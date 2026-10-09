const { Assignment, UserStats, Earnings, ProductStat, UserStore, User } = require('../models');
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

// ============================================================================
// Все методы userController — store-scoped.
// storeId всегда берётся из req.storeId (резолвится по Host в server.js).
// Глобальные данные (users, notifications, push_subscriptions) — из общих БД;
// рабочие данные магазина — из store-N.db.
// ============================================================================

/**
 * Профиль текущего пользователя В КОНТЕКСТЕ МАГАЗИНА.
 * Глобальные поля users + per-store статус (роль, is_fired, коэф.) + статистика
 * магазина (user_stats, активные/завершённые назначения).
 */
exports.getProfile = async (req, res) => {
  try {
    const storeId = req.storeId;
    const userId = req.user.id;

    const storeRecord = await UserStore.get(userId, storeId);
    const stats = await UserStats.getStats(storeId, userId);
    const activeOrders = await Assignment.getActiveOrders(storeId, userId);
    const completedOrders = await Assignment.getCompletedOrders(storeId, userId);

    res.json({
      ...req.user,
      // per-store блок — фронт показывает/скрывает разделы по этой роли
      store: storeRecord
        ? {
          role: storeRecord.role,
          is_fired: !!storeRecord.is_fired,
          earnings_factor: storeRecord.earnings_factor,
          was_employee: !!storeRecord.was_employee,
        }
        : null,
      stats,
      activeOrders,
      completedOrders,
    });
  } catch (err) {
    console.error(`[getProfile][store ${req.storeId}] Ошибка:`, err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Отображаемое имя — глобальное поле users.display_name (своё у пользователя
 * во всех магазинах сразу).
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
    console.error(`[updateDisplayName][store ${req.storeId}] Ошибка:`, err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Активные заказы сотрудника (с составом, фото, статусом статистики).
 */
exports.getActiveOrders = async (req, res, next) => {
  try {
    const orders = await OrderService.buildActiveOrders(req.storeId, req.user.id);
    res.json(orders);
  } catch (err) {
    console.error(`[getActiveOrders][store ${req.storeId}] Ошибка:`, err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Завершённые заказы, ещё ожидающие отправки (awaiting_deliver).
 */
exports.getCompletedOrders = async (req, res, next) => {
  try {
    const orders = await OrderService.buildCompletedOrdersAwaitingDeliver(
      req.storeId,
      req.user.id
    );
    res.json(orders);
  } catch (err) {
    console.error(`[getCompletedOrders][store ${req.storeId}] Ошибка:`, err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Обновить статусы всех заказов сотрудника (активные + завершённые).
 * Кулдаун 1 минута (middlewares/cooldown → CooldownService.touch).
 */
exports.refreshOrders = async (req, res, next) => {
  const storeId = req.storeId;
  const userId = req.user.id;
  try {
    const sync = await OrderService.syncOrderStatuses(storeId);
    await OrderService.cleanExpiredAssignments(storeId, sync.activeOrderIds, { userId });

    const [active, completed] = await Promise.all([
      OrderService.buildActiveOrders(storeId, userId),
      OrderService.buildCompletedOrdersAwaitingDeliver(storeId, userId),
    ]);

    // Кулдаун ставится ТОЛЬКО после успешной синхронизации
    CooldownService.touch('refreshOrders', storeId, userId);
    res.json({ active, completed, syncedAt: Date.now(), removed: sync.removed });
  } catch (err) {
    console.error(`[refreshOrders][store ${storeId}] Ошибка:`, err);
    res.status(400).json({ error: err.message });
  }
};

/**
 * Завершить заказ (требуется статистика по всем товарам).
 */
exports.finishOrder = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = req.user.id;
    const { orderId } = req.params;
    const result = await OrderService.finishOrder(storeId, orderId, userId);
    res.json({
      message: 'Order finished',
      earnings: result.earnings,
      label: result.labelAvailable ? 'label available' : 'no label',
    });
  } catch (err) {
    console.error(`[finishOrder][store ${req.storeId}] Ошибка:`, err);
    res.status(400).json({ error: err.message });
  }
};

/**
 * Отменить заказ (с подтверждением на фронте).
 */
exports.cancelOrder = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = req.user.id;
    const { orderId } = req.params;
    await OrderService.cancelOrder(storeId, orderId, userId);
    res.json({ message: 'Order cancelled' });
  } catch (err) {
    console.error(`[cancelOrder][store ${req.storeId}] Ошибка:`, err);
    res.status(400).json({ error: err.message });
  }
};

/**
 * Этикетка завершённого заказа.
 */
exports.getLabel = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = req.user.id;
    const { orderId } = req.params;
    const labelBuffer = await OrderService.getLabel(storeId, orderId, userId);
    if (!labelBuffer) {
      return res.status(404).json({ error: 'Label not available' });
    }
    // Кулдаун ставится только после успешной выдачи
    CooldownService.touch('label', storeId, userId);
    disableCache(res);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=label_${orderId}.pdf`);
    res.send(labelBuffer);
  } catch (err) {
    console.error(`[getLabel][store ${req.storeId}] Ошибка:`, err);
    res.status(400).json({ error: err.message });
  }
};

/**
 * Все этикетки для завершённых заказов сотрудника (склейка на стороне Ozon).
 */
exports.getAllLabels = async (req, res, next) => {
  const storeId = req.storeId;
  const userId = req.user.id;
  try {
    const pdfBuffer = await OrderService.getAllLabels(storeId, userId);
    if (!pdfBuffer) {
      CooldownService.touch('allLabels', storeId, userId, 1);
      return res.status(404).json({
        error: 'Нет этикеток для скачивания: нет завершённых заказов в статусе awaiting_deliver',
      });
    }
    CooldownService.touch('allLabels', storeId, userId, 0);
    disableCache(res);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=all_labels.pdf');
    res.send(pdfBuffer);
  } catch (err) {
    CooldownService.touch('allLabels', storeId, userId, 1);
    console.error(`[getAllLabels][store ${storeId}] Ошибка:`, err);
    res.status(400).json({ error: err.message });
  }
};

/**
 * Скачать этикетку, отправленную сотруднику администратором (label_sent).
 * Доступ: только если сотруднику отправляли оповещение с этим orderId
 * ИЗ ЭТОГО МАГАЗИНА. Файл: outputs/store-<id>/labels/<orderId>.pdf.
 */
exports.getSentLabel = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = req.user.id;
    const { orderId } = req.params;

    if (!/^[\w-]+$/.test(orderId)) {
      return res.status(400).json({ error: 'Некорректный номер заказа' });
    }
    const notification = await Notification.findLatestByTypeAndOrder(
      userId,
      'label_sent',
      orderId,
      storeId
    );
    if (!notification) {
      return res.status(403).json({ error: 'Этикетка этого заказа не отправлялась вам' });
    }

    const filePath = path.join(
      __dirname,
      '../../outputs',
      `store-${storeId}`,
      'labels',
      `${orderId}.pdf`
    );
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
    console.error(`[getSentLabel][store ${req.storeId}] Ошибка:`, err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * История заработка за месяц.
 */
exports.getMonthlyEarnings = async (req, res, next) => {
  try {
    const storeId = req.storeId;
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
      const now = getLocalDate();
      const year = now.getFullYear();
      const m = now.getMonth();
      fromDate = new Date(year, m, 1).getTime();
      toDate = new Date(year, m + 1, 1).getTime() - 1;
    }

    const history = await Earnings.getHistory(storeId, userId, fromDate, toDate);
    const total = history.reduce((sum, h) => sum + h.amount, 0);
    res.json({
      period: { from: fromDate, to: toDate },
      earnings: history,
      total,
      count: history.length,
    });
  } catch (err) {
    console.error(`[getMonthlyEarnings][store ${req.storeId}] Ошибка:`, err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Активный заработок (с последнего расчёта).
 */
exports.getActiveEarnings = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = req.user.id;
    const active = await Earnings.getActive(storeId, userId, 0, Date.now());
    const totalBase = active.reduce((sum, a) => sum + a.amount, 0);
    const adjustments = await Earnings.getActiveAdjustmentsSum(storeId, userId, 0, Date.now());
    res.json({
      baseEarnings: totalBase,
      adjustments,
      total: totalBase + adjustments,
      orders: active,
    });
  } catch (err) {
    console.error(`[getActiveEarnings][store ${req.storeId}] Ошибка:`, err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Переключить приём заказов.
 * taking_orders — глобальное поле users (принимает ли человек заказы вообще,
 * во всех магазинах сразу). Кулдаун и оповещение — per-store.
 */
exports.toggleOrders = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await User.getById(userId);
    if (!user) throw new Error('User not found');

    const newStatus = user.taking_orders === 1 ? 0 : 1;
    await User.update(userId, { taking_orders: newStatus });

    // Кулдаун: если запрос пришёл с магазинного домена — с ключом
    // 'storeId:userId'; если с глобального — 'null:userId' (единый для
    // всех магазинов, но отдельный от магазинных).
    CooldownService.touch('toggleOrders', req.storeId, userId);

    // Оповещение персоналу. Если контекст магазина известен — только ему.
    // Если нет (глобальный домен) — во ВСЕ магазины, где пользователь
    // числится сотрудником: каждый магазин получит свою запись в журнале.
    const payload = {
      userId,
      userName: user.name,
      takingOrders: newStatus === 1,
    };
    if (req.storeId) {
      NotificationService.notifyStaff('taking_orders_changed', payload, {
        storeId: req.storeId,
      });
    } else {
      const UserStore = require('../models/UserStore');
      const rows = await UserStore.listByUser(userId);
      for (const r of rows) {
        if (r.is_fired) continue;
        NotificationService.notifyStaff('taking_orders_changed', payload, {
          storeId: r.store_id,
        });
      }
    }

    res.json({ taking_orders: newStatus });
  } catch (err) {
    console.error(`[toggleOrders][store ${req.storeId || '—'}] Ошибка:`, err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Заполнить статистику товара (материал, цвет, вес).
 */
exports.fillStats = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = req.user.id;
    const { offerId, material, color, weight } = req.body;
    if (!offerId || !material || !color || !weight) {
      return res.status(400).json({ error: 'Missing fields' });
    }

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

    await ProductStat.upsert(storeId, offerId, material, color, weightNum, userId);

    NotificationService.notifyStaff('stats_filled', {
      userId,
      userName: req.user.name,
      offerId,
      material,
      color,
      weight: weightNum,
    }, { storeId });

    res.json({ message: 'Stats saved' });
  } catch (err) {
    console.error(`[fillStats][store ${req.storeId}] Ошибка:`, err);
    res.status(500).json({ error: err.message });
  }
};

// ============================================================================
// WEB PUSH: подписки устройства — ГЛОБАЛЬНЫЕ (не store-scoped).
// Одно устройство = одна подписка. Если пользователь подписан на push,
// он получает оповещения всех магазинов, где у него есть роль (вкладки
// на разных поддоменах → одна push-подписка на браузер). NotificationService
// сам решает, кому и на какой storeId слать (см. socket + push).
// ============================================================================

exports.getPushPublicKey = (req, res) => {
  const publicKey = PushService.publicKey;
  if (!publicKey) {
    return res.status(503).json({ error: 'Web Push не настроен на сервере' });
  }
  res.json({ publicKey });
};

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
    console.error(`[pushSubscribe][store ${req.storeId}] Ошибка:`, err);
    NotificationService.logServerError('user.pushSubscribe', err, {
      storeId: req.storeId,
      userId: req.user?.id,
    });
    res.status(500).json({ error: err.message });
  }
};

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
    console.error(`[pushUnsubscribe][store ${req.storeId}] Ошибка:`, err);
    NotificationService.logServerError('user.pushUnsubscribe', err, {
      storeId: req.storeId,
      userId: req.user?.id,
    });
    res.status(500).json({ error: err.message });
  }
};

exports.getPushStatus = async (req, res) => {
  try {
    const count = await PushService.countForUser(req.user.id);
    res.json({ enabled: PushService.enabled, count });
  } catch (err) {
    console.error(`[getPushStatus][store ${req.storeId}] Ошибка:`, err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Товары без заполненной статистики среди активных заказов сотрудника.
 */
exports.getMissingStats = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = req.user.id;
    const activeOrders = await Assignment.getActiveOrders(storeId, userId);
    const missingOffers = new Set();

    for (const order of activeOrders) {
      const details = await OzonService.getOrderDetails(storeId, order.order_id);
      if (details && details.products) {
        for (const p of details.products) {
          if (!p.offer_id) continue;
          const stat = await ProductStat.get(storeId, p.offer_id);
          if (!stat) missingOffers.add(p.offer_id);
        }
      }
    }
    res.json({ missingOffers: Array.from(missingOffers) });
  } catch (err) {
    console.error(`[getMissingStats][store ${req.storeId}] Ошибка:`, err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Список магазинов, доступных текущему пользователю.
 *
 * Используется страницей «Глобальный профиль» (корневой домен): показывает
 * карточки магазинов, где пользователь имеет запись в user_stores, и
 * магазины без записи (можно предложить «запросить доступ»).
 *
 * Работает БЕЗ магазина в запросе (req.storeId = null) — это разрешено
 * резолвером для пути /user/stores.
 *
 * Ответ для каждого магазина реестра:
 *   {
 *     store_id, name, subdomain, client_origin,
 *     role: 'employee' | 'moderator' | 'admin' | 'god' | null,
 *     is_fired: boolean | null,       // null — записи нет
 *     earnings_factor: number | null,
 *     was_employee: boolean | null,
 *     has_access: boolean,            // есть ли доступ к сотрудническим фичам
 *   }
 */
exports.getUserStores = async (req, res) => {
  try {
    const userId = req.user.id;
    const UserStore = require('../models/UserStore');
    const stores = require('../config/stores');

    // Per-store записи пользователя
    const userStoreRows = await UserStore.listByUser(userId);
    const byStoreId = new Map(
      userStoreRows.map((r) => [String(r.store_id), r])
    );

    // Обходим ВСЕ зарегистрированные магазины (порядок — по STORE_ID)
    const allStoreIds = stores.getStoreIds();
    const result = allStoreIds.map((sid) => {
      const store = stores.getStore(sid);
      const record = byStoreId.get(sid);

      return {
        store_id: sid,
        name: store.name,
        subdomain: store.subdomain,
        client_origin: store.clientOrigin,
        // Записи может не быть — пользователь «глобальный», к магазину
        // отношения не имеет
        role: record ? record.role : null,
        is_fired: record ? !!record.is_fired : null,
        earnings_factor: record ? record.earnings_factor : null,
        was_employee: record ? !!record.was_employee : null,
        // Может ли пользователь войти в магазин как сотрудник/staff
        has_access: !!(record && !record.is_fired),
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[getUserStores] Ошибка:', err);
    res.status(500).json({ error: err.message });
  }
};