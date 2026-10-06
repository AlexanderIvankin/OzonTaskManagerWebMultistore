/**
 * Smoke-тест напоминаний и обнуления заработка awaiting_deliver
 * (запуск: node tests/smoke-deliver-reminder.js из папки backend/).
 *
 * Проверяет трёхшаговую логику планировщика:
 *   1) 1 полный день  -> напоминание №1 (без предупреждения);
 *   2) 2 полных дня   -> напоминание №2 с ПРЕДУПРЕЖДЕНИЕМ (payload.isFinalWarning);
 *   3) 3 полных дня   -> заработок за заказ обнуляется сторнирующей
 *      корректировкой (идемпотентно — повторный прогон денег не трогает).
 *
 * Ozon API переключён в MOCK-режим, список awaiting_deliver подменяется стабом.
 */
process.env.OZON_MOCK_MODE = 'true';
require('dotenv').config();

const { initDB, getDB } = require('../src/config/database');
const { initNotificationsDB, getNotificationsDB } = require('../src/config/notificationsDatabase');
const { User } = require('../src/models');
const Notification = require('../src/models/Notification');
const OzonService = require('../src/services/OzonService');
const scheduler = require('../src/scheduler');

const TEST_MARK = 'smokeReminder';
const stamp = Date.now();
const TEST_ORDER = `${TEST_MARK}-1_${stamp}`;
const DAY = 24 * 60 * 60 * 1000;

