const OzonService = require('./OzonService');
const { Assignment, UserStats, Earnings, ProductStat } = require('../models');
const User = require('../models/User');
const UserStore = require('../models/UserStore');
const { getStoreDB } = require('../config/database');
const NotificationService = require('./NotificationService');
const {
  finishingOrders,
  pendingFinishConfirmations,
  pendingForms,
  processingOrders,
  productImagesCache,
  orderStateCache,
} = require('../state');
const EarningsService = require('./EarningsService');
const ModelService = require('./ModelService');

// Статусы Ozon, в которых заказ считается «живым» для сотрудника:
//   awaiting_packaging — активный заказ (в работе);
//   awaiting_deliver   — завершён, но этикетка ещё доступна (см. вкладку
//                        «Завершённые заказы»).
const ORDER_STATUS_PACKAGING = 'awaiting_packaging';
const ORDER_STATUS_DELIVER = 'awaiting_deliver';

// Страховочный TTL кэша фотографий (24 часа): записи, которые давно никто не
// запрашивал и которые не принадлежат ни одному «живому» заказу из кэша,
// вычищаются при синхронизации.
const PRODUCT_IMAGES_TTL_MS = 24 * 60 * 60 * 1000;

// ============================================================================
//  Глобальное состояние очереди — per-store.
//  Каждый магазин имеет свой список «новых заказов» и свой флаг «идёт
//  назначение». Ключ — строка storeId.
// ============================================================================
const pendingNewOrdersByStore = new Map();       // storeId -> []
const currentOrderProcessingByStore = new Map(); // storeId -> { order, timestamp } | undefined
const orderAssignRetriesByStore = new Map();     // storeId -> Map<orderId, count>

function getPendingList(storeId) {
  const key = String(storeId);
  if (!pendingNewOrdersByStore.has(key)) pendingNewOrdersByStore.set(key, []);
  return pendingNewOrdersByStore.get(key);
}

function getRetries(storeId) {
  const key = String(storeId);
  if (!orderAssignRetriesByStore.has(key)) orderAssignRetriesByStore.set(key, new Map());
  return orderAssignRetriesByStore.get(key);
}

// ============================================================================
//  Составные ключи in-memory кэшей (state.js): одна и та же строка orderId
//  теоретически может встретиться в двух магазинах — префиксуем storeId.
// ============================================================================
function stateKey(storeId, id) {
  return `${storeId}:${id}`;
}

/**
 * Формирует компактный JSON-слепок деталей заказа для payload оповещения.
 */
function buildOrderNotificationDetails(details) {
  if (!details) return null;
  return {
    order_number: details.order_number || null,
    substatus: details.substatus || null,
    delivery_method: details.delivery_method
      ? {
        name: details.delivery_method.name || null,
        warehouse_id: details.delivery_method.warehouse_id || null,
      }
      : null,
    products: (details.products || []).map((p) => ({
      name: p.name || null,
      sku: p.sku || null,
      offer_id: p.offer_id || null,
      quantity: p.quantity || 1,
      price: p.price?.amount || null,
      currency: p.price?.currency || 'RUB',
    })),
    in_process_at: details.in_process_at || null,
    tracking_number: details.tracking_number || null,
  };
}

