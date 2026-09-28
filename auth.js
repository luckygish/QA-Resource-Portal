'use strict';

// Аутентификация и роли:
//   - OAuth 2.0 / 3LO вход через Jira Data Center (Authorization Code Grant)
//   - сессия = httpOnly cookie + запись в хранилище (sessions)
//   - middleware authRequired / restrict / владельческий скоуп
//   - админ-панель: список аккаунтов, смена ролей
//   - bootstrap первого админа по env ADMIN_JIRA_EMAIL, если админов ещё нет

const crypto = require('crypto');
const jira = require('./jira');
const { ROLES } = require('./repo/scope');

const COOKIE_NAME = 'portal_session';

// Несоль-хэширование пароля локальных тест-УЗ (scrypt). Только для демо-входа,
// прод-пользователи аутентифицируются через Jira (Basic/OAuth).
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = parts[1];
  const expected = parts[2];
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i === -1) return;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function adminEmail() {
  const v = process.env.ADMIN_JIRA_EMAIL;
  return v ? String(v).trim().toLowerCase() : null;
}

class Auth {
  constructor(getStore) {
    this.getStore = getStore;
    this.states = new Map(); // state -> {at, redirect}
  }

  store() {
    const s = this.getStore();
    if (!s) { const e = new Error('Хранилище не инициализировано'); e.status = 500; throw e; }
    return s;
  }

  clearExpiredStates() {
    const now = Date.now();
    for (const [k, v] of this.states) if (now - v.at > STATE_TTL_MS) this.states.delete(k);
  }

  /* ---------- middleware ---------- */

