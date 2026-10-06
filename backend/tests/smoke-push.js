/**
 * Smoke-тест связки Socket.IO + Web Push.
 * Запуск из папки backend/: node tests/smoke-push.js
 *
 * Проверяет:
 *   1) схему push_subscriptions (таблица + индекс idx_push_user);
 *   2) PushService: валидация подписки, upsert по endpoint (смена владельца),
 *      отправка (успех / 410 Gone -> удаление / 500 -> подписка цела),
 *      pruneStale (чистка залежавшихся подписок), отписка;
 *   3) socket.isUserOnline() при неинициализированном Socket.IO -> false;
 *   4) маршрутизацию NotificationService.notifyUser: пользователь ОФЛАЙН ->
 *      оповещение уходит в PushService (а не в сокет), а транзиентные
 *      (persist: false) не пушатся вообще.
 *
 * Сеть НЕ используется: webpush.sendNotification подменяется заглушкой.
 * Все созданные записи удаляются в конце.
 */
require('dotenv').config();

const webpush = require('web-push');
const { initDB, getDB } = require('../src/config/database');
const {
  initNotificationsDB,
  getNotificationsDB,
} = require('../src/config/notificationsDatabase');
const PushService = require('../src/services/PushService');
const NotificationService = require('../src/services/NotificationService');
const { isUserOnline, notifyUser: socketNotifyUser } = require('../src/socket');

const ENDPOINT_A = 'https://example.invalid/smoke-push-a';
const ENDPOINT_B = 'https://example.invalid/smoke-push-b';

function assert(condition, message) {
  if (!condition) throw new Error(`ПРОВАЛ: ${message}`);
  console.log(`✅ ${message}`);
}

/** Подписка, как её отдаёт PushSubscription.toJSON() в браузере. */
function fakeSubscription(endpoint) {
  return {
    endpoint,
    keys: { p256dh: 'BSmokeTestP256dhKey', auth: 'SmokeTestAuthSecret' },
  };
}

