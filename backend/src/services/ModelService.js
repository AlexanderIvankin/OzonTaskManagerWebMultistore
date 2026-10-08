const OfferModel = require('../models/OfferModel');
const StorageService = require('./StorageService');
const NotificationService = require('./NotificationService');
const OzonService = require('./OzonService');
const { getStoreDB, getUsersDB } = require('../config/database');
const { STAFF_ROLES } = require('../config/staffRoles');

// ============================================================================
// ModelService — работа с 3D-моделями.
//
// MULTISTORE:
//   • Модели и их выдача ГЛОБАЛЬНЫ (models.db). Один артикул — один zip.
//   • Все оповещения адресуются в КОНТЕКСТЕ магазина (storeId).
//   • Если контекст магазина неизвестен (глобальный sync из планировщика) —
//     шлём во все магазины получателя (user_stores, is_fired=0).
// ============================================================================

const ALLOWED_EXTENSIONS = ['.stl', '.3mf', '.step', '.obj', '.txt', '.zip'];
const FORBIDDEN_EXTENSIONS = [
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.sh', '.jar', '.dll',
];

const MAX_UPLOAD_MB = parseInt(process.env.MODELS_MAX_UPLOAD_MB, 10) || 1024;
const TOKEN_TTL_MIN = parseInt(process.env.MODELS_TOKEN_TTL_MIN, 10) || 15;
const TOKEN_TTL_MS = TOKEN_TTL_MIN * 60 * 1000;

const S3_MISS_TTL_MS = 60 * 1000;
const s3MissCache = new Map();

const OFFER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function normalizeOfferId(rawOfferId) {
  if (typeof rawOfferId !== 'string') return null;
  let offerId = rawOfferId.trim();
  if (offerId.toLowerCase().endsWith('.zip')) {
    offerId = offerId.slice(0, -4);
  }
  if (!offerId || !OFFER_ID_RE.test(offerId)) return null;
  return offerId;
}

function getParentOfferId(offerId) {
  if (typeof offerId === 'string' && (offerId.endsWith('-NR') || offerId.endsWith('-NL'))) {
    return offerId.slice(0, -1);
  }
  return null;
}

function offerCandidates(offerId) {
  const list = [offerId];
  const parent = getParentOfferId(offerId);
  if (parent && !list.includes(parent)) list.push(parent);
  return list;
}

function parseZipEntries(buffer) {
  const EOCD_SIG = 0x06054b50;
  const CDH_SIG = 0x02014b50;

  const scanStart = Math.max(0, buffer.length - (65535 + 22));
  let eocd = -1;
  for (let i = buffer.length - 22; i >= scanStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('Повреждённый zip-архив: не найдена оглавляющая запись (EOCD)');
  }

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  let cdOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries === 0) return [];
  if (cdOffset === 0xffffffff || totalEntries === 0xffff) {
    throw new Error('ZIP64-архивы не поддерживаются');
  }

  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== CDH_SIG) {
      throw new Error('Повреждённый zip-архив: ошибка в оглавлении');
    }
    const flags = buffer.readUInt16LE(pos + 8);
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const name = buffer.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    entries.push({ name, flags, uncompressedSize });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function validateZipBuffer(buffer) {
  if (!buffer || !buffer.length) {
    throw new Error('Файл пустой');
  }
  const magic = buffer.slice(0, 4).toString('latin1');
  if (!magic.startsWith('PK')) {
    throw new Error('Файл не является zip-архивом');
  }

  const entries = parseZipEntries(buffer);
  if (!entries.length) {
    throw new Error('zip-архив пустой');
  }

  const maxUncompressedBytes = MAX_UPLOAD_MB * 2 * 1024 * 1024;
  const names = [];
  const modelFiles = [];
  let totalUncompressed = 0;

  for (const entry of entries) {
    const name = entry.name;
    if (name.includes('..') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
      throw new Error(`Недопустимый путь в архиве: ${name}`);
    }
    if (entry.flags & 0x1) {
      throw new Error(`Запись зашифрована — заливка запрещена: ${name}`);
    }
    if (name.endsWith('/')) continue;
    const lower = name.toLowerCase();
    if (FORBIDDEN_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      throw new Error(`Запрещённый тип файла в архиве: ${name}`);
    }
    if (ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      modelFiles.push(name);
    }
    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > maxUncompressedBytes) {
      throw new Error(
        `Распакованное содержимое превышает лимит ${MAX_UPLOAD_MB * 2} МБ`
      );
    }
    names.push(name);
  }

  return {
    entries: names,
    modelFiles,
    hasModelFiles: modelFiles.length > 0,
    totalUncompressed,
  };
}

