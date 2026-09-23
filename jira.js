// Jira (Server/DC, REST API v2) integration module.
// Credentials are loaded from env vars JIRA_URL / JIRA_PERSONAL_TOKEN,
// falling back to a local (gitignored) .jira-config.json next to the app.
// The token never leaves the server: the frontend only talks to /api/jira/*.

const fs = require('fs');
const path = require('path');

const APP_DIR = typeof process !== 'undefined' && process.pkg ? path.dirname(process.execPath) : __dirname;
const CONFIG_PATH = path.join(APP_DIR, '.jira-config.json');

function loadConfig() {
  const cfg = { url: null, token: null };
  if (process.env.JIRA_URL) cfg.url = String(process.env.JIRA_URL).replace(/\/+$/, '');
  if (process.env.JIRA_PERSONAL_TOKEN) cfg.token = String(process.env.JIRA_PERSONAL_TOKEN);

  if ((!cfg.url || !cfg.token) && fs.existsSync(CONFIG_PATH)) {
    try {
      const fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (!cfg.url && fileCfg.url) cfg.url = String(fileCfg.url).replace(/\/+$/, '');
      if (!cfg.token && fileCfg.token) cfg.token = String(fileCfg.token);
    } catch (e) { /* invalid config file -> ignore */ }
  }

  cfg.configured = !!(cfg.url && cfg.token);
  cfg.base = cfg.url ? cfg.url + '/rest/api/2' : null;
  return cfg;
}

