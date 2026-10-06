// ВАЖНО: PushService подключается на верхнем уровне через
// NotificationService -> AuthService -> routes/auth, то есть загружается при
// СТАРТЕ сервера. Поэтому MODULE_NOT_FOUND/SyntaxError из require('web-push')
// (например, на сервере не выполнен `npm install` после обновления кода) уронил
// бы весь API: nginx начал бы отдавать 502 на все запросы, включая /api/auth/login.
// Вместо падения — режим «Web Push выключен» с понятной строкой в логе.
let webpush = null;
try {
  webpush = require('web-push');
} catch (err) {
  console.warn(
    `[Push] Web Push выключен: пакет web-push недоступен (${err.message}). ` +
      'Выполните `npm install` в папке backend/ и перезапустите процесс.'
  );
}
const { getDB } = require('../config/database');

// ============================================================================
// PushService — обёртка над web-push: доставка оповещений тем, кто ОФЛАЙН.
//
// Канал доставки выбирает NotificationService: есть активный сокет (онлайн) —
// событие уходит мгновенно через Socket.IO; сокетов нет — PushService шлёт
// Web Push на ВСЕ подписанные устройства пользователя (сценарий «офлайн»).
//
// Схема таблицы — src/config/database.js (push_subscriptions, endpoint UNIQUE).
// HTTP-эндпоинты подписок — src/routes/user.js:
//   GET  /api/user/push-public-key  → публичный VAPID-ключ для браузера;
//   POST /api/user/push-subscribe   → сохранить подписку устройства;
//   POST /api/user/push-unsubscribe → удалить подписку (в т.ч. при выходе).
//
// Ключи VAPID (backend/.env):
//   VAPID_PUBLIC_KEY  — отдаётся клиенту как applicationServerKey (не секрет);
//   VAPID_PRIVATE_KEY — ТОЛЬКО на сервере, в браузер не попадает;
//   VAPID_SUBJECT     — контакт администратора (mailto:...).
//   Сгенерировать заново: npx web-push generate-vapid-keys
//
// ВАЖНО: setVapidDetails() бросает исключение на пустых/битых ключах, а
// PushService подключается из NotificationService — падение здесь уронило бы
// весь сервер. Поэтому при ошибке сервис переходит в режим «выключен»
// (enabled → false), а все методы становятся безопасными no-op.
// ============================================================================

// TTL push-сообщения: 24 часа. Если пользователь офлайн — FCM/APNs подержит
// уведомление до суток и доставит его, когда он снова появится в сети.
const PUSH_TTL_SEC = 86400;

let vapidReady = false;

/** Подписка больше не валидна: браузер отписался / удалил данные. */
function isGone(err) {
  return err?.statusCode === 404 || err?.statusCode === 410;
}

if (!webpush) {
  // Пакет не установлен — Web Push отключён (см. warning выше).
} else {
  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@your-domain.ru',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
    vapidReady = true;
  } catch (err) {
    // Сервер продолжает работать, но Web Push отключён (ошибка видна в логе).
    console.warn(
      `[Push] Web Push выключен — проверьте VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY в .env: ${err.message}`
    );
  }
}

class PushService {
  /** Настроен ли Web Push на сервере (пакет установлен + валидные VAPID-ключи). */
  static get enabled() {
    return Boolean(webpush) && vapidReady && Boolean(process.env.VAPID_PUBLIC_KEY);
  }

  /** Публичный VAPID-ключ для клиента (applicationServerKey). */
  static get publicKey() {
    return process.env.VAPID_PUBLIC_KEY || null;
  }

  /** TTL push-сообщения в секундах (документация/тесты). */
  static get ttlSec() {
    return PUSH_TTL_SEC;
  }

  /** Валидация подписки, пришедшей из браузера (PushSubscription.toJSON()). */
  static isValidSubscription(subscription) {
    const keys = subscription?.keys;
    return Boolean(
      subscription &&
        typeof subscription.endpoint === 'string' &&
        subscription.endpoint.trim() &&
        keys &&
        typeof keys.p256dh === 'string' &&
        keys.p256dh &&
        typeof keys.auth === 'string' &&
        keys.auth
    );
  }
  /**
   * Сохранить/обновить подписку устройства.
   * endpoint UNIQUE: повторная подписка того же браузера ОБНОВЛЯЕТ строку, а
   * вход ДРУГОГО пользователя на этом устройстве ПЕРЕприсваивает подписку ему —
   * иначе прежний владелец продолжал бы получать чужие оповещения.
   * @returns {Promise<boolean>} true — подписка сохранена
   */
  static async subscribe(userId, subscription, userAgent = null) {
    if (!PushService.isValidSubscription(subscription)) return false;
    try {
      const db = getDB();
      const now = Date.now();
      await db.run(
        `INSERT INTO push_subscriptions
           (user_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           user_agent = excluded.user_agent,
           last_used_at = excluded.last_used_at`,
        userId,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        userAgent || null,
        now,
        now
      );
      return true;
    } catch (err) {
      console.error('[Push] subscribe:', err.message);
      return false;
    }
  }

