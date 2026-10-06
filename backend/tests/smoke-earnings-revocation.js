/**
 * Smoke-тест идемпотентного сторнирования заработка
 * (запуск: node tests/smoke-earnings-revocation.js из папки backend/).
 *
 * Главная проверка — по одному заказу НИКОГДА не может произойти двух списаний:
 *   A) прямой КОНКУРЕНТНЫЙ вызов EarningsService.revokeOrderEarnings x2;
 *   B) планировщик отменённых заказов, запущенный ДВАЖДЫ;
 *   C) кросс-планировщик: заказ уже сторнирован сверкой отмены, затем его же
 *      пытается обнулить планировщик awaiting_deliver.
 */
process.env.OZON_MOCK_MODE = 'true';
require('dotenv').config();

const { initDB, getDB } = require('../src/config/database');
const { initNotificationsDB, getNotificationsDB } = require('../src/config/notificationsDatabase');
const { User, Assignment } = require('../src/models');
const Notification = require('../src/models/Notification');
const OzonService = require('../src/services/OzonService');
const EarningsService = require('../src/services/EarningsService');
const scheduler = require('../src/scheduler');

const MARK = 'smokeRevoke';
const stamp = Date.now();
const ORDER_A = `${MARK}-A_${stamp}`;
const ORDER_B = `${MARK}-B_${stamp}`;
const ORDER_C = `${MARK}-C_${stamp}`;
const DAY = 24 * 60 * 60 * 1000;

