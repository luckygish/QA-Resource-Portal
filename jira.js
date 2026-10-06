// Jira (Server/DC, REST API v2) integration module.
// Credentials are loaded from env vars JIRA_URL / JIRA_PERSONAL_TOKEN,
// falling back to a local (gitignored) .jira-config.json next to the app.
// The token never leaves the server: the frontend only talks to /api/jira/*.

const fs = require('fs');
const path = require('path');

const APP_DIR = typeof process !== 'undefined' && process.pkg ? path.dirname(process.execPath) : __dirname;
const CONFIG_PATH = path.join(APP_DIR, '.jira-config.json');

let lastConfigIssue = null;

function loadConfig() {
  const cfg = { url: null, token: null };
  let envSeen = false;
  if (process.env.JIRA_URL) { cfg.url = String(process.env.JIRA_URL).replace(/\/+$/, ''); envSeen = true; }
  if (process.env.JIRA_PERSONAL_TOKEN) { cfg.token = String(process.env.JIRA_PERSONAL_TOKEN); envSeen = true; }

  // OAuth 2.0 / 3LO (Jira Data Center) client-приложение.
  if (process.env.JIRA_OAUTH_CLIENT_ID) cfg.oauthClientId = String(process.env.JIRA_OAUTH_CLIENT_ID).trim();
  if (process.env.JIRA_OAUTH_CLIENT_SECRET) cfg.oauthClientSecret = String(process.env.JIRA_OAUTH_CLIENT_SECRET).trim();
  if (process.env.JIRA_OAUTH_REDIRECT_URI) cfg.oauthRedirectUri = String(process.env.JIRA_OAUTH_REDIRECT_URI).trim();

  let fileUsed = null;
  if ((!cfg.url || !cfg.token) && fs.existsSync(CONFIG_PATH)) {
    let raw;
    try {
      raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    } catch (e) { /* не читается — игнор */ }
    if (raw !== undefined) {
      // Notepad/Windows могут добавить BOM (U+FEFF) — JSON.parse его не переваривает.
      const text = String(raw).replace(/^\uFEFF/, '');
      try {
        const fileCfg = JSON.parse(text);
        if (!cfg.url && fileCfg.url) cfg.url = String(fileCfg.url).replace(/\/+$/, '');
        if (!cfg.token && fileCfg.token) cfg.token = String(fileCfg.token);
        if (!cfg.oauthClientId && fileCfg.oauthClientId) cfg.oauthClientId = String(fileCfg.oauthClientId).trim();
        if (!cfg.oauthClientSecret && fileCfg.oauthClientSecret) cfg.oauthClientSecret = String(fileCfg.oauthClientSecret).trim();
        if (!cfg.oauthRedirectUri && fileCfg.oauthRedirectUri) cfg.oauthRedirectUri = String(fileCfg.oauthRedirectUri).trim();
        fileUsed = CONFIG_PATH;
      } catch (e) {
        lastConfigIssue = 'Ошибка разбора JSON в ' + CONFIG_PATH + ': ' + e.message;
      }
    }
  }

  cfg.configured = !!(cfg.url && cfg.token);
  cfg.oauthConfigured = !!(cfg.url && cfg.oauthClientId && cfg.oauthClientSecret && cfg.oauthRedirectUri);
  cfg.base = cfg.url ? cfg.url + '/rest/api/2' : null;
  cfg.source = envSeen ? 'env' : (fileUsed ? 'file' : 'none');
  cfg.configFile = fileUsed;
  cfg.envSeen = envSeen;

  if (!cfg.configured && !lastConfigIssue) {
    lastConfigIssue = fs.existsSync(CONFIG_PATH)
      ? 'Конфиг найден (' + CONFIG_PATH + '), но в нём пустые url/token'
      : 'Файл конфига не найден в: ' + CONFIG_PATH;
  }
  return cfg;
}

function convToken(cfg, token) {
  if (token) {
    // Личный токен (из сессии) заменяет конфиговый; пересчитываем configured,
    // т.к. url + личный токен уже достаточно (серверный token не обязателен).
    const t = String(token).trim();
    return { ...cfg, token: t, configured: !!(cfg.url && t) };
  }
  return cfg;
}

function oauthEndpoints(cfg) {
  const url = /\/$/.test(cfg.url) ? cfg.url.slice(0, -1) : cfg.url;
  return {
    authorize: url + '/oauth2/authorize',
    token: url + '/oauth2/token',
  };
}

function notConfigured() {
  const e = new Error(
    'Jira не настроена. Проверено: ' + CONFIG_PATH
    + '. Задайте JIRA_URL и JIRA_PERSONAL_TOKEN (или .jira-config.json рядом с приложением)'
    + (lastConfigIssue ? '. Причина: ' + lastConfigIssue : '')
  );
  e.status = 503;
  return e;
}

