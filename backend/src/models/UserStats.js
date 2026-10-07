const { getStoreDB } = require('../config/database');

/**
 * Статистика сотрудника в магазине (store-N.db).
 *
 * Все методы принимают `storeId` первым аргументом — единый стиль
 * со всеми store-моделями (Assignment, Earnings, ProductStat, Warehouse).
 * Соединение с БД резолвится через getStoreDB(storeId).
 */
class UserStats {
  static async incrementStats(storeId, userId, orderAmount = 0) {
    const db = getStoreDB(storeId);
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

  static async incrementCanceled(storeId, userId) {
    const db = getStoreDB(storeId);
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
        `INSERT INTO user_stats (user_id, total_orders, total_amount, canceled_orders)
         VALUES (?, 0, 0, 1)`,
        userId
      );
    }
  }

  static async getStats(storeId, userId) {
    const db = getStoreDB(storeId);
    const stats = await db.get(
      'SELECT total_orders, total_amount, canceled_orders FROM user_stats WHERE user_id = ?',
      userId
    );
    return stats || { total_orders: 0, total_amount: 0, canceled_orders: 0 };
  }

  /**
   * Статистика всех сотрудников магазина.
   * user_name берётся через ATTACH users.db (схема 'usersdb').
   */
  static async getAll(storeId) {
    const db = getStoreDB(storeId);
    return db.all(`
      SELECT
        us.user_id,
        u.name AS user_name,
        us.total_orders,
        us.total_amount,
        us.canceled_orders
      FROM user_stats us
      LEFT JOIN usersdb.users u ON u.id = us.user_id
      ORDER BY us.user_id
    `);
  }

  /**
   * Полная статистика: суммарный заработок + количество заказов.
   */
  static async getSummaryForUser(storeId, userId) {
    const db = getStoreDB(storeId);
    const stats = await this.getStats(storeId, userId);
    const earnings = await db.get(
      `SELECT
         COALESCE(SUM(amount), 0) AS total_earnings,
         COUNT(*) AS orders_count
       FROM earnings_history WHERE user_id = ?`,
      userId
    );
    return {
      ...stats,
      total_earnings: Number(earnings?.total_earnings) || 0,
      orders_count: Number(earnings?.orders_count) || 0,
    };
  }
}

module.exports = UserStats;