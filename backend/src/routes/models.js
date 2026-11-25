const express = require('express');
const router = express.Router();
const { authenticate, requireEmployee } = require('../middlewares/auth');
const { requireModelsEnabled } = require('../middlewares/requireModelsEnabled');
const modelsController = require('../controllers/modelsController');

// ============================================================================
// Двухфазное скачивание 3D-моделей (zip в S3). Прямых ссылок на S3 нет.
//
//   Фаза 1 — POST /api/models/prepare/:offerId
//            Access: authenticate + requireEmployee + requireModelsEnabled.
//            Доступ к артикулу: выданная модель / активный заказ / staff.
//            200 { ready:true,  token }      — файл уже в кэше;
//            202 { ready:false, taskId }     — запущена фоновая задача S3→кэш.
//
//   Опрос   — GET  /api/models/tasks/:taskId
//            200 { status:'preparing'|'ready'|'failed', ... }
//            404 → задача потеряна (рестарт процесса) → повторить /prepare.
//
//   Фаза 2 — GET  /api/models/download/:token
//            Аутентификация по токену (32 байта, TTL 15 мин, reusable для
//            Range). Bearer-токен опционален (сверка владельца).
// ============================================================================

router.post(
  '/prepare/:offerId',
  authenticate,
  requireEmployee,
  requireModelsEnabled,
  modelsController.prepareDownload
);

router.get(
  '/tasks/:taskId',
  authenticate,
  requireEmployee,
  modelsController.getTask
);

router.get(
  '/download/:token',
  requireModelsEnabled,
  modelsController.downloadByToken
);

module.exports = router;