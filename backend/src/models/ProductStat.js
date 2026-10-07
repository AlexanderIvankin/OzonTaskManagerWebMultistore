const { getStoreDB } = require('../config/database');

/**
 * Статистика товаров (store-N.db): материал, цвет, вес.
 * Все методы принимают storeId первым аргументом.
 */
class ProductStat {
  static async get(storeId, offerId) {
    const db = getStoreDB(storeId);
    return db.get('SELECT * FROM product_stats WHERE offer_id = ?', offerId);
  }

  static async upsert(storeId, offerId, material, color, weight, userId) {
    const db = getStoreDB(storeId);
    await db.run(
      `INSERT INTO product_stats (offer_id, material, color, weight_grams, user_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(offer_id) DO UPDATE SET
         material = excluded.material,
         color = excluded.color,
         weight_grams = excluded.weight_grams,
         user_id = excluded.user_id,
         updated_at = excluded.updated_at`,
      offerId, material, color, weight, userId, Date.now()
    );
  }

  static async delete(storeId, offerId) {
    const db = getStoreDB(storeId);
    await db.run('DELETE FROM product_stats WHERE offer_id = ?', offerId);
  }

  static async getAll(storeId) {
    const db = getStoreDB(storeId);
    return db.all(`
      SELECT ps.offer_id, ps.material, ps.color, ps.weight_grams,
             ps.user_id, u.name AS user_name, ps.updated_at
      FROM product_stats ps
      LEFT JOIN usersdb.users u ON u.id = ps.user_id
      ORDER BY ps.offer_id
    `);
  }

  static async checkBatch(storeId, offerIds) {
    if (!offerIds || offerIds.length === 0) {
      return { missing: [], existing: [] };
    }
    const db = getStoreDB(storeId);
    const placeholders = offerIds.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT offer_id FROM product_stats WHERE offer_id IN (${placeholders})`,
      offerIds
    );
    const existingSet = new Set(rows.map((r) => r.offer_id));
    const missing = offerIds.filter((id) => !existingSet.has(id));
    return { missing, existing: offerIds.filter((id) => existingSet.has(id)) };
  }
}

module.exports = ProductStat;