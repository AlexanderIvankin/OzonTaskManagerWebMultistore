/**
 * Smoke-тест: кэш состояния заказов и вкладка «🗳️ Завершённые заказы»
 * (запуск: node tests/smoke-order-status-sync.js из папки backend/).
 *
 * MULTISTORE: все методы OrderService принимают storeId. Ключи in-memory
 * кэшей (orderStateCache, productImagesCache) префиксуются storeId — поэтому
 * проверяем через OrderService.getOrderState(storeId, orderId) и
 * productImagesCache.get(`${storeId}:${offerId}`).
 *
 * Реальных запросов к Ozon и S3 нет: методы OzonService/ModelService
 * подменяются стабами. Проверяет:
 *   1) назначение заказа кладёт детали и статус в orderStateCache;
 *   2) завершение заказа НЕ удаляет фото, статус -> awaiting_deliver;
 *   3) buildCompletedOrdersAwaitingDeliver = завершённые ∩ awaiting_deliver (с фото);
 *   4) у заказа без снимка (после перезапуска) статус уточняется ОДНИМ списком Ozon;
 *   5) syncOrderStatuses: заказ, вышедший из awaiting_*, убирается из кэша, его
 *      фото чистятся — но НЕ удаляются, если артикул использует другой заказ;
 *   6) кулдаун refreshOrders (кнопка «Обновить») — 60 секунд;
 *   7) cleanExpiredAssignments({ userId }) снимает заказы только этого сотрудника.
 */
require('dotenv').config();
const { setup, cleanup } = require('./helpers/setupTestEnv');
const STORE_ID = setup('1').storeId;

const assert = require('assert');
const { initDB, closeAll, getStoreDB, getUsersDB } = require('../src/config/database');
const { User, UserStore } = require('../src/models');
const OzonService = require('../src/services/OzonService');
const ModelService = require('../src/services/ModelService');
const OrderService = require('../src/services/OrderService');
const CooldownService = require('../src/services/CooldownService');
const { productImagesCache } = require('../src/state');

const TEST_MARK = 'smokeOrderSync';
const stamp = Date.now();
const ORDER_ACTIVE = `${TEST_MARK}-active_${stamp}`;
const ORDER_DONE = `${TEST_MARK}-done_${stamp}`;
const ORDER_DONE_UNIQUE = `${TEST_MARK}-doneu_${stamp}`;
const OFFER_SHARED = `${TEST_MARK}_shared_${stamp}`;
const OFFER_UNIQUE = `${TEST_MARK}_unique_${stamp}`;
const SKU_SHARED = `sku_shared_${stamp}`;
const SKU_UNIQUE = `sku_unique_${stamp}`;
const TEST_ORDER_IDS = [ORDER_ACTIVE, ORDER_DONE, ORDER_DONE_UNIQUE];
const TEST_OFFER_IDS = [OFFER_SHARED, OFFER_UNIQUE];

// Ключ кэша фото с префиксом магазина (см. OrderService.stateKey)
const photoKey = (offerId) => `${STORE_ID}:${offerId}`;

const detailsFor = (orderId, offerId, sku, status) => ({
  posting_number: orderId,
  status,
  products: [{ name: `Товар ${offerId}`, quantity: 1, offer_id: offerId, sku }],
});

