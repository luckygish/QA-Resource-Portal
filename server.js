const fs = require('fs');
const path = require('path');
const express = require('express');
const seed = require('./seed');
const jira = require('./jira');
const { spawn } = require('child_process');

// When packaged into a single .exe (pkg/SEA), __dirname points into an in-memory
// snapshot that does not persist writes. Resolve data storage to a real folder
// next to the executable so data.json survives across runs.
const APP_DIR = typeof process !== 'undefined' && process.pkg ? path.dirname(process.execPath) : __dirname;
const DATA_FILE = path.join(APP_DIR, 'data.json');
const DEFAULT_PORT = Number(process.env.PORT) || 3001;

const app = express();
app.use(express.json());

/* ---------------- init / migration ---------------- */

function normalizeData(data) {
  let changed = false;

  // seed registry + categories if empty
  if (!Array.isArray(data.skillRegistry) || data.skillRegistry.length === 0) {
    data.skillRegistry = seed.skillRegistry.map((s) => JSON.parse(JSON.stringify(s)));
    changed = true;
  }
  if (!Array.isArray(data.categories) || data.categories.length === 0) {
    data.categories = seed.categories.map((c) => ({ ...c }));
    changed = true;
  }

  // ensure categories used by registry skills exist in the list
  data.skillRegistry.forEach((s) => {
    if (!data.categories.some((c) => c.name === s.category)) {
      data.categories.push({ id: nextId(data.categories), name: s.category });
      changed = true;
    }
  });

  // migrate user.skills: { skill, level } -> { skillId, level }
  (data.users || []).forEach((user) => {
    if (!Array.isArray(user.skills)) { user.skills = []; changed = true; return; }
    user.skills.forEach((sk) => {
      if (sk && 'skill' in sk && !('skillId' in sk)) {
        const hit = data.skillRegistry.find((r) => r.skill.trim().toLowerCase() === String(sk.skill).trim().toLowerCase());
        if (hit) {
          delete sk.skill;
          sk.skillId = hit.id;
        } else {
          sk._drop = true;
        }
        changed = true;
      }
    });
    const kept = (user.skills || []).filter((sk) => sk && !sk._drop);
    (user.skills || []).forEach((sk) => { if (sk) delete sk._drop; });
    if (kept.length !== user.skills.length) { user.skills = kept; changed = true; }
  });

  // ensure managers array exists
  if (!Array.isArray(data.managers)) { data.managers = []; changed = true; }

  // extend projects with registry fields (defaults) if missing
  (data.projects || []).forEach((p) => {
    if (!('abbreviation' in p)) { p.abbreviation = ''; changed = true; }
    if (!('isGovernmentContract' in p)) { p.isGovernmentContract = false; changed = true; }
    if (!('contractNumber' in p)) { p.contractNumber = null; changed = true; }
    if (!('managerId' in p)) { p.managerId = null; changed = true; }
    if (!('jiraKey' in p)) { p.jiraKey = null; changed = true; }
  });

  // migrate request.manager (string) -> managerId, creating managers on the fly
  (data.requests || []).forEach((r) => {
    if ('manager' in r && !('managerId' in r)) {
      const name = String(r.manager == null ? '' : r.manager).trim();
      let mid = null;
      if (name) {
        let mgr = data.managers.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
        if (!mgr) { mgr = { id: nextId(data.managers), name, email: '' }; data.managers.push(mgr); }
        mid = mgr.id;
        // if the request links to a project without a manager, link the manager to it
        const proj = data.projects.find((p) => p.id === Number(r.projectId));
        if (proj && !proj.managerId && mid != null) { proj.managerId = mid; changed = true; }
      }
      r.managerId = mid;
      delete r.manager;
      changed = true;
    }
  });

  // all projects are government contracts
  (data.projects || []).forEach((p) => {
    if (p.isGovernmentContract !== true) { p.isGovernmentContract = true; changed = true; }
  });

  return changed;
}

function initData() {
  let data;
  if (fs.existsSync(DATA_FILE)) {
    data = readData();
  } else {
    // first run with no data file: create an empty baseline so the server
    // starts cleanly and the seed/migration populates the registry.
    data = { users: [], projects: [], requests: [], managers: [], skillRegistry: [], categories: [] };
    writeData(data);
  }
  if (normalizeData(data)) writeData(data);
}

