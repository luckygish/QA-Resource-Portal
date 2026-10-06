const path = require('path');
const express = require('express');
const seed = require('./seed');
const jira = require('./jira');
const { spawn } = require('child_process');
const { createStore } = require('./repo/store');
const { Auth, hashPassword } = require('./auth');

const DEFAULT_PORT = Number(process.env.PORT) || 3001;

const app = express();
app.use(express.json());

// Разрешённые источники для CORS (MySkills и др. сервисы портала).
// Как правило '*' достаточно для офисного использования; можно ограничить через ALLOW_ORIGINS.
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOW_ORIGINS.includes('*') || (origin && ALLOW_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGINS.includes('*') ? '*' : origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Единый инстанс хранилища (PostgreSQL либо data.json fallback).
let store = null;

// Аутентификация (лениво читает store по колбеку).
const auth = new Auth(() => store);

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
    if (!('isOutstaff' in user)) { user.isOutstaff = false; changed = true; }
  });

  // ensure managers array exists
  if (!Array.isArray(data.managers)) { data.managers = []; changed = true; }

  // ensure assessments array exists
  if (!Array.isArray(data.assessments)) { data.assessments = []; changed = true; }

  // ensure occupancy capacities array exists (per assignee+project, manual)
  if (!Array.isArray(data.capacities)) { data.capacities = []; changed = true; }

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

async function initData() {
  // data.json слепок, если он есть — для импорта в пустую БД и для fallback.
  let baseline = null;
  try {
    const fs = require('fs');
    const { appDir } = require('./repo/db');
    const jsonFile = path.join(appDir(), 'data.json');
    if (fs.existsSync(jsonFile)) baseline = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  } catch (e) {
    console.warn('Не удалось прочитать data.json:', e.message);
  }

  if (!baseline) {
    baseline = { users: [], projects: [], requests: [], managers: [], skillRegistry: [], categories: [], assessments: [], capacities: [] };
  }
  if (normalizeData(baseline)) {
    // помечаем, что рекомендация обновить file имеет смысл только для fallback;
    // для БД инициализация происходит через seed ниже.
  }

  if (store && store.__isDb) {
    // PostgreSQL: если схема пуста — импортировать baseline (data.json или seed).
    const count = await store.countBusinessRows();
    if (count === 0) {
      await store.seed(baseline);
      console.log('[repo] Импортированы стартовые данные в PostgreSQL (' + (baseline.users || []).length + ' пользователей, ' + (baseline.skillRegistry || []).length + ' навыков).');
    }
  }
}

// Бутстрап локальных аккаунтов:
//   - butovds — админ по умолчанию (если нет ни одного админа или УЗ есть);
//   - testLead (Lid) и testPM (PM) — тестовые, вход по локальному паролю 12345678.
// Тестовые УЗ входят без обращений в Jira (пароль хэшируется локально).
async function bootstrapAccounts(store) {
  const upsert = async ({ email, fullName, role, jiraAccountKey, password }) => {
    let account = email ? await store.findAccountByEmail(email) : null;
    if (!account) account = await store.findAccountByJiraKey(jiraAccountKey);
    if (account) {
      if (account.role !== role) account = await store.setAccountRole(account.id, role);
    } else {
      account = await store.createAccount({ email, fullName, role, jiraAccountKey });
    }
    if (password) {
      const existing = await store.getAccountPasswordHash(account.id);
      if (!existing) await store.setAccountPassword(account.id, hashPassword(password));
    }
    return account;
  };

  // butovds — админ по умолчанию.
  const admins = await store.listAccounts().then((list) => list.filter((a) => a.role === 'admin'));
  await upsert({
    email: process.env.ADMIN_JIRA_EMAIL || 'butovds@gnivc.ru',
    fullName: process.env.ADMIN_FULL_NAME || 'Бутов Дмитрий Сергеевич',
    role: 'admin',
    jiraAccountKey: 'ButovDS',
    password: process.env.ADMIN_PASSWORD || undefined,
  });
  // Если админов всё ещё нет (напр. ADMIN_JIRA_EMAIL указывает на другую УЗ) — гарантируем админа.
  const stillNoAdmins = await store.listAccounts().then((list) => list.filter((a) => a.role === 'admin').length === 0);
  if (stillNoAdmins && admins.length === 0) {
    const fallback = await store.findAccountByJiraKey('ButovDS') || (await store.listAccounts())[0];
    if (fallback) await store.setAccountRole(fallback.id, 'admin');
  }

  // Тестовые Лид и ПМ.
  await upsert({ email: 'testLead@demo.local', fullName: 'Test Lead', role: 'lead', jiraAccountKey: 'testLead', password: '12345678' });
  await upsert({ email: 'testPM@demo.local', fullName: 'Test PM', role: 'pm', jiraAccountKey: 'testPM', password: '12345678' });
  console.log('Аккаунты: админ butovds, тестовые testLead (lead), testPM (pm) [пароль 12345678, локальный]');
}

