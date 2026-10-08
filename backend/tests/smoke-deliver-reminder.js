/**
 * Smoke-тест напоминаний и обнуления заработка awaiting_deliver.
 * Запуск: node tests/smoke-deliver-reminder.js из папки backend/.
 *
 * MULTISTORE: runAwaitingDeliverReminder(storeId, delayHours, opts).
 * Проверяет:
 *   1) 1 полный день → напоминание без предупреждения;
 *   2) 2 полных дня → с isFinalWarning;
 *   3) 3 полных дня → заработок обнулён (корректировки -amount);
 *   4) повторный прогон идемпотентен.
 */
const { setup, cleanup } = require('./helpers/setupTestEnv');
const STORE_ID = setup('1').storeId;

const { initDB, closeAll, getUsersDB, getStoreDB } = require('../src/config/database');
const { initNotificationsDB, closeNotificationsDB } = require('../src/config/notificationsDatabase');
const User = require('../src/models/User');
const UserStore = require('../src/models/UserStore');
const Notification = require('../src/models/Notification');
const OzonService = require('../src/services/OzonService');
const scheduler = require('../src/scheduler');

const TEST_MARK = 'smokeReminder';
const stamp = Date.now();
const TEST_ORDER = `${TEST_MARK}-1_${stamp}`;
const DAY = 24 * 60 * 60 * 1000;

