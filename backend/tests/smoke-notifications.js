/**
 * Smoke-тест notifications.db (запуск: node tests/smoke-notifications.js из backend/).
 * MULTISTORE: оповещения магазинов разделены колонкой store_id.
 *   • notifyUser/notifyStaff принимают { storeId };
 *   • получатели notifyStaff ищутся в user_stores магазина;
 *   • фильтры getByRecipient/getErrors работают в контексте магазина.
 * Создаёт тестовые записи, проверяет CRUD, удаляет за собой.
 */
require('dotenv').config();
const { setup, cleanup } = require('./helpers/setupTestEnv');
const env = setup('1');
const STORE_ID = env.storeId;

const { initDB, closeAll } = require('../src/config/database');
const {
  initNotificationsDB,
  getNotificationsDB,
  getNotificationsDBPath,
  closeNotificationsDB,
} = require('../src/config/notificationsDatabase');
const Notification = require('../src/models/Notification');
const NotificationService = require('../src/services/NotificationService');
const User = require('../src/models/User');
const UserStore = require('../src/models/UserStore');

const STORE_B = 'test-store-B';
const STAMP = Date.now();

(async () => {
  try {
    console.log('=== Smoke-тест notifications.db (multistore) ===');
    await initDB();
    await initNotificationsDB();
    console.log('Файл БД оповещений:', getNotificationsDBPath());

    // --- Фикстура: админ магазина + обычный пользователь ---
    const admin = await User.create({
      username: `smoke_notif_admin_${STAMP}`,
      email: `smoke_notif_admin_${STAMP}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeNotifAdmin',
      role: 'user',
    });
    await UserStore.upsert(admin.id, STORE_ID, { role: 'admin', was_employee: 1 });

    const user = await User.create({
      username: `smoke_notif_user_${STAMP}`,
      email: `smoke_notif_user_${STAMP}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeNotifUser',
      role: 'user',
    });

    // 1. Личное оповещение
    const createdId = await Notification.create({
      recipientId: user.id,
      storeId: STORE_ID,
      audience: 'user',
      type: 'order_assigned',
      title: '📦 Заказ TEST-1 назначен вам',
      message: 'Тестовое оповещение',
      payload: { orderId: 'TEST-1' },
      orderId: 'TEST-1',
    });
    console.log(`1. Личное оповещение создано, id=${createdId}`);

    // 2. Штатный сервис: notifyUser + notifyStaff + logServerError
    await NotificationService.notifyUser(
      user.id,
      'order_finished',
      { orderId: 'TEST-2', labelAvailable: true, earnings: 150 },
      { storeId: STORE_ID }
    );
    await NotificationService.notifyStaff(
      'order_finished',
      { orderId: 'TEST-2', userName: 'SmokeTest', earnings: 150 },
      { storeId: STORE_ID }
    );
    await NotificationService.logServerError(
      'smokeTest',
      new Error('Тестовая ошибка сервера'),
      { storeId: STORE_ID, orderId: 'TEST-3' }
    );
    console.log('2. notifyUser + notifyStaff + logServerError — ок');

    // 3. Чтение списков (в контексте магазина)
    const mine = await Notification.getByRecipient(user.id, {
      storeId: STORE_ID, audience: 'user', limit: 10,
    });
    const staff = await Notification.getByRecipient(admin.id, {
      storeId: STORE_ID, audience: 'staff', limit: 10,
    });
    const errors = await Notification.getErrors({ storeId: STORE_ID, limit: 10 });
    console.log(`Личных: ${mine.total}, в журнале (admin): ${staff.total}, ошибок: ${errors.total}`);
    if (mine.total < 2) throw new Error('Ожидалось >= 2 личных оповещений');
    if (staff.total < 1) throw new Error('Ожидалось >= 1 запись в журнале персонала');
    if (errors.total < 1) throw new Error('Ожидалось >= 1 ошибка сервера');

    // 4. Изоляция магазинов: те же получатели, другой storeId — ничего нет
    const otherStoreMine = await Notification.getByRecipient(user.id, {
      storeId: STORE_B, audience: 'user', limit: 10,
    });
    const otherStoreStaff = await Notification.getByRecipient(admin.id, {
      storeId: STORE_B, audience: 'staff', limit: 10,
    });
    if (otherStoreMine.total !== 0) throw new Error('Оповещения утекли в другой магазин');
    if (otherStoreStaff.total !== 0) throw new Error('Журнал утёк в другой магазин');
    console.log('4. Изоляция по store_id: в другом магазине — пусто ✅');

    // 5. Фильтр непрочитанных и счётчик
    const unreadOnly = await Notification.getByRecipient(user.id, {
      storeId: STORE_ID, audience: 'user', unreadOnly: true, limit: 5,
    });
    const unreadCount = await Notification.getUnreadCount(user.id, {
      storeId: STORE_ID, audience: 'user',
    });
    console.log(`Непрочитанных личных: ${unreadOnly.total} (счётчик: ${unreadCount})`);
    if (unreadOnly.total !== unreadCount) throw new Error('Счётчик unread расходится со списком');

    // 6. Поиск по номеру заказа и имени сотрудника
    const byOrder = await Notification.getByRecipient(user.id, {
      storeId: STORE_ID, audience: 'user', orderId: 'TEST-2',
    });
    const byName = await Notification.getByRecipient(admin.id, {
      storeId: STORE_ID, audience: 'staff', userName: 'SmokeTest',
    });
    const byNameMiss = await Notification.getByRecipient(admin.id, {
      storeId: STORE_ID, audience: 'staff', userName: 'НетТакогоИмени',
    });
    console.log(`Поиск по заказу TEST-2: ${byOrder.total}, по имени SmokeTest: ${byName.total}, miss: ${byNameMiss.total}`);
    if (byOrder.total < 1) throw new Error('Поиск по orderId не работает');
    if (byName.total < 1) throw new Error('Поиск по userName не работает');
    if (byNameMiss.total !== 0) throw new Error('Поиск по отсутствующему имени вернул записи');

    // 7. Поиск по артикулу offer_id
    await NotificationService.notifyUser(
      user.id,
      'order_assigned',
      {
        orderId: 'TEST-4',
        userName: 'SmokeTest',
        details: { products: [{ offer_id: 'OFFER-1' }, { offer_id: 'OFFER-2' }] },
        missingStats: ['OFFER-2'],
      },
      { storeId: STORE_ID }
    );
    const byOffer = await Notification.getByRecipient(user.id, {
      storeId: STORE_ID, audience: 'user', offerId: 'OFFER-1',
    });
    console.log(`Поиск по артикулу OFFER-1: ${byOffer.total}`);
    if (byOffer.total < 1) throw new Error('Поиск по offer_id не работает');

    // 8. Транзиентное (persist: false) — не пишется в историю
    const beforeTransient = (await Notification.getByRecipient(user.id, {
      storeId: STORE_ID, audience: 'user',
    })).total;
    await NotificationService.notifyUser(
      user.id,
      'earnings_settled_zero',
      { adminName: 'SmokeAdmin' },
      { storeId: STORE_ID, persist: false }
    );
    const afterTransient = (await Notification.getByRecipient(user.id, {
      storeId: STORE_ID, audience: 'user',
    })).total;
    if (afterTransient !== beforeTransient) throw new Error('Транзиентное оповещение сохранилось в историю');
    console.log('8. Транзиентное (persist: false) в историю не попало ✅');

    // 9. markRead + unreadCount
    const marked = await Notification.markRead(user.id, [createdId]);
    const unreadAfter = await Notification.getUnreadCount(user.id, {
      storeId: STORE_ID, audience: 'user',
    });
    console.log(`Отмечено прочитано: ${marked}, осталось непрочитанных: ${unreadAfter}`);
    if (marked !== 1) throw new Error('markRead не отметил запись');

    // 10. Очистка за собой
    const db = getNotificationsDB();
    await db.run(
      `DELETE FROM notifications WHERE payload LIKE '%TEST-1%' OR payload LIKE '%TEST-2%' OR payload LIKE '%TEST-4%' OR payload LIKE '%SmokeTest%'`
    );
    await db.run(`DELETE FROM server_errors WHERE source = 'smokeTest'`);
    const pruned = await Notification.pruneOld(30, 14);
    console.log(`pruneOld OK (удалено ${pruned.notifications} оповещений, ${pruned.errors} ошибок)`);

    // Убираем тестовых пользователей
    const { getUsersDB } = require('../src/config/database');
    await getUsersDB().run('DELETE FROM user_stores WHERE user_id IN (?, ?)', admin.id, user.id);
    await getUsersDB().run('DELETE FROM users WHERE id IN (?, ?)', admin.id, user.id);

    console.log('=== Smoke-тест пройден ✅ ===');
    process.exit(0);
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exit(1);
  } finally {
    try { await closeNotificationsDB(); } catch { /* не открылась */ }
    try { await closeAll(); } catch { /* не открылась */ }
    cleanup();
  }
})();