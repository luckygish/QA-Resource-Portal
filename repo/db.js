'use strict';

// Конфигурация подключения к PostgreSQL.
// Приоритет: переменные окружения -> файл конфига (.db-config.json) -> значения по умолчанию.

const fs = require('fs');
const path = require('path');

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 5432;
const DEFAULT_DB = 'qa_portal';
const DEFAULT_USER = 'postgres';
const DEFAULT_PASS = '';

function appDir() {
  // При сборке в exe (pkg) __dirname указывает на in-memory snapshot;
  // конфиг читаем рядом с исполняемым файлом.
  return typeof process !== 'undefined' && process.pkg ? path.dirname(process.execPath) : __dirname;
}

function loadConfigFile() {
  const candidates = [
    path.join(appDir(), '.db-config.json'),
    path.resolve(appDir(), '..') !== appDir() ? path.join(path.resolve(appDir(), '..'), '.db-config.json') : null,
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error('Не удалось прочитать конфиг БД ' + file + ':', e.message);
    }
  }
  return {};
}

function parsePort(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function getConfig() {
  const file = loadConfigFile();
  const env = process.env;

  const host = env.DB_HOST || file.host || DEFAULT_HOST;
  const port = parsePort(env.DB_PORT !== undefined ? env.DB_PORT : file.port, DEFAULT_PORT);
  const database = env.DB_NAME || file.database || DEFAULT_DB;
  const user = env.DB_USER || file.user || DEFAULT_USER;
  const password = env.DB_PASSWORD !== undefined ? env.DB_PASSWORD : (file.password !== undefined ? file.password : DEFAULT_PASS);

  // DATABASE_URL имеет максимальный приоритет, если задан
  const url = env.DATABASE_URL || file.url || null;

  return {
    enabled: env.PG_ENABLED !== '0' && (env.PG_ENABLED === '1' || Boolean(url || file.host || isEnvDefined())),
    url,
    host,
    port,
    database,
    user,
    password,
    ssl: env.DB_SSL === '1' || file.ssl ? { rejectUnauthorized: false } : false,
  };
}

function isEnvDefined() {
  return ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DATABASE_URL'].some((k) => process.env[k] !== undefined);
}

module.exports = { getConfig, appDir };