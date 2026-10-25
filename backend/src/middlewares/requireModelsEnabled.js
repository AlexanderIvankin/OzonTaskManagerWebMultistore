// Defense-in-depth для магазинов с DISABLE_MODELS=true.
// Фронт уже скрывает страницу «Модели» и кнопки скачивания, но если
// кто-то дёрнет API напрямую (curl, Postman, старый фронт) — получит
// внятный 403 вместо попытки залить файл в S3 / выдать токен.

function requireModelsEnabled(req, res, next) {
  // req.store заполняется в storeResolver (на /api ДО authenticate).
  // На root-домене req.store = null — пропускаем (там моделей и так нет).
  if (!req.store) return next();

  if (req.store.features?.disableModels) {
    return res.status(403).json({
      error: 'Работа с 3D-моделями отключена в этом магазине (DISABLE_MODELS=true)',
      code: 'MODELS_DISABLED',
    });
  }

  next();
}

module.exports = { requireModelsEnabled };