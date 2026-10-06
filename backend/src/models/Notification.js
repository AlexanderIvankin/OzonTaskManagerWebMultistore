const { getNotificationsDB } = require('../config/notificationsDatabase');

/**
 * Разбирает JSON-поле строки (payload/context), не падая на битых данных.
 */
function safeParse(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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

// === Сериализация пакетных (транзакционных) записей ===
// Соединение SQLite одно: если два пакета (например, два notifyStaff из
// ModelService.issueForAssignment — «модели выданы» и «модель взята у
// родителя») стартуют одновременно, второй BEGIN TRANSACTION падает с
// «cannot start a transaction within a transaction», и его оповещения
// теряются. Все пакетные записи выстраиваются в единую очередь.
let writeChain = Promise.resolve();

/**
 * Выполнить пакетную запись строго после завершения предыдущей.
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 * @template T
 */
function serializeWrite(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Экранирует спецсимволы LIKE (% _ \), чтобы поиск работал как поиск подстроки.
 */
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

class Notification {
  // =========================================================================
  // ОПОВЕЩЕНИЯ (персональные строки для каждого получателя)
  // =========================================================================

  /**
   * Найти последнее оповещение пользователя данного типа по номеру заказа.
   * Используется для проверки доступа к скачиванию отправленной этикетки
   * (type = 'label_sent'): скачать PDF может только тот сотрудник,
   * которому администратор отправлял этикетку этого заказа.
   */
  static async findLatestByTypeAndOrder(recipientId, type, orderId) {
    const db = getNotificationsDB();
    const row = await db.get(
      `SELECT * FROM notifications
       WHERE recipient_id = ? AND type = ? AND order_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      recipientId,
      type,
      orderId
    );
    return parseNotificationRow(row);
  }

  /**
   * Создать одно оповещение. Возвращает id созданной записи.
   */
  static async create({
    recipientId,
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
      `INSERT INTO notifications (recipient_id, audience, type, title, message, payload, order_id, user_name, offer_ids, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      recipientId,
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
   * Создать пакет оповещений (например, копии журнала действий всем админам/модераторам).
   * Возвращает массив id.
   */
  static async createMany(rows) {
    if (!rows.length) return [];
    // Пакетные записи — строго по очереди (см. serializeWrite), иначе
    // параллельные notifyStaff ломают транзакцию SQLite и теряют оповещения.
    return serializeWrite(() => Notification.writeMany(rows));
  }

  /**
   * Внутренний исполнитель пакетной вставки: одна транзакция на пакет.
   * Вызывать только через createMany (сериализация записи).
   */
  static async writeMany(rows) {
    const db = getNotificationsDB();
    const ids = [];

    await db.run('BEGIN TRANSACTION');
    try {
      for (const r of rows) {
        const result = await db.run(
          `INSERT INTO notifications (recipient_id, audience, type, title, message, payload, order_id, user_name, offer_ids, is_read, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          r.recipientId,
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
      try {
        await db.run('ROLLBACK');
      } catch {
        // Транзакция уже закрыта (например, BEGIN не удался) — не маскируем
        // исходную ошибку: наверх уходит именно причина сбоя пакета.
      }
      throw err;
    }
    return ids;
  }

  /**
   * Удалить ВСЕ непрочитанные оповещения данного типа (для дедупликации:
   * например, «новые заказы в очереди» должно существовать в единственном
   * экземпляре — новое отправляется вместо старого). Прочитанные записи
   * остаются в архиве. Возвращает число удалённых строк.
   */
  static async deleteUnreadByType(type, audience = 'staff') {
    const db = getNotificationsDB();
    const result = await db.run(
      `DELETE FROM notifications WHERE type = ? AND audience = ? AND is_read = 0`,
      type,
      audience
    );
    return result.changes;
  }

  /**
   * Список оповещений получателя с пагинацией.
   * @param {number} recipientId
   * @param {object} opts - audience: 'user'|'staff'|null, unreadOnly, limit, offset
   */
  static async getByRecipient(
    recipientId,
    {
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
    if (audience) {
      where.push('audience = ?');
      params.push(audience);
    }
    if (unreadOnly) {
      where.push('is_read = 0');
    }
    // Поиск по номеру заказа / имени сотрудника / артикулу offer_id
    // (подстрока, спецсимволы LIKE экранируются — ищем как обычный текст)
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
   * Количество непрочитанных оповещений получателя.
   */
  static async getUnreadCount(recipientId, { audience = null } = {}) {
    const db = getNotificationsDB();
    const where = ['recipient_id = ?', 'is_read = 0'];
    const params = [recipientId];
    if (audience) {
      where.push('audience = ?');
      params.push(audience);
    }
    const row = await db.get(
      `SELECT COUNT(*) as count FROM notifications WHERE ${where.join(' AND ')}`,
      ...params
    );
    return row ? row.count : 0;
  }

  /**
   * Отметить прочитанными конкретные оповещения получателя.
   * Возвращает число изменённых строк.
   */
  static async markRead(recipientId, ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const db = getNotificationsDB();
    const result = await db.run(
      `UPDATE notifications SET is_read = 1
       WHERE recipient_id = ? AND id IN (${placeholders(ids)})`,
      recipientId,
      ...ids
    );
    return result.changes;
  }

  /**
   * Отметить все оповещения получателя прочитанными (опционально — только одну аудиторию).
   */
  static async markAllRead(recipientId, { audience = null } = {}) {
    const db = getNotificationsDB();
    const where = ['recipient_id = ?', 'is_read = 0'];
    const params = [recipientId];
    if (audience) {
      where.push('audience = ?');
      params.push(audience);
    }
    const result = await db.run(
      `UPDATE notifications SET is_read = 1 WHERE ${where.join(' AND ')}`,
      ...params
    );
    return result.changes;
  }

  /**
   * Удалить конкретные оповещения получателя ("как в email").
   */
  static async deleteByIds(recipientId, ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const db = getNotificationsDB();
    const result = await db.run(
      `DELETE FROM notifications WHERE recipient_id = ? AND id IN (${placeholders(ids)})`,
      recipientId,
      ...ids
    );
    return result.changes;
  }

  /**
   * Удалить все ПРОЧИТАННЫЕ оповещения получателя ("очистить прочитанные").
   */
  static async deleteRead(recipientId, { audience = null } = {}) {
    const db = getNotificationsDB();
    const where = ['recipient_id = ?', 'is_read = 1'];
    const params = [recipientId];
    if (audience) {
      where.push('audience = ?');
      params.push(audience);
    }
    const result = await db.run(
      `DELETE FROM notifications WHERE ${where.join(' AND ')}`,
      ...params
    );
    return result.changes;
  }

  // =========================================================================
  // ОШИБКИ СЕРВЕРА (общий журнал)
  // =========================================================================

  /**
   * Сохранить ошибку сервера. Возвращает id созданной записи.
   */
  static async addError({ level = 'error', source = '', message, stack = null, context = null }) {
    const db = getNotificationsDB();
    const result = await db.run(
      `INSERT INTO server_errors (level, source, message, stack, context, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      level,
      source,
      message,
      stack,
      context ? JSON.stringify(context) : null,
      Date.now()
    );
    return result.lastID;
  }

  /**
   * Список ошибок сервера с пагинацией (для админов/модераторов).
   * @param {object} opts - level: 'error'|'warn'|null, unreadOnly, limit, offset
   */
  static async getErrors({
    level = null,
    unreadOnly = false,
    limit = 30,
    offset = 0,
  } = {}) {
    const db = getNotificationsDB();

    const where = [];
    const params = [];
    if (level) {
      where.push('level = ?');
      params.push(level);
    }
    if (unreadOnly) {
      where.push('is_read = 0');
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = await db.get(
      `SELECT COUNT(*) as count FROM server_errors ${whereSql}`,
      ...params
    );
    const items = await db.all(
      `SELECT * FROM server_errors ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset
    );

    const total = totalRow ? totalRow.count : 0;
    return {
      items: items.map(parseErrorRow),
      total,
      hasMore: offset + items.length < total,
    };
  }

  /**
   * Количество ошибок сервера (опционально по уровню).
   */
  static async countErrors({ level = null } = {}) {
    const db = getNotificationsDB();
    const where = [];
    const params = [];
    if (level) {
      where.push('level = ?');
      params.push(level);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const row = await db.get(
      `SELECT COUNT(*) as count FROM server_errors ${whereSql}`,
      ...params
    );
    return row ? row.count : 0;
  }

  /**
   * Удалить выбранные ошибки сервера.
   */
  static async deleteErrorsByIds(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const db = getNotificationsDB();
    const result = await db.run(
      `DELETE FROM server_errors WHERE id IN (${placeholders(ids)})`,
      ...ids
    );
    return result.changes;
  }

  /**
   * Отметить выбранные ошибки сервера прочитанными.
   * @param {number[]} ids
   * @returns {Promise<number>} число изменённых строк.
   */
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

  /**
   * Отметить ВСЕ ошибки сервера прочитанными.
   * @returns {Promise<number>} число изменённых строк.
   */
  static async markAllErrorsRead() {
    const db = getNotificationsDB();
    const result = await db.run(
      'UPDATE server_errors SET is_read = 1 WHERE is_read = 0'
    );
    return result.changes;
  }

  /**
   * Количество непрочитанных ошибок сервера (опционально по уровню).
   */
  static async getUnreadErrorsCount({ level = null } = {}) {
    const db = getNotificationsDB();
    const where = ['is_read = 0'];
    const params = [];
    if (level) {
      where.push('level = ?');
      params.push(level);
    }
    const row = await db.get(
      `SELECT COUNT(*) as count FROM server_errors WHERE ${where.join(' AND ')}`,
      ...params
    );
    return row ? row.count : 0;
  }

  /**
   * Очистить весь журнал ошибок сервера.
   */
  static async clearErrors() {
    const db = getNotificationsDB();
    const result = await db.run('DELETE FROM server_errors');
    return result.changes;
  }

  // =========================================================================
  // РЕТЕНЦИЯ (очистка старых записей)
  // =========================================================================

  /**
   * Удалить оповещения и ошибки старше указанного числа дней.
   * Вызывается планировщиком раз в сутки.
   */
  static async pruneOld(notificationDays = 7, errorDays = 14) {
    const db = getNotificationsDB();
    const notifCutoff = Date.now() - notificationDays * 24 * 60 * 60 * 1000;
    const errorCutoff = Date.now() - errorDays * 24 * 60 * 60 * 1000;

    const notifResult = await db.run(
      'DELETE FROM notifications WHERE created_at < ?',
      notifCutoff
    );
    const errorResult = await db.run(
      'DELETE FROM server_errors WHERE created_at < ?',
      errorCutoff
    );
    return {
      notifications: notifResult.changes,
      errors: errorResult.changes,
    };
  }
}

module.exports = Notification;