(async () => {
  console.log('=== Smoke-тест: кэш заказов и «Завершённые заказы» ===');
  let storeDb;
  const createdUserIds = [];
  let awaitingPackaging = [];
  let awaitingDeliver = [];
  let deliverListCalls = 0;

  const originals = {
    fetchAwaitingOrders: OzonService.fetchAwaitingOrders,
    fetchAwaitingDeliverOrders: OzonService.fetchAwaitingDeliverOrders,
    fetchProductsImages: OzonService.fetchProductsImages,
    getOrderDetails: OzonService.getOrderDetails,
    getOrderTotalAmount: OzonService.getOrderTotalAmount,
    confirmPostingShip: OzonService.confirmPostingShip,
    getPackageLabel: OzonService.getPackageLabel,
    attachToProducts: ModelService.attachToProducts,
    issueForAssignment: ModelService.issueForAssignment,
  };

  OzonService.fetchAwaitingOrders = async () => awaitingPackaging;
  OzonService.fetchAwaitingDeliverOrders = async () => {
    deliverListCalls += 1;
    return awaitingDeliver;
  };
  OzonService.fetchProductsImages = async (storeId, skuList) => {
    const map = {};
    for (const sku of skuList) {
      map[String(sku)] = [
        `https://img.local/${sku}_1.jpg`,
        `https://img.local/${sku}_2.jpg`,
      ];
    }
    return map;
  };
  OzonService.getOrderDetails = async (storeId, orderId) => {
    if (orderId === ORDER_ACTIVE) {
      return detailsFor(ORDER_ACTIVE, OFFER_SHARED, SKU_SHARED, 'awaiting_packaging');
    }
    if (orderId === ORDER_DONE) {
      return detailsFor(ORDER_DONE, OFFER_SHARED, SKU_SHARED, 'awaiting_deliver');
    }
    if (orderId === ORDER_DONE_UNIQUE) {
      return detailsFor(ORDER_DONE_UNIQUE, OFFER_UNIQUE, SKU_UNIQUE, 'awaiting_deliver');
    }
    return null;
  };
  OzonService.getOrderTotalAmount = async () => 1000;
  OzonService.confirmPostingShip = async () => ({ result: true });
  OzonService.getPackageLabel = async () => Buffer.from('%PDF-1.4 label\n%EOF');
  // 3D-модели в этом тесте не нужны (S3 не трогаем)
  ModelService.attachToProducts = async (products) => products;
  ModelService.issueForAssignment = async () => null;

  try {
    await initDB();
    storeDb = getStoreDB(STORE_ID);

    const emp = await User.create({
      username: `${TEST_MARK}_emp_${stamp}`,
      email: `${TEST_MARK}_emp_${stamp}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeOrderSyncСотрудник',
      role: 'user',
    });
    createdUserIds.push(emp.id);
    await UserStore.upsert(emp.id, STORE_ID, { role: 'employee', was_employee: 1 });

    // 1. Назначение заказа: детали уже загружены -> снимок в кэше
    await OrderService.assignOrder(STORE_ID, ORDER_ACTIVE, emp.id);
    const activeState = OrderService.getOrderState(STORE_ID, ORDER_ACTIVE);
    assert(activeState, 'назначение должно положить снимок заказа в кэш');
    assert.strictEqual(activeState.status, 'awaiting_packaging', 'статус активного заказа');
    assert.strictEqual(
      activeState.details.products[0].offer_id,
      OFFER_SHARED,
      'в кэше — загруженные детали заказа'
    );
    assert.strictEqual(
      productImagesCache.has(photoKey(OFFER_SHARED)),
      false,
      'фото грузятся лениво — пока их в кэше нет'
    );
    console.log('1. Назначение: детали и статус заказа сохранены в кэше ✅');

    // 2. Список активных: состав из кэша + фото по sku (кэш по offer_id)
    const active = await OrderService.buildActiveOrders(STORE_ID, emp.id);
    assert.strictEqual(active.length, 1, 'в активных ровно один заказ');
    assert.strictEqual(active[0].products[0].images.length, 2, 'фото привязаны к товару');
    assert.strictEqual(productImagesCache.has(photoKey(OFFER_SHARED)), true, 'фото закэшированы по offer_id');
    console.log('2. Активные заказы: состав и фото из кэша ✅');

    // 3. Завершение заказа: фото НЕ удаляются, статус -> awaiting_deliver
    await OrderService.assignOrder(STORE_ID, ORDER_DONE, emp.id);
    const finishResult = await OrderService.finishOrder(STORE_ID, ORDER_DONE, emp.id);
    assert.strictEqual(finishResult.success, true, 'заказ завершён');
    const doneState = OrderService.getOrderState(STORE_ID, ORDER_DONE);
    assert(doneState, 'завершённый заказ остаётся в кэше');
    assert.strictEqual(doneState.status, 'awaiting_deliver', 'после завершения статус awaiting_deliver');
    assert.strictEqual(
      productImagesCache.has(photoKey(OFFER_SHARED)),
      true,
      'фото заказа НЕ удалены при завершении (нужны на вкладке «Завершённые»)'
    );
    const doneRow = await storeDb.get('SELECT status FROM assignments WHERE order_id = ?', ORDER_DONE);
    assert.strictEqual(doneRow.status, 'completed', 'в БД заказ помечен completed');
    console.log('3. Завершение: фото сохранены, статус awaiting_deliver ✅');

    // 4. Вкладка «Завершённые заказы»: только ожидающие отправки, с фото
    const completed = await OrderService.buildCompletedOrdersAwaitingDeliver(STORE_ID, emp.id);
    assert.strictEqual(completed.length, 1, 'в «Завершённых» ровно один заказ');
    assert.strictEqual(completed[0].orderId, ORDER_DONE, 'это завершённый заказ');
    assert.strictEqual(completed[0].products[0].images.length, 2, 'фото завершённого заказа на месте');
    const activeAfter = await OrderService.buildActiveOrders(STORE_ID, emp.id);
    assert.strictEqual(activeAfter.length, 1, 'завершённый заказ ушёл из активных');
    assert.strictEqual(activeAfter[0].orderId, ORDER_ACTIVE, 'в активных остался только незавершённый');
    console.log('4. «Завершённые заказы»: awaiting_deliver с фото ✅');

    // 5. Снимка нет (перезапуск сервера): статус уточняется ОДНИМ списком Ozon
    OrderService.forgetOrderState(STORE_ID, ORDER_DONE);
    awaitingDeliver = [{ posting_number: ORDER_DONE }];
    deliverListCalls = 0;
    const completedCold = await OrderService.buildCompletedOrdersAwaitingDeliver(STORE_ID, emp.id);
    assert.strictEqual(deliverListCalls, 1, 'fetchAwaitingDeliverOrders вызван один раз на весь список');
    assert.strictEqual(completedCold.length, 1, 'заказ снова виден после восстановления статуса');
    assert.strictEqual(completedCold[0].products[0].images.length, 2, 'фото взяты из кэша по offer_id');
    console.log('5. Без снимка: 1 вызов Ozon на список, фото из кэша ✅');

    // 6. Заказ отправлен (ушёл из awaiting_deliver): снимок убран, общее фото —
    //    сохранено (артикул ещё используется активным заказом)
    awaitingPackaging = [{ posting_number: ORDER_ACTIVE }];
    awaitingDeliver = [];
    const syncShipped = await OrderService.syncOrderStatuses(STORE_ID);
    assert.strictEqual(syncShipped.removed, 1, 'вышедший из awaiting_* заказ убран из кэша');
    assert.strictEqual(OrderService.getOrderState(STORE_ID, ORDER_DONE), null, 'снимка заказа больше нет');
    assert.strictEqual(
      productImagesCache.has(photoKey(OFFER_SHARED)),
      true,
      'фото общего артикула не удалено'
    );
    assert.deepStrictEqual(syncShipped.activeOrderIds, [ORDER_ACTIVE], 'активные заказы отданы для очистки назначений');
    const completedAfterShip = await OrderService.buildCompletedOrdersAwaitingDeliver(STORE_ID, emp.id);
    assert.strictEqual(completedAfterShip.length, 0, 'отправленный заказ исчез из «Завершённых»');
    console.log('6. Отправленный заказ убран, общее фото сохранено ✅');

    // 7. Заказ с «личным» артикулом: после выхода из статусов фото удаляются
    await OrderService.assignOrder(STORE_ID, ORDER_DONE_UNIQUE, emp.id);
    await OrderService.finishOrder(STORE_ID, ORDER_DONE_UNIQUE, emp.id);
    const warmed = await OrderService.buildCompletedOrdersAwaitingDeliver(STORE_ID, emp.id);
    assert.strictEqual(warmed.length, 1, 'уникальный заказ виден в «Завершённых»');
    assert.strictEqual(
      productImagesCache.has(photoKey(OFFER_UNIQUE)),
      true,
      'фото уникального артикула закэшировано'
    );
    awaitingDeliver = [];
    const syncUnique = await OrderService.syncOrderStatuses(STORE_ID);
    assert.ok(syncUnique.removed >= 1, 'уникальный заказ убран из кэша');
    assert.strictEqual(
      OrderService.getOrderState(STORE_ID, ORDER_DONE_UNIQUE),
      null,
      'снимка уникального заказа нет'
    );
    assert.strictEqual(
      productImagesCache.has(photoKey(OFFER_UNIQUE)),
      false,
      'фото уникального артикула удалено'
    );
    assert.strictEqual(
      productImagesCache.has(photoKey(OFFER_SHARED)),
      true,
      'фото общего артикула осталось'
    );
    console.log('7. Фото «личного» артикула удалены, общие — сохранены ✅');

    // 8. Кулдаун кнопки «Обновить» (CooldownService.refreshOrders) — 60 секунд
    const now = Date.now();
    assert.strictEqual(
      CooldownService.check('refreshOrders', STORE_ID, emp.id, now).blocked,
      false,
      'до синхронизации кулдаун не блокирует'
    );
    CooldownService.touch('refreshOrders', STORE_ID, emp.id, 0, now);
    const blocked = CooldownService.check('refreshOrders', STORE_ID, emp.id, now + 1000);
    assert.strictEqual(blocked.blocked, true, 'после синхронизации блокирует');
    assert.ok(
      blocked.retryAfterSec >= 59 && blocked.retryAfterSec <= 60,
      `retryAfterSec ≈ 60, получено ${blocked.retryAfterSec}`
    );
    assert.ok(
      blocked.message.includes('обновлени'),
      'текст про повторное обновление заказов'
    );
    assert.strictEqual(
      CooldownService.check('refreshOrders', STORE_ID, emp.id, now + 60 * 1000).blocked,
      false,
      'через минуту снова можно обновлять'
    );
    console.log('8. Кулдаун refreshOrders — 60 секунд ✅');

    // 9. Авто-снятие ограничено одним сотрудником
    const other = await User.create({
      username: `${TEST_MARK}_other_${stamp}`,
      email: `${TEST_MARK}_other_${stamp}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeOrderSyncВторой',
      role: 'user',
    });
    createdUserIds.push(other.id);
    await UserStore.upsert(other.id, STORE_ID, { role: 'employee', was_employee: 1 });

    const GHOST_MINE = `${TEST_MARK}-ghost_mine_${stamp}`;
    const GHOST_OTHER = `${TEST_MARK}-ghost_other_${stamp}`;
    TEST_ORDER_IDS.push(GHOST_MINE, GHOST_OTHER);
    const assignedAt = Date.now();
    await storeDb.run(
      'INSERT INTO assignments (order_id, user_id, assigned_at, status) VALUES (?, ?, ?, ?)',
      GHOST_MINE, emp.id, assignedAt, 'assigned'
    );
    await storeDb.run(
      'INSERT INTO assignments (order_id, user_id, assigned_at, status) VALUES (?, ?, ?, ?)',
      GHOST_OTHER, other.id, assignedAt, 'assigned'
    );
    // Список awaiting_packaging пуст -> оба заказа «неактуальны»
    await OrderService.cleanExpiredAssignments(STORE_ID, [], { userId: emp.id });
    const mineRow = await storeDb.get('SELECT 1 AS x FROM assignments WHERE order_id = ?', GHOST_MINE);
    const otherRow = await storeDb.get('SELECT 1 AS x FROM assignments WHERE order_id = ?', GHOST_OTHER);
    assert.ok(!mineRow, 'заказ сотрудника снят (его нет в awaiting_packaging)');
    assert.ok(otherRow, 'назначения других сотрудников не тронуты');
    console.log('9. Авто-снятие ограничено сотрудником ✅');

    console.log('✅ Все проверки пройдены');
  } catch (err) {
    console.error('❌ Smoke-тест провален:', err.message);
    process.exitCode = 1;
  } finally {
    Object.assign(OzonService, {
      fetchAwaitingOrders: originals.fetchAwaitingOrders,
      fetchAwaitingDeliverOrders: originals.fetchAwaitingDeliverOrders,
      fetchProductsImages: originals.fetchProductsImages,
      getOrderDetails: originals.getOrderDetails,
      getOrderTotalAmount: originals.getOrderTotalAmount,
      confirmPostingShip: originals.confirmPostingShip,
      getPackageLabel: originals.getPackageLabel,
    });
    ModelService.attachToProducts = originals.attachToProducts;
    ModelService.issueForAssignment = originals.issueForAssignment;
    for (const orderId of TEST_ORDER_IDS) OrderService.forgetOrderState(STORE_ID, orderId);
    for (const offerId of TEST_OFFER_IDS) productImagesCache.delete(photoKey(offerId));
    try {
      if (storeDb) {
        for (const orderId of TEST_ORDER_IDS) {
          await storeDb.run('DELETE FROM assignments WHERE order_id = ?', orderId);
        }
      }
      const usersDb = getUsersDB();
      for (const userId of createdUserIds) {
        await usersDb.run('DELETE FROM user_stores WHERE user_id = ?', userId);
        await usersDb.run('DELETE FROM users WHERE id = ?', userId);
      }
      console.log('Тестовые данные удалены');
    } catch (cleanupErr) {
      console.error('Ошибка очистки:', cleanupErr.message);
    }
    try { await closeAll(); } catch { /* ignore */ }
    cleanup();
  }
})();