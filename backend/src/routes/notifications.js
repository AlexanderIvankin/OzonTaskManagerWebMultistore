const express = require('express');
const router = express.Router();
const { authenticate, authorize, STAFF_ROLES } = require('../middlewares/auth');
const Notification = require('../models/Notification');
const NotificationService = require('../services/NotificationService');
const { notifyUser } = require('../socket');

// Аутентификация для всех маршрутов
router.use(authenticate);

const isStaffRole = (role) => STAFF_ROLES.includes(role);

const parseIds = (value) =>
  Array.isArray(value) ? value.map(Number).filter((n) => Number.isInteger(n)) : [];

const parseLimitOffset = (query) => ({
  limit: Math.min(Math.max(parseInt(query.limit) || 30, 1), 100),
  offset: Math.max(parseInt(query.offset) || 0, 0),
});

/**
 * Определяет «ящик» оповещений из box (query или body):
 *   mine  — личные оповещения (все роли);
 *   staff — журнал действий сотрудников (только admin/moderator).
 * Возвращает 'mine' | 'staff' | null (null — нет доступа).
 */
function resolveBox(req) {
  const box = req.query.box === 'staff' || req.body?.box === 'staff' ? 'staff' : 'mine';
  if (box === 'staff' && !isStaffRole(req.user.role)) return null;
  return box;
}

// Сообщаем клиенту, что счётчики изменились (для живого бейджа в сайдбаре)
function emitCountersChanged(userId) {
  notifyUser(userId, 'notifications_changed', { createdAt: Date.now() });
}

// ===========================================================================
// ОПОВЕЩЕНИЯ (личные "mine" + журнал действий "staff")
// ===========================================================================

// Список оповещений с пагинацией и поиском (по номеру заказа / имени сотрудника)
router.get('/', async (req, res) => {
  try {
    const box = resolveBox(req);
    if (!box) return res.status(403).json({ error: 'Forbidden' });

    const { limit, offset } = parseLimitOffset(req.query);
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';

    // Поиск (опционально): точная подстрока в order_id / user_name
    const orderId =
      typeof req.query.orderId === 'string' && req.query.orderId.trim()
        ? req.query.orderId.trim()
        : null;
    const userName =
      typeof req.query.userName === 'string' && req.query.userName.trim()
        ? req.query.userName.trim()
        : null;
    const offerId =
      typeof req.query.offerId === 'string' && req.query.offerId.trim()
        ? req.query.offerId.trim()
        : null;

    const result = await Notification.getByRecipient(req.user.id, {
      audience: box === 'staff' ? 'staff' : 'user',
      unreadOnly,
      limit,
      offset,
      orderId,
      userName,
      offerId,
    });
    res.json(result);
  } catch (err) {
    console.error('[notifications] list:', err);
    NotificationService.logServerError('notifications.list', err);
    res.status(500).json({ error: err.message });
  }
});

// Количество непрочитанных (для бейджа)
router.get('/unread-count', async (req, res) => {
  try {
    const box = resolveBox(req);
    if (!box) return res.status(403).json({ error: 'Forbidden' });

    const count = await Notification.getUnreadCount(req.user.id, {
      audience: box === 'staff' ? 'staff' : 'user',
    });
    res.json({ count });
  } catch (err) {
    console.error('[notifications] unread-count:', err);
    NotificationService.logServerError('notifications.unreadCount', err);
    res.status(500).json({ error: err.message });
  }
});

// Отметить прочитанными: { box, ids?: number[] } или { box, all: true }
router.post('/read', async (req, res) => {
  try {
    const box = resolveBox(req);
    if (!box) return res.status(403).json({ error: 'Forbidden' });
    const audience = box === 'staff' ? 'staff' : 'user';

    let changed = 0;
    if (req.body.all) {
      changed = await Notification.markAllRead(req.user.id, { audience });
    } else {
      changed = await Notification.markRead(req.user.id, parseIds(req.body.ids));
    }

    emitCountersChanged(req.user.id);
    res.json({ changed });
  } catch (err) {
    console.error('[notifications] read:', err);
    NotificationService.logServerError('notifications.read', err);
    res.status(500).json({ error: err.message });
  }
});