  authRequired = async (req, res, next) => {
    const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
    try {
      const session = await this.store().findSession(token);
      if (!session) return res.status(401).json({ error: 'Сессия недействительна или истекла' });
      req.session = session;
      req.account = session.account;
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };

  restrict = (...roles) => (req, res, next) => {
    if (!req.account) return res.status(401).json({ error: 'Требуется авторизация' });
    if (!roles.includes(req.account.role)) return res.status(403).json({ error: 'Недостаточно прав' });
    next();
  };

  /* ---------- OAuth ---------- */

  async login(req, res) {
    const cfg = jira.getOAuthConfig();
    if (!cfg.configured) {
      return res.status(503).json({ error: 'OAuth для Jira не настроен на сервере' });
    }
    this.clearExpiredStates();
    const state = newToken();
    let redirect = '/';
    if (req.query && req.query.redirect) redirect = String(req.query.redirect);
    this.states.set(state, { at: Date.now(), redirect });
    const url = jira.getAuthUrl(state, cfg.redirectUri);
    if (!url) return res.status(503).json({ error: 'OAuth для Jira не настроен на сервере' });
    res.redirect(url);
  }

  // Находит или создаёт аккаунт по данным из Jira + бутстрап первого админа.
  async resolveAccount(me) {
    const email = (me.email || '').trim().toLowerCase();
    const idKey = String(me.accountId || me.name || ('_' + (email || Math.random()))).slice(0, 255);
    const store = this.store();
    let account = email ? await store.findAccountByEmail(email) : null;
    if (!account) account = await store.findAccountByJiraKey(idKey);
    if (!account) {
      account = await store.createAccount({
        email: email || ('uid:' + idKey),
        fullName: me.displayName || me.name || email || idKey,
        role: 'employee',
        jiraAccountKey: idKey,
      });
    }
    const adm = adminEmail();
    if (account.role !== 'admin' && adm && adm === email && (await store.countAdmins()) === 0) {
      account = await store.setAccountRole(account.id, 'admin');
    }
    return account;
  }

  async issueSession(res, account, jiraTokens, req) {
    const token = newToken();
    const ip = (req && req.ip) || '';
    const userAgent = (req && req.headers && req.headers['user-agent']) || '';
    await this.store().createSession({
      token,
      accountId: account.id,
      jiraAccessToken: (jiraTokens && jiraTokens.accessToken) || null,
      jiraRefreshToken: (jiraTokens && jiraTokens.refreshToken) || null,
      ip,
      userAgent,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
    });
    return token;
  }

  async callback(req, res) {
    const { code, state } = req.query || {};
    this.clearExpiredStates();
    const st = this.states.get(state);
    this.states.delete(state);
    if (!st) return res.status(400).send('Недопустимый OAuth state.');
    if (!code) return res.status(400).send('Отсутствует authorization code.');

    try {
      const cfg = jira.getOAuthConfig();
      const tokens = await jira.exchangeCode(code, cfg.redirectUri);
      if (!tokens.accessToken) throw new Error('Jira не вернула access_token.');
      const me = await jira.myself(tokens.accessToken);
      if (!me.email && !me.name) throw new Error('Не удалось получить данные пользователя из Jira.');
      const account = await this.resolveAccount(me);
      await this.issueSession(res, account, tokens, req);
      res.redirect(st.redirect || '/');
    } catch (e) {
      res.status(500).send('Ошибка входа через Jira: ' + e.message);
    }
  }

  // Вход по логину/паролю или по личному Jira-токену (PAT).
  //   - token: валидация через /myself (Bearer), сохраняем как личный для вкладки Jira;
  //   - иначе локальная тест-УЗ (по хэшу пароля, без Jira);
  //   - иначе Jira Basic.
  // Пароль нигде не сохраняется; токен хранится только в httpOnly-сессии.
  async loginPassword(req, res) {
    const { username, password, token } = req.body || {};
    if (token) {
      // Вход по личному PAT.
      const t = String(token).trim();
      if (!t) return res.status(400).json({ error: 'Укажите Jira-токен' });
      if (!username) return res.status(400).json({ error: 'Укажите логин вместе с токеном' });
      try {
        const me = await jira.loginToken(t);
        const account = await this.resolveAccount(me);
        await this.issueSession(res, account, { accessToken: t }, req);
        return res.json({ ok: true, account });
      } catch (e) {
        return res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 500).json({ error: e.message });
      }
    }
    if (!username || !password) return res.status(400).json({ error: 'Укажите логин и пароль' });
    try {
      // Локальная тест-УЗ: парольный вход доступен ТОЛЬКО аккаунтам, у которых
      // в БД прописан локальный пароль (тестовые testLead/testPM и т.п.).
      // Корпоративные УЗ входят по личному токену (token) или OAuth.
      const store = this.store();
      const local = await store.findAccountForLogin(username);
      if (!local || !local.isActive) {
        return res.status(401).json({ error: 'Локальная УЗ не найдена или отключена. Корпоративные УЗ входят по личному Jira-токену.' });
      }
      const storedHash = await store.getAccountPasswordHash(local.id);
      if (!storedHash) {
        return res.status(401).json({ error: 'У этой УЗ нет локального пароля. Войдите по личному Jira-токену.' });
      }
      if (!verifyPassword(password, storedHash)) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
      }
      await this.issueSession(res, local, null, req);
      return res.json({ ok: true, account: local });
    } catch (e) {
      res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 500).json({ error: e.message });
    }
  }

  async me(req, res) {
    const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    if (token) {
      try {
        const session = await this.store().findSession(token);
        if (session && session.account) {
          const leadId = await this.store().getLeadLink(session.account.id);
          return res.json({ authed: true, account: session.account, leadId });
        }
      } catch (e) { /* fallthrough -> not authed */ }
    }
    res.json({ authed: false });
  }

  async logout(req, res) {
    const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    if (token) {
      try { await this.store().deleteSession(token); } catch (e) { /* ignore */ }
    }
    res.clearCookie(COOKIE_NAME);
    res.json({ ok: true });
  }

  /* ---------- admin ---------- */

  async listAccounts(req, res) {
    try { res.json({ accounts: await this.store().listAccounts() }); } catch (e) { res.status(500).json({ error: e.message }); }
  }

  async setRole(req, res) {
    const id = Number(req.params.id);
    const role = String((req.body || {}).role || '').trim();
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Недопустимая роль' });
    try {
      const existing = await this.store().getAccountById(id);
      if (!existing) return res.status(404).json({ error: 'Аккаунт не найден' });
      // Нельзя лишить систему последнего администратора.
      if (existing.role === 'admin' && role !== 'admin' && (await this.store().countAdmins()) <= 1) {
        return res.status(409).json({ error: 'Нельзя снять роль администратора с последнего активного админа' });
      }
      const updated = await this.store().setAccountRole(id, role);
      res.json({ account: updated });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }

  /* ---------- личное пространство сотрудника ---------- */

  async listLeads(req, res) {
    const q = String((req.query && req.query.q) || '').trim().toLowerCase();
    try {
      const accounts = await this.store().listAccounts();
      const leads = accounts.filter((a) => a.role === 'lead' && a.isActive);
      const filtered = q ? leads.filter((a) => (a.fullName || '').toLowerCase().includes(q) || (a.email || '').toLowerCase().includes(q)) : leads;
      res.json({ leads: filtered.map((l) => ({ id: l.id, fullName: l.fullName, email: l.email })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }

  async setMyLead(req, res) {
    const leadId = Number((req.body || {}).leadId);
    const store = this.store();
    try {
      const lead = await store.getAccountById(leadId);
      if (!lead || lead.role !== 'lead') return res.status(400).json({ error: 'Выбранный аккаунт не является Лидом' });
      await store.setLeadLink(req.account.id, leadId);
      res.json({ ok: true, leadId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
}

module.exports = { Auth, COOKIE_NAME, parseCookies, hashPassword, verifyPassword };