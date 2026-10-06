const { getDB } = require('../config/database');

/**
 * Управление статистикой товаров (материал, цвет, вес)
 */
class ProductStat {
  /**
   * Получить статистику по offer_id
   */
  static async get(offerId) {
    const db = getDB();
    return db.get('SELECT * FROM product_stats WHERE offer_id = ?', offerId);
  }

  /**
   * Сохранить или обновить статистику
   */
  static async upsert(offerId, material, color, weight, userId) {
    const db = getDB();
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

  /**
   * Удалить статистику (для админа)
   */
  static async delete(offerId) {
    const db = getDB();
    await db.run('DELETE FROM product_stats WHERE offer_id = ?', offerId);
  }

  /**
   * Получить все записи для экспорта (с именами пользователей)
   */
  static async getAll() {
    const db = getDB();
    return db.all(`
      SELECT ps.offer_id, ps.material, ps.color, ps.weight_grams,
             ps.user_id, u.name as user_name, ps.updated_at
      FROM product_stats ps
      LEFT JOIN users u ON ps.user_id = u.id
      ORDER BY ps.offer_id
    `);
  }

  /**
   * Проверить, есть ли статистика для списка offer_id (для завершения заказа)
   * @param {string[]} offerIds
   * @returns {Promise<{ missing: string[], existing: string[] }>}
   */
  static async checkBatch(offerIds) {
    if (!offerIds || offerIds.length === 0) {
      return { missing: [], existing: [] };
    }
    const db = getDB();
    const placeholders = offerIds.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT offer_id FROM product_stats WHERE offer_id IN (${placeholders})`,
      offerIds
    );
    const existingSet = new Set(rows.map(r => r.offer_id));
    const missing = offerIds.filter(id => !existingSet.has(id));
    return { missing, existing: offerIds.filter(id => existingSet.has(id)) };
  }
}

module.exports = ProductStat;