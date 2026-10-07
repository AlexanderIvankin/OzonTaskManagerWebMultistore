const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ============================================================================
//  ЕДИНАЯ БАЗА ОПОВЕЩЕНИЙ (notifications.db)
//
//  Одна на всё приложение. Все оповещения и ошибки сервера для всех
//  магазинов лежат в одной БД, разделяются колонкой store_id:
//    • notifications.store_id — какой магазин породил оповещение
//      (NULL для системных, не привязанных к конкретному магазину)
//    • server_errors.store_id — какой магазин породил ошибку
//
//  Плюсы единой БД:
//    • один файл вместо N (меньше бэкапов, меньше путаницы);
//    • сквозной журнал серверных ошибок — админ видит все сразу,
//      фильтрует по магазину;
//    • легко считать сводную статистику.
//
//  Ретенция и бэкапы настраиваются для всей БД целиком.
// ============================================================================

// Единая БД оповещений (одна на всё приложение).
// Путь задаётся через NOTIFICATIONS_DB_PATH (глобальный .env),
// по умолчанию './notifications.db'.
const NOTIFICATIONS_DB_PATH = process.env.NOTIFICATIONS_DB_PATH || './notifications.db';

let dbInstance = null;

async function initNotificationsDB() {
  if (dbInstance) return dbInstance;

  const absolutePath = path.isAbsolute(NOTIFICATIONS_DB_PATH)
    ? NOTIFICATIONS_DB_PATH
    : path.resolve(__dirname, '../..', NOTIFICATIONS_DB_PATH);

  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  dbInstance = await open({
    filename: absolutePath,
    driver: sqlite3.Database,
  });

  await dbInstance.exec('PRAGMA journal_mode = WAL;');
  await dbInstance.exec('PRAGMA busy_timeout = 5000;');
  await createTables(dbInstance);
  await ensureSearchColumns(dbInstance);

  console.log(`✅ База оповещений инициализирована: ${absolutePath}`);
  return dbInstance;
}

async function createTables(db) {
  // --- Оповещения ---
  // store_id: '1', '2', ... — идентификатор магазина.
  // Для системных (не привязанных к магазину) — NULL.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_id INTEGER NOT NULL,
      store_id TEXT,
      audience TEXT NOT NULL DEFAULT 'user',
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT DEFAULT '',
      payload TEXT,
      order_id TEXT,
      user_name TEXT,
      offer_ids TEXT,
      is_read INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created ON notifications(recipient_id, created_at DESC);'
  );
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_notifications_recipient_store ON notifications(recipient_id, store_id, created_at DESC);'
  );
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_notifications_recipient_audience ON notifications(recipient_id, audience, created_at DESC);'
  );
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_notifications_recipient_read ON notifications(recipient_id, is_read);'
  );

  // --- Ошибки сервера ---
  // store_id: тот же смысл. NULL для глобальных ошибок (auth, initDB и т.п.).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS server_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id TEXT,
      level TEXT NOT NULL DEFAULT 'error',
      source TEXT DEFAULT '',
      message TEXT NOT NULL,
      stack TEXT,
      context TEXT,
      is_read INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_server_errors_created ON server_errors(created_at DESC);'
  );
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_server_errors_store ON server_errors(store_id, created_at DESC);'
  );

  console.log('✅ Таблицы оповещений созданы/проверены');
}

/**
 * Лёгкая миграция для существующих БД: добавляем колонки, которых
 * может не быть (order_id, user_name, offer_ids, store_id, is_read).
 */
async function ensureSearchColumns(db) {
  const columns = await db.all('PRAGMA table_info(notifications)');
  const names = columns.map((c) => c.name);

  if (!names.includes('order_id')) {
    await db.exec('ALTER TABLE notifications ADD COLUMN order_id TEXT');
    console.log('✅ notifications: добавлена колонка order_id');
  }
  if (!names.includes('user_name')) {
    await db.exec('ALTER TABLE notifications ADD COLUMN user_name TEXT');
    console.log('✅ notifications: добавлена колонка user_name');
  }
  if (!names.includes('offer_ids')) {
    await db.exec('ALTER TABLE notifications ADD COLUMN offer_ids TEXT');
    console.log('✅ notifications: добавлена колонка offer_ids');
  }
  // НОВОЕ: store_id
  if (!names.includes('store_id')) {
    await db.exec('ALTER TABLE notifications ADD COLUMN store_id TEXT');
    await db.exec(
      'CREATE INDEX IF NOT EXISTS idx_notifications_recipient_store ON notifications(recipient_id, store_id, created_at DESC);'
    );
    console.log('✅ notifications: добавлена колонка store_id (multi-store)');
  }

  // server_errors
  const errColumns = await db.all('PRAGMA table_info(server_errors)');
  const errNames = errColumns.map((c) => c.name);

  if (!errNames.includes('is_read')) {
    await db.exec('ALTER TABLE server_errors ADD COLUMN is_read INTEGER DEFAULT 0');
    console.log('✅ server_errors: добавлена колонка is_read');
  }
  if (!errNames.includes('store_id')) {
    await db.exec('ALTER TABLE server_errors ADD COLUMN store_id TEXT');
    await db.exec(
      'CREATE INDEX IF NOT EXISTS idx_server_errors_store ON server_errors(store_id, created_at DESC);'
    );
    console.log('✅ server_errors: добавлена колонка store_id (multi-store)');
  }
}

function getNotificationsDB() {
  if (!dbInstance) {
    throw new Error(
      'База оповещений не инициализирована. Сначала вызовите initNotificationsDB().'
    );
  }
  return dbInstance;
}

function getNotificationsDBPath() {
  return NOTIFICATIONS_DB_PATH;
}

async function closeNotificationsDB() {
  if (!dbInstance) return;
  try {
    await dbInstance.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.warn('[NotifDB] wal_checkpoint:', err.message);
  }
  await dbInstance.close();
  dbInstance = null;
  console.log('[NotifDB] Соединение закрыто');
}

module.exports = {
  initNotificationsDB,
  getNotificationsDB,
  getNotificationsDBPath,
  closeNotificationsDB,
};