function notConfigured() {
  const e = new Error('Jira не настроена. Задайте JIRA_URL и JIRA_PERSONAL_TOKEN (или .jira-config.json).');
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
let ENV_FIELD_ID = null;
let REQUEST_TYPE_FIELD_ID = null;

async function resolveEnvironmentField(cfg) {
  if (ENV_FIELD_ID) return ENV_FIELD_ID;
  try {
    const all = (await jiraCall('/field', cfg)) || [];
    const fields = Array.isArray(all) ? all : [];
    const custom = fields.filter((f) => String(f.id).startsWith('customfield_'));
    const exact = custom.find((f) => {
      const n = String(f.name || '').trim().toLowerCase();
      return n === 'environment' || n === 'окружение';
    });
    const fuzzy = custom.find((f) => /environment|окружени/i.test(String(f.name || '')));
    ENV_FIELD_ID = (exact || fuzzy || null) && (exact || fuzzy).id;
  } catch (e) {
    ENV_FIELD_ID = null;
  }
  return ENV_FIELD_ID;
}

async function resolveRequestTypeField(cfg) {
  if (REQUEST_TYPE_FIELD_ID) return REQUEST_TYPE_FIELD_ID;
  try {
    const all = (await jiraCall('/field', cfg)) || [];
    const fields = Array.isArray(all) ? all : [];
    const custom = fields.filter((f) => String(f.id).startsWith('customfield_'));
    const hit = custom.find((f) => /тип(\s+)?заявки|request type/i.test(String(f.name || '')));
    REQUEST_TYPE_FIELD_ID = (hit || null) && hit.id;
  } catch (e) {
    REQUEST_TYPE_FIELD_ID = null;
  }
  return REQUEST_TYPE_FIELD_ID;
}

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

const DASHBOARD_BASE_FIELDS = SEARCH_FIELD_LIST.concat([
  'statusCategory', 'resolution', 'resolutiondate', 'labels', 'components',
]);

const NO_ENV = 'Без окружения';
const DEFAULT_DAYS = 90;
const BUG_EXCLUDED_RESOLUTIONS = ['Не воспроизводится', 'Не является дефектом', 'Canceled', 'Дубликат', 'Не нуждается в исправлении'];

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isoDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// [from, to] date window: last N full days ending today (UTC date granularity).
function dateWindow(days) {
  const n = Math.max(1, Math.min(365, Number(days) || DEFAULT_DAYS));
  const to = new Date();
  to.setUTCHours(0, 0, 0, 0);
  const from = new Date(to.getTime() - (n - 1) * 86400000);
  return { from: isoDate(from), to: isoDate(to), days: n };
}

// Bug-issuetype JQL piece: классические «Ошибки» + Service Task с «Тип заявки» = Ошибка
// (аналог примера пользователя), с фолбэком, если поле «Тип заявки» не резолвится.
function bugTypeJql(rtId) {
  if (!rtId) return `issuetype = "Ошибка"`;
  const cf = String(rtId).replace(/^customfield_/i, '');
  return `(issuetype = "Ошибка" OR (issuetype = "Service Task" AND cf[${cf}] = "Ошибка"))`;
}

// Paginated search that returns all issues of a matching jql (capped).
async function searchAll(cfg, jql, { pageSize = 200, cap = 1000 } = {}) {
  const sprintId = await resolveSprintField(cfg);
  const envId = await resolveEnvironmentField(cfg);
  const fields = DASHBOARD_BASE_FIELDS.slice();
  if (sprintId) fields.push(sprintId);
  if (envId) fields.push(envId);

  const out = [];
  let startAt = 0;
  for (let guard = 0; guard < 20; guard++) {
    const body = { jql, maxResults: pageSize, fields };
    if (startAt > 0) body.startAt = startAt;
    let res;
    try {
      res = await jiraCall('/search', cfg, { method: 'POST', body });
    } catch (e) {
      break;
    }
    const arr = (res && res.issues) || [];
    arr.forEach((it) => {
      const names = sprintNamesOfIssue(it);
      if (names.length) it._sprintNames = names;
      out.push(it);
    });
    if (arr.length < pageSize || out.length >= cap) break;
    startAt += arr.length;
  }
  return out;
}

function issueStatusCategory(it) {
  const f = it && it.fields;
  return f && f.status && f.status.statusCategory ? f.status.statusCategory.key : null;
}

function issueStatusName(it) {
  const f = it && it.fields;
  return (f && f.status && f.status.name) || '—';
}

function isDone(it) {
  return issueStatusCategory(it) === 'done';
}

function issueTypeName(it) {
  const n = (it && it.fields && it.fields.issuetype && it.fields.issuetype.name) || 'Проч.';
  const l = String(n).trim().toLowerCase();
  if (l === 'задача') return 'Задача';
  if (l === 'ошибка' || l === 'bug') return 'Ошибка';
  return 'Прочее';
}

function issueAssignee(it) {
  const a = it && it.fields && it.fields.assignee;
  return (a && a.displayName) || 'Не назначен';
}

function issuePriority(it) {
  const p = it && it.fields && it.fields.priority;
  return (p && p.name) || 'Не задан';
}

function issueResolution(it) {
  const r = it && it.fields && it.fields.resolution;
  return (r && r.name) || null;
}

function issueEnv(it, envId) {
  if (!envId) return NO_ENV;
  const v = it && it.fields && it.fields[envId];
  if (v === undefined || v === null || v === '') return NO_ENV;
  if (typeof v === 'object') return v.value || v.name || JSON.stringify(v);
  return String(v);
}

function counts(map, key) {
  if (!key && key !== 0) return;
  map[key] = (map[key] || 0) + 1;
}

function sprintNamesOfIssueArr(it) {
  return (it && it._sprintNames) || [];
}

function sumTime(it, field) {
  return toNum(it && it.fields && it.fields[field]);
}

async function dashboard(projectKey, opts = {}) {
  const cfg = loadConfig();
  if (!cfg.configured) throw notConfigured();
  const key = String(projectKey || '').trim().toUpperCase();
  if (!key) throw new Error('Укажите projectKey');

  const envId = await resolveEnvironmentField(cfg);
  const rtId = await resolveRequestTypeField(cfg);
  const cap = Number(opts.cap) || 2000;
  const { from, to, days } = dateWindow(opts.days);
  const bugType = bugTypeJql(rtId);
  const bugRes = BUG_EXCLUDED_RESOLUTIONS.map((r) => `"${r}"`).join(', ');

  // Окно по resolve: закрытые Задача/Ошибка за последние N дней
  const resolvedJql = `project = "${key}" AND issuetype in ("Задача", "Ошибка") AND resolutiondate >= "${from}" AND resolutiondate <= "${to}"`;
  // Отчёт по окружению: ошибки, заведённые за окно (пример пользователя)
  const envJql = `project = "${key}" AND ${bugType} AND resolution not in (${bugRes}) AND created >= "${from} 00:00" AND created <= "${to} 23:59"`;
  // Ошибки: заведённые или закрытые за окно — для разбивки по спринтам
  const sprintBugsJql = `project = "${key}" AND ${bugType} AND (created >= "${from} 00:00" AND created <= "${to} 23:59" OR resolutiondate >= "${from}" AND resolutiondate <= "${to}")`;

  const [resolved, envBugs, sprintBugs] = await Promise.all([
    searchAll(cfg, resolvedJql, { cap }),
    searchAll(cfg, envJql, { cap }),
    searchAll(cfg, sprintBugsJql, { cap }),
  ]);

  // ---- KPI (за окно)
  let closedTasks = 0;
  let closedBugs = 0;
  let spent90 = 0;
  resolved.forEach((it) => {
    if (issueTypeName(it) === 'Задача') closedTasks += 1;
    else if (issueTypeName(it) === 'Ошибка') closedBugs += 1;
    spent90 += sumTime(it, 'aggregatetimespent') || sumTime(it, 'timespent');
  });
  const kpi = {
    days,
    closedTasks,
    closedBugs,
    closedTotal: resolved.length,
    bugsCreated: envBugs.length,
    spent90,
  };

  // ---- Загрузка по исполнителям: кто закрыл (Задача/Ошибка) за окно
  const byAssignee = {};
  resolved.forEach((it) => counts(byAssignee, issueAssignee(it)));
  // ---- По типам (закрытые за окно)
  const byType = {};
  resolved.forEach((it) => counts(byType, issueTypeName(it)));

  // ---- Разрез по окружению (ошибки за окно, по env-полю)
  const byEnvironment = {};
  envBugs.forEach((it) => counts(byEnvironment, issueEnv(it, envId)));

  // ---- Ошибки по спринтам: заведённые и закрытые за окно
  const spName = 'Без спринта';
  const createdBySprint = {};
  const closedBySprint = {};
  const sprintOrder = [];
  const stampCreated = (it) => new Date(it.fields && it.fields.created).getTime();
  const stampResolved = (it) => new Date(it.fields && it.fields.resolutiondate).getTime();
  const fromT = new Date(from + 'T00:00:00').getTime();
  const toT = new Date(to + 'T23:59:59').getTime();

  sprintBugs.forEach((it) => {
    const sprints = sprintNamesOfIssueArr(it);
    if (!sprints.length) sprints.push(spName);
    const catCreated = stampCreated(it) >= fromT && stampCreated(it) <= toT;
    const catClosed = stampResolved(it) >= fromT && stampResolved(it) <= toT;
    sprints.forEach((sn) => {
      if (!(sn in createdBySprint)) { createdBySprint[sn] = 0; closedBySprint[sn] = 0; sprintOrder.push(sn); }
      if (catCreated) createdBySprint[sn] += 1;
      if (catClosed) closedBySprint[sn] += 1;
    });
  });
  const bugSprints = sprintOrder.map((sn) => ({ sprint: sn, created: createdBySprint[sn], closed: closedBySprint[sn] }));

  // ---- Время (за окно закрытых)
  const timeByAssignee = {};
  const timeByStatus = {};
  let timeTotalSpent = 0;
  let timeTotalEstimate = 0;
  resolved.forEach((it) => {
    const spent = sumTime(it, 'aggregatetimespent') || sumTime(it, 'timespent');
    const est = sumTime(it, 'aggregatetimeestimate') || sumTime(it, 'timeestimate');
    timeTotalSpent += spent;
    timeTotalEstimate += est;
    const a = issueAssignee(it);
    if (!timeByAssignee[a]) timeByAssignee[a] = { spent: 0, estimate: 0 };
    timeByAssignee[a].spent += spent;
    timeByAssignee[a].estimate += est;
    const s = issueStatusName(it);
    if (!timeByStatus[s]) timeByStatus[s] = { spent: 0, estimate: 0 };
    timeByStatus[s].spent += spent;
    timeByStatus[s].estimate += est;
  });

  const toSorted = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));

  return {
    projectKey: key,
    days: { from, to, days },
    envFieldResolved: !!envId,
    requestTypeFieldResolved: !!rtId,
    kpi,
    byAssignee: toSorted(byAssignee),
    byType: toSorted(byType),
    byEnvironment: Object.entries(byEnvironment).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })),
    bugSprints,
    time: {
      byAssignee: Object.entries(timeByAssignee).map(([name, v]) => ({ name, spent: v.spent, estimate: v.estimate })),
      byStatus: Object.entries(timeByStatus).map(([name, v]) => ({ name, spent: v.spent, estimate: v.estimate })),
      total: { spent: timeTotalSpent, estimate: timeTotalEstimate },
    },
  };
}

module.exports = {
  getConfig() {
    const c = loadConfig();
    return { configured: c.configured, url: c.url };
  },

  async projects() {
    const cfg = loadConfig();
    if (!cfg.configured) throw notConfigured();
    const list = await jiraCall('/project?maxResults=200', cfg);
    return (Array.isArray(list) ? list : []).map((p) => ({
      key: p.key,
      name: p.name,
      lead: p.lead && p.lead.displayName,
    }));
  },

  async search({ projectKey, jql, maxResults, startAt }) {
    const cfg = loadConfig();
    if (!cfg.configured) throw notConfigured();
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

  async users(q) {
    const cfg = loadConfig();
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

  async assignables(projectKeys) {
    const cfg = loadConfig();
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

  async activeSprints(projectKeys) {
    const cfg = loadConfig();
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

  async issue(key) {
    const cfg = loadConfig();
    if (!cfg.configured) throw notConfigured();
    const fields = SEARCH_FIELD_LIST.concat(['description', 'comment', 'components', 'labels', 'fixVersions', 'resolution']).join(',');
    return jiraCall('/issue/' + encodeURIComponent(key) + '?fields=' + fields, cfg);
  },

  dashboard,
};