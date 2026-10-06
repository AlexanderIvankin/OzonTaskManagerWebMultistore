const OzonService = require('./OzonService');
const { Assignment, UserStats, Earnings, ProductStat, User } = require('../models');
const { getDB } = require('../config/database');
const NotificationService = require('./NotificationService');
const { escapeHtml } = require('../utils');
const { finishingOrders, pendingFinishConfirmations, pendingForms, processingOrders, productImagesCache, orderStateCache } = require('../state');
const EarningsService = require('./EarningsService');
const ModelService = require('./ModelService');

// Статусы Ozon, в которых заказ считается «живым» для сотрудника:
//   awaiting_packaging — активный заказ (в работе);
//   awaiting_deliver   — завершён, но этикетка ещё доступна (см. вкладку
//                        «Завершённые заказы»).
// Пока заказ в одном из них, в orderStateCache хранятся его детали и статус,
// а в productImagesCache — фотографии товаров.
const ORDER_STATUS_PACKAGING = 'awaiting_packaging';
const ORDER_STATUS_DELIVER = 'awaiting_deliver';

// Страховочный TTL кэша фотографий (24 часа): записи, которые давно никто не
// запрашивал и которые не принадлежат ни одному «живому» заказу из кэша,
// вычищаются при синхронизации — иначе фото отменённых/зависших заказов
// оставались бы в памяти до перезапуска сервера.
const PRODUCT_IMAGES_TTL_MS = 24 * 60 * 60 * 1000;

// Глобальное состояние очереди (в памяти)
let pendingNewOrders = [];
let currentOrderProcessing = null;
let orderAssignRetries = new Map();

// Конфигурация материалов и минимального заработка загружается внутри
// EarningsService (MaterialsService) — здесь дубликаты не нужны.

