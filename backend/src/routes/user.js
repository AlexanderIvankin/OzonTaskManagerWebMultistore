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
// Глобальные (не store-scoped) роуты — доступны ЛЮБОМУ авторизованному,
// в том числе на корневом домене без магазина (req.storeId = null).
// Размещены ДО requireEmployee.
// ===========================================================================

// Список магазинов пользователя (для страницы «Глобальный профиль»).
// Резолвер разрешает /user/stores без магазина — из него строится dashboard.
router.get('/stores', userController.getUserStores);

// Web Push: подписки на оповещения.
// Подписаться может любой авторизованный (личные оповещения приходят всем
// ролям, включая 'user'). Канал доставки (Socket.IO или Web Push) выбирает
// NotificationService.
router.get('/push-public-key', userController.getPushPublicKey);
router.get('/push-status', userController.getPushStatus);
router.post('/push-subscribe', userController.pushSubscribe);
router.post('/push-unsubscribe', userController.pushUnsubscribe);

// Приём заказов — сквозной флаг users.taking_orders (глобальный).
// Работает и на глобальном домене (req.storeId = null): сотрудник может
// отключить приём заказов сразу во всех магазинах, где он числится.
// Кулдаун — с ключом 'null:userId' (единый для всех магазинов).
router.post(
  '/toggle-orders',
  cooldown('toggleOrders', 'Переключение приёма заказов'),
  userController.toggleOrders,
);

// Отображаемое имя (display_name) — глобальное поле users.
// Редактируется ТОЛЬКО на странице GlobalProfile (корневой домен);
// в магазинах display_name показывается, но не редактируется.
// Работает без магазина (req.storeId = null на глобальном домене).
router.put('/display-name', userController.updateDisplayName);

// Для всех остальных маршрутов требуется роль сотрудника (employee, moderator, admin)
router.use(requireEmployee);

// ===========================================================================
// Роуты в контексте магазина (нужен сотрудник, req.storeId != null)
// ===========================================================================

// Названия материалов и цвета магазина — для формы «Заполнить статистику»
// (employee+; на /admin/materials у сотрудника не было доступа).
// Тонкий payload: без цен за грамм (они — только для персонала).
router.get('/materials', userController.getMaterialsForForm);

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

// Заработок за месяц
router.get('/earnings/monthly', userController.getMonthlyEarnings);

// Активный заработок
router.get('/earnings/active', userController.getActiveEarnings);

// Заполнить статистику
router.post('/fill-stats', userController.fillStats);

// Получить не заполненные статистики
router.get('/missing-stats', userController.getMissingStats);

module.exports = router;