/* ---------------- storage ---------------- */

function readData() { return store.read(); }
function writeData(data) { return store.write(data); }

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

function validPercent(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : null;
}

function validateBoolFields(body, fields) {
  for (const f of fields) if (!(f in body)) return false;
  return true;
}

/* ---------------- API: data/catalog ---------------- */

// Аутентификация (без сессии -> экран входа).
app.get('/api/auth/me', (req, res) => auth.me(req, res));
app.post('/api/auth/logout', (req, res) => auth.logout(req, res));
app.get('/api/auth/jira/login', (req, res) => auth.login(req, res));
app.get('/api/auth/jira/callback', (req, res) => auth.callback(req, res));
// Запасной вход по логину/паролю (Jira Basic), пока OAuth-клиент не настроен.
app.post('/api/auth/login', (req, res) => auth.loginPassword(req, res));

// Админ-панель.
app.get('/api/accounts', auth.authRequired, auth.restrict('admin'), (req, res) => auth.listAccounts(req, res));
app.put('/api/accounts/:id/role', auth.authRequired, auth.restrict('admin'), (req, res) => auth.setRole(req, res));

// Личное пространство сотрудника.
app.get('/api/leads', (req, res, next) => {
  // Доступно сотруднику (сессия) и сервисам (MySkills) по внутреннему токену.
  const svc = req.get('x-portal-token');
  if (svc && process.env.PORTAL_IMPORT_TOKEN && svc === process.env.PORTAL_IMPORT_TOKEN) return next();
  return auth.authRequired(req, res, next);
}, (req, res) => auth.listLeads(req, res));
app.put('/api/my/lead', auth.authRequired, (req, res) => auth.setMyLead(req, res));
app.get('/api/my', auth.authRequired, async (req, res) => {
  const leadId = await store.getLeadLink(req.account.id);
  res.json({ account: req.account, leadId });
});

// Ролевая сборка /api/data.
app.get('/api/data', auth.authRequired, async (req, res) => {
  res.json(await store.readForRole(req.account.role, req.account.id));
});

/* ---------------- users ---------------- */

app.post('/api/users', auth.authRequired, auth.restrict('lead', 'admin'), async (req, res) => {
  const { name, grade, email } = req.body || {};
  if (!name || !GRADES.includes(grade)) return err(res, 400, 'Нужны name и валидный grade');
  await withLock(async () => {
    const data = await readData();
    const user = { id: nextId(data.users), name, grade, email: email || '', isOutstaff: !!(req.body || {}).isOutstaff, ownerId: req.account.id, skills: [], assignments: [] };
    data.users.push(user);
    await writeData(data);
    res.json(user);
  });
});

app.put('/api/users/:id', auth.authRequired, auth.restrict('lead', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  await withLock(async () => {
    const data = await readData();
    const user = data.users.find((u) => u.id === id);
    if (!user) return err(res, 404, 'Сотрудник не найден');
    if (req.account.role !== 'admin' && user.ownerId !== req.account.id) return err(res, 403, 'Это чужой сотрудник');
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
    if (req.body && 'isOutstaff' in req.body) user.isOutstaff = !!req.body.isOutstaff;
    await writeData(data);
    res.json(user);
  });
});

