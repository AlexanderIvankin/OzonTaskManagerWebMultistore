// src/config/database.js
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');

const config = require('./index');
const stores = require('./stores');
const {
  createUsersSchema,
  createModelsSchema,
  createStoreSchema,
} = require('./schema');

// ============================================================================
//  СОСТОЯНИЕ
// ============================================================================

let usersDbInstance = null;
let modelsDbInstance = null;
const storeDbInstances = new Map(); // storeId → connection

// ============================================================================
//  ХЕЛПЕРЫ
// ============================================================================

function resolveDbPath(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath) {
    throw new Error(`resolveDbPath: ожидается непустая строка, получено: ${dbPath}`);
  }
  return path.isAbsolute(dbPath)
    ? dbPath
    : path.resolve(__dirname, '../..', dbPath);
}

/**
 * Открывает БД, применяет схему и (опционально) ATTACH'ит users.db
 * под схемой 'usersdb' — чтобы store-модели могли делать
 * JOIN usersdb.users ...
 *
 * ATTACH работает на уровне СOEDINENIЯ, а не файла. При открытии store-1.db
 * в нём появляется дополнительная схема 'usersdb', указывающая на users.db.
 * FK через неё работать не будет (SQLite не умеет междокументные FK), но
 * JOIN и SELECT — работают.
 */
async function _openAndInit(dbPath, schemaFn, label, { attachUsersDb = false } = {}) {
  const absolutePath = resolveDbPath(dbPath);

  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = await open({
    filename: absolutePath,
    driver: sqlite3.Database,
  });

  await db.exec('PRAGMA foreign_keys = ON');
  await db.exec('PRAGMA busy_timeout = 5000');
  await db.exec('PRAGMA journal_mode = WAL');

  // ATTACH users.db как схема 'usersdb'
  if (attachUsersDb) {
    const usersPath = resolveDbPath(config.usersDbPath);
    if (!fs.existsSync(usersPath)) {
      throw new Error(
        `ATTACH users.db: файл не найден (${usersPath}). ` +
        `Сначала должна быть инициализирована users.db.`
      );
    }
    // Идемпотентность: если уже ATTACH'нут — пропускаем
    const attached = await db.all('PRAGMA database_list');
    if (!attached.some((d) => d.name === 'usersdb')) {
      await db.run('ATTACH DATABASE ? AS usersdb', usersPath);
    }
  }

  await schemaFn(db);
  return { db, absolutePath };
}

// ============================================================================
//  ИНИЦИАЛИЗАЦИЯ
// ============================================================================

async function initDB() {
  // Идемпотентность: не переоткрываем соединения, если уже готовы
  if (usersDbInstance && modelsDbInstance && storeDbInstances.size > 0) {
    return getStatus();
  }

  const startTime = Date.now();

  // --- 1. users.db (единый для всех магазинов) ---
  const usersResult = await _openAndInit(
    config.usersDbPath, createUsersSchema, 'users'
  );
  usersDbInstance = usersResult.db;

  // --- 2. models.db (единый, с ATTACH users.db для uploaded_by) ---
  const modelsResult = await _openAndInit(
    config.modelsDbPath, createModelsSchema, 'models',
    { attachUsersDb: true }
  );
  modelsDbInstance = modelsResult.db;

  // --- 3. store-N.db (по одной на каждый магазин, с ATTACH users.db) ---
  for (const storeId of Object.keys(stores)) {
    const store = stores[storeId];
    if (!store || typeof store !== 'object' || !store.dbPath) {
      console.warn(`[DB] Магазин ${storeId} пропущен: не задан dbPath`);
      continue;
    }
    try {
      const result = await _openAndInit(
        store.dbPath, createStoreSchema, `store-${storeId}`,
        { attachUsersDb: true }
      );
      storeDbInstances.set(String(storeId), result.db);
    } catch (err) {
      console.error(`[DB] Не удалось открыть store-${storeId}.db:`, err.message);
      throw err;
    }
  }

  _logInit(startTime);
  _checkLegacyFile();

  return getStatus();
}

function _logInit(startTime) {
  const elapsed = Date.now() - startTime;
  console.log('✅ Все БД инициализированы:');
  console.log(`   users.db:      ${resolveDbPath(config.usersDbPath)}`);
  console.log(`   models.db:     ${resolveDbPath(config.modelsDbPath)}  [ATTACH usersdb]`);
  for (const storeId of storeDbInstances.keys()) {
    const store = stores[storeId];
    console.log(`   store-${storeId}.db:  ${resolveDbPath(store.dbPath)}  [ATTACH usersdb]`);
  }
  console.log(`   ⏱  ${elapsed} мс`);
}

