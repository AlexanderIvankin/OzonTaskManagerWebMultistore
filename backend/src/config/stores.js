// src/config/stores.js
const { getStoreConfig, getAvailableStoreIds } = require('./envLoader');
const globalConfig = require('./index');

/**
 * Реестр магазинов.
 *
 * Каждый магазин — независимый конфиг, собранный из:
 *   • глобального .env (через envLoader)
 *   • .env.store<N> (переопределяет/дополняет)
 *
 * Per-store в этом файле — только то, что РЕАЛЬНО отличается
 * от магазина к магазину:
 *   • идентификатор и пути к БД (store-N.db, notifications-N.db)
 *   • CORS origin (свой поддомен)
 *   • Ozon-ключи (разные аккаунты продавцов)
 *   • VAPID subject (контакт для push-сервисов своего поддомена)
 *   • флаг включения очистки акций
 *
 * Всё остальное (SMTP, S3, JWT, GOD, timezone, интервалы планировщиков
 * и т.п.) — глобально в src/config/index.js.
 */

function buildStore(storeId) {
  const env = getStoreConfig(storeId);

  if (!env.STORE_ID) {
    throw new Error(`[stores] Магазин ${storeId}: не задан STORE_ID`);
  }

  const storeIdFinal = String(env.STORE_ID);

  // Валидация обязательного per-store
  if (!env.OZON_CLIENT_ID || !env.OZON_API_KEY) {
    throw new Error(
      `[stores] Магазин ${storeIdFinal}: не заданы OZON_CLIENT_ID / OZON_API_KEY ` +
      `(проверьте .env.store${storeIdFinal})`
    );
  }
  if (!env.CLIENT_ORIGIN) {
    throw new Error(
      `[stores] Магазин ${storeIdFinal}: не задан CLIENT_ORIGIN ` +
      `(нужен для CORS; пример: https://shop1.your-domain.ru)`
    );
  }

  return {
    id: storeIdFinal,

    // Пути к БД этого магазина
    dbPath: env.DB_PATH || `./store-${storeIdFinal}.db`,
    notificationsDbPath:
      env.NOTIFICATIONS_DB_PATH || `./notifications-${storeIdFinal}.db`,

    // CORS origin
    clientOrigin: env.CLIENT_ORIGIN,

    // Ozon (свой аккаунт продавца)
    ozon: {
      clientId: env.OZON_CLIENT_ID,
      apiKey: env.OZON_API_KEY,
      // shipIdentifier — глобальный, оставлен здесь для удобства
      // (значение подтягивается из globalConfig при использовании)
    },

    // Web Push subject (уникальный mailto на поддомен)
    push: {
      vapidSubject:
        env.VAPID_SUBJECT ||
        `mailto:admin@${env.CLIENT_ORIGIN.replace(/^https?:\/\//, '')}`,
    },

    // Флаги, которые могут отличаться между магазинами
    features: {
      cleanPromotions:
        (env.CLEAN_PROMOTIONS || 'false') === 'true',
    },
  };
}

const stores = {};
for (const storeId of getAvailableStoreIds()) {
  try {
    stores[storeId] = buildStore(storeId);
  } catch (err) {
    console.error(`[stores] Не удалось собрать конфиг магазина ${storeId}:`, err.message);
    // В production лучше падать сразу, но на этапе отладки — пропускаем магазин
    if (process.env.NODE_ENV === 'production') process.exit(1);
  }
}

if (Object.keys(stores).length === 0) {
  throw new Error(
    '[stores] Не найдено ни одного валидного .env.store<N> файла. ' +
    'Создайте .env.store1 на основе .env.store1.example.'
  );
}

console.log(
  `[stores] Загружены магазины: ${Object.keys(stores).join(', ')}`
);

// Удобный хелпер: получить список ID всех магазинов
function getStoreIds() {
  return Object.keys(stores);
}

// Удобный хелпер: получить конфиг магазина (с бросанием, если нет)
function getStore(storeId) {
  const s = stores[String(storeId)];
  if (!s) {
    throw new Error(`[stores] Магазин ${storeId} не зарегистрирован`);
  }
  return s;
}

module.exports = stores;

// Экспортируем хелперы как НЕперечислимые свойства.
// Иначе Object.keys(stores) вернёт не только ID магазинов ('1', '2', ...),
// но и 'getStoreIds' / 'getStore', и циклы по магазинам будут
// пытаться обработать функции как конфиги.
Object.defineProperty(module.exports, 'getStoreIds', {
  value: getStoreIds,
  enumerable: false,
  writable: false,
  configurable: false,
});

Object.defineProperty(module.exports, 'getStore', {
  value: getStore,
  enumerable: false,
  writable: false,
  configurable: false,
});

module.exports.getStoreIds = getStoreIds;
module.exports.getStore = getStore;