const fs = require('fs');
const ModelService = require('../services/ModelService');
const ModelDownloadTaskService = require('../services/ModelDownloadTaskService');
const StorageService = require('../services/StorageService');
const OfferModel = require('../models/OfferModel');
const { disableCache } = require('../utils');

/**
 * Контроллер 3D-моделей (zip-архивы в S3).
 *
 * Двухфазное скачивание:
 *   1) POST /api/models/prepare/:offerId — подготовка.
 *        200 { ready:true, token }        — файл уже в кэше;
 *        202 { ready:false, taskId }      — запущена фоновая задача S3→кэш.
 *   2) GET  /api/models/tasks/:taskId  — опрос статуса задачи.
 *        200 { status:'preparing'|'ready'|'failed', ... } (ready + token).
 *   3) GET  /api/models/download/:token — скачивание из локального кэша.
 *        Токен reusable до TTL (Range-докачка), Bearer опционален.
 */

/**
 * Стрим локального файла с поддержкой Range (докачка при обрыве).
 * Ставит Content-Type/Disposition/Accept-Ranges и, при необходимости,
 * Content-Range + 206 Partial Content.
 */
function streamLocalFile(req, res, filePath, fileName, version) {
  const stat = fs.statSync(filePath);
  const size = stat.size;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  if (version) res.setHeader('X-Model-Version', String(version));

  const range = req.headers.range;
  const m = range && /^bytes=(\d+)-(\d*)$/.exec(range);

  if (!m) {
    // Полная отдача
    res.setHeader('Content-Length', String(size));
    const stream = fs.createReadStream(filePath);
    res.on('close', () => stream.destroy());
    stream.on('error', (err) => {
      console.error('[modelsController] stream error:', err);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.pipe(res);
    return;
  }

  // Частичная отдача (206)
  const start = parseInt(m[1], 10);
  const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
  if (start >= size || start > end) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${size}`);
    res.end();
    return;
  }
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', String(end - start + 1));
  const stream = fs.createReadStream(filePath, { start, end });
  res.on('close', () => stream.destroy());
  stream.on('error', (err) => {
    console.error('[modelsController] stream error:', err);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  stream.pipe(res);
}

/**
 * Фаза 1: подготовка модели.
 *  200 — кэш свежий, выдан token;
 *  202 — запущена задача S3→кэш, клиент опрашивает /tasks/:taskId.
 */
exports.prepareDownload = async (req, res) => {
  try {
    const { offerId } = req.params;
    const result = await ModelService.prepareDownload(
      offerId,
      req.user,
      { storeId: req.storeId }
    );
    if (result.ready) return res.json(result);
    return res.status(202).json(result);
  } catch (err) {
    console.error('[modelsController.prepareDownload] Ошибка:', err);
    const status =
      err.status ||
      (err.message && err.message.includes('не найдена') ? 404 : 400);
    res.status(status).json({ error: err.message || 'Не удалось подготовить модель' });
  }
};

/**
 * Фаза 1b: статус задачи подготовки.
 *  preparing → готовим
 *  ready     → выдан одноразовый token (reusable до TTL, Range)
 *  failed    → ошибка; клиент может повторить POST /prepare
 *  404       → задача потеряна (рестарт процесса) — re-prepare
 */
exports.getTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = ModelDownloadTaskService.getForUser(taskId, req.user.id);
    if (!task) {
      return res.status(404).json({
        error: 'Задача не найдена или истекла',
        code: 'TASK_NOT_FOUND',
      });
    }

    if (task.status === 'preparing') {
      return res.json({
        status: 'preparing',
        taskId: task.id,
        offerId: task.offerId,
        fileName: task.fileName,
        fileSize: task.fileSize,
      });
    }

    if (task.status === 'failed') {
      return res.json({
        status: 'failed',
        taskId: task.id,
        offerId: task.offerId,
        error: task.error || 'Не удалось подготовить модель',
      });
    }

    // ready: создаём токен (тот же TTL, что в prepare)
    const { token, expiresAt } = await OfferModel.createToken(
      task.offerId,
      req.user.id,
      ModelService.TOKEN_TTL_MS
    );

    // Уточняем fileSize и version по факту (после rename в кэше)
    let fileSize = task.fileSize || null;
    let version = null;
    try {
      const cached = StorageService.getRawCachedInfo(task.offerId);
      if (cached) fileSize = cached.size;
      const record = await OfferModel.get(task.offerId);
      if (record) version = record.s3_etag;
    } catch { /* некритично */ }

    return res.json({
      status: 'ready',
      taskId: task.id,
      offerId: task.offerId,
      fileName: task.fileName,
      fileSize,
      token,
      expiresAt,
      version,
    });
  } catch (err) {
    console.error('[modelsController.getTask] Ошибка:', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal error' });
  }
};

/**
 * Фаза 2: скачивание по одноразовому токену. Из локального кэша.
 * Если файл не подготовлен — 409 с кодом MODEL_NOT_PREPARED.
 * Токен reusable до expires_at (для Range-докачки).
 */
exports.downloadByToken = async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || token.length < 32) {
      return res.status(400).json({ error: 'Некорректный токен' });
    }

    const { offerId, userId } = await ModelService.consumeToken(token);

    // Если клиент передал Bearer — проверяем, что токен выдан ему же.
    if (req.user && req.user.id !== userId) {
      return res.status(403).json({ error: 'Токен выдан другому пользователю' });
    }

    const info = await ModelService.getCachedDownloadInfo(offerId);
    if (!info) {
      return res.status(409).json({
        error: 'Модель не подготовлена. Вызовите POST /api/models/prepare/:offerId',
        code: 'MODEL_NOT_PREPARED',
      });
    }

    disableCache(res);
    streamLocalFile(req, res, info.path, info.fileName, info.version);
  } catch (err) {
    console.error('[modelsController.downloadByToken] Ошибка:', err);
    const status = err.status || 400;
    if (!res.headersSent) res.status(status).json({ error: err.message });
  }
};