function validateUploadFile(fileName, buffer) {
  if (fileName) {
    const baseName = String(fileName).trim().split(/[\\/]/).pop();
    if (baseName && !baseName.toLowerCase().endsWith('.zip')) {
      const err = new Error(
        `Допускается только zip-архив: получен «${baseName}». ` +
        `Модель на артикул — один архив, назовите файл «{offer_id}.zip» (например, ARD000001-N.zip)`
      );
      err.validation = true;
      throw err;
    }
  }
  try {
    return validateZipBuffer(buffer);
  } catch (err) {
    err.validation = true;
    throw err;
  }
}

class ModelService {
  // =====================================================================
  // ПОИСК МОДЕЛЕЙ
  // =====================================================================

  static async resolveModel(offerId) {
    const resolved = await this.resolveForOffers([offerId]);
    return resolved.get(String(offerId)) || null;
  }

  static async resolveForOffers(offerIds) {
    const result = new Map();
    const unique = Array.from(new Set((offerIds || []).filter(Boolean).map(String)));
    if (!unique.length) return result;

    const allCandidates = new Set();
    const candidateLists = new Map();
    for (const offerId of unique) {
      const candidates = offerCandidates(offerId);
      candidateLists.set(offerId, candidates);
      candidates.forEach((c) => allCandidates.add(c));
    }
    const rows = await OfferModel.getBatch(Array.from(allCandidates));

    const unresolved = [];
    for (const [offerId, candidates] of candidateLists) {
      let found = null;
      for (const candidate of candidates) {
        const model = rows.get(candidate);
        if (model) {
          found = { model, matchedOfferId: candidate };
          break;
        }
      }
      if (found) result.set(offerId, found);
      else unresolved.push(offerId);
    }
    if (!unresolved.length) return result;

    const toCheck = new Set();
    for (const offerId of unresolved) {
      for (const candidate of candidateLists.get(offerId)) {
        if (rows.has(candidate)) continue;
        const missUntil = s3MissCache.get(candidate);
        if (missUntil && missUntil > Date.now()) continue;
        toCheck.add(candidate);
      }
    }
    const foundInS3 = new Map();
    await Promise.all(Array.from(toCheck).map(async (candidate) => {
      try {
        const stat = await StorageService.statZip(candidate);
        if (stat) foundInS3.set(candidate, stat);
        else s3MissCache.set(candidate, Date.now() + S3_MISS_TTL_MS);
      } catch (err) {
        console.error(`[MODELS] Fallback-проверка S3 не удалась (${candidate}):`, err.message);
      }
    }));

    const registeredNow = new Set();
    for (const offerId of unresolved) {
      for (const candidate of candidateLists.get(offerId)) {
        const dbModel = rows.get(candidate);
        if (dbModel) {
          result.set(offerId, { model: dbModel, matchedOfferId: candidate });
          break;
        }
        const stat = foundInS3.get(candidate);
        if (!stat) continue;
        const model = {
          offer_id: candidate,
          s3_key: StorageService.keyFor(candidate),
          file_name: StorageService.fileNameFor(candidate),
          s3_etag: stat.etag || null,
          file_size: stat.size,
          uploaded_at: stat.lastModified,
          uploaded_by: null,
          from_storage: true,
        };
        if (!registeredNow.has(candidate)) {
          registeredNow.add(candidate);
          try {
            await OfferModel.syncEntry(candidate, {
              s3Key: model.s3_key,
              fileName: model.file_name,
              fileSize: model.file_size,
              uploadedAt: model.uploaded_at,
              etag: model.s3_etag,
            });
            s3MissCache.delete(candidate);
          } catch (err) {
            console.error(`[MODELS] Не удалось зарегистрировать ${candidate} в offer_models:`, err.message);
          }
        }
        result.set(offerId, { model, matchedOfferId: candidate });
        break;
      }
    }
    return result;
  }

