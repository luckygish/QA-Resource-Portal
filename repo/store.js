'use strict';

// Фабрика хранилища. Выбирает между PostgreSQL и data.json (fallback).
// Интерфейс: read()/write(doc)/ensureExists()/seed(doc)/isUsable()/withLock(fn).

const { PgStore } = require('./pg-store');
const { JsonStore } = require('./json-store');
const db = require('./db');

async function createStore() {
  const cfg = db.getConfig();

  if (cfg.enabled) {
    try {
      const pg = new PgStore();
      await pg.connect();
      const usable = await pg.isUsable();
      if (usable) {
        console.log('[repo] Хранилище: PostgreSQL (' + (cfg.url ? cfg.url.split('@').pop() : cfg.host + ':' + cfg.port + '/' + cfg.database) + ')');
        return pg;
      }
      console.warn('[repo] PostgreSQL недоступен — переключаюсь на data.json (fallback).');
    } catch (e) {
      console.warn('[repo] Не удалось подключиться к PostgreSQL: ' + e.message);
      console.warn('[repo] Переключаюсь на data.json (fallback).');
    }
  }

  const json = new JsonStore();
  json.ensureExists();
  console.warn('[repo] Хранилище: data.json (fallback).');
  return json;
}

module.exports = { createStore, PgStore, JsonStore, db };