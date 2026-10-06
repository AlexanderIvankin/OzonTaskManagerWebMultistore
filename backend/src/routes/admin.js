const express = require('express');
const router = express.Router();
const { authenticate, authorize, STAFF_ROLES } = require('../middlewares/auth');
const adminController = require('../controllers/adminController');
const multer = require('multer');
const path = require('path');

// Настройка multer для загрузки файлов (временное хранилище)
const upload = multer({ dest: 'uploads/' });

// Все маршруты требуют аутентификации и роли персонала (admin/moderator/god).
// Модератор = Администратор по правам.
router.use(authenticate);
router.use(authorize(...STAFF_ROLES));

// --- Управление пользователями ---
router.get('/users', adminController.getUsers);
router.get('/users/:id', adminController.getUserById);
// Создание аккаунта администратором (в обход подтверждения email)
router.post('/users', adminController.createUserByAdmin);
router.put('/users/:id', adminController.updateUser);
router.delete('/users/:id', adminController.fireUser);

// --- Статистика персонала (вкладка «Статистика», только персонал) ---
router.get('/stats', adminController.getStaffStats);
// 🎃 Пасхалка: редактирование фейковой статистики Создателя — только god
router.put('/stats/god', authorize('god'), adminController.updateGodFakeStats);

// --- Синхронизация из Excel ---
router.post('/sync/employees', upload.single('file'), adminController.syncEmployees);
// Синхронизация из серверного файла team-info.xlsx (кнопка «Обновить»)
router.post('/sync/server-file', adminController.syncEmployeesServerFile);
// Актуальное (версионированное) имя файла сотрудников — для строгой
// проверки имени при загрузке файла на странице «Пользователи»
router.get('/sync/expected-filename', adminController.getSyncExpectedFileName);
// --- Экспорт данных ---
router.get('/export/team-info', adminController.exportTeamInfo);
router.get('/export/product-stats', adminController.exportProductStats);
router.get('/export/database', authorize(...STAFF_ROLES), adminController.downloadDatabase); // персонал (admin/moderator/god)
router.post('/backup', authorize(...STAFF_ROLES), adminController.createBackup); // ручной бэкап, персонал

// --- Конфигурация materials-prices.json ---
router.get('/materials', adminController.getMaterials);
router.get('/materials/download', adminController.downloadMaterials);
router.post('/materials/upload', upload.single('file'), adminController.uploadMaterials);

// --- Склады ---
router.get('/warehouses', adminController.getWarehouses);
router.post('/warehouses/sync', adminController.syncWarehouses);

// --- Заказы ---
router.get('/orders/awaiting', adminController.getAwaitingOrders);
router.get('/orders/active', adminController.getActiveOrdersAll);
router.get('/orders/:orderId/details', adminController.getOrderDetails);
router.post('/orders/:orderId/assign', adminController.assignOrder);
router.post('/orders/:orderId/unassign', adminController.unassignOrder);
// Этикетка заказа (аналог /admin_send_label): без сотрудника — скачать себе,
// с сотрудником — отправить ему оповещение с кнопкой скачивания
router.get('/orders/:orderId/label', adminController.downloadOrderLabel);
router.post('/orders/:orderId/label/send', adminController.sendOrderLabelToEmployee);
router.get('/users/:id/orders', adminController.getUserOrders);
// Завершённые заказы: query userId (опционально — все сотрудники), days (период),
// limit (размер страницы или 'all' — полная выгрузка), offset (пагинация),
// orderId (подстрока номера заказа), offerId (подстрока артикула)
router.get('/orders/completed', adminController.getCompletedOrders);
router.get('/users/:id/stats', adminController.getUserStats);

// --- Заработок ---
router.get('/earnings/monthly', adminController.exportMonthlyEarnings);
router.get('/earnings/active', adminController.getActiveEarningsAll);
router.post('/earnings/adjust', adminController.addEarningsAdjustment);
router.post('/earnings/settle/:id', adminController.settleEarnings);
router.post('/earnings/reset', authorize(...STAFF_ROLES), adminController.resetAllEarnings); // персонал (admin/moderator/god)

// --- Административные команды ---
router.post('/assignments/clear', authorize(...STAFF_ROLES), adminController.clearAssignments);
router.post('/orders/reload-queue', authorize(...STAFF_ROLES), adminController.reloadQueue);

// --- Статистика товара: удаление (аналог /clear_product_stats) ---
router.delete('/product-stats/:offerId', adminController.deleteProductStats);

// --- 3D-модели (zip-архивы в S3, раздел «Модели») ---
// Модель на артикул — ОДИН zip-архив в корне бакета: s3://<bucket>/{offer_id}.zip.
// Лимит размера zip — MODELS_MAX_UPLOAD_MB (по умолчанию 1024 МБ = 1 ГБ).
// Жёсткая проверка «только .zip» выполняется в adminController.uploadModel
// (расширение имени файла + magic-байты архива): при отказе загрузивший
// получает live-оповещение, а запись в историю не создаётся.
const modelsUpload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: (parseInt(process.env.MODELS_MAX_UPLOAD_MB, 10) || 1024) * 1024 * 1024,
  },
});
router.get('/models', adminController.listModels);
router.post('/models/upload', modelsUpload.single('file'), adminController.uploadModel);
router.get('/models/:offerId/download', adminController.downloadModel);
router.delete('/models/:offerId', adminController.deleteModel);

// --- Планировщик: пауза/возобновление авто-проверки очереди (аналог /pause, /resume) ---
router.get('/scheduler/status', adminController.getSchedulerStatus);
router.post('/scheduler/pause', adminController.pauseScheduler);
router.post('/scheduler/resume', adminController.resumeScheduler);

// --- Команды Модератора ---
// Получить текущий заказ для модерации
// router.get('/orders/current', adminController.getCurrentOrder);
// Получить всю очередь
// router.get('/orders/queue', adminController.getPendingOrders);
// Пропустить текущий заказ
// router.post('/orders/skip', adminController.skipOrder);

module.exports = router;