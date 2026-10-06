// Самодостаточный Jira-клиент для JiraTime (Jira Server/DC, REST API v2).
// Конфиг: env JIRA_URL / JIRA_PERSONAL_TOKEN -> .jira-config.json.
// В exe (pkg): файл ищется рядом с исполняемым файлом; в dev — в корне репозитория.
// Используется серверный PAT; страница работает без логина (внутренний инструмент).

const fs = require('fs');
const path = require('path');

function configCandidates() {
  if (process.pkg) {
    // В exe-сборке конфиг ищется ТОЛЬКО рядом с исполняемым файлом
    // (fallback на cwd или куда-либо ещё может случайно подхватить чужой файл).
    const exeDir = path.dirname(process.execPath);
    return [
      path.join(exeDir, '.jira-config.json'),
      path.join(exeDir, 'jira-config.json'),
    ];
  }
  return [
    path.join(__dirname, '..', '.jira-config.json'),
  ];
}

let lastConfigIssue = null;

function readJsonFile(file) {
  let raw;
  let readErr = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    readErr = e;
  }
  if (readErr || raw === undefined) return { value: null, err: null };
  // Notepad/Windows могут добавить BOM (U+FEFF) — JSON.parse его не переваривает.
  const text = String(raw).replace(/^\uFEFF/, '');
  try {
    return { value: JSON.parse(text), err: null };
  } catch (e) {
    return { value: null, err: new Error('Ошибка разбора JSON в ' + file + ': ' + e.message) };
  }
}

function loadConfig() {
  const cfg = { url: null, token: null };
  const envUrl = process.env.JIRA_URL ? String(process.env.JIRA_URL).replace(/\/+$/, '') : null;
  const envToken = process.env.JIRA_PERSONAL_TOKEN ? String(process.env.JIRA_PERSONAL_TOKEN).trim() : null;
  if (envUrl) cfg.url = envUrl;
  if (envToken) cfg.token = envToken;

  let usedFile = null;
  let sawEnv = !!(envUrl || envToken);
  if ((!cfg.url || !cfg.token)) {
    for (const file of configCandidates()) {
      if (!fs.existsSync(file)) continue;
      const parsed = readJsonFile(file);
      if (parsed.err) {
        lastConfigIssue = parsed.err.message;
        usedFile = file;
        break;
      }
      const fileCfg = parsed.value || {};
      if (!cfg.url && fileCfg.url) cfg.url = String(fileCfg.url).replace(/\/+$/, '');
      if (!cfg.token && fileCfg.token) cfg.token = String(fileCfg.token);
      usedFile = file;
      if (cfg.url && cfg.token) break;
    }
  }

  cfg.configured = !!(cfg.url && cfg.token);
  cfg.base = cfg.url ? cfg.url + '/rest/api/2' : null;
  // Источник кредов для диагностики: env / путь файла / none.
  cfg.source = sawEnv ? 'env' : (usedFile ? 'file' : 'none');
  cfg.configFile = usedFile;
  cfg.envSeen = sawEnv;

  if (!cfg.configured && !lastConfigIssue) {
    const checked = configCandidates().filter((p) => fs.existsSync(p));
    lastConfigIssue = checked.length
      ? 'Найден(-ы) ' + checked.length + ' кандидат(а) конфига, но в них пустые url/token'
      : 'Файл конфига не найден в: ' + configCandidates().join('; ');
  }
  return cfg;
}

function notConfigured() {
  const cfg = configCandidates();
  const e = new Error(
    'Jira не настроена. Проверено: ' + cfg.join('; ')
    + '. Задайте JIRA_URL и JIRA_PERSONAL_TOKEN или положите рядом с JiraTime.exe файл .jira-config.json вида {"url":"https://jira.example.ru","token":"<PAT>"}'
    + (lastConfigIssue ? '. Причина: ' + lastConfigIssue : '')
  );
  e.status = 503;
  throw e;
}