/* ---------------- storage ---------------- */

function readData() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  return JSON.parse(raw);
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Serialize mutations (Node is single-threaded, but queue prevents interleaved async reads)
let queue = Promise.resolve();
function withLock(fn) {
  const run = queue.then(() => fn());
  queue = run.catch(() => {});
  return run;
}

function nextId(arr) {
  return arr.reduce((m, i) => Math.max(m, Number(i.id) || 0), 0) + 1;
}

/* ---------------- helpers ---------------- */

function parseDate(s) {
  const d = new Date(s);
  return d.getTime();
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return parseDate(aStart) <= parseDate(bEnd) && parseDate(bStart) <= parseDate(aEnd);
}

// For a candidate assignment on a user, find any day where total overlap exceeds 100%.
// Returns { ok: true } or { ok: false, conflicts: [...] }
function checkOverload(user, candidate) {
  const relevant = user.assignments.filter((a) => a.id !== candidate.id && overlap(a.start, a.end, candidate.start, candidate.end));
  if (relevant.length === 0) return { ok: true };

  const cStart = parseDate(candidate.start);
  const cEnd = parseDate(candidate.end);
  const DAY = 86400000;

  for (let t = cStart; t <= cEnd; t += DAY) {
    let total = Number(candidate.percent) || 0;
    const onDay = [];
    for (const a of relevant) {
      if (parseDate(a.start) <= t && t <= parseDate(a.end)) {
        total += Number(a.percent) || 0;
        onDay.push(a);
      }
    }
    if (total > 100) {
      return {
        ok: false,
        conflicts: onDay.map((a) => ({ assignment: a, day: new Date(t).toISOString().slice(0, 10), total })),
      };
    }
  }
  return { ok: true };
}

function err(res, code, message, extra = {}) {
  return res.status(code).json({ error: message, ...extra });
}

const GRADES = ['Junior', 'Middle', 'Senior', 'Lead'];
const REQUEST_STATUSES = ['Новая', 'В работе', 'Закрыта', 'Отклонена'];

// normalizes a percent to an integer in 1..100, or null if invalid
function validPercent(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : null;
}

function validateBoolFields(body, fields) {
  for (const f of fields) if (!(f in body)) return false;
  return true;
}

/* ---------------- API: data/catalog ---------------- */

app.get('/api/data', (req, res) => {
  res.json(readData());
});

/* ---------------- users ---------------- */

app.post('/api/users', (req, res) => {
  const { name, grade, email } = req.body || {};
  if (!name || !GRADES.includes(grade)) return err(res, 400, 'Нужны name и валидный grade');
  withLock(() => {
    const data = readData();
    const user = { id: nextId(data.users), name, grade, email: email || '', skills: [], assignments: [] };
    data.users.push(user);
    writeData(data);
    res.json(user);
  });
});

app.put('/api/users/:id', (req, res) => {
  const id = Number(req.params.id);
  withLock(() => {
    const data = readData();
    const user = data.users.find((u) => u.id === id);
    if (!user) return err(res, 404, 'Тестировщик не найден');
    if (req.body && validateBoolFields(req.body, ['name', 'grade'])) {
      if (req.body.grade && !GRADES.includes(req.body.grade)) return err(res, 400, 'Некорректный grade');
      user.name = req.body.name;
      user.grade = req.body.grade;
    }
    if (req.body && 'email' in req.body) user.email = req.body.email;
    if (req.body && 'age' in req.body) {
      const age = req.body.age === '' || req.body.age == null ? null : Number(req.body.age);
      if (age !== null && (!Number.isInteger(age) || age < 0 || age > 200)) return err(res, 400, 'Некорректный возраст');
      user.age = age;
    }
    if (req.body && 'about' in req.body) {
      const about = String(req.body.about == null ? '' : req.body.about);
      if (about.length > 255) return err(res, 400, '«О себе» должно быть не длиннее 255 символов');
      user.about = about;
    }
    writeData(data);
    res.json(user);
  });
});

