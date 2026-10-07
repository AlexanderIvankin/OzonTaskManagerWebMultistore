const { getStoreDB } = require('../config/database');

/**
 * Заработок сотрудников (store-N.db).
 *
 * История (earnings_history) + активный расчёт (earnings_active) +
 * корректировки (earnings_adjustments + earnings_adjustments_active).
 * Все методы принимают storeId первым аргументом.
 */
class Earnings {
  // -------------------- ИСТОРИЯ --------------------

  static async saveHistory(storeId, userId, orderId, amount) {
    const db = getStoreDB(storeId);
    await db.run(
      `INSERT INTO earnings_history (user_id, order_id, amount, calculated_at)
       VALUES (?, ?, ?, ?)`,
      userId, orderId, amount, Date.now()
    );
  }

  static async getHistory(storeId, userId, fromDate, toDate) {
    const db = getStoreDB(storeId);
    return db.all(
      `SELECT order_id, amount, calculated_at
       FROM earnings_history
       WHERE user_id = ? AND calculated_at >= ? AND calculated_at <= ?
       ORDER BY calculated_at`,
      userId, fromDate, toDate
    );
  }

  static async getAllHistoryForPeriod(storeId, fromDate, toDate) {
    const db = getStoreDB(storeId);
    return db.all(`
      SELECT u.id, u.name, eh.order_id, eh.amount, eh.calculated_at
      FROM earnings_history eh
      LEFT JOIN usersdb.users u ON u.id = eh.user_id
      WHERE eh.calculated_at >= ? AND eh.calculated_at <= ?
      ORDER BY eh.user_id, eh.calculated_at
    `, fromDate, toDate);
  }

  static async getSumHistory(storeId, userId, fromDate, toDate) {
    const db = getStoreDB(storeId);
    const row = await db.get(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM earnings_history
       WHERE user_id = ? AND calculated_at >= ? AND calculated_at <= ?`,
      userId, fromDate, toDate
    );
    return row ? row.total : 0;
  }

  static async getOrderEarningsSum(storeId, userId, orderId) {
    const db = getStoreDB(storeId);
    const row = await db.get(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM earnings_history
       WHERE user_id = ? AND order_id = ?`,
      userId, orderId
    );
    return row ? Number(row.total) || 0 : 0;
  }

  static async getHistoryWithDetails(storeId, userId, fromDate, toDate) {
    return this.getHistory(storeId, userId, fromDate, toDate);
  }

  // -------------------- АКТИВНЫЙ ЗАРАБОТОК --------------------

  static async saveActive(storeId, userId, orderId, amount) {
    const db = getStoreDB(storeId);
    await db.run(
      `INSERT INTO earnings_active (user_id, order_id, amount, calculated_at)
       VALUES (?, ?, ?, ?)`,
      userId, orderId, amount, Date.now()
    );
  }

  static async getActive(storeId, userId, fromDate, toDate) {
    const db = getStoreDB(storeId);
    return db.all(
      `SELECT order_id, amount, calculated_at
       FROM earnings_active
       WHERE user_id = ? AND calculated_at >= ? AND calculated_at <= ?
       ORDER BY calculated_at`,
      userId, fromDate, toDate
    );
  }

  static async getActiveSum(storeId, userId, fromDate, toDate) {
    const db = getStoreDB(storeId);
    const row = await db.get(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM earnings_active
       WHERE user_id = ? AND calculated_at >= ? AND calculated_at <= ?`,
      userId, fromDate, toDate
    );
    return row ? row.total : 0;
  }

  static async clearActive(storeId, userId) {
    const db = getStoreDB(storeId);
    await db.run('DELETE FROM earnings_active WHERE user_id = ?', userId);
  }

  /**
   * Все активные заработки магазина (для экспорта).
   */
  static async getAllActiveForPeriod(storeId, fromDate, toDate) {
    const db = getStoreDB(storeId);
    return db.all(`
      SELECT u.id, u.name, ea.order_id, ea.amount, ea.calculated_at
      FROM earnings_active ea
      LEFT JOIN usersdb.users u ON u.id = ea.user_id
      WHERE ea.calculated_at >= ? AND ea.calculated_at <= ?
      ORDER BY ea.user_id, ea.calculated_at
    `, fromDate, toDate);
  }

  // -------------------- КОРРЕКТИРОВКИ --------------------

  static async addAdjustment(storeId, userId, amount, reason = '') {
    const db = getStoreDB(storeId);
    await db.run(
      `INSERT INTO earnings_adjustments (user_id, amount, reason, adjusted_at)
       VALUES (?, ?, ?, ?)`,
      userId, amount, reason, Date.now()
    );
  }

  static async getAdjustmentsSum(storeId, userId, fromDate, toDate) {
    const db = getStoreDB(storeId);
    const row = await db.get(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM earnings_adjustments
       WHERE user_id = ? AND adjusted_at >= ? AND adjusted_at <= ?`,
      userId, fromDate, toDate
    );
    return row ? row.total : 0;
  }

  static async getAllAdjustmentsForPeriod(storeId, fromDate, toDate) {
    const db = getStoreDB(storeId);
    return db.all(`
      SELECT u.id, u.name, ea.amount, ea.reason, ea.adjusted_at
      FROM earnings_adjustments ea
      LEFT JOIN usersdb.users u ON u.id = ea.user_id
      WHERE ea.adjusted_at >= ? AND ea.adjusted_at <= ?
      ORDER BY ea.user_id, ea.adjusted_at
    `, fromDate, toDate);
  }

  // -------------------- АКТИВНЫЕ КОРРЕКТИРОВКИ --------------------

  static async addActiveAdjustment(storeId, userId, amount, reason = '') {
    const db = getStoreDB(storeId);
    await db.run(
      `INSERT INTO earnings_adjustments_active (user_id, amount, reason, adjusted_at)
       VALUES (?, ?, ?, ?)`,
      userId, amount, reason, Date.now()
    );
  }

  static async getActiveAdjustmentsSum(storeId, userId, fromDate, toDate) {
    const db = getStoreDB(storeId);
    const row = await db.get(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM earnings_adjustments_active
       WHERE user_id = ? AND adjusted_at >= ? AND adjusted_at <= ?`,
      userId, fromDate, toDate
    );
    return row ? row.total : 0;
  }

  static async clearActiveAdjustments(storeId, userId) {
    const db = getStoreDB(storeId);
    await db.run('DELETE FROM earnings_adjustments_active WHERE user_id = ?', userId);
  }
}

module.exports = Earnings;