(async () => {
  const employee = { id: null };
  const staffUser = { id: null };
  let db;
  let ndb;

  const originalFetch = OzonService.fetchAwaitingDeliverOrders;
  OzonService.fetchAwaitingDeliverOrders = async () => [
    { posting_number: TEST_ORDER, products: [{ name: 'Тестовый товар', quantity: 1 }] },
  ];

  try {
    console.log('=== Smoke-тест напоминаний/обнуления awaiting_deliver ===');
    await initDB();
    await initNotificationsDB();
    db = getDB();
    ndb = getNotificationsDB();

    const emp = await User.create({
      username: `${TEST_MARK}_emp_${stamp}`,
      email: `${TEST_MARK}_emp_${stamp}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeReminderСотрудник',
      role: 'user',
    });
    const mod = await User.create({
      username: `${TEST_MARK}_mod_${stamp}`,
      email: `${TEST_MARK}_mod_${stamp}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeReminderМодератор',
      role: 'moderator',
    });
    employee.id = emp.id;
    staffUser.id = mod.id;
    console.log(`Созданы: сотрудник #${emp.id}, модератор #${mod.id}`);

    // Завершено 1 день + 1 час назад -> daysPassed = 1
    const oneDayAgo = Date.now() - (DAY + 60 * 60 * 1000);
    await db.run(
      `INSERT INTO assignments (order_id, user_id, assigned_at, completed_at, status)
       VALUES (?, ?, ?, ?, 'completed')`,
      TEST_ORDER, emp.id, oneDayAgo, oneDayAgo
    );
    await db.run(
      `INSERT INTO earnings_history (user_id, order_id, amount, calculated_at)
       VALUES (?, ?, ?, ?)`,
      emp.id, TEST_ORDER, 150, oneDayAgo
    );
    await db.run(
      `INSERT INTO earnings_active (user_id, order_id, amount, calculated_at)
       VALUES (?, ?, ?, ?)`,
      emp.id, TEST_ORDER, 150, oneDayAgo
    );

    const OPTS = { warnDays: 2, revokeDays: 3 };
    // --- Шаг 1: напоминание №1 ---
    const r1 = await scheduler.runAwaitingDeliverReminder(24, OPTS);
    const notif1 = (await Notification.getByRecipient(emp.id, { audience: 'user', limit: 20 }))
      .items.filter((n) => n.type === 'deliver_reminder');
    console.log(`Шаг 1: отправлено=${r1.sent}, напоминаний=${notif1.length}, isFinalWarning=${notif1[0]?.payload?.isFinalWarning}`);
    if (r1.sent !== 1 || notif1.length !== 1) throw new Error('Шаг 1: ожидалось одно напоминание');
    if (notif1[0].payload.isFinalWarning) throw new Error('Шаг 1: не должно быть предупреждения');

    // --- Шаг 2: напоминание №2 с предупреждением ---
    const twoDaysAgo = Date.now() - (2 * DAY + 60 * 60 * 1000);
    await db.run(
      'UPDATE assignments SET completed_at = ?, deliver_reminder_sent_at = NULL WHERE order_id = ?',
      twoDaysAgo, TEST_ORDER
    );
    const r2 = await scheduler.runAwaitingDeliverReminder(24, OPTS);
    const notif2 = (await Notification.getByRecipient(emp.id, { audience: 'user', limit: 20 }))
      .items.filter((n) => n.type === 'deliver_reminder');
    const warning = notif2.find((n) => n.payload?.isFinalWarning);
    console.log(`Шаг 2: отправлено=${r2.sent}, всего напоминаний=${notif2.length}, предупреждение=${!!warning}`);
    if (r2.sent !== 1 || !warning) throw new Error('Шаг 2: ожидалось напоминание с предупреждением');

    // --- Шаг 3: обнуление заработка ---
    const threeDaysAgo = Date.now() - (3 * DAY + 60 * 60 * 1000);
    await db.run(
      'UPDATE assignments SET completed_at = ?, deliver_reminder_sent_at = NULL WHERE order_id = ?',
      threeDaysAgo, TEST_ORDER
    );
    const r3 = await scheduler.runAwaitingDeliverReminder(24, OPTS);
    const assignment = await db.get('SELECT * FROM assignments WHERE order_id = ?', TEST_ORDER);
    const revokedNotif = (await Notification.getByRecipient(emp.id, { audience: 'user', limit: 20 }))
      .items.filter((n) => n.type === 'deliver_earnings_revoked');
    const adjHist = await db.get(
      'SELECT COALESCE(SUM(amount),0) AS s FROM earnings_adjustments WHERE user_id = ?', emp.id
    );
    const adjAct = await db.get(
      'SELECT COALESCE(SUM(amount),0) AS s FROM earnings_adjustments_active WHERE user_id = ?', emp.id
    );
    console.log(`Шаг 3: revoked=${r3.revoked}, замок=${assignment.earnings_revoked_at}, история=${adjHist.s}, актив=${adjAct.s}, оповещение=${revokedNotif.length}`);
    if (r3.revoked !== 1) throw new Error('Шаг 3: заработок не обнулён');
    if (!assignment.earnings_revoked_at) throw new Error('Шаг 3: замок не выставлен');
    if (adjHist.s !== -150) throw new Error(`Шаг 3: история корректировок=${adjHist.s}, ожидалось -150`);
    if (adjAct.s !== -150) throw new Error(`Шаг 3: активные корректировки=${adjAct.s}, ожидалось -150`);
    if (!revokedNotif.length) throw new Error('Шаг 3: оповещение deliver_earnings_revoked не создано');

    // --- Идемпотентность: повторный прогон не должен списать ещё раз ---
    const r4 = await scheduler.runAwaitingDeliverReminder(24, OPTS);
    const adjHist2 = await db.get(
      'SELECT COALESCE(SUM(amount),0) AS s FROM earnings_adjustments WHERE user_id = ?', emp.id
    );
    console.log(`Повтор: revoked=${r4.revoked}, сумма корректировок=${adjHist2.s} (должно остаться -150)`);
    if (r4.revoked !== 0) throw new Error('Повторный прогон снова обнулил заработок (двойное списание!)');
    if (adjHist2.s !== -150) throw new Error(`Повторное списание: сумма=${adjHist2.s}, ожидалось -150`);

    console.log('=== Smoke-тест пройден ✅ ===');
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    OzonService.fetchAwaitingDeliverOrders = originalFetch;
    try {
      await ndb.run(`DELETE FROM notifications WHERE payload LIKE '%${TEST_MARK}%'`);
      await db.run('DELETE FROM assignments WHERE order_id = ?', TEST_ORDER);
      await db.run('DELETE FROM earnings_history WHERE order_id = ?', TEST_ORDER);
      await db.run('DELETE FROM earnings_active WHERE order_id = ?', TEST_ORDER);
      if (employee.id) {
        await db.run('DELETE FROM earnings_adjustments WHERE user_id = ?', employee.id);
        await db.run('DELETE FROM earnings_adjustments_active WHERE user_id = ?', employee.id);
        await db.run('DELETE FROM users WHERE id = ?', employee.id);
      }
      if (staffUser.id) await db.run('DELETE FROM users WHERE id = ?', staffUser.id);
      console.log('Тестовые данные удалены');
    } catch (cleanupErr) {
      console.error('Ошибка очистки:', cleanupErr.message);
    }
  }
})();
