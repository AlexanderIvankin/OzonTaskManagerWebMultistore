const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ============================================================================
// ОТДЕЛЬНАЯ БАЗА ОПОВЕЩЕНИЙ (notifications.db)
//
// Оповещения НЕ хранятся в основной БД bot_web.db — они живут в собственном
// файле, чтобы:
//  1) не раздувать основную базу историей событий;
//  2) можно было независимо настраивать ретенцию (срок хранения) и бэкапы;
//  3) журнал ошибок сервера был доступен даже при проблемах с основной БД.
// ============================================================================

// Базовый путь к БД оповещений: из NOTIFICATIONS_DB_PATH или по умолчанию рядом с backend/
const NOTIF_DB_BASE_PATH =
  process.env.NOTIFICATIONS_DB_PATH || path.join(__dirname, '../../notifications.db');

// Суффикс версии из BOT_VERSION — как у основной БД:
// BOT_VERSION=1 -> notifications.db -> notifications-1.db
const DB_VERSION = (process.env.BOT_VERSION || '').trim();

/**
 * Вставляет суффикс версии в имя файла: './notifications.db' -> './notifications-1.db'.
 * Уже существующий суффикс "-<число>" заменяется актуальной версией.
 */
function withVersionSuffix(dbPath) {
  if (!DB_VERSION) return dbPath;
  const dir = path.dirname(dbPath);
  const ext = path.extname(dbPath);
  const base = path.basename(dbPath, ext).replace(/-\d+$/, '') || 'notifications';
  return path.join(dir, `${base}-${DB_VERSION}${ext}`);
}

const NOTIF_DB_PATH = withVersionSuffix(NOTIF_DB_BASE_PATH);

let dbInstance = null;

async function initNotificationsDB() {
  if (dbInstance) return dbInstance;

  const dir = path.dirname(NOTIF_DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  dbInstance = await open({
    filename: NOTIF_DB_PATH,
    driver: sqlite3.Database,
  });

  // WAL — безопаснее при параллельной записи из API и планировщика
  await dbInstance.exec('PRAGMA journal_mode = WAL;');
  await createTables(dbInstance);
  await ensureSearchColumns(dbInstance);

  console.log(`✅ База оповещений инициализирована: ${NOTIF_DB_PATH}`);
  return dbInstance;
}

async function createTables(db) {
  // --- Оповещения ---
  // Каждое оповещение создаётся ПЕРСОНАЛЬНО для каждого получателя
  // ("как в email"): сотрудник — свои, каждый админ/модератор — свои копии
  // из журнала действий. Поэтому «прочитано/удалено» у каждого независимо.
  //
  // audience:
  //   'user'  — личные оповещения (назначение заказа, корректировка заработка, ...)
  //   'staff' — журнал действий сотрудников (для админов/модераторов)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_id INTEGER NOT NULL,
      audience TEXT NOT NULL DEFAULT 'user',
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT DEFAULT '',
      payload TEXT,
      is_read INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created ON notifications(recipient_id, created_at DESC);'
  );
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_notifications_recipient_audience ON notifications(recipient_id, audience, created_at DESC);'
  );
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_notifications_recipient_read ON notifications(recipient_id, is_read);'
  );

  // --- Ошибки сервера (общий журнал, доступен админам/модераторам) ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS server_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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

  console.log('✅ Таблицы оповещений созданы/проверены');
}

/**
 * Лёгкая миграция для существующих БД: колонки для быстрого поиска
 * (номер заказа, имя сотрудника). Добавляются безопасно, только если их ещё нет.
 */
async function ensureSearchColumns(db) {
  const columns = await db.all('PRAGMA table_info(notifications)');
  const names = columns.map((c) => c.name);
  if (!names.includes('order_id')) {
    await db.exec('ALTER TABLE notifications ADD COLUMN order_id TEXT');
    console.log('✅ notifications: добавлена колонка order_id (поиск по заказу)');
  }
  if (!names.includes('user_name')) {
    await db.exec('ALTER TABLE notifications ADD COLUMN user_name TEXT');
    console.log('✅ notifications: добавлена колонка user_name (поиск по сотруднику)');
  }
  if (!names.includes('offer_ids')) {
    await db.exec('ALTER TABLE notifications ADD COLUMN offer_ids TEXT');
    console.log('✅ notifications: добавлена колонка offer_ids (поиск по артикулу)');
  }

  // Колонка «прочитано» в журнале ошибок сервера (для вкладки «Ошибки сервера»:
  // «Прочитать выбранные / всё», фильтр «Только непрочитанные»).
  const errColumns = await db.all('PRAGMA table_info(server_errors)');
  const errNames = errColumns.map((c) => c.name);
  if (!errNames.includes('is_read')) {
    await db.exec('ALTER TABLE server_errors ADD COLUMN is_read INTEGER DEFAULT 0');
    console.log('✅ server_errors: добавлена колонка is_read (отметка прочитанности)');
  }
}

function getNotificationsDB() {
  if (!dbInstance) {
    throw new Error(
      'База оповещений не инициализирована. Сначала вызовите initNotificationsDB()'
    );
  }
  return dbInstance;
}

/**
 * Путь к файлу базы оповещений (для бэкапа/диагностики)
 */
function getNotificationsDBPath() {
  return NOTIF_DB_PATH;
}

module.exports = { initNotificationsDB, getNotificationsDB, getNotificationsDBPath };