async function jiraCall(pathname, opts = {}) {
  const cfg = loadConfig();
  if (!cfg.configured) notConfigured();

  const headers = {
    Authorization: 'Bearer ' + cfg.token,
    Accept: 'application/json',
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(cfg.base + pathname, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }

  if (!res.ok) {
    let msg = 'Jira HTTP ' + res.status;
    if (body && body.errorMessages && body.errorMessages.length) msg = body.errorMessages.join('; ');
    else if (body && body.message) msg = body.message;
    else if (Array.isArray(body) && body[0] && body[0].errorMessages) msg = body[0].errorMessages.join('; ');
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  return body;
}

let SPRINT_FIELD_ID = null;

async function resolveSprintField() {
  if (SPRINT_FIELD_ID) return SPRINT_FIELD_ID;
  try {
    const all = (await jiraCall('/field')) || [];
    const fields = Array.isArray(all) ? all : [];
    const custom = fields.filter((f) => String(f.id).startsWith('customfield_'));
    const exact = custom.find((f) => String(f.name || '').trim().toLowerCase() === 'sprint');
    const fuzzy = custom.find((f) => /sprint|спринт/i.test(String(f.name || '')) && !/history|истори/i.test(String(f.name || '')));
    SPRINT_FIELD_ID = (exact || fuzzy || null) && (exact || fuzzy).id;
  } catch (e) {
    SPRINT_FIELD_ID = null;
  }
  return SPRINT_FIELD_ID;
}

async function projects() {
  const list = await jiraCall('/project?maxResults=200');
  const out = (Array.isArray(list) ? list : []).map((p) => ({ key: p.key, name: p.name }));
  out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
  return out;
}

// Активный спринт: JQL openSprints() — как в портале. Возвращает задачи спринта
// с пагинацией (страница по 200, максимум maxResults на проект).
async function searchActiveSprint(projectKey, maxResults = 400) {
  const cfg = loadConfig();
  if (!cfg.configured) notConfigured();

  const sprintId = await resolveSprintField();
  const fields = ['key', 'summary', 'status', 'priority', 'assignee', 'issuetype', 'duedate', 'labels', 'components'];
  if (sprintId) fields.push(sprintId);

  const jql = 'project = "' + String(projectKey).toUpperCase() + '" AND sprint in openSprints() AND issuetype in ("Задача", "Ошибка", "Активность")';
  const issues = [];
  const seen = new Set();
  const PAGE = 200;
  let startAt = 0;
  for (let page = 0; page < Math.ceil((Number(maxResults) || 400) / PAGE); page++) {
    const res = await jiraCall('/search', {
      method: 'POST',
      body: { jql, maxResults: PAGE, startAt, fields },
    });
    const arr = (res && res.issues) || [];
    arr.forEach((it) => {
      if (!seen.has(it.key)) { seen.add(it.key); issues.push(it); }
    });
    if (arr.length < PAGE) break;
    startAt += arr.length;
    if (issues.length >= (Number(maxResults) || 400)) break;
  }
  return { jql, total: issues.length, issues };
}

async function updateDueDate(key, isoDate) {
  await jiraCall('/issue/' + encodeURIComponent(key), {
    method: 'PUT',
    body: { fields: { duedate: isoDate } },
  });
  return { key };
}

// Диагностика интеграции с Jira: пробует /myself и классифицирует причину сбоя,
// чтобы отличить сеть/прокси/TLS от неверного токена. Токен из ответа исключён.
async function health() {
  const cfg = getConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      configured: false,
      url: cfg.url || null,
      source: cfg.source,
      configFile: cfg.configFile,
      envSeen: cfg.envSeen,
      pkg: !!process.pkg,
      paths: cfg.configPaths || [],
      issue: cfg.issue,
    };
  }
  try {
    const me = await jiraCall('/myself');
    return {
      ok: true,
      configured: true,
      url: cfg.url,
      source: cfg.source,
      configFile: cfg.configFile,
      envSeen: cfg.envSeen,
      pkg: !!process.pkg,
      me: { name: (me && (me.displayName || me.name)) || null, email: (me && me.emailAddress) || null },
    };
  } catch (e) {
    const cause = e && e.cause;
    const code = (cause && cause.code) || null;
    let kind = 'unknown';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') kind = 'dns';
    else if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(code)) kind = 'network';
    else if (/CERT|DEPTH_ZERO|UNABLE_TO_VERIFY|SELF_SIGNED|CERT_VERIFY/i.test(String(code || ''))) kind = 'tls';
    else if (e.status === 401 || e.status === 403) kind = 'auth';
    else if (e.status >= 400 && e.status < 600) kind = 'http';
    else if (code) kind = 'network';
    return {
      ok: false,
      configured: true,
      url: cfg.url,
      source: cfg.source,
      configFile: cfg.configFile,
      envSeen: cfg.envSeen,
      pkg: !!process.pkg,
      kind,
      code,
      status: e.status || null,
      message: (e && e.message) || String(e) || 'неизвестная ошибка',
    };
  }
}

function getConfig() {
  const c = loadConfig();
  return {
    configured: c.configured,
    url: c.url,
    source: c.source,
    configFile: c.configFile,
    envSeen: c.envSeen,
    configPaths: configCandidates(),
    issue: lastConfigIssue,
  };
}

module.exports = {
  getConfig,
  setSprintFieldCache(v) { SPRINT_FIELD_ID = v; },
  projects,
  searchActiveSprint,
  updateDueDate,
  health,
};