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

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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

function isOpenIt(it) {
  const f = it && it.fields;
  return !(f && f.resolution);
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

function sprintNameOfIssue(it) {
  return (it && it._sprintNames && it._sprintNames[0]) || null;
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
  const cap = Number(opts.cap) || 1000;

  const [active, unresolved, closed] = await Promise.all([
    searchAll(cfg, `project = "${key}" AND sprint in openSprints()`, { cap: 500 }),
    searchAll(cfg, `project = "${key}" AND resolution is EMPTY`, { cap: 500 }),
    searchAll(cfg, `project = "${key}" AND sprint in closedSprints()`, { cap }),
  ]);

  // ---- Block A: summary / byStatus / byType / byAssignee / byPriority / byEnvironment
  const kpi = { open: 0, activeBugs: 0, inTesting: 0, aggSpentActive: 0 };
  const byStatus = {};
  const byType = {};
  const byAssignee = {};
  const byPriority = {};
  const byEnvironment = {};

  let aggSpentActive = 0;
  active.forEach((it) => {
    aggSpentActive += sumTime(it, 'aggregatetimespent');
    counts(byEnvironment, issueEnv(it, envId));
  });

  // в активном спринте: открытые ошибки
  active.forEach((it) => {
    if (issueTypeName(it) === 'Ошибка' && !isDone(it)) kpi.activeBugs += 1;
  });

  // unresolved: открыто задач, тестирование, по статусам/типам/исполнителю/приоритету
  unresolved.forEach((it) => {
    if (isOpenIt(it)) kpi.open += 1;
    const st = issueStatusName(it);
    if (String(st).trim().toLowerCase() === 'тестирование') kpi.inTesting += 1;
    counts(byStatus, st);
    counts(byType, issueTypeName(it));
    counts(byAssignee, issueAssignee(it));
    counts(byPriority, issuePriority(it));
  });
  kpi.aggSpentActive = aggSpentActive;

  // ---- Block B: velocity over closed sprints + burndown of active sprint
  const sprintDelivered = {};
  const sprintStarted = {};
  const sprintOrder = [];
  closed.forEach((it) => {
    const sn = sprintNameOfIssue(it);
    if (!sn) return;
    if (!(sn in sprintDelivered)) { sprintDelivered[sn] = 0; sprintStarted[sn] = 0; sprintOrder.push(sn); }
    if (isDone(it)) sprintDelivered[sn] += 1;
    else sprintStarted[sn] += 1;
  });
  const velocity = sprintOrder
    .map((name) => ({ sprint: name, delivered: sprintDelivered[name], started: sprintStarted[name] }))
    .slice(-10);

  // burndown of active sprint
  let remaining = 0;
  let burndownDone = 0;
  let burndownTotal = 0;
  let doneCount = 0;
  let remainCount = 0;
  active.forEach((it) => {
    if (isDone(it)) {
      const sp = sumTime(it, 'aggregatetimespent') || sumTime(it, 'timespent');
      burndownDone += sp;
      doneCount += 1;
      burndownTotal += sumTime(it, 'aggregatetimeestimate') || sumTime(it, 'timeestimate');
    } else {
      const rem = sumTime(it, 'aggregatetimeestimate') || sumTime(it, 'timeestimate');
      remaining += rem;
      remainCount += 1;
      burndownTotal += rem;
    }
  });
  const burndown = { remaining, done: burndownDone, total: burndownTotal, counts: { done: doneCount, remaining: remainCount } };

  // ---- Block D: spent vs estimate by assignee and by status
  const timeByAssignee = {};
  const timeByStatus = {};
  let timeTotalSpent = 0;
  let timeTotalEstimate = 0;
  active.forEach((it) => {
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

  const sortDesc = (obj, key) => Object.entries(obj)
    .map(([name, v]) => (key ? { name, value: v[key] } : { name, value: v }))
    .sort((a, b) => b.value - a.value);

  return {
    projectKey: key,
    envFieldResolved: !!envId,
    kpi,
    byStatus: Object.entries(byStatus).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })),
    byType: Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })),
    byAssignee: Object.entries(byAssignee).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })),
    byPriority: Object.entries(byPriority).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })),
    byEnvironment: Object.entries(byEnvironment).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })),
    velocity,
    burndown,
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