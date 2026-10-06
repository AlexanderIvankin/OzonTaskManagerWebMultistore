const { Assignment, UserStats, Earnings, ProductStat, User } = require('../models');
const Notification = require('../models/Notification');
const OrderService = require('../services/OrderService');
const OzonService = require('../services/OzonService');
const NotificationService = require('../services/NotificationService');
const CooldownService = require('../services/CooldownService');
const PushService = require('../services/PushService');
const { getLocalDate, disableCache } = require('../utils');
const fs = require('fs');
const path = require('path');

// Строгое ограничение веса пластика в граммах (10 кг) — как в бот-версии
const MAX_WEIGHT_GRAMS = 10000;

/**
 * Получить профиль текущего пользователя
 */
exports.getProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const stats = await UserStats.getStats(userId);
    const activeOrders = await Assignment.getActiveOrders(userId);
    const completedOrders = await Assignment.getCompletedOrders(userId);
    res.json({
      ...req.user,
      stats,
      activeOrders,
      completedOrders,
    });
  } catch (err) {
    console.error('[getProfile] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Обновить отображаемое имя (display_name) — только для себя.
 * В отличие от name (которое редактирует Персонал в админке),
 * display_name пользователь меняет сам на странице Профиль.
 */
exports.updateDisplayName = async (req, res) => {
  try {
    const { displayName } = req.body;
    if (typeof displayName !== 'string' || displayName.trim().length < 1) {
      return res.status(400).json({ error: 'Укажите отображаемое имя' });
    }
    if (displayName.trim().length > 100) {
      return res.status(400).json({ error: 'Отображаемое имя: максимум 100 символов' });
    }
    const user = await User.update(req.user.id, { display_name: displayName.trim() });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('[updateDisplayName] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Получить активные заказы пользователя с деталями (состав, статус статистики).
 * Детали берутся из серверного кэша состояния заказов (orderStateCache):
 * Ozon запрашивается только при промахе кэша, а не при каждом открытии страницы.
 */
exports.getActiveOrders = async (req, res, next) => {
  try {
    const orders = await OrderService.buildActiveOrders(req.user.id);
    res.json(orders);
  } catch (err) {
    console.error('[getActiveOrders] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Получить завершённые пользователем заказы, которые ещё ожидают отправки
 * (awaiting_deliver) — вкладка «🗳️ Завершённые заказы». Такие карточки нужны,
 * чтобы скачать этикетку (getPackageLabel).
 */
exports.getCompletedOrders = async (req, res, next) => {
  try {
    const orders = await OrderService.buildCompletedOrdersAwaitingDeliver(req.user.id);
    res.json(orders);
  } catch (err) {
    console.error('[getCompletedOrders] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Обновить статусы ВСЕХ заказов сотрудника (активные + завершённые) и вернуть
 * оба списка одним ответом. Кулдаун 1 минута — см. routes/user.js
 * (cooldown('refreshOrders')).
 * Синхронизация — 2 запроса к Ozon (сравнимо с ежечасной задачей планировщика);
 * активные заказы, которых больше нет в awaiting_packaging, снимаются — так же,
 * как это делает плановый OrderService.checkNewOrders.
 */
exports.refreshOrders = async (req, res, next) => {
  const userId = req.user.id;
  try {
    const sync = await OrderService.syncOrderStatuses();
    // Снимаем заказы сотрудника, вышедшие из awaiting_packaging (иначе карточка
    // «зависнет» до следующего часового прогона checkNewOrders). Ограничиваем
    // только его назначениями — кнопка не должна трогать чужие заказы.
    await OrderService.cleanExpiredAssignments(sync.activeOrderIds, { userId });
    const [active, completed] = await Promise.all([
      OrderService.buildActiveOrders(userId),
      OrderService.buildCompletedOrdersAwaitingDeliver(userId),
    ]);
    // Кулдаун ставится ТОЛЬКО после успешной синхронизации (как у других команд)
    CooldownService.touch('refreshOrders', userId);
    res.json({ active, completed, syncedAt: Date.now(), removed: sync.removed });
  } catch (err) {
    console.error('[refreshOrders] Ошибка:', err);
    res.status(400).json({ error: err.message });
  }
};

/**
 * Завершить заказ (требуется, чтобы все товары имели статистику)
 */
exports.finishOrder = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.params;
    const result = await OrderService.finishOrder(orderId, userId);
    res.json({ message: 'Order finished', earnings: result.earnings, label: result.labelAvailable ? 'label available' : 'no label' });
  } catch (err) {
    console.error('[finishOrder] Ошибка:', err);
    res.status(400).json({ error: err.message });
  }
};

/**
 * Отменить заказ (с подтверждением на фронтенде)
 */
exports.cancelOrder = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.params;
    const result = await OrderService.cancelOrder(orderId, userId);
    res.json({ message: 'Order cancelled' });
  } catch (err) {
    console.error('[cancelOrder] Ошибка:', err);
    res.status(400).json({ error: err.message });
  }
};

/**
 * Получить этикетку для завершённого заказа
 */
exports.getLabel = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.params;
    const labelBuffer = await OrderService.getLabel(orderId, userId);
    if (!labelBuffer) {
      return res.status(404).json({ error: 'Label not available' });
    }
    // Кулдаун ставится только после успешной выдачи (паритет с ботом)
    CooldownService.touch('label', userId);
    disableCache(res);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=label_${orderId}.pdf`);
    res.send(labelBuffer);
  } catch (err) {
    console.error('[getLabel] Ошибка:', err);
    res.status(400).json({ error: err.message });
  }
};

/**
 * Получить все этикетки для завершённых заказов (объединённые в PDF)
 */
exports.getAllLabels = async (req, res, next) => {
  const userId = req.user.id;
  try {
    const pdfBuffer = await OrderService.getAllLabels(userId);
    if (!pdfBuffer) {
      // Нет пересечения completed ∩ awaiting_deliver либо задача Ozon
      // не дождалась file_url. Отдаём явную ошибку, а не пустой ответ.
      // Пустой ответ/ошибка -> короткий кулдаун 1 мин (как в боте).
      CooldownService.touch('allLabels', userId, 1);
      return res.status(404).json({
        error: 'Нет этикеток для скачивания: нет завершённых заказов в статусе awaiting_deliver',
      });
    }
    // Успех -> длинный кулдаун 1 час (как в боте)
    CooldownService.touch('allLabels', userId, 0);
    disableCache(res);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=all_labels.pdf');
    res.send(pdfBuffer);
  } catch (err) {
    // Ошибка -> короткий кулдаун 1 мин, чтобы не долбить Ozon (как в боте)
    CooldownService.touch('allLabels', userId, 1);
    console.error('[getAllLabels] Ошибка:', err);
    res.status(400).json({ error: err.message });
  }
};

/**
 * Скачать этикетку, отправленную сотруднику администратором
 * (аналог получения PDF из /admin_send_label в боте).
 * Доступ: только если сотруднику отправляли оповещение label_sent
 * с этим номером заказа. Файл лежит в outputs/labels/<orderId>.pdf.
 */
exports.getSentLabel = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.params;
    // Строгая проверка номера заказа — защита от path traversal
    if (!/^[\w-]+$/.test(orderId)) {
      return res.status(400).json({ error: 'Некорректный номер заказа' });
    }
    const notification = await Notification.findLatestByTypeAndOrder(
      userId,
      'label_sent',
      orderId
    );
    if (!notification) {
      return res.status(403).json({ error: 'Этикетка этого заказа не отправлялась вам' });
    }
    const filePath = path.join(__dirname, '../../outputs', 'labels', `${orderId}.pdf`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: 'Файл этикетки не найден на сервере. Попросите администратора отправить её заново.',
      });
    }
    disableCache(res);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=label_${orderId}.pdf`);
    res.send(fs.readFileSync(filePath));
  } catch (err) {
    console.error('[getSentLabel] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Получить заработок за месяц (история)
 */
exports.getMonthlyEarnings = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { month } = req.query;
    let fromDate, toDate;
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: 'Invalid month format. Use YYYY-MM' });
      }
      const [year, m] = month.split('-').map(Number);
      fromDate = new Date(year, m - 1, 1).getTime();
      toDate = new Date(year, m, 1).getTime() - 1;
    } else {
      // Текущий месяц по локальному времени (TIMEZONE), как в планировщике
      const now = getLocalDate();
      const year = now.getFullYear();
      const m = now.getMonth();
      fromDate = new Date(year, m, 1).getTime();
      toDate = new Date(year, m + 1, 1).getTime() - 1;
    }
    const history = await Earnings.getHistory(userId, fromDate, toDate);
    const total = history.reduce((sum, h) => sum + h.amount, 0);
    res.json({
      period: { from: fromDate, to: toDate },
      earnings: history,
      total,
      count: history.length,
    });
  } catch (err) {
    console.error('[getMonthlyEarnings] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Получить активный заработок (с последнего расчёта)
 */
exports.getActiveEarnings = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const active = await Earnings.getActive(userId, 0, Date.now());
    const totalBase = active.reduce((sum, a) => sum + a.amount, 0);
    const adjustments = await Earnings.getActiveAdjustmentsSum(userId, 0, Date.now());
    const totalWithAdjustments = totalBase + adjustments;
    res.json({
      baseEarnings: totalBase,
      adjustments,
      total: totalWithAdjustments,
      orders: active,
    });
  } catch (err) {
    console.error('[getActiveEarnings] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Переключить статус приёма заказов
 */
exports.toggleOrders = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await User.getById(userId);
    if (!user) throw new Error('User not found');
    const newStatus = user.taking_orders === 1 ? 0 : 1;
    await User.update(userId, { taking_orders: newStatus });

    // Кулдаун ставится только после успешного изменения (паритет с ботом)
    CooldownService.touch('toggleOrders', userId);

    // Оповещение персоналу: сотрудник изменил приём заказов
    NotificationService.notifyStaff('taking_orders_changed', {
      userId,
      userName: user.name,
      takingOrders: newStatus === 1,
    });

    res.json({ taking_orders: newStatus });
  } catch (err) {
    console.error('[toggleOrders] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Заполнить статистику товара (материал, цвет, вес)
 */
exports.fillStats = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { offerId, material, color, weight } = req.body;
    if (!offerId || !material || !color || !weight) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    // Валидация веса (паритет с фронтом): поддерживаем оба разделителя
    // ("12.5" и "12,5"), строгий формат — максимум одна цифра после
    // разделителя, положительное число в пределах MAX_WEIGHT_GRAMS
    const weightNormalized = String(weight).trim().replace(',', '.');
    const weightNum = Number(weightNormalized);
    if (!Number.isFinite(weightNum) || weightNum <= 0) {
      return res.status(400).json({ error: 'Вес должен быть положительным числом (например, 12.5)' });
    }
    if (!/^\d+(\.\d)?$/.test(weightNormalized)) {
      return res.status(400).json({ error: 'Вес указывается с точностью до 0.1 г (одна цифра после запятой)' });
    }
    if (weightNum > MAX_WEIGHT_GRAMS) {
      return res.status(400).json({ error: `Вес не может быть больше ${MAX_WEIGHT_GRAMS} г (10 кг)` });
    }
    await ProductStat.upsert(offerId, material, color, weightNum, userId);

    // Оповещение персоналу: сотрудник заполнил статистику товара
    NotificationService.notifyStaff('stats_filled', {
      userId,
      userName: req.user.name,
      offerId,
      material,
      color,
      weight: weightNum,
    });

    res.json({ message: 'Stats saved' });
  } catch (err) {
    console.error('[fillStats] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
};

// ===========================================================================
// WEB PUSH: подписки браузера (доступно ВСЕМ авторизованным — см. routes/user.js)
//
// Канал доставки оповещений выбирает NotificationService: онлайн-пользователю
// событие уходит мгновенно через Socket.IO, офлайн — Web Push (PushService).
// Здесь — только управление подписками устройства.
// ===========================================================================

/**
 * Публичный VAPID-ключ для подписки на Web Push.
 * Браузер использует его как applicationServerKey в pushManager.subscribe().
 * Секретов не содержит — можно отдавать любому авторизованному пользователю.
 */
exports.getPushPublicKey = (req, res) => {
  const publicKey = PushService.publicKey;
  if (!publicKey) {
    // Web Push не настроен (нет VAPID_* в .env) — фронт просто не подпишется
    return res.status(503).json({ error: 'Web Push не настроен на сервере' });
  }
  res.json({ publicKey });
};

/**
 * Сохранить подписку браузера на Web Push.
 * Body: { subscription: { endpoint, keys: { p256dh, auth } } } (PushSubscription.toJSON()).
 * endpoint уникален: повторная подписка того же браузера обновляет запись, а
 * вход другого пользователя на этом устройстве переприсваивает её ему.
 */
exports.pushSubscribe = async (req, res) => {
  try {
    const { subscription } = req.body || {};
    if (!PushService.isValidSubscription(subscription)) {
      return res.status(400).json({ error: 'Некорректная подписка' });
    }
    const saved = await PushService.subscribe(
      req.user.id,
      subscription,
      req.headers['user-agent'] || null
    );
    if (!saved) {
      return res.status(500).json({ error: 'Не удалось сохранить подписку' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[pushSubscribe] Ошибка:', err);
    NotificationService.logServerError('user.pushSubscribe', err, {
      userId: req.user?.id,
    });
    res.status(500).json({ error: err.message });
  }
};

/**
 * Удалить подписку устройства (кнопка «Отключить», выход из системы).
 * Body: { endpoint } — одно устройство, { all: true } — все устройства.
 */
exports.pushUnsubscribe = async (req, res) => {
  try {
    const { endpoint, all } = req.body || {};
    let removed;
    if (all) {
      removed = await PushService.unsubscribeAll(req.user.id);
    } else {
      if (typeof endpoint !== 'string' || !endpoint.trim()) {
        return res.status(400).json({ error: 'Укажите endpoint подписки' });
      }
      removed = await PushService.unsubscribe(req.user.id, endpoint.trim());
    }
    res.json({ ok: true, removed });
  } catch (err) {
    console.error('[pushUnsubscribe] Ошибка:', err);
    NotificationService.logServerError('user.pushUnsubscribe', err, {
      userId: req.user?.id,
    });
    res.status(500).json({ error: err.message });
  }
};

/**
 * Сколько устройств пользователя подписано на Web Push (для UI профиля).
 */
exports.getPushStatus = async (req, res) => {
  try {
    const count = await PushService.countForUser(req.user.id);
    res.json({ enabled: PushService.enabled, count });
  } catch (err) {
    console.error('[getPushStatus] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Получить список товаров без статистики для текущего пользователя (проверка)
 */
exports.getMissingStats = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const activeOrders = await Assignment.getActiveOrders(userId);
    const missingOffers = new Set();
    for (const order of activeOrders) {
      const details = await OzonService.getOrderDetails(order.order_id);
      if (details && details.products) {
        for (const p of details.products) {
          if (!p.offer_id) continue;
          const stat = await ProductStat.get(p.offer_id);
          if (!stat) {
            missingOffers.add(p.offer_id);
          }
        }
      }
    }
    res.json({ missingOffers: Array.from(missingOffers) });
  } catch (err) {
    console.error('[getMissingStats] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
};