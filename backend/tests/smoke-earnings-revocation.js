/**
 * Smoke-тест идемпотентного сторнирования заработка.
 * Запуск: node tests/smoke-earnings-revocation.js из папки backend/.
 *
 * MULTISTORE: revokeOrderEarnings(storeId, userId, orderId, opts).
 * Проверяет:
 *   A) конкурентный x2 → одно списание;
 *   B) scheduler.runCancelledOrdersEarningsRevocation(storeId) дважды → 1/0;
 *   C) кросс-планировщик (cancelled → awaiting_deliver) → одно списание;
 *   D) повторное назначение не сбрасывает замок.
 */
const { setup, cleanup } = require('./helpers/setupTestEnv');
const STORE_ID = setup('1').storeId;

const { initDB, closeAll, getUsersDB, getStoreDB } = require('../src/config/database');
const { initNotificationsDB, closeNotificationsDB } = require('../src/config/notificationsDatabase');
const { User } = require('../src/models');
const UserStore = require('../src/models/UserStore');
const OzonService = require('../src/services/OzonService');
const EarningsService = require('../src/services/EarningsService');
const Assignment = require('../src/models/Assignment');
const scheduler = require('../src/scheduler');

const MARK = 'smokeRevoke';
const stamp = Date.now();
const ORDER_A = `${MARK}-A_${stamp}`;
const ORDER_B = `${MARK}-B_${stamp}`;
const ORDER_C = `${MARK}-C_${stamp}`;
const DAY = 24 * 60 * 60 * 1000;