app.delete('/api/users/:id', auth.authRequired, auth.restrict('lead', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  await withLock(async () => {
    const data = await readData();
    const idx = data.users.findIndex((u) => u.id === id);
    if (idx === -1) return err(res, 404, 'Сотрудник не найден');
    const user = data.users[idx];
    if (req.account.role !== 'admin' && user.ownerId !== req.account.id) return err(res, 403, 'Это чужой сотрудник');
    data.users.splice(idx, 1);
    data.requests.forEach((r) => {
      if (r.assignedUserId === id) { r.assignedUserId = null; r.status = 'Новая'; }
    });
    await writeData(data);
    res.json({ ok: true });
  });
});

/* ---------------- user skills ---------------- */

app.post('/api/users/:id/skills', auth.authRequired, auth.restrict('lead', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  const { skillId, level } = req.body || {};
  if (skillId === undefined || level === undefined) return err(res, 400, 'Нужны skillId и level');
  await withLock(async () => {
    const data = await readData();
    const user = data.users.find((u) => u.id === id);
    if (!user) return err(res, 404, 'Сотрудник не найден');
    if (req.account.role !== 'admin' && user.ownerId !== req.account.id) return err(res, 403, 'Это чужой сотрудник');
    if (!data.skillRegistry.some((s) => s.id === Number(skillId))) return err(res, 400, 'Такого навыка нет в реестре');
    const entry = { skillId: Number(skillId), level: Math.min(4, Math.max(1, Number(level))) };
    user.skills.push(entry);
    await writeData(data);
    res.json(entry);
  });
});

app.put('/api/users/:id/skills/:idx', auth.authRequired, auth.restrict('lead', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  await withLock(async () => {
    const data = await readData();
    const user = data.users.find((u) => u.id === id);
    if (!user) return err(res, 404, 'Сотрудник не найден');
    if (req.account.role !== 'admin' && user.ownerId !== req.account.id) return err(res, 403, 'Это чужой сотрудник');
    if (!user.skills[idx]) return err(res, 404, 'Навык не найден');
    const b = req.body || {};
    if ('skillId' in b) {
      if (!data.skillRegistry.some((s) => s.id === Number(b.skillId))) return err(res, 400, 'Такого навыка нет в реестре');
      user.skills[idx].skillId = Number(b.skillId);
    }
    if ('level' in b) user.skills[idx].level = Math.min(4, Math.max(1, Number(b.level)));
    await writeData(data);
    res.json(user.skills[idx]);
  });
});

app.delete('/api/users/:id/skills/:idx', auth.authRequired, auth.restrict('lead', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  await withLock(async () => {
    const data = await readData();
    const user = data.users.find((u) => u.id === id);
    if (!user) return err(res, 404, 'Сотрудник не найден');
    if (req.account.role !== 'admin' && user.ownerId !== req.account.id) return err(res, 403, 'Это чужой сотрудник');
    if (!user.skills[idx]) return err(res, 404, 'Навык не найден');
    user.skills.splice(idx, 1);
    await writeData(data);
    res.json({ ok: true });
  });
});

/* ---------------- user assignments ---------------- */

app.post('/api/users/:id/assignments', auth.authRequired, auth.restrict('lead', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  const { projectId, start, end, percent } = req.body || {};
  if (!projectId || !start || !end || percent === undefined) return err(res, 400, 'Нужны projectId, start, end, percent');
  const pct = validPercent(percent);
  if (pct == null) return err(res, 400, 'Занятость должна быть в диапазоне 1–100%');
  await withLock(async () => {
    const data = await readData();
    const user = data.users.find((u) => u.id === id);
    if (!user) return err(res, 404, 'Сотрудник не найден');
    if (req.account.role !== 'admin' && user.ownerId !== req.account.id) return err(res, 403, 'Это чужой сотрудник');
    if (!data.projects.some((p) => p.id === Number(projectId))) return err(res, 400, 'Проект не найден');
    const candidate = { id: 0, projectId: Number(projectId), start, end, percent: pct };
    const check = checkOverload(user, candidate);
    if (!check.ok) return err(res, 409, 'Перегрузка занятости', { conflicts: check.conflicts });
    candidate.id = nextId(data.users.flatMap((u) => u.assignments ? u.assignments : []));
    user.assignments.push(candidate);
    await writeData(data);
    res.json(candidate);
  });
});

