// src/services/StoredReturnsService.js
const XLSX = require('xlsx');
const { getUsersDB } = require('../config/database');
const { User, StoredReturn } = require('../models');
const NotificationService = require('./NotificationService');
const LozonResolver = require('./LozonResolver');

// ============================================================================
//  Хранилище возвратов (глобально, users.db).
//
//  Публичный API:
//    • setEnabled / isEnabled                 — глобальный тумблер в users
//    • addManual                              — добавить одну запись (box, lozon_id, qty)
//    • importFromExcel                        — массовая загрузка
//    • listForUser / listForStaff             — чтение (для UI)
//    • removeEntry                            — soft-delete своей записи
//    • findMatchesForOrder                    — для checkNewOrders
//    • consumeForOrder                        — для finishOrder
//    • restoreForOrder                        — для отмены заказа (опционально)
// ============================================================================

const MAX_RESOLUTION_ATTEMPTS = 10;

class StoredReturnsService {
  // ── Тумблер ──────────────────────────────────────────────────────────────

  static async setEnabled(userId, enabled) {
    const db = getUsersDB();
    await db.run(
      'UPDATE users SET returns_storage_enabled = ?, updated_at = ? WHERE id = ?',
      enabled ? 1 : 0, Date.now(), userId
    );
    return enabled ? 1 : 0;
  }

  static async isEnabled(userId) {
    const db = getUsersDB();
    const row = await db.get(
      'SELECT returns_storage_enabled FROM users WHERE id = ?',
      userId
    );
    return !!(row && row.returns_storage_enabled);
  }

  // ── Ввод ─────────────────────────────────────────────────────────────────

  /**
   * Ручной ввод одной записи. Пытается резолвить lozon_id сразу.
   * @returns {Promise<{ id, created, quantity, resolution: 'resolved'|'pending' }>}
   */
  static async addManual(userId, { boxNumber, lozonId, quantity = 1 }, { storeId = null } = {}) {
    const box = String(boxNumber || '').trim();
    const loz = String(lozonId || '').trim();
    if (!box) throw new Error('Укажите номер/название коробки');
    if (!loz) throw new Error('Укажите lozon_id (штрихкод с возвратной этикетки)');
    if (box.length > 100) throw new Error('Название коробки: максимум 100 символов');
    if (loz.length > 200) throw new Error('lozon_id: максимум 200 символов');
    const qty = Math.max(1, parseInt(quantity, 10) || 1);

    // Проверка: тумблер включён.
    const enabled = await this.isEnabled(userId);
    if (!enabled) {
      throw new Error('Хранилище возвратов отключено. Включите его в профиле.');
    }

    // Пытаемся резолвить сразу (не блокирующе — если null, уйдёт в pending).
    let resolution = null;
    try {
      resolution = await LozonResolver.lookup(loz, { storeId });
    } catch (err) {
      console.warn(`[StoredReturnsService] resolve на лету (${loz}):`, err.message);
    }

    const db = getUsersDB();
    const result = await StoredReturn.upsert(db, userId, {
      boxNumber: box,
      lozonId: loz,
      quantity: qty,
      offerId: resolution?.offer_id || null,
      sku: resolution?.sku || null,
      productName: resolution?.product_name || null,
      sourceStoreId: storeId || null,
      resolutionStatus: resolution?.offer_id || resolution?.sku ? 'resolved' : 'pending',
    });

    return {
      id: result.id,
      created: result.created,
      quantity: result.quantity,
      resolution: resolution?.offer_id || resolution?.sku ? 'resolved' : 'pending',
    };
  }

  /**
   * Массовый импорт из Excel.
   *
   * Колонки (порядок не важен, читаем по заголовкам, регистронезависимо):
   *   • box_number  — обязательно
   *   • lozon_id    — обязательно
   *   • quantity    — обязательно (целое ≥ 1)
   *   • product_name / source_store_id / source_order_id — опционально
   *
   * Поведение:
   *   • каждая валидная строка — upsert (см. StoredReturn.upsert);
   *   • строки с ошибками — в errors[], без падения всего импорта;
   *   • резолв lozon_id — асинхронно: для каждой строки пробуем на лету,
   *     иначе она уходит в pending и подхватится scheduler'ом.
   */
  static async importFromExcel(userId, buffer, { storeId = null } = {}) {
    const enabled = await this.isEnabled(userId);
    if (!enabled) {
      throw new Error('Хранилище возвратов отключено. Включите его в профиле.');
    }

    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error('Файл пуст или не содержит листов');
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) throw new Error('В файле нет строк с данными');

