// src/models/StoredReturn.js
// Глобальное «хранилище возвратов» (users.db).
// Все методы, которые пишут/читают БД, принимают db-хендл явно — чтобы
// вызывающий мог объединить несколько операций в одну транзакцию.
const { getUsersDB } = require('../config/database');

/**
 * Одна строка = партия одного lozon_id в одной коробке у одного сотрудника.
 * status: 'stored' | 'used' | 'removed'.
 * resolution_status: 'pending' | 'resolved' | 'unresolved'.
 */
class StoredReturn {
  /**
   * UPSERT с app-level merge по (user_id, offer_id, box_number).
   *
   * Логика:
   *   1. Ищем существующую строку по (user_id, offer_id, box_number, status='stored').
   *   2. Если нашли → увеличиваем quantity, добиваем недостающие поля (COALESCE).
   *   3. Если нет → вставляем новую.
   *
   * Placeholder в lozon_id (NOT NULL в схеме) для не-lozon путей:
   *   • 'MANUAL_BARCODE:<barcode>' — ввод по barcode
   *   • 'MANUAL_OFFER:<offer_id>'  — ввод по offer_id напрямую
   */
  static async upsert(db, userId, data) {
    const {
      boxNumber,
      lozonId = null,
      barcode = null,
      offerId,
      sku = null,
      productName = null,
      cargoBoxId = null,
      quantity = 1,
      source = 'lozon_id',               // 'lozon_id' | 'barcode' | 'offer_id'
      sourceStoreId = null,
      sourceOrderId = null,
    } = data;

    if (!offerId) throw new Error('StoredReturn.upsert: offer_id обязателен');
    if (!boxNumber) throw new Error('StoredReturn.upsert: box_number обязателен');

    const now = Date.now();
    const qty = Math.max(1, parseInt(quantity, 10) || 1);

    // Нормализация ключа для NOT NULL
    let lozonKey = lozonId;
    if (!lozonKey) {
      lozonKey = source === 'barcode' && barcode
        ? `MANUAL_BARCODE:${barcode}`
        : `MANUAL_OFFER:${offerId}`;
    }

    // App-level merge по (user, offer, box)
    const existing = await db.get(
      `SELECT id, quantity FROM stored_returns
       WHERE user_id = ? AND offer_id = ? AND box_number = ? AND status = 'stored'
       ORDER BY created_at ASC LIMIT 1`,
      userId, offerId, boxNumber
    );

    if (existing) {
      const newQuantity = existing.quantity + qty;
      await db.run(
        `UPDATE stored_returns
         SET quantity = ?, updated_at = ?,
             lozon_id = CASE
               WHEN lozon_id LIKE 'MANUAL_%' AND ? IS NOT NULL AND ? NOT LIKE 'MANUAL_%'
                 THEN ?
               ELSE lozon_id
             END,
             barcode = COALESCE(barcode, ?),
             cargo_box_id = COALESCE(cargo_box_id, ?),
             sku = COALESCE(sku, ?),
             product_name = COALESCE(product_name, ?)
         WHERE id = ?`,
        newQuantity, now,
        lozonId, lozonId, lozonId,  // если пришёл настоящий lozonId — перезапишем MANUAL
        barcode, cargoBoxId, sku, productName,
        existing.id
      );
      return { id: existing.id, created: false, quantity: newQuantity };
    }

    const result = await db.run(
      `INSERT INTO stored_returns
         (user_id, box_number, lozon_id, offer_id, barcode, cargo_box_id,
          sku, product_name, quantity, source,
          resolution_status, resolution_attempts,
          source_store_id, source_order_id, status,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'resolved', 0, ?, ?, 'stored', ?, ?)`,
      userId, boxNumber, lozonKey, offerId, barcode, cargoBoxId,
      sku, productName, qty, source,
      sourceStoreId, sourceOrderId, now, now
    );
    return { id: result.lastID, created: true, quantity: qty };
  }

  static async getById(db, id) {
    return (await db.get('SELECT * FROM stored_returns WHERE id = ?', id)) || null;
  }

  /**
   * Список записей сотрудника. По умолчанию — активные ('stored').
   */
  static async listForUser(db, userId, { status = 'stored', includeAll = false } = {}) {
    if (includeAll) {
      return db.all(
        'SELECT * FROM stored_returns WHERE user_id = ? ORDER BY created_at DESC',
        userId
      );
    }
    return db.all(
      'SELECT * FROM stored_returns WHERE user_id = ? AND status = ? ORDER BY created_at DESC',
      userId, status
    );
  }

  /**
   * Список для персонала магазина: только записи сотрудников ЭТОГО магазина.
   */
  static async listForStaff(db, {
    storeId,
    userId = null,
    status = 'stored',
    resolutionStatus = null,
    source = null,
  }) {
    const conds = ['us.store_id = ?', 'us.is_fired = 0', 'sr.status = ?'];
    const params = [String(storeId), status];
    if (userId) { conds.push('sr.user_id = ?'); params.push(userId); }
    if (resolutionStatus) { conds.push('sr.resolution_status = ?'); params.push(resolutionStatus); }
    if (source) { conds.push('sr.source = ?'); params.push(source); }

    return db.all(
      `SELECT sr.*, u.name AS user_name, u.username AS user_username
     FROM stored_returns sr
     INNER JOIN user_stores us ON us.user_id = sr.user_id
     INNER JOIN users u ON u.id = sr.user_id
     WHERE ${conds.join(' AND ')}
     ORDER BY sr.created_at DESC`,
      params
    );
  }

