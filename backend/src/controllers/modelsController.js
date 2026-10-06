const fs = require('fs');
const ModelService = require('../services/ModelService');
const { disableCache } = require('../utils');

/**
 * Контроллер 3D-моделей (zip-архивы в S3).
 *
 * Скачивание всегда по одноразовому токену (прямых ссылок на S3 нет):
 *   1) POST /api/models/request/:offerId   -> { token, expiresAt, fileName }
 *   2) GET  /api/models/download/:token    -> zip-файл (stream из кэша/S3)
 */

/**
 * Запрос одноразового токена на скачивание модели.
 * Доступ: сотрудник, которому модель выдана (issued_models), либо
 * персонал; также достаточно наличия артикула в активном заказе.
 */
exports.requestDownload = async (req, res) => {
  try {
    const { offerId } = req.params;
    const grant = await ModelService.requestToken(offerId, req.user);
    res.json({
      token: grant.token,
      expiresAt: grant.expiresAt,
      // offerId — архив модели, который реально отдаём (может быть родительским
      // артикулом товара: ARD000003-NR -> ARD000003-N)
      offerId: grant.offerId,
      requestedOfferId: grant.requestedOfferId,
      sourceOfferId: grant.sourceOfferId,
      viaParent: String(grant.requestedOfferId) !== String(grant.sourceOfferId),
      fileName: grant.fileName,
      fileSize: grant.fileSize,
      // Версия модели (ETag в S3); при скачивании сверяется с хранилищем.
      version: grant.version || null,
    });
  } catch (err) {
    console.error('[modelsController.requestDownload] Ошибка:', err);
    const status = err.status || (err.message && err.message.includes('не найдена') ? 404 : 400);
    res.status(status).json({ error: err.message || 'Не удалось выдать токен' });
  }
};

/**
 * Скачивание zip по одноразовому токену. Аутентификация по токену:
 * 32 случайных байта, TTL 15 минут, помечается использованным при первом
 * обращении. Authorization-заголовок опционален (если передан — проверяем,
 * что токен выдан именно этому пользователю).
 */
exports.downloadByToken = async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || token.length < 32) {
      return res.status(400).json({ error: 'Некорректный токен' });
    }

    const { offerId, userId } = await ModelService.consumeToken(token);

    // Дополнительная сверка: если клиент передал Bearer-токен, убеждаемся,
    // что download-токен выдан тому же пользователю (защита от передачи ссылки).
    if (req.user && req.user.id !== userId) {
      return res.status(403).json({ error: 'Токен выдан другому пользователю' });
    }

    const info = await ModelService.getDownloadInfo(offerId);
    if (!fs.existsSync(info.path)) {
      return res.status(404).json({ error: 'Файл модели не найден в хранилище' });
    }

    disableCache(res);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${info.fileName}"`
    );
    if (info.size) res.setHeader('Content-Length', String(info.size));
    // Версия отданного файла (ETag в S3) — для диагностики/логов на клиенте
    if (info.version) res.setHeader('X-Model-Version', String(info.version));

    // Отдаём из локального кэша (он уже прогрет из S3 при необходимости)
    const stream = fs.createReadStream(info.path);
    stream.on('error', (streamErr) => {
      console.error('[modelsController.downloadByToken] Ошибка потока:', streamErr);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.pipe(res);
  } catch (err) {
    console.error('[modelsController.downloadByToken] Ошибка:', err);
    const status = err.status || 400;
    if (!res.headersSent) res.status(status).json({ error: err.message });
  }
};