  /**
   * Синхронизация S3 -> offer_models. ГЛОБАЛЬНАЯ (не store-scoped).
   * Оповещения об изменениях шлются без storeId — notificationModelUpdated
   * сам разложит их по магазинам получателей.
   */
  static async syncFromStorage() {
    const objects = await StorageService.listZipKeys();
    let registered = 0;
    let updated = 0;
    let invalid = 0;

    for (const obj of objects) {
      if (!obj.offerId || !OFFER_ID_RE.test(obj.offerId)) {
        invalid++;
        continue;
      }
      try {
        const res = await OfferModel.syncEntry(obj.offerId, {
          s3Key: obj.key,
          fileName: StorageService.fileNameFor(obj.offerId),
          fileSize: obj.size,
          uploadedAt: obj.lastModified,
          etag: obj.etag,
        });
        if (res.created) {
          registered++;
          s3MissCache.delete(obj.offerId);
          console.log(`[MODELS] Синхронизация S3: зарегистрирована модель ${obj.offerId} (${obj.key})`);
        } else if (res.changed) {
          updated++;
          s3MissCache.delete(obj.offerId);
          StorageService.invalidateCache(obj.offerId);
          await this.notifyModelUpdated(obj.offerId, res.record, 'storage', { storeId: null });
          console.log(`[MODELS] Синхронизация S3: обновлена модель ${obj.offerId} (новая версия ${String(res.record.s3_etag).slice(0, 12)}…)`);
        }
      } catch (err) {
        console.error(`[MODELS] Синхронизация S3: ошибка записи ${obj.offerId}:`, err.message);
      }
    }

    if (registered || updated) {
      console.log(
        `[MODELS] Синхронизация S3: +${registered} новых, ~${updated} обновлённых, всего zip в бакете: ${objects.length}`
      );
    }
    return { found: objects.length, registered, updated, invalid };
  }

  /**
   * Точечная сверка одной модели перед скачиванием.
   * @param {string} offerId
   * @param {{ storeId?: string|null }} [opts] — контекст магазина (для оповещений)
   */
  static async reconcileFromStorage(offerId, { storeId = null } = {}) {
    try {
      const stat = await StorageService.statZip(offerId);
      if (!stat) return { checked: false, changed: false };
      const res = await OfferModel.syncEntry(offerId, {
        s3Key: StorageService.keyFor(offerId),
        fileName: StorageService.fileNameFor(offerId),
        fileSize: stat.size,
        uploadedAt: stat.lastModified,
        etag: stat.etag,
      });
      if (res.changed) {
        StorageService.invalidateCache(offerId);
        await this.notifyModelUpdated(offerId, res.record, 'storage', { storeId });
        console.log(
          `[MODELS] Сверка с S3: модель ${offerId} изменилась (${String(res.record.s3_etag).slice(0, 12)}…) — кэш сброшен`
        );
      }
      return { checked: true, changed: !!res.changed };
    } catch (err) {
      console.error(`[MODELS] Сверка с S3 не удалась (${offerId}):`, err.message);
      return { checked: false, changed: false };
    }
  }

