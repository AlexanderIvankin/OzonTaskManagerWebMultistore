/**
 * Smoke-тест связки Socket.IO + Web Push.
 * Запуск: node tests/smoke-push.js из папки backend/.
 *
 * MULTISTORE: notifyUser/notifyStaff/isUserOnline/socket.notifyUser принимают
 * storeId первым аргументом. push-подписки по-прежнему глобальные (одно
 * устройство = одна подписка) — таблица в users.db без store_id.
 *
 * Проверяет:
 *   1) схему push_subscriptions (таблица + индекс idx_push_user);
 *   2) PushService: валидация, upsert по endpoint (смена владельца),
 *      отправка (успех / 410 Gone -> удаление / 500 -> подписка цела),
 *      pruneStale, отписка;
 *   3) socket.isUserOnline(storeId, userId) без Socket.IO -> false;
 *   4) маршрутизацию NotificationService.notifyUser: офлайн + storeId ->
 *      Web Push; офлайн без storeId -> молча ничего; persist: false не пушится.
 *
 * Сеть НЕ используется: webpush.sendNotification подменяется заглушкой.
 */
require('dotenv').config();
const { setup, cleanup } = require('./helpers/setupTestEnv');
const env = setup('1');
const STORE_ID = env.storeId;

const webpush = require('web-push');
const { initDB, closeAll, getUsersDB } = require('../src/config/database');
const {
  initNotificationsDB,
  getNotificationsDB,
  closeNotificationsDB,
} = require('../src/config/notificationsDatabase');
const PushService = require('../src/services/PushService');
const NotificationService = require('../src/services/NotificationService');
const User = require('../src/models/User');
const { isUserOnline, notifyUser: socketNotifyUser } = require('../src/socket');

const ENDPOINT_A = 'https://example.invalid/smoke-push-a';
const ENDPOINT_B = 'https://example.invalid/smoke-push-b';