(async () => {
  const users = { a: null, b: null, c: null };
  const origFetchCancelled = OzonService.fetchCancelledOrders;
  const origFetchDeliver = OzonService.fetchAwaitingDeliverOrders;
  OzonService.fetchCancelledOrders = async () => [];
  OzonService.fetchAwaitingDeliverOrders = async () => [];

  try {
    console.log('=== Smoke-тест идемпотентного сторнирования ===');
    await initDB();
    await initNotificationsDB();
    const db = getUsersDB();
    const storeDb = getStoreDB(STORE_ID);

    for (const key of ['a', 'b', 'c']) {
      const u = await User.create({
        username: `${MARK}_${key}_${stamp}`,
        email: `${MARK}_${key}_${stamp}@smoke.local`,
        passwordHash: 'x', name: `SmokeRevoke-${key}`, role: 'user',
      });
      users[key] = u;
      await UserStore.upsert(u.id, STORE_ID, { role: 'employee', was_employee: 1 });
    }
    console.log(`Созданы: A=#${users.a.id}, B=#${users.b.id}, C=#${users.c.id}`);

    async function seedCompleted(orderId, amount, ageMs, userId) {
      const t = Date.now() - ageMs;
      await storeDb.run(
        `INSERT INTO assignments (order_id, user_id, assigned_at, completed_at, status)
         VALUES (?, ?, ?, ?, 'completed')`,
        orderId, userId, t, t
      );
      await storeDb.run(
        'INSERT INTO earnings_history (user_id, order_id, amount, calculated_at) VALUES (?, ?, ?, ?)',
        userId, orderId, amount, t
      );
      await storeDb.run(
        'INSERT INTO earnings_active (user_id, order_id, amount, calculated_at) VALUES (?, ?, ?, ?)',
        userId, orderId, amount, t
      );
    }

    async function adjSum(userId, table) {
      const r = await storeDb.get(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM ${table} WHERE user_id = ?`, userId
      );
      return r ? r.s : 0;
    }
    async function markerOf(orderId) {
      const r = await storeDb.get('SELECT earnings_revoked_at FROM assignments WHERE order_id = ?', orderId);
      return r ? r.earnings_revoked_at : null;
    }

    // A. Конкурентный
    await seedCompleted(ORDER_A, 200, DAY, users.a.id);
    const [ra, rb] = await Promise.all([
      EarningsService.revokeOrderEarnings(STORE_ID, users.a.id, ORDER_A, {
        reason: 'test-A', notificationType: 'deliver_earnings_revoked', userName: 'A', source: 'test',
      }),
      EarningsService.revokeOrderEarnings(STORE_ID, users.a.id, ORDER_A, {
        reason: 'test-A', notificationType: 'deliver_earnings_revoked', userName: 'A', source: 'test',
      }),
    ]);
    const revokedA = [ra, rb].filter((r) => r.revoked).length;
    const adjA = await adjSum(users.a.id, 'earnings_adjustments');
    console.log(`A) успешных=${revokedA}/2, adj=${adjA}, lock=${await markerOf(ORDER_A)}`);
    if (revokedA !== 1) throw new Error(`A: ${revokedA} списаний`);
    if (adjA !== -200) throw new Error(`A: adj=${adjA}`);

    // B. Планировщик дважды
    await seedCompleted(ORDER_B, 300, DAY, users.b.id);
    OzonService.fetchCancelledOrders = async (storeId) => {
      if (storeId !== STORE_ID) throw new Error('storeId не проброшен');
      return [{ posting_number: ORDER_B }];
    };
    const b1 = await scheduler.runCancelledOrdersEarningsRevocation(STORE_ID, { windowHours: 48 });
    const b2 = await scheduler.runCancelledOrdersEarningsRevocation(STORE_ID, { windowHours: 48 });
    const adjB = await adjSum(users.b.id, 'earnings_adjustments');
    console.log(`B) revoked=${b1.revoked}/${b2.revoked}, adj=${adjB}`);
    if (b1.revoked !== 1 || b2.revoked !== 0) throw new Error(`B: ${b1.revoked}/${b2.revoked}`);
    if (adjB !== -300) throw new Error(`B: adj=${adjB}`);

    // C. Кросс-планировщик
    await seedCompleted(ORDER_C, 100, 4 * DAY, users.c.id);
    OzonService.fetchCancelledOrders = async () => [{ posting_number: ORDER_C }];
    const c1 = await scheduler.runCancelledOrdersEarningsRevocation(STORE_ID, { windowHours: 48 });
    OzonService.fetchAwaitingDeliverOrders = async () => [{ posting_number: ORDER_C }];
    const c2 = await scheduler.runAwaitingDeliverReminder(STORE_ID, 24, { warnDays: 2, revokeDays: 3 });
    const adjC = await adjSum(users.c.id, 'earnings_adjustments');
    console.log(`C) revoked=${c1.revoked}/${c2.revoked}, adj=${adjC}`);
    if (c1.revoked !== 1 || c2.revoked !== 0) throw new Error(`C: ${c1.revoked}/${c2.revoked}`);
    if (adjC !== -100) throw new Error(`C: adj=${adjC}`);

    // D. Повторное назначение не сбрасывает замок
    const markerBefore = await markerOf(ORDER_A);
    await Assignment.assign(STORE_ID, ORDER_A, users.a.id);
    const markerAfter = await markerOf(ORDER_A);
    console.log(`D) lock before=${markerBefore}, after=${markerAfter}`);
    if (!markerAfter || markerAfter !== markerBefore) {
      throw new Error('D: назначение сбросило замок');
    }

    console.log('=== Smoke-тест пройден ✅ ===');
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    OzonService.fetchCancelledOrders = origFetchCancelled;
    OzonService.fetchAwaitingDeliverOrders = origFetchDeliver;
    try {
      const db = getUsersDB();
      const storeDb = getStoreDB(STORE_ID);
      for (const orderId of [ORDER_A, ORDER_B, ORDER_C]) {
        await storeDb.run('DELETE FROM assignments WHERE order_id = ?', orderId);
        await storeDb.run('DELETE FROM earnings_history WHERE order_id = ?', orderId);
        await storeDb.run('DELETE FROM earnings_active WHERE order_id = ?', orderId);
      }
      for (const key of ['a', 'b', 'c']) {
        const u = users[key];
        if (!u) continue;
        await storeDb.run('DELETE FROM earnings_adjustments WHERE user_id = ?', u.id);
        await storeDb.run('DELETE FROM earnings_adjustments_active WHERE user_id = ?', u.id);
        await db.run('DELETE FROM user_stores WHERE user_id = ?', u.id);
        await db.run('DELETE FROM users WHERE id = ?', u.id);
      }
    } catch { /* ignore */ }
    try { await closeNotificationsDB(); } catch { /* ignore */ }
    try { await closeAll(); } catch { /* ignore */ }
    cleanup();
  }
})();