  /**
   * Оповестить сотрудников с выданной моделью, что архив обновился.
   *
   * @param {string} offerId
   * @param {object} record — запись offer_models
   * @param {'storage'|'upload'} source
   * @param {{ storeId?: string|null }} [opts]
   *   storeId задан — шлём только в этот магазин;
   *   storeId = null — для каждого получателя берём его магазины из
   *   user_stores (is_fired=0) и шлём в КАЖДЫЙ.
   */
  static async notifyModelUpdated(offerId, record, source = 'storage', { storeId = null } = {}) {
    try {
      const users = await OfferModel.getUsersWithIssuedAny(offerId);
      if (!users.length) return;

      const fileName = (record && record.file_name) || StorageService.fileNameFor(offerId);
      const fileSize = (record && record.file_size) || null;

      // Карта user_id -> [store_id]. Запрашиваем одним запросом.
      let userStoresMap = new Map();
      if (!storeId) {
        const usersDb = getUsersDB();
        const ids = users.map((u) => u.user_id);
        if (ids.length) {
          const placeholders = ids.map(() => '?').join(',');
          const rows = await usersDb.all(
            `SELECT user_id, store_id FROM user_stores
             WHERE user_id IN (${placeholders}) AND is_fired = 0`,
            ...ids
          );
          for (const r of rows) {
            if (!userStoresMap.has(r.user_id)) userStoresMap.set(r.user_id, []);
            userStoresMap.get(r.user_id).push(r.store_id);
          }
        }
      }

      let notified = 0;
      for (const u of users) {
        const targets = storeId
          ? [String(storeId)]
          : (userStoresMap.get(u.user_id) || []);
        if (!targets.length) continue;
        for (const sid of targets) {
          await NotificationService.notifyUser(u.user_id, 'model_updated', {
            offerId,
            fileName,
            fileSize,
            source,
          }, { storeId: sid });
          notified++;
        }
      }
      console.log(
        `[MODELS] Модель ${offerId} обновлена (${source}) — отправлено оповещений: ${notified}`
      );
    } catch (err) {
      console.error('[MODELS] Ошибка оповещения об обновлении модели:', err.message);
    }
  }

  // =====================================================================
  // ЗАГРУЗКА / УДАЛЕНИЕ / СПИСОК
  // =====================================================================

  /**
   * @param {object} opts
   *   storeId     — магазин загрузчика (для журнала персонала);
   *   uploaderName — имя загрузившего (для текста оповещения).
   */
  static async uploadModel(rawOfferId, buffer, userId, uploadedFileName = null, { storeId = null, uploaderName = null } = {}) {
    const offerId = normalizeOfferId(rawOfferId);
    if (!offerId) {
      const err = new Error(
        `Некорректный артикул "${rawOfferId}" — допустимы буквы, цифры, точка, дефис, подчёркивание`
      );
      err.validation = true;
      throw err;
    }

    const validation = validateUploadFile(uploadedFileName, buffer);

    await StorageService.uploadZip(offerId, buffer);
    const s3Key = StorageService.keyFor(offerId);
    const fileName = StorageService.fileNameFor(offerId);

    let etag = null;
    try {
      const stat = await StorageService.statZip(offerId);
      if (stat) etag = stat.etag;
    } catch (err) {
      console.error(`[MODELS] Не удалось получить ETag ${offerId}:`, err.message);
    }

    const record = await OfferModel.set(offerId, {
      s3Key, fileName,
      fileSize: buffer.length,
      uploadedBy: userId,
      etag,
    });

    NotificationService.notifyStaff('model_uploaded', {
      offerId,
      fileName,
      fileSize: buffer.length,
      filesCount: validation.entries.length,
      modelFiles: validation.modelFiles,
      hasModelFiles: validation.hasModelFiles,
      adminName: uploaderName,
      adminId: userId,
    }, { storeId });

    // Оповещение сотрудникам с выданной моделью — в контексте магазина загрузчика.
    await this.notifyModelUpdated(offerId, record, 'upload', { storeId });

    console.log(
      `[MODELS] Модель ${offerId} загружена (${fileName}, ${buffer.length} байт, файлов: ${validation.entries.length}, модельных: ${validation.modelFiles.length}, etag: ${etag ? etag.slice(0, 12) + '…' : '—'})`
    );
    return {
      ...record,
      entries: validation.entries,
      modelFiles: validation.modelFiles,
      hasModelFiles: validation.hasModelFiles,
      totalUncompressed: validation.totalUncompressed,
    };
  }

