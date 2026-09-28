'use strict';

// Реализация хранилища на data.json (Fallback, когда БД недоступна).
// Сохраняет прежнее поведение: синхронное чтение/запись файла, глобальная
// очередь мутаций, автоинкремент nextId по документу.

const fs = require('fs');
const path = require('path');
const { filterDocByRole } = require('./scope');

// data.json всегда лежит в корне проекта / рядом с exe, а не в подпапке repo.
const APP_DIR = typeof process !== 'undefined' && process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const DATA_FILE = path.join(APP_DIR, 'data.json');

class JsonStore {
  constructor(file) {
    this.dataFile = file || DATA_FILE;
    // Serialize mutations (Node is single-threaded, but queue prevents interleaved async reads)
    this.queue = Promise.resolve();
  }

  withLock(fn) {
    const run = this.queue.then(() => fn());
    this.queue = run.catch(() => {});
    return run;
  }

  read() {
    const raw = fs.readFileSync(this.dataFile, 'utf8');
    return JSON.parse(raw);
  }

  write(data) {
    fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2));
  }

  exists() {
    return fs.existsSync(this.dataFile);
  }

  // Создаёт пустую baseline, если файла нет (первый запуск).
  ensureExists() {
    if (fs.existsSync(this.dataFile)) return;
    const data = { users: [], projects: [], requests: [], managers: [], skillRegistry: [], categories: [], assessments: [], capacities: [], accounts: [], sessions: [], leadLinks: [] };
    this.write(data);
  }

  _ensure(doc) {
    if (!Array.isArray(doc.accounts)) doc.accounts = [];
    if (!Array.isArray(doc.sessions)) doc.sessions = [];
    if (!Array.isArray(doc.leadLinks)) doc.leadLinks = [];
    return doc;
  }

  mapAccount(a) {
    return {
      id: a.id,
      email: a.email,
      fullName: a.fullName || '',
      role: a.role || 'employee',
      isActive: a.isActive !== false,
      jiraAccountKey: a.jiraAccountKey || null,
      createdAt: a.createdAt || null,
    };
  }

  async readForRole(role, accountId) {
    const doc = this._ensure(this.read());
    return filterDocByRole(doc, role, accountId);
  }

  // ---- accounts / sessions / lead links (json fallback) ----

  async getAccountById(id) {
    const doc = this._ensure(this.read());
    const a = doc.accounts.find((x) => x.id === id);
    return a ? this.mapAccount(a) : null;
  }

  async findAccountByEmail(email) {
    const doc = this._ensure(this.read());
    const a = doc.accounts.find((x) => String(x.email).toLowerCase() === String(email).toLowerCase());
    return a ? this.mapAccount(a) : null;
  }

  async findAccountByJiraKey(key) {
    const doc = this._ensure(this.read());
    const a = doc.accounts.find((x) => x.jiraAccountKey === key);
    return a ? this.mapAccount(a) : null;
  }

  async createAccount({ email, fullName, role, jiraAccountKey }) {
    const doc = this._ensure(this.read());
    const id = doc.accounts.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;
    const acc = { id, email, fullName: fullName || '', role: role || 'employee', isActive: true, jiraAccountKey: jiraAccountKey || null, createdAt: new Date().toISOString() };
    doc.accounts.push(acc);
    this.write(doc);
    return this.mapAccount(acc);
  }

  // Ищет аккаунт по логину: email ИЛИ jira-ключ (для локального входа тест-УЗ).
  async findAccountForLogin(login) {
    const doc = this._ensure(this.read());
    const key = String(login || '').trim().toLowerCase();
    if (!key) return null;
    const a = doc.accounts.find((x) =>
      String(x.email || '').toLowerCase() === key ||
      String(x.jiraAccountKey || '').toLowerCase() === key
    );
    return a ? this.mapAccount(a) : null;
  }

  async getAccountPasswordHash(id) {
    const doc = this._ensure(this.read());
    const a = doc.accounts.find((x) => x.id === id);
    return a ? (a.passwordHash || null) : null;
  }

  async setAccountPassword(id, passwordHash) {
    const doc = this._ensure(this.read());
    const a = doc.accounts.find((x) => x.id === id);
    if (!a) return null;
    a.passwordHash = passwordHash || null;
    this.write(doc);
    return this.mapAccount(a);
  }

  async setAccountRole(id, role) {
    const doc = this._ensure(this.read());
    const a = doc.accounts.find((x) => x.id === id);
    if (!a) return null;
    a.role = role;
    this.write(doc);
    return this.mapAccount(a);
  }

  async listAccounts() {
    const doc = this._ensure(this.read());
    return doc.accounts.map((a) => this.mapAccount(a));
  }

  async countAdmins() {
    const doc = this._ensure(this.read());
    return doc.accounts.filter((a) => a.role === 'admin' && a.isActive !== false).length;
  }

  async createSession({ token, accountId, jiraAccessToken, jiraRefreshToken, ip, userAgent, expiresAt }) {
    const doc = this._ensure(this.read());
    doc.sessions = doc.sessions.filter((s) => new Date(s.expiresAt).getTime() > Date.now());
    doc.sessions.push({
      token,
      accountId,
      jiraAccessToken: jiraAccessToken || null,
      jiraRefreshToken: jiraRefreshToken || null,
      createdAt: new Date().toISOString(),
      expiresAt,
      ip: ip || '',
      userAgent: userAgent || '',
    });
    this.write(doc);
  }

  async findSession(token) {
    const doc = this._ensure(this.read());
    const s = doc.sessions.find((x) => x.token === token);
    if (!s) return null;
    if (new Date(s.expiresAt).getTime() <= Date.now()) {
      doc.sessions = doc.sessions.filter((x) => x.token !== token);
      this.write(doc);
      return null;
    }
    const account = await this.getAccountById(s.accountId);
    if (!account || !account.isActive) return null;
    return {
      token: s.token,
      accountId: s.accountId,
      account,
      jiraAccessToken: s.jiraAccessToken || null,
      jiraRefreshToken: s.jiraRefreshToken || null,
      expiresAt: s.expiresAt,
    };
  }

  async updateSessionJiraToken(token, jiraAccessToken, jiraRefreshToken) {
    const doc = this._ensure(this.read());
    const s = doc.sessions.find((x) => x.token === token);
    if (s) {
      s.jiraAccessToken = jiraAccessToken || null;
      s.jiraRefreshToken = jiraRefreshToken || null;
      this.write(doc);
    }
  }

  async deleteSession(token) {
    const doc = this._ensure(this.read());
    doc.sessions = doc.sessions.filter((x) => x.token !== token);
    this.write(doc);
  }

  async deleteExpiredSessions() {
    const doc = this._ensure(this.read());
    doc.sessions = doc.sessions.filter((s) => new Date(s.expiresAt).getTime() > Date.now());
    this.write(doc);
  }

  async getLeadLink(accountId) {
    const doc = this._ensure(this.read());
    const l = doc.leadLinks.find((x) => x.accountId === accountId);
    return l ? l.leadAccountId : null;
  }

  async setLeadLink(accountId, leadAccountId) {
    const doc = this._ensure(this.read());
    let l = doc.leadLinks.find((x) => x.accountId === accountId);
    if (l) {
      l.leadAccountId = leadAccountId;
      l.updatedAt = new Date().toISOString();
    } else {
      const id = doc.leadLinks.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;
      doc.leadLinks.push({ id, accountId, leadAccountId, updatedAt: new Date().toISOString() });
    }
    this.write(doc);
    return leadAccountId;
  }

  async seed(doc) {
    this.write(doc);
  }

  async readDoc() {
    return this._ensure(this.read());
  }

  async isUsable() { return true; }
}

module.exports = { JsonStore };