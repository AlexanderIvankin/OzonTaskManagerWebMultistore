// src/controllers/storedReturnsController.js
const fs = require('fs');
const { User, UserStore } = require('../models');
const { getUsersDB } = require('../config/database');
const StoredReturnsService = require('../services/StoredReturnsService');
const NotificationService = require('../services/NotificationService');

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
    const { boxNumber, lozonId, quantity } = req.body || {};
    const result = await StoredReturnsService.addManual(
      req.user.id,
      { boxNumber, lozonId, quantity },
      { storeId: req.storeId || null }
    );
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    if (err.message && (
      err.message.includes('Укажите') ||
      err.message.includes('отключено') ||
      err.message.includes('максимум')
    )) {
      return res.status(400).json({ error: err.message });
    }
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
    res.json({ ok: true, ...result });
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

// ── Админский view ─────────────────────────────────────────────────────────

exports.listForStaff = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
    const status = typeof req.query.status === 'string' && req.query.status
      ? String(req.query.status)
      : 'stored';
    const resolutionStatus = typeof req.query.resolutionStatus === 'string' && req.query.resolutionStatus
      ? String(req.query.resolutionStatus)
      : null;

    const items = await StoredReturnsService.listForStaff({
      storeId, userId, status, resolutionStatus,
    });
    res.json({ items });
  } catch (err) { next(err); }
};