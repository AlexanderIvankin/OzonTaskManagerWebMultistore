const { getNotificationsDB } = require('../config/notificationsDatabase');

function safeParse(value) { 
  if (value === null || value === undefined) return null;
  try { return JSON.parse(value); } catch { return value; }
}

function parseNotificationRow(row) {
  if (!row) return row;
  return { ...row, payload: safeParse(row.payload) };
}

function parseErrorRow(row) {
  if (!row) return row;
  return { ...row, context: safeParse(row.context) };
}

function placeholders(ids) {
  return ids.map(() => '?').join(', ');
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

// Очередь пакетных записей (см. комментарий в старом коде —
// та же защита от параллельных транзакций)
let writeChain = Promise.resolve();
function serializeWrite(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

class Notification {
  // =========================================================================
  // ОПОВЕЩЕНИЯ (персональные)
  // =========================================================================

  /**
   * Найти последнее оповещение получателя данного типа по заказу.
   * Store-scoped: ищем только в оповещениях того же магазина.
   */
  static async findLatestByTypeAndOrder(recipientId, type, orderId, storeId = null) {
    const db = getNotificationsDB();
    const where = ['recipient_id = ?', 'type = ?', 'order_id = ?'];
    const params = [recipientId, type, orderId];

    if (storeId !== null && storeId !== undefined) {
      where.push('store_id = ?');
      params.push(String(storeId));
    }

    const row = await db.get(
      `SELECT * FROM notifications
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      ...params
    );
    return parseNotificationRow(row);
  }

  /**
   * Создать одно оповещение.
   * @param {object} data
   *   • storeId — идентификатор магазина (string|number|null)
   *   • остальные — как раньше
   */
  static async create({
    recipientId,
    storeId = null,
    audience = 'user',
    type,
    title,
    message = '',
    payload = null,
    orderId = null,
    userName = null,
    offerIds = null,
    isRead = 0,
    createdAt = Date.now(),
  }) {
    const db = getNotificationsDB();
    const result = await db.run(
      `INSERT INTO notifications
         (recipient_id, store_id, audience, type, title, message,
          payload, order_id, user_name, offer_ids, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      recipientId,
      storeId === null || storeId === undefined ? null : String(storeId),
      audience,
      type,
      title,
      message,
      payload ? JSON.stringify(payload) : null,
      orderId,
      userName,
      offerIds,
      isRead,
      createdAt
    );
    return result.lastID;
  }

  /**
   * Пакетная вставка (журнал действий всем админам/модераторам).
   * Каждая запись может содержать свой storeId.
   */
  static async createMany(rows) {
    if (!rows.length) return [];
    return serializeWrite(() => Notification.writeMany(rows));
  }

  static async writeMany(rows) {
    const db = getNotificationsDB();
    const ids = [];
    await db.run('BEGIN TRANSACTION');
    try {
      for (const r of rows) {
        const result = await db.run(
          `INSERT INTO notifications
             (recipient_id, store_id, audience, type, title, message,
              payload, order_id, user_name, offer_ids, is_read, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          r.recipientId,
          r.storeId === null || r.storeId === undefined ? null : String(r.storeId),
          r.audience || 'user',
          r.type,
          r.title,
          r.message || '',
          r.payload ? JSON.stringify(r.payload) : null,
          r.orderId || null,
          r.userName || null,
          r.offerIds || null,
          r.isRead || 0,
          r.createdAt || Date.now()
        );
        ids.push(result.lastID);
      }
      await db.run('COMMIT');
    } catch (err) {
      try { await db.run('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    return ids;
  }

  /**
   * Удалить непрочитанные оповещения типа (в рамках магазина).
   */
  static async deleteUnreadByType(type, audience = 'staff', storeId = null) {
    const db = getNotificationsDB();
    const where = ['type = ?', 'audience = ?', 'is_read = 0'];
    const params = [type, audience];

    if (storeId !== null && storeId !== undefined) {
      where.push('store_id = ?');
      params.push(String(storeId));
    }

    const result = await db.run(
      `DELETE FROM notifications WHERE ${where.join(' AND ')}`,
      ...params
    );
    return result.changes;
  }

  /**
   * Список оповещений получателя с пагинацией.
   * @param {object} opts
   *   • storeId     — фильтр по магазину (null = все магазины)
   *   • audience    — 'user' | 'staff' | null
   *   • unreadOnly, limit, offset
   *   • orderId, userName, offerId — подстрочный поиск
   */
  static async getByRecipient(
    recipientId,
    {
      storeId = null,
      audience = null,
      unreadOnly = false,
      limit = 30,
      offset = 0,
      orderId = null,
      userName = null,
      offerId = null,
    } = {}
  ) {
    const db = getNotificationsDB();

    const where = ['recipient_id = ?'];
    const params = [recipientId];

    if (storeId !== null && storeId !== undefined) {
      where.push('store_id = ?');
      params.push(String(storeId));
    }
    if (audience) { where.push('audience = ?'); params.push(audience); }
    if (unreadOnly) where.push('is_read = 0');
    if (orderId) {
      where.push("order_id LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(orderId)}%`);
    }
    if (userName) {
      where.push("user_name LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(userName)}%`);
    }
    if (offerId) {
      where.push("offer_ids LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(offerId)}%`);
    }
    const whereSql = where.join(' AND ');

    const totalRow = await db.get(
      `SELECT COUNT(*) as count FROM notifications WHERE ${whereSql}`,
      ...params
    );
    const items = await db.all(
      `SELECT * FROM notifications WHERE ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset
    );

    const total = totalRow ? totalRow.count : 0;
    return {
      items: items.map(parseNotificationRow),
      total,
      hasMore: offset + items.length < total,
    };
  }

  /**
   * Количество непрочитанных (в рамках магазина).
   */
  static async getUnreadCount(recipientId, { audience = null, storeId = null } = {}) {
    const db = getNotificationsDB();
    const where = ['recipient_id = ?', 'is_read = 0'];
    const params = [recipientId];
    if (audience) { where.push('audience = ?'); params.push(audience); }
    if (storeId !== null && storeId !== undefined) {
      where.push('store_id = ?');
      params.push(String(storeId));
    }
    const row = await db.get(
      `SELECT COUNT(*) as count FROM notifications WHERE ${where.join(' AND ')}`,
      ...params
    );
    return row ? row.count : 0;
  }

  static async markRead(recipientId, ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const db = getNotificationsDB();
    const result = await db.run(
      `UPDATE notifications SET is_read = 1
       WHERE recipient_id = ? AND id IN (${placeholders(ids)})`,
      recipientId, ...ids
    );
    return result.changes;
  }

  static async markAllRead(recipientId, { audience = null, storeId = null } = {}) {
    const db = getNotificationsDB();
    const where = ['recipient_id = ?', 'is_read = 0'];
    const params = [recipientId];
    if (audience) { where.push('audience = ?'); params.push(audience); }
    if (storeId !== null && storeId !== undefined) {
      where.push('store_id = ?');
      params.push(String(storeId));
    }
    const result = await db.run(
      `UPDATE notifications SET is_read = 1 WHERE ${where.join(' AND ')}`,
      ...params
    );
    return result.changes;
  }

  static async deleteByIds(recipientId, ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const db = getNotificationsDB();
    const result = await db.run(
      `DELETE FROM notifications WHERE recipient_id = ? AND id IN (${placeholders(ids)})`,
      recipientId, ...ids
    );
    return result.changes;
  }

  static async deleteRead(recipientId, { audience = null, storeId = null } = {}) {
    const db = getNotificationsDB();
    const where = ['recipient_id = ?', 'is_read = 1'];
    const params = [recipientId];
    if (audience) { where.push('audience = ?'); params.push(audience); }
    if (storeId !== null && storeId !== undefined) {
      where.push('store_id = ?');
      params.push(String(storeId));
    }
    const result = await db.run(
      `DELETE FROM notifications WHERE ${where.join(' AND ')}`,
      ...params
    );
    return result.changes;
  }

  // =========================================================================
  // ОШИБКИ СЕРВЕРА (сквозной журнал с фильтром по store_id)
  // =========================================================================

  static async addError({
    storeId = null,
    level = 'error',
    source = '',
    message,
    stack = null,
    context = null,
  }) {
    const db = getNotificationsDB();
    const result = await db.run(
      `INSERT INTO server_errors
         (store_id, level, source, message, stack, context, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      storeId === null || storeId === undefined ? null : String(storeId),
      level, source, message, stack,
      context ? JSON.stringify(context) : null,
      Date.now()
    );
    return result.lastID;
  }

  static async getErrors({
    storeId = null,
    level = null,
    unreadOnly = false,
    limit = 30,
    offset = 0,
  } = {}) {
    const db = getNotificationsDB();
    const where = [];
    const params = [];

    if (storeId !== null && storeId !== undefined) {
      where.push('store_id = ?');
      params.push(String(storeId));
    }
    if (level) { where.push('level = ?'); params.push(level); }
    if (unreadOnly) where.push('is_read = 0');

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = await db.get(
      `SELECT COUNT(*) as count FROM server_errors ${whereSql}`,
      ...params
    );
    const items = await db.all(
      `SELECT * FROM server_errors ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );

    const total = totalRow ? totalRow.count : 0;
    return {
      items: items.map(parseErrorRow),
      total,
      hasMore: offset + items.length < total,
    };
  }

  static async countErrors({ storeId = null, level = null } = {}) {
    const db = getNotificationsDB();
    const where = [];
    const params = [];
    if (storeId !== null && storeId !== undefined) {
      where.push('store_id = ?');
      params.push(String(storeId));
    }
    if (level) { where.push('level = ?'); params.push(level); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const row = await db.get(
      `SELECT COUNT(*) as count FROM server_errors ${whereSql}`,
      ...params
    );
    return row ? row.count : 0;
  }

  static async deleteErrorsByIds(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const db = getNotificationsDB();
    const result = await db.run(
      `DELETE FROM server_errors WHERE id IN (${placeholders(ids)})`,
      ...ids
    );
    return result.changes;
  }

  static async markErrorsRead(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const db = getNotificationsDB();
    const result = await db.run(
      `UPDATE server_errors SET is_read = 1
       WHERE is_read = 0 AND id IN (${placeholders(ids)})`,
      ...ids
    );
    return result.changes;
  }

  static async markAllErrorsRead({ storeId = null } = {}) {
    const db = getNotificationsDB();
    const where = ['is_read = 0'];
    const params = [];
    if (storeId !== null && storeId !== undefined) {
      where.push('store_id = ?');
      params.push(String(storeId));
    }
    const result = await db.run(
      `UPDATE server_errors SET is_read = 1 WHERE ${where.join(' AND ')}`,
      ...params
    );
    return result.changes;
  }

  static async getUnreadErrorsCount({ storeId = null, level = null } = {}) {
    const db = getNotificationsDB();
    const where = ['is_read = 0'];
    const params = [];
    if (storeId !== null && storeId !== undefined) {
      where.push('store_id = ?');
      params.push(String(storeId));
    }
    if (level) { where.push('level = ?'); params.push(level); }
    const row = await db.get(
      `SELECT COUNT(*) as count FROM server_errors WHERE ${where.join(' AND ')}`,
      ...params
    );
    return row ? row.count : 0;
  }

  static async clearErrors({ storeId = null } = {}) {
    const db = getNotificationsDB();
    const where = [];
    const params = [];
    if (storeId !== null && storeId !== undefined) {
      where.push('store_id = ?');
      params.push(String(storeId));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await db.run(`DELETE FROM server_errors ${whereSql}`, ...params);
    return result.changes;
  }

  // =========================================================================
  // РЕТЕНЦИЯ
  // =========================================================================

  static async pruneOld(notificationDays = 7, errorDays = 14) {
    const db = getNotificationsDB();
    const notifCutoff = Date.now() - notificationDays * 24 * 60 * 60 * 1000;
    const errorCutoff = Date.now() - errorDays * 24 * 60 * 60 * 1000;

    const notifResult = await db.run(
      'DELETE FROM notifications WHERE created_at < ?', notifCutoff
    );
    const errorResult = await db.run(
      'DELETE FROM server_errors WHERE created_at < ?', errorCutoff
    );
    return {
      notifications: notifResult.changes,
      errors: errorResult.changes,
    };
  }
}

module.exports = Notification;