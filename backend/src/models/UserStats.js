const { getDB } = require('../config/database');

class UserStats {
  /**
   * Обновить статистику при завершении заказа
   */
  static async incrementStats(userId, orderAmount = 0) {
    const db = getDB();
    await db.run(
      `INSERT INTO user_stats (user_id, total_orders, total_amount, canceled_orders)
       VALUES (?, 1, ?, 0)
       ON CONFLICT(user_id) DO UPDATE SET
       total_orders = total_orders + 1,
       total_amount = total_amount + ?,
       canceled_orders = COALESCE(canceled_orders, 0)`,
      userId, orderAmount, orderAmount
    );
  }

  /**
   * Увеличить счётчик отменённых заказов (при ручной отмене)
   */
  static async incrementCanceled(userId) {
    const db = getDB();
    const existing = await db.get(
      'SELECT canceled_orders FROM user_stats WHERE user_id = ?',
      userId
    );
    if (existing) {
      await db.run(
        'UPDATE user_stats SET canceled_orders = canceled_orders + 1 WHERE user_id = ?',
        userId
      );
    } else {
      await db.run(
        'INSERT INTO user_stats (user_id, total_orders, total_amount, canceled_orders) VALUES (?, 0, 0, 1)',
        userId
      );
    }
  }

  /**
   * Получить статистику пользователя
   */
  static async getStats(userId) {
    const db = getDB();
    const stats = await db.get(
      'SELECT total_orders, total_amount, canceled_orders FROM user_stats WHERE user_id = ?',
      userId
    );
    return stats || { total_orders: 0, total_amount: 0, canceled_orders: 0 };
  }
}

module.exports = UserStats;