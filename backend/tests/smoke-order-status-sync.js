/**
 * Smoke-тест: кэш состояния заказов и вкладка «🗳️ Завершённые заказы»
 * (запуск: node tests/smoke-order-status-sync.js из папки backend/).
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
process.env.OZON_MOCK_MODE = 'false';
require('dotenv').config();

const assert = require('assert');
const { initDB, getDB } = require('../src/config/database');
const { User } = require('../src/models');
const OzonService = require('../src/services/OzonService');
const ModelService = require('../src/services/ModelService');
const OrderService = require('../src/services/OrderService');
const CooldownService = require('../src/services/CooldownService');
const { orderStateCache, productImagesCache } = require('../src/state');

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

const detailsFor = (orderId, offerId, sku, status) => ({
  posting_number: orderId,
  status,
  products: [{ name: `Товар ${offerId}`, quantity: 1, offer_id: offerId, sku }],
});

(async () => {
  console.log('=== Smoke-тест: кэш заказов и «Завершённые заказы» ===');
  let db;
  const createdUserIds = [];
  // Стабы: списки заказов в статусах (Ozon) + счётчик вызовов списка awaiting_deliver
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
  // Фото товара: 2 ссылки на sku (кэшируются по offer_id)
  OzonService.fetchProductsImages = async (skuList) => {
    const map = {};
    for (const sku of skuList) {
      map[String(sku)] = [
        `https://img.local/${sku}_1.jpg`,
        `https://img.local/${sku}_2.jpg`,
      ];
    }
    return map;
  };
  OzonService.getOrderDetails = async (orderId) => {
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
    db = getDB();

    const emp = await User.create({
      username: `${TEST_MARK}_emp_${stamp}`,
      email: `${TEST_MARK}_emp_${stamp}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeOrderSyncСотрудник',
      role: 'employee',
    });
    createdUserIds.push(emp.id);

    // 1. Назначение заказа: детали уже загружены -> снимок в кэше
    await OrderService.assignOrder(ORDER_ACTIVE, emp.id);
    const activeState = orderStateCache.get(ORDER_ACTIVE);
    assert(activeState, 'назначение должно положить снимок заказа в кэш');
    assert.strictEqual(activeState.status, 'awaiting_packaging', 'статус активного заказа');
    assert.strictEqual(
      activeState.details.products[0].offer_id,
      OFFER_SHARED,
      'в кэше — загруженные детали заказа'
    );
    assert.strictEqual(
      productImagesCache.has(OFFER_SHARED),
      false,
      'фото грузятся лениво — пока их в кэше нет'
    );
    console.log('1. Назначение: детали и статус заказа сохранены в кэше ✅');

    // 2. Список активных: состав из кэша + фото по sku (кэш по offer_id)
    const active = await OrderService.buildActiveOrders(emp.id);
    assert.strictEqual(active.length, 1, 'в активных ровно один заказ');
    assert.strictEqual(active[0].products[0].images.length, 2, 'фото привязаны к товару');
    assert.strictEqual(productImagesCache.has(OFFER_SHARED), true, 'фото закэшированы по offer_id');
    console.log('2. Активные заказы: состав и фото из кэша ✅');

    // 3. Завершение заказа: фото НЕ удаляются, статус -> awaiting_deliver
    await OrderService.assignOrder(ORDER_DONE, emp.id);
    const finishResult = await OrderService.finishOrder(ORDER_DONE, emp.id);
    assert.strictEqual(finishResult.success, true, 'заказ завершён');
    const doneState = orderStateCache.get(ORDER_DONE);
    assert(doneState, 'завершённый заказ остаётся в кэше');
    assert.strictEqual(doneState.status, 'awaiting_deliver', 'после завершения статус awaiting_deliver');
    assert.strictEqual(
      productImagesCache.has(OFFER_SHARED),
      true,
      'фото заказа НЕ удалены при завершении (нужны на вкладке «Завершённые»)'
    );
    const doneRow = await db.get('SELECT status FROM assignments WHERE order_id = ?', ORDER_DONE);
    assert.strictEqual(doneRow.status, 'completed', 'в БД заказ помечен completed');
    console.log('3. Завершение: фото сохранены, статус awaiting_deliver ✅');

    // 4. Вкладка «Завершённые заказы»: только ожидающие отправки, с фото
    const completed = await OrderService.buildCompletedOrdersAwaitingDeliver(emp.id);
    assert.strictEqual(completed.length, 1, 'в «Завершённых» ровно один заказ');
    assert.strictEqual(completed[0].orderId, ORDER_DONE, 'это завершённый заказ');
    assert.strictEqual(completed[0].products[0].images.length, 2, 'фото завершённого заказа на месте');
    const activeAfter = await OrderService.buildActiveOrders(emp.id);
    assert.strictEqual(activeAfter.length, 1, 'завершённый заказ ушёл из активных');
    assert.strictEqual(activeAfter[0].orderId, ORDER_ACTIVE, 'в активных остался только незавершённый');
    console.log('4. «Завершённые заказы»: awaiting_deliver с фото ✅');

    // 5. Снимка нет (перезапуск сервера): статус уточняется ОДНИМ списком Ozon
    orderStateCache.delete(ORDER_DONE);
    awaitingDeliver = [{ posting_number: ORDER_DONE }];
    deliverListCalls = 0;
    const completedCold = await OrderService.buildCompletedOrdersAwaitingDeliver(emp.id);
    assert.strictEqual(deliverListCalls, 1, 'fetchAwaitingDeliverOrders вызван один раз на весь список');
    assert.strictEqual(completedCold.length, 1, 'заказ снова виден после восстановления статуса');
    assert.strictEqual(completedCold[0].products[0].images.length, 2, 'фото взяты из кэша по offer_id');
    console.log('5. Без снимка: 1 вызов Ozon на список, фото из кэша ✅');

    // 6. Заказ отправлен (ушёл из awaiting_deliver): снимок убран, общее фото —
    //    сохранено (артикул ещё используется активным заказом)
    awaitingPackaging = [{ posting_number: ORDER_ACTIVE }];
    awaitingDeliver = [];
    const syncShipped = await OrderService.syncOrderStatuses();
    assert.strictEqual(syncShipped.removed, 1, 'вышедший из awaiting_* заказ убран из кэша');
    assert.strictEqual(orderStateCache.has(ORDER_DONE), false, 'снимка заказа больше нет');
    assert.strictEqual(productImagesCache.has(OFFER_SHARED), true, 'фото общего артикула не удалено');
    assert.deepStrictEqual(syncShipped.activeOrderIds, [ORDER_ACTIVE], 'активные заказы отданы для очистки назначений');
    const completedAfterShip = await OrderService.buildCompletedOrdersAwaitingDeliver(emp.id);
    assert.strictEqual(completedAfterShip.length, 0, 'отправленный заказ исчез из «Завершённых»');
    console.log('6. Отправленный заказ убран, общее фото сохранено ✅');

    // 7. Заказ с «личным» артикулом: после выхода из статусов фото удаляются
    await OrderService.assignOrder(ORDER_DONE_UNIQUE, emp.id);
    await OrderService.finishOrder(ORDER_DONE_UNIQUE, emp.id);
    const warmed = await OrderService.buildCompletedOrdersAwaitingDeliver(emp.id);
    assert.strictEqual(warmed.length, 1, 'уникальный заказ виден в «Завершённых»');
    assert.strictEqual(productImagesCache.has(OFFER_UNIQUE), true, 'фото уникального артикула закэшировано');
    awaitingDeliver = [];
    const syncUnique = await OrderService.syncOrderStatuses();
    // removed >= 1: помимо уникального заказа тут же вычищается «отрицательный»
    // снимок отправленного заказа из шага 6 (статус 'other')
    assert.ok(syncUnique.removed >= 1, 'уникальный заказ убран из кэша');
    assert.strictEqual(orderStateCache.has(ORDER_DONE_UNIQUE), false, 'снимка уникального заказа нет');
    assert.strictEqual(productImagesCache.has(OFFER_UNIQUE), false, 'фото уникального артикула удалено');
    assert.strictEqual(productImagesCache.has(OFFER_SHARED), true, 'фото общего артикула осталось');
    console.log('7. Фото «личного» артикула удалены, общие — сохранены ✅');

    // 8. Кулдаун кнопки «Обновить» (CooldownService.refreshOrders) — 60 секунд
    const now = Date.now();
    assert.strictEqual(
      CooldownService.check('refreshOrders', emp.id, now).blocked,
      false,
      'до синхронизации кулдаун не блокирует'
    );
    CooldownService.touch('refreshOrders', emp.id, 0, now);
    const blocked = CooldownService.check('refreshOrders', emp.id, now + 1000);
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
      CooldownService.check('refreshOrders', emp.id, now + 60 * 1000).blocked,
      false,
      'через минуту снова можно обновлять'
    );
    console.log('8. Кулдаун refreshOrders — 60 секунд ✅');

    // 9. Авто-снятие из интерфейса ограничено одним сотрудником: заказы, ушедшие
    //    из awaiting_packaging, снимаются только у нажавшего кнопку «Обновить»
    const other = await User.create({
      username: `${TEST_MARK}_other_${stamp}`,
      email: `${TEST_MARK}_other_${stamp}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeOrderSyncВторой',
      role: 'employee',
    });
    createdUserIds.push(other.id);
    const GHOST_MINE = `${TEST_MARK}-ghost_mine_${stamp}`;
    const GHOST_OTHER = `${TEST_MARK}-ghost_other_${stamp}`;
    TEST_ORDER_IDS.push(GHOST_MINE, GHOST_OTHER);
    const assignedAt = Date.now();
    await db.run(
      'INSERT INTO assignments (order_id, user_id, assigned_at, status) VALUES (?, ?, ?, ?)',
      GHOST_MINE, emp.id, assignedAt, 'assigned'
    );
    await db.run(
      'INSERT INTO assignments (order_id, user_id, assigned_at, status) VALUES (?, ?, ?, ?)',
      GHOST_OTHER, other.id, assignedAt, 'assigned'
    );
    // Список awaiting_packaging пуст -> оба заказа «неактуальны»
    await OrderService.cleanExpiredAssignments([], { userId: emp.id });
    const mineRow = await db.get('SELECT 1 AS x FROM assignments WHERE order_id = ?', GHOST_MINE);
    const otherRow = await db.get('SELECT 1 AS x FROM assignments WHERE order_id = ?', GHOST_OTHER);
    assert.ok(!mineRow, 'заказ сотрудника снят (его нет в awaiting_packaging)');
    assert.ok(otherRow, 'назначения других сотрудников не тронуты');
    console.log('9. Авто-снятие ограничено сотрудником ✅');

    console.log('✅ Все проверки пройдены');
  } catch (err) {
    console.error('❌ Smoke-тест провален:', err.message);
    process.exitCode = 1;
  } finally {
    // Восстанавливаем подменённые методы и чистим тестовые данные
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
    for (const orderId of TEST_ORDER_IDS) orderStateCache.delete(orderId);
    for (const offerId of TEST_OFFER_IDS) productImagesCache.delete(offerId);
    try {
      if (db) {
        for (const orderId of TEST_ORDER_IDS) {
          await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);
        }
        for (const userId of createdUserIds) {
          await db.run('DELETE FROM users WHERE id = ?', userId);
        }
      }
      console.log('Тестовые данные удалены');
    } catch (cleanupErr) {
      console.error('Ошибка очистки:', cleanupErr.message);
    }
  }
})();