// Удалить выбранные: { box, ids: number[] }
router.post('/delete', async (req, res) => {
  try {
    const box = resolveBox(req);
    if (!box) return res.status(403).json({ error: 'Forbidden' });

    const changed = await Notification.deleteByIds(
      req.user.id,
      parseIds(req.body.ids)
    );

    emitCountersChanged(req.user.id);
    res.json({ changed });
  } catch (err) {
    console.error('[notifications] delete:', err);
    NotificationService.logServerError('notifications.delete', err);
    res.status(500).json({ error: err.message });
  }
});

// Удалить все прочитанные: { box }
router.post('/clear-read', async (req, res) => {
  try {
    const box = resolveBox(req);
    if (!box) return res.status(403).json({ error: 'Forbidden' });

    const changed = await Notification.deleteRead(req.user.id, {
      audience: box === 'staff' ? 'staff' : 'user',
    });

    emitCountersChanged(req.user.id);
    res.json({ changed });
  } catch (err) {
    console.error('[notifications] clear-read:', err);
    NotificationService.logServerError('notifications.clearRead', err);
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// ОШИБКИ СЕРВЕРА (только admin/moderator)
// ===========================================================================

// Список ошибок сервера (с фильтром «только непрочитанные»)
router.get('/errors', authorize(...STAFF_ROLES), async (req, res) => {
  try {
    const { limit, offset } = parseLimitOffset(req.query);
    const level =
      req.query.level === 'error' || req.query.level === 'warn'
        ? req.query.level
        : null;
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';

    const result = await Notification.getErrors({
      level,
      unreadOnly,
      limit,
      offset,
    });
    res.json(result);
  } catch (err) {
    console.error('[notifications] errors:', err);
    res.status(500).json({ error: err.message });
  }
});

// Количество ошибок (для бейджа вкладки)
router.get('/errors/count', authorize(...STAFF_ROLES), async (req, res) => {
  try {
    const level =
      req.query.level === 'error' || req.query.level === 'warn'
        ? req.query.level
        : null;
    const count = await Notification.countErrors({ level });
    res.json({ count });
  } catch (err) {
    console.error('[notifications] errors/count:', err);
    res.status(500).json({ error: err.message });
  }
});

// Количество непрочитанных ошибок (для кнопки «Прочитать всё»)
router.get(
  '/errors/unread-count',
  authorize(...STAFF_ROLES),
  async (req, res) => {
    try {
      const level =
        req.query.level === 'error' || req.query.level === 'warn'
          ? req.query.level
          : null;
      const count = await Notification.getUnreadErrorsCount({ level });
      res.json({ count });
    } catch (err) {
      console.error('[notifications] errors/unread-count:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Отметить прочитанными выбранные ошибки: { ids: number[] }
// или все: { all: true }
router.post('/errors/read', authorize(...STAFF_ROLES), async (req, res) => {
  try {
    let changed;
    if (req.body.all) {
      changed = await Notification.markAllErrorsRead();
    } else {
      changed = await Notification.markErrorsRead(parseIds(req.body.ids));
    }
    res.json({ changed });
  } catch (err) {
    console.error('[notifications] errors/read:', err);
    res.status(500).json({ error: err.message });
  }
});

// Удалить выбранные ошибки: { ids: number[] }
router.post('/errors/delete', authorize(...STAFF_ROLES), async (req, res) => {
  try {
    const changed = await Notification.deleteErrorsByIds(parseIds(req.body.ids));
    res.json({ changed });
  } catch (err) {
    console.error('[notifications] errors/delete:', err);
    res.status(500).json({ error: err.message });
  }
});

// Очистить весь журнал ошибок
router.post('/errors/clear', authorize(...STAFF_ROLES), async (req, res) => {
  try {
    const changed = await Notification.clearErrors();
    res.json({ changed });
  } catch (err) {
    console.error('[notifications] errors/clear:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
