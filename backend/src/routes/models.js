const express = require('express');
const router = express.Router();
const { authenticate, requireEmployee } = require('../middlewares/auth');
const modelsController = require('../controllers/modelsController');

// ============================================================================
// Маршруты 3D-моделей (zip-архивы в S3). Прямых ссылок на S3 нет:
//   1) POST /api/models/request/:offerId  — выдать одноразовый токен скачивания
//      (доступ: выданная модель, активный заказ с этим артикулом или персонал);
//   2) GET  /api/models/download/:token   — скачать zip по токену.
//      Аутентификация по токену (32 байта, TTL ~15 мин, одноразовый),
//      поэтому здесь НЕТ authenticate: токен сам является доказательством
//      доступа. Bearer-токен проверяется опционально (сверка владельца).
// ============================================================================

router.post('/request/:offerId', authenticate, requireEmployee, modelsController.requestDownload);
router.get('/download/:token', modelsController.downloadByToken);

module.exports = router;