  /**
   * Удалить модель (S3 + models.db). Журнал — в контексте магазина админа.
   */
  static async deleteModel(offerId, adminId = null, { storeId = null, adminName = null } = {}) {
    await StorageService.deleteZip(offerId);
    await OfferModel.delete(offerId);
    NotificationService.notifyStaff('model_deleted', {
      offerId,
      adminName,
      adminId,
    }, { storeId });
    console.log(`[MODELS] Модель ${offerId} удалена (S3 + БД, store ${storeId || '—'})`);
  }

  static async listModels() {
    const models = await OfferModel.getAll();
    return models.map((m) => {
      const cache = StorageService.cacheInfo(m.offer_id);
      const issuedCount = m.issued_count || 0;
      return {
        ...m,
        issued_count: issuedCount,
        in_cache: cache.cached,
        cache_fresh: cache.fresh,
        cached_at: cache.mtime,
        in_work: issuedCount > 0 || cache.cached,
      };
    });
  }

  // =====================================================================
  // ВЫДАЧА ПРИ НАЗНАЧЕНИИ ЗАКАЗА
  // =====================================================================

  /**
   * Оповещение ПЕРСОНАЛА о выдаче по родительскому артикулу.
   * ctx.storeId обязателен для корректной доставки в журнал магазина.
   */
  static async notifyParentUsage(ctx, parentOffers) {
    if (!Array.isArray(parentOffers) || !parentOffers.length) return;
    try {
      const storeId = ctx && ctx.storeId ? String(ctx.storeId) : null;
      await NotificationService.notifyStaff('models_parent_used', {
        context: (ctx && ctx.context) || null,
        orderId: (ctx && ctx.orderId) || null,
        userId: (ctx && ctx.userId) || null,
        userName: (ctx && ctx.userName) || null,
        parentOffers,
      }, { storeId });
      console.log(
        `[MODELS][store ${storeId || '—'}] Модель выдана по родительскому артикулу (${(ctx && ctx.context) || 'unknown'}): ` +
        parentOffers.map((x) => `${x.offerId} <- ${x.parentOfferId}`).join(', ')
      );
    } catch (err) {
      console.error('[MODELS] Ошибка оповещения о родительском артикуле:', err.message);
    }
  }