app.delete('/api/users/:id', (req, res) => {
  const id = Number(req.params.id);
  withLock(() => {
    const data = readData();
    const idx = data.users.findIndex((u) => u.id === id);
    if (idx === -1) return err(res, 404, 'Тестировщик не найден');
    data.users.splice(idx, 1);
    // unassign from requests
    data.requests.forEach((r) => {
      if (r.assignedUserId === id) { r.assignedUserId = null; r.status = 'Новая'; }
    });
    writeData(data);
    res.json({ ok: true });
  });
});

/* ---------------- user skills ---------------- */

app.post('/api/users/:id/skills', (req, res) => {
  const id = Number(req.params.id);
  const { skillId, level } = req.body || {};
  if (skillId === undefined || level === undefined) return err(res, 400, 'Нужны skillId и level');
  withLock(() => {
    const data = readData();
    const user = data.users.find((u) => u.id === id);
    if (!user) return err(res, 404, 'Тестировщик не найден');
    if (!data.skillRegistry.some((s) => s.id === Number(skillId))) return err(res, 400, 'Такого навыка нет в реестре');
    const entry = { skillId: Number(skillId), level: Math.min(4, Math.max(1, Number(level))) };
    user.skills.push(entry);
    writeData(data);
    res.json(entry);
  });
});

app.put('/api/users/:id/skills/:idx', (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  withLock(() => {
    const data = readData();
    const user = data.users.find((u) => u.id === id);
    if (!user) return err(res, 404, 'Тестировщик не найден');
    if (!user.skills[idx]) return err(res, 404, 'Навык не найден');
    const b = req.body || {};
    if ('skillId' in b) {
      if (!data.skillRegistry.some((s) => s.id === Number(b.skillId))) return err(res, 400, 'Такого навыка нет в реестре');
      user.skills[idx].skillId = Number(b.skillId);
    }
    if ('level' in b) user.skills[idx].level = Math.min(4, Math.max(1, Number(b.level)));
    writeData(data);
    res.json(user.skills[idx]);
  });
});

app.delete('/api/users/:id/skills/:idx', (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  withLock(() => {
    const data = readData();
    const user = data.users.find((u) => u.id === id);
    if (!user) return err(res, 404, 'Тестировщик не найден');
    if (!user.skills[idx]) return err(res, 404, 'Навык не найден');
    user.skills.splice(idx, 1);
    writeData(data);
    res.json({ ok: true });
  });
});

/* ---------------- user assignments ---------------- */

app.post('/api/users/:id/assignments', (req, res) => {
  const id = Number(req.params.id);
  const { projectId, start, end, percent } = req.body || {};
  if (!projectId || !start || !end || percent === undefined) return err(res, 400, 'Нужны projectId, start, end, percent');
  const pct = validPercent(percent);
  if (pct == null) return err(res, 400, 'Занятость должна быть в диапазоне 1–100%');
  withLock(() => {
    const data = readData();
    const user = data.users.find((u) => u.id === id);
    if (!user) return err(res, 404, 'Тестировщик не найден');
    if (!data.projects.some((p) => p.id === Number(projectId))) return err(res, 400, 'Проект не найден');
    const candidate = { id: 0, projectId: Number(projectId), start, end, percent: pct };
    const check = checkOverload(user, candidate);
    if (!check.ok) return err(res, 409, 'Перегрузка занятости', { conflicts: check.conflicts });
    candidate.id = nextId(data.users.flatMap((u) => u.assignments));
    user.assignments.push(candidate);
    writeData(data);
    res.json(candidate);
  });
});

app.put('/api/users/:id/assignments/:aid', (req, res) => {
  const id = Number(req.params.id);
  const aid = Number(req.params.aid);
  withLock(() => {
    const data = readData();
    const user = data.users.find((u) => u.id === id);
    if (!user) return err(res, 404, 'Тестировщик не найден');
    const a = user.assignments.find((x) => x.id === aid);
    if (!a) return err(res, 404, 'Назначение не найдено');
    const b = req.body || {};
    const candidate = { ...a, ...b, id: aid };
    if ('percent' in b) {
      const pct = validPercent(b.percent);
      if (pct == null) return err(res, 400, 'Занятость должна быть в диапазоне 1–100%');
      candidate.percent = pct;
    }
    if (b.projectId && !data.projects.some((p) => p.id === Number(b.projectId))) return err(res, 400, 'Проект не найден');
    const check = checkOverload(user, candidate);
    if (!check.ok) return err(res, 409, 'Перегрузка занятости', { conflicts: check.conflicts });
    Object.assign(a, candidate, { id: aid });
    writeData(data);
    res.json(a);
  });
});

