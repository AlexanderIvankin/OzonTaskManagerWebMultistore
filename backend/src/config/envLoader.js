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
/**
 * Собирает конфиг одного магазина:
 *   - глобальные переменные (process.env)
 *   - затем per-store переопределения из .env.store<ID>
 *   - затем раскрывает ${VAR} / {VAR} для ВСЕХ известных ключей merged
 *     (включая STORE_ID → SUBDOMAIN → CLIENT_ORIGIN — цепочки любой длины).
 *
 * Раскрытие делается в несколько проходов (до 5), чтобы цепочки
 * вида CLIENT_ORIGIN=https://${SUBDOMAIN}.x, SUBDOMAIN=store${STORE_ID}
 * срабатывали независимо от порядка строк в .env файле.
 *
 * Имена переменных регистронезависимы: ${SUBDOMAIN} и ${subdomain} → одно и то же.
 * Неизвестные ссылки остаются как есть (${NOPE} → "${NOPE}").
 */
function getStoreConfig(storeId) {
  const perStore = storeEnvs[String(storeId)] || {};
  const merged = { ...process.env, ...perStore };
  merged.STORE_ID = String(storeId);

  const VAR_RE = /\$?\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  const MAX_PASSES = 5;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    // Регистронезависимая карта ключей: 'subdomain' → 'SUBDOMAIN'
    const keyMap = new Map();
    for (const k of Object.keys(merged)) {
      keyMap.set(k.toUpperCase(), k);
    }

    let changed = false;
    for (const key of Object.keys(merged)) {
      const value = merged[key];
      if (typeof value !== 'string' || !value.includes('{')) continue;

      const replaced = value.replace(VAR_RE, (match, varName) => {
        // Не раскрываем self-reference (X=${X})
        if (varName.toUpperCase() === key.toUpperCase()) return match;

        const actualKey = keyMap.get(varName.toUpperCase());
        if (!actualKey) return match;             // неизвестная переменная — оставить как есть

        const replacement = merged[actualKey];
        if (replacement === undefined || replacement === null) return match;
        if (String(replacement) === match) return match; // защита от циклов

        changed = true;
        return String(replacement);
      });

      if (replaced !== value) merged[key] = replaced;
    }

    if (!changed) break;
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