(async () => {
  const originalSendNotification = webpush.sendNotification;
  const startedAt = Date.now();
  let testUserId = null;

  try {
    console.log('=== Smoke-тест Web Push (Socket.IO + Push) ===');
    await initDB();
    await initNotificationsDB();
    const db = getDB();

    assert(PushService.enabled, 'Web Push настроен (VAPID_* из .env)');

    // --- 0. Схема ---
    const table = await db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'push_subscriptions'"
    );
    assert(Boolean(table), 'Таблица push_subscriptions создана');
    const index = await db.get(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_push_user'"
    );
    assert(Boolean(index), 'Индекс idx_push_user создан');

    const users = await db.all('SELECT id FROM users ORDER BY id LIMIT 2');
    if (!users.length) {
      console.log('⚠️ В БД нет пользователей — проверки PushService пропущены');
      return;
    }
    testUserId = users[0].id;
    const secondUserId = (users[1] || users[0]).id;

    await db.run(
      'DELETE FROM push_subscriptions WHERE endpoint IN (?, ?)',
      ENDPOINT_A,
      ENDPOINT_B
    );

    // --- 1. Валидация подписки ---
    assert(
      PushService.isValidSubscription(fakeSubscription(ENDPOINT_A)),
      'Валидная подписка принята'
    );
    assert(!PushService.isValidSubscription(null), 'null отклонён');
    assert(
      !PushService.isValidSubscription({
        endpoint: '',
        keys: { p256dh: 'a', auth: 'b' },
      }),
      'Пустой endpoint отклонён'
    );
    assert(
      !PushService.isValidSubscription({
        endpoint: 'https://x',
        keys: { p256dh: 'a' },
      }),
      'Подписка без auth отклонена'
    );

    // --- 2. Upsert по endpoint: тот же браузер, другой пользователь ---
    await PushService.subscribe(testUserId, fakeSubscription(ENDPOINT_A), 'smoke-agent');
    assert(
      (await PushService.countForUser(testUserId)) === 1,
      'Подписка сохранена (1 устройство)'
    );
    await PushService.subscribe(secondUserId, fakeSubscription(ENDPOINT_A), 'smoke-agent');
    const row = await db.get(
      'SELECT user_id FROM push_subscriptions WHERE endpoint = ?',
      ENDPOINT_A
    );
    assert(
      row && row.user_id === secondUserId,
      'Повторный вход на устройстве переприсвоил подписку новому пользователю'
    );
    await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', ENDPOINT_A);

    // --- 3. Отправка: 410 Gone -> подписка удаляется ---
    await PushService.subscribe(testUserId, fakeSubscription(ENDPOINT_A), 'smoke-agent');
    webpush.sendNotification = async () => {
      const err = new Error('Gone');
      err.statusCode = 410;
      throw err;
    };
    let result = await PushService.sendToUser(testUserId, { title: 't', body: 'b' });
    assert(
      result.sent === 0 && result.removed >= 1,
      `410 Gone -> подписка удалена (removed=${result.removed})`
    );
    assert(
      (await PushService.countForUser(testUserId)) === 0,
      'После 410 подписок у пользователя нет'
    );

    // --- 4. Отправка: 500 -> ошибка посчитана, подписка остаётся ---
    await PushService.subscribe(testUserId, fakeSubscription(ENDPOINT_B), 'smoke-agent');
    webpush.sendNotification = async () => {
      const err = new Error('Server error');
      err.statusCode = 500;
      throw err;
    };
    result = await PushService.sendToUser(testUserId, { title: 't', body: 'b' });
    assert(
      result.failed === 1 && result.removed === 0,
      `500 -> ошибка доставки без удаления (failed=${result.failed})`
    );
    assert(
      (await PushService.countForUser(testUserId)) === 1,
      'Подписка сохранена после 500'
    );

    // --- 5. Отправка: успех (проверяем TTL и обновление last_used_at) ---
    let sentPayload = null;
    webpush.sendNotification = async (subscription, data, options) => {
      sentPayload = { subscription, data: JSON.parse(data), options };
    };
    result = await PushService.sendToUser(testUserId, { title: 's', body: 'ok' });
    assert(result.sent === 1, `Успешная доставка посчитана (sent=${result.sent})`);
    assert(
      sentPayload?.options?.TTL === PushService.ttlSec,
      `TTL push-сообщения = ${PushService.ttlSec} c (24 часа)`
    );
    const used = await db.get(
      'SELECT last_used_at FROM push_subscriptions WHERE endpoint = ?',
      ENDPOINT_B
    );
    assert(
      Boolean(used?.last_used_at) && used.last_used_at >= startedAt,
      'last_used_at обновлён после успешной доставки'
    );

    // --- 6. pruneStale: залежавшаяся подписка вычищается ---
    const staleAt = startedAt - 400 * 24 * 60 * 60 * 1000;
    await db.run(
      'UPDATE push_subscriptions SET created_at = ?, last_used_at = ? WHERE endpoint = ?',
      staleAt,
      staleAt,
      ENDPOINT_B
    );
    const pruned = await PushService.pruneStale(180);
    assert(pruned >= 1, `pruneStale удалил залежавшуюся подписку (${pruned})`);

    // --- 7. Онлайн-детект без Socket.IO ---
    assert(isUserOnline(testUserId) === false, 'isUserOnline без Socket.IO = false');
    assert(
      socketNotifyUser(testUserId, 'notification_new', {}) === false,
      'notifyUser без Socket.IO возвращает false (событие не доставлено)'
    );

    // --- 8. Маршрутизация: пользователь офлайн -> Web Push ---
    await PushService.subscribe(testUserId, fakeSubscription(ENDPOINT_B), 'smoke-agent');
    const pushCalls = [];
    webpush.sendNotification = async (_subscription, data) => {
      pushCalls.push(JSON.parse(data));
    };
    await NotificationService.notifyUser(testUserId, 'order_assigned', {
      orderId: 'PUSH-SMOKE-1',
      userName: 'SmokeTest',
      details: { products: [{ offer_id: 'ARD000001', quantity: 1 }] },
    });
    assert(
      pushCalls.length === 1,
      `Офлайн: оповещение ушло Web Push (попыток: ${pushCalls.length})`
    );
    assert(
      pushCalls[0]?.body?.includes('PUSH-SMOKE-1') &&
        pushCalls[0]?.url === '/notifications',
      'Push-payload содержит номер заказа и url /notifications'
    );

    // --- 9. Транзиентные оповещения (persist: false) не пушатся ---
    const pushCallsBefore = pushCalls.length;
    await NotificationService.notifyUser(
      testUserId,
      'command_cooldown',
      { command: 'Smoke-команда', retryAfterSec: 5 },
      { persist: false }
    );
    assert(
      pushCalls.length === pushCallsBefore,
      'Транзиентное оповещение (persist: false) в Web Push не уходит'
    );

    // --- 10. Отписка устройства ---
    const removed = await PushService.unsubscribe(testUserId, ENDPOINT_B);
    assert(removed === 1, 'unsubscribe удалил подписку устройства');

    console.log('=== Smoke-тест пройден ✅ ===');
  } catch (err) {
    console.error('❌', err.message);
    process.exitCode = 1;
  } finally {
    // Возвращаем настоящую отправку и убираем тестовые данные
    webpush.sendNotification = originalSendNotification;
    try {
      const db = getDB();
      await db.run(
        'DELETE FROM push_subscriptions WHERE endpoint IN (?, ?)',
        ENDPOINT_A,
        ENDPOINT_B
      );
      if (testUserId != null) {
        await getNotificationsDB().run(
          'DELETE FROM notifications WHERE recipient_id = ? AND created_at >= ?',
          testUserId,
          startedAt
        );
      }
    } catch (cleanupErr) {
      console.warn('⚠️ Очистка тестовых данных:', cleanupErr.message);
    }
  }
})();
