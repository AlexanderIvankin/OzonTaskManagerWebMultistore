/**
 * Кулдауны команд веб-версии — паритет с Telegram-ботом (BOTFILES/commands.js),
 * с одним улучшением: `label` теперь двухуровневый:
 *   • label per-order  — 60 сек на КОНКРЕТНУЮ этикетку (повторный запрос той же);
 *   • label global     — 15 сек между РАЗНЫМИ этикетками (антиспам API).
 *
 * Если пользователь качает 10 этикеток подряд по одной — ждёт по 15 сек
 * между ними (вместо 60 сек на каждую). Защита от спама: Ozon rate limit.
 *
 * Остальные kind — без изменений:
 *   • allLabels     — 1 час после успеха / 1 минута после пусто/ошибки;
 *   • toggleOrders  — 1 минута;
 *   • refreshOrders — 1 минута;
 *   • toggleReturns — 1 минута.
 *
 * Хранение — Map: 'storeId:userId' (или 'storeId:userId:orderId' для label per-order).
 * Кулдаун ставится ТОЛЬКО после успешного выполнения (как в боте).
 * Устаревшие записи чистит scheduler.startCooldownCleaner раз в час
 * + ленивая очистка прямо в check() (чтобы 15-секундные записи не висели час).
 *
 * MULTISTORE: ключ включает storeId — сотрудник в двух магазинах имеет
 * независимые кулдауны.
 */

const LABEL_COOLDOWN_MS = 60 * 1000;
const LABEL_DIFFERENT_COOLDOWN_MS = 15 * 1000;
const SEND_ALL_LABELS_COOLDOWN_MS = 3600 * 1000;
const SEND_ALL_LABELS_EMPTY_COOLDOWN_MS = 60 * 1000;
const TOGGLE_ORDERS_COOLDOWN_MS = 60 * 1000;
const REFRESH_ORDERS_COOLDOWN_MS = 60 * 1000;
const TOGGLE_RETURNS_COOLDOWN_MS = 60 * 1000;

const labelPerOrderCooldowns = new Map();   // storeId:userId:orderId
const labelGlobalCooldowns = new Map();     // storeId:userId
const sendAllLabelsCooldowns = new Map();
const sendAllLabelsEmptyCooldowns = new Map();
const toggleOrdersCooldowns = new Map();
const refreshOrdersCooldowns = new Map();
const toggleReturnsCooldowns = new Map();

function makeKey(storeId, userId) {
  return `${storeId}:${userId}`;
}

const defaultKey = (storeId, userId) => makeKey(storeId, userId);

const DEFINITIONS = {
  label: [
    // 1. Per-order — 60 сек на ту же этикетку (проверяется первым: если
    //    человек жмёт повторно на тот же заказ, ждать 60 сек, а не 15).
    {
      map: labelPerOrderCooldowns,
      limitMs: LABEL_COOLDOWN_MS,
      key: (storeId, userId, opts) => {
        const oid = opts && opts.orderId;
        if (!oid) return null; // без orderId эту карту не трогаем
        return `${storeId}:${userId}:${oid}`;
      },
      message: (sec) => `⏳ Подождите ${sec} сек. перед повторным запросом этой этикетки.`,
    },
    // 2. Global — 15 сек между РАЗНЫМИ этикетками.
    {
      map: labelGlobalCooldowns,
      limitMs: LABEL_DIFFERENT_COOLDOWN_MS,
      key: defaultKey,
      message: (sec) => `⏳ Подождите ${sec} сек. перед запросом следующей этикетки.`,
    },
  ],
  allLabels: [
    {
      map: sendAllLabelsCooldowns,
      limitMs: SEND_ALL_LABELS_COOLDOWN_MS,
      key: defaultKey,
      message: (sec) => `⏳ Команда доступна раз в час. Подождите ${Math.ceil(sec / 60)} мин.`,
    },
    {
      map: sendAllLabelsEmptyCooldowns,
      limitMs: SEND_ALL_LABELS_EMPTY_COOLDOWN_MS,
      key: defaultKey,
      message: (sec) => `⏳ Подождите ${sec} сек. перед повторным запросом.`,
    },
  ],
  toggleOrders: [{
    map: toggleOrdersCooldowns,
    limitMs: TOGGLE_ORDERS_COOLDOWN_MS,
    key: defaultKey,
    message: (sec) => `⏳ Подождите ${sec} сек. перед повторным изменением статуса.`,
  }],
  refreshOrders: [{
    map: refreshOrdersCooldowns,
    limitMs: REFRESH_ORDERS_COOLDOWN_MS,
    key: defaultKey,
    message: (sec) => `⏳ Подождите ${sec} сек. перед повторным обновлением заказов.`,
  }],
  toggleReturns: [{
    map: toggleReturnsCooldowns,
    limitMs: TOGGLE_RETURNS_COOLDOWN_MS,
    key: defaultKey,
    message: (sec) => `⏳ Подождите ${sec} сек. перед повторным изменением статуса возвратов.`,
  }],
};