    const resolveHeader = (raw) => String(raw || '').trim().toLowerCase();
    const headerMap = {};
    for (const key of Object.keys(rows[0])) {
      headerMap[resolveHeader(key)] = key;
    }

    const colBox = headerMap['box_number'] || headerMap['коробка'] || headerMap['box'] || null;
    const colLoz = headerMap['lozon_id'] || headerMap['lozon'] || headerMap['штрихкод'] || null;
    const colQty = headerMap['quantity'] || headerMap['количество'] || headerMap['qty'] || null;
    const colName = headerMap['product_name'] || headerMap['название'] || null;
    const colSrcStore = headerMap['source_store_id'] || null;
    const colSrcOrder = headerMap['source_order_id'] || null;

    if (!colBox || !colLoz || !colQty) {
      throw new Error(
        'В файле должны быть колонки: box_number, lozon_id, quantity (регистр не важен)'
      );
    }

    const errors = [];
    const valid = [];
    rows.forEach((rawRow, idx) => {
      const rowNum = idx + 2; // 1 — заголовок
      const box = String(rawRow[colBox] || '').trim();
      const loz = String(rawRow[colLoz] || '').trim();
      const qtyRaw = String(rawRow[colQty] || '').trim();
      if (!box) { errors.push({ row: rowNum, error: 'пустой box_number' }); return; }
      if (!loz) { errors.push({ row: rowNum, error: 'пустой lozon_id' }); return; }
      if (!qtyRaw) { errors.push({ row: rowNum, error: 'пустой quantity' }); return; }
      if (!/^\d+$/.test(qtyRaw)) { errors.push({ row: rowNum, error: 'quantity не целое', raw: qtyRaw }); return; }
      const qty = parseInt(qtyRaw, 10);
      if (qty < 1) { errors.push({ row: rowNum, error: 'quantity < 1', raw: qtyRaw }); return; }
      valid.push({
        box, loz, qty,
        productName: colName ? String(rawRow[colName] || '').trim() || null : null,
        sourceStoreId: colSrcStore ? String(rawRow[colSrcStore] || '').trim() || null : null,
        sourceOrderId: colSrcOrder ? String(rawRow[colSrcOrder] || '').trim() || null : null,
      });
    });

    const db = getUsersDB();
    let inserted = 0;
    let updated = 0;
    let resolvedNow = 0;
    let pendingNow = 0;

    for (const v of valid) {
      let resolution = null;
      try {
        resolution = await LozonResolver.lookup(v.loz, { storeId });
      } catch (err) {
        console.warn(`[StoredReturnsService] resolve (import, ${v.loz}):`, err.message);
      }
      const isResolved = !!(resolution?.offer_id || resolution?.sku);
      if (isResolved) resolvedNow++; else pendingNow++;

      try {
        const r = await StoredReturn.upsert(db, userId, {
          boxNumber: v.box,
          lozonId: v.loz,
          quantity: v.qty,
          offerId: resolution?.offer_id || null,
          sku: resolution?.sku || null,
          productName: resolution?.product_name || v.productName,
          sourceStoreId: v.sourceStoreId || storeId || null,
          sourceOrderId: v.sourceOrderId,
          resolutionStatus: isResolved ? 'resolved' : 'pending',
        });
        if (r.created) inserted++; else updated++;
      } catch (err) {
        errors.push({ row: v.loz, error: err.message });
      }
    }

