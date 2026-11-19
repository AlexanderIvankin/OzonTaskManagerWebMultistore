// src/services/ReturnsCacheService.js
//
// Работа с локальным кэшем возвратов Ozon (returns-N.db).
//   • upsertMany           — пачка возвратов (шаг 1, из CSV-отчёта);
//   • applyCargoBoxIdBatch — пары из PDF (шаг 2, ручная заливка модератора);
//   • getByBarcode         — резолв штрихкода (шаг 3, addManual);
//   • getByCargoBoxId, count, pruneOlderThan.

const { getReturnsDB } = require('../config/returnsDatabase');

const MAX_BARCODE_LEN = 200;
const MAX_CARGO_BOX_LEN = 100;

class ReturnsCacheService {
  /**
   * UPSERT пачки возвратов в returns-N.db. Ключ — returns[].id (PK).
   * Идемпотентно: повторная загрузка того же возврата обновляет запись.
   *
   * @param {string} storeId
   * @param {Array<object>} rows — см. схему в returnsDatabase.js.
   *   Обязательно: id.
   *   resolution_status: 'ready' если есть offer_id или sku, иначе 'skip'.
   * @returns {Promise<{ inserted: number, updated: number, skipped: number }>}
   */
  static async upsertMany(storeId, rows) {
    const db = getReturnsDB(storeId);
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const now = Date.now();

    await db.run('BEGIN IMMEDIATE');
    try {
      for (const r of rows || []) {
        if (!r || !r.id || !r.barcode) { skipped++; continue; }
        try {
          const existing = await db.get('SELECT id FROM returns WHERE id = ?', r.id);
          await db.run(
            `INSERT INTO returns
               (id, barcode, cargo_box_id, offer_id, sku, product_name, quantity,
                order_id, order_number, posting_number, schema, return_schema,
                return_date, status_name, status_sys_name, place_name,
                resolution_status, resolution_reason, raw_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               barcode = excluded.barcode,
               offer_id = excluded.offer_id,
               sku = excluded.sku,
               product_name = excluded.product_name,
               quantity = excluded.quantity,
               order_id = excluded.order_id,
               order_number = excluded.order_number,
               posting_number = excluded.posting_number,
               schema = excluded.schema,
               return_schema = excluded.return_schema,
               return_date = excluded.return_date,
               status_name = excluded.status_name,
               status_sys_name = excluded.status_sys_name,
               place_name = excluded.place_name,
               resolution_status = excluded.resolution_status,
               resolution_reason = excluded.resolution_reason,
               raw_json = excluded.raw_json,
               updated_at = excluded.updated_at`,
            r.id,
            r.barcode,
            r.cargo_box_id || null,
            r.offer_id || null,
            r.sku || null,
            r.product_name || null,
            r.quantity != null ? Number(r.quantity) : 1,
            r.order_id || null,
            r.order_number || null,
            r.posting_number || null,
            r.schema || null,
            r.return_schema || null,
            r.return_date || null,
            r.status_name || null,
            r.status_sys_name || null,
            r.place_name || null,
            r.resolution_status || 'ready',
            r.resolution_reason || null,
            typeof r.raw_json === 'string' ? r.raw_json : (r.raw_json ? JSON.stringify(r.raw_json) : null),
            now, now
          );
          if (existing) updated++; else inserted++;
        } catch (err) {
          console.warn(`[ReturnsCache] upsert ${r.id}:`, err.message);
          skipped++;
        }
      }
      await db.run('COMMIT');
    } catch (err) {
      try { await db.run('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    return { inserted, updated, skipped };
  }

  /**
   * Применяет пары { cargo_box_id, barcode } из PDF-акта.
   * Обновляет ТОЛЬКО записи, где cargo_box_id ещё NULL или совпадает.
   * Конфликты (было другое значение) не перезаписываем — считаем в conflicts.
   *
   * @returns {Promise<{ updated, alreadySet, notFound, conflicts }>}
   */
  static async applyCargoBoxIdBatch(storeId, pairs) {
    const db = getReturnsDB(storeId);
    let updated = 0;
    let alreadySet = 0;
    let notFound = 0;
    let conflicts = 0;
    const now = Date.now();

    await db.run('BEGIN IMMEDIATE');
    try {
      for (const p of pairs || []) {
        const barcode = String(p.barcode || '').trim();
        const cargoBoxId = String(p.cargo_box_id || '').trim();
        if (!barcode || !cargoBoxId) continue;
        if (barcode.length > MAX_BARCODE_LEN || cargoBoxId.length > MAX_CARGO_BOX_LEN) continue;

        const rows = await db.all(
          'SELECT id, cargo_box_id FROM returns WHERE barcode = ?',
          barcode
        );
        if (!rows.length) { notFound++; continue; }

        for (const row of rows) {
          if (!row.cargo_box_id) {
            await db.run(
              'UPDATE returns SET cargo_box_id = ?, updated_at = ? WHERE id = ?',
              cargoBoxId, now, row.id
            );
            updated++;
          } else if (row.cargo_box_id === cargoBoxId) {
            alreadySet++;
          } else {
            conflicts++;
          }
        }
      }
      await db.run('COMMIT');
    } catch (err) {
      try { await db.run('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    return { updated, alreadySet, notFound, conflicts };
  }

  static async getByBarcode(storeId, barcode) {
    const db = getReturnsDB(storeId);
    return db.all('SELECT * FROM returns WHERE barcode = ?', String(barcode));
  }

  static async getByCargoBoxId(storeId, cargoBoxId) {
    const db = getReturnsDB(storeId);
    return db.all('SELECT * FROM returns WHERE cargo_box_id = ?', String(cargoBoxId));
  }

  static async count(storeId) {
    const db = getReturnsDB(storeId);
    const r = await db.get('SELECT COUNT(*) AS n FROM returns');
    return r ? r.n : 0;
  }

  static async list(storeId, { limit = 100, offset = 0 } = {}) {
    const db = getReturnsDB(storeId);
    return db.all(
      'SELECT * FROM returns ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      Math.min(Math.max(limit, 1), 1000), Math.max(offset, 0)
    );
  }

  static async pruneOlderThan(storeId, days) {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const db = getReturnsDB(storeId);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const r = await db.run('DELETE FROM returns WHERE updated_at < ?', cutoff);
    return r.changes || 0;
  }
}

module.exports = ReturnsCacheService;