  /**
   * Удалить подписку одного устройства (выход из системы, выключение push).
   * @returns {Promise<number>} число удалённых строк
   */
  static async unsubscribe(userId, endpoint) {
    if (!endpoint) return 0;
    try {
      const db = getDB();
      const result = await db.run(
        'DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?',
        userId,
        endpoint
      );
      return result.changes || 0;
    } catch (err) {
      console.error('[Push] unsubscribe:', err.message);
      return 0;
    }
  }

  /**
   * Удалить ВСЕ подписки пользователя (на всех устройствах).
   * @returns {Promise<number>} число удалённых строк
   */
  static async unsubscribeAll(userId) {
    try {
      const db = getDB();
      const result = await db.run(
        'DELETE FROM push_subscriptions WHERE user_id = ?',
        userId
      );
      return result.changes || 0;
    } catch (err) {
      console.error('[Push] unsubscribeAll:', err.message);
      return 0;
    }
  }

  /** Количество подписанных устройств пользователя. */
  static async countForUser(userId) {
    try {
      const db = getDB();
      const row = await db.get(
        'SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?',
        userId
      );
      return row ? row.count : 0;
    } catch (err) {
      console.error('[Push] countForUser:', err.message);
      return 0;
    }
  }

  /**
   * Отправить push во ВСЕ подписки пользователя (сценарий «несколько устройств»).
   * Никогда не бросает исключений — сбой push не должен ломать бизнес-логику.
   * @param {number} userId
   * @param {object} payload - данные для Service Worker (title/body/url/tag/...)
   * @returns {Promise<{sent:number, failed:number, removed:number}>}
   */
  static async sendToUser(userId, payload) {
    const result = { sent: 0, failed: 0, removed: 0 };
    // !webpush — пакет не установлен: отправлять нечем. Сервер при этом работает
    // (см. защищённый require выше), просто без Web Push.
    if (!webpush || !PushService.enabled) return result;

    try {
      const db = getDB();
      const subs = await db.all(
        'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
        userId
      );
      if (!subs.length) return result;

      const data = JSON.stringify(payload || {});
      const now = Date.now();
      const expired = [];

      for (const sub of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            data,
            { TTL: PUSH_TTL_SEC }
          );
          result.sent++;
          // Отметка «живости» подписки: по ней pruneStale чистит мёртвые
          await db.run(
            'UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?',
            now,
            sub.id
          );
        } catch (err) {
          if (isGone(err)) {
            // 404/410 — браузер отписался: строку удаляем сразу
            expired.push(sub.id);
          } else {
            result.failed++;
            console.error(`[Push] Ошибка доставки #${sub.id}:`, err.message);
          }
        }
      }

      if (expired.length) {
        result.removed = await PushService._deleteByIds(expired);
      }
    } catch (err) {
      console.error('[Push] sendToUser:', err.message);
    }

    return result;
  }

  /** Удалить подписки по id (внутреннее). */
  static async _deleteByIds(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    try {
      const db = getDB();
      const placeholders = ids.map(() => '?').join(', ');
      const result = await db.run(
        `DELETE FROM push_subscriptions WHERE id IN (${placeholders})`,
        ...ids
      );
      return result.changes || 0;
    } catch (err) {
      console.error('[Push] _deleteByIds:', err.message);
      return 0;
    }
  }

  /**
   * Удалить «залежавшиеся» подписки: те, что не использовались N дней
   * (last_used_at, а для только что созданных — created_at). Вызывается
   * планировщиком в ежедневной очистке. Фронт переподписывается при каждом
   * входе в приложение (upsert обновляет last_used_at), поэтому активные
   * устройства под чистку не попадают, а таблица не растёт бесконечно.
   * @param {number} days
   * @returns {Promise<number>} число удалённых подписок
   */
  static async pruneStale(days = 180) {
    try {
      const db = getDB();
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const result = await db.run(
        `DELETE FROM push_subscriptions
          WHERE COALESCE(last_used_at, created_at) < ?`,
        cutoff
      );
      return result.changes || 0;
    } catch (err) {
      console.error('[Push] pruneStale:', err.message);
      return 0;
    }
  }
}

module.exports = PushService;