class OrderService {
  // =================================================================
  // 1. ОЧИСТКА УСТАРЕВШИХ НАЗНАЧЕНИЙ
  // =================================================================
  static async cleanExpiredAssignments(storeId, activeOrderIds, { userId = null } = {}) {
    console.log(`[OrderService][store ${storeId}] cleanExpiredAssignments начата`);
    const activeSet = new Set(activeOrderIds);
    const db = getStoreDB(storeId);

    // Забираем активные назначения + per-store статус сотрудника (is_fired
    // лежит в user_stores, не в users).
    const assignments = await db.all(
      `SELECT a.order_id, a.user_id, u.tg_user_id, u.name AS employee_name,
              COALESCE(us.is_fired, 0) AS is_fired,
              a.status AS local_status
       FROM assignments a
       LEFT JOIN usersdb.users u ON a.user_id = u.id
       LEFT JOIN usersdb.user_stores us ON us.user_id = a.user_id AND us.store_id = ?
       WHERE a.status = "assigned"${userId ? ' AND a.user_id = ?' : ''}`,
      ...(userId ? [storeId, userId] : [storeId])
    );

    for (const assignment of assignments) {
      const orderId = assignment.order_id;
      const compositeKey = stateKey(storeId, orderId);

      // === 1. Проверка зависших состояний завершения ===
      const finishState = finishingOrders.get(compositeKey);
      if (finishState) {
        const elapsed = Date.now() - finishState.startedAt;
        if (elapsed < 10 * 60 * 1000) {
          console.log(`[CLEAN][store ${storeId}] Заказ ${orderId} в процессе завершения (${Math.round(elapsed / 1000)} сек.), пропускаем`);
          continue;
        }
        console.warn(`[CLEAN][store ${storeId}] Заказ ${orderId} завис в finishingOrders на ${Math.round(elapsed / 60000)} мин. Принудительно удаляем.`);
        finishingOrders.delete(compositeKey);
        pendingFinishConfirmations.delete(compositeKey);
      }

      const confirmState = pendingFinishConfirmations.get(compositeKey);
      if (confirmState) {
        if (!confirmState.startedAt) {
          console.warn(`[CLEAN][store ${storeId}] Заказ ${orderId} имеет pendingFinishConfirmations без startedAt. Удаляем.`);
          pendingFinishConfirmations.delete(compositeKey);
        } else {
          const elapsed = Date.now() - confirmState.startedAt;
          if (elapsed > 10 * 60 * 1000) {
            console.warn(`[CLEAN][store ${storeId}] Заказ ${orderId} имеет зависшее pendingFinishConfirmations (${Math.round(elapsed / 60000)} мин), удаляем.`);
            pendingFinishConfirmations.delete(compositeKey);
          } else {
            console.log(`[CLEAN][store ${storeId}] Заказ ${orderId} ожидает подтверждения, пропускаем`);
            continue;
          }
        }
      }

      // === 2. Если заказ всё ещё в awaiting_packaging — пропускаем ===
      if (activeSet.has(orderId)) continue;

      // === 3. Если заказ уже завершён в БД — пропускаем ===
      if (assignment.local_status === 'completed') {
        console.log(`[CLEAN][store ${storeId}] Заказ ${orderId} уже завершён (status=completed), пропускаем`);
        continue;
      }

      const freshStatus = await db.get(
        'SELECT status FROM assignments WHERE order_id = ?',
        orderId
      );
      if (freshStatus && freshStatus.status === 'completed') {
        console.log(`[CLEAN][store ${storeId}] Заказ ${orderId} уже завершён (повторная проверка), пропускаем`);
        continue;
      }

      // === 4. Если сотрудник отсутствует или уволен — снимаем заказ ===
      if (!assignment.employee_name || assignment.is_fired === 1) {
        console.warn(`[CLEAN][store ${storeId}] Заказ ${orderId} назначен на некорректного сотрудника (user_id=${assignment.user_id}), снимаем`);
        await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);

        NotificationService.notifyStaff('order_unassigned', {
          orderId,
          auto: true,
          reason: 'Сотрудник отсутствует или уволен',
          userName: assignment.employee_name || 'не найден',
        }, { storeId });
        NotificationService.notifyUser(assignment.user_id, 'order_unassigned', {
          orderId,
          auto: true,
          reason: 'Сотрудник отсутствует или уволен',
        }, { storeId });
        this.forgetOrderState(storeId, orderId, { prunePhotos: true });
        continue;
      }

      // === 5. Стандартное удаление: заказ больше не в awaiting_packaging ===
      console.log(`[CLEAN][store ${storeId}] Заказ ${orderId} больше не в awaiting_packaging, отменяем назначение у ${assignment.employee_name}`);
      await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);

