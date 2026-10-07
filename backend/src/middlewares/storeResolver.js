// Определяет магазин по Host запроса (поддомен) и кладёт его в req.storeId.
//
// Приоритет:
//   1. Точное совпадение hostname с hostname из CLIENT_ORIGIN магазина.
//   2. Совпадение первого лейбла hostname с SUBDOMAIN магазина
//      (shop1.example.com -> 'shop1'; 1.example.com -> '1').
//   3. Fallback: если в реестре ровно ОДИН магазин — отдаём его для любого Host.
//      Это рабочий режим локальной разработки (localhost:3000/5000)
//      и этап миграции на один магазин.
//   4. Иначе — 404 STORE_NOT_FOUND (фронт обрабатывает как «неизвестный магазин»
//      и ведёт на общий login).
//
// Резолвер НЕ падает, если Host не пришёл (например, служебный healthcheck):
// в single-store режиме отдаст единственный магазин, в multi-store — 404.
const stores = require('../config/stores');
const { getStoreIds } = stores;

/** 'https://shop1.example.com:443' -> 'shop1.example.com' */
function hostnameFromOrigin(origin) {
  if (!origin) return null;
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 'shop1.example.com:5000' -> 'shop1.example.com' */
function hostnameFromHostHeader(hostHeader) {
  if (!hostHeader) return null;
  return String(hostHeader).split(':')[0].trim().toLowerCase();
}

/**
 * Резолвит storeId по hostname.
 * @param {string|null} hostname
 * @returns {string|null}
 */
function resolveStoreId(hostname) {
  const ids = getStoreIds();
  if (!hostname) {
    // Без Host: в single-store можно, в multi-store — нет
    return ids.length === 1 ? ids[0] : null;
  }

  // 1. Точное совпадение с CLIENT_ORIGIN
  for (const storeId of ids) {
    const store = stores[storeId];
    const originHost = hostnameFromOrigin(store.clientOrigin);
    if (originHost && originHost === hostname) return storeId;
  }

  // 2. Совпадение первого лейбла с SUBDOMAIN
  const firstLabel = hostname.split('.')[0];
  for (const storeId of ids) {
    const store = stores[storeId];
    if (store.subdomain && store.subdomain === firstLabel) return storeId;
  }

  // 3. Fallback для single-store (dev / миграция)
  if (ids.length === 1) return ids[0];

  // 4. Ничего не совпало
  return null;
}

/**
 * Express-middleware. Кладёт req.storeId и req.store.
 * Вешается на /api ДО authenticate и роутов.
 */
function storeResolver(req, res, next) {
  const hostname = hostnameFromHostHeader(req.headers.host);
  const storeId = resolveStoreId(hostname);

  if (!storeId) {
    return res.status(404).json({
      error: 'Магазин не найден',
      code: 'STORE_NOT_FOUND',
      host: req.headers.host || null,
    });
  }

  req.storeId = storeId;
  req.store = stores[storeId];
  next();
}

module.exports = { storeResolver, resolveStoreId };