/**
 * check(kind, storeId, userId, opts|now?, now?)
 *   opts: { orderId?: string }
 * Обратная совместимость: 4-й аргумент может быть числом (now).
 * @returns {{blocked:false} | {blocked:true, retryAfterSec:number, message:string}}
 */
function check(kind, storeId, userId, optsOrNow, nowArg) {
  const opts = (optsOrNow && typeof optsOrNow === 'object') ? optsOrNow : {};
  const now = typeof optsOrNow === 'number'
    ? optsOrNow
    : (typeof nowArg === 'number' ? nowArg : Date.now());

  const stores = DEFINITIONS[kind];
  if (!stores) return { blocked: false };

  for (const store of stores) {
    const key = store.key(storeId, userId, opts);
    if (!key) continue;
    const last = store.map.get(key);
    if (last === undefined) continue;
    const elapsed = now - last;
    if (elapsed >= store.limitMs) {
      store.map.delete(key); // ленивая очистка
      continue;
    }
    const retryAfterSec = Math.max(1, Math.ceil((store.limitMs - elapsed) / 1000));
    return { blocked: true, retryAfterSec, message: store.message(retryAfterSec) };
  }
  return { blocked: false };
}

/**
 * touch(kind, storeId, userId, opts|storeIndex?, now?/storeIndex?)
 *   opts: { orderId?: string }
 *
 * Старые вызовы (совместимы):
 *   touch('allLabels', storeId, userId, 0)         — тронуть индекс 0;
 *   touch('label', storeId, userId, 0, now)        — тронуть индекс 0 с now.
 * Новые вызовы:
 *   touch('label', storeId, userId, { orderId })   — тронуть ВСЕ записи label.
 */
function touch(kind, storeId, userId, arg4, arg5) {
  let opts = {};
  let storeIndex = null;
  let now = Date.now();

  if (typeof arg4 === 'number') {
    storeIndex = arg4;
    if (typeof arg5 === 'number') now = arg5;
  } else if (arg4 && typeof arg4 === 'object') {
    opts = arg4;
    if (typeof arg5 === 'number') now = arg5;
  } else if (typeof arg5 === 'number') {
    now = arg5;
  }

  const stores = DEFINITIONS[kind];
  if (!stores) return;

  const targets = (storeIndex === null || storeIndex === undefined)
    ? stores
    : [stores[storeIndex]].filter(Boolean);

  for (const store of targets) {
    const key = store.key(storeId, userId, opts);
    if (!key) continue;
    store.map.set(key, now);
  }
}

function cleanCooldowns(now = Date.now()) {
  let deleted = 0;
  for (const stores of Object.values(DEFINITIONS)) {
    for (const store of stores) {
      for (const [key, time] of store.map) {
        if (now - time > store.limitMs) {
          store.map.delete(key);
          deleted++;
        }
      }
    }
  }
  if (deleted > 0) {
    console.log(`[COOLDOWN] Удалено ${deleted} устаревших записей кулдаунов`);
  }
  return deleted;
}

/**
 * Ручной сброс кулдаунов (админ/тесты). Без аргументов — сбросить всё.
 */
function resetCooldowns(storeId = null, userId = null) {
  let cleared = 0;
  const sId = storeId != null ? String(storeId) : null;
  const uId = userId != null ? String(userId) : null;

  for (const stores of Object.values(DEFINITIONS)) {
    for (const store of stores) {
      for (const key of Array.from(store.map.keys())) {
        const parts = key.split(':');
        const keyStore = parts[0];
        const keyUser = parts[1];
        const matchStore = sId == null || keyStore === sId;
        const matchUser = uId == null || keyUser === uId;
        if (matchStore && matchUser) {
          store.map.delete(key);
          cleared++;
        }
      }
    }
  }
  if (cleared > 0) {
    console.log(`[COOLDOWN] resetCooldowns(storeId=${sId}, userId=${uId}): удалено ${cleared}`);
  }
  return cleared;
}

function stats() {
  const out = {};
  for (const [kind, stores] of Object.entries(DEFINITIONS)) {
    out[kind] = stores.map((s) => s.map.size);
  }
  return out;
}

module.exports = {
  LABEL_COOLDOWN_MS,
  LABEL_DIFFERENT_COOLDOWN_MS,
  SEND_ALL_LABELS_COOLDOWN_MS,
  SEND_ALL_LABELS_EMPTY_COOLDOWN_MS,
  TOGGLE_ORDERS_COOLDOWN_MS,
  TOGGLE_RETURNS_COOLDOWN_MS,
  REFRESH_ORDERS_COOLDOWN_MS,
  makeKey,
  check,
  touch,
  cleanCooldowns,
  resetCooldowns,
  stats,
};