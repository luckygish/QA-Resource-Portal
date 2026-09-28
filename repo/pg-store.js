'use strict';

// Реализация хранилища на PostgreSQL — полная нормализация таблиц.
//
// Интерфейс (документно-ориентированный, сохраняет контракт /api/data):
//   store.read()   -> собирает цельный документ из нормализованных таблиц через JOIN
//   store.write(doc) -> в одной транзакции пересинхронизирует все таблицы из документа
//   store.seed(doc)  -> переносит data.json в пустую БД (импорт при старте)
//   store.isUsable() -> работоспособно ли соединение (для fallback)
//
// Все записи выполняются в транзакции вместо глобальной очереди мутаций json-store.

const { Pool } = require('pg');
const db = require('./db');
const migrations = require('./migrations');
const { filterDocByRole } = require('./scope');

function boolToAttr(rows, attr) {
  rows.forEach((r) => { if (r[attr] === true || r[attr] === false) r[attr] = Boolean(r[attr]); });
  return rows;
}

class PgStore {
  constructor() {
    this._pool = null;
    this._readOnlyDocs = null;
  }

  async connect() {
    const cfg = db.getConfig();
    this._pool = new Pool(cfg.url ? { connectionString: cfg.url, ssl: cfg.ssl } : cfg);
    await migrations.runMigrations(this._pool);
    return this;
  }

  async ping() {
    try { await this._pool.query('SELECT 1'); return true; } catch (e) { return false; }
  }

  async isUsable() { return this.ping(); }

  async close() { if (this._pool) await this._pool.end(); }

  // ---- чтение: сборка полного документа из нормализованных таблиц ----