app.delete('/api/users/:id/assignments/:aid', (req, res) => {
  const id = Number(req.params.id);
  const aid = Number(req.params.aid);
  withLock(() => {
    const data = readData();
    const user = data.users.find((u) => u.id === id);
    if (!user) return err(res, 404, 'Тестировщик не найден');
    const idx = user.assignments.findIndex((x) => x.id === aid);
    if (idx === -1) return err(res, 404, 'Назначение не найдено');
    user.assignments.splice(idx, 1);
    writeData(data);
    res.json({ ok: true });
  });
});

/* ---------------- projects (registry) ---------------- */

function normalizeProjectBody(data, body) {
  const b = body || {};
  const out = {};

  if (b.name !== undefined) {
    const name = String(b.name == null ? '' : b.name).trim();
    if (!name) return { ok: false, error: 'Укажите название проекта' };
    out.name = name;
  }

  if (b.abbreviation !== undefined) {
    out.abbreviation = String(b.abbreviation == null ? '' : b.abbreviation).trim();
  }

  if (b.contractNumber !== undefined) {
    out.contractNumber = String(b.contractNumber == null ? '' : b.contractNumber).trim();
  }

  if (b.jiraKey !== undefined) {
    const jk = b.jiraKey == null ? '' : String(b.jiraKey).trim().toUpperCase();
    out.jiraKey = jk || null;
  }

  if (b.managerId !== undefined) {
    if (b.managerId == null || b.managerId === '') {
      out.managerId = null;
    } else {
      const mid = Number(b.managerId);
      if (!data.managers.some((m) => m.id === mid)) return { ok: false, error: 'Менеджер не найден в реестре' };
      out.managerId = mid;
    }
  }

  return { ok: true, data: out };
}

function projectView(p) {
  return {
    id: p.id,
    name: p.name,
    abbreviation: p.abbreviation || '',
    isGovernmentContract: true,
    contractNumber: p.contractNumber || null,
    managerId: p.managerId != null ? p.managerId : null,
    jiraKey: p.jiraKey || null,
  };
}

app.get('/api/projects', (req, res) => {
  res.json(readData().projects.map(projectView));
});

app.get('/api/projects/:id', (req, res) => {
  const data = readData();
  const p = data.projects.find((x) => x.id === Number(req.params.id));
  if (!p) return err(res, 404, 'Проект не найден');
  res.json(projectView(p));
});

app.post('/api/projects', (req, res) => {
  withLock(() => {
    const data = readData();
    const norm = normalizeProjectBody(data, req.body || {});
    if (!norm.ok) return err(res, 400, norm.error);
    if (!norm.data.name) return err(res, 400, 'Укажите название проекта');
    const b = norm.data;
    const p = {
      id: nextId(data.projects),
      name: b.name,
      abbreviation: b.abbreviation || '',
      isGovernmentContract: true,
      contractNumber: b.contractNumber !== undefined ? b.contractNumber : null,
      managerId: b.managerId != null ? b.managerId : null,
      jiraKey: b.jiraKey !== undefined ? b.jiraKey : null,
    };
    data.projects.push(p);
    writeData(data);
    res.json(projectView(p));
  });
});

app.put('/api/projects/:id', (req, res) => {
  const id = Number(req.params.id);
  withLock(() => {
    const data = readData();
    const p = data.projects.find((x) => x.id === id);
    if (!p) return err(res, 404, 'Проект не найден');
    const norm = normalizeProjectBody(data, req.body || {});
    if (!norm.ok) return err(res, 400, norm.error);
    const b = norm.data;
    if (b.name !== undefined) p.name = b.name;
    if (b.abbreviation !== undefined) p.abbreviation = b.abbreviation;
    if (b.contractNumber !== undefined) p.contractNumber = b.contractNumber;
    if (b.managerId !== undefined) p.managerId = b.managerId;
    if (b.jiraKey !== undefined) p.jiraKey = b.jiraKey;
    p.isGovernmentContract = true;
    writeData(data);
    res.json(projectView(p));
  });
});

