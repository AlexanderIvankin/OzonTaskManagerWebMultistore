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
 * Per-store здесь — только то, что РЕАЛЬНО отличается от магазина к магазину:
 *   • путь к БД магазина (store-N.db)
 *   • CORS origin (свой поддомен) + SUBDOMAIN для резолва по Host
 *   • Ozon-ключи (разные аккаунты продавцов) + суффикс фильтрации заказов
 *   • VAPID subject (контакт для push-сервисов своего поддомена)
 *   • флаги: очистка акций, отключение работы с 3D-моделями
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
      `(нужен для CORS; пример: https://store1.your-domain.ru)`
    );
  }

  // FILTER_ORDER_SUFFIX может прийти как "" (пустая строка в .env) — тогда
  // фильтра нет. trim() на всякий случай (пробелы в .env).
  const filterOrderSuffix = String(env.FILTER_ORDER_SUFFIX || '').trim();

  return {
    id: storeIdFinal,

    // Человеческое имя магазина для UI глобального профиля (dashboard
    // магазинов). STORE_NAME из .env.storeN, fallback — «Магазин N».
    name: String(env.STORE_NAME || `Магазин ${storeIdFinal}`).trim(),

    // Поддомен для резолва магазина по Host (см. middlewares/storeResolver.js).
    // store1.example.com -> 'store1'. Если SUBDOMAIN не задан — берётся STORE_ID.
    // Храним в нижнем регистре: Host приходит в нижнем регистре.
    subdomain: String(env.SUBDOMAIN || storeIdFinal).toLowerCase(),

    // Путь к БД этого магазина
    dbPath: env.DB_PATH || `./store-${storeIdFinal}.db`,

    // CORS origin (свой поддомен)
    clientOrigin: env.CLIENT_ORIGIN,

    // Ozon (свой аккаунт продавца)
    ozon: {
      clientId: env.OZON_CLIENT_ID,
      apiKey: env.OZON_API_KEY,
    },

    // Фильтрация заказов по суффиксу offer_id (per-store, т.к. ассортимент
    // магазинов различается). Пусто / не задан -> null (без фильтра).
    // Используется в OzonService.fetchAwaitingOrders.
    filterOrderSuffix: filterOrderSuffix || null,

    // Web Push subject (уникальный mailto на поддомен)
    push: {
      vapidSubject:
        env.VAPID_SUBJECT ||
        `mailto:admin@${env.CLIENT_ORIGIN.replace(/^https?:\/\//, '')}`,
    },

    // Флаги, которые могут отличаться между магазинами
    features: {
      // Ежедневная очистка акций этого магазина
      cleanPromotions: (env.CLEAN_PROMOTIONS || 'false') === 'true',
      // Отключение работы с 3D-моделями для магазина (если модели не нужны):
      // выдача при назначении заказа, кнопки скачивания, раздел «Модели».
      disableModels: (env.DISABLE_MODELS || 'false') === 'true',
    },
  };
}

const stores = {};
for (const storeId of getAvailableStoreIds()) {
  try {
    stores[storeId] = buildStore(storeId);
  } catch (err) {
    console.error(`[stores] Не удалось собрать конфиг магазина ${storeId}:`, err.message);
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

function getStoreIds() {
  return Object.keys(stores);
}

function getStore(storeId) {
  const s = stores[String(storeId)];
  if (!s) {
    throw new Error(`[stores] Магазин ${storeId} не зарегистрирован`);
  }
  return s;
}

module.exports = stores;

// Хелперы — НЕперечислимые, чтобы цикл по магазинам видел только ID.
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