// src/controllers/storedReturnsController.js
const fs = require('fs');
const XLSX = require('xlsx');
const { User, UserStore } = require('../models');
const { getUsersDB } = require('../config/database');
const StoredReturnsService = require('../services/StoredReturnsService');
const NotificationService = require('../services/NotificationService');
const CooldownService = require('../services/CooldownService');

// ============================================================================
//  Хранилище возвратов — контроллер.
//  Глобальные эндпоинты (settings, my list, add, import, resolve, remove)
//  доступны ЛЮБОМУ авторизованному (роуты смонтированы до requireEmployee).
//  Админский listForStaff — только персонал магазина (роут в /admin/*).
// ============================================================================

async function hasAnyStoreAccess(userId) {
  const db = getUsersDB();
  const row = await db.get(
    'SELECT 1 AS ok FROM user_stores WHERE user_id = ? AND is_fired = 0 LIMIT 1',
    userId
  );
  return !!row;
}

exports.getSettings = async (req, res, next) => {
  try {
    const enabled = await StoredReturnsService.isEnabled(req.user.id);
    res.json({ enabled });
  } catch (err) { next(err); }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const enabled = !!req.body?.enabled;

    if (enabled) {
      const u = await User.getById(userId);
      if (!u) return res.status(404).json({ error: 'User not found' });
      const isGod = u.role === 'god';
      if (!isGod) {
        const has = await hasAnyStoreAccess(userId);
        if (!has) {
          return res.status(400).json({
            error: 'Хранилище возвратов доступно только сотрудникам магазинов',
          });
        }
      }
    }

    const next_value = await StoredReturnsService.setEnabled(userId, enabled);
    // Кулдаун ставится только после успешного переключения (как в toggleOrders)
    CooldownService.touch('toggleReturns', req.storeId, userId);
    res.json({ enabled: !!next_value });
  } catch (err) { next(err); }
};

exports.listMy = async (req, res, next) => {
  try {
    const includeAll = req.query.includeAll === 'true' || req.query.includeAll === '1';
    const status = typeof req.query.status === 'string' && req.query.status
      ? String(req.query.status)
      : 'stored';
    const items = await StoredReturnsService.listForUser(req.user.id, { status, includeAll });
    res.json({ items });
  } catch (err) { next(err); }
};

exports.addManual = async (req, res, next) => {
  try {
    const { boxNumber, offerId, input, quantity } = req.body || {};
    const result = await StoredReturnsService.addManual(
      req.user.id,
      { boxNumber, offerId, input, quantity },
      { storeId: req.storeId || null }
    );
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    // Бизнес-ошибки → 400 с текстом, без next(err).
    // next(err) — только для настоящих 500 (неожиданные исключения).
    const BUSINESS_PATTERNS = [
      'Укажите', 'отключено', 'максимум',
      'Не удалось опознать', 'несколько товаров',
      'не сопоставлен', 'не синхронизирован', 'не найден',
    ];
    if (err.message && BUSINESS_PATTERNS.some((p) => err.message.includes(p))) {
      return res.status(400).json({ error: err.message });
    }
    // Ozon API вернул ошибку (сеть/5xx) — тоже 400 с деталями
    if (err.response?.data) {
      return res.status(400).json({
        error: `Ozon API: ${err.message}`,
        details: err.response.data,
      });
    }
    console.error('[addManual] Неожиданная ошибка:', err);
    next(err);
  }
};

exports.importExcel = async (req, res, next) => {
  const filePath = req.file?.path;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не передан (поле file)' });
    }
    const buffer = fs.readFileSync(filePath);
    const result = await StoredReturnsService.importFromExcel(
      req.user.id,
      buffer,
      { storeId: req.storeId || null }
    );

    // Если есть отклонённые — генерируем return_skipped.xlsx (base64),
    // чтобы пользователь мог скачать, исправить и повторить заливку.
    // Файл готов к повторной загрузке: те же колонки, что в исходном,
    // плюс колонка `error` (импортер её игнорирует — лишние колонки разрешены).
    let skippedFileBase64 = null;
    let skippedFileName = null;
    if (result.errors && result.errors.length > 0) {
      try {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(
          result.errors.map((e) => ({
            box_number: e.box_number || '',
            lozon_id: e.lozon_id || '',
            offer_id: e.offer_id || '',
            quantity: e.quantity ?? '',
            error: e.error,
          })),
          { header: ['box_number', 'lozon_id', 'offer_id', 'quantity', 'error'] }
        );
        XLSX.utils.book_append_sheet(wb, ws, 'Skipped');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        skippedFileBase64 = buf.toString('base64');
        skippedFileName = 'return_skipped.xlsx';
      } catch (xlsxErr) {
        console.warn('[importExcel] не удалось сгенерировать return_skipped.xlsx:', xlsxErr.message);
      }
    }

    res.json({
      ok: true,
      ...result,
      skippedFileBase64,
      skippedFileName,
    });
  } catch (err) {
    if (err.message && (
      err.message.includes('отключено') ||
      err.message.includes('колонки') ||
      err.message.includes('пуст')
    )) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  } finally {
    if (filePath) { try { fs.unlinkSync(filePath); } catch { /* ignore */ } }
  }
};

exports.removeEntry = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Некорректный id' });
    const removed = await StoredReturnsService.removeEntry(req.user.id, id);
    if (!removed) {
      return res.status(404).json({ error: 'Запись не найдена или уже удалена' });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
};

exports.clearAll = async (req, res, next) => {
  try {
    const cleared = await StoredReturnsService.clearAllForUser(req.user.id);
    console.log(
      `[storedReturns.clearAll] user=${req.user.id}: обнулено ${cleared} записей`
    );
    res.json({ ok: true, cleared });
  } catch (err) {
    console.error('[storedReturns.clearAll] Ошибка:', err);
    next(err);
  }
};

// ── Админский view ─────────────────────────────────────────────────────────

exports.listForStaff = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
    const status = typeof req.query.status === 'string' && req.query.status
      ? String(req.query.status) : 'stored';
    const resolutionStatus = typeof req.query.resolutionStatus === 'string' && req.query.resolutionStatus
      ? String(req.query.resolutionStatus) : null;
    const source = typeof req.query.source === 'string' && req.query.source
      ? String(req.query.source) : null;

    const items = await StoredReturnsService.listForStaff({
      storeId, userId, status, resolutionStatus, source,
    });
    res.json({ items });
  } catch (err) { next(err); }
};