  /**
   * Выдать модели сотруднику по составу заказа.
   * @param {object} opts
   *   storeId — магазин заказа (обязателен для оповещений).
   */
  static async issueForAssignment(orderId, userId, employee, orderDetails, { storeId = null } = {}) {
    const products = (orderDetails && orderDetails.products) || [];
    const available = [];
    const missing = [];
    const parentMatched = [];

    const offerIds = products.map((p) => p.offer_id).filter(Boolean);
    const resolvedMap = await this.resolveForOffers(offerIds);

    for (const product of products) {
      const offerId = product.offer_id;
      if (!offerId) continue;
      const resolved = resolvedMap.get(offerId);
      if (!resolved) {
        missing.push({ offerId, productName: product.name || null });
        continue;
      }
      const fileName =
        resolved.model.file_name || StorageService.fileNameFor(resolved.matchedOfferId);

      if (String(resolved.matchedOfferId) !== String(offerId)) {
        parentMatched.push({
          offerId: String(offerId),
          productName: product.name || null,
          parentOfferId: String(resolved.matchedOfferId),
          fileName,
        });
      }

      await OfferModel.addIssued(userId, offerId);
      available.push({
        offerId,
        sourceOfferId: resolved.matchedOfferId,
        fileName,
        fileSize: resolved.model.file_size || null,
      });
    }

    const parentOffersPayload = parentMatched.map((p) => ({
      offerId: p.offerId,
      parentOfferId: p.parentOfferId,
      fileName: p.fileName,
    }));

    if (available.length) {
      const payload = {
        orderId,
        userName: employee?.name || null,
        offerIds: available.map((a) => a.offerId),
        sourceOfferIds: available.map((a) => a.sourceOfferId),
        parentOffers: parentOffersPayload,
        missingOffers: missing.map((m) => m.offerId),
      };
      await NotificationService.notifyUser(userId, 'models_available', payload, { storeId });
      await NotificationService.notifyStaff('models_available', payload, { storeId });
    }

    await this.notifyParentUsage(
      { context: 'assign', orderId, userId, userName: employee?.name || null, storeId },
      parentMatched
    );

    if (missing.length) {
      await NotificationService.notifyStaff('models_missing', {
        orderId,
        userName: employee?.name || null,
        offerIds: missing.map((m) => m.offerId),
      }, { storeId });
      if (!available.length) {
        await NotificationService.notifyUser(userId, 'models_missing', {
          orderId,
          userName: employee?.name || null,
          offerIds: missing.map((m) => m.offerId),
        }, { storeId });
      }
    }

    console.log(
      `[MODELS][store ${storeId || '—'}] Выдача по заказу ${orderId}: доступно ${available.length}, отсутствует ${missing.length}, по родителю ${parentMatched.length}`
    );
    return { available, missing, parentMatched };
  }

  // =====================================================================
  // ПРОВЕРКА ДОСТУПА И ТОКЕНЫ
  // =====================================================================

  /**
   * Проверка доступа к модели.
   * @param {object} opts
   *   storeId — для fallback-проверки активных заказов магазина.
   */
  static async checkAccess(offerId, user, { storeId = null } = {}) {
    if (!user) return { allowed: false, matchedOfferId: null, source: null };
    if (STAFF_ROLES.includes(user.role)) {
      return { allowed: true, matchedOfferId: offerId, source: 'staff' };
    }

    const candidates = offerCandidates(offerId);
    const issuedMatch = await OfferModel.matchIssued(user.id, candidates);
    if (issuedMatch) {
      return { allowed: true, matchedOfferId: issuedMatch, source: 'issued' };
    }

    // Fallback: артикул в составе активного заказа сотрудника В ЭТОМ МАГАЗИНЕ
    if (storeId) {
      try {
        const db = getStoreDB(storeId);
        const activeOrders = await db.all(
          `SELECT order_id FROM assignments WHERE user_id = ? AND status = 'assigned'`,
          user.id
        );
        for (const order of activeOrders) {
          const details = await OzonService.getOrderDetails(storeId, order.order_id);
          const products = (details && details.products) || [];
          for (const candidate of candidates) {
            if (products.some((p) => String(p.offer_id) === candidate)) {
              return { allowed: true, matchedOfferId: candidate, source: 'active_order' };
            }
          }
        }
      } catch (err) {
        console.error(`[MODELS][store ${storeId}] Ошибка fallback-проверки доступа:`, err.message);
      }
    }
    return { allowed: false, matchedOfferId: null, source: null };
  }

