/**
 * Smoke-тест: склейка всех этикеток одним вызовом Ozon
 * (запуск: node tests/smoke-all-labels.js из папки backend/).
 * Реальных запросов к Ozon нет: fetchAwaitingDeliverOrders и getPackageLabel
 * подменяются стабами. Проверяет OrderService.getAllLabels:
 *   1) в create уходит пересечение completed-заказов сотрудника со списком
 *      awaiting_deliver одним массивом;
 *   2) пустое пересечение -> null (контроллер отдаст 404 с текстом);
 *   3) без завершённых заказов список Ozon вообще не запрашивается.
 */
process.env.OZON_MOCK_MODE = 'false';
require('dotenv').config();

const assert = require('assert');
const { initDB, getDB } = require('../src/config/database');
const { User } = require('../src/models');
const OzonService = require('../src/services/OzonService');
const OrderService = require('../src/services/OrderService');

const TEST_MARK = 'smokeAllLabels';
const stamp = Date.now();
const ORDER_IN_AWAITING = `${TEST_MARK}-in_${stamp}`;
const ORDER_OUT_OF_STATUS = `${TEST_MARK}-out_${stamp}`;
const FOREIGN_ORDER = `${TEST_MARK}-foreign_${stamp}`;
const PDF_BYTES = Buffer.from('%PDF-1.4 combined-labels\n%EOF');

(async () => {
  console.log('=== Smoke-тест: OrderService.getAllLabels (склейка) ===');
  let db;
  const createdUserIds = [];
  const originalFetch = OzonService.fetchAwaitingDeliverOrders;
  const originalGetPackageLabel = OzonService.getPackageLabel;

  // Стабы Ozon: список awaiting_deliver + готовый «склеенный» PDF
  const labelCalls = [];
  OzonService.fetchAwaitingDeliverOrders = async () => [
    { posting_number: ORDER_IN_AWAITING },
    { posting_number: FOREIGN_ORDER },
  ];
  OzonService.getPackageLabel = async (postingNumbers) => {
    labelCalls.push(postingNumbers);
    return PDF_BYTES;
  };

  try {
    await initDB();
    db = getDB();

    // Два сотрудника: у первого два завершённых заказа, у второго нет
    const emp = await User.create({
      username: `${TEST_MARK}_emp_${stamp}`,
      email: `${TEST_MARK}_emp_${stamp}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeAllLabelsСотрудник',
      role: 'user',
    });
    const emptyEmp = await User.create({
      username: `${TEST_MARK}_empty_${stamp}`,
      email: `${TEST_MARK}_empty_${stamp}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeAllLabelsБезЗаказов',
      role: 'user',
    });
    createdUserIds.push(emp.id, emptyEmp.id);

    const now = Date.now();
    for (const orderId of [ORDER_IN_AWAITING, ORDER_OUT_OF_STATUS]) {
      await db.run(
        `INSERT INTO assignments (order_id, user_id, assigned_at, completed_at, status)
         VALUES (?, ?, ?, ?, 'completed')`,
        orderId, emp.id, now, now
      );
    }

    // 1. Пересечение: ORDER_IN_AWAITING есть и в completed, и в awaiting_deliver;
    //    ORDER_OUT_OF_STATUS завершён, но уже не в awaiting_deliver -> не попадает;
    //    FOREIGN_ORDER из списка Ozon, но не завершён сотрудником -> не попадает.
    labelCalls.length = 0;
    const pdf = await OrderService.getAllLabels(emp.id);
    assert(Buffer.isBuffer(pdf), 'Должен вернуться Buffer PDF');
    assert.strictEqual(pdf, PDF_BYTES, 'PDF должен прийти как есть из getPackageLabel');
    assert.strictEqual(labelCalls.length, 1, 'getPackageLabel должен вызваться ровно один раз');
    assert.deepStrictEqual(
      labelCalls[0],
      [ORDER_IN_AWAITING],
      'В create должен уйти один номер из пересечения completed ∩ awaiting_deliver'
    );
    console.log('1. Пересечение completed ∩ awaiting_deliver уходит одним массивом');

    // 2. Сотрудник есть в completed, но Ozon не вернул ни одного его заказа
    OzonService.fetchAwaitingDeliverOrders = async () => [{ posting_number: FOREIGN_ORDER }];
    labelCalls.length = 0;
    const noIntersection = await OrderService.getAllLabels(emp.id);
    assert.strictEqual(noIntersection, null, 'Без пересечения должен вернуться null');
    assert.strictEqual(labelCalls.length, 0, 'getPackageLabel не должен вызываться');
    console.log('2. Пустое пересечение -> null (HTTP 404 с текстом), без create');

    // 3. У сотрудника нет завершённых заказов -> список Ozon не запрашивается
    let fetchCalls = 0;
    OzonService.fetchAwaitingDeliverOrders = async () => {
      fetchCalls += 1;
      return [];
    };
    const empty = await OrderService.getAllLabels(emptyEmp.id);
    assert.strictEqual(empty, null, 'Без завершённых заказов должен вернуться null');
    assert.strictEqual(fetchCalls, 0, 'fetchAwaitingDeliverOrders не должен вызываться');
    console.log('3. Нет завершённых заказов -> null без запроса к Ozon');

    console.log('✅ Все проверки пройдены');
  } catch (err) {
    console.error('❌ Smoke-тест провален:', err.message);
    process.exitCode = 1;
  } finally {
    // Восстанавливаем подменённые методы и чистим тестовые данные
    OzonService.fetchAwaitingDeliverOrders = originalFetch;
    OzonService.getPackageLabel = originalGetPackageLabel;
    try {
      if (db) {
        for (const userId of createdUserIds) {
          await db.run('DELETE FROM assignments WHERE user_id = ?', userId);
        }
      }
      for (const userId of createdUserIds) {
        await db.run('DELETE FROM users WHERE id = ?', userId);
      }
      console.log('Тестовые данные удалены');
    } catch (cleanupErr) {
      console.error('Ошибка очистки:', cleanupErr.message);
    }
  }
})();