function assert(condition, message) {
  if (!condition) throw new Error(`ПРОВАЛ: ${message}`);
  console.log(`✅ ${message}`);
}

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
  let u1 = null;
  let u2 = null;

  try {
    console.log('=== Smoke-тест Web Push (Socket.IO + Push) ===');
    await initDB();
    await initNotificationsDB();
    const db = getUsersDB();

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

    // --- Тестовые пользователи ---
    const ts = Date.now();
    u1 = await User.create({
      username: `smoke_push_u1_${ts}`,
      email: `smoke_push_u1_${ts}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokePushПервый',
      role: 'user',
    });
    u2 = await User.create({
      username: `smoke_push_u2_${ts}`,
      email: `smoke_push_u2_${ts}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokePushВторой',
      role: 'user',
    });
    testUserId = u1.id;
    const secondUserId = u2.id;

    await db.run(
      'DELETE FROM push_subscriptions WHERE endpoint IN (?, ?)',
      ENDPOINT_A, ENDPOINT_B
    );

    // --- 1. Валидация подписки ---
    assert(PushService.isValidSubscription(fakeSubscription(ENDPOINT_A)), 'Валидная подписка принята');
    assert(!PushService.isValidSubscription(null), 'null отклонён');
    assert(
      !PushService.isValidSubscription({ endpoint: '', keys: { p256dh: 'a', auth: 'b' } }),
      'Пустой endpoint отклонён'
    );
    assert(
      !PushService.isValidSubscription({ endpoint: 'https://x', keys: { p256dh: 'a' } }),
      'Подписка без auth отклонена'
    );

    // --- 2. Upsert по endpoint: смена владельца ---
    await PushService.subscribe(testUserId, fakeSubscription(ENDPOINT_A), 'smoke-agent');
    assert((await PushService.countForUser(testUserId)) === 1, 'Подписка сохранена (1 устройство)');
    await PushService.subscribe(secondUserId, fakeSubscription(ENDPOINT_A), 'smoke-agent');
    const row = await db.get('SELECT user_id FROM push_subscriptions WHERE endpoint = ?', ENDPOINT_A);
    assert(row && row.user_id === secondUserId, 'Повторный вход переприсвоил подписку');
    await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', ENDPOINT_A);

    // --- 3. 410 Gone -> подписка удаляется ---
    await PushService.subscribe(testUserId, fakeSubscription(ENDPOINT_A), 'smoke-agent');
    webpush.sendNotification = async () => {
      const err = new Error('Gone');
      err.statusCode = 410;
      throw err;
    };
    let result = await PushService.sendToUser(testUserId, { title: 't', body: 'b' });
    assert(result.sent === 0 && result.removed >= 1, `410 Gone -> подписка удалена (removed=${result.removed})`);
    assert((await PushService.countForUser(testUserId)) === 0, 'После 410 подписок нет');

    // --- 4. 500 -> ошибка без удаления ---
    await PushService.subscribe(testUserId, fakeSubscription(ENDPOINT_B), 'smoke-agent');
    webpush.sendNotification = async () => {
      const err = new Error('Server error');
      err.statusCode = 500;
      throw err;
    };
    result = await PushService.sendToUser(testUserId, { title: 't', body: 'b' });
    assert(result.failed === 1 && result.removed === 0, `500 -> ошибка без удаления (failed=${result.failed})`);
    assert((await PushService.countForUser(testUserId)) === 1, 'Подписка сохранена после 500');

    // --- 5. Успех + TTL + last_used_at ---
    let sentPayload = null;
    webpush.sendNotification = async (subscription, data, options) => {
      sentPayload = { subscription, data: JSON.parse(data), options };
    };
    result = await PushService.sendToUser(testUserId, { title: 's', body: 'ok' });
    assert(result.sent === 1, `Успешная доставка (sent=${result.sent})`);
    assert(sentPayload?.options?.TTL === PushService.ttlSec, `TTL = ${PushService.ttlSec} c (24 часа)`);
    const used = await db.get('SELECT last_used_at FROM push_subscriptions WHERE endpoint = ?', ENDPOINT_B);
    assert(Boolean(used?.last_used_at) && used.last_used_at >= startedAt, 'last_used_at обновлён');

    // --- 6. pruneStale ---
    const staleAt = startedAt - 400 * 24 * 60 * 60 * 1000;
    await db.run(
      'UPDATE push_subscriptions SET created_at = ?, last_used_at = ? WHERE endpoint = ?',
      staleAt, staleAt, ENDPOINT_B
    );
    const pruned = await PushService.pruneStale(180);
    assert(pruned >= 1, `pruneStale удалил залежавшуюся подписку (${pruned})`);

    // --- 7. Онлайн-детект без Socket.IO ---
    assert(isUserOnline(STORE_ID, testUserId) === false, 'isUserOnline(storeId, userId) без Socket.IO = false');
    assert(
      socketNotifyUser(STORE_ID, testUserId, 'notification_new', {}) === false,
      'socket.notifyUser(storeId, ...) без Socket.IO возвращает false'
    );

    // --- 8. Офлайн + storeId -> Web Push ---
    await PushService.subscribe(testUserId, fakeSubscription(ENDPOINT_B), 'smoke-agent');
    const pushCalls = [];
    webpush.sendNotification = async (_sub, data) => { pushCalls.push(JSON.parse(data)); };
    await NotificationService.notifyUser(
      testUserId,
      'order_assigned',
      {
        orderId: 'PUSH-SMOKE-1',
        userName: 'SmokeTest',
        details: { products: [{ offer_id: 'ARD000001', quantity: 1 }] },
      },
      { storeId: STORE_ID }
    );
    assert(pushCalls.length === 1, `Офлайн + storeId: push ушёл (попыток: ${pushCalls.length})`);
    assert(
      pushCalls[0]?.body?.includes('PUSH-SMOKE-1') && pushCalls[0]?.url === '/notifications',
      'Push-payload содержит номер заказа и url /notifications'
    );
    assert(pushCalls[0]?.storeId === STORE_ID, 'Push-payload содержит storeId');

    // --- 9. Офлайн БЕЗ storeId -> ни сокета, ни push (только БД) ---
    const pushCallsBeforeNoStore = pushCalls.length;
    await NotificationService.notifyUser(
      testUserId,
      'order_assigned',
      { orderId: 'PUSH-NO-STORE', userName: 'SmokeTest' }
      // storeId не передан
    );
    assert(
      pushCalls.length === pushCallsBeforeNoStore,
      'Офлайн без storeId: push НЕ уходит (событие не адресуемо)'
    );

    // --- 10. persist: false не пушится ---
    const pushCallsBefore = pushCalls.length;
    await NotificationService.notifyUser(
      testUserId,
      'command_cooldown',
      { command: 'Smoke-команда', retryAfterSec: 5 },
      { storeId: STORE_ID, persist: false }
    );
    assert(
      pushCalls.length === pushCallsBefore,
      'Транзиентное (persist: false) в Web Push не уходит'
    );

    // --- 11. Отписка устройства ---
    const removed = await PushService.unsubscribe(testUserId, ENDPOINT_B);
    assert(removed === 1, 'unsubscribe удалил подписку устройства');

    console.log('=== Smoke-тест пройден ✅ ===');
  } catch (err) {
    console.error('❌', err.message);
    process.exitCode = 1;
  } finally {
    webpush.sendNotification = originalSendNotification;
    try {
      const db = getUsersDB();
      await db.run('DELETE FROM push_subscriptions WHERE endpoint IN (?, ?)', ENDPOINT_A, ENDPOINT_B);
      if (testUserId != null) {
        await getNotificationsDB().run(
          'DELETE FROM notifications WHERE recipient_id = ? AND created_at >= ?',
          testUserId, startedAt
        );
        const ids = [u1?.id, u2?.id].filter(Boolean);
        if (ids.length) {
          await db.run(
            `DELETE FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
            ...ids
          ).catch(() => { });
        }
      }
    } catch (cleanupErr) {
      console.warn('⚠️ Очистка тестовых данных:', cleanupErr.message);
    }
    try { await closeNotificationsDB(); } catch { /* ignore */ }
    try { await closeAll(); } catch { /* ignore */ }
    cleanup();
  }
})();