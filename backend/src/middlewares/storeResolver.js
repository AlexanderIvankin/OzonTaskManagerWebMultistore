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
 * Глобальные пути — доступны БЕЗ магазина (например, на корневом домене
 * myapp.com, где нет магазина, но живёт глобальный профиль).
 *
 * req.path здесь уже БЕЗ префикса /api (роутер смонтирован на /api),
 * поэтому проверяем пути в форме '/auth/login', '/user/stores' и т.д.
 *
 * Если запрос пришёл с магазинного поддомена (shop1.example.com) — эти же
 * пути работают как обычно, просто req.storeId будет заполнен.
 */
function isGlobalPath(path) {
  if (path === '/auth' || path.startsWith('/auth/')) return true;
  // Список магазинов пользователя (страница GlobalProfile)
  if (path === '/user/stores') return true;
  // Push-подписки — глобальные (привязаны к устройству, не к магазину)
  if (path.startsWith('/user/push-')) return true;
  // Оповещения — общие для всех магазинов: на глобальном домене
  // отдаём ЕДИНЫЙ inbox со всех магазинов (Notification.getByRecipient
  // с storeId=null не применяет фильтр по магазину).
  if (path === '/notifications' || path.startsWith('/notifications/')) return true;
  // Приём заказов — сквозной флаг users.taking_orders (глобальный,
  // не per-store), переключается и с глобального домена тоже.
  if (path === '/user/toggle-orders') return true;

  // Обновление display_name — глобальное поле users, доступно любому
  // авторизованному пользователю (в том числе без роли в магазине).
  if (path === '/user/display-name') return true;
  return false;
}

/**
 * Express-middleware. Кладёт req.storeId и req.store.
 * Вешается на /api ДО authenticate и роутов.
 *
 * MULTISTORE + глобальный домен:
 *   • магазин определён → req.storeId, req.store заполнены;
 *   • магазин не определён, но путь глобальный (/auth/*, /user/stores,
 *     /user/push-*) → req.storeId = null, req.store = null, пропускаем;
 *   • магазин не определён и путь НЕ глобальный → 404 STORE_NOT_FOUND.
 */
function storeResolver(req, res, next) {
  const hostname = hostnameFromHostHeader(req.headers.host);
  const rootDomain = (process.env.ROOT_DOMAIN || '').trim().toLowerCase();

  // 1. Корневой домен = ГЛОБАЛЬНЫЙ контекст (магазина нет).
  //    Здесь работает только глобальный набор путей: /auth/*, /user/stores,
  //    /user/push-*. Всё остальное — 404 (магазин не выбран).
  //    Без этой проверки fallback «единственный магазин» вернул бы магазин 1
  //    даже на корневом домене, и фронт не смог бы отличить глобальный
  //    профиль от магазинного.
  if (rootDomain && (hostname === rootDomain || hostname === `www.${rootDomain}`)) {
    if (isGlobalPath(req.path)) {
      req.storeId = null;
      req.store = null;
      return next();
    }
    return res.status(404).json({
      error: 'Магазин не найден',
      code: 'STORE_NOT_FOUND',
      host: req.headers.host || null,
    });
  }

  // 2. Резолвинг магазина по Host (shop1.example.com → магазин 1)
  const storeId = resolveStoreId(hostname);

  if (!storeId) {
    if (isGlobalPath(req.path)) {
      req.storeId = null;
      req.store = null;
      return next();
    }
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