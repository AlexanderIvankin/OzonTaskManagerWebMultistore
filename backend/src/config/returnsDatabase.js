// src/config/returnsDatabase.js
//
// Отдельная БД на каждый магазин: returns-N.db.
// По аналогии с notifications/chat — свой модуль, свой lifecycle.
// Здесь лежит локальный кэш возвратов Ozon, чтобы резолв lozon_id → offer_id
// был мгновенным и без регулярных тяжёлых запросов в Ozon.

const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');

const stores = require('./stores');

const instances = new Map(); // storeId -> connection

function resolveReturnsPath(storeId) {
  const sid = String(storeId);
  const store = stores[sid] || {};
  const rel = store.returnsDbPath || `./returns-${sid}.db`;
  return path.isAbsolute(rel) ? rel : path.resolve(__dirname, '../..', rel);
}

async function createReturnsSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS returns (
      id                TEXT PRIMARY KEY,
      barcode           TEXT,
      cargo_box_id      TEXT,
      offer_id          TEXT,
      sku               TEXT,
      product_name      TEXT,
      quantity          INTEGER DEFAULT 1,
      order_id          TEXT,
      order_number      TEXT,
      posting_number    TEXT,
      schema            TEXT,
      return_schema     TEXT,
      return_date       TEXT,
      status_name       TEXT,
      status_sys_name   TEXT,
      place_name        TEXT,
      resolution_status TEXT NOT NULL DEFAULT 'pending',
      raw_json          TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_returns_barcode ON returns(barcode)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_returns_cargo_box ON returns(cargo_box_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_returns_offer ON returns(offer_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_returns_resolution ON returns(resolution_status)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_returns_return_date ON returns(return_date)');

  // Мягкая миграция для старых БД без cargo_box_id
  const cols = await db.all('PRAGMA table_info(returns)');
  if (!cols.some((c) => c.name === 'cargo_box_id')) {
    await db.exec('ALTER TABLE returns ADD COLUMN cargo_box_id TEXT');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_returns_cargo_box ON returns(cargo_box_id)');
    console.log('✅ returns: добавлена колонка cargo_box_id');
  }
}

async function initReturnsDB() {
  if (instances.size > 0) return;
  for (const storeId of stores.getStoreIds()) {
    const dbPath = resolveReturnsPath(storeId);
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.exec('PRAGMA journal_mode = WAL');
    await db.exec('PRAGMA busy_timeout = 5000');
    await createReturnsSchema(db);
    instances.set(String(storeId), db);
    console.log(`✅ returns-${storeId}.db: ${dbPath}`);
  }
}

function getReturnsDB(storeId) {
  const db = instances.get(String(storeId));
  if (!db) {
    const available = Array.from(instances.keys()).join(', ') || '(нет)';
    throw new Error(
      `returns-${storeId}.db не инициализирована. Доступные: ${available}. ` +
      `Проверьте, что initReturnsDB() вызван на старте сервера.`
    );
  }
  return db;
}

async function closeAllReturnsDB() {
  for (const [sid, db] of instances) {
    try { await db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    try { await db.close(); } catch (err) {
      console.warn(`[ReturnsDB] close store ${sid}:`, err.message);
    }
  }
  instances.clear();
}

module.exports = {
  initReturnsDB,
  getReturnsDB,
  closeAllReturnsDB,
  resolveReturnsPath,
};