/**
 * Формирует компактный JSON-слепок деталей заказа для payload оповещения
 * (по мотивам formatOrderDetails из commands.js, но в структурированном виде).
 * Сохраняется в notifications.db -> payload и участвует в поиске по offer_id.
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
  // 1. ОЧИСТКА УСТАРЕВШИХ НАЗНАЧЕНИЙ (из bot.js)
  // =================================================================
  static async cleanExpiredAssignments(activeOrderIds, { userId = null } = {}) {
    console.log('[OrderService] cleanExpiredAssignments начата');
    const activeSet = new Set(activeOrderIds);
    const db = getDB();

    // Получаем все активные назначения с LEFT JOIN на users.
    // userId (опционально) ограничивает проверку одним сотрудником — так
    // вызывается авто-снятие из интерфейса (кнопка «Обновить»), чтобы кнопка
    // одного сотрудника не снимала заказы у остальных.
    const assignments = await db.all(
      `SELECT a.order_id, a.user_id, u.tg_user_id, u.name as employee_name,
            u.is_fired, a.status as local_status
     FROM assignments a
     LEFT JOIN users u ON a.user_id = u.id
     WHERE a.status = "assigned"${userId ? ' AND a.user_id = ?' : ''}`,
      ...(userId ? [userId] : [])
    );

    for (const assignment of assignments) {
      const orderId = assignment.order_id;

      // === 1. Проверка зависших состояний завершения ===
      const finishState = finishingOrders.get(orderId);
      if (finishState) {
        const elapsed = Date.now() - finishState.startedAt;
        if (elapsed < 10 * 60 * 1000) {
          console.log(`[CLEAN] Заказ ${orderId} в процессе завершения (${Math.round(elapsed / 1000)} сек.), пропускаем`);
          continue;
        }
        console.warn(`[CLEAN] Заказ ${orderId} завис в finishingOrders на ${Math.round(elapsed / 60000)} мин. Принудительно удаляем.`);
        finishingOrders.delete(orderId);
        pendingFinishConfirmations.delete(orderId);
      }

      const confirmState = pendingFinishConfirmations.get(orderId);
      if (confirmState) {
        if (!confirmState.startedAt) {
          console.warn(`[CLEAN] Заказ ${orderId} имеет pendingFinishConfirmations без startedAt. Удаляем.`);
          pendingFinishConfirmations.delete(orderId);
        } else {
          const elapsed = Date.now() - confirmState.startedAt;
          if (elapsed > 10 * 60 * 1000) {
            console.warn(`[CLEAN] Заказ ${orderId} имеет зависшее pendingFinishConfirmations (${Math.round(elapsed / 60000)} мин), удаляем.`);
            pendingFinishConfirmations.delete(orderId);
          } else {
            console.log(`[CLEAN] Заказ ${orderId} ожидает подтверждения, пропускаем`);
            continue;
          }
        }
      }

      // === 2. Если заказ всё ещё в awaiting_packaging — пропускаем ===
      if (activeSet.has(orderId)) {
        continue;
      }

      // === 3. Если заказ уже завершён в БД — пропускаем ===
      if (assignment.local_status === 'completed') {
        console.log(`[CLEAN] Заказ ${orderId} уже завершён (status=completed), пропускаем`);
        continue;
      }

      const freshStatus = await db.get(
        'SELECT status FROM assignments WHERE order_id = ?',
        orderId
      );
      if (freshStatus && freshStatus.status === 'completed') {
        console.log(`[CLEAN] Заказ ${orderId} уже завершён (повторная проверка), пропускаем`);
        continue;
      }

      // === 4. Если сотрудник отсутствует или уволен — снимаем заказ ===
      if (!assignment.employee_name || assignment.is_fired === 1) {
        console.warn(`[CLEAN] Заказ ${orderId} назначен на некорректного сотрудника (user_id=${assignment.user_id}), снимаем`);
        await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);

        // Оповещения: персоналу в журнал действий + сотруднику лично.
        // Фикс: раньше отправляли по tg_user_id, а комнаты сокета именуются
        // по user_id — поэтому авто-снятие до сотрудника не доходило.
        NotificationService.notifyStaff('order_unassigned', {
          orderId,
          auto: true,
          reason: 'Сотрудник отсутствует или уволен',
          userName: assignment.employee_name || 'не найден',
        });
        NotificationService.notifyUser(assignment.user_id, 'order_unassigned', {
          orderId,
          auto: true,
          reason: 'Сотрудник отсутствует или уволен',
        });
        // Снимок заказа больше не нужен: он не в awaiting_packaging, фото чистим
        OrderService.forgetOrderState(orderId, { prunePhotos: true });
        continue;
      }

      // === 5. Стандартное удаление: заказ больше не в awaiting_packaging ===
      console.log(`[CLEAN] Заказ ${orderId} больше не в awaiting_packaging, отменяем назначение у ${assignment.employee_name}`);
      await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);

      NotificationService.notifyStaff('order_unassigned', {
        orderId,
        auto: true,
        reason: 'Заказ более не актуален (не в awaiting_packaging)',
        userName: assignment.employee_name,
      });
      NotificationService.notifyUser(assignment.user_id, 'order_unassigned', {
        orderId,
        auto: true,
        reason: 'Заказ более не актуален',
      });
      // Заказ вышел из awaiting_packaging -> забываем снимок и чистим фото
      OrderService.forgetOrderState(orderId, { prunePhotos: true });
    }

    console.log('[OrderService] cleanExpiredAssignments завершена');
  }

  // =================================================================
  // 2. ПРОВЕРКА НОВЫХ ЗАКАЗОВ (из bot.js checkAndOfferNewOrders)
  // =================================================================
  static async checkNewOrders() {
    console.log('[OrderService] Проверка новых заказов...');
    try {
      const allOrders = await OzonService.fetchAwaitingOrders();
      const activeOrderIds = allOrders.map(o => o.posting_number);
      await OrderService.cleanExpiredAssignments(activeOrderIds);

      if (!allOrders.length) {
        if (pendingNewOrders.length === 0) {
          currentOrderProcessing = null;
        }
        return;
      }

      const db = getDB();
      const assignedOrderIds = (await db.all('SELECT order_id FROM assignments WHERE status = "assigned"'))
        .map(r => r.order_id);
      const assignedSet = new Set(assignedOrderIds);

      const newOrders = allOrders.filter(order => !assignedSet.has(order.posting_number));
      if (!newOrders.length) {
        return;
      }

      // Сохраняем текущий обрабатываемый заказ
      const currentOrderId = currentOrderProcessing?.order?.posting_number;
      if (currentOrderId && !newOrders.some(o => o.posting_number === currentOrderId)) {
        console.log(`[CHECK] Текущий заказ ${currentOrderId} больше не в awaiting_packaging, сбрасываем`);
        currentOrderProcessing = null;
      }

      pendingNewOrders = newOrders;
      console.log(`[CHECK] Очередь обновлена, заказов: ${pendingNewOrders.length}`);

      // Оповещаем персонал о новых заказах (БД оповещений + WebSocket).
      // ТОЛЬКО модераторам; новое оповещение заменяет старое непрочитанное
      // (в журнале подобное оповещение всегда ОДНО).
      NotificationService.notifyStaff(
        'new_orders_available',
        {
          count: pendingNewOrders.length,
          orders: pendingNewOrders.map(o => ({
            posting_number: o.posting_number,
            products_count: o.products?.length || 0,
          })),
        },
        {
          roles: ['moderator'],
          replaceUnreadType: 'new_orders_available',
          // Без Web Push: оповещение дедуплицируется и обновляется постоянно —
          // будить телефон на каждый тик планировщика нельзя.
          push: false,
        },
      );

      // Если нет активного заказа и есть заказы – берём первый
      if (!currentOrderProcessing && pendingNewOrders.length) {
        currentOrderProcessing = { order: pendingNewOrders[0], timestamp: Date.now() };
      }

    } catch (err) {
      console.error('[OrderService] Ошибка checkNewOrders:', err);
      throw err;
    }
  }

  // =================================================================
  // 3. НАЗНАЧЕНИЕ ЗАКАЗА (из commands.js assignOrder)
  // =================================================================
  static async assignOrder(orderId, userId, adminId = null) {
    // Блокировка
    if (processingOrders.has(orderId)) {
      console.log(`[ASSIGN] Заказ ${orderId} уже обрабатывается, пропускаем.`);
      throw new Error('Заказ уже обрабатывается');
    }
    processingOrders.add(orderId);

    let queuedOrder = null;
    const queueIndex = pendingNewOrders.findIndex(o => o.posting_number === orderId);
    if (queueIndex !== -1) {
      queuedOrder = pendingNewOrders.splice(queueIndex, 1)[0];
      console.log(`[ASSIGN] Заказ ${orderId} удалён из очереди`);
    }
    if (currentOrderProcessing?.order?.posting_number === orderId) {
      currentOrderProcessing = null;
    }

    let assignedInDb = false;
    let employee = null;
    let orderDetails = null;

    try {
      // Проверка сотрудника
      employee = await User.getById(userId);
      if (!employee) throw new Error(`Сотрудник с ID ${userId} не найден.`);
      if (employee.is_fired) throw new Error(`Сотрудник ${employee.name} уволен.`);
      // Создателю ('god') заказы не назначаются — он вне списков сотрудников.
      // Исключение: Создатель может назначить заказ самому себе (для тестов),
      // т.е. разрешено только когда назначающий (adminId) и получатель (userId)
      // — один и тот же пользователь.
      if (employee.role === 'god') {
        if (!adminId || adminId !== userId) {
          throw new Error(`Заказ нельзя назначить Создателю.`);
        }
      }

      // Получение деталей заказа
      orderDetails = await OzonService.getOrderDetails(orderId);
      if (!orderDetails) throw new Error(`Не удалось получить детали заказа ${orderId}.`);

      // Очистка старых состояний
      await this.clearOrderState(orderId);

      // Назначение в БД
      await Assignment.assign(orderId, userId);
      assignedInDb = true;
      console.log(`[ASSIGN] Заказ ${orderId} записан в БД за сотрудником ${employee.name}`);

      // Снимок заказа в кэше: детали УЖЕ загружены (0 доп. вызовов Ozon) —
      // страница «Мои заказы» берёт состав отсюда, пока заказ не выйдет из
      // awaiting_packaging/awaiting_deliver (см. syncOrderStatuses).
      this.cacheOrderState(orderId, {
        userId,
        status: orderDetails.status || ORDER_STATUS_PACKAGING,
        details: orderDetails,
        assignedAt: Date.now(),
        completedAt: null,
      });

      // === ПРОВЕРКА СТАТИСТИКИ (перенесено из commands.js assignOrder, шаг 4) ===
      // Каких товаров ещё нет в product_stats — сотрудник заполнит их
      // через диалог «Заполнить статистику» на странице «Заказы».
      const missingStats = [];
      for (const product of orderDetails.products || []) {
        const offerId = product.offer_id;
        if (!offerId) continue;
        const stats = await ProductStat.get(offerId);
        if (!stats) missingStats.push(offerId);
      }

      // === ОПОВЕЩЕНИЕ О НАЗНАЧЕНИИ (вместо сообщений в Telegram) ===
      // Одно событие «order_assigned» для обеих аудиторий. В payload кладём
      // детали заказа (состав с offer_id, склад, трек-номер) + missingStats —
      // как в бот-версии уходило текстом в сообщении сотруднику и модератору.
      const assignPayload = {
        orderId,
        userId,
        userName: employee.name,
        adminId: adminId || null,
        adminName: adminId
          ? (await User.getById(adminId))?.name || String(adminId)
          : null,
        missingStats,
        details: buildOrderNotificationDetails(orderDetails),
      };
      NotificationService.notifyUser(userId, 'order_assigned', assignPayload);
      NotificationService.notifyStaff('order_assigned', assignPayload);

      // === ФОТОГРАФИИ: пропускаем ===
      // В бот-версии фото товаров отправлялись в Telegram (fetchProductsImages).
      // В веб-версии фото всегда доступны на странице «Заказы»
      // (attachProductImages) — дублировать в оповещения не нужно.

      // === 3D-МОДЕЛИ (шаг 9 из bot.js assignOrder) ===
      // Для каждого offer_id из состава заказа ищем zip-модель в offer_models
      // (с учётом родительского артикула -NR/-NL). Найденные модели записываются
      // сотруднику в issued_models, сотруднику уходит оповещение «модели доступны»,
      // персоналу — журнал выданных и список недостающих. Ошибка выдачи моделей
      // НЕ отменяет назначение заказа (как в бот-версии).
      let modelsSummary = null;
      try {
        modelsSummary = await ModelService.issueForAssignment(
          orderId,
          userId,
          employee,
          orderDetails
        );
      } catch (modelsErr) {
        console.error(`[ASSIGN] Ошибка выдачи 3D-моделей для ${orderId}:`, modelsErr);
        NotificationService.notifyStaff('order_assign_error', {
          orderId,
          error: `Выдача 3D-моделей: ${modelsErr.message}`,
          userName: employee.name,
        });
      }

      orderAssignRetries.delete(orderId);
      console.log(`[ASSIGN] Заказ ${orderId} успешно назначен сотруднику ${employee.name} (ID ${employee.id})`);
      return { success: true, employee };

    } catch (err) {
      console.error(`[ASSIGN] Ошибка назначения заказа ${orderId}:`, err);

      if (assignedInDb) {
        // Ошибка после записи в БД — не возвращаем заказ в очередь
        console.error(`[ASSIGN] Заказ ${orderId} уже назначен в БД, в очередь не возвращаем.`);
        NotificationService.notifyStaff('order_assign_error', {
          orderId,
          error: err.message,
          userName: employee?.name || userId,
        });
        NotificationService.logServerError('OrderService.assignOrder', err, {
          orderId,
          phase: 'after_db_write',
        });
      } else {
        // Ошибка до записи в БД — возвращаем заказ в очередь
        let retries = orderAssignRetries.get(orderId) || 0;
        retries++;
        orderAssignRetries.set(orderId, retries);

        if (retries <= 3) {
          if (!pendingNewOrders.some(o => o.posting_number === orderId)) {
            if (!queuedOrder) {
              try {
                queuedOrder = await OzonService.fetchAwaitingOrdersById(orderId);
              } catch (e) {
                queuedOrder = { posting_number: orderId, products: [] };
              }
            }
            if (queuedOrder) {
              pendingNewOrders.unshift(queuedOrder);
              console.log(`[ASSIGN] Заказ ${orderId} возвращён в очередь (попытка ${retries}/3).`);
            }
          }
        } else {
          console.error(`[ASSIGN] Заказ ${orderId} не удалось назначить после 3 попыток.`);
          NotificationService.notifyStaff('order_assign_failed', {
            orderId,
            error: err.message,
            attempts: retries,
          });
          NotificationService.logServerError('OrderService.assignOrder', err, {
            orderId,
            attempts: retries,
          });
          orderAssignRetries.delete(orderId);
        }
      }
      throw err;
    } finally {
      processingOrders.delete(orderId);
      console.log(`[ASSIGN] Блокировка для ${orderId} снята.`);
    }
  }

  // =================================================================
  // 4. ЗАВЕРШЕНИЕ ЗАКАЗА (из commands.js finishOrder)
  // =================================================================
  static async finishOrder(orderId, userId) {
    console.log(`[FINISH] === Начало завершения заказа ${orderId} сотрудником ${userId} ===`);
    let transactionCompleted = false;

    try {
      // Проверяем, что заказ ещё активен и принадлежит пользователю
      const db = getDB();
      const assignment = await db.get(
        'SELECT status FROM assignments WHERE order_id = ? AND user_id = ? AND status = "assigned"',
        orderId, userId
      );
      if (!assignment) {
        throw new Error(`Заказ ${orderId} уже завершён или не найден.`);
      }

      // Получаем пользователя
      const user = await User.getById(userId);
      if (!user) throw new Error('Пользователь не найден');

      // 1. Получаем сумму заказа
      const orderAmount = await OzonService.getOrderTotalAmount(orderId);
      console.log(`[FINISH] Сумма заказа: ${orderAmount}`);

      // 2. Рассчитываем заработок
      const orderDetails = await OzonService.getOrderDetails(orderId);
      let earningsData = null;
      if (orderDetails && orderDetails.products) {
        // Конфигурация материалов/спецпредложений загружается внутри EarningsService
        earningsData = await EarningsService.calculateOrderEarnings(orderDetails, user);
        if (!earningsData.allHaveStats) {
          console.warn(`[FINISH] Не все товары имеют статистику для заказа ${orderId}`);
        }
      }

      // 3. Подтверждение сборки через Ozon
      let labelBuffer = null;
      try {
        await OzonService.confirmPostingShip(orderId);
      } catch (shipError) {
        if (shipError.message && shipError.message.includes('не в статусе awaiting_packaging')) {
          console.warn(`[FINISH] Заказ ${orderId} уже подтверждён (статус не awaiting_packaging)`);
        } else {
          throw shipError;
        }
      }

      // Пауза не нужна: getPackageLabel сам ждёт готовности задачи
      // (первый опрос — через 45-60 секунд по рекомендации Ozon).
      labelBuffer = await OzonService.getPackageLabel(orderId);

      // ========== ТРАНЗАКЦИЯ БД ==========
      await db.run('BEGIN TRANSACTION');

      try {
        // Обновляем статистику
        await UserStats.incrementStats(userId, orderAmount);

        // Сохраняем заработок
        if (earningsData && earningsData.total > 0) {
          const existing = await db.get('SELECT id FROM earnings_history WHERE order_id = ?', orderId);
          if (!existing) {
            await Earnings.saveHistory(userId, orderId, earningsData.total);
            await Earnings.saveActive(userId, orderId, earningsData.total);
          }
        }

        // Завершаем заказ + сохраняем «слепок» (сумма и состав) для
        // страницы «Завершённые заказы»
        await Assignment.complete(orderId, {
          orderAmount: orderAmount,
          products:
            orderDetails && Array.isArray(orderDetails.products)
              ? orderDetails.products
              : null,
        });

        // Фотографии товаров НЕ удаляем: заказ только что переведён в
        // awaiting_deliver, карточка нужна на вкладке «Завершённые заказы»
        // (фото очистятся, когда заказ выйдет из awaiting_deliver —
        // см. OrderService.syncOrderStatuses).

        await db.run('COMMIT');
        transactionCompleted = true;
        console.log(`[FINISH] Транзакция успешно закоммичена для заказа ${orderId}`);
      } catch (txError) {
        await db.run('ROLLBACK');
        console.error(`[FINISH] Ошибка в транзакции для заказа ${orderId}:`, txError);
        throw txError;
      }

      // === СИНХРОНИЗАЦИЯ С OZON ПОСЛЕ ЗАВЕРШЕНИЯ ===
      // Заказ подтверждён (confirmPostingShip) -> статус стал awaiting_deliver.
      // Сохраняем снимок в кэше сразу (даже если синк ниже не удастся) и
      // уточняем статус/детали одним вызовом. Сбой синка НЕ отменяет завершение:
      // статус подтянут планировщик и кнопка «Обновить» на странице заказов.
      this.cacheOrderState(orderId, {
        userId,
        status: ORDER_STATUS_DELIVER,
        details: orderDetails || null,
        completedAt: Date.now(),
      });
      try {
        const freshDetails = await OzonService.getOrderDetails(orderId);
        if (freshDetails) {
          this.cacheOrderState(orderId, {
            status: freshDetails.status || ORDER_STATUS_DELIVER,
            details: freshDetails,
          });
          if (freshDetails.status && freshDetails.status !== ORDER_STATUS_DELIVER) {
            console.warn(
              `[FINISH] Заказ ${orderId} после подтверждения сборки в статусе "${freshDetails.status}" ` +
              `(ожидался awaiting_deliver) — этикетка может быть недоступна`
            );
          }
        }
      } catch (syncErr) {
        console.error(`[FINISH] Не удалось синхронизировать статус заказа ${orderId}:`, syncErr.message);
        NotificationService.logServerError('OrderService.finishOrder.sync', syncErr, { orderId });
      }

      // Оповещения: сотруднику (этикетка/заработок) + персоналу в журнал действий.
      // В payload кладём детализацию заработка по товарам — в бот-версии она
      // отправлялась сотруднику отдельным сообщением «💰 Заработок за заказ».
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
      NotificationService.notifyUser(userId, 'order_finished', finishedPayload);
      NotificationService.notifyStaff('order_finished', {
        orderId,
        userId,
        userName: user.name,
        ...finishedPayload,
      });

      // Очищаем состояния
      await this.clearOrderState(orderId);

      console.log(`[FINISH] === Заказ ${orderId} успешно завершён ===`);
      return { success: true, earnings: earningsData?.total || 0, labelAvailable: !!labelBuffer };

    } catch (err) {
      console.error(`[FINISH] Ошибка при завершении заказа ${orderId}:`, err);
      throw err;
    } finally {
      // Принудительно удаляем флаги
      if (!transactionCompleted) {
        console.log(`[FINISH] Принудительно удаляем флаги для ${orderId}`);
        finishingOrders.delete(orderId);
        pendingFinishConfirmations.delete(orderId);
      }
    }
  }

  // =================================================================
  // 5. ОТМЕНА ЗАКАЗА
  // =================================================================

  // ОТМЕНА ЗАКАЗА (пользователь)
  static async cancelOrder(orderId, userId) {
    console.log(`[CANCEL] Отмена заказа ${orderId} пользователем ${userId}`);
    const db = getDB();

    // Проверяем, что заказ назначен этому пользователю и ещё не завершён
    const assignment = await db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND user_id = ? AND status = "assigned"',
      orderId, userId
    );
    if (!assignment) {
      throw new Error('Заказ не найден или не назначен вам');
    }

    // Удаляем назначение
    await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);

    // Снимок заказа в кэше больше не нужен (заказ вернулся в очередь).
    // Фотографии оставляем: заказ по-прежнему в awaiting_packaging и может быть
    // назначен снова (фото в кэше привязаны к артикулу, а не к сотруднику).
    this.forgetOrderState(orderId);

    // Увеличиваем счётчик отменённых заказов (вина пользователя)
    await UserStats.incrementCanceled(userId);

    // Оповещения: сотруднику + персоналу в журнал действий
    const cancelledUser = await User.getById(userId);
    NotificationService.notifyUser(userId, 'order_cancelled', { orderId });
    NotificationService.notifyStaff('order_cancelled', {
      orderId,
      userId,
      userName: cancelledUser?.name || userId,
    });

    // Возвращаем заказ в очередь (перезагружаем)
    await this.reloadQueue();

    return { success: true };
  }

  // СНЯТИЕ ЗАКАЗА АДМИНИСТРАТОРОМ (без увеличения счётчика отмен)
  static async unassignOrder(orderId, adminId) {
    console.log(`[UNASSIGN] Снятие заказа ${orderId} администратором ${adminId}`);
    const db = getDB();

    // Проверяем, что заказ назначен
    const assignment = await db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND status = "assigned"',
      orderId
    );
    if (!assignment) {
      throw new Error('Заказ не назначен');
    }

    // Сохраняем userId для уведомления
    const userId = assignment.user_id;

    // Удаляем назначение (без увеличения счётчика отмен)
    await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);

    // Снимок заказа в кэше больше не нужен (заказ вернулся в очередь);
    // фотографии оставляем — заказ всё ещё в awaiting_packaging
    this.forgetOrderState(orderId);

    // Оповещения: сотруднику + персоналу в журнал действий
    const unassignedUser = await User.getById(userId);
    NotificationService.notifyUser(userId, 'order_unassigned', {
      orderId,
      auto: false,
      reason: 'Снят администратором',
    });
    NotificationService.notifyStaff('order_unassigned', {
      orderId,
      userId,
      adminId,
      userName: unassignedUser?.name || userId,
      reason: 'Снят администратором',
    });

    // Возвращаем заказ в очередь
    await this.reloadQueue();

    return { success: true };
  }

  // =================================================================
  // 6. ПОЛУЧЕНИЕ ЭТИКЕТКИ
  // =================================================================
  static async getLabel(orderId, userId) {
    const db = getDB();
    // Проверяем, что заказ завершён и принадлежит пользователю
    const assignment = await db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND user_id = ? AND status = "completed"',
      orderId, userId
    );
    if (!assignment) {
      throw new Error('Заказ не найден или не завершён');
    }

    // Проверяем статус заказа в Ozon
    const details = await OzonService.getOrderDetails(orderId);
    if (!details || details.status !== 'awaiting_deliver') {
      throw new Error('Этикетка ещё не доступна');
    }

    return await OzonService.getPackageLabel(orderId);
  }

  static async getAllLabels(userId) {
    const db = getDB();
    const completed = await db.all(
      'SELECT order_id FROM assignments WHERE user_id = ? AND status = "completed"',
      userId
    );
    if (!completed.length) return null;

    // Один запрос списка заказов в статусе awaiting_deliver (этикетка
    // доступна только в этом статусе; паритет с /send_all_labels в боте).
    let awaitingDeliver;
    try {
      awaitingDeliver = await OzonService.fetchAwaitingDeliverOrders();
    } catch (err) {
      console.error(
        '[getAllLabels] Не удалось получить заказы awaiting_deliver из Ozon:',
        err.message
      );
      throw new Error(`Не удалось получить список заказов из Ozon: ${err.message}`);
    }

    // Пересечение: завершённые заказы сотрудника, которые всё ещё в
    // awaiting_deliver. Один вызов package-label/create на весь массив —
    // Ozon сам отдаёт один PDF сразу со всеми этикетками (без mergePdfs).
    const completedIds = new Set(completed.map((o) => o.order_id));
    const postingNumbers = awaitingDeliver
      .map((o) => o.posting_number)
      .filter((n) => completedIds.has(n))
      .slice(0, 1000); // лимит posting_numbers в package-label/create
    if (!postingNumbers.length) {
      console.log(
        `[getAllLabels] У сотрудника ${userId} нет завершённых заказов в статусе awaiting_deliver`
      );
      return null;
    }
    console.log(
      `[getAllLabels] Запрос склейки этикеток для ${postingNumbers.length} отправлений`
    );
    return await OzonService.getPackageLabel(postingNumbers);
  }

  // =================================================================
  // 7. ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ДЛЯ РАБОТЫ С ОЧЕРЕДЬЮ
  // =================================================================

  static getCurrentOrder() {
    return currentOrderProcessing?.order || null;
  }

  static getPendingOrders() {
    return pendingNewOrders;
  }

  static async reloadQueue() {
    console.log('[OrderService] Принудительная перезагрузка очереди');
    pendingNewOrders = [];
    currentOrderProcessing = null;
    await this.checkNewOrders();
  }

// =================================================================
  // 7.5 ПРИВЯЗКА ФОТОГРАФИЙ К ТОВАРАМ С ИСПОЛЬЗОВАНИЕМ КЭША
  // =================================================================
  // Для каждого offer_id фото грузятся с Ozon только один раз и кладутся в in-memory кэш
  // (productImagesCache). При повторных запросах (обновлении страниц админом/пользователем)
  // фото берутся из кэша. Кэш живёт, пока заказ находится в awaiting_packaging /
  // awaiting_deliver (чистка — при синхронизации статусов, см. syncOrderStatuses).
  static async attachProductImages(products) {
    if (!Array.isArray(products) || !products.length) return products || [];

    const needSkus = new Set(); // SKU, для которых фото ещё нет ни в кэше, ни в товаре

    // 1. Привязываем фото из кэша по offer_id
    for (const p of products) {
      if (p.offer_id) {
        const cached = productImagesCache.get(String(p.offer_id));
        if (cached && cached.images && cached.images.length) {
          p.images = cached.images.map(url => ({ url, name: p.name }));
          // Отмечаем обращение: пока фото запрашивают, TTL-чистка их не тронет
          cached.updatedAt = Date.now();
        } else if (p.sku) {
          needSkus.add(String(p.sku));
        }
      } else if (p.sku) {
        // У товара нет offer_id — грузим по sku (кэшировать некуда)
        needSkus.add(String(p.sku));
      }
    }

    // 2. Догружаем с Ozon только недостающие фото
    if (needSkus.size) {
      const imageMap = await OzonService.fetchProductsImages(Array.from(needSkus));
      for (const p of products) {
        if (p.images || !p.sku) continue;
        const urls = imageMap[String(p.sku)];
        if (!urls || !urls.length) continue;
        p.images = urls.map(url => ({ url, name: p.name }));
        if (p.offer_id) {
          productImagesCache.set(String(p.offer_id), {
            sku: String(p.sku),
            images: urls,
            updatedAt: Date.now(),
          });
        }
      }
    }

    // 3. Если фото не нашлось — ставим пустой массив
    for (const p of products) {
      if (!p.images) p.images = [];
    }

    return products;
  }

  // =================================================================
  // 7.5.1 ПРИВЯЗКА СТАТИСТИКИ ТОВАРА (материал, цвет, вес)
  // =================================================================
  // Для каждого offer_id берём запись из product_stats и кладём её в p.stats —
  // фронт показывает её под товаром (как «Материал/Цвет» в карточке бота).
  // Если статистики нет — p.stats = null, блок не рендерится. Вызывается
  // ПОСЛЕ attachProductImages/attachToProducts на копии состава (cloneProducts),
  // чтобы служебные поля не оседали в кэше деталей заказа.
  static async attachProductStats(products) {
    if (!Array.isArray(products) || !products.length) return products || [];
    for (const p of products) {
      if (!p || !p.offer_id) {
        if (p) p.stats = null;
        continue;
      }
      const stat = await ProductStat.get(p.offer_id);
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
  // 7.6 КЭШ СОСТОЯНИЯ ЗАКАЗОВ И ВКЛАДКА «ЗАВЕРШЁННЫЕ ЗАКАЗЫ»
  // =================================================================
  // orderStateCache (см. state.js) хранит снимок заказа, пока он «жив»:
  // awaiting_packaging (активный) или awaiting_deliver (завершён, этикетка
  // доступна). Это избавляет страницу «Мои заказы» от запроса деталей в Ozon
  // на каждое открытие и позволяет показать состав с фото на вкладке
  // «🗳️ Завершённые заказы».

  /**
   * Записать/обновить снимок заказа в кэше (патч накладывается на запись).
   * @param {string} orderId
   * @param {object} [patch] - { userId, status, details, assignedAt, completedAt }
   * @returns {object|null} обновлённая запись
   */
  static cacheOrderState(orderId, patch = {}) {
    if (!orderId) return null;
    const key = String(orderId);
    const prev = orderStateCache.get(key) || {};
    const next = { ...prev, ...patch, orderId: key, updatedAt: Date.now() };
    orderStateCache.set(key, next);
    return next;
  }

  /** Снимок заказа из кэша (или null). */
  static getOrderState(orderId) {
    if (!orderId) return null;
    return orderStateCache.get(String(orderId)) || null;
  }

  /**
   * Забыть заказ (отмена, снятие админом, выход из «живых» статусов).
   * @param {string} orderId
   * @param {object} [options]
   * @param {boolean} [options.prunePhotos] - удалить и фотографии товаров
   *   (только те артикулы, которые больше не используются другими заказами)
   */
  static forgetOrderState(orderId, { prunePhotos = false } = {}) {
    if (!orderId) return;
    const key = String(orderId);
    const state = orderStateCache.get(key);
    orderStateCache.delete(key);
    if (prunePhotos && state) {
      this.pruneProductImagesCache(new Set(this.offerIdsOfState(state)));
    }
  }

  /** Артикулы (offer_id) из снимка заказа. */
  static offerIdsOfState(state) {
    const products = state && state.details ? state.details.products : null;
    if (!Array.isArray(products)) return [];
    return products
      .map((p) => (p && p.offer_id ? String(p.offer_id) : null))
      .filter(Boolean);
  }

  /**
   * Копия состава заказа: поля, которые добавляются на лету при формировании
   * ответа (images, model), не должны «оседать» в кэше.
   */
  static cloneProducts(products) {
    return (products || []).map((p) => ({ ...p }));
  }

  /**
   * Детали заказа: из кэша, при промахе — 1 запрос к Ozon с записью в кэш.
   * @param {string} orderId
   * @param {object} [options]
   * @param {boolean} [options.forceFresh] - игнорировать кэш (принудительный синк)
   */
  static async resolveOrderDetails(orderId, { forceFresh = false } = {}) {
    const cached = this.getOrderState(orderId);
    if (!forceFresh && cached && cached.details) return cached;
    const details = await OzonService.getOrderDetails(orderId);
    if (!details) return cached;
    return this.cacheOrderState(orderId, {
      status: details.status || (cached ? cached.status : null),
      details,
    });
  }

  /**
   * Активные заказы сотрудника (состав, фото, статус статистики).
   * Детали берутся из кэша (при промахе — 1 запрос к Ozon), поэтому страница
   * «Мои заказы» больше не дёргает Ozon по каждому заказу при каждом рендере.
   * @param {number} userId
   */
  static async buildActiveOrders(userId) {
    const orders = await Assignment.getActiveOrders(userId);
    const result = [];
    for (const order of orders) {
      let state = await this.resolveOrderDetails(order.order_id);
      // Снимок «кто и когда взял» — по нему видно принадлежность заказа
      state = this.cacheOrderState(order.order_id, {
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
          const stat = await ProductStat.get(p.offer_id);
          if (!stat) {
            statsStatus = 'missing';
            missingStats.push(p.offer_id);
          }
        }
      }
      const products = await this.attachProductImages(this.cloneProducts(details?.products));
      await ModelService.attachToProducts(products);
      await this.attachProductStats(products);
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

  /**
   * Завершённые сотрудником заказы, которые ещё ожидают отправки
   * (awaiting_deliver) — вкладка «🗳️ Завершённые заказы».
   * Источник списка — БД (assignments.status='completed' пишется при завершении),
   * статус — из кэша. Для заказов без снимка (завершены до перезапуска сервера/
   * до внедрения кэша) достаточно ОДНОГО вызова fetchAwaitingDeliverOrders: он
   * отсеивает уже отправленные заказы без запроса деталей по каждому. Детали
   * (состав с фото) добираются по требованию и тоже кэшируются.
   * @param {number} userId
   */
  static async buildCompletedOrdersAwaitingDeliver(userId) {
    const db = getDB();
    const rows = await db.all(
      `SELECT order_id, completed_at FROM assignments
       WHERE user_id = ? AND status = 'completed'
         AND earnings_revoked_at IS NULL
       ORDER BY completed_at DESC`,
      userId
    );
    if (!rows.length) return [];

    // Статус неизвестен (нет снимка или в снимке нет статуса) -> уточняем одним
    // списком awaiting_deliver
    const needsStatus = (orderId) => {
      const state = this.getOrderState(orderId);
      return !state || !state.status;
    };
    let awaitingDeliverSet = null;
    if (rows.some((row) => needsStatus(row.order_id))) {
      try {
        const postings = await OzonService.fetchAwaitingDeliverOrders();
        awaitingDeliverSet = new Set(
          (postings || []).map((p) => p && p.posting_number).filter(Boolean)
        );
      } catch (err) {
        // Ozon недоступен: показываем только то, что уже известно из кэша
        console.error(
          '[COMPLETED] Не удалось получить заказы awaiting_deliver из Ozon:',
          err.message
        );
      }
    }

    const result = [];
    for (const row of rows) {
      let state = this.getOrderState(row.order_id);
      let status = state ? state.status : null;
      if ((!state || !status) && awaitingDeliverSet) {
        status = awaitingDeliverSet.has(row.order_id)
          ? ORDER_STATUS_DELIVER
          : 'other';
      }
      // Статус неизвестен (Ozon недоступен) — заказ не показываем
      if (!status) continue;

      state = this.cacheOrderState(row.order_id, {
        userId,
        status,
        completedAt: row.completed_at,
      });
      // Показываем только ожидающие отправки: этикетка доступна только в них
      if (status !== ORDER_STATUS_DELIVER) continue;

      if (!state.details) {
        state = await this.resolveOrderDetails(row.order_id);
      }
      const products = await this.attachProductImages(this.cloneProducts(state?.details?.products));
      await this.attachProductStats(products);
      result.push({
        orderId: row.order_id,
        completedAt: row.completed_at,
        products,
      });
    }
    return result;
  }

  /**
   * Синхронизация кэша со статусами Ozon: ДВА запроса списков
   * (awaiting_packaging + awaiting_deliver; пагинация — внутри OzonService).
   * Снимки заказов, вышедшие из обоих статусов, удаляются вместе с фотографиями
   * (только если артикулы больше не используются оставшимися заказами).
   * Вызывается планировщиком (ежечасно) и кнопкой «🔄 Обновить» на странице
   * «Мои заказы» (кулдаун 1 минута).
   * @returns {Promise<{checked:number, removed:number, photosRemoved:number,
   *   activeOrderIds:string[]}>}
   */
  static async syncOrderStatuses() {
    // Запросы параллельно; сбой любого -> исключение до правок кэша (fail-safe:
    // при недоступном Ozon ничего не удаляем)
    const [packaging, deliver] = await Promise.all([
      OzonService.fetchAwaitingOrders(),
      OzonService.fetchAwaitingDeliverOrders(),
    ]);

    // orderId -> статус, в котором заказ находится СЕЙЧАС
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

    const checked = orderStateCache.size;
    let removed = 0;
    const removedOfferIds = new Set();
    for (const [orderId, state] of Array.from(orderStateCache.entries())) {
      const status = statusByOrderId.get(orderId);
      if (!status) {
        // Заказ вышел из «живых» статусов (отправлен/отменён/возврат):
        // убираем снимок, артикулы запоминаем для чистки фото
        for (const offerId of this.offerIdsOfState(state)) removedOfferIds.add(offerId);
        orderStateCache.delete(orderId);
        removed++;
        continue;
      }
      if (state.status !== status) {
        this.cacheOrderState(orderId, { status });
      }
    }

    let photosRemoved = this.pruneProductImagesCache(removedOfferIds);
    photosRemoved += this.pruneStaleProductImages();

    const activeOrderIds = [];
    for (const [orderId, status] of statusByOrderId) {
      if (status === ORDER_STATUS_PACKAGING) activeOrderIds.push(orderId);
    }

    if (removed || photosRemoved) {
      console.log(
        `[SYNC] Статусы заказов: проверено ${checked}, убрано из кэша ${removed}, ` +
        `удалено фото ${photosRemoved}`
      );
    }

    return { checked, removed, photosRemoved, activeOrderIds };
  }

  /**
   * Удаляет фотографии артикулов, забытых вместе с заказами, но только если они
   * больше НЕ используются оставшимися в кэше заказами (один offer_id может
   * встречаться в нескольких заказах).
   * @param {Set<string>} candidateOfferIds
   * @returns {number} сколько записей кэша удалено
   */
  static pruneProductImagesCache(candidateOfferIds) {
    if (!candidateOfferIds || candidateOfferIds.size === 0) return 0;
    const stillUsed = this.collectCachedOfferIds();
    let removed = 0;
    for (const offerId of candidateOfferIds) {
      if (stillUsed.has(offerId)) continue;
      if (productImagesCache.delete(offerId)) removed++;
    }
    return removed;
  }

  /**
   * Страховочная чистка кэша фото: записи, которые не запрашивались дольше
   * PRODUCT_IMAGES_TTL_MS и не принадлежат ни одному заказу из кэша (например,
   * заказ отменили — фото остались, или фото смотрел админ по неназначенному
   * заказу). Живые заказы не затрагиваются: их артикулы есть в кэше, а каждое
   * обращение обновляет updatedAt.
   * @param {number} [now] - метка времени (для тестов)
   * @returns {number} сколько записей кэша удалено
   */
  static pruneStaleProductImages(now = Date.now()) {
    const stillUsed = this.collectCachedOfferIds();
    let removed = 0;
    for (const [offerId, entry] of Array.from(productImagesCache.entries())) {
      if (stillUsed.has(offerId)) continue;
      const updatedAt = entry && entry.updatedAt ? entry.updatedAt : 0;
      if (now - updatedAt < PRODUCT_IMAGES_TTL_MS) continue;
      productImagesCache.delete(offerId);
      removed++;
    }
    return removed;
  }

  /** Артикулы, используемые всеми заказами, оставшимися в кэше. */
  static collectCachedOfferIds() {
    const offerIds = new Set();
    for (const state of orderStateCache.values()) {
      for (const offerId of this.offerIdsOfState(state)) offerIds.add(offerId);
    }
    return offerIds;
  }

  // =================================================================
  // 8. ОЧИСТКА СОСТОЯНИЙ ЗАКАЗА (из commands.js clearOrderState)
  // =================================================================
  static async clearOrderState(orderId, userId = null) {
    console.log(`[CLEAR] Начало очистки заказа ${orderId}${userId ? ` для пользователя ${userId}` : ''}`);

    // Очищаем pendingForms
    if (userId) {
      const key = `${userId}_${orderId}`;
      if (pendingForms.has(key)) {
        pendingForms.delete(key);
      }
    } else {
      for (const [key, state] of pendingForms) {
        if (state.orderId === orderId) {
          pendingForms.delete(key);
          break;
        }
      }
    }

    // Очищаем pendingFinishConfirmations
    if (pendingFinishConfirmations.has(orderId)) {
      pendingFinishConfirmations.delete(orderId);
    }

    // Очищаем finishingOrders
    if (finishingOrders.has(orderId)) {
      finishingOrders.delete(orderId);
    }

    console.log(`[CLEAR] Завершена очистка заказа ${orderId}`);
  }
}

module.exports = OrderService;