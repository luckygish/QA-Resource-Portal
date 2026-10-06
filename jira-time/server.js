// JiraTime — автономный инструмент массовой простановки «Срок исполнения» (duedate)
// задачам/ошибкам/активностям активного спринта. Вне портала.
// Статика запечатана в exe (pkg) и доступна через __dirname (снапшот); конфиг Jira
// читается jira.js из папки рядом с exe (или из корня репозитория в dev).

const path = require('path');
const express = require('express');
const { spawn } = require('child_process');
const jira = require('./jira');

const DEFAULT_PORT = Number(process.env.JIRATIME_PORT) || 3400;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function isWorkingStatus(status) {
  const cat = status && status.statusCategory;
  return !cat || String(cat.key || '').toLowerCase() !== 'done';
}

function mapTask(it) {
  const f = it.fields || {};
  const status = f.status || {};
  return {
    key: it.key,
    summary: String(f.summary || ''),
    type: (f.issuetype && f.issuetype.name) || '—',
    status: status.name || '—',
    statusCategory: (status.statusCategory && status.statusCategory.key) || '',
    duedate: f.duedate || null,
    assignee: f.assignee ? (f.assignee.displayName || f.assignee.name || null) : null,
    labels: Array.isArray(f.labels) ? f.labels.slice() : [],
    components: (Array.isArray(f.components) ? f.components : []).map((c) => (c && c.name) || ''),
    url: app.get('jiraUrl') ? app.get('jiraUrl') + '/browse/' + encodeURIComponent(it.key) : null,
  };
}

/* ---------- API ---------- */

app.get('/api/config', (req, res) => {
  const cfg = jira.getConfig();
  if (cfg.configured) return res.json({ configured: true, url: cfg.url });
  const msg = 'Jira не настроена. Проверено: ' + (cfg.configPaths || []).join('; ')
    + '. Задайте JIRA_URL/JIRA_PERSONAL_TOKEN или положите рядом с JiraTime.exe файл .jira-config.json вида {"url":"https://jira.example.ru","token":"<PAT>"}'
    + (cfg.issue ? '. Причина: ' + cfg.issue : '');
  return res.status(503).json({ error: msg });
});

// Пробник интеграции с Jira: /myself + классификация ошибки (auth/network/tls/dns/http).
app.get('/api/health/jira', async (req, res) => {
  try {
    res.json(await jira.health());
  } catch (e) {
    res.status(500).json({ ok: false, message: (e && e.message) || 'Ошибка проверки' });
  }
});

app.get('/api/projects', async (req, res) => {
  try {
    const list = await jira.projects();
    res.json({ projects: list });
  } catch (e) {
    res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 500)
      .json({ error: (e && e.message) || 'Ошибка загрузки проектов' });
  }
});

app.get('/api/tasks', async (req, res) => {
  const project = String((req.query && req.query.project) || '').trim().toUpperCase();
  if (!project) return res.status(400).json({ error: 'Укажите проект (param project)' });
  try {
    const { total, issues } = await jira.searchActiveSprint(project);
    const tasks = issues
      .filter((it) => isWorkingStatus(it.fields && it.fields.status))
      .map(mapTask)
      .sort((a, b) => String(a.key).localeCompare(String(b.key)));
    res.json({ project, total, tasks });
  } catch (e) {
    res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 500)
      .json({ error: (e && e.message) || 'Ошибка загрузки задач' });
  }
});

// Валидация даты dd/MM/yyyy (реальная календарная дата).
function parseDmY(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

function toIso(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

app.post('/api/tasks/update', async (req, res) => {
  const { tasks, duedate } = (req.body || {});
  const keys = Array.isArray(tasks) ? tasks.map((k) => String(k).trim()).filter(Boolean) : [];
  if (!keys.length) return res.status(400).json({ error: 'Нет задач для обновления (body.tasks)' });
  if (keys.length > 400) return res.status(400).json({ error: 'Слишком много задач (максимум 400)' });

  const dt = parseDmY(duedate);
  if (!dt) return res.status(400).json({ error: 'Укажите дату в формате dd/MM/yyyy' });
  const iso = toIso(dt);

  const failed = [];
  let updated = 0;
  for (const key of keys) {
    try {
      await jira.updateDueDate(key, iso);
      updated += 1;
    } catch (e) {
      failed.push({ key, error: (e && e.message) || 'HTTP ' + (e && e.status) });
    }
  }
  res.json({ ok: failed.length === 0, updated, failed, duedate: iso });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function openBrowser(url) {
  if (process.env.JIRATIME_NO_OPEN) return;
  try {
    const stdio = 'ignore';
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio, detached: true, windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio, detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio, detached: true }).unref();
    }
  } catch (e) {
    console.error('Не удалось открыть браузер:', e.message);
  }
}

function listen(port) {
  return new Promise((resolve) => {
    const server = app.listen(port);
    server.once('error', () => resolve(null));
    server.once('listening', () => resolve(server));
  });
}

(async function start() {
  const cfg = jira.getConfig();
  if (cfg.configured) app.set('jiraUrl', cfg.url);
  let server = null;
  let port = DEFAULT_PORT;
  for (let i = 0; i < 100; i += 1) {
    server = await listen(port);
    if (server) break;
    port += 1;
  }
  if (!server) {
    console.error('Не удалось занять порт для запуска сервера.');
    return;
  }
  const url = 'http://localhost:' + server.address().port;
  console.log('JiraTime listening on ' + url);
  if (!cfg.configured) console.warn('Внимание: Jira не настроена (JIRA_URL/JIRA_PERSONAL_TOKEN или ../.jira-config.json).');
  openBrowser(url);
})();