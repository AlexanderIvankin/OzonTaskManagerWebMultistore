const express = require('express');
const router = express.Router();
const { authenticate, requireEmployee } = require('../middlewares/auth');
const { cooldown } = require('../middlewares/cooldown');
const userController = require('../controllers/userController');

// Аутентификация для всех маршрутов
router.use(authenticate);

// Профиль доступен всем авторизованным (даже с ролью 'user')
router.get('/profile', userController.getProfile);

// Обновление отображаемого имени (display_name) — только свой профиль,
// доступно всем авторизованным (даже с ролью 'user')
router.put('/profile', userController.updateDisplayName);

// ===========================================================================
// Web Push: подписки на оповещения.
// Размещено ДО requireEmployee — подписаться может ЛЮБОЙ авторизованный, т.к.
// личные оповещения приходят всем ролям (включая 'user': например, сброс пароля).
// Канал доставки (Socket.IO или Web Push) выбирает NotificationService.
// ===========================================================================
router.get('/push-public-key', userController.getPushPublicKey);
router.get('/push-status', userController.getPushStatus);
router.post('/push-subscribe', userController.pushSubscribe);
router.post('/push-unsubscribe', userController.pushUnsubscribe);

// Для всех остальных маршрутов требуется роль сотрудника (employee, moderator, admin)
router.use(requireEmployee);

// Активные заказы
router.get('/orders/active', userController.getActiveOrders);

// Завершённые заказы сотрудника, ещё ожидающие отправки (awaiting_deliver) —
// вкладка «🗳️ Завершённые заказы» (в каждой карточке кнопка «Скачать этикетку»)
router.get('/orders/completed', userController.getCompletedOrders);

// Обновить статусы всех заказов сотрудника (активные + завершённые) и получить
// оба списка: синхронизация с Ozon (2 запроса) + кулдаун 1 минута от спама
router.post(
  '/orders/refresh',
  cooldown('refreshOrders', 'Обновление заказов'),
  userController.refreshOrders
);


// Завершить заказ
router.post('/orders/:orderId/finish', userController.finishOrder);

// Отменить заказ
router.post('/orders/:orderId/cancel', userController.cancelOrder);

// Получить этикетку (кулдаун 1 мин после успеха — как /send_label в боте)
router.get(
  '/orders/:orderId/label',
  cooldown('label', 'Скачивание этикетки'),
  userController.getLabel
);

// Получить склейку всех этикеток (1 час после успеха / 1 мин после пустого ответа)
router.get(
  '/orders/labels/all',
  cooldown('allLabels', 'Скачивание всех этикеток'),
  userController.getAllLabels
);

// Скачать этикетку, отправленную администратором (label_sent)
router.get('/labels/:orderId/sent', userController.getSentLabel);

// Переключить приём заказов (кулдаун 1 мин после успеха — как /toggle_orders в боте)
router.post(
  '/toggle-orders',
  cooldown('toggleOrders', 'Переключение приёма заказов'),
  userController.toggleOrders
);

// Заработок за месяц
router.get('/earnings/monthly', userController.getMonthlyEarnings);

// Активный заработок
router.get('/earnings/active', userController.getActiveEarnings);

// Заполнить статистику
router.post('/fill-stats', userController.fillStats);

// Получить не заполненные статистики
router.get('/missing-stats', userController.getMissingStats);

module.exports = router;