  /**
   * Очередь резолвера: 'pending' / 'unresolved', attempts < maxAttempts.
   * Возвращает по created_at ASC (FIFO).
   */
  static async listPending(db, { limit = 100, maxAttempts = 10 } = {}) {
    return db.all(
      `SELECT * FROM stored_returns
       WHERE status = 'stored'
         AND resolution_status IN ('pending', 'unresolved')
         AND resolution_attempts < ?
       ORDER BY created_at ASC
       LIMIT ?`,
      maxAttempts, limit
    );
  }

  /**
   * Обновить результат резолва. idempotent: если запись уже resolved — не трогаем.
   */
  static async applyResolution(db, id, { offerId = null, sku = null, productName = null, success }) {
    const now = Date.now();
    if (success) {
      await db.run(
        `UPDATE stored_returns
         SET offer_id = COALESCE(?, offer_id),
             sku = COALESCE(?, sku),
             product_name = COALESCE(?, product_name),
             resolution_status = 'resolved',
             resolution_attempts = resolution_attempts + 1,
             last_resolution_attempt_at = ?,
             resolution_error = NULL,
             updated_at = ?
         WHERE id = ? AND status = 'stored'`,
        offerId, sku, productName, now, now, id
      );
    } else {
      // Считаем попытки. Если достигли лимита — 'unresolved', иначе 'pending'.
      // MAX_ATTEMPTS дублируется в сервисе, здесь — консервативно 10.
      await db.run(
        `UPDATE stored_returns
         SET resolution_attempts = resolution_attempts + 1,
             last_resolution_attempt_at = ?,
             resolution_status = CASE
               WHEN resolution_attempts + 1 >= 10 THEN 'unresolved'
               ELSE 'pending'
             END,
             updated_at = ?
         WHERE id = ? AND status = 'stored' AND resolution_status != 'resolved'`,
        now, now, id
      );
    }
  }

  /**
   * Найти «готовые» возвраты по списку offer_id/sku, только у активных
   * сотрудников указанного магазина. Возвращает сгруппированный результат.
   *
   * @param {object} db     — usersDb
   * @param {string[]} offerIds
   * @param {string[]} skus
   * @param {string} storeId
   * @returns {Promise<Array<{ offer_id, sku, user_id, user_name, box_number, quantity, lozon_ids: string[] }>>}
   */
  static async findMatches(db, { offerIds = [], skus = [], storeId }) {
    const conds = ["sr.status = 'stored'", 'sr.quantity > 0', 'us.store_id = ?', 'us.is_fired = 0'];
    const params = [String(storeId)];

    const orParts = [];
    if (offerIds.length) {
      orParts.push(`sr.offer_id IN (${offerIds.map(() => '?').join(',')})`);
      params.push(...offerIds);
    }
    if (skus.length) {
      orParts.push(`sr.sku IN (${skus.map(() => '?').join(',')})`);
      params.push(...skus);
    }
    if (!orParts.length) return [];
    conds.push(`(${orParts.join(' OR ')})`);

    const rows = await db.all(
      `SELECT sr.offer_id, sr.sku, sr.user_id, u.name AS user_name,
              sr.box_number, sr.quantity, sr.lozon_id, sr.created_at
       FROM stored_returns sr
       INNER JOIN user_stores us ON us.user_id = sr.user_id
       INNER JOIN users u ON u.id = sr.user_id
       WHERE ${conds.join(' AND ')}
       ORDER BY sr.created_at ASC`,
      params
    );

    // Группируем: (offer_id|sku, user_id, box_number) -> агрегируем quantity + lozon_ids
    const map = new Map();
    for (const r of rows) {
      const key = `${r.offer_id || ''}|${r.sku || ''}|${r.user_id}|${r.box_number}`;
      if (!map.has(key)) {
        map.set(key, {
          offer_id: r.offer_id,
          sku: r.sku,
          user_id: r.user_id,
          user_name: r.user_name,
          box_number: r.box_number,
          quantity: 0,
          lozon_ids: [],
        });
      }
      const g = map.get(key);
      g.quantity += r.quantity;
      if (r.lozon_id && !g.lozon_ids.includes(r.lozon_id)) g.lozon_ids.push(r.lozon_id);
    }
    return Array.from(map.values());
  }