  /**
   * Выдать одноразовый токен скачивания.
   * @param {object} opts.storeId — контекст магазина (для оповещений и checkAccess).
   */
  static async requestToken(rawOfferId, user, { storeId = null } = {}) {
    const offerId = normalizeOfferId(rawOfferId);
    if (!offerId) {
      throw new Error('Некорректный артикул');
    }

    const resolved = await this.resolveModel(offerId);
    if (!resolved) {
      throw new Error(`Модель для артикула ${offerId} не найдена`);
    }

    const access = await this.checkAccess(offerId, user, { storeId });
    if (!access.allowed) {
      const err = new Error('Модель не выдана вам — запросите у модератора');
      err.status = 403;
      throw err;
    }

    const fileName =
      resolved.model.file_name || StorageService.fileNameFor(resolved.matchedOfferId);

    const isStaff = STAFF_ROLES.includes(user.role);
    if (!isStaff && String(resolved.matchedOfferId) !== String(offerId)) {
      await this.notifyParentUsage(
        {
          context: 'download',
          orderId: null,
          userId: user.id,
          userName: user.name || null,
          storeId,
        },
        [{
          offerId: String(offerId),
          productName: null,
          parentOfferId: String(resolved.matchedOfferId),
          fileName,
        }]
      );
    }

    const { token, expiresAt } = await OfferModel.createToken(
      resolved.matchedOfferId,
      user.id,
      TOKEN_TTL_MS
    );

    return {
      token,
      expiresAt,
      offerId: resolved.matchedOfferId,
      sourceOfferId: resolved.matchedOfferId,
      requestedOfferId: String(offerId),
      fileName,
      fileSize: resolved.model.file_size || null,
      version: resolved.model.s3_etag || null,
    };
  }

  static async consumeToken(token) {
    const row = await OfferModel.getLiveToken(token);
    if (!row) {
      const err = new Error('Токен недействителен, истёк или уже использован');
      err.status = 403;
      throw err;
    }
    await OfferModel.markTokenUsed(token);
    return { offerId: row.offer_id, userId: row.user_id };
  }

  /**
   * Данные для отдачи файла модели.
   * @param {object} opts.storeId — контекст магазина (передаётся в reconcile).
   */
  static async getDownloadInfo(offerId, { storeId = null } = {}) {
    await this.reconcileFromStorage(offerId, { storeId });
    const info = await StorageService.getZipInfo(offerId);
    const record = await OfferModel.get(offerId);
    return {
      ...info,
      fileName: StorageService.fileNameFor(offerId),
      version: (record && record.s3_etag) || null,
    };
  }

  // =====================================================================
  // ОБОГАЩЕНИЕ СПИСКОВ ЗАКАЗОВ
  // =====================================================================

  static async attachToProducts(products) {
    if (!Array.isArray(products) || !products.length) return products || [];
    const offerIds = products.map((p) => p.offer_id).filter(Boolean);
    const resolvedMap = await this.resolveForOffers(offerIds);
    for (const p of products) {
      if (!p.offer_id) continue;
      const resolved = resolvedMap.get(p.offer_id);
      if (!resolved) {
        p.model = null;
        continue;
      }
      const sourceOfferId = String(resolved.matchedOfferId);
      p.model = {
        offerId: sourceOfferId,
        sourceOfferId,
        requestedOfferId: String(p.offer_id),
        isParent: sourceOfferId !== String(p.offer_id),
        fileName: resolved.model.file_name || StorageService.fileNameFor(sourceOfferId),
        fileSize: resolved.model.file_size || null,
      };
    }
    return products;
  }
}

ModelService.normalizeOfferId = normalizeOfferId;
ModelService.getParentOfferId = getParentOfferId;
ModelService.offerCandidates = offerCandidates;
ModelService.validateZipBuffer = validateZipBuffer;
ModelService.validateUploadFile = validateUploadFile;
ModelService.parseZipEntries = parseZipEntries;
ModelService.ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS;
ModelService.FORBIDDEN_EXTENSIONS = FORBIDDEN_EXTENSIONS;
ModelService.MAX_UPLOAD_MB = MAX_UPLOAD_MB;
ModelService.TOKEN_TTL_MIN = TOKEN_TTL_MIN;
ModelService.TOKEN_TTL_MS = TOKEN_TTL_MS;

module.exports = ModelService;