(async () => {
  const emp = { id: null };
  const mod = { id: null };
  const origFetch = OzonService.fetchAwaitingDeliverOrders;
  OzonService.fetchAwaitingDeliverOrders = async () => [
    { posting_number: TEST_ORDER, products: [{ name: 'Тестовый товар', quantity: 1 }] },
  ];

  try {
    console.log('=== Smoke-тест напоминаний awaiting_deliver ===');
    await initDB();
    await initNotificationsDB();
    const db = getUsersDB();
    const storeDb = getStoreDB(STORE_ID);

    emp.id = (await User.create({
      username: `${TEST_MARK}_emp_${stamp}`, email: `${TEST_MARK}_emp_${stamp}@smoke.local`,
      passwordHash: 'x', name: 'SmokeReminderСотрудник', role: 'user',
    })).id;
    mod.id = (await User.create({
      username: `${TEST_MARK}_mod_${stamp}`, email: `${TEST_MARK}_mod_${stamp}@smoke.local`,
      passwordHash: 'x', name: 'SmokeReminderМодератор', role: 'user',
    })).id;
    await UserStore.upsert(emp.id, STORE_ID, { role: 'employee', was_employee: 1 });
    await UserStore.upsert(mod.id, STORE_ID, { role: 'moderator', was_employee: 1 });
    console.log(`Созданы: emp #${emp.id}, mod #${mod.id}`);

    // Завершено 1 день + 1 час назад
    const oneDayAgo = Date.now() - (DAY + 60 * 60 * 1000);
    await storeDb.run(
      `INSERT INTO assignments (order_id, user_id, assigned_at, completed_at, status)
       VALUES (?, ?, ?, ?, 'completed')`,
      TEST_ORDER, emp.id, oneDayAgo, oneDayAgo
    );
    await storeDb.run(
      `INSERT INTO earnings_history (user_id, order_id, amount, calculated_at) VALUES (?, ?, ?, ?)`,
      emp.id, TEST_ORDER, 150, oneDayAgo
    );
    await storeDb.run(
      `INSERT INTO earnings_active (user_id, order_id, amount, calculated_at) VALUES (?, ?, ?, ?)`,
      emp.id, TEST_ORDER, 150, oneDayAgo
    );

    const OPTS = { warnDays: 2, revokeDays: 3 };

    // Шаг 1
    const r1 = await scheduler.runAwaitingDeliverReminder(STORE_ID, 24, OPTS);
    const notif1 = (await Notification.getByRecipient(emp.id, {
      storeId: STORE_ID, audience: 'user', limit: 20,
    })).items.filter((n) => n.type === 'deliver_reminder');
    console.log(`Шаг 1: sent=${r1.sent}, notif=${notif1.length}, final=${notif1[0]?.payload?.isFinalWarning}`);
    if (r1.sent !== 1 || notif1.length !== 1) throw new Error('Шаг 1');
    if (notif1[0].payload.isFinalWarning) throw new Error('Шаг 1: не должно быть предупреждения');

    // Шаг 2
    const twoDaysAgo = Date.now() - (2 * DAY + 60 * 60 * 1000);
    await storeDb.run(
      'UPDATE assignments SET completed_at = ?, deliver_reminder_sent_at = NULL WHERE order_id = ?',
      twoDaysAgo, TEST_ORDER
    );
    const r2 = await scheduler.runAwaitingDeliverReminder(STORE_ID, 24, OPTS);
    const notif2 = (await Notification.getByRecipient(emp.id, {
      storeId: STORE_ID, audience: 'user', limit: 20,
    })).items.filter((n) => n.type === 'deliver_reminder');
    const warning = notif2.find((n) => n.payload?.isFinalWarning);
    console.log(`Шаг 2: sent=${r2.sent}, warning=${!!warning}`);
    if (r2.sent !== 1 || !warning) throw new Error('Шаг 2: ожидалось предупреждение');

    // Шаг 3
    const threeDaysAgo = Date.now() - (3 * DAY + 60 * 60 * 1000);
    await storeDb.run(
      'UPDATE assignments SET completed_at = ?, deliver_reminder_sent_at = NULL WHERE order_id = ?',
      threeDaysAgo, TEST_ORDER
    );
    const r3 = await scheduler.runAwaitingDeliverReminder(STORE_ID, 24, OPTS);
    const assignment = await storeDb.get('SELECT * FROM assignments WHERE order_id = ?', TEST_ORDER);
    const revokedNotif = (await Notification.getByRecipient(emp.id, {
      storeId: STORE_ID, audience: 'user', limit: 20,
    })).items.filter((n) => n.type === 'deliver_earnings_revoked');
    const adjH = await storeDb.get(
      'SELECT COALESCE(SUM(amount),0) AS s FROM earnings_adjustments WHERE user_id = ?', emp.id
    );
    const adjA = await storeDb.get(
      'SELECT COALESCE(SUM(amount),0) AS s FROM earnings_adjustments_active WHERE user_id = ?', emp.id
    );
    console.log(`Шаг 3: revoked=${r3.revoked}, lock=${assignment.earnings_revoked_at}, adjH=${adjH.s}, adjA=${adjA.s}, notif=${revokedNotif.length}`);
    if (r3.revoked !== 1) throw new Error('Шаг 3: не обнулён');
    if (!assignment.earnings_revoked_at) throw new Error('Шаг 3: замок');
    if (adjH.s !== -150 || adjA.s !== -150) throw new Error(`Шаг 3: суммы ${adjH.s}/${adjA.s}`);
    if (!revokedNotif.length) throw new Error('Шаг 3: оповещение');

    // Повтор
    const r4 = await scheduler.runAwaitingDeliverReminder(STORE_ID, 24, OPTS);
    const adjH2 = await storeDb.get(
      'SELECT COALESCE(SUM(amount),0) AS s FROM earnings_adjustments WHERE user_id = ?', emp.id
    );
    console.log(`Повтор: revoked=${r4.revoked}, adjH=${adjH2.s}`);
    if (r4.revoked !== 0) throw new Error('Повтор: снова обнулил');
    if (adjH2.s !== -150) throw new Error('Повтор: двойное списание');

    console.log('=== Smoke-тест пройден ✅ ===');
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    OzonService.fetchAwaitingDeliverOrders = origFetch;
    try {
      const db = getUsersDB();
      const storeDb = getStoreDB(STORE_ID);
      await storeDb.run('DELETE FROM assignments WHERE order_id = ?', TEST_ORDER);
      await storeDb.run('DELETE FROM earnings_history WHERE order_id = ?', TEST_ORDER);
      await storeDb.run('DELETE FROM earnings_active WHERE order_id = ?', TEST_ORDER);
      if (emp.id) {
        await storeDb.run('DELETE FROM earnings_adjustments WHERE user_id = ?', emp.id);
        await storeDb.run('DELETE FROM earnings_adjustments_active WHERE user_id = ?', emp.id);
      }
      for (const id of [emp.id, mod.id]) {
        if (!id) continue;
        await db.run('DELETE FROM user_stores WHERE user_id = ?', id);
        await db.run('DELETE FROM users WHERE id = ?', id);
      }
    } catch { /* ignore */ }
    try { await closeNotificationsDB(); } catch { /* ignore */ }
    try { await closeAll(); } catch { /* ignore */ }
    cleanup();
  }
})();