  /**
   * Списать с хранилища сотрудника товары под заказ.
   * Пишет строки в stored_returns_consumptions, уменьшает quantity,
   * при 0 — status='used'.
   *
   * ВАЖНО: вызывается в ОТДЕЛЬНОЙ транзакции usersDb (после коммита store-транзакции
   * в OrderService.finishOrder). Атомарно с store-N.db не получится (2 файла),
   * но при ошибке OrderService логирует + notifyStaff, чтобы можно было исправить.
   *
   * @param {object} db     — usersDb (в транзакции)
   * @param {number} userId
   * @param {string} orderId
   * @param {string} storeId
   * @param {Array<{offer_id?:string, sku?:string, quantity:number}>} products
   * @returns {Promise<Array<{ lozon_id, box_number, quantity, stored_return_id, offer_id, sku }>>}
   */
  static async consumeForOrder(db, userId, orderId, storeId, products) {
    const consumed = [];
    const now = Date.now();

    for (const p of products || []) {
      const needRaw = Math.max(1, parseInt(p.quantity, 10) || 1);
      let need = needRaw;
      const offerId = p.offer_id ? String(p.offer_id) : null;
      const sku = p.sku ? String(p.sku) : null;
      if (!offerId && !sku) continue;

      // Тянем партии FIFO. Приоритет — по offer_id, если он есть; fallback — sku.
      const conds = ["status = 'stored'", 'user_id = ?', 'quantity > 0'];
      const params = [userId];
      const orParts = [];
      if (offerId) { orParts.push('offer_id = ?'); params.push(offerId); }
      if (sku) { orParts.push('sku = ?'); params.push(sku); }
      conds.push(`(${orParts.join(' OR ')})`);

      const batches = await db.all(
        `SELECT id, offer_id, sku, box_number, lozon_id, quantity
         FROM stored_returns
         WHERE ${conds.join(' AND ')}
         ORDER BY created_at ASC`,
        params
      );

      for (const b of batches) {
        if (need <= 0) break;
        const take = Math.min(b.quantity, need);
        const remaining = b.quantity - take;
        if (remaining > 0) {
          await db.run(
            'UPDATE stored_returns SET quantity = ?, updated_at = ? WHERE id = ?',
            remaining, now, b.id
          );
        } else {
          await db.run(
            "UPDATE stored_returns SET quantity = 0, status = 'used', updated_at = ? WHERE id = ?",
            now, b.id
          );
        }
        await db.run(
          `INSERT INTO stored_returns_consumptions
             (stored_return_id, order_id, store_id, user_id,
              lozon_id, offer_id, sku, box_number, quantity, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          b.id, orderId, String(storeId), userId,
          b.lozon_id, b.offer_id, b.sku, b.box_number, take, now
        );
        consumed.push({
          stored_return_id: b.id,
          lozon_id: b.lozon_id,
          box_number: b.box_number,
          quantity: take,
          offer_id: b.offer_id,
          sku: b.sku,
        });
        need -= take;
      }
    }

    return consumed;
  }

  /**
   * Симметрично consumeForOrder: вернуть списанное обратно в хранилище.
   * Используется при отмене заказа (если успели списать). Помечает
   * consumptions.restored_at, возвращает quantity в исходную запись.
   */
  static async restoreForOrder(db, orderId, storeId) {
    const rows = await db.all(
      `SELECT * FROM stored_returns_consumptions
       WHERE order_id = ? AND store_id = ? AND restored_at IS NULL`,
      orderId, String(storeId)
    );
    const now = Date.now();
    for (const r of rows) {
      await db.run(
        `UPDATE stored_returns
         SET quantity = quantity + ?,
             status = 'stored',
             updated_at = ?
         WHERE id = ?`,
        r.quantity, now, r.stored_return_id
      );
      await db.run(
        'UPDATE stored_returns_consumptions SET restored_at = ? WHERE id = ?',
        now, r.id
      );
    }
    return rows.length;
  }

  /**
   * Мягкое удаление (status='removed'). Только владелец.
   */
  static async softDelete(db, id, userId) {
    const result = await db.run(
      `UPDATE stored_returns
       SET status = 'removed', updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'stored'`,
      Date.now(), id, userId
    );
    return result.changes === 1;
  }

  /**
 * Soft-delete всех активных записей пользователя (только status='stored').
 * Не трогает status='used' — это история ранее списанных товаров,
 * на неё ссылаются stored_returns_consumptions (FK).
 *
 * @returns {Promise<number>} — сколько записей помечено как removed
 */
  static async clearAllForUser(db, userId) {
    const result = await db.run(
      `UPDATE stored_returns
     SET status = 'removed', updated_at = ?
     WHERE user_id = ? AND status = 'stored'`,
      Date.now(), userId
    );
    return result.changes || 0;
  }

  /**
   * Ручной резолв: сотрудник указал offer_id/sku вручную.
   */
  static async manualResolve(db, id, userId, { offerId = null, sku = null, productName = null }) {
    if (!offerId && !sku) {
      throw new Error('Укажите offer_id или sku');
    }
    const now = Date.now();
    const result = await db.run(
      `UPDATE stored_returns
       SET offer_id = COALESCE(?, offer_id),
           sku = COALESCE(?, sku),
           product_name = COALESCE(?, product_name),
           resolution_status = 'resolved',
           resolution_error = NULL,
           last_resolution_attempt_at = ?,
           updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'stored'`,
      offerId, sku, productName, now, now, id, userId
    );
    return result.changes === 1;
  }
}

module.exports = StoredReturn;