      NotificationService.notifyStaff('order_unassigned', {
        orderId,
        auto: true,
        reason: 'Заказ более не актуален (не в awaiting_packaging)',
        userName: assignment.employee_name,
      }, { storeId });
      NotificationService.notifyUser(assignment.user_id, 'order_unassigned', {
        orderId,
        auto: true,
        reason: 'Заказ более не актуален',
      }, { storeId });
      this.forgetOrderState(storeId, orderId, { prunePhotos: true });
    }

    console.log(`[OrderService][store ${storeId}] cleanExpiredAssignments завершена`);
  }

  // =================================================================
  // 2. ПРОВЕРКА НОВЫХ ЗАКАЗОВ
  // =================================================================
  static async checkNewOrders(storeId) {
    console.log(`[OrderService][store ${storeId}] Проверка новых заказов...`);
    try {
      const allOrders = await OzonService.fetchAwaitingOrders(storeId);
      const activeOrderIds = allOrders.map(o => o.posting_number);
      await OrderService.cleanExpiredAssignments(storeId, activeOrderIds);

      const pending = getPendingList(storeId);
      const storeKey = String(storeId);

      if (!allOrders.length) {
        if (pending.length === 0) {
          currentOrderProcessingByStore.delete(storeKey);
        }
        return;
      }

      const db = getStoreDB(storeId);
      const assignedOrderIds = (await db.all('SELECT order_id FROM assignments WHERE status = "assigned"'))
        .map(r => r.order_id);
      const assignedSet = new Set(assignedOrderIds);

      const newOrders = allOrders.filter(order => !assignedSet.has(order.posting_number));
      if (!newOrders.length) return;

      // Текущий обрабатываемый заказ: если он больше не в списке — сбрасываем
      const current = currentOrderProcessingByStore.get(storeKey);
      const currentOrderId = current?.order?.posting_number;
      if (currentOrderId && !newOrders.some(o => o.posting_number === currentOrderId)) {
        console.log(`[CHECK][store ${storeId}] Текущий заказ ${currentOrderId} больше не в awaiting_packaging, сбрасываем`);
        currentOrderProcessingByStore.delete(storeKey);
      }

      // Обновляем per-store очередь
      pendingNewOrdersByStore.set(storeKey, newOrders);
      console.log(`[CHECK][store ${storeId}] Очередь обновлена, заказов: ${newOrders.length}`);

      NotificationService.notifyStaff(
        'new_orders_available',
        {
          count: newOrders.length,
          orders: newOrders.map(o => ({
            posting_number: o.posting_number,
            products_count: o.products?.length || 0,
          })),
        },
        {
          storeId,
          roles: ['moderator'],
          replaceUnreadType: 'new_orders_available',
          push: false,
        },
      );

      // Если нет активного заказа и есть заказы – берём первый
      if (!currentOrderProcessingByStore.has(storeKey) && newOrders.length) {
        currentOrderProcessingByStore.set(storeKey, { order: newOrders[0], timestamp: Date.now() });
      }

    } catch (err) {
      console.error(`[OrderService][store ${storeId}] Ошибка checkNewOrders:`, err);
      throw err;
    }
  }

  // =================================================================
  // 3. НАЗНАЧЕНИЕ ЗАКАЗА
  // =================================================================
  static async assignOrder(storeId, orderId, userId, adminId = null) {
    const compositeKey = stateKey(storeId, orderId);
    const storeKey = String(storeId);
    const pending = getPendingList(storeId);

    // Блокировка
    if (processingOrders.has(compositeKey)) {
      console.log(`[ASSIGN][store ${storeId}] Заказ ${orderId} уже обрабатывается, пропускаем.`);
      throw new Error('Заказ уже обрабатывается');
    }
    processingOrders.add(compositeKey);

    let queuedOrder = null;
    const queueIndex = pending.findIndex(o => o.posting_number === orderId);
    if (queueIndex !== -1) {
      queuedOrder = pending.splice(queueIndex, 1)[0];
      console.log(`[ASSIGN][store ${storeId}] Заказ ${orderId} удалён из очереди`);
    }
    const current = currentOrderProcessingByStore.get(storeKey);
    if (current?.order?.posting_number === orderId) {
      currentOrderProcessingByStore.delete(storeKey);
    }

    let assignedInDb = false;
    let employee = null;
    let orderDetails = null;

    try {
      // Проверка сотрудника
      employee = await User.getById(userId);
      if (!employee) throw new Error(`Сотрудник с ID ${userId} не найден.`);

      // Per-store статус: запись в user_stores обязательна (иначе человек не
      // числится сотрудником этого магазина) и is_fired должен быть 0.
      const storeRecord = await UserStore.get(userId, storeId);
      if (!storeRecord) {
        throw new Error(`Пользователь ${employee.name} не привязан к магазину ${storeId}.`);
      }
      if (storeRecord.is_fired) {
        throw new Error(`Сотрудник ${employee.name} уволен в магазине ${storeId}.`);
      }

      // Создателю ('god') заказы не назначаются — он вне списков сотрудников.
      // Исключение: Создатель может назначить заказ самому себе (для тестов).
      if (employee.role === 'god') {
        if (!adminId || adminId !== userId) {
          throw new Error(`Заказ нельзя назначить Создателю.`);
        }
      }

      // Получение деталей заказа (per-store клиент Ozon)
      orderDetails = await OzonService.getOrderDetails(storeId, orderId);
      if (!orderDetails) throw new Error(`Не удалось получить детали заказа ${orderId}.`);

      // Очистка старых состояний
      await this.clearOrderState(storeId, orderId);

      // Назначение в БД (store-N.db)
      await Assignment.assign(storeId, orderId, userId);
      assignedInDb = true;
      console.log(`[ASSIGN][store ${storeId}] Заказ ${orderId} записан в БД за сотрудником ${employee.name}`);

      // Снимок заказа в кэше
      this.cacheOrderState(storeId, orderId, {
        userId,
        status: orderDetails.status || ORDER_STATUS_PACKAGING,
        details: orderDetails,
        assignedAt: Date.now(),
        completedAt: null,
      });

      // === ПРОВЕРКА СТАТИСТИКИ (per-store product_stats) ===
      const missingStats = [];
      for (const product of orderDetails.products || []) {
        const offerId = product.offer_id;
        if (!offerId) continue;
        const stats = await ProductStat.get(storeId, offerId);
        if (!stats) missingStats.push(offerId);
      }

      // === ОПОВЕЩЕНИЕ О НАЗНАЧЕНИИ ===
      const adminUser = adminId ? await User.getById(adminId) : null;
      const assignPayload = {
        orderId,
        userId,
        userName: employee.name,
        adminId: adminId || null,
        adminName: adminUser?.name || (adminId ? String(adminId) : null),
        missingStats,
        details: buildOrderNotificationDetails(orderDetails),
      };
      NotificationService.notifyUser(userId, 'order_assigned', assignPayload, { storeId });
      NotificationService.notifyStaff('order_assigned', assignPayload, { storeId });

      // === 3D-МОДЕЛИ ===
      // Модели и их выдача глобальны (models.db), но если магазин отключил
      // модели (DISABLE_MODELS=true) — пропускаем выдачу.
      let modelsSummary = null;
      const store = require('../config/stores').getStore(storeId);
      if (!store.features.disableModels) {
        try {
          modelsSummary = await ModelService.issueForAssignment(
            orderId,
            userId,
            employee,
            orderDetails,
            { storeId },
          );
        } catch (modelsErr) {
          console.error(`[ASSIGN][store ${storeId}] Ошибка выдачи 3D-моделей для ${orderId}:`, modelsErr);
          NotificationService.notifyStaff('order_assign_error', {
            orderId,
            error: `Выдача 3D-моделей: ${modelsErr.message}`,
            userName: employee.name,
          }, { storeId });
        }
      }

      getRetries(storeId).delete(orderId);
      console.log(`[ASSIGN][store ${storeId}] Заказ ${orderId} успешно назначен сотруднику ${employee.name} (ID ${employee.id})`);
      return { success: true, employee };

    } catch (err) {
      console.error(`[ASSIGN][store ${storeId}] Ошибка назначения заказа ${orderId}:`, err);

      if (assignedInDb) {
        console.error(`[ASSIGN][store ${storeId}] Заказ ${orderId} уже назначен в БД, в очередь не возвращаем.`);
        NotificationService.notifyStaff('order_assign_error', {
          orderId,
          error: err.message,
          userName: employee?.name || userId,
        }, { storeId });
        NotificationService.logServerError('OrderService.assignOrder', err, {
          storeId, orderId, phase: 'after_db_write',
        });
      } else {
        const retriesMap = getRetries(storeId);
        let retries = retriesMap.get(orderId) || 0;
        retries++;
        retriesMap.set(orderId, retries);

        if (retries <= 3) {
          if (!pending.some(o => o.posting_number === orderId)) {
            if (!queuedOrder) {
              try {
                queuedOrder = await OzonService.fetchAwaitingOrdersById(storeId, orderId);
              } catch (e) {
                queuedOrder = { posting_number: orderId, products: [] };
              }
            }
            if (queuedOrder) {
              pending.unshift(queuedOrder);
              console.log(`[ASSIGN][store ${storeId}] Заказ ${orderId} возвращён в очередь (попытка ${retries}/3).`);
            }
          }
        } else {
          console.error(`[ASSIGN][store ${storeId}] Заказ ${orderId} не удалось назначить после 3 попыток.`);
          NotificationService.notifyStaff('order_assign_failed', {
            orderId,
            error: err.message,
            attempts: retries,
          }, { storeId });
          NotificationService.logServerError('OrderService.assignOrder', err, {
            storeId, orderId, attempts: retries,
          });
          retriesMap.delete(orderId);
        }
      }
      throw err;
    } finally {
      processingOrders.delete(compositeKey);
      console.log(`[ASSIGN][store ${storeId}] Блокировка для ${orderId} снята.`);
    }
  }

  // =================================================================
  // 4. ЗАВЕРШЕНИЕ ЗАКАЗА
  // =================================================================
  static async finishOrder(storeId, orderId, userId) {
    console.log(`[FINISH][store ${storeId}] === Начало завершения заказа ${orderId} сотрудником ${userId} ===`);
    let transactionCompleted = false;
    const compositeKey = stateKey(storeId, orderId);

    try {
      const db = getStoreDB(storeId);
      const assignment = await db.get(
        'SELECT status FROM assignments WHERE order_id = ? AND user_id = ? AND status = "assigned"',
        orderId, userId
      );
      if (!assignment) {
        throw new Error(`Заказ ${orderId} уже завершён или не найден.`);
      }

      const user = await User.getById(userId);
      if (!user) throw new Error('Пользователь не найден');

      // Для расчёта заработка нужен per-store коэффициент
      const storeRecord = await UserStore.get(userId, storeId);
      const earningsFactor = storeRecord?.earnings_factor ?? 1.0;

      // 1. Сумма заказа
      const orderAmount = await OzonService.getOrderTotalAmount(storeId, orderId);
      console.log(`[FINISH][store ${storeId}] Сумма заказа: ${orderAmount}`);

      // 2. Расчёт заработка
      const orderDetails = await OzonService.getOrderDetails(storeId, orderId);
      let earningsData = null;
      if (orderDetails && orderDetails.products) {
        earningsData = await EarningsService.calculateOrderEarnings(
          storeId, orderDetails, { ...user, earnings_factor: earningsFactor }
        );
        if (!earningsData.allHaveStats) {
          console.warn(`[FINISH][store ${storeId}] Не все товары имеют статистику для заказа ${orderId}`);
        }
      }

      // 3. Подтверждение сборки
      let labelBuffer = null;
      try {
        await OzonService.confirmPostingShip(storeId, orderId);
      } catch (shipError) {
        if (shipError.message && shipError.message.includes('не в статусе awaiting_packaging')) {
          console.warn(`[FINISH][store ${storeId}] Заказ ${orderId} уже подтверждён (статус не awaiting_packaging)`);
        } else {
          throw shipError;
        }
      }

      labelBuffer = await OzonService.getPackageLabel(storeId, orderId);

      // ========== ТРАНЗАКЦИЯ БД (store-N.db) ==========
      await db.run('BEGIN TRANSACTION');
      try {
        await UserStats.incrementStats(storeId, userId, orderAmount);

        if (earningsData && earningsData.total > 0) {
          const existing = await db.get('SELECT id FROM earnings_history WHERE order_id = ?', orderId);
          if (!existing) {
            await Earnings.saveHistory(storeId, userId, orderId, earningsData.total);
            await Earnings.saveActive(storeId, userId, orderId, earningsData.total);
          }
        }

        await Assignment.complete(storeId, orderId, {
          orderAmount,
          products: orderDetails?.products || null,
        });

        await db.run('COMMIT');
        transactionCompleted = true;
        console.log(`[FINISH][store ${storeId}] Транзакция закоммичена для заказа ${orderId}`);
      } catch (txError) {
        await db.run('ROLLBACK');
        console.error(`[FINISH][store ${storeId}] Ошибка в транзакции для заказа ${orderId}:`, txError);
        throw txError;
      }

      // === СИНХРОНИЗАЦИЯ С OZON ПОСЛЕ ЗАВЕРШЕНИЯ ===
      this.cacheOrderState(storeId, orderId, {
        userId,
        status: ORDER_STATUS_DELIVER,
        details: orderDetails || null,
        completedAt: Date.now(),
      });
      try {
        const freshDetails = await OzonService.getOrderDetails(storeId, orderId);
        if (freshDetails) {
          this.cacheOrderState(storeId, orderId, {
            status: freshDetails.status || ORDER_STATUS_DELIVER,
            details: freshDetails,
          });
          if (freshDetails.status && freshDetails.status !== ORDER_STATUS_DELIVER) {
            console.warn(
              `[FINISH][store ${storeId}] Заказ ${orderId} после подтверждения сборки в статусе "${freshDetails.status}" ` +
              `(ожидался awaiting_deliver) — этикетка может быть недоступна`
            );
          }
        }
      } catch (syncErr) {
        console.error(`[FINISH][store ${storeId}] Не удалось синхронизировать статус заказа ${orderId}:`, syncErr.message);
        NotificationService.logServerError('OrderService.finishOrder.sync', syncErr, { storeId, orderId });
      }

      const finishedPayload = {
        orderId,
        labelAvailable: !!labelBuffer,
        earnings: earningsData?.total || 0,
        earningsDetails: (earningsData?.details || []).map((item) => ({
          offerId: item.offerId,
          productName: item.productName,
          material: item.material,
          weight: item.weight,
          quantity: item.quantity,
          earningsPerUnit: item.earningsPerUnit,
          totalForProduct: item.totalForProduct,
          isSpecial: item.isSpecial,
        })),
      };
      NotificationService.notifyUser(userId, 'order_finished', finishedPayload, { storeId });
      NotificationService.notifyStaff('order_finished', {
        orderId,
        userId,
        userName: user.name,
        ...finishedPayload,
      }, { storeId });

      await this.clearOrderState(storeId, orderId);

      console.log(`[FINISH][store ${storeId}] === Заказ ${orderId} успешно завершён ===`);
      return { success: true, earnings: earningsData?.total || 0, labelAvailable: !!labelBuffer };

    } catch (err) {
      console.error(`[FINISH][store ${storeId}] Ошибка при завершении заказа ${orderId}:`, err);
      throw err;
    } finally {
      if (!transactionCompleted) {
        console.log(`[FINISH][store ${storeId}] Принудительно удаляем флаги для ${orderId}`);
        finishingOrders.delete(compositeKey);
        pendingFinishConfirmations.delete(compositeKey);
      }
    }
  }

  // =================================================================
  // 5. ОТМЕНА ЗАКАЗА
  // =================================================================
  static async cancelOrder(storeId, orderId, userId) {
    console.log(`[CANCEL][store ${storeId}] Отмена заказа ${orderId} пользователем ${userId}`);
    const db = getStoreDB(storeId);

    const assignment = await db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND user_id = ? AND status = "assigned"',
      orderId, userId
    );
    if (!assignment) throw new Error('Заказ не найден или не назначен вам');

    await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);
    this.forgetOrderState(storeId, orderId);
    await UserStats.incrementCanceled(storeId, userId);

    const cancelledUser = await User.getById(userId);
    NotificationService.notifyUser(userId, 'order_cancelled', { orderId }, { storeId });
    NotificationService.notifyStaff('order_cancelled', {
      orderId,
      userId,
      userName: cancelledUser?.name || userId,
    }, { storeId });

    await this.reloadQueue(storeId);
    return { success: true };
  }

  static async unassignOrder(storeId, orderId, adminId) {
    console.log(`[UNASSIGN][store ${storeId}] Снятие заказа ${orderId} администратором ${adminId}`);
    const db = getStoreDB(storeId);

    const assignment = await db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND status = "assigned"',
      orderId
    );
    if (!assignment) throw new Error('Заказ не назначен');

    const userId = assignment.user_id;
    await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);
    this.forgetOrderState(storeId, orderId);

    const unassignedUser = await User.getById(userId);
    NotificationService.notifyUser(userId, 'order_unassigned', {
      orderId,
      auto: false,
      reason: 'Снят администратором',
    }, { storeId });
    NotificationService.notifyStaff('order_unassigned', {
      orderId,
      userId,
      adminId,
      userName: unassignedUser?.name || userId,
      reason: 'Снят администратором',
    }, { storeId });

    await this.reloadQueue(storeId);
    return { success: true };
  }

  // =================================================================
  // 6. ПОЛУЧЕНИЕ ЭТИКЕТКИ
  // =================================================================
  static async getLabel(storeId, orderId, userId) {
    const db = getStoreDB(storeId);
    const assignment = await db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND user_id = ? AND status = "completed"',
      orderId, userId
    );
    if (!assignment) throw new Error('Заказ не найден или не завершён');

    const details = await OzonService.getOrderDetails(storeId, orderId);
    if (!details || details.status !== 'awaiting_deliver') {
      throw new Error('Этикетка ещё не доступна');
    }
    return await OzonService.getPackageLabel(storeId, orderId);
  }

  static async getAllLabels(storeId, userId) {
    const db = getStoreDB(storeId);
    const completed = await db.all(
      'SELECT order_id FROM assignments WHERE user_id = ? AND status = "completed"',
      userId
    );
    if (!completed.length) return null;

    let awaitingDeliver;
    try {
      awaitingDeliver = await OzonService.fetchAwaitingDeliverOrders(storeId);
    } catch (err) {
      console.error(`[getAllLabels][store ${storeId}] Не удалось получить заказы awaiting_deliver из Ozon:`, err.message);
      throw new Error(`Не удалось получить список заказов из Ozon: ${err.message}`);
    }

    const completedIds = new Set(completed.map((o) => o.order_id));
    const postingNumbers = awaitingDeliver
      .map((o) => o.posting_number)
      .filter((n) => completedIds.has(n))
      .slice(0, 1000);
    if (!postingNumbers.length) {
      console.log(`[getAllLabels][store ${storeId}] У сотрудника ${userId} нет завершённых заказов в статусе awaiting_deliver`);
      return null;
    }
    console.log(`[getAllLabels][store ${storeId}] Запрос склейки этикеток для ${postingNumbers.length} отправлений`);
    return await OzonService.getPackageLabel(storeId, postingNumbers);
  }

  // =================================================================
  // 7. ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ДЛЯ РАБОТЫ С ОЧЕРЕДЬЮ
  // =================================================================
  static getCurrentOrder(storeId) {
    const cur = currentOrderProcessingByStore.get(String(storeId));
    return cur?.order || null;
  }

  static getPendingOrders(storeId) {
    return pendingNewOrdersByStore.get(String(storeId)) || [];
  }

  static async reloadQueue(storeId) {
    console.log(`[OrderService][store ${storeId}] Принудительная перезагрузка очереди`);
    pendingNewOrdersByStore.set(String(storeId), []);
    currentOrderProcessingByStore.delete(String(storeId));
    await this.checkNewOrders(storeId);
  }

  // =================================================================
  // 7.5 ПРИВЯЗКА ФОТОГРАФИЙ К ТОВАРАМ (per-store кэш)
  // =================================================================
  static async attachProductImages(storeId, products) {
    if (!Array.isArray(products) || !products.length) return products || [];

    const needSkus = new Set();

    for (const p of products) {
      if (p.offer_id) {
        const key = stateKey(storeId, String(p.offer_id));
        const cached = productImagesCache.get(key);
        if (cached && cached.images && cached.images.length) {
          p.images = cached.images.map(url => ({ url, name: p.name }));
          cached.updatedAt = Date.now();
        } else if (p.sku) {
          needSkus.add(String(p.sku));
        }
      } else if (p.sku) {
        needSkus.add(String(p.sku));
      }
    }

    if (needSkus.size) {
      const imageMap = await OzonService.fetchProductsImages(storeId, Array.from(needSkus));
      for (const p of products) {
        if (p.images || !p.sku) continue;
        const urls = imageMap[String(p.sku)];
        if (!urls || !urls.length) continue;
        p.images = urls.map(url => ({ url, name: p.name }));
        if (p.offer_id) {
          productImagesCache.set(stateKey(storeId, String(p.offer_id)), {
            sku: String(p.sku),
            images: urls,
            updatedAt: Date.now(),
          });
        }
      }
    }

    for (const p of products) {
      if (!p.images) p.images = [];
    }

    return products;
  }

  // =================================================================
  // 7.5.1 ПРИВЯЗКА СТАТИСТИКИ ТОВАРА
  // =================================================================
  static async attachProductStats(storeId, products) {
    if (!Array.isArray(products) || !products.length) return products || [];
    for (const p of products) {
      if (!p || !p.offer_id) {
        if (p) p.stats = null;
        continue;
      }
      const stat = await ProductStat.get(storeId, p.offer_id);
      p.stats = stat
        ? {
          material: stat.material,
          color: stat.color,
          weight_grams: stat.weight_grams,
        }
        : null;
    }
    return products;
  }

  // =================================================================
  // 7.6 КЭШ СОСТОЯНИЯ ЗАКАЗОВ
  // =================================================================
  static cacheOrderState(storeId, orderId, patch = {}) {
    if (!orderId) return null;
    const key = stateKey(storeId, orderId);
    const prev = orderStateCache.get(key) || {};
    const next = { ...prev, ...patch, storeId: String(storeId), orderId: String(orderId), updatedAt: Date.now() };
    orderStateCache.set(key, next);
    return next;
  }

  static getOrderState(storeId, orderId) {
    if (!orderId) return null;
    return orderStateCache.get(stateKey(storeId, orderId)) || null;
  }

  static forgetOrderState(storeId, orderId, { prunePhotos = false } = {}) {
    if (!orderId) return;
    const key = stateKey(storeId, orderId);
    const state = orderStateCache.get(key);
    orderStateCache.delete(key);
    if (prunePhotos && state) {
      this.pruneProductImagesCache(storeId, new Set(this.offerIdsOfState(state)));
    }
  }

  static offerIdsOfState(state) {
    const products = state && state.details ? state.details.products : null;
    if (!Array.isArray(products)) return [];
    return products
      .map((p) => (p && p.offer_id ? String(p.offer_id) : null))
      .filter(Boolean);
  }

  static cloneProducts(products) {
    return (products || []).map((p) => ({ ...p }));
  }

  static async resolveOrderDetails(storeId, orderId, { forceFresh = false } = {}) {
    const cached = this.getOrderState(storeId, orderId);
    if (!forceFresh && cached && cached.details) return cached;
    const details = await OzonService.getOrderDetails(storeId, orderId);
    if (!details) return cached;
    return this.cacheOrderState(storeId, orderId, {
      status: details.status || (cached ? cached.status : null),
      details,
    });
  }

  static async buildActiveOrders(storeId, userId) {
    const orders = await Assignment.getActiveOrders(storeId, userId);
    const result = [];
    for (const order of orders) {
      let state = await this.resolveOrderDetails(storeId, order.order_id);
      state = this.cacheOrderState(storeId, order.order_id, {
        userId,
        assignedAt: order.assigned_at,
        status: (state && state.status) || ORDER_STATUS_PACKAGING,
      });

      const details = state.details || null;
      let statsStatus = 'filled';
      const missingStats = [];
      if (details && Array.isArray(details.products)) {
        for (const p of details.products) {
          if (!p.offer_id) continue;
          const stat = await ProductStat.get(storeId, p.offer_id);
          if (!stat) {
            statsStatus = 'missing';
            missingStats.push(p.offer_id);
          }
        }
      }
      const products = await this.attachProductImages(storeId, this.cloneProducts(details?.products));

      // Модели: только если магазин не отключил их
      const store = require('../config/stores').getStore(storeId);
      if (!store.features.disableModels) {
        await ModelService.attachToProducts(products);
      } else {
        for (const p of products) p.model = null;
      }

      await this.attachProductStats(storeId, products);
      result.push({
        orderId: order.order_id,
        assignedAt: order.assigned_at,
        statsStatus,
        missingStats,
        products,
      });
    }
    return result;
  }

  static async buildCompletedOrdersAwaitingDeliver(storeId, userId) {
    const db = getStoreDB(storeId);
    const rows = await db.all(
      `SELECT order_id, completed_at FROM assignments
       WHERE user_id = ? AND status = 'completed'
         AND earnings_revoked_at IS NULL
       ORDER BY completed_at DESC`,
      userId
    );
    if (!rows.length) return [];

    const needsStatus = (orderId) => {
      const state = this.getOrderState(storeId, orderId);
      return !state || !state.status;
    };
    let awaitingDeliverSet = null;
    if (rows.some((row) => needsStatus(row.order_id))) {
      try {
        const postings = await OzonService.fetchAwaitingDeliverOrders(storeId);
        awaitingDeliverSet = new Set(
          (postings || []).map((p) => p && p.posting_number).filter(Boolean)
        );
      } catch (err) {
        console.error(`[COMPLETED][store ${storeId}] Не удалось получить заказы awaiting_deliver из Ozon:`, err.message);
      }
    }

    const result = [];
    for (const row of rows) {
      let state = this.getOrderState(storeId, row.order_id);
      let status = state ? state.status : null;
      if ((!state || !status) && awaitingDeliverSet) {
        status = awaitingDeliverSet.has(row.order_id) ? ORDER_STATUS_DELIVER : 'other';
      }
      if (!status) continue;

      state = this.cacheOrderState(storeId, row.order_id, {
        userId,
        status,
        completedAt: row.completed_at,
      });
      if (status !== ORDER_STATUS_DELIVER) continue;

      if (!state.details) {
        state = await this.resolveOrderDetails(storeId, row.order_id);
      }
      const products = await this.attachProductImages(storeId, this.cloneProducts(state?.details?.products));
      await this.attachProductStats(storeId, products);
      result.push({
        orderId: row.order_id,
        completedAt: row.completed_at,
        products,
      });
    }
    return result;
  }

  static async syncOrderStatuses(storeId) {
    const [packaging, deliver] = await Promise.all([
      OzonService.fetchAwaitingOrders(storeId),
      OzonService.fetchAwaitingDeliverOrders(storeId),
    ]);

    const statusByOrderId = new Map();
    for (const order of packaging || []) {
      if (order && order.posting_number) {
        statusByOrderId.set(String(order.posting_number), ORDER_STATUS_PACKAGING);
      }
    }
    for (const order of deliver || []) {
      if (order && order.posting_number) {
        statusByOrderId.set(String(order.posting_number), ORDER_STATUS_DELIVER);
      }
    }

    // Чистим только записи ЭТОГО магазина
    const prefix = `${storeId}:`;
    let checked = 0;
    let removed = 0;
    const removedOfferIds = new Set();
    for (const [key, state] of Array.from(orderStateCache.entries())) {
      if (!key.startsWith(prefix)) continue;
      checked++;
      const orderId = key.slice(prefix.length);
      const status = statusByOrderId.get(orderId);
      if (!status) {
        for (const offerId of this.offerIdsOfState(state)) removedOfferIds.add(offerId);
        orderStateCache.delete(key);
        removed++;
        continue;
      }
      if (state.status !== status) {
        this.cacheOrderState(storeId, orderId, { status });
      }
    }

    let photosRemoved = this.pruneProductImagesCache(storeId, removedOfferIds);
    photosRemoved += this.pruneStaleProductImages(storeId);

    const activeOrderIds = [];
    for (const [orderId, status] of statusByOrderId) {
      if (status === ORDER_STATUS_PACKAGING) activeOrderIds.push(orderId);
    }

    if (removed || photosRemoved) {
      console.log(
        `[SYNC][store ${storeId}] Статусы заказов: проверено ${checked}, убрано из кэша ${removed}, ` +
        `удалено фото ${photosRemoved}`
      );
    }

    return { checked, removed, photosRemoved, activeOrderIds };
  }

  static pruneProductImagesCache(storeId, candidateOfferIds) {
    if (!candidateOfferIds || candidateOfferIds.size === 0) return 0;
    const stillUsed = this.collectCachedOfferIds(storeId);
    let removed = 0;
    for (const offerId of candidateOfferIds) {
      if (stillUsed.has(offerId)) continue;
      if (productImagesCache.delete(stateKey(storeId, offerId))) removed++;
    }
    return removed;
  }

  static pruneStaleProductImages(storeId, now = Date.now()) {
    const stillUsed = this.collectCachedOfferIds(storeId);
    const prefix = `${storeId}:`;
    let removed = 0;
    for (const [key, entry] of Array.from(productImagesCache.entries())) {
      if (!key.startsWith(prefix)) continue;
      const offerId = key.slice(prefix.length);
      if (stillUsed.has(offerId)) continue;
      const updatedAt = entry && entry.updatedAt ? entry.updatedAt : 0;
      if (now - updatedAt < PRODUCT_IMAGES_TTL_MS) continue;
      productImagesCache.delete(key);
      removed++;
    }
    return removed;
  }

  static collectCachedOfferIds(storeId) {
    const offerIds = new Set();
    const prefix = `${storeId}:`;
    for (const [key, state] of orderStateCache.entries()) {
      if (!key.startsWith(prefix)) continue;
      for (const offerId of this.offerIdsOfState(state)) offerIds.add(offerId);
    }
    return offerIds;
  }

  // =================================================================
  // 8. ОЧИСТКА СОСТОЯНИЙ ЗАКАЗА
  // =================================================================
  static async clearOrderState(storeId, orderId, userId = null) {
    console.log(`[CLEAR][store ${storeId}] Начало очистки заказа ${orderId}${userId ? ` для пользователя ${userId}` : ''}`);
    const compositeKey = stateKey(storeId, orderId);

    if (userId) {
      const key = `${storeId}_${userId}_${orderId}`;
      if (pendingForms.has(key)) pendingForms.delete(key);
    } else {
      const prefix = `${storeId}_`;
      for (const [key, state] of pendingForms) {
        if (key.startsWith(prefix) && state.orderId === orderId) {
          pendingForms.delete(key);
          break;
        }
      }
    }

    if (pendingFinishConfirmations.has(compositeKey)) pendingFinishConfirmations.delete(compositeKey);
    if (finishingOrders.has(compositeKey)) finishingOrders.delete(compositeKey);

    console.log(`[CLEAR][store ${storeId}] Завершена очистка заказа ${orderId}`);
  }
}

module.exports = OrderService;