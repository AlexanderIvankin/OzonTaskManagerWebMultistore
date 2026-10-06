const { getDB } = require('../config/database');

/**
 * Управление заработком пользователей
 * - История заработка (все заказы)
 * - Активный заработок (с момента последнего расчёта)
 * - Корректировки (история и активные)
 */
class Earnings {
  // -------------------- ИСТОРИЯ ЗАРАБОТКА (навсегда) --------------------

  /**
   * Сохранить заработок за заказ в историю
   */
  static async saveHistory(userId, orderId, amount) {
    const db = getDB();
    await db.run(
      `INSERT INTO earnings_history (user_id, order_id, amount, calculated_at)
       VALUES (?, ?, ?, ?)`,
      userId, orderId, amount, Date.now()
    );
  }

  /**
   * Получить историю заработка пользователя за период (для отчётов)
   */
  static async getHistory(userId, fromDate, toDate) {
    const db = getDB();
    return db.all(
      `SELECT order_id, amount, calculated_at
       FROM earnings_history
       WHERE user_id = ? AND calculated_at >= ? AND calculated_at <= ?
       ORDER BY calculated_at`,
      userId, fromDate, toDate
    );
  }

  /**
   * Получить историю всех пользователей за период (для экспорта)
   */
  static async getAllHistoryForPeriod(fromDate, toDate) {
    const db = getDB();
    return db.all(`
      SELECT u.id, u.name, eh.order_id, eh.amount, eh.calculated_at
      FROM earnings_history eh
      JOIN users u ON eh.user_id = u.id
      WHERE eh.calculated_at >= ? AND eh.calculated_at <= ?
      ORDER BY u.id, eh.calculated_at
    `, fromDate, toDate);
  }

  /**
   * Получить сумму заработка за период (для статистики)
   */
  static async getSumHistory(userId, fromDate, toDate) {
    const db = getDB();
    const row = await db.get(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM earnings_history
       WHERE user_id = ? AND calculated_at >= ? AND calculated_at <= ?`,
      userId, fromDate, toDate
    );
    return row ? row.total : 0;
  }

  /**
* Получить историю заработка пользователя с деталями (для формирования сообщения)
*/
  /**
   * Сумма заработка, начисленного за КОНКРЕТНЫЙ заказ пользователя.
   * Используется при сторнировании заработка за отменённый / вовремя не
   * отправленный заказ: корректировка делается на -эту сумму.
   */
  static async getOrderEarningsSum(userId, orderId) {
    const db = getDB();
    const row = await db.get(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM earnings_history
       WHERE user_id = ? AND order_id = ?`,
      userId, orderId
    );
    return row ? Number(row.total) || 0 : 0;
  }

  static async getHistoryWithDetails(userId, fromDate, toDate) {
    const db = getDB();
    return db.all(
      `SELECT order_id, amount, calculated_at
     FROM earnings_history
     WHERE user_id = ? AND calculated_at >= ? AND calculated_at <= ?
     ORDER BY calculated_at`,
      userId, fromDate, toDate
    );
  }

  // -------------------- АКТИВНЫЙ ЗАРАБОТОК (до расчёта) --------------------

  /**
   * Сохранить заработок в активную таблицу (при завершении заказа)
   */
  static async saveActive(userId, orderId, amount) {
    const db = getDB();
    await db.run(
      `INSERT INTO earnings_active (user_id, order_id, amount, calculated_at)
       VALUES (?, ?, ?, ?)`,
      userId, orderId, amount, Date.now()
    );
  }

  /**
   * Получить активные заработки пользователя за период (или все)
   */
  static async getActive(userId, fromDate, toDate) {
    const db = getDB();
    return db.all(
      `SELECT order_id, amount, calculated_at
       FROM earnings_active
       WHERE user_id = ? AND calculated_at >= ? AND calculated_at <= ?
       ORDER BY calculated_at`,
      userId, fromDate, toDate
    );
  }

  /**
   * Получить сумму активного заработка пользователя за период
   */
  static async getActiveSum(userId, fromDate, toDate) {
    const db = getDB();
    const row = await db.get(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM earnings_active
       WHERE user_id = ? AND calculated_at >= ? AND calculated_at <= ?`,
      userId, fromDate, toDate
    );
    return row ? row.total : 0;
  }

  /**
   * Очистить активный заработок пользователя (после расчёта)
   */
  static async clearActive(userId) {
    const db = getDB();
    await db.run('DELETE FROM earnings_active WHERE user_id = ?', userId);
  }

  // -------------------- КОРРЕКТИРОВКИ ЗАРАБОТКА --------------------

  /**
   * Добавить корректировку в историю
   */
  static async addAdjustment(userId, amount, reason = '') {
    const db = getDB();
    await db.run(
      `INSERT INTO earnings_adjustments (user_id, amount, reason, adjusted_at)
       VALUES (?, ?, ?, ?)`,
      userId, amount, reason, Date.now()
    );
  }

  /**
   * Получить сумму корректировок за период для пользователя
   */
  static async getAdjustmentsSum(userId, fromDate, toDate) {
    const db = getDB();
    const row = await db.get(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM earnings_adjustments
       WHERE user_id = ? AND adjusted_at >= ? AND adjusted_at <= ?`,
      userId, fromDate, toDate
    );
    return row ? row.total : 0;
  }

  /**
   * Получить все корректировки за период для всех пользователей
   */
  static async getAllAdjustmentsForPeriod(fromDate, toDate) {
    const db = getDB();
    return db.all(`
      SELECT u.id, u.name, ea.amount, ea.reason, ea.adjusted_at
      FROM earnings_adjustments ea
      JOIN users u ON ea.user_id = u.id
      WHERE ea.adjusted_at >= ? AND ea.adjusted_at <= ?
      ORDER BY u.id, ea.adjusted_at
    `, fromDate, toDate);
  }

  // -------------------- АКТИВНЫЕ КОРРЕКТИРОВКИ --------------------

  /**
   * Сохранить корректировку в активную таблицу
   */
  static async addActiveAdjustment(userId, amount, reason = '') {
    const db = getDB();
    await db.run(
      `INSERT INTO earnings_adjustments_active (user_id, amount, reason, adjusted_at)
       VALUES (?, ?, ?, ?)`,
      userId, amount, reason, Date.now()
    );
  }

  /**
   * Получить сумму активных корректировок для пользователя
   */
  static async getActiveAdjustmentsSum(userId, fromDate, toDate) {
    const db = getDB();
    const row = await db.get(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM earnings_adjustments_active
       WHERE user_id = ? AND adjusted_at >= ? AND adjusted_at <= ?`,
      userId, fromDate, toDate
    );
    return row ? row.total : 0;
  }

  /**
   * Очистить активные корректировки для пользователя (после расчёта)
   */
  static async clearActiveAdjustments(userId) {
    const db = getDB();
    await db.run('DELETE FROM earnings_adjustments_active WHERE user_id = ?', userId);
  }
}

module.exports = Earnings;