app.put('/api/users/:id/assignments/:aid', auth.authRequired, auth.restrict('lead', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  const aid = Number(req.params.aid);
  await withLock(async () => {
    const data = await readData();
    const user = data.users.find((u) => u.id === id);
    if (!user) return err(res, 404, 'Сотрудник не найден');
    if (req.account.role !== 'admin' && user.ownerId !== req.account.id) return err(res, 403, 'Это чужой сотрудник');
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
    await writeData(data);
    res.json(a);
  });
});

app.delete('/api/users/:id/assignments/:aid', auth.authRequired, auth.restrict('lead', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  const aid = Number(req.params.aid);
  await withLock(async () => {
    const data = await readData();
    const user = data.users.find((u) => u.id === id);
    if (!user) return err(res, 404, 'Сотрудник не найден');
    if (req.account.role !== 'admin' && user.ownerId !== req.account.id) return err(res, 403, 'Это чужой сотрудник');
    const idx = user.assignments.findIndex((x) => x.id === aid);
    if (idx === -1) return err(res, 404, 'Назначение не найдено');
    user.assignments.splice(idx, 1);
    await writeData(data);
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

app.get('/api/projects', auth.authRequired, async (req, res) => {
  res.json((await readData()).projects.map(projectView));
});

app.get('/api/projects/:id', auth.authRequired, async (req, res) => {
  const data = await readData();
  const p = data.projects.find((x) => x.id === Number(req.params.id));
  if (!p) return err(res, 404, 'Проект не найден');
  res.json(projectView(p));
});

app.post('/api/projects', auth.authRequired, auth.restrict('admin', 'lead'), async (req, res) => {
  await withLock(async () => {
    const data = await readData();
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
    await writeData(data);
    res.json(projectView(p));
  });
});

app.put('/api/projects/:id', auth.authRequired, auth.restrict('admin', 'lead'), async (req, res) => {
  const id = Number(req.params.id);
  await withLock(async () => {
    const data = await readData();
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
    await writeData(data);
    res.json(projectView(p));
  });
});

app.delete('/api/projects/:id', auth.authRequired, auth.restrict('admin', 'lead'), async (req, res) => {
  const id = Number(req.params.id);
  await withLock(async () => {
    const data = await readData();
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
    await writeData(data);
    res.json({ ok: true });
  });
});

/* ---------------- managers (registry) ---------------- */

app.get('/api/managers', auth.authRequired, async (req, res) => {
  res.json((await readData()).managers || []);
});

app.get('/api/managers/:id', auth.authRequired, async (req, res) => {
  const data = await readData();
  const m = data.managers.find((x) => x.id === Number(req.params.id));
  if (!m) return err(res, 404, 'Менеджер не найден');
  res.json(m);
});

app.post('/api/managers', auth.authRequired, auth.restrict('admin', 'lead'), async (req, res) => {
  await withLock(async () => {
    const data = await readData();
    const name = String((req.body || {}).name || '').trim();
    if (!name) return err(res, 400, 'Укажите имя менеджера');
    if (data.managers.some((m) => m.name.trim().toLowerCase() === name.toLowerCase())) return err(res, 409, 'Менеджер с таким именем уже существует');
    const email = req.body.email === undefined ? '' : String(req.body.email).trim();
    const m = { id: nextId(data.managers), name, email };
    data.managers.push(m);
    await writeData(data);
    res.json(m);
  });
});

app.put('/api/managers/:id', auth.authRequired, auth.restrict('admin', 'lead'), async (req, res) => {
  const id = Number(req.params.id);
  await withLock(async () => {
    const data = await readData();
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
    await writeData(data);
    res.json(m);
  });
});

app.delete('/api/managers/:id', auth.authRequired, auth.restrict('admin', 'lead'), async (req, res) => {
  const id = Number(req.params.id);
  await withLock(async () => {
    const data = await readData();
    const idx = data.managers.findIndex((x) => x.id === id);
    if (idx === -1) return err(res, 404, 'Менеджер не найден');
    if (data.projects.some((p) => p.managerId === id)) return err(res, 409, 'Нельзя удалить: менеджер назначен на проекты');
    data.managers.splice(idx, 1);
    await writeData(data);
    res.json({ ok: true });
  });
});

/* ---------------- requests ---------------- */

app.post('/api/requests', auth.authRequired, auth.restrict('admin', 'lead', 'pm'), async (req, res) => {
  const { projectId, grade, start, end, percent, comment, managerId } = req.body || {};
  const pct = validPercent(percent);
  if (!projectId || !grade || !start || !end || pct == null) return err(res, 400, 'Нужны projectId, grade, start, end, percent');
  if (!GRADES.includes(grade)) return err(res, 400, 'Некорректный grade');
  if (!comment || !String(comment).trim()) return err(res, 400, 'Комментарий обязателен');
  if (managerId == null || managerId === '') return err(res, 400, 'Менеджер проекта обязателен');
  await withLock(async () => {
    const data = await readData();
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
      createdBy: req.account.id,
    };
    data.requests.push(r);
    await writeData(data);
    res.json(r);
  });
});

app.put('/api/requests/:id', auth.authRequired, auth.restrict('admin', 'lead', 'pm'), async (req, res) => {
  const id = Number(req.params.id);
  await withLock(async () => {
    const data = await readData();
    const r = data.requests.find((x) => x.id === id);
    if (!r) return err(res, 404, 'Заявка не найдена');
    if (req.account.role === 'pm' && r.createdBy !== req.account.id) return err(res, 403, 'Это чужая заявка');
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
    await writeData(data);
    res.json(r);
  });
});

app.delete('/api/requests/:id', auth.authRequired, auth.restrict('admin', 'lead', 'pm'), async (req, res) => {
  const id = Number(req.params.id);
  await withLock(async () => {
    const data = await readData();
    const idx = data.requests.findIndex((x) => x.id === id);
    if (idx === -1) return err(res, 404, 'Заявка не найдена');
    if (req.account.role === 'pm' && data.requests[idx].createdBy !== req.account.id) return err(res, 403, 'Это чужая заявка');
    data.requests.splice(idx, 1);
    await writeData(data);
    res.json({ ok: true });
  });
});

/* assign a tester to a request */
app.post('/api/requests/:id/assign', auth.authRequired, auth.restrict('lead', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  const userId = Number((req.body || {}).userId);
  if (!userId) return err(res, 400, 'Нужен userId');
  await withLock(async () => {
    const data = await readData();
    const r = data.requests.find((x) => x.id === id);
    if (!r) return err(res, 404, 'Заявка не найдена');
    if (r.assignedUserId) return err(res, 409, 'Заявка уже имеет назначенного сотрудника');
    const user = data.users.find((u) => u.id === userId);
    if (!user) return err(res, 404, 'Сотрудник не найден');
    if (req.account.role !== 'admin' && user.ownerId !== req.account.id) return err(res, 403, 'Можно назначать только своего сотрудника');
    const candidate = { id: 0, projectId: r.projectId, start: r.start, end: r.end, percent: r.percent };
    const check = checkOverload(user, candidate);
    if (!check.ok) return err(res, 409, 'Пересечение периодов или перегрузка занятости', { conflicts: check.conflicts });
    candidate.id = nextId(data.users.flatMap((u) => u.assignments ? u.assignments : []));
    user.assignments.push(candidate);
    r.assignedUserId = userId;
    r.status = 'В работе';
    await writeData(data);
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

app.get('/api/skills', auth.authRequired, async (req, res) => {
  const data = await readData();
  res.json(data.skillRegistry.map((s) => ({ id: s.id, skill: s.skill, category: s.category })));
});

app.get('/api/skills/:id', auth.authRequired, async (req, res) => {
  const data = await readData();
  const s = registrySkill(res, data, req.params.id);
  if (s) res.json(s);
});

app.post('/api/skills', auth.authRequired, auth.restrict('admin', 'lead'), async (req, res) => {
  const { skill, category, levels } = req.body || {};
  const lv = validLevels(levels);
  if (!skill || !String(skill).trim()) return err(res, 400, 'Нужно название навыка');
  if (!category || !String(category).trim()) return err(res, 400, 'Нужна категория');
  if (!lv) return err(res, 400, 'Нужны описания уровней 1–4');
  await withLock(async () => {
    const data = await readData();
    const name = String(skill).trim();
    if (data.skillRegistry.some((x) => x.skill.trim().toLowerCase() === name.toLowerCase())) return err(res, 409, 'Навык с таким названием уже есть');
    if (!data.categories.some((c) => c.name === String(category).trim())) return err(res, 400, 'Категория не найдена');
    const item = { id: nextId(data.skillRegistry), skill: name, category: String(category).trim(), levels: lv };
    data.skillRegistry.push(item);
    await writeData(data);
    res.json(item);
  });
});

app.put('/api/skills/:id', auth.authRequired, auth.restrict('admin', 'lead'), async (req, res) => {
  const lv = validLevels(req.body ? req.body.levels : null);
  await withLock(async () => {
    const data = await readData();
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
    await writeData(data);
    res.json(item);
  });
});

app.delete('/api/skills/:id', auth.authRequired, auth.restrict('admin', 'lead'), async (req, res) => {
  const id = Number(req.params.id);
  await withLock(async () => {
    const data = await readData();
    const idx = data.skillRegistry.findIndex((x) => x.id === id);
    if (idx === -1) return err(res, 404, 'Навык не найден в реестре');
    data.skillRegistry.splice(idx, 1);
    (data.users || []).forEach((u) => {
      u.skills = (u.skills || []).filter((sk) => !(sk && sk.skillId === id));
    });
    await writeData(data);
    res.json({ ok: true });
  });
});

app.get('/api/categories', auth.authRequired, async (req, res) => {
  res.json((await readData()).categories);
});

app.post('/api/categories', auth.authRequired, auth.restrict('admin', 'lead'), async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return err(res, 400, 'Нужно название категории');
  await withLock(async () => {
    const data = await readData();
    if (data.categories.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())) return err(res, 409, 'Категория уже существует');
    const cat = { id: nextId(data.categories), name };
    data.categories.push(cat);
    await writeData(data);
    res.json(cat);
  });
});

/* ---------------- employee assessments ---------------- */

app.get('/api/assessments', auth.authRequired, async (req, res) => {
  const roleData = await store.readForRole(req.account.role, req.account.id);
  res.json({ assessments: roleData.assessments || [] });
});

app.post('/api/assessments/import', async (req, res) => {
  const body = req.body || {};

  // Аутентификация импорта: внутренний токен (MySkills) ИЛИ сессия админа/лида.
  const { parseCookies, COOKIE_NAME } = require('./auth');
  const svcToken = req.get('x-portal-token');
  let role = null;
  let ownerBySession = null;
  if (svcToken && process.env.PORTAL_IMPORT_TOKEN && svcToken === process.env.PORTAL_IMPORT_TOKEN) {
    role = 'service';
  } else {
    const sessToken = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    if (sessToken) {
      const sess = await store.findSession(sessToken);
      if (sess && (sess.account.role === 'admin' || sess.account.role === 'lead')) {
        role = sess.account.role;
        ownerBySession = sess.account.id;
      }
    }
  }
  if (!role) return err(res, 403, 'Доступно только через MySkills (внутренний токен) или администратору/лиду');

  const employee = body.employee || {};
  const name = String(employee.name || '').trim();
  const grade = String(employee.grade || '').trim();
  const assessmentDate = String(employee.assessmentDate || '').trim();
  const skills = Array.isArray(body.skills) ? body.skills : [];

  if (!name) return err(res, 400, 'Укажите ФИО сотрудника');
  if (!GRADES.includes(grade)) return err(res, 400, 'Некорректный грейд');
  if (!assessmentDate) return err(res, 400, 'Укажите дату оценки');
  if (skills.length === 0) return err(res, 400, 'Файл не содержит навыков');

  // Владелец оценки (пространство Лида). Приоритет: leadAccountId из тела -> сессия лида.
  let ownerId = Number(body.leadAccountId != null ? body.leadAccountId : ownerBySession) || null;
  // Альтернатива: Лид задан вручную (ФИО/email) — резолвим к аккаунту-лиду портала.
  if (!ownerId && body.leadName) {
    const q = String(body.leadName).trim().toLowerCase();
    if (q) {
      const accounts = (await store.listAccounts()) || [];
      const lead = accounts.find((a) => a.role === 'lead' && a.isActive && (
        (a.fullName || '').trim().toLowerCase().includes(q) ||
        (a.email || '').trim().toLowerCase().includes(q) ||
        q.includes((a.fullName || '').trim().toLowerCase()) ||
        q.includes((a.email || '').trim().toLowerCase())
      ));
      if (lead) ownerId = lead.id;
    }
  }

  await withLock(async () => {
    const data = await readData();
    const unknown = [];
    const mapped = [];
    for (const s of skills) {
      const sname = String((s && s.skill) || '').trim();
      const r = sname
        ? data.skillRegistry.find((x) => x.skill.trim().toLowerCase() === sname.toLowerCase())
        : null;
      if (!sname) { if (!unknown.includes('(без названия)')) unknown.push('(без названия)'); continue; }
      if (!r) { unknown.push(sname); continue; }
      const lvl = Number(s.level);
      mapped.push({
        skillId: r.id,
        skill: r.skill,
        selfLevel: Number.isFinite(lvl) && lvl >= 1 && lvl <= 4 ? Math.trunc(lvl) : 1,
        selfComment: String((s && s.comment) == null ? '' : s.comment),
        leadLevel: null,
        leadComment: '',
      });
    }
    if (unknown.length) return err(res, 400, 'Не удалось распознать навыки: ' + Array.from(new Set(unknown)).join(', '));

    const key = (n) => String(n).trim().replace(/\s+/g, ' ').toLowerCase();
    let user = data.users.find((u) => key(u.name) === key(name));
    let userId = user ? user.id : null;
    if (!user) {
      user = { id: nextId(data.users), name, grade, email: '', isOutstaff: false, ownerId, skills: [], assignments: [] };
      data.users.push(user);
      userId = user.id;
    } else if (ownerId != null && !user.ownerId) {
      user.ownerId = ownerId;
    }

    const assessment = { id: nextId(data.assessments), userId, name, grade, assessmentDate, ownerId, skills: mapped };
    data.assessments.push(assessment);
    await writeData(data);
    res.status(201).json(assessment);
  });
});

app.put('/api/assessments/:id/skills/:idx', auth.authRequired, auth.restrict('lead', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  await withLock(async () => {
    const data = await readData();
    const a = (data.assessments || []).find((x) => x.id === id);
    if (!a) return err(res, 404, 'Оценка не найдена');
    if (req.account.role !== 'admin' && a.ownerId !== req.account.id) return err(res, 403, 'Это чужое пространство');
    if (!a.skills[idx]) return err(res, 404, 'Навык не найден');
    const b = req.body || {};
    if ('leadLevel' in b) {
      const lv = b.leadLevel === null || b.leadLevel === '' ? null : Number(b.leadLevel);
      if (lv !== null && !(Number.isInteger(lv) && lv >= 1 && lv <= 4)) return err(res, 400, 'Уровень лида должен быть целым от 1 до 4');
      a.skills[idx].leadLevel = lv;
    }
    if ('leadComment' in b) a.skills[idx].leadComment = String(b.leadComment == null ? '' : b.leadComment);
    await writeData(data);
    res.json(a.skills[idx]);
  });
});

app.delete('/api/assessments/:id', auth.authRequired, auth.restrict('lead', 'admin'), async (req, res) => {
  const id = Number(req.params.id);
  await withLock(async () => {
    const data = await readData();
    const idx = (data.assessments || []).findIndex((x) => x.id === id);
    if (idx === -1) return err(res, 404, 'Оценка не найдена');
    if (req.account.role !== 'admin' && data.assessments[idx].ownerId !== req.account.id) return err(res, 403, 'Это чужое пространство');
    data.assessments.splice(idx, 1);
    await writeData(data);
    res.json({ ok: true });
  });
});

/* ---------------- Jira integration (proxy личным токеном) ---------------- */

app.get('/api/jira/capacities', auth.authRequired, async (req, res) => {
  const roleData = await store.readForRole(req.account.role, req.account.id);
  res.json({ capacities: roleData.capacities || [] });
});

// Ёмкость устанавливают только Лид/Админ; ПМ — только чтение.
app.put('/api/jira/capacities', auth.authRequired, auth.restrict('lead', 'admin'), async (req, res) => {
  const b = req.body || {};
  const projectKey = String(b.projectKey || '').trim();
  const assignee = String(b.assignee || '').trim();
  if (!projectKey || !assignee) return err(res, 400, 'Нужны projectKey и assignee');
  const capacity = Number(b.capacity);
  if (!Number.isFinite(capacity) || capacity < 0) return err(res, 400, 'Ёмкость должна быть неотрицательным числом');
  await withLock(async () => {
    const data = await readData();
    const rec = (data.capacities || []).find((c) => c.assignee === assignee && c.projectKey === projectKey);
    if (rec) {
      rec.capacity = capacity;
      if (!rec.ownerId && req.account.role === 'lead') rec.ownerId = req.account.id;
    } else {
      data.capacities.push({ id: nextId(data.capacities), assignee, projectKey, capacity, ownerId: req.account.role === 'lead' ? req.account.id : null });
    }
    await writeData(data);
    res.json({ ok: true, capacities: data.capacities });
  });
});

app.get('/api/jira/health', async (req, res) => {
  // Здоровье учитывает личный токен сессии: если пользователь вошёл по личному
  // токену (или OAuth) и у сессии есть jiraAccessToken — Jira считается доступной,
  // даже когда в .jira-config.json нет серверного token.
  // Плюс диагностика: источник конфига, причина (если не настроено) и результат
  // реального пробника /myself (auth/network/tls/dns/http) при доступности.
  const { parseCookies, COOKIE_NAME } = require('./auth');
  const base = jira.getConfig();
  let sessionToken = null;
  try {
    const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    if (token) {
      const session = await store.findSession(token);
      if (session) sessionToken = session.jiraAccessToken || null;
    }
  } catch (e) { /* ignore */ }
  const configured = base.configured || Boolean(base.url && sessionToken);
  let probe = null;
  if (configured) {
    try {
      probe = await jira.probe(sessionToken || null);
    } catch (e) { /* ignore */ }
  }
  res.json({
    ...base,
    configured,
    probe,
  });
});

function jiraToken(req) {
  return (req.session && req.session.jiraAccessToken) || null;
}

app.get('/api/jira/projects', auth.authRequired, auth.restrict('lead', 'pm', 'admin'), async (req, res) => {
  try {
    res.json(await jira.projects(jiraToken(req)));
  } catch (e) {
    err(res, e.status || 502, e.message);
  }
});

app.post('/api/jira/search', auth.authRequired, auth.restrict('lead', 'pm', 'admin'), async (req, res) => {
  try {
    res.json(await jira.search(req.body || {}, jiraToken(req)));
  } catch (e) {
    err(res, e.status || 502, e.message);
  }
});

app.get('/api/jira/users', auth.authRequired, auth.restrict('lead', 'pm', 'admin'), async (req, res) => {
  try {
    res.json(await jira.users(req.query.q, jiraToken(req)));
  } catch (e) {
    err(res, e.status || 502, e.message);
  }
});

app.post('/api/jira/assignables', auth.authRequired, auth.restrict('lead', 'pm', 'admin'), async (req, res) => {
  try {
    res.json(await jira.assignables(((req.body || {}).projectKeys) || [], jiraToken(req)));
  } catch (e) {
    err(res, e.status || 502, e.message);
  }
});

app.post('/api/jira/active-sprints', auth.authRequired, auth.restrict('lead', 'pm', 'admin'), async (req, res) => {
  try {
    res.json(await jira.activeSprints(((req.body || {}).projectKeys) || [], jiraToken(req)));
  } catch (e) {
    err(res, e.status || 502, e.message);
  }
});

app.get('/api/jira/issue/:key', auth.authRequired, auth.restrict('lead', 'pm', 'admin'), async (req, res) => {
  try {
    res.json(await jira.issue(req.params.key, jiraToken(req)));
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
  // Инициализация хранилища (PostgreSQL при доступности, иначе fallback на data.json).
  store = await createStore();
  store.__isDb = store.constructor.name === 'PgStore';
  await initData();
  await bootstrapAccounts(store);

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
  console.log(`Gnivc Resource Portal listening on ${url}`);
  console.log(`Storage: ${store.__isDb ? 'PostgreSQL' : 'data.json'}`);
  openBrowser(url);
})();