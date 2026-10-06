require('dotenv').config(); // грузит глобальный .env в process.env

const fs = require('fs');
const path = require('path');

// Папка backend — где лежат .env файлы (../.. от src/config)
const BACKEND_DIR = path.resolve(__dirname, '../..');

/**
 * Минимальный парсер .env файла.
 * НЕ использует dotenv, потому что нам нужно изолированное пространство
 * имён для per-store переменных (не подмешивать в process.env).
 */
function parseEnvFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Снимаем кавычки
    if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Находит все .env.store<N> файлы в backend/ и возвращает объект:
 *   { '1': { STORE_ID: '1', OZON_CLIENT_ID: '...', ... },
 *     '2': { ... } }
 */
function loadAllStoreEnvs() {
  const result = {};

  const entries = fs.readdirSync(BACKEND_DIR);
  for (const name of entries) {
    const match = name.match(/^\.env\.store(\d+)$/);
    if (!match) continue;

    const storeId = match[1];
    const filePath = path.join(BACKEND_DIR, name);

    try {
      const env = parseEnvFile(filePath);
      // STORE_ID в файле опционален — берём из имени, если не указан
      env.STORE_ID = env.STORE_ID || storeId;
      result[storeId] = env;
    } catch (err) {
      console.error(`[envLoader] Ошибка парсинга ${name}:`, err.message);
    }
  }

  return result;
}

const storeEnvs = loadAllStoreEnvs();

/**
 * Собирает конфиг одного магазина:
 *   - глобальные переменные (process.env)
 *   - затем per-store переопределения из .env.store<ID>
 * Также подставляет {STORE_ID} в шаблонных строках (например, DB_PATH=./store-{STORE_ID}.db).
 */
function getStoreConfig(storeId) {
  const perStore = storeEnvs[String(storeId)] || {};

  // Мерджим: per-store переопределяет глобальные
  const merged = { ...process.env, ...perStore };
  merged.STORE_ID = String(storeId);

  // Подставляем {STORE_ID} в значениях
  for (const key of Object.keys(merged)) {
    if (typeof merged[key] === 'string') {
      merged[key] = merged[key].replace(/\{STORE_ID\}/g, merged.STORE_ID);
    }
  }

  return merged;
}

function getAvailableStoreIds() {
  return Object.keys(storeEnvs).sort((a, b) => Number(a) - Number(b));
}

module.exports = {
  getStoreConfig,
  getAvailableStoreIds,
  storeEnvs, // для отладки
};