(async () => {
  const users = { a: null, b: null, c: null, mod: null };
  let db;
  let ndb;

  const originalFetchCancelled = OzonService.fetchCancelledOrders;
  const originalFetchDeliver = OzonService.fetchAwaitingDeliverOrders;
  const originalGetDetails = OzonService.getOrderDetails;

  // По умолчанию отменённых нет и список awaiting_deliver пуст.
  OzonService.fetchCancelledOrders = async () => [];
  OzonService.fetchAwaitingDeliverOrders = async () => [];
  OzonService.getOrderDetails = async () => null;

  async function seedCompleted(orderId, amount, ageMs, userId) {
    const t = Date.now() - ageMs;
    await db.run(
      `INSERT INTO assignments (order_id, user_id, assigned_at, completed_at, status)
       VALUES (?, ?, ?, ?, 'completed')`,
      orderId, userId, t, t
    );
    await db.run(
      'INSERT INTO earnings_history (user_id, order_id, amount, calculated_at) VALUES (?, ?, ?, ?)',
      userId, orderId, amount, t
    );
    await db.run(
      'INSERT INTO earnings_active (user_id, order_id, amount, calculated_at) VALUES (?, ?, ?, ?)',
      userId, orderId, amount, t
    );
  }

  // Сумма корректировок пользователя (таблицы без order_id -> считаем по user).
  async function adjSum(userId, table) {
    const row = await db.get(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM ${table} WHERE user_id = ?`, userId
    );
    return row ? row.s : 0;
  }

  async function countUserNotifs(userId, type) {
    const res = await Notification.getByRecipient(userId, { audience: 'user', limit: 50 });
    return res.items.filter((n) => n.type === type).length;
  }

  async function markerOf(orderId) {
    const row = await db.get('SELECT earnings_revoked_at FROM assignments WHERE order_id = ?', orderId);
    return row ? row.earnings_revoked_at : null;
  }

  try {
    console.log('=== Smoke-тест идемпотентного сторнирования заработка ===');
    await initDB();
    await initNotificationsDB();
    db = getDB();
    ndb = getNotificationsDB();

    for (const key of ['a', 'b', 'c']) {
      users[key] = await User.create({
        username: `${MARK}_${key}_${stamp}`,
        email: `${MARK}_${key}_${stamp}@smoke.local`,
        passwordHash: 'x',
        name: `SmokeRevoke-${key}`,
        role: 'user',
      });
    }
    users.mod = await User.create({
      username: `${MARK}_mod_${stamp}`,
      email: `${MARK}_mod_${stamp}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeRevokeМодератор',
      role: 'moderator',
    });
    console.log(`Созданы пользователи A=#${users.a.id}, B=#${users.b.id}, C=#${users.c.id}, mod=#${users.mod.id}`);
    // === Случай A: КОНКУРЕНТНЫЙ вызов revokeOrderEarnings (x2) ===
    await seedCompleted(ORDER_A, 200, DAY, users.a.id);
    const [ra, rb] = await Promise.all([
      EarningsService.revokeOrderEarnings(users.a.id, ORDER_A, {
        reason: 'test-A', notificationType: 'deliver_earnings_revoked', userName: 'A', source: 'test',
      }),
      EarningsService.revokeOrderEarnings(users.a.id, ORDER_A, {
        reason: 'test-A', notificationType: 'deliver_earnings_revoked', userName: 'A', source: 'test',
      }),
    ]);
    const revokedA = [ra, rb].filter((r) => r.revoked).length;
    const adjHistA = await adjSum(users.a.id, 'earnings_adjustments');
    const adjActA = await adjSum(users.a.id, 'earnings_adjustments_active');
    const notifA = await countUserNotifs(users.a.id, 'deliver_earnings_revoked');
    console.log(`A) успешных вызовов=${revokedA}/2, история=${adjHistA}, актив=${adjActA}, оповещений=${notifA}, замок=${await markerOf(ORDER_A)}`);
    if (revokedA !== 1) throw new Error(`A: списаний=${revokedA}, ожидалось ровно 1`);
    if (adjHistA !== -200 || adjActA !== -200) throw new Error(`A: суммы=${adjHistA}/${adjActA}, ожидалось -200/-200`);
    if (notifA !== 1) throw new Error(`A: оповещений=${notifA}, ожидалось 1`);
    if (!(await markerOf(ORDER_A))) throw new Error('A: замок не выставлен');

    // === Случай B: планировщик отменённых заказов, запущенный ДВАЖДЫ ===
    await seedCompleted(ORDER_B, 300, DAY, users.b.id);
    OzonService.fetchCancelledOrders = async () => [{ posting_number: ORDER_B }];
    const b1 = await scheduler.runCancelledOrdersEarningsRevocation({ windowHours: 48 });
    const b2 = await scheduler.runCancelledOrdersEarningsRevocation({ windowHours: 48 });
    const adjHistB = await adjSum(users.b.id, 'earnings_adjustments');
    const notifB = await countUserNotifs(users.b.id, 'order_cancelled_earnings_revoked');
    console.log(`B) revoked: ${b1.revoked}/${b2.revoked}, история=${adjHistB}, оповещений=${notifB}, замок=${await markerOf(ORDER_B)}`);
    if (b1.revoked !== 1 || b2.revoked !== 0) throw new Error(`B: revoked=${b1.revoked}/${b2.revoked}, ожидалось 1/0`);
    if (adjHistB !== -300) throw new Error(`B: история=${adjHistB}, ожидалось -300`);
    if (notifB !== 1) throw new Error(`B: оповещений=${notifB}, ожидалось 1`);

    // === Случай C: кросс-планировщик (сначала отмена, затем awaiting_deliver) ===
    await seedCompleted(ORDER_C, 100, 4 * DAY, users.c.id);
    OzonService.fetchCancelledOrders = async () => [{ posting_number: ORDER_C }];
    const c1 = await scheduler.runCancelledOrdersEarningsRevocation({ windowHours: 48 });
    // Теперь тот же заказ «завис» в awaiting_deliver и по возрасту подлежит обнулению,
    // но заработок уже сторнирован -> повторного списания быть не должно.
    OzonService.fetchAwaitingDeliverOrders = async () => [{ posting_number: ORDER_C }];
    const c2 = await scheduler.runAwaitingDeliverReminder(24, { warnDays: 2, revokeDays: 3 });
    const adjHistC = await adjSum(users.c.id, 'earnings_adjustments');
    console.log(`C) revoked: ${c1.revoked}/${c2.revoked}, история=${adjHistC}, замок=${await markerOf(ORDER_C)}`);
    if (c1.revoked !== 1 || c2.revoked !== 0) throw new Error(`C: revoked=${c1.revoked}/${c2.revoked}, ожидалось 1/0`);
    if (adjHistC !== -100) throw new Error(`C: история=${adjHistC}, ожидалось -100`);

    // === Случай D: повторное назначение заказа НЕ сбрасывает замок ===
    // (иначе INSERT OR REPLACE открыл бы путь ко второму списанию)
    const markerBefore = await markerOf(ORDER_A);
    await Assignment.assign(ORDER_A, users.a.id); // повторное назначение
    const markerAfter = await markerOf(ORDER_A);
    console.log(`D) замок до=${markerBefore}, после повторного назначения=${markerAfter}`);
    if (!markerAfter || markerAfter !== markerBefore) {
      throw new Error('D: повторное назначение сбросило замок отмены заработка!');
    }

    console.log('=== Smoke-тест пройден ✅ ===');
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    OzonService.fetchCancelledOrders = originalFetchCancelled;
    OzonService.fetchAwaitingDeliverOrders = originalFetchDeliver;
    OzonService.getOrderDetails = originalGetDetails;
    try {
      await ndb.run(`DELETE FROM notifications WHERE payload LIKE '%${MARK}%'`);
      for (const orderId of [ORDER_A, ORDER_B, ORDER_C]) {
        await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);
        await db.run('DELETE FROM earnings_history WHERE order_id = ?', orderId);
        await db.run('DELETE FROM earnings_active WHERE order_id = ?', orderId);
      }
      for (const key of ['a', 'b', 'c']) {
        const u = users[key];
        if (!u) continue;
        await db.run('DELETE FROM earnings_adjustments WHERE user_id = ?', u.id);
        await db.run('DELETE FROM earnings_adjustments_active WHERE user_id = ?', u.id);
        await db.run('DELETE FROM users WHERE id = ?', u.id);
      }
      if (users.mod) await db.run('DELETE FROM users WHERE id = ?', users.mod.id);
      console.log('Тестовые данные удалены');
    } catch (cleanupErr) {
      console.error('Ошибка очистки:', cleanupErr.message);
    }
  }
})();