app.delete('/api/projects/:id', (req, res) => {
  const id = Number(req.params.id);
  withLock(() => {
    const data = readData();
    const idx = data.projects.findIndex((x) => x.id === id);
    if (idx === -1) return err(res, 404, 'Проект не найден');
    const usedInAssign = data.users.some((u) => (u.assignments || []).some((a) => a.projectId === id));
    const usedInReq = data.requests.some((r) => r.projectId === id);
    if (usedInAssign || usedInReq) {
      const why = [];
      if (usedInAssign) why.push('занятости');
      if (usedInReq) why.push('заявках');
      return err(res, 409, 'Нельзя удалить: проект используется в ' + why.join(' и '));
    }
    data.projects.splice(idx, 1);
    writeData(data);
    res.json({ ok: true });
  });
});

/* ---------------- managers (registry) ---------------- */

app.get('/api/managers', (req, res) => {
  res.json(readData().managers || []);
});

app.get('/api/managers/:id', (req, res) => {
  const data = readData();
  const m = data.managers.find((x) => x.id === Number(req.params.id));
  if (!m) return err(res, 404, 'Менеджер не найден');
  res.json(m);
});

app.post('/api/managers', (req, res) => {
  withLock(() => {
    const data = readData();
    const name = String((req.body || {}).name || '').trim();
    if (!name) return err(res, 400, 'Укажите имя менеджера');
    if (data.managers.some((m) => m.name.trim().toLowerCase() === name.toLowerCase())) return err(res, 409, 'Менеджер с таким именем уже существует');
    const email = req.body.email === undefined ? '' : String(req.body.email).trim();
    const m = { id: nextId(data.managers), name, email };
    data.managers.push(m);
    writeData(data);
    res.json(m);
  });
});

app.put('/api/managers/:id', (req, res) => {
  const id = Number(req.params.id);
  withLock(() => {
    const data = readData();
    const m = data.managers.find((x) => x.id === id);
    if (!m) return err(res, 404, 'Менеджер не найден');
    const b = req.body || {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) return err(res, 400, 'Укажите имя менеджера');
      if (data.managers.some((x) => x.id !== id && x.name.trim().toLowerCase() === name.toLowerCase())) return err(res, 409, 'Менеджер с таким именем уже существует');
      m.name = name;
    }
    if (b.email !== undefined) m.email = String(b.email).trim();
    writeData(data);
    res.json(m);
  });
});

app.delete('/api/managers/:id', (req, res) => {
  const id = Number(req.params.id);
  withLock(() => {
    const data = readData();
    const idx = data.managers.findIndex((x) => x.id === id);
    if (idx === -1) return err(res, 404, 'Менеджер не найден');
    if (data.projects.some((p) => p.managerId === id)) return err(res, 409, 'Нельзя удалить: менеджер назначен на проекты');
    data.managers.splice(idx, 1);
    writeData(data);
    res.json({ ok: true });
  });
});

/* ---------------- requests ---------------- */

app.post('/api/requests', (req, res) => {
  const { projectId, grade, start, end, percent, comment, managerId } = req.body || {};
  const pct = validPercent(percent);
  if (!projectId || !grade || !start || !end || pct == null) return err(res, 400, 'Нужны projectId, grade, start, end, percent');
  if (!GRADES.includes(grade)) return err(res, 400, 'Некорректный grade');
  if (!comment || !String(comment).trim()) return err(res, 400, 'Комментарий обязателен');
  if (managerId == null || managerId === '') return err(res, 400, 'Менеджер проекта обязателен');
  withLock(() => {
    const data = readData();
    if (!data.projects.some((p) => p.id === Number(projectId))) return err(res, 400, 'Проект не найден');
    const mid = Number(managerId);
    if (!data.managers.some((m) => m.id === mid)) return err(res, 400, 'Менеджер не найден в реестре');
    const r = {
      id: nextId(data.requests),
      projectId: Number(projectId),
      grade,
      start,
      end,
      percent: pct,
      status: 'Новая',
      comment: String(comment).trim(),
      managerId: mid,
      assignedUserId: null,
    };
    data.requests.push(r);
    writeData(data);
    res.json(r);
  });
});

