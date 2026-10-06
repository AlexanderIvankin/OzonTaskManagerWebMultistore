/**
 * Smoke-тест notifications.db (запуск: node tests/smoke-notifications.js из папки backend/).
 * Создаёт тестовые записи, проверяет CRUD и удаляет за собой.
 */
require('dotenv').config();

const { initDB } = require('../src/config/database');
const { initNotificationsDB, getNotificationsDBPath } = require('../src/config/notificationsDatabase');
const Notification = require('../src/models/Notification');
const NotificationService = require('../src/services/NotificationService');

(async () => {
  try {
    console.log('=== Smoke-тест notifications.db ===');
    await initDB();
    await initNotificationsDB();
    console.log('Файл БД оповещений:', getNotificationsDBPath());

    // 1. Личное оповещение пользователю id=1
    const created = [];
    created.push(await Notification.create({
      recipientId: 1,
      audience: 'user',
      type: 'order_assigned',
      title: '📦 Заказ TEST-1 назначен вам',
      message: 'Тестовое оповещение',
      payload: { orderId: 'TEST-1' },
    }));

    // 2. Штатный сервис: notifyUser + notifyStaff (копия каждому админу/модератору)
    await NotificationService.notifyUser(1, 'order_finished', { orderId: 'TEST-2', labelAvailable: true, earnings: 150 });
    await NotificationService.notifyStaff('order_finished', { orderId: 'TEST-2', userName: 'SmokeTest', earnings: 150 });
    await NotificationService.logServerError('smokeTest', new Error('Тестовая ошибка сервера'), { orderId: 'TEST-3' });

    // 3. Чтение списков
    const mine = await Notification.getByRecipient(1, { audience: 'user', limit: 10 });
    const staff = await Notification.getByRecipient(1, { audience: 'staff', limit: 10 });
    const errors = await Notification.getErrors({ limit: 10 });
    console.log(`Личных: ${mine.total}, в журнале (для админа id=1): ${staff.total}, ошибок: ${errors.total}`);
    console.log('Пример личного:', JSON.stringify(mine.items[0]));
    console.log('Пример ошибки:', JSON.stringify(errors.items[0]));

    // 4. Пагинация и фильтр непрочитанных
    const unreadOnly = await Notification.getByRecipient(1, { audience: 'user', unreadOnly: true, limit: 5 });
    console.log(`Непрочитанных личных: ${unreadOnly.total}`);

    // 4b. Поиск по номеру заказа и имени сотрудника
    const byOrder = await Notification.getByRecipient(1, {
      audience: 'user',
      orderId: 'TEST-2',
    });
    const byName = await Notification.getByRecipient(3, {
      audience: 'staff',
      userName: 'SmokeTest',
    });
    const byNameMiss = await Notification.getByRecipient(3, {
      audience: 'staff',
      userName: 'НесуществующийСотрудник',
    });
    console.log(
      `Поиск по заказу TEST-2: ${byOrder.total}, по имени SmokeTest: ${byName.total}, по отсутствующему имени: ${byNameMiss.total}`
    );

    // 4c. Поиск по артикулу offer_id (payload.details.products -> колонка offer_ids)
    await NotificationService.notifyUser(1, 'order_assigned', {
      orderId: 'TEST-4',
      userName: 'SmokeTest',
      details: { products: [{ offer_id: 'OFFER-1' }, { offer_id: 'OFFER-2' }] },
      missingStats: ['OFFER-2'],
    });
    const byOffer = await Notification.getByRecipient(1, {
      audience: 'user',
      offerId: 'OFFER-1',
    });
    console.log(`Поиск по артикулу OFFER-1: ${byOffer.total}`);

    // 4d. Шаблон корректировки заработка (админ + причина)
    await NotificationService.notifyUser(1, 'earnings_adjusted', {
      amount: 200,
      reason: 'SmokeTest',
      adminName: 'SmokeAdmin',
    });
    const byAdjust = await Notification.getByRecipient(1, {
      audience: 'user',
    });
    const adjustItem = byAdjust.items.find(
      (n) => n.type === 'earnings_adjusted' && n.payload?.reason === 'SmokeTest',
    );
    console.log(
      `Корректировка создана: ${!!adjustItem}, сообщение: "${adjustItem?.message}"`,
    );

    // 4e. Транзиентное оповещение (persist: false) — НЕ пишется в историю
    await NotificationService.notifyUser(
      1,
      'earnings_settled_zero',
      { adminName: 'SmokeAdmin' },
      { persist: false },
    );
    const afterTransient = await Notification.getByRecipient(1, {
      audience: 'user',
    });
    const transientSaved = afterTransient.items.some(
      (n) => n.type === 'earnings_settled_zero',
    );
    console.log(
      `Транзиентное оповещение НЕ сохранено в историю: ${!transientSaved}`,
    );

    // 5. Прочитка/удаление
    const marked = await Notification.markRead(1, [created[0]]);
    const unreadAfter = await Notification.getUnreadCount(1, { audience: 'user' });
    console.log(`Отмечено прочитано: ${marked}, осталось непрочитанных личных у id=1: ${unreadAfter}`);

    // 6. Очистка за собой: удаляем тестовые записи (у всех получателей)
    const db = require('../src/config/notificationsDatabase').getNotificationsDB();
    await db.run(
      `DELETE FROM notifications WHERE payload LIKE '%TEST-1%' OR payload LIKE '%TEST-2%' OR payload LIKE '%TEST-4%' OR payload LIKE '%SmokeTest%'`
    );
    await db.run(`DELETE FROM server_errors WHERE source = 'smokeTest'`);
    const pruned = await Notification.pruneOld(30, 14);
    console.log(`pruneOld OK (удалено ${pruned.notifications} оповещений, ${pruned.errors} ошибок)`);

    console.log('=== Smoke-тест пройден ✅ ===');
    process.exit(0);
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exit(1);
  }
})();
