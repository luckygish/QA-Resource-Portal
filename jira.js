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
};