app.put('/api/requests/:id', (req, res) => {
  const id = Number(req.params.id);
  withLock(() => {
    const data = readData();
    const r = data.requests.find((x) => x.id === id);
    if (!r) return err(res, 404, 'Заявка не найдена');
    const b = req.body || {};
    for (const key of ['projectId', 'grade', 'start', 'end', 'comment', 'managerId']) {
      if (key in b) r[key] = b[key];
    }
    if ('percent' in b) {
      const pct = validPercent(b.percent);
      if (pct == null) return err(res, 400, 'Занятость должна быть в диапазоне 1–100%');
      r.percent = pct;
    }
    if ('managerId' in b) {
      const mid = b.managerId == null || b.managerId === '' ? null : Number(b.managerId);
      if (mid != null && !data.managers.some((m) => m.id === mid)) {
        return err(res, 400, 'Менеджер не найден в реестре');
      }
      r.managerId = mid;
    }
    if (b.status) {
      if (!REQUEST_STATUSES.includes(b.status)) return err(res, 400, 'Некорректный статус');
      r.status = b.status;
    }
    writeData(data);
    res.json(r);
  });
});

app.delete('/api/requests/:id', (req, res) => {
  const id = Number(req.params.id);
  withLock(() => {
    const data = readData();
    const idx = data.requests.findIndex((x) => x.id === id);
    if (idx === -1) return err(res, 404, 'Заявка не найдена');
    data.requests.splice(idx, 1);
    writeData(data);
    res.json({ ok: true });
  });
});

/* assign a tester to a request */
app.post('/api/requests/:id/assign', (req, res) => {
  const id = Number(req.params.id);
  const userId = Number((req.body || {}).userId);
  if (!userId) return err(res, 400, 'Нужен userId');
  withLock(() => {
    const data = readData();
    const r = data.requests.find((x) => x.id === id);
    if (!r) return err(res, 404, 'Заявка не найдена');
    if (r.assignedUserId) return err(res, 409, 'Заявка уже имеет назначенного тестировщика');
    const user = data.users.find((u) => u.id === userId);
    if (!user) return err(res, 404, 'Тестировщик не найден');
    const candidate = { id: 0, projectId: r.projectId, start: r.start, end: r.end, percent: r.percent };
    const check = checkOverload(user, candidate);
    if (!check.ok) return err(res, 409, 'Пересечение периодов или перегрузка занятости', { conflicts: check.conflicts });
    candidate.id = nextId(data.users.flatMap((u) => u.assignments));
    user.assignments.push(candidate);
    r.assignedUserId = userId;
    r.status = 'В работе';
    writeData(data);
    res.json({ request: r, assignment: candidate });
  });
});

/* ---------------- skill registry ---------------- */

function registrySkill(res, data, id) {
  const s = data.skillRegistry.find((x) => x.id === Number(id));
  if (!s) return err(res, 404, 'Навык не найден в реестре');
  return s;
}

function validLevels(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const k of ['1', '2', '3', '4']) {
    const v = obj[k];
    if (v === undefined || v === null || !String(v).trim()) return null;
    out[k] = String(v).trim();
  }
  return out;
}

app.get('/api/skills', (req, res) => {
  const data = readData();
  res.json(data.skillRegistry.map((s) => ({ id: s.id, skill: s.skill, category: s.category })));
});

app.get('/api/skills/:id', (req, res) => {
  const data = readData();
  const s = registrySkill(res, data, req.params.id);
  if (s) res.json(s);
});

app.post('/api/skills', (req, res) => {
  const { skill, category, levels } = req.body || {};
  const lv = validLevels(levels);
  if (!skill || !String(skill).trim()) return err(res, 400, 'Нужно название навыка');
  if (!category || !String(category).trim()) return err(res, 400, 'Нужна категория');
  if (!lv) return err(res, 400, 'Нужны описания уровней 1–4');
  withLock(() => {
    const data = readData();
    const name = String(skill).trim();
    if (data.skillRegistry.some((x) => x.skill.trim().toLowerCase() === name.toLowerCase())) return err(res, 409, 'Навык с таким названием уже есть');
    if (!data.categories.some((c) => c.name === String(category).trim())) return err(res, 400, 'Категория не найдена');
    const item = { id: nextId(data.skillRegistry), skill: name, category: String(category).trim(), levels: lv };
    data.skillRegistry.push(item);
    writeData(data);
    res.json(item);
  });
});