    return {
      total: rows.length,
      valid: valid.length,
      inserted,
      updated,
      resolvedNow,
      pendingNow,
      errors,
    };
  }

  // ── Чтение ───────────────────────────────────────────────────────────────

  static async listForUser(userId, { status = 'stored', includeAll = false } = {}) {
    const db = getUsersDB();
    return StoredReturn.listForUser(db, userId, { status, includeAll });
  }

  static async listForStaff({ storeId, userId = null, status = 'stored', resolutionStatus = null }) {
    const db = getUsersDB();
    return StoredReturn.listForStaff(db, { storeId, userId, status, resolutionStatus });
  }

  static async removeEntry(userId, id) {
    const db = getUsersDB();
    return StoredReturn.softDelete(db, id, userId);
  }

  // ── Матчинг и списание ──────────────────────────────────────────────────

  /**
   * Найти «готовые» возвраты для набора товаров заказа. Только сотрудники
   * этого магазина. Возвращает сгруппированный результат для UI/payload.
   *
   * @param {string} storeId
   * @param {Array<{offer_id?:string, sku?:string}>} products
   */
  static async findMatchesForOrder(storeId, products) {
    if (!Array.isArray(products) || !products.length) return [];
    const offerIds = Array.from(new Set(
      products.map((p) => p.offer_id).filter(Boolean).map(String)
    ));
    const skus = Array.from(new Set(
      products.map((p) => p.sku).filter(Boolean).map(String)
    ));
    if (!offerIds.length && !skus.length) return [];

    const db = getUsersDB();
    return StoredReturn.findMatches(db, { offerIds, skus, storeId });
  }

  /**
 * Batch-версия findMatchesForOrder: один SELECT на все заказы сразу.
 * Раскладывает результат в Map<orderId, matches[]>, где matches —
 * те же объекты, что возвращает findMatches (с user_name, box_number, quantity).
 *
 * @param {string} storeId
 * @param {Array<{ orderId: string, products: Array<{offer_id?, sku?}> }>} orders
 * @returns {Promise<Map<string, Array>>}
 */
  static async findMatchesForOrders(storeId, orders) {
    if (!Array.isArray(orders) || !orders.length) return new Map();

    // 1. Собираем уникальные (offer_id | sku) со всех заказов
    const allProducts = [];
    const seen = new Set();
    for (const o of orders) {
      for (const p of (o.products || [])) {
        const oid = p.offer_id ? String(p.offer_id) : null;
        const sku = p.sku ? String(p.sku) : null;
        if (!oid && !sku) continue;
        const k = `${oid || ''}|${sku || ''}`;
        if (seen.has(k)) continue;
        seen.add(k);
        allProducts.push({ offer_id: oid, sku });
      }
    }
    if (!allProducts.length) return new Map();

    // 2. Один SELECT (как в старом findMatchesForOrder)
    const matches = await this.findMatchesForOrder(storeId, allProducts);
    if (!matches.length) return new Map();

    // 3. Индекс: по offer_id и по sku (у одного match может быть оба)
    const byOffer = new Map();
    const bySku = new Map();
    for (const m of matches) {
      if (m.offer_id) {
        if (!byOffer.has(m.offer_id)) byOffer.set(m.offer_id, []);
        byOffer.get(m.offer_id).push(m);
      }
      if (m.sku) {
        if (!bySku.has(m.sku)) bySku.set(m.sku, []);
        bySku.get(m.sku).push(m);
      }
    }

    // 4. Раскладка по заказам (дедупликация: один match только один раз)
    const result = new Map();
    for (const o of orders) {
      const orderMatches = [];
      const seenIds = new Set();
      for (const p of (o.products || [])) {
        const lists = [];
        if (p.offer_id && byOffer.has(String(p.offer_id))) {
          lists.push(byOffer.get(String(p.offer_id)));
        }
        if (p.sku && bySku.has(String(p.sku))) {
          lists.push(bySku.get(String(p.sku)));
        }
        for (const arr of lists) {
          for (const m of arr) {
            const id = `${m.user_id}|${m.box_number}|${m.offer_id || ''}|${m.sku || ''}`;
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            orderMatches.push(m);
          }
        }
      }
      if (orderMatches.length) result.set(o.orderId, orderMatches);
    }
    return result;
  }

  /**
   * Списать с хранилища сотрудника товары под заказ.
   * Оборачивается в отдельную транзакцию usersDb (store-транзакция уже
   * закоммичена выше). При ошибке — пробрасываем наверх: OrderService
   * логирует и notifyStaff.
   */
  static async consumeForOrder(userId, orderId, storeId, products) {
    if (!Array.isArray(products) || !products.length) return [];
    const db = getUsersDB();
    await db.run('BEGIN IMMEDIATE');
    try {
      const consumed = await StoredReturn.consumeForOrder(
        db, userId, orderId, storeId, products
      );
      await db.run('COMMIT');
      return consumed;
    } catch (err) {
      try { await db.run('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Симметрично consumeForOrder — для отмены заказа, если списание уже было.
   * Не критично для основного потока; вызывается из OrderService.cancelOrder
   * при статусе completed (или вручную из админки).
   */
  static async restoreForOrder(orderId, storeId) {
    const db = getUsersDB();
    await db.run('BEGIN IMMEDIATE');
    try {
      const n = await StoredReturn.restoreForOrder(db, orderId, storeId);
      await db.run('COMMIT');
      return n;
    } catch (err) {
      try { await db.run('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Синхронный резолв lozon_id → { offer_id, sku, product_name }.
   * Возвращает:
   *   • объект с offer_id ИЛИ sku — успех;
   *   • null — цепочка резолва не сложилась, пользователю отказ.
   *
   * Никаких «pending» в БД: если здесь null, вызывающий НЕ создаёт запись.
   */
  static async _resolveLozon(storeId, lozonId) {
    // 1. lozon_id → cargo_box_id (Ozon API)
    const box = await LozonResolver.resolveCargoBoxId(lozonId, { storeId });
    if (!box || !box.cargo_box_id) {
      return { ok: false, reason: 'box_not_found', cargoBoxId: null };
    }

    // 2. cargo_box_id → запись в returns-N.db
    const dbReturns = getReturnsDB(storeId);
    const rows = await dbReturns.all(
      'SELECT barcode, offer_id, sku, product_name FROM returns WHERE cargo_box_id = ?',
      box.cargo_box_id
    );

    // Fallback: если по cargo_box_id пусто, пробуем по box_barcode
    // (на случай, если lozon_id == barcode и cargo_box_id ещё не залит PDF).
    let candidates = rows;
    if (!candidates.length && box.box_barcode) {
      candidates = await dbReturns.all(
        'SELECT barcode, offer_id, sku, product_name FROM returns WHERE barcode = ?',
        box.box_barcode
      );
    }

    if (!candidates.length) {
      return { ok: false, reason: 'not_in_cache', cargoBoxId: box.cargo_box_id };
    }

    // Ищем хоть одну запись с offer_id или sku
    const withIds = candidates.find((r) => r.offer_id || r.sku);
    if (!withIds) {
      return { ok: false, reason: 'no_offer_id', cargoBoxId: box.cargo_box_id };
    }

    return {
      ok: true,
      cargo_box_id: box.cargo_box_id,
      barcode: withIds.barcode,
      offer_id: withIds.offer_id || null,
      sku: withIds.sku || null,
      product_name: withIds.product_name || null,
    };
  }

  /**
   * Ручной ввод одной записи. Синхронный резолв. Отказ при неудаче.
   * @returns {Promise<{ id, created, quantity, offer_id, sku, cargo_box_id, barcode }>}
   * @throws Error с понятным сообщением — пользователю.
   */
  static async addManual(userId, { boxNumber, lozonId, quantity = 1 }, { storeId = null } = {}) {
    const box = String(boxNumber || '').trim();
    const loz = String(lozonId || '').trim();
    if (!box) throw new Error('Укажите номер/название коробки');
    if (!loz) throw new Error('Укажите штрихкод возврата (lozon_id)');
    if (box.length > 100) throw new Error('Название коробки: максимум 100 символов');
    if (loz.length > 200) throw new Error('lozon_id: максимум 200 символов');
    const qty = Math.max(1, parseInt(quantity, 10) || 1);

    if (!storeId) {
      throw new Error(
        'Добавление на хранение доступно только из контекста магазина ' +
        '(нужно определить, где искать возврат).'
      );
    }

    const enabled = await this.isEnabled(userId);
    if (!enabled) {
      throw new Error('Хранилище возвратов отключено. Включите его в профиле.');
    }

    // Синхронный резолв
    const resolved = await this._resolveLozon(storeId, loz);
    if (!resolved.ok) {
      const msg = {
        box_not_found: `Штрихкод ${loz} не найден в возвратах Ozon. Проверьте, что возврат оформлен именно на этот магазин.`,
        not_in_cache: `Штрихкод ${loz} есть в Ozon, но ещё не синхронизирован в базу магазина. Попробуйте через 1–2 часа или обратитесь к администратору.`,
        no_offer_id: `Штрихкод ${loz} найден, но артикул ещё не сопоставлен. Администратор должен загрузить PDF-акт с этим возвратом.`,
      }[resolved.reason] || `Не удалось опознать возврат ${loz}.`;
      throw new Error(msg);
    }

    const db = getUsersDB();
    const result = await StoredReturn.upsert(db, userId, {
      boxNumber: box,
      lozonId: loz,
      quantity: qty,
      offerId: resolved.offer_id,
      sku: resolved.sku,
      productName: resolved.product_name,
      cargoBoxId: resolved.cargo_box_id,
      sourceStoreId: storeId,
      resolutionStatus: 'resolved',
    });

    return {
      id: result.id,
      created: result.created,
      quantity: result.quantity,
      offer_id: resolved.offer_id,
      sku: resolved.sku,
      cargo_box_id: resolved.cargo_box_id,
      barcode: resolved.barcode,
    };
  }

  /**
   * Массовый импорт. Для каждой строки — тот же синхронный резолв.
   * Строки, которые не резолвятся, — в errors[], в БД НЕ попадают.
   */
  static async importFromExcel(userId, buffer, { storeId = null } = {}) {
    const enabled = await this.isEnabled(userId);
    if (!enabled) throw new Error('Хранилище возвратов отключено. Включите его в профиле.');
    if (!storeId) throw new Error('Импорт доступен только из контекста магазина.');

    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error('Файл пуст или не содержит листов');
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) throw new Error('В файле нет строк с данными');

    const resolveHeader = (raw) => String(raw || '').trim().toLowerCase();
    const headerMap = {};
    for (const key of Object.keys(rows[0])) headerMap[resolveHeader(key)] = key;

    const colBox = headerMap['box_number'] || headerMap['коробка'] || headerMap['box'] || null;
    const colLoz = headerMap['lozon_id'] || headerMap['lozon'] || headerMap['штрихкод'] || null;
    const colQty = headerMap['quantity'] || headerMap['количество'] || headerMap['qty'] || null;
    if (!colBox || !colLoz || !colQty) {
      throw new Error('В файле должны быть колонки: box_number, lozon_id, quantity (регистр не важен)');
    }

    const errors = [];
    const valid = [];
    rows.forEach((rawRow, idx) => {
      const rowNum = idx + 2;
      const box = String(rawRow[colBox] || '').trim();
      const loz = String(rawRow[colLoz] || '').trim();
      const qtyRaw = String(rawRow[colQty] || '').trim();
      if (!box) { errors.push({ row: rowNum, lozon_id: loz || null, error: 'пустой box_number' }); return; }
      if (!loz) { errors.push({ row: rowNum, error: 'пустой lozon_id' }); return; }
      if (!/^\d+$/.test(qtyRaw)) { errors.push({ row: rowNum, lozon_id: loz, error: 'quantity не целое', raw: qtyRaw }); return; }
      const qty = parseInt(qtyRaw, 10);
      if (qty < 1) { errors.push({ row: rowNum, lozon_id: loz, error: 'quantity < 1' }); return; }
      valid.push({ row: rowNum, box, loz, qty });
    });

    const db = getUsersDB();
    let inserted = 0;
    let updated = 0;

    for (const v of valid) {
      let resolved;
      try {
        resolved = await this._resolveLozon(storeId, v.loz);
      } catch (err) {
        errors.push({ row: v.row, lozon_id: v.loz, error: `Ozon API: ${err.message}` });
        continue;
      }
      if (!resolved.ok) {
        const reasonMap = {
          box_not_found: 'штрихкод не найден в возвратах Ozon',
          not_in_cache: 'возврат ещё не синхронизирован в БД магазина',
          no_offer_id: 'артикул не сопоставлен (нужен PDF-акт)',
        };
        errors.push({
          row: v.row, lozon_id: v.loz, box: v.box,
          error: reasonMap[resolved.reason] || 'не удалось опознать',
        });
        continue;
      }
      try {
        const r = await StoredReturn.upsert(db, userId, {
          boxNumber: v.box,
          lozonId: v.loz,
          quantity: v.qty,
          offerId: resolved.offer_id,
          sku: resolved.sku,
          productName: resolved.product_name,
          cargoBoxId: resolved.cargo_box_id,
          sourceStoreId: storeId,
          resolutionStatus: 'resolved',
        });
        if (r.created) inserted++; else updated++;
      } catch (err) {
        errors.push({ row: v.row, lozon_id: v.loz, error: err.message });
      }
    }

    return {
      total: rows.length,
      valid: valid.length,
      inserted, updated,
      rejected: errors.length,
      errors,
    };
  }
}

module.exports = StoredReturnsService;