  async read() {
    const p = this._pool;
    const [cats, skills, mgrs, projs, usr, usk, ass, reqs, assess, ask, caps] = await Promise.all([
      p.query('SELECT id, name FROM categories ORDER BY id'),
      p.query('SELECT s.id, s.skill, c.name AS category_id, s.levels FROM skill_registry s JOIN categories c ON c.id = s.category_id ORDER BY s.id'),
      p.query('SELECT id, name, email FROM managers ORDER BY id'),
      p.query('SELECT id, name, abbreviation, is_government_contract, contract_number, manager_id, jira_key FROM projects ORDER BY id'),
      p.query('SELECT id, name, grade, email, age, about, is_outstaff, owner_id FROM users ORDER BY id'),
      p.query('SELECT user_id, skill_id, level FROM user_skills ORDER BY user_id, skill_id'),
      p.query('SELECT id, user_id, project_id, start_date::text AS start, end_date::text AS "end", percent FROM assignments ORDER BY id'),
      p.query('SELECT id, project_id, grade, start_date::text AS start, end_date::text AS "end", percent, status, comment, manager_id, assigned_user_id, created_by FROM requests ORDER BY id'),
      p.query('SELECT id, user_id, name, grade, assessment_date::text AS assessment_date, owner_id FROM assessments ORDER BY id'),
      p.query('SELECT assessment_id, skill_id, self_level, self_comment, lead_level, lead_comment FROM assessment_skills ORDER BY assessment_id, skill_id'),
      p.query('SELECT id, project_key, assignee, capacity, owner_id FROM capacities ORDER BY id'),
    ]);

    const categories = cats.rows;
    const skillRegistry = skills.rows.map((r) => ({
      id: r.id,
      skill: r.skill,
      category: r.category_id,
      levels: r.levels || {},
    }));
    const managers = mgrs.rows;
    const projects = boolToAttr(projs.rows, 'is_government_contract').map((r) => ({
      id: r.id,
      name: r.name,
      abbreviation: r.abbreviation,
      isGovernmentContract: r.is_government_contract,
      contractNumber: r.contract_number,
      managerId: r.manager_id !== null ? r.manager_id : null,
      jiraKey: r.jira_key !== null ? r.jira_key : null,
    }));

    const uskMap = new Map();
    usk.rows.forEach((r) => {
      if (!uskMap.has(r.user_id)) uskMap.set(r.user_id, []);
      uskMap.get(r.user_id).push({ skillId: r.skill_id, level: r.level });
    });
    const assMap = new Map();
    ass.rows.forEach((r) => {
      if (!assMap.has(r.user_id)) assMap.set(r.user_id, []);
      assMap.get(r.user_id).push({ id: r.id, projectId: r.project_id, start: r.start, end: r.end, percent: r.percent });
    });

    const users = boolToAttr(usr.rows, 'is_outstaff').map((r) => ({
      id: r.id,
      name: r.name,
      grade: r.grade,
      email: r.email,
      age: r.age !== null ? r.age : null,
      about: r.about,
      isOutstaff: r.is_outstaff,
      ownerId: r.owner_id !== null ? r.owner_id : null,
      skills: uskMap.get(r.id) || [],
      assignments: assMap.get(r.id) || [],
    }));

    const requests = reqs.rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      grade: r.grade,
      start: r.start,
      end: r.end,
      percent: r.percent,
      status: r.status,
      comment: r.comment,
      managerId: r.manager_id !== null ? r.manager_id : null,
      assignedUserId: r.assigned_user_id !== null ? r.assigned_user_id : null,
      createdBy: r.created_by !== null ? r.created_by : null,
    }));

    const askMap = new Map();
    ask.rows.forEach((r) => {
      if (!askMap.has(r.assessment_id)) askMap.set(r.assessment_id, []);
      askMap.get(r.assessment_id).push({
        skillId: r.skill_id,
        selfLevel: r.self_level,
        selfComment: r.self_comment,
        leadLevel: r.lead_level !== null ? r.lead_level : null,
        leadComment: r.lead_comment,
      });
    });
    const nameBySkillId = new Map(skillRegistry.map((s) => [s.id, s.skill]));
    const assessments = assess.rows.map((r) => ({
      id: r.id,
      userId: r.user_id !== null ? r.user_id : null,
      name: r.name,
      grade: r.grade,
      assessmentDate: r.assessment_date,
      ownerId: r.owner_id !== null ? r.owner_id : null,
      skills: (askMap.get(r.id) || []).map((sk) => ({ ...sk, skill: nameBySkillId.get(sk.skillId) || '' })),
    }));

    const capacities = caps.rows.map((r) => ({
      id: r.id,
      projectKey: r.project_key,
      assignee: r.assignee,
      capacity: Number(r.capacity) || 0,
      ownerId: r.owner_id !== null ? r.owner_id : null,
    }));

    return {
      users,
      projects,
      requests,
      managers,
      skillRegistry,
      categories,
      assessments,
      capacities,
    };
  }

  // ---- запись: полная пересинхронизация в одной транзакции ----

  async write(doc) {
    const client = await this._pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('TRUNCATE assessment_skills, assessments, requests, assignments, user_skills, users, projects, managers, skill_registry, categories, capacities RESTART IDENTITY CASCADE');

      const catIds = new Set();
      for (const c of doc.categories || []) {
        await client.query('INSERT INTO categories (id, name) VALUES ($1,$2)', [c.id, c.name]);
        catIds.add(String(c.id));
      }
      for (const s of doc.skillRegistry || []) {
        const cat = doc.categories.find((c) => c.name === s.category);
        const catId = cat ? cat.id : (Number(s.categoryId) || null);
        await client.query('INSERT INTO skill_registry (id, skill, category_id, levels) VALUES ($1,$2,$3,$4)', [s.id, s.skill, catId, JSON.stringify(s.levels || {})]);
      }
      for (const m of doc.managers || []) {
        await client.query('INSERT INTO managers (id, name, email) VALUES ($1,$2,$3)', [m.id, m.name, m.email || '']);
      }
      for (const p of doc.projects || []) {
        await client.query('INSERT INTO projects (id, name, abbreviation, is_government_contract, contract_number, manager_id, jira_key) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [p.id, p.name, p.abbreviation || '', p.isGovernmentContract !== false, p.contractNumber != null ? p.contractNumber : null, p.managerId != null ? p.managerId : null, p.jiraKey || null]);
      }
      for (const u of doc.users || []) {
        await client.query('INSERT INTO users (id, name, grade, email, age, about, is_outstaff, owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [u.id, u.name, u.grade, u.email || '', u.age != null ? u.age : null, u.about || '', !!u.isOutstaff, u.ownerId != null ? u.ownerId : null]);
        for (const sk of u.skills || []) {
          await client.query('INSERT INTO user_skills (user_id, skill_id, level) VALUES ($1,$2,$3)', [u.id, sk.skillId, sk.level]);
        }
        for (const a of u.assignments || []) {
          await client.query('INSERT INTO assignments (id, user_id, project_id, start_date, end_date, percent) VALUES ($1,$2,$3,$4,$5,$6)',
            [a.id, u.id, a.projectId, a.start, a.end, a.percent]);
        }
      }
      for (const r of doc.requests || []) {
        await client.query('INSERT INTO requests (id, project_id, grade, start_date, end_date, percent, status, comment, manager_id, assigned_user_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [r.id, r.projectId, r.grade, r.start, r.end, r.percent, r.status || 'Новая', r.comment || '', r.managerId != null ? r.managerId : null, r.assignedUserId != null ? r.assignedUserId : null, r.createdBy != null ? r.createdBy : null]);
      }
      for (const a of doc.assessments || []) {
        await client.query('INSERT INTO assessments (id, user_id, name, grade, assessment_date, owner_id) VALUES ($1,$2,$3,$4,$5,$6)',
          [a.id, a.userId != null ? a.userId : null, a.name, a.grade, a.assessmentDate, a.ownerId != null ? a.ownerId : null]);
        for (const sk of a.skills || []) {
          await client.query('INSERT INTO assessment_skills (assessment_id, skill_id, self_level, self_comment, lead_level, lead_comment) VALUES ($1,$2,$3,$4,$5,$6)',
            [a.id, sk.skillId, sk.selfLevel != null ? sk.selfLevel : 0, sk.selfComment || '', sk.leadLevel != null ? sk.leadLevel : null, sk.leadComment || '']);
        }
      }
      for (const c of doc.capacities || []) {
        await client.query('INSERT INTO capacities (id, project_key, assignee, capacity, owner_id) VALUES ($1,$2,$3,$4,$5)', [c.id, c.projectKey, c.assignee, c.capacity || 0, c.ownerId != null ? c.ownerId : null]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async seed(doc) {
    await this.write(doc);
  }

  // Ролевое чтение: собирает полный документ и фильтрует по роли на сервере.
  async readForRole(role, accountId) {
    const doc = await this.read();
    return filterDocByRole(doc, role, accountId);
  }

  async countBusinessRows() {
    const r = await this._pool.query('SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM projects) + (SELECT count(*) FROM skill_registry) AS c');
    return Number(r.rows[0].c);
  }

  // ---- accounts / sessions / lead links ----

  mapAccount(r) {
    return {
      id: r.id,
      email: r.email,
      fullName: r.full_name,
      role: r.role,
      isActive: Boolean(r.is_active),
      jiraAccountKey: r.jira_account_key || null,
      createdAt: r.created_at,
    };
  }

  async getAccountById(id) {
    const { rows } = await this._pool.query('SELECT * FROM accounts WHERE id = $1', [id]);
    return rows[0] ? this.mapAccount(rows[0]) : null;
  }

  async findAccountByEmail(email) {
    const { rows } = await this._pool.query('SELECT * FROM accounts WHERE lower(email) = lower($1)', [email]);
    return rows[0] ? this.mapAccount(rows[0]) : null;
  }

  async findAccountByJiraKey(key) {
    const { rows } = await this._pool.query('SELECT * FROM accounts WHERE jira_account_key = $1', [key]);
    return rows[0] ? this.mapAccount(rows[0]) : null;
  }

  async createAccount({ email, fullName, role, jiraAccountKey }) {
    const { rows } = await this._pool.query(
      'INSERT INTO accounts (email, full_name, role, jira_account_key) VALUES ($1,$2,$3,$4) RETURNING *',
      [email, fullName || '', role || 'employee', jiraAccountKey || null]
    );
    return this.mapAccount(rows[0]);
  }

  async setAccountRole(id, role) {
    await this._pool.query('UPDATE accounts SET role = $1 WHERE id = $2', [role, id]);
    return this.getAccountById(id);
  }

  async findAccountForLogin(login) {
    const { rows } = await this._pool.query(
      `SELECT * FROM accounts WHERE lower(email) = lower($1) OR lower(coalesce(jira_account_key,'')) = lower($1) LIMIT 1`,
      [login]
    );
    return rows[0] ? this.mapAccount(rows[0]) : null;
  }

  async getAccountPasswordHash(id) {
    const { rows } = await this._pool.query('SELECT password_hash FROM accounts WHERE id = $1', [id]);
    return rows[0] ? (rows[0].password_hash || null) : null;
  }

  async setAccountPassword(id, passwordHash) {
    await this._pool.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [passwordHash || null, id]);
    return this.getAccountById(id);
  }

  async listAccounts() {
    const { rows } = await this._pool.query('SELECT * FROM accounts ORDER BY id');
    return rows.map((r) => this.mapAccount(r));
  }

  async countAdmins() {
    const { rows } = await this._pool.query('SELECT count(*) AS c FROM accounts WHERE role = $1 AND is_active = true', ['admin']);
    return Number(rows[0].c);
  }

  async createSession({ token, accountId, jiraAccessToken, jiraRefreshToken, ip, userAgent, expiresAt }) {
    await this._pool.query(
      'INSERT INTO sessions (token, account_id, jira_access_token, jira_refresh_token, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [token, accountId, jiraAccessToken || null, jiraRefreshToken || null, ip || '', userAgent || '', expiresAt]
    );
  }

  async findSession(token) {
    const { rows } = await this._pool.query('SELECT * FROM sessions WHERE token = $1', [token]);
    if (!rows[0]) return null;
    const s = rows[0];
    if (new Date(s.expires_at).getTime() <= Date.now()) {
      await this.deleteSession(token);
      return null;
    }
    const account = await this.getAccountById(s.account_id);
    if (!account || !account.isActive) return null;
    return {
      token: s.token,
      accountId: s.account_id,
      account,
      jiraAccessToken: s.jira_access_token || null,
      jiraRefreshToken: s.jira_refresh_token || null,
      expiresAt: s.expires_at,
    };
  }

  async updateSessionJiraToken(token, jiraAccessToken, jiraRefreshToken) {
    await this._pool.query(
      'UPDATE sessions SET jira_access_token = $1, jira_refresh_token = $2 WHERE token = $3',
      [jiraAccessToken || null, jiraRefreshToken || null, token]
    );
  }

  async deleteSession(token) {
    await this._pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  }

  async deleteExpiredSessions() {
    await this._pool.query('DELETE FROM sessions WHERE expires_at <= now()');
  }

  async getLeadLink(accountId) {
    const { rows } = await this._pool.query('SELECT lead_account_id FROM lead_links WHERE account_id = $1', [accountId]);
    return rows[0] ? rows[0].lead_account_id : null;
  }

  async setLeadLink(accountId, leadAccountId) {
    const { rows } = await this._pool.query(
      `INSERT INTO lead_links (account_id, lead_account_id, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (account_id) DO UPDATE SET lead_account_id = EXCLUDED.lead_account_id, updated_at = now()
       RETURNING lead_account_id`,
      [accountId, leadAccountId]
    );
    return rows[0] ? rows[0].lead_account_id : leadAccountId;
  }
}

module.exports = { PgStore, db, migrations };