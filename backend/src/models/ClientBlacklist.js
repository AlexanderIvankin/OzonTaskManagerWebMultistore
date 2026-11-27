const { getUsersDB } = require('../config/database');

/**
 * Чёрный список клиентов (users.db, глобальный).
 *
 * client_id — первая часть posting_number Ozon: "91703548-0052-1" → "91703548".
 * Один вредитель = одна запись на всю систему (все магазины).
 */
class ClientBlacklist {
  static async list() {
    const db = getUsersDB();
    return db.all(`
      SELECT cb.client_id, cb.reason, cb.added_by, cb.added_at,
             u.name AS added_by_name
      FROM client_blacklist cb
      LEFT JOIN users u ON u.id = cb.added_by
      ORDER BY cb.added_at DESC
    `);
  }

  static async get(clientId) {
    const db = getUsersDB();
    return db.get(
      `SELECT cb.client_id, cb.reason, cb.added_by, cb.added_at,
              u.name AS added_by_name
       FROM client_blacklist cb
       LEFT JOIN users u ON u.id = cb.added_by
       WHERE cb.client_id = ?`,
      String(clientId).trim()
    );
  }

  /**
   * Bulk lookup: array of client_ids → Map<clientId, row>.
   * Один запрос на страницу заказов (не N+1).
   */
  static async getBatch(clientIds) {
    const result = new Map();
    if (!Array.isArray(clientIds) || !clientIds.length) return result;
    const uniq = Array.from(new Set(clientIds.map((c) => String(c).trim()).filter(Boolean)));
    if (!uniq.length) return result;

    const db = getUsersDB();
    const placeholders = uniq.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT client_id, reason, added_by, added_at
       FROM client_blacklist
       WHERE client_id IN (${placeholders})`,
      ...uniq
    );
    for (const row of rows) result.set(row.client_id, row);
    return result;
  }

  /**
   * Upsert: повторное добавление обновляет reason и added_at.
   */
  static async add(clientId, { reason = null, addedBy = null } = {}) {
    const cid = String(clientId || '').trim();
    if (!cid) throw new Error('client_id не может быть пустым');

    const db = getUsersDB();
    await db.run(
      `INSERT INTO client_blacklist (client_id, reason, added_by, added_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET
         reason = excluded.reason,
         added_by = excluded.added_by,
         added_at = excluded.added_at`,
      cid, reason || null, addedBy || null, Date.now()
    );
    return this.get(cid);
  }

  static async remove(clientId) {
    const cid = String(clientId || '').trim();
    if (!cid) return false;
    const db = getUsersDB();
    const res = await db.run('DELETE FROM client_blacklist WHERE client_id = ?', cid);
    return (res.changes || 0) > 0;
  }
}

module.exports = ClientBlacklist;