function _checkLegacyFile() {
  const legacyPath = resolveDbPath(config.legacyDbPath || './bot_web.db');
  if (!fs.existsSync(legacyPath)) return;

  console.warn(
    '\n' +
    '┌────────────────────────────────────────────────────────────────┐\n' +
    '│ ⚠️  Обнаружен legacy-файл (старая схема):                       │\n' +
    `│    ${legacyPath.padEnd(60)}│\n` +
    '│                                                                │\n' +
    '│ Backend работает с НОВОЙ схемой:                               │\n' +
    '│   • users.db      — пользователи, user_stores, auth             │\n' +
    '│   • models.db     — метаданные моделей, выдача                  │\n' +
    '│   • store-N.db    — assignments, earnings, warehouses           │\n' +
    '│                                                                │\n' +
    '│ Если миграция ещё НЕ выполнена:                                 │\n' +
    '│   1. Остановить backend                                         │\n' +
    '│   2. cd migration && node split.js                              │\n' +
    '│   3. Скопировать output/*.db рядом с backend/                   │\n' +
    '│   4. Перезапустить backend                                      │\n' +
    '│                                                                │\n' +
    '│ Legacy-файл НЕ удаляем — он остаётся как резервная копия.       │\n' +
    '└────────────────────────────────────────────────────────────────┘\n'
  );
}

// ============================================================================
//  ГЕТТЕРЫ
// ============================================================================

function getUsersDB() {
  if (!usersDbInstance) {
    throw new Error('users.db не инициализирована. Сначала вызовите initDB().');
  }
  return usersDbInstance;
}

function getModelsDB() {
  if (!modelsDbInstance) {
    throw new Error('models.db не инициализирована. Сначала вызовите initDB().');
  }
  return modelsDbInstance;
}

function getStoreDB(storeId) {
  const key = String(storeId);
  const db = storeDbInstances.get(key);
  if (!db) {
    const available = Array.from(storeDbInstances.keys()).join(', ') || '(нет)';
    throw new Error(
      `store-${key}.db не инициализирована.\n` +
      `Проверьте, что существует файл .env.store${key} и он валиден.\n` +
      `Доступные магазины: ${available}`
    );
  }
  return db;
}

/**
 * @deprecated — единого getDB() в multi-store нет.
 */
function getDB() {
  throw new Error(
    'getDB() устарел в multi-store архитектуре.\n' +
    'Используйте:\n' +
    '  getUsersDB()           — users, user_stores, refresh_tokens, ...\n' +
    '  getModelsDB()          — offer_models, issued_models\n' +
    '  getStoreDB(storeId)    — assignments, earnings, warehouses, ...'
  );
}

// ============================================================================
//  ЗАКРЫТИЕ И СТАТУС
// ============================================================================

async function closeAll() {
  let closed = 0;

  const tryClose = async (db, label) => {
    if (!db) return;
    try {
      await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
      console.warn(`[DB] wal_checkpoint для ${label}:`, err.message);
    }
    try {
      await db.close();
      closed++;
    } catch (err) {
      console.warn(`[DB] Ошибка закрытия ${label}:`, err.message);
    }
  };

  await tryClose(usersDbInstance, 'users.db');
  usersDbInstance = null;

  await tryClose(modelsDbInstance, 'models.db');
  modelsDbInstance = null;

  for (const [storeId, db] of storeDbInstances) {
    await tryClose(db, `store-${storeId}.db`);
  }
  storeDbInstances.clear();

  console.log(`[DB] Закрыто соединений: ${closed}`);
}

function getStatus() {
  const legacyPath = config.legacyDbPath || './bot_web.db';

  const status = {
    usersDb: {
      path: resolveDbPath(config.usersDbPath),
      connected: !!usersDbInstance,
    },
    modelsDb: {
      path: resolveDbPath(config.modelsDbPath),
      connected: !!modelsDbInstance,
      attachUsers: true, // ← добавляется в _openAndInit
    },
    storeDbs: {},
    legacy: {
      path: resolveDbPath(legacyPath),
      exists: fs.existsSync(resolveDbPath(legacyPath)),
    },
  };

  for (const storeId of Object.keys(stores)) {
    const store = stores[storeId];
    const db = storeDbInstances.get(String(storeId));
    status.storeDbs[storeId] = {
      path: resolveDbPath(store.dbPath),
      connected: !!db,
      attachUsers: true,
    };
  }

  return status;
}

// ============================================================================
//  ЭКСПОРТ
// ============================================================================

module.exports = {
  initDB,
  closeAll,

  getUsersDB,
  getModelsDB,
  getStoreDB,
  getDB,       // deprecated

  getStatus,
  resolveDbPath,
};