async function jiraCall(pathname, cfg, opts = {}) {
  const res = await fetch(cfg.base + pathname, {
    method: opts.method || 'GET',
    headers: {
      Authorization: 'Bearer ' + cfg.token,
      Accept: 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }

  if (!res.ok) {
    let msg = 'Jira HTTP ' + res.status;
    if (body && body.errorMessages && body.errorMessages.length) msg = body.errorMessages.join('; ');
    else if (body && body.message) msg = body.message;
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  return body;
}

const SEARCH_FIELD_LIST = [
  'key', 'summary', 'status', 'assignee', 'reporter', 'priority', 'issuetype',
  'created', 'updated', 'duedate', 'timetracking',
  'timeestimate', 'timespent', 'aggregatetimeestimate', 'aggregatetimespent',
];

let SPRINT_FIELD_ID = null;

async function resolveSprintField(cfg) {
  if (SPRINT_FIELD_ID) return SPRINT_FIELD_ID;
  try {
    const all = (await jiraCall('/field', cfg)) || [];
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

function parseSprintValue(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && v.name) return { name: String(v.name), state: String(v.state || '') };
  const s = typeof v === 'string' ? v : (Array.isArray(v) ? v[0] : null);
  if (!s) return null;
  if (typeof s === 'object' && s.name) return { name: String(s.name), state: String(s.state || '') };
  if (typeof s !== 'string') return null;
  const nameM = s.match(/name=(.*?),startDate=/);
  const stateM = s.match(/state=([^,]+)/);
  return { name: nameM ? nameM[1] : null, state: stateM ? stateM[1].toLowerCase() : '' };
}

function activeSprintNameOfIssue(issue) {
  if (!issue || !issue.fields || !SPRINT_FIELD_ID) return null;
  const v = issue.fields[SPRINT_FIELD_ID];
  const arr = Array.isArray(v) ? v : [v];
  let activeName = null;
  arr.forEach((item) => {
    const p = parseSprintValue(item);
    if (p && p.name && (p.state === 'active' || p.state === 'ACTIVE') && !activeName) activeName = p.name;
  });
  return activeName;
}

function sprintNamesOfIssue(issue) {
  if (!issue || !issue.fields || !SPRINT_FIELD_ID) return [];
  const v = issue.fields[SPRINT_FIELD_ID];
  const arr = Array.isArray(v) ? v : [v];
  const names = [];
  arr.forEach((item) => {
    const p = parseSprintValue(item);
    if (p && p.name) names.push(p.name);
  });
  return names;
}

function mapUser(u) {
  if (!u || u.active === false || u.accountType === 'service') return null;
  const name = u.name || u.key;
  return {
    key: u.key || null,
    name,
    displayName: (u.displayName || name || '—').trim(),
    emailAddress: (u.emailAddress || '').trim() || null,
    accountId: u.accountId || null,
    active: u.active !== false,
    jqlName: name || u.accountId || u.key,
  };
}

module.exports = {
  getConfig() {
    const c = loadConfig();
    return {
      configured: c.configured,
      oauthConfigured: c.oauthConfigured,
      url: c.url,
      source: c.source,
      configFile: c.configFile,
      envSeen: c.envSeen,
      issue: lastConfigIssue,
    };
  },

  // Диагностика интеграции: пробует /myself и классифицирует причину сбоя
  // (auth/network/tls/dns/http), чтобы отличить сеть/прокси/сертификаты от токена.
  async probe(token) {
    const cfg = loadConfig();
    if (!(cfg.url && (cfg.token || token))) {
      return { ok: false, kind: 'config', status: null, message: lastConfigIssue || 'Jira не настроена' };
    }
    try {
      const me = await module.exports.myself(token || null);
      return {
        ok: true,
        appliedToken: token ? 'session' : 'server',
        me: { name: me.displayName, email: me.email },
      };
    } catch (e) {
      const cause = e && e.cause;
      const code = (cause && cause.code) || null;
      let kind = 'unknown';
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') kind = 'dns';
      else if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) kind = 'network';
      else if (/CERT|DEPTH_ZERO|UNABLE_TO_VERIFY|SELF_SIGNED|CERT_VERIFY/i.test(String(code || ''))) kind = 'tls';
      else if (e.status === 401 || e.status === 403) kind = 'auth';
      else if (e.status >= 400 && e.status < 600) kind = 'http';
      else if (code) kind = 'network';
      return { ok: false, kind, code, status: e.status || null, message: (e && e.message) || String(e) || 'неизвестная ошибка' };
    }
  },

  async projects(token) {
    const cfg = convToken(loadConfig(), token);
    if (!cfg.configured) throw notConfigured();
    const list = await jiraCall('/project?maxResults=200', cfg);
    return (Array.isArray(list) ? list : []).map((p) => ({
      key: p.key,
      name: p.name,
      lead: p.lead && p.lead.displayName,
    }));
  },

  async search(opts, token) {
    const cfg = convToken(loadConfig(), token);
    if (!cfg.configured) throw notConfigured();
    const { projectKey, jql, maxResults, startAt } = opts || {};
    const query = (jql && String(jql).trim())
      ? String(jql).trim()
      : (projectKey ? `project = "${String(projectKey).toUpperCase()}"` : '');
    if (!query) throw new Error('Укажите проект или JQL');

    const fields = SEARCH_FIELD_LIST.slice();
    const sprintId = await resolveSprintField(cfg);
    if (sprintId) fields.push(sprintId);

    const body = {
      jql: query,
      maxResults: Number(maxResults) || 100,
      fields,
    };
    if (Number.isInteger(Number(startAt)) && Number(startAt) > 0) body.startAt = Number(startAt);
    const res = await jiraCall('/search', cfg, { method: 'POST', body });
    const issues = (res.issues || []).map((it) => {
      const sprintNames = sprintNamesOfIssue(it, sprintId);
      if (sprintNames.length) it._sprintNames = sprintNames;
      return it;
    });
    return {
      jql: query,
      total: res.total || 0,
      issues,
    };
  },

  async users(q, token) {
    const cfg = convToken(loadConfig(), token);
    if (!cfg.configured) throw notConfigured();
    const query = String(q || '').trim();
    if (query) {
      const list = await jiraCall(`/user/search?username=${encodeURIComponent(query)}&maxResults=50`, cfg);
      const lower = query.toLowerCase();
      const out = (Array.isArray(list) ? list : [])
        .map((u) => mapUser(u))
        .filter((m) => m && ( (m.displayName || '').toLowerCase().includes(lower)
          || (m.name || '').toLowerCase().includes(lower)
          || (m.emailAddress || '').toLowerCase().includes(lower) ));
      out.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || '', 'ru'));
      return out;
    }
    const out = [];
    const cap = 1500;
    const batch = 1000;
    let startAt = 0;
    while (out.length < cap) {
      let list;
      try {
        list = await jiraCall(`/user/search?username=.&startAt=${startAt}&maxResults=${batch}`, cfg);
      } catch (e) {
        break;
      }
      if (!Array.isArray(list) || list.length === 0) break;
      list.forEach((u) => {
        const m = mapUser(u);
        if (m) out.push(m);
      });
      if (list.length < batch) break;
      startAt += list.length;
    }
    out.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || '', 'ru'));
    return out.slice(0, cap);
  },

  async assignables(projectKeys, token) {
    const cfg = convToken(loadConfig(), token);
    if (!cfg.configured) throw notConfigured();
    const keys = (Array.isArray(projectKeys) ? projectKeys : [])
      .map((k) => String(k).trim().toUpperCase())
      .filter(Boolean);
    if (!keys.length) return [];
    const byKey = new Map();
    for (const key of keys) {
      const batch = 1000;
      let startAt = 0;
      for (let guard = 0; guard < 10; guard++) {
        let list;
        try {
          list = await jiraCall(`/user/assignable/search?project=${encodeURIComponent(key)}&startAt=${startAt}&maxResults=${batch}`, cfg);
        } catch (e) {
          break;
        }
        if (!Array.isArray(list) || list.length === 0) break;
        list.forEach((u) => {
          const m = mapUser(u);
          if (m && m.key && !byKey.has(m.key)) byKey.set(m.key, m);
        });
        if (list.length < batch) break;
        startAt += list.length;
      }
    }
    const out = [...byKey.values()];
    out.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || '', 'ru'));
    return out;
  },

  async activeSprints(projectKeys, token) {
    const cfg = convToken(loadConfig(), token);
    if (!cfg.configured) throw notConfigured();
    const keys = (Array.isArray(projectKeys) ? projectKeys : [])
      .map((k) => String(k).trim().toUpperCase())
      .filter(Boolean);
    if (!keys.length) return {};
    const sprintId = await resolveSprintField(cfg);
    if (!sprintId) return {};
    const map = {};
    for (const key of keys) {
      let body;
      let res;
      try {
        body = {
          jql: `project = "${key}" AND sprint in openSprints()`,
          maxResults: 100,
          fields: ['key', sprintId],
        };
        res = await jiraCall('/search', cfg, { method: 'POST', body });
      } catch (e) {
        continue;
      }
      const issues = (res && res.issues) || [];
      let name = null;
      for (const it of issues) {
        if (!name) name = activeSprintNameOfIssue(it);
        if (name) break;
      }
      if (name) map[key] = name;
    }
    return map;
  },

  async issue(key, token) {
    const cfg = convToken(loadConfig(), token);
    if (!cfg.configured) throw notConfigured();
    const fields = SEARCH_FIELD_LIST.concat(['description', 'comment', 'components', 'labels', 'fixVersions', 'resolution']).join(',');
    return jiraCall('/issue/' + encodeURIComponent(key) + '?fields=' + fields, cfg);
  },

  async myself(token) {
    const cfg = convToken(loadConfig(), token);
    if (!cfg.configured) throw notConfigured();
    const me = await jiraCall('/myself', cfg);
    return {
      email: me && me.emailAddress ? me.emailAddress : null,
      accountId: me && me.accountId ? String(me.accountId) : null,
      name: me && me.name ? me.name : null,
      displayName: me && me.displayName ? me.displayName : null,
    };
  },

  // Логин-валидация через Basic auth (запасной путь, когда OAuth-клиент не настроен).
  // Пароль используется только для проверки подлинности и нигде не сохраняется.
  // Вход по личному Personal Access Token (PAT) вместо Basic. Токен валидируем
  // через /myself и затем используем в сессии как личный для вкладки Jira.
  async loginToken(personalToken) {
    const t = String(personalToken || '').trim();
    if (!t) { const e = new Error('Укажите Jira-токен'); e.status = 400; throw e; }
    const cfg = loadConfig();
    if (!cfg.url) throw notConfigured();
    const me = await fetch(cfg.base + '/myself', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + t, Accept: 'application/json' },
    });
    if (!me.ok) {
      const e = new Error(me.status === 401 ? 'Неверный Jira-токен' : 'Jira HTTP ' + me.status);
      e.status = me.status === 401 ? 401 : (me.status || 502);
      throw e;
    }
    const data = await me.json();
    return {
      email: data && data.emailAddress ? data.emailAddress : null,
      accountId: data && data.accountId ? String(data.accountId) : null,
      name: data && data.name ? data.name : null,
      displayName: data && data.displayName ? data.displayName : null,
      token: t,
    };
  },

  async loginBasic(username, password) {
    const base = loadConfig();
    if (!base.url) throw notConfigured();
    const res = await fetch(base.base + '/myself', {
      method: 'GET',
      headers: {
        Authorization: 'Basic ' + Buffer.from(String(username || '') + ':' + String(password || '')).toString('base64'),
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const e = new Error(res.status === 401 ? 'Неверный логин или пароль' : 'Jira HTTP ' + res.status);
      e.status = res.status === 401 ? 401 : (res.status || 502);
      throw e;
    }
    const me = await res.json();
    return {
      email: me && me.emailAddress ? me.emailAddress : null,
      accountId: me && me.accountId ? String(me.accountId) : null,
      name: me && me.name ? me.name : null,
      displayName: me && me.displayName ? me.displayName : null,
    };
  },

  // ---- OAuth 2.0 / 3LO (Jira Data Center) ----
  getOAuthConfig() {
    const c = loadConfig();
    return {
      configured: c.oauthConfigured,
      url: c.url,
      clientId: c.oauthClientId || null,
      redirectUri: c.oauthRedirectUri || null,
    };
  },

  oauthNotConfigured() {
    const e = new Error('OAuth для Jira не настроен. Задайте JIRA_OAUTH_CLIENT_ID, JIRA_OAUTH_CLIENT_SECRET и JIRA_OAUTH_REDIRECT_URI (или в .jira-config.json).');
    e.status = 503;
    return e;
  },

  getAuthUrl(state, redirectUri) {
    const cfg = loadConfig();
    if (!cfg.oauthConfigured) return null;
    const endpoints = oauthEndpoints(cfg);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.oauthClientId,
      redirect_uri: redirectUri || cfg.oauthRedirectUri,
      scope: 'read:jira-user read:jira-work offline_access',
      state,
    });
    return endpoints.authorize + '?' + params.toString();
  },

  async exchangeCode(code, redirectUri) {
    const cfg = loadConfig();
    if (!cfg.oauthConfigured) throw this.oauthNotConfigured();
    const endpoints = oauthEndpoints(cfg);
    const bodyParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.oauthClientId,
      client_secret: cfg.oauthClientSecret,
      code,
      redirect_uri: redirectUri || cfg.oauthRedirectUri,
    });
    const res = await fetch(endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: bodyParams.toString(),
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    if (!res.ok) {
      const msg = body && (body.error_description || body.error || body.message) || ('Jira OAuth HTTP ' + res.status);
      const e = new Error(msg);
      e.status = res.status;
      throw e;
    }
    return {
      accessToken: body.access_token || null,
      refreshToken: body.refresh_token || null,
      expiresIn: Number(body.expires_in) || null,
    };
  },
};