app.put('/api/skills/:id', (req, res) => {
  const lv = validLevels(req.body ? req.body.levels : null);
  withLock(() => {
    const data = readData();
    const item = registrySkill(res, data, req.params.id);
    if (!item) return;
    const b = req.body || {};
    if ('skill' in b) {
      if (!String(b.skill).trim()) return err(res, 400, 'Название не может быть пустым');
      item.skill = String(b.skill).trim();
    }
    if ('category' in b) {
      if (!String(b.category).trim()) return err(res, 400, 'Категория не может быть пустой');
      if (!data.categories.some((c) => c.name === String(b.category).trim())) return err(res, 400, 'Категория не найдена');
      item.category = String(b.category).trim();
    }
    if (lv) item.levels = lv;
    else if (req.body && 'levels' in req.body) return err(res, 400, 'Нужны корректные описания уровней 1–4');
    writeData(data);
    res.json(item);
  });
});

app.delete('/api/skills/:id', (req, res) => {
  const id = Number(req.params.id);
  withLock(() => {
    const data = readData();
    const idx = data.skillRegistry.findIndex((x) => x.id === id);
    if (idx === -1) return err(res, 404, 'Навык не найден в реестре');
    data.skillRegistry.splice(idx, 1);
    (data.users || []).forEach((u) => {
      u.skills = (u.skills || []).filter((sk) => !(sk && sk.skillId === id));
    });
    writeData(data);
    res.json({ ok: true });
  });
});

app.get('/api/categories', (req, res) => {
  res.json(readData().categories);
});

app.post('/api/categories', (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return err(res, 400, 'Нужно название категории');
  withLock(() => {
    const data = readData();
    if (data.categories.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())) return err(res, 409, 'Категория уже существует');
    const cat = { id: nextId(data.categories), name };
    data.categories.push(cat);
    writeData(data);
    res.json(cat);
  });
});

/* ---------------- Jira integration (read-only proxy) ---------------- */

app.get('/api/jira/health', (req, res) => {
  res.json(jira.getConfig());
});

app.get('/api/jira/projects', async (req, res) => {
  try {
    res.json(await jira.projects());
  } catch (e) {
    err(res, e.status || 502, e.message);
  }
});

app.post('/api/jira/search', async (req, res) => {
  try {
    res.json(await jira.search(req.body || {}));
  } catch (e) {
    err(res, e.status || 502, e.message);
  }
});

app.get('/api/jira/users', async (req, res) => {
  try {
    res.json(await jira.users(req.query.q));
  } catch (e) {
    err(res, e.status || 502, e.message);
  }
});

app.post('/api/jira/assignables', async (req, res) => {
  try {
    res.json(await jira.assignables(((req.body || {}).projectKeys) || []));
  } catch (e) {
    err(res, e.status || 502, e.message);
  }
});

app.post('/api/jira/active-sprints', async (req, res) => {
  try {
    res.json(await jira.activeSprints(((req.body || {}).projectKeys) || []));
  } catch (e) {
    err(res, e.status || 502, e.message);
  }
});

app.get('/api/jira/issue/:key', async (req, res) => {
  try {
    res.json(await jira.issue(req.params.key));
  } catch (e) {
    err(res, e.status || 502, e.message);
  }
});

app.get('/api/jira/dashboard', async (req, res) => {
  try {
    res.json(await jira.dashboard(String(req.query.projectKey || ''), { cap: Number(req.query.cap) || undefined }));
  } catch (e) {
    err(res, e.status || 502, e.message);
  }
});

/* ---------------- static + fallback ---------------- */

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

function openBrowser(url) {
  if (process.env.PORTAL_NO_OPEN) return;
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
  initData();
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
  const actual = server.address().port;
  const url = `http://localhost:${actual}`;
  console.log(`QA Resource Portal listening on ${url}`);
  console.log(`Data file: ${DATA_FILE}`);
  openBrowser(url);
})();