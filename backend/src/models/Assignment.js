const { getStoreDB } = require('../config/database');

/**
 * Назначения заказов (store-N.db).
 *
 * Все методы принимают storeId первым аргументом.
 * JOIN с users делается через схему 'usersdb' (ATTACH users.db).
 */
class Assignment {
  /**
   * Назначить заказ сотруднику.
   * UPSERT сохраняет earnings_revoked_at — защита от двойного списания.
   */
  static async assign(storeId, orderId, userId) {
    const db = getStoreDB(storeId);
    await db.run(
      `INSERT INTO assignments (order_id, user_id, assigned_at, status)
       VALUES (?, ?, ?, 'assigned')
       ON CONFLICT(order_id) DO UPDATE SET
         user_id = excluded.user_id,
         assigned_at = excluded.assigned_at,
         status = excluded.status`,
      orderId, userId, Date.now()
    );
  }

  /**
   * Завершить заказ + сохранить «слепок» (order_amount, offer_ids, products_json).
   */
  static async complete(storeId, orderId, { orderAmount = null, products = null } = {}) {
    const db = getStoreDB(storeId);
    const list = Array.isArray(products) ? products : null;

    const offerIds = list
      ? Array.from(
        new Set(
          list.map((p) => String(p.offer_id || '').trim()).filter(Boolean)
        )
      ).join(' ')
      : null;

    const productsJson = list
      ? JSON.stringify(
        list.map((p) => ({
          offer_id: p.offer_id || null,
          name: p.name || null,
          quantity: p.quantity || 1,
        }))
      )
      : null;

    await db.run(
      `UPDATE assignments
       SET status = 'completed', completed_at = ?,
           order_amount = ?, offer_ids = ?, products_json = ?
       WHERE order_id = ? AND status = 'assigned'`,
      Date.now(),
      orderAmount === undefined ? null : orderAmount,
      offerIds,
      productsJson,
      orderId
    );
  }

  /**
   * АТОМАРНО «забронировать» отмену заработка (идемпотентность).
   */
  static async claimEarningsRevocation(storeId, orderId, userId, amount, reason = null) {
    const db = getStoreDB(storeId);
    const result = await db.run(
      `UPDATE assignments
       SET earnings_revoked_at = ?, earnings_revoked_amount = ?, earnings_revoke_reason = ?
       WHERE order_id = ? AND user_id = ? AND earnings_revoked_at IS NULL`,
      Date.now(), amount, reason, orderId, userId
    );
    return result.changes === 1;
  }

  static async cancel(storeId, orderId, userId) {
    const db = getStoreDB(storeId);
    const assignment = await db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND user_id = ? AND status = "assigned"',
      orderId, userId
    );
    if (!assignment) throw new Error('Order not found or already completed');
    await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);
  }

  static async autoCancel(storeId, orderId) {
    const db = getStoreDB(storeId);
    await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);
  }

  static async getActiveOrders(storeId, userId) {
    const db = getStoreDB(storeId);
    return db.all(
      `SELECT order_id, assigned_at FROM assignments
       WHERE user_id = ? AND status = "assigned"
       ORDER BY assigned_at`,
      userId
    );
  }

  static async getActiveOrdersCount(storeId, userId) {
    const db = getStoreDB(storeId);
    const row = await db.get(
      `SELECT COUNT(*) as count FROM assignments
       WHERE user_id = ? AND status = "assigned"`,
      userId
    );
    return row ? row.count : 0;
  }

  static async isAssignedToUser(storeId, orderId, userId) {
    const db = getStoreDB(storeId);
    const row = await db.get(
      `SELECT 1 FROM assignments
       WHERE order_id = ? AND user_id = ? AND status = "assigned"`,
      orderId, userId
    );
    return !!row;
  }

  /**
   * Все активные назначения магазина.
   * user_name тянем из usersdb.users через ATTACH.
   */
  static async getAllActive(storeId) {
    const db = getStoreDB(storeId);
    return db.all(
      `SELECT a.order_id, a.user_id, u.name AS user_name, a.assigned_at
       FROM assignments a
       LEFT JOIN usersdb.users u ON u.id = a.user_id
       WHERE a.status = 'assigned'
       ORDER BY a.assigned_at`
    );
  }

  static async getByOrderId(storeId, orderId) {
    const db = getStoreDB(storeId);
    return db.get('SELECT * FROM assignments WHERE order_id = ?', orderId);
  }

  static async getCompletedOrders(storeId, userId) {
    const db = getStoreDB(storeId);
    return db.all(
      `SELECT order_id, completed_at FROM assignments
       WHERE user_id = ? AND status = "completed"`,
      userId
    );
  }

  /**
   * Завершённые заказы с фильтрами и пагинацией.
   * JOIN с usersdb.users для user_name.
   */
  static async getCompletedOrdersPaged(storeId, {
    userId = null,
    days = null,
    limit = 25,
    offset = 0,
    orderId = null,
    offerId = null,
  } = {}) {
    const db = getStoreDB(storeId);

    const where = ["a.status = 'completed'"];
    const params = [];

    if (userId) { where.push('a.user_id = ?'); params.push(userId); }
    if (days) {
      where.push('a.completed_at >= ?');
      params.push(Date.now() - days * 24 * 60 * 60 * 1000);
    }
    if (orderId) {
      where.push("a.order_id LIKE ? ESCAPE '\\'");
      params.push(`%${String(orderId).replace(/[\\%_]/g, '\\$&')}%`);
    }
    if (offerId) {
      where.push("a.offer_ids LIKE ? ESCAPE '\\'");
      params.push(`%${String(offerId).replace(/[\\%_]/g, '\\$&')}%`);
    }
    const whereSql = where.join(' AND ');

    const totalRow = await db.get(
      `SELECT COUNT(*) AS count FROM assignments a WHERE ${whereSql}`,
      ...params
    );
    const total = totalRow ? totalRow.count : 0;

    let sql = `
      SELECT a.order_id, a.completed_at, a.user_id, u.name AS user_name,
             a.order_amount, a.offer_ids, a.products_json,
        (SELECT COALESCE(SUM(amount), 0)
           FROM earnings_history eh
          WHERE eh.order_id = a.order_id AND eh.user_id = a.user_id) AS amount
      FROM assignments a
      LEFT JOIN usersdb.users u ON u.id = a.user_id
      WHERE ${whereSql}
      ORDER BY a.completed_at DESC
    `;
    if (limit !== 'all') {
      sql += ' LIMIT ? OFFSET ?';
      params.push(limit, offset);
    }
    const rows = await db.all(sql, ...params);

    const items = rows.map((row) => {
      let products = null;
      if (row.products_json) {
        try { products = JSON.parse(row.products_json); } catch { products = null; }
      }
      return {
        order_id: row.order_id,
        completed_at: row.completed_at,
        user_id: row.user_id,
        user_name: row.user_name,
        order_amount:
          row.order_amount === null || row.order_amount === undefined
            ? null
            : Number(row.order_amount),
        amount: Number(row.amount) || 0,
        offer_ids: row.offer_ids || null,
        products,
      };
    });

    return {
      items,
      total,
      hasMore: limit === 'all' ? false : offset + items.length < total,
    };
  }
}

module.exports = Assignment;