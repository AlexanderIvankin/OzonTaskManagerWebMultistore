// src/services/StoredReturnsService.js
const XLSX = require('xlsx');
const { getUsersDB } = require('../config/database');
const { getReturnsDB } = require('../config/returnsDatabase');
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
 * Универсальный резолвер одного значения: пробует интерпретировать как
 * offer_id, затем как barcode (из returns-N.db), затем как lozon_id (Ozon API).
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   reason?: string,
 *   source?: 'offer_id'|'barcode'|'lozon_id',
 *   offer_id?: string|null,
 *   sku?: string|null,
 *   barcode?: string|null,
 *   cargo_box_id?: string|null,
 *   product_name?: string|null,
 * }>}
 */
  static async _resolveInput(storeId, input) {
    const raw = String(input || '').trim();
    if (!raw) return { ok: false, reason: 'empty' };

    const returnsDb = getReturnsDB(storeId);

    // 0. В поле «Штрихкод» пользователь ввёл offer_id? Отклоняем с явной
    //    подсказкой «используйте поле Артикул». Проверяем только по кэшу:
    //    если совпало с известным offer_id — это 100% ошибка ввода.
    if (/^[A-Za-z0-9_.\-]+$/.test(raw) && raw.length <= 200) {
      const byOffer = await returnsDb.get(
        'SELECT id FROM returns WHERE offer_id = ? LIMIT 1', raw
      );
      if (byOffer) {
        return { ok: false, reason: 'looks_like_offer_id', offer_id: raw };
      }
    }

    // 1. barcode в returns-N.db (единственный источник истины)
    const byBarcode = await returnsDb.all(
      'SELECT * FROM returns WHERE barcode = ?', raw
    );
    if (byBarcode.length > 1) {
      const offerIds = Array.from(new Set(
        byBarcode.map((r) => r.offer_id).filter(Boolean)
      ));
      return {
        ok: false,
        reason: 'multiple_products_in_return',
        barcode: raw,
        offer_ids: offerIds,
      };
    }
    if (byBarcode.length === 1) {
      const row = byBarcode[0];
      if (row.resolution_status === 'skip') {
        return { ok: false, reason: row.resolution_reason || 'skip', barcode: raw };
      }
      return {
        ok: true, source: 'barcode',
        offer_id: row.offer_id, sku: row.sku, barcode: row.barcode,
        cargo_box_id: row.cargo_box_id, product_name: row.product_name,
      };
    }

    // 2. lozon_id через Ozon API → cargo_box_id → returns-N.db
    try {
      const box = await LozonResolver.resolveCargoBoxId(raw, { storeId });
      if (box && box.cargo_box_id) {
        const byCargo = await returnsDb.all(
          'SELECT * FROM returns WHERE cargo_box_id = ?', box.cargo_box_id
        );
        if (byCargo.length === 0) {
          return { ok: false, reason: 'cargo_box_not_in_cache', cargo_box_id: box.cargo_box_id };
        }
        if (byCargo.length > 1) {
          const offerIds = Array.from(new Set(
            byCargo.map((r) => r.offer_id).filter(Boolean)
          ));
          return {
            ok: false,
            reason: 'multiple_products_in_return',
            cargo_box_id: box.cargo_box_id,
            offer_ids: offerIds,
          };
        }
        const row = byCargo[0];
        if (row.resolution_status === 'skip') {
          return { ok: false, reason: row.resolution_reason || 'skip' };
        }
        return {
          ok: true, source: 'lozon_id',
          offer_id: row.offer_id, sku: row.sku, barcode: row.barcode,
          cargo_box_id: box.cargo_box_id, product_name: row.product_name,
        };
      }
    } catch (err) {
      console.warn(`[StoredReturnsService] LozonResolver (${raw}):`, err.message);
    }

    return { ok: false, reason: 'not_found' };
  }

  /**
   * Ручной ввод одной записи по Артикулу (offer_id) или по Коду Возврата (barcode/lozon_id).
   * @returns {Promise<{ id, created, quantity, resolution: 'resolved'|'pending' }>}
   */
  static async addManual(userId, { boxNumber, offerId, input, quantity = 1 }, { storeId = null } = {}) {
    const box = String(boxNumber || '').trim();
    const directOffer = String(offerId || '').trim();
    const genericInput = String(input || '').trim();

    if (!box) throw new Error('Укажите номер/название коробки');
    if (!directOffer && !genericInput) {
      throw new Error('Укажите offer_id или штрихкод возврата');
    }
    if (box.length > 100) throw new Error('Название коробки: максимум 100 символов');
    const qty = Math.max(1, parseInt(quantity, 10) || 1);

    if (!storeId) throw new Error('Добавление на хранение доступно только из контекста магазина.');
    const enabled = await this.isEnabled(userId);
    if (!enabled) throw new Error('Хранилище возвратов отключено. Включите его в профиле.');

    let resolved;
    if (directOffer) {
      // Приоритет: если пользователь явно ввёл offer_id — идём «прямым» путём,
      // даже не пытаясь резолвить genericInput (он может быть необязательным).
      // Но если offer_id есть в returns-N.db — обогатим данными.
      const returnsDb = getReturnsDB(storeId);
      const byOffer = await returnsDb.get(
        'SELECT * FROM returns WHERE offer_id = ? LIMIT 1', directOffer
      );
      resolved = byOffer
        ? {
          ok: true, source: 'offer_id',
          offer_id: byOffer.offer_id, sku: byOffer.sku,
          barcode: byOffer.barcode, cargo_box_id: byOffer.cargo_box_id,
          product_name: byOffer.product_name,
        }
        : {
          ok: true, source: 'offer_id',
          offer_id: directOffer, sku: null, barcode: null,
          cargo_box_id: null, product_name: null,
        };
    } else {
      resolved = await this._resolveInput(storeId, genericInput);
    }

    if (!resolved.ok) {
      const offerIdsHint = Array.isArray(resolved.offer_ids) && resolved.offer_ids.length
        ? ` (${resolved.offer_ids.join(', ')})`
        : '';
      const msg = {
        empty: 'Укажите штрихкод возврата или offer_id.',
        looks_like_offer_id: `«${genericInput}» — это offer_id, а не штрихкод. Используйте поле «Артикул» для прямого указания товара.`,
        not_found: `Не удалось опознать «${genericInput}» как штрихкод возврата. Если это offer_id — используйте поле «Артикул».`,
        cargo_box_not_in_cache: `Штрихкод «${genericInput}» есть в Ozon, но возврат ещё не синхронизирован в БД магазина. Попробуйте через 1–2 часа или укажите offer_id.`,
        no_offer_id: `Штрихкод «${genericInput}» найден, но артикул не сопоставлен. Укажите offer_id напрямую или загрузите PDF-акт.`,
        no_offer_id_in_returns: `Штрихкод «${genericInput}» найден, но артикул не сопоставлен. Укажите offer_id напрямую или загрузите PDF-акт.`,
        multiple_products: `По штрихкоду «${genericInput}»${offerIdsHint} найдено несколько товаров. Автоматический резолв невозможен — добавьте каждый товар отдельно через offer_id.`,
        multiple_products_in_return: `По штрихкоду «${genericInput}»${offerIdsHint} найдено несколько товаров в возврате. Добавьте каждый товар отдельно через offer_id.`,
        skip: `Штрихкод «${genericInput}» не может быть использован для авто-резолва. Укажите offer_id напрямую.`,
      }[resolved.reason] || `Не удалось опознать «${genericInput}».`;
      throw new Error(msg);
    }

    const db = getUsersDB();
    const result = await StoredReturn.upsert(db, userId, {
      boxNumber: box,
      lozonId: resolved.source === 'lozon_id' ? String(genericInput) : null,
      barcode: resolved.barcode,
      offerId: resolved.offer_id,
      sku: resolved.sku,
      productName: resolved.product_name,
      cargoBoxId: resolved.cargo_box_id,
      quantity: qty,
      source: resolved.source,
      sourceStoreId: storeId,
    });

    return {
      id: result.id,
      created: result.created,
      quantity: result.quantity,
      offer_id: resolved.offer_id,
      sku: resolved.sku,
      barcode: resolved.barcode,
      cargo_box_id: resolved.cargo_box_id,
      source: resolved.source,
    };
  }

  /**
   * Массовый импорт из Excel.
   *
   * Колонки (порядок не важен, читаем по заголовкам, регистронезависимо):
   *   • box_number  — обязательно
   *   • offer_id    — ЛИБО обязательно
   *   • lozon_id/barcode — ЛИБО обязательно
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
    if (!enabled) throw new Error('Хранилище возвратов отключено. Включите его в профиле.');
    if (!storeId) throw new Error('Импорт доступен только из контекста магазина.');

    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error('Файл пуст или не содержит листов');
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) throw new Error('В файле нет строк с данными');

    const norm = (s) => String(s || '').trim().toLowerCase();
    const headerMap = {};
    for (const k of Object.keys(rows[0])) headerMap[norm(k)] = k;

    const colBox = headerMap['box_number'] || headerMap['коробка'] || headerMap['box'] || null;
    const colOffer = headerMap['offer_id'] || headerMap['offerid'] || headerMap['артикул'] || null;
    const colLoz = headerMap['lozon_id'] || headerMap['lozon'] || headerMap['штрихкод'] || headerMap['barcode'] || null;
    const colQty = headerMap['quantity'] || headerMap['количество'] || headerMap['qty'] || null;

    if (!colBox || (!colLoz && !colOffer) || !colQty) {
      throw new Error(
        'В файле нужны колонки: box_number + (lozon_id ИЛИ offer_id) + quantity'
      );
    }

    const errors = [];
    const valid = [];
    rows.forEach((rawRow, idx) => {
      const rowNum = idx + 2;
      const box = String(rawRow[colBox] || '').trim();
      const offer = colOffer ? String(rawRow[colOffer] || '').trim() : '';
      const loz = colLoz ? String(rawRow[colLoz] || '').trim() : '';
      const qtyRaw = String(rawRow[colQty] || '').trim();

      if (!box) { errors.push({ row: rowNum, error: 'пустой box_number' }); return; }
      if (!offer && !loz) {
        errors.push({ row: rowNum, error: 'нужен offer_id или lozon_id' });
        return;
      }
      // Мульти в ячейке → пропускаем
      if (offer && (/\s/.test(offer) || /[,;\n]/.test(offer))) {
        errors.push({ row: rowNum, offer_id: offer, error: 'в ячейке offer_id несколько значений' });
        return;
      }
      if (loz && (/\s/.test(loz) || /[,;\n]/.test(loz))) {
        errors.push({ row: rowNum, lozon_id: loz, error: 'в ячейке lozon_id несколько значений' });
        return;
      }
      if (!/^\d+$/.test(qtyRaw)) {
        errors.push({ row: rowNum, error: 'quantity не целое', raw: qtyRaw });
        return;
      }
      const qty = parseInt(qtyRaw, 10);
      if (qty < 1) { errors.push({ row: rowNum, error: 'quantity < 1' }); return; }
      valid.push({ row: rowNum, box, offer, loz, qty });
    });

    const db = getUsersDB();
    let inserted = 0;
    let updated = 0;

    for (const v of valid) {
      let resolved;
      if (v.offer) {
        const returnsDb = getReturnsDB(storeId);
        const byOffer = await returnsDb.get(
          'SELECT * FROM returns WHERE offer_id = ? LIMIT 1', v.offer
        );
        resolved = byOffer
          ? {
            ok: true, source: 'offer_id',
            offer_id: byOffer.offer_id, sku: byOffer.sku,
            barcode: byOffer.barcode, cargo_box_id: byOffer.cargo_box_id,
            product_name: byOffer.product_name,
          }
          : {
            ok: true, source: 'offer_id',
            offer_id: v.offer, sku: null, barcode: null,
            cargo_box_id: null, product_name: null,
          };
      } else {
        try {
          resolved = await this._resolveInput(storeId, v.loz);
        } catch (err) {
          errors.push({ row: v.row, lozon_id: v.loz, error: `Ozon API: ${err.message}` });
          continue;
        }
      }
      if (!resolved.ok) {
        const reasonMap = {
          not_found: 'не найдено в Ozon',
          cargo_box_not_in_cache: 'возврат не синхронизирован в БД',
          no_offer_id: 'артикул не сопоставлен (нужен PDF-акт)',
          no_offer_id_in_returns: 'артикул не сопоставлен (нужен PDF-акт)',
          multiple_products: 'несколько товаров в возврате — добавьте через offer_id',
          multiple_products_in_return: 'несколько товаров в возврате — добавьте через offer_id',
          skip: 'авто-резолв невозможен, добавьте через offer_id',
        };
        errors.push({
          row: v.row, offer_id: v.offer || null, lozon_id: v.loz || null,
          error: reasonMap[resolved.reason] || 'не удалось опознать',
        });
        continue;
      }
      try {
        const r = await StoredReturn.upsert(db, userId, {
          boxNumber: v.box,
          lozonId: resolved.source === 'lozon_id' ? v.loz : null,
          barcode: resolved.barcode,
          offerId: resolved.offer_id,
          sku: resolved.sku,
          productName: resolved.product_name,
          cargoBoxId: resolved.cargo_box_id,
          quantity: v.qty,
          source: resolved.source,
          sourceStoreId: storeId,
        });
        if (r.created) inserted++; else updated++;
      } catch (err) {
        errors.push({ row: v.row, error: err.message });
      }
    }

    return {
      total: rows.length, valid: valid.length,
      inserted, updated, rejected: errors.length, errors,
    };
  }

  // ── Чтение ───────────────────────────────────────────────────────────────

  static async listForUser(userId, { status = 'stored', includeAll = false } = {}) {
    const db = getUsersDB();
    return StoredReturn.listForUser(db, userId, { status, includeAll });
  }

  static async listForStaff({
    storeId, userId = null, status = 'stored',
    resolutionStatus = null, source = null,
  }) {
    const db = getUsersDB();
    return StoredReturn.listForStaff(db, { storeId, userId, status, resolutionStatus, source });
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
  static async addManual(userId, { boxNumber, offerId, input, quantity = 1 }, { storeId = null } = {}) {
    const box = String(boxNumber || '').trim();
    const directOffer = String(offerId || '').trim();
    const genericInput = String(input || '').trim();

    if (!box) throw new Error('Укажите номер/название коробки');
    if (!directOffer && !genericInput) {
      throw new Error('Укажите offer_id или штрихкод возврата');
    }
    if (box.length > 100) throw new Error('Название коробки: максимум 100 символов');
    const qty = Math.max(1, parseInt(quantity, 10) || 1);

    if (!storeId) throw new Error('Добавление на хранение доступно только из контекста магазина.');
    const enabled = await this.isEnabled(userId);
    if (!enabled) throw new Error('Хранилище возвратов отключено. Включите его в профиле.');

    let resolved;
    if (directOffer) {
      const returnsDb = getReturnsDB(storeId);
      const byOffer = await returnsDb.get(
        'SELECT * FROM returns WHERE offer_id = ? LIMIT 1', directOffer
      );
      resolved = byOffer
        ? {
          ok: true, source: 'offer_id',
          offer_id: byOffer.offer_id, sku: byOffer.sku,
          barcode: byOffer.barcode, cargo_box_id: byOffer.cargo_box_id,
          product_name: byOffer.product_name,
        }
        : {
          ok: true, source: 'offer_id',
          offer_id: directOffer, sku: null, barcode: null,
          cargo_box_id: null, product_name: null,
        };
    } else {
      resolved = await this._resolveInput(storeId, genericInput);
    }

    if (!resolved.ok) {
      const offerIdsHint = Array.isArray(resolved.offer_ids) && resolved.offer_ids.length
        ? ` (${resolved.offer_ids.join(', ')})`
        : '';
      const msg = {
        empty: 'Укажите штрихкод возврата или offer_id.',
        not_found: `Не удалось опознать «${genericInput}». Попробуйте offer_id напрямую.`,
        cargo_box_not_in_cache: `Штрихкод «${genericInput}» есть в Ozon, но возврат ещё не синхронизирован в БД магазина. Попробуйте через 1–2 часа или укажите offer_id.`,
        no_offer_id: `Штрихкод «${genericInput}» найден, но артикул не сопоставлен. Укажите offer_id напрямую или загрузите PDF-акт.`,
        no_offer_id_in_returns: `Штрихкод «${genericInput}» найден, но артикул не сопоставлен. Укажите offer_id напрямую или загрузите PDF-акт.`,
        multiple_products: `По штрихкоду «${genericInput}»${offerIdsHint} найдено несколько товаров. Автоматический резолв невозможен — добавьте каждый товар отдельно через offer_id.`,
        multiple_products_in_return: `По штрихкоду «${genericInput}»${offerIdsHint} найдено несколько товаров в возврате. Добавьте каждый товар отдельно через offer_id.`,
        skip: `Штрихкод «${genericInput}» не может быть использован для авто-резолва. Укажите offer_id напрямую.`,
      }[resolved.reason] || `Не удалось опознать «${genericInput}».`;
      throw new Error(msg);
    }

    const db = getUsersDB();
    const result = await StoredReturn.upsert(db, userId, {
      boxNumber: box,
      lozonId: resolved.source === 'lozon_id' ? String(genericInput) : null,
      barcode: resolved.barcode,
      offerId: resolved.offer_id,
      sku: resolved.sku,
      productName: resolved.product_name,
      cargoBoxId: resolved.cargo_box_id,
      quantity: qty,
      source: resolved.source,
      sourceStoreId: storeId,
    });

    return {
      id: result.id,
      created: result.created,
      quantity: result.quantity,
      offer_id: resolved.offer_id,
      sku: resolved.sku,
      barcode: resolved.barcode,
      cargo_box_id: resolved.cargo_box_id,
      source: resolved.source,
    };
  }
}

module.exports = StoredReturnsService;