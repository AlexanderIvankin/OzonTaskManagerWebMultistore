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
const { getUsersDB } = require('../config/database');

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

// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY — ГЛОБАЛЬНЫЕ (одни на всё приложение):
// все подписки создаются с одним applicationServerKey, менять нельзя.
// VAPID_SUBJECT — PER-STORE (подставляется per-call в sendNotification через
// options.vapidDetails). Fallback — нейтральный контакт администратора.
const config = require('../config');
const { getStore } = require('../config/stores');

/** Подписка больше не валидна. */
function isGone(err) {
  const s = err?.statusCode;
  // 404/410 — подписка удалена браузером;
  // 400 — битые ключи (дешифровка не удалась);
  // 403 — VAPID subject отклонён push-сервисом;
  // 413 — payload слишком большой (FCM 4KB).
  return s === 404 || s === 410 || s === 400 || s === 403 || s === 413;
}

/**
 * VAPID-детали для конкретной отправки.
 * Ключи глобальные, subject — per-store (если магазин известен).
 * Никогда не бросает: если магазин не найден или поле пустое — отдаём
 * дефолтный контакт из .env (DEFAULT_VAPID_SUBJECT).
 *
 * @param {string|number|null} storeId
 * @returns {{ subject: string, publicKey: string, privateKey: string }}
 */
function getVapidDetails(storeId) {
  let subject = config.push.vapidDefaultSubject || 'mailto:admin@your-domain.com';

  if (storeId) {
    try {
      const store = getStore(String(storeId));
      if (store?.push?.vapidSubject) subject = store.push.vapidSubject;
    } catch (err) {
      // Магазин не найден — не роняем push, используем дефолт.
      console.warn(`[Push] Магазин ${storeId} не найден, использую DEFAULT_VAPID_SUBJECT`);
    }
  }

  return {
    subject,
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  };
}

if (!webpush) {
  // Пакет не установлен — Web Push отключён (см. warning выше).
} else if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  console.warn(
    '[Push] Web Push выключен — VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY не заданы в .env'
  );
}

class PushService {
  /** Настроен ли Web Push на сервере (пакет установлен + валидные VAPID-ключи). */
  /** Настроен ли Web Push на сервере (пакет + оба ключа присутствуют). */
  static get enabled() {
    return Boolean(webpush)
      && Boolean(process.env.VAPID_PUBLIC_KEY)
      && Boolean(process.env.VAPID_PRIVATE_KEY);
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
   * Максимум УСТРОЙСТВ на одного пользователя.
   *
   * ВАЖНО: это НЕ максимум подписок. Одно устройство = один user_agent и
   * несколько подписок — по одной на каждый origin (главный домен + каждый
   * поддомен магазина), потому что браузер регистрирует отдельный Service
   * Worker для каждого origin и выдаёт разные endpoint'ы.
   *
   * Пример: у сотрудника 2 устройства, он работает в 3 магазинах.
   * Origins: your-domain.com + store1 + store2 + store3 = 4.
   * Подписок: 2 × 4 = 8. Все восемь должны жить.
   */
  static get MAX_DEVICES_PER_USER() {
    return Math.max(1, parseInt(process.env.PUSH_MAX_DEVICES_PER_USER, 10) || 5);
  }

  /**
   * Жёсткий предохранитель от «бесконечного» роста (баг, миграция, дубликаты).
   * Считается в подписках, а не устройствах — срабатывает только при аномалии.
   */
  static get MAX_SUBS_HARD_LIMIT() {
    return Math.max(20, parseInt(process.env.PUSH_MAX_SUBS_HARD_LIMIT, 10) || 100);
  }

  static async subscribe(userId, subscription, userAgent = null, origin = null) {
    if (!PushService.isValidSubscription(subscription)) return false;
    try {
      const db = getUsersDB();

      // Глобальный opt-out: если пользователь отключил push — не сохраняем
      // новые подписки и не воскрешаем старые. Снять флаг может только явное
      // включение через UI (см. userController.pushEnable).
      const u = await db.get('SELECT push_disabled FROM users WHERE id = ?', userId);
      if (u && u.push_disabled) {
        console.log(`[Push] user=${userId}: push_disabled=1, подписка проигнорирована`);
        return false;
      }

      const now = Date.now();
      await db.run(
        `INSERT INTO push_subscriptions
           (user_id, endpoint, p256dh, auth, user_agent, origin, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           user_agent = excluded.user_agent,
           origin = COALESCE(excluded.origin, push_subscriptions.origin),
           last_used_at = excluded.last_used_at`,
        userId,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        userAgent || null,
        origin ? String(origin).trim() : null,
        now,
        now
      );

      // --- 1. Лимит УСТРОЙСТВ -----------------------------------------------
      // Одно устройство = один user_agent (браузер + ОС). Все подписки одного
      // UA (разные origin'ы) считаются одним устройством. Если устройств
      // больше лимита — удаляем все подписки самого СТАРОГО устройства
      // (того UA, у которого минимальный last_used_at/created_at).
      const maxDevices = PushService.MAX_DEVICES_PER_USER;
      const deviceGroups = await db.all(
        `SELECT COALESCE(user_agent, '') AS ua,
                COUNT(*)                 AS cnt,
                MIN(COALESCE(last_used_at, created_at)) AS oldest
         FROM push_subscriptions
         WHERE user_id = ?
         GROUP BY COALESCE(user_agent, '')
         ORDER BY oldest ASC`,
        userId
      );
      if (deviceGroups.length > maxDevices) {
        const excessDevices = deviceGroups.slice(0, deviceGroups.length - maxDevices);
        for (const d of excessDevices) {
          const res = await db.run(
            `DELETE FROM push_subscriptions
             WHERE user_id = ? AND COALESCE(user_agent, '') = ?`,
            userId, d.ua
          );
          console.log(
            `[Push] user=${userId}: устройств > ${maxDevices}, удалено старое ` +
            `устройство (ua="${(d.ua || '—').slice(0, 40)}", подписок: ${res.changes})`
          );
        }
      }

      // --- 2. Safety-net по общему количеству подписок ----------------------
      // На случай бага/миграции — не даём таблице расти бесконечно.
      const hardLimit = PushService.MAX_SUBS_HARD_LIMIT;
      const totalRow = await db.get(
        'SELECT COUNT(*) AS cnt FROM push_subscriptions WHERE user_id = ?',
        userId
      );
      if (totalRow && totalRow.cnt > hardLimit) {
        const toDelete = totalRow.cnt - hardLimit;
        const old = await db.all(
          `SELECT id FROM push_subscriptions
           WHERE user_id = ?
           ORDER BY COALESCE(last_used_at, created_at) ASC
           LIMIT ?`,
          userId, toDelete
        );
        if (old.length) {
          const ids = old.map((r) => r.id);
          const ph = ids.map(() => '?').join(',');
          const res = await db.run(
            `DELETE FROM push_subscriptions WHERE id IN (${ph})`,
            ...ids
          );
          console.warn(
            `[Push] user=${userId}: подписок > ${hardLimit} (аномалия), удалено ${res.changes} старых`
          );
        }
      }

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
      const db = getUsersDB();
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
 * Удалить все подписки пользователя, связанные с конкретным устройством
 * (user_agent). Используется при logout: один origin — текущий SW, но
 * подписок у устройства может быть несколько (na3d.ru + все поддомены).
 * Удаляем все разом.
 *
 * Оговорка: два устройства с одинаковым user_agent (например, два iPhone
 * одной модели/iOS) схлопнутся. На практике это редко — детали UA обычно
 * различаются (версия ОС, сборка браузера).
 *
 * @param {number} userId
 * @param {string} userAgent
 * @returns {Promise<number>}
 */
  static async unsubscribeAllForDevice(userId, userAgent) {
    if (!userAgent || typeof userAgent !== 'string') return 0;
    try {
      const db = getUsersDB();
      const result = await db.run(
        'DELETE FROM push_subscriptions WHERE user_id = ? AND user_agent = ?',
        userId, userAgent
      );
      console.log(
        `[Push] user=${userId}: logout с устройства ua="${userAgent.slice(0, 40)}…", удалено ${result.changes} подписок`
      );
      return result.changes || 0;
    } catch (err) {
      console.error('[Push] unsubscribeAllForDevice:', err.message);
      return 0;
    }
  }

  /**
 * Полное отключение push для пользователя: ставит users.push_disabled = 1
 * и удаляет ВСЕ его подписки (все устройства × все origin'ы).
 *
 * С этого момента subscribe() не сохраняет новые подписки, даже если
 * пользователь зайдёт на другой домен или переустановит браузер.
 * Включить обратно — только через pushEnable().
 */
  static async disableForUser(userId) {
    try {
      const db = getUsersDB();
      await db.run('UPDATE users SET push_disabled = 1, updated_at = ? WHERE id = ?', Date.now(), userId);
      const res = await db.run('DELETE FROM push_subscriptions WHERE user_id = ?', userId);
      console.log(`[Push] user=${userId}: push отключён глобально, удалено ${res.changes} подписок`);
      return res.changes || 0;
    } catch (err) {
      console.error('[Push] disableForUser:', err.message);
      return 0;
    }
  }

  /**
   * Обратное включение: снимает users.push_disabled. Сами подписки создаст
   * браузер при следующем заходе (usePushSubscription → subscribe).
   */
  static async enableForUser(userId) {
    try {
      const db = getUsersDB();
      await db.run('UPDATE users SET push_disabled = 0, updated_at = ? WHERE id = ?', Date.now(), userId);
      console.log(`[Push] user=${userId}: push разрешён, браузер переподпишется при входе`);
      return true;
    } catch (err) {
      console.error('[Push] enableForUser:', err.message);
      return false;
    }
  }

  /** Текущее состояние (для UI): отключён ли push глобально. */
  static async getGlobalStatus(userId) {
    try {
      const db = getUsersDB();
      const u = await db.get('SELECT push_disabled FROM users WHERE id = ?', userId);
      return { disabled: !!(u && u.push_disabled) };
    } catch {
      return { disabled: false };
    }
  }

  /**
   * Удалить ВСЕ подписки пользователя (на всех устройствах).
   * @returns {Promise<number>} число удалённых строк
   */
  static async unsubscribeAll(userId) {
    try {
      const db = getUsersDB();
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

  /**
   * Количество УСТРОЙСТВ пользователя (по уникальным user_agent).
   *
   * ВАЖНО: не путать с количеством подписок. Одно устройство = один
   * user_agent и несколько подписок (по одной на каждый origin, где юзер
   * заходил). Для UI «У вас N устройств» считаем именно устройства.
   */
  static async countForUser(userId) {
    try {
      const db = getUsersDB();
      const row = await db.get(
        `SELECT COUNT(DISTINCT COALESCE(user_agent, '')) AS count
         FROM push_subscriptions WHERE user_id = ?`,
        userId
      );
      return row ? row.count : 0;
    } catch (err) {
      console.error('[Push] countForUser:', err.message);
      return 0;
    }
  }

  /**
   * Отправить push во ВСЕ подписки пользователя (или в подписки конкретного
   * origin — см. opts.origin).
   *
   * @param {number} userId
   * @param {object} payload
   * @param {object} [opts]
   *   storeId — для VAPID subject (per-store).
   *   origin  — фильтр по origin (например, 'https://store1.na3d.ru').
   *             Если задан — шлём ТОЛЬКО на подписки с этим origin.
   *             Если null/undefined — шлём на все origin (системные события).
   *             Fallback: если для заданного origin подписок НЕТ, но есть
   *             подписки с origin = NULL (старые записи до миграции) —
   *             шлём на них, чтобы не потерять пользователей.
   */
  static async sendToUser(userId, payload, { storeId = null, origin = null } = {}) {
    const result = { sent: 0, failed: 0, removed: 0 };
    if (!webpush || !PushService.enabled) return result;

    try {
      const db = getUsersDB();

      // Выбор подписок с дедупликацией по УСТРОЙСТВУ.
      //
      // Правило: на КАЖДОЕ устройство (user_agent) — не больше одной
      // отправки. Если у одного UA накопилось N подписок с одинаковым
      // origin (Firefox пересоздавал endpoint, миграция, ручной insert) —
      // отправляем только на самую свежую. Иначе на одно событие прилетит
      // N баннеров на одно устройство.
      //
      // SQL ниже для каждой пары (user_id, user_agent, origin) выбирает
      // ровно одну строку — с максимальным last_used_at, а при равенстве —
      // с максимальным id (последняя вставленная).
      let subs;
      if (origin) {
        subs = await db.all(
          `SELECT id, endpoint, p256dh, auth
           FROM push_subscriptions ps
           WHERE ps.user_id = ?
             AND ps.origin = ?
             AND ps.id = (
               SELECT ps2.id FROM push_subscriptions ps2
               WHERE ps2.user_id = ps.user_id
                 AND ps2.origin = ps.origin
                 AND COALESCE(ps2.user_agent, '') = COALESCE(ps.user_agent, '')
               ORDER BY COALESCE(ps2.last_used_at, ps2.created_at) DESC,
                        ps2.id DESC
               LIMIT 1
             )`,
          userId, String(origin)
        );

        // Обратная совместимость: если у пользователя ещё нет подписок с
        // этим origin (юзер не перезаходил после деплоя origin-фикса),
        // используем NULL-origin подписки — по одной на устройство.
        if (!subs.length) {
          subs = await db.all(
            `SELECT id, endpoint, p256dh, auth
             FROM push_subscriptions ps
             WHERE ps.user_id = ?
               AND ps.origin IS NULL
               AND ps.id = (
                 SELECT ps2.id FROM push_subscriptions ps2
                 WHERE ps2.user_id = ps.user_id
                   AND ps2.origin IS NULL
                   AND COALESCE(ps2.user_agent, '') = COALESCE(ps.user_agent, '')
                 ORDER BY COALESCE(ps2.last_used_at, ps2.created_at) DESC,
                          ps2.id DESC
                 LIMIT 1
               )`,
            userId
          );
          if (subs.length) {
            console.log(
              `[Push] user=${userId}: подписок для origin=${origin} нет, шлю на legacy (origin IS NULL): ${subs.length}`
            );
          }
        }
      } else {
        // Системное событие (storeId=null): по одной подписке на устройство,
        // независимо от origin — какое бы устройство ни получило push,
        // баннер один. При этом origin может быть любым (берётся самый
        // свежий), на UX это не влияет — важно лишь «дойти до устройства».
        subs = await db.all(
          `SELECT id, endpoint, p256dh, auth
           FROM push_subscriptions ps
           WHERE ps.user_id = ?
             AND ps.id = (
               SELECT ps2.id FROM push_subscriptions ps2
               WHERE ps2.user_id = ps.user_id
                 AND COALESCE(ps2.user_agent, '') = COALESCE(ps.user_agent, '')
               ORDER BY COALESCE(ps2.last_used_at, ps2.created_at) DESC,
                        ps2.id DESC
               LIMIT 1
             )`,
          userId
        );
      }
      if (!subs.length) return result;

      const data = JSON.stringify(payload || {});
      const now = Date.now();
      const expired = [];
      const vapidDetails = getVapidDetails(storeId);

      for (const sub of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            data,
            { TTL: PUSH_TTL_SEC, vapidDetails }
          );
          result.sent++;
          // Отметка «живости» подписки: по ней pruneStale чистит мёртвые
          await db.run(
            'UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?',
            now,
            sub.id
          );
          // Небольшая пауза между отправками: FCM чувствителен к всплескам.
          // 50 мс на 10 подписок = 0.5 сек — незаметно для UX, но резко снижает 429.
          if (subs.length > 1) {
            await new Promise((r) => setTimeout(r, 50));
          }
        } catch (err) {
          const code = err?.statusCode ?? '?';
          if (isGone(err)) {
            expired.push(sub.id);
            console.warn(`[Push] Подписка #${sub.id} удалена (status=${code})`);
          } else if (code === 429) {
            // Rate limit push-сервиса: не долбим дальше, не считаем провалом,
            // не удаляем подписку. Уведомление на этом endpoint уйдёт в следующий раз.
            result.failed++;
            console.warn(
              `[Push] #${sub.id} (user=${userId}, store=${storeId ?? '—'}) — 429 rate limit, пропускаю`
            );
          } else {
            result.failed++;
            console.error(
              `[Push] Ошибка доставки #${sub.id} (status=${code}, store=${storeId ?? '—'}):`,
              err.message
            );
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
      const db = getUsersDB();
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
      const db = getUsersDB();
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