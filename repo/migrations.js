'use strict';

// Автоприменяемые миграции схемы PostgreSQL.
// Версионирование: таблица schema_migrations; каждая миграция применяется в транзакции.
// Используем чистый `pg` (без нативных бинарников) — совместимо со сборкой в exe через pkg.

const MIGRATIONS = [
  {
    version: 1,
    name: 'create core tables',
    sql: `
    CREATE TABLE IF NOT EXISTS categories (
      id   integer PRIMARY KEY,
      name text NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS skill_registry (
      id          integer PRIMARY KEY,
      skill       text NOT NULL,
      category_id integer NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
      levels      jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS managers (
      id    integer PRIMARY KEY,
      name  text NOT NULL,
      email text NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS projects (
      id                    integer PRIMARY KEY,
      name                  text NOT NULL,
      abbreviation          text NOT NULL DEFAULT '',
      is_government_contract boolean NOT NULL DEFAULT true,
      contract_number       text,
      manager_id            integer REFERENCES managers(id) ON DELETE SET NULL,
      jira_key              text
    );

    CREATE TABLE IF NOT EXISTS users (
      id          integer PRIMARY KEY,
      name        text NOT NULL,
      grade       text NOT NULL,
      email       text NOT NULL DEFAULT '',
      age         integer,
      about       text NOT NULL DEFAULT '',
      is_outstaff boolean NOT NULL DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS user_skills (
      user_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      skill_id  integer NOT NULL REFERENCES skill_registry(id) ON DELETE CASCADE,
      level     smallint NOT NULL,
      PRIMARY KEY (user_id, skill_id)
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id         integer PRIMARY KEY,
      user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id integer NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      start_date date NOT NULL,
      end_date   date NOT NULL,
      percent    smallint NOT NULL
    );

    CREATE TABLE IF NOT EXISTS requests (
      id               integer PRIMARY KEY,
      project_id       integer NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      grade            text NOT NULL,
      start_date       date NOT NULL,
      end_date         date NOT NULL,
      percent          smallint NOT NULL,
      status           text NOT NULL DEFAULT 'Новая',
      comment          text NOT NULL,
      manager_id       integer REFERENCES managers(id) ON DELETE RESTRICT,
      assigned_user_id integer REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS assessments (
      id              integer PRIMARY KEY,
      user_id         integer REFERENCES users(id) ON DELETE SET NULL,
      name            text NOT NULL,
      grade           text NOT NULL,
      assessment_date date NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assessment_skills (
      assessment_id integer NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
      skill_id      integer NOT NULL REFERENCES skill_registry(id) ON DELETE CASCADE,
      self_level    smallint NOT NULL,
      self_comment  text NOT NULL DEFAULT '',
      lead_level    smallint,
      lead_comment  text NOT NULL DEFAULT '',
      PRIMARY KEY (assessment_id, skill_id)
    );

    CREATE TABLE IF NOT EXISTS capacities (
      id          integer PRIMARY KEY,
      project_key text NOT NULL,
      assignee    text NOT NULL,
      capacity    numeric DEFAULT 0,
      UNIQUE (assignee, project_key)
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version  integer PRIMARY KEY,
      name     text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    `
  },
  {
    version: 2,
    name: 'accounts, sessions, lead_links, owner scoping',
    sql: `
    CREATE TABLE IF NOT EXISTS accounts (
      id          integer PRIMARY KEY,
      email       text NOT NULL UNIQUE,
      full_name   text NOT NULL DEFAULT '',
      role        text NOT NULL DEFAULT 'employee',
      is_active   boolean NOT NULL DEFAULT true,
      jira_account_key text,
      created_at  timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token           text PRIMARY KEY,
      account_id      integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      jira_access_token text,
      jira_refresh_token text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      expires_at      timestamptz NOT NULL,
      ip              text NOT NULL DEFAULT '',
      user_agent      text NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS lead_links (
      id              integer PRIMARY KEY,
      account_id      integer NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
      lead_account_id integer REFERENCES accounts(id) ON DELETE SET NULL,
      updated_at      timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS owner_id integer REFERENCES accounts(id) ON DELETE SET NULL;
    ALTER TABLE assessments ADD COLUMN IF NOT EXISTS owner_id integer REFERENCES accounts(id) ON DELETE SET NULL;
    ALTER TABLE capacities ADD COLUMN IF NOT EXISTS owner_id integer REFERENCES accounts(id) ON DELETE SET NULL;
    ALTER TABLE requests ADD COLUMN IF NOT EXISTS created_by integer REFERENCES accounts(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_users_owner ON users (owner_id);
    CREATE INDEX IF NOT EXISTS idx_assessments_owner ON assessments (owner_id);
    CREATE INDEX IF NOT EXISTS idx_capacities_owner ON capacities (owner_id);
    CREATE INDEX IF NOT EXISTS idx_requests_created_by ON requests (created_by);
    `
  },
  {
    version: 3,
    name: 'account local passwords and login lookup',
    sql: `
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS password_hash text;

    CREATE INDEX IF NOT EXISTS idx_accounts_login
      ON accounts (lower(email), lower(coalesce(jira_account_key, '')));
    `
  },
];

async function runMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version  integer PRIMARY KEY,
      name     text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
      await client.query('COMMIT');
      console.log('Миграция применена: v' + m.version + ' ' + m.name);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

// Проверяет, пуста ли (в смысле бизнес-данных) схема — для автоимпорта data.json.
async function isDbEmpty(pool) {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*) FROM users) AS u,
      (SELECT count(*) FROM projects) AS p,
      (SELECT count(*) FROM skill_registry) AS s
  `);
  const r = rows[0] || {};
  return Number(r.u) === 0 && Number(r.p) === 0 && Number(r.s) === 0;
}

module.exports = { runMigrations, isDbEmpty };