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

/**
 * Преобразует относительный путь к БД (из .env: './users.db')
 * в абсолютный, относительно корня backend/.
 */
function resolveDbPath(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath) {
    throw new Error(`resolveDbPath: ожидается непустая строка, получено: ${dbPath}`);
  }
  return path.isAbsolute(dbPath)
    ? dbPath
    : path.resolve(__dirname, '../..', dbPath);
}

/**
 * Открывает БД и применяет схему. Создаёт файл, если его нет.
 * @returns {Promise<{ db, absolutePath }>}
 */
async function _openAndInit(dbPath, schemaFn, label) {
  const absolutePath = resolveDbPath(dbPath);

  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = await open({
    filename: absolutePath,
    driver: sqlite3.Database,
  });

  // Foreign keys — важно для консистентности
  await db.exec('PRAGMA foreign_keys = ON');
  // Ждать до 5 секунд снятия блокировки вместо мгновенного SQLITE_BUSY
  await db.exec('PRAGMA busy_timeout = 5000');
  // WAL — устойчивее к конкурентной записи (API + планировщик + сокеты)
  await db.exec('PRAGMA journal_mode = WAL');

  await schemaFn(db);

  return { db, absolutePath };
}

// ============================================================================
//  ИНИЦИАЛИЗАЦИЯ
// ============================================================================

async function initDB() {
  // Идемпотентность
  if (usersDbInstance && modelsDbInstance && storeDbInstances.size > 0) {
    return getStatus();
  }

  const startTime = Date.now();

  // --- users.db (единый для всех магазинов) ---
  const usersResult = await _openAndInit(
    config.usersDbPath, createUsersSchema, 'users'
  );
  usersDbInstance = usersResult.db;

  // --- models.db (единый для всех магазинов) ---
  const modelsResult = await _openAndInit(
    config.modelsDbPath, createModelsSchema, 'models'
  );
  modelsDbInstance = modelsResult.db;

  // --- store-N.db (по одной на каждый магазин из реестра) ---
  for (const storeId of Object.keys(stores)) {
    const store = stores[storeId];
    if (!store || typeof store !== 'object' || !store.dbPath) {
      console.warn(`[DB] Магазин ${storeId} пропущен: не задан dbPath`);
      continue;
    }
    try {
      const result = await _openAndInit(
        store.dbPath, createStoreSchema, `store-${storeId}`
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
  console.log(`   models.db:     ${resolveDbPath(config.modelsDbPath)}`);
  for (const storeId of storeDbInstances.keys()) {
    const store = stores[storeId];
    console.log(`   store-${storeId}.db:  ${resolveDbPath(store.dbPath)}`);
  }
  console.log(`   ⏱  ${elapsed} мс`);
}

/**
 * Проверяет наличие legacy-файла (bot_web-N.db со старой схемой).
 * Если есть — печатает заметный warning с подсказкой о миграции.
 * Legacy-файл НЕ удаляем, оставляем как резервную копию.
 */
function _checkLegacyFile() {
  const legacyPath = config.legacyDbPath || './bot_web.db';
  const absoluteLegacy = resolveDbPath(legacyPath);

  if (!fs.existsSync(absoluteLegacy)) return;

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
    '│   3. Проверить output/ и скопировать *.db рядом с backend/      │\n' +
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
 * @deprecated Используйте getUsersDB / getModelsDB / getStoreDB(storeId).
 * Метод оставлен, чтобы старый код падал с понятным сообщением,
 * а не с непонятной ошибкой.
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

  if (usersDbInstance) {
    await usersDbInstance.close();
    usersDbInstance = null;
    closed++;
  }
  if (modelsDbInstance) {
    await modelsDbInstance.close();
    modelsDbInstance = null;
    closed++;
  }
  for (const [, db] of storeDbInstances) {
    try {
      await db.close();
      closed++;
    } catch (err) {
      console.warn('[DB] Ошибка закрытия store-соединения:', err.message);
    }
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
    },
    storeDbs: {},
    legacy: {
      path: resolveDbPath(legacyPath),
      exists: fs.existsSync(resolveDbPath(legacyPath)),
    },
  };

  for (const storeId of Object.keys(stores)) {
    const store = stores[storeId];
    const db = storeDbInstances.get(storeId);
    status.storeDbs[storeId] = {
      path: resolveDbPath(store.dbPath),
      connected: !!db,
    };
  }

  return status;
}

// ============================================================================
//  ЭКСПОРТ
// ============================================================================

module.exports = {
  // Инициализация / закрытие
  initDB,
  closeAll,

  // Геттеры
  getUsersDB,
  getModelsDB,
  getStoreDB,
  getDB,       // deprecated

  // Информация
  getStatus,

  // Хелперы
  resolveDbPath,
};