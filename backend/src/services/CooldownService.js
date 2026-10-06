/**
 * Кулдауны команд веб-версии — паритет с Telegram-ботом (BOTFILES/commands.js):
 *   • label         — /send_label: 1 минута после успешной выдачи этикетки;
 *   • allLabels     — /send_all_labels: 1 час после УСПЕШНОЙ склейки (основной)
 *                     + 1 минута после пустого ответа/ошибки (короткий);
 *   • toggleOrders  — /toggle_orders: 1 минута после успешного переключения;
 *   • refreshOrders — страница «Мои заказы»: 1 минута после успешной
 *                     синхронизации статусов (кнопка «Обновить»).
 *
 * Хранение — в памяти процесса (Map: String(userId) -> timestamp срабатывания).
 * Кулдаун ставится ТОЛЬКО после успешного выполнения (как в боте).
 * Устаревшие записи вычищает планировщик: scheduler.startCooldownCleaner (раз в час).
 */

const LABEL_COOLDOWN_MS = 60 * 1000; // 1 минута
const SEND_ALL_LABELS_COOLDOWN_MS = 3600 * 1000; // 1 час (после успеха)
const SEND_ALL_LABELS_EMPTY_COOLDOWN_MS = 60 * 1000; // 1 минута (пусто/ошибка)
const TOGGLE_ORDERS_COOLDOWN_MS = 60 * 1000; // 1 минута
const REFRESH_ORDERS_COOLDOWN_MS = 60 * 1000; // 1 минута

const labelCooldowns = new Map();
const sendAllLabelsCooldowns = new Map();
const sendAllLabelsEmptyCooldowns = new Map();
const toggleOrdersCooldowns = new Map();
const refreshOrdersCooldowns = new Map();

/**
 * Описание кулдаунов по kind: массив «хранилищ» (у allLabels их два —
 * длинный и короткий, проверяются по порядку, как в боте).
 * message(retryAfterSec) — текст, совпадает с ботом.
 */
const DEFINITIONS = {
  label: [
    {
      map: labelCooldowns,
      limitMs: LABEL_COOLDOWN_MS,
      message: (sec) => `⏳ Подождите ${sec} сек. перед повторным запросом этикетки.`,
    },
  ],
  allLabels: [
    {
      map: sendAllLabelsCooldowns,
      limitMs: SEND_ALL_LABELS_COOLDOWN_MS,
      message: (sec) => `⏳ Команда доступна раз в час. Подождите ${Math.ceil(sec / 60)} мин.`,
    },
    {
      map: sendAllLabelsEmptyCooldowns,
      limitMs: SEND_ALL_LABELS_EMPTY_COOLDOWN_MS,
      message: (sec) => `⏳ Подождите ${sec} сек. перед повторным запросом.`,
    },
  ],
  toggleOrders: [
    {
      map: toggleOrdersCooldowns,
      limitMs: TOGGLE_ORDERS_COOLDOWN_MS,
      message: (sec) => `⏳ Подождите ${sec} сек. перед повторным изменением статуса.`,
    },
  ],
  refreshOrders: [
    {
      map: refreshOrdersCooldowns,
      limitMs: REFRESH_ORDERS_COOLDOWN_MS,
      message: (sec) => `⏳ Подождите ${sec} сек. перед повторным обновлением заказов.`,
    },
  ],
};

/**
 * Проверка кулдауна для команды.
 * @param {string} kind - 'label' | 'allLabels' | 'toggleOrders'
 * @param {number|string} userId
 * @param {number} [now] - метка времени (для тестов)
 * @returns {{blocked: false}
 *          | {blocked: true, retryAfterSec: number, message: string}}
 */
function check(kind, userId, now = Date.now()) {
  const stores = DEFINITIONS[kind];
  if (!stores) return { blocked: false };
  const key = String(userId);
  for (const store of stores) {
    const last = store.map.get(key);
    if (last === undefined) continue;
    const elapsed = now - last;
    if (elapsed < store.limitMs) {
      const retryAfterSec = Math.max(1, Math.ceil((store.limitMs - elapsed) / 1000));
      return { blocked: true, retryAfterSec, message: store.message(retryAfterSec) };
    }
  }
  return { blocked: false };
}

/**
 * Зафиксировать срабатывание кулдауна (после УСПЕШНОГО выполнения команды).
 * @param {string} kind - 'label' | 'allLabels' | 'toggleOrders'
 * @param {number|string} userId
 * @param {number} [storeIndex] - индекс хранилища внутри kind (у allLabels:
 *   0 — длинный «успех», 1 — короткий «пусто/ошибка»)
 * @param {number} [now] - метка времени (для тестов)
 */
function touch(kind, userId, storeIndex = 0, now = Date.now()) {
  const stores = DEFINITIONS[kind];
  if (!stores || !stores[storeIndex]) return;
  stores[storeIndex].map.set(String(userId), now);
}

/**
 * Очищает устаревшие записи из всех кулдаунов (вызывает планировщик
 * раз в час, по аналогии с ботом). Возвращает число удалённых записей.
 * @param {number} [now] - метка времени (для тестов)
 */
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
 * Размеры хранилищ по kind (диагностика/тесты).
 * @returns {Object<string, number[]>}
 */
function stats() {
  const out = {};
  for (const [kind, stores] of Object.entries(DEFINITIONS)) {
    out[kind] = stores.map((s) => s.map.size);
  }
  return out;
}

module.exports = {
  LABEL_COOLDOWN_MS,
  SEND_ALL_LABELS_COOLDOWN_MS,
  SEND_ALL_LABELS_EMPTY_COOLDOWN_MS,
  TOGGLE_ORDERS_COOLDOWN_MS,
  REFRESH_ORDERS_COOLDOWN_MS,
  check,
  touch,
  cleanCooldowns,
  stats,
};
