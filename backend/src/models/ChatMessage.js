// src/models/ChatMessage.js
//
// Сообщения чата. Создание атомарно обновляет тред (last_message,
// updated_at, unread-счётчик) — одна транзакция, чтобы не было рассинхрона
// «сообщение есть, а в списке тредов его нет».
//
// author_role фиксируется в момент отправки. Если модератор потом станет
// админом, старые сообщения сохранят 'moderator' — правильно для аудита.
//
// softDelete: на будущее (пользователь удалил своё сообщение). Сейчас не
// используется в API — удаляется весь тред целиком (приватность).

const { getChatDB } = require('../config/chatDatabase');

// Максимальный превью в списке тредов: 100 символов — достаточно, чтобы
// понять контекст, не раздуваем запись.
const PREVIEW_MAX = 100;

function makePreview(body) {
  const s = String(body || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX - 1)}…` : s;
}

class ChatMessage {
  /**
   * Создать сообщение И обновить тред (атомарно).
   *
   * @param {object} data
   *   threadId    — id треда
   *   authorId    — user id автора
   *   authorRole  — 'user' | 'moderator' | 'admin' | 'god' (на момент отправки)
   *   body        — текст (может быть '' если только вложение — пока не используется)
   *   storeId     — контекст ('1'..'3' или null)
   *   replyToId   — id цитируемого сообщения (nullable)
   * @returns {Promise<object>} созданное сообщение
   */
  static async create({ threadId, authorId, authorRole, body, storeId = null, replyToId = null, replyQuoteText = null, }) {
    const db = getChatDB();
    const now = Date.now();
    const isStaffMessage = authorRole !== 'user';

    // BEGIN IMMEDIATE — блокируем на запись сразу, чтобы инкременты unread
    // и updated_at не пересеклись с параллельным insert'ом.
    await db.run('BEGIN IMMEDIATE');
    try {
      const result = await db.run(
        `INSERT INTO chat_messages
           (thread_id, author_id, author_role, body, store_id, reply_to_id, reply_quote_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        threadId,
        authorId,
        authorRole,
        String(body || ''),
        storeId != null && storeId !== '' ? String(storeId) : null,
        replyToId || null,
        replyQuoteText ? String(replyQuoteText) : null,
        now
      );
      const messageId = result.lastID;

      // Превью и обновление треда.
      // Пришло сообщение ОТ ПЕРСОНАЛА → увеличиваем unread_for_user.
      // Пришло сообщение ОТ ПОЛЬЗОВАТЕЛЯ → увеличиваем unread_for_staff.
      const unreadCol = isStaffMessage ? 'unread_for_user' : 'unread_for_staff';
      const lastAuthor = isStaffMessage ? 'staff' : 'user';
      await db.run(
        `UPDATE chat_threads
         SET updated_at = ?,
             last_message_preview = ?,
             last_message_author = ?,
             status = CASE WHEN status = 'closed' THEN 'open' ELSE status END,
             ${unreadCol} = ${unreadCol} + 1
         WHERE id = ?`,
        now,
        makePreview(body),
        lastAuthor,
        threadId
      );

      await db.run('COMMIT');
      return this.getByIdWithReply(messageId);
    } catch (err) {
      try { await db.run('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Сообщения треда, старые сверху (ASC). Пагинация «назад во времени»:
   * @param {object} opts
   * @param {number} [opts.beforeId=null] — вернуть сообщения с id < beforeId
   * @param {number} [opts.limit=50]
   */
  static async listByThread(threadId, { beforeId = null, limit = 50 } = {}) {
    const db = getChatDB();
    const where = ['m.thread_id = ?'];
    const params = [threadId];
    if (beforeId) {
      where.push('m.id < ?');
      params.push(beforeId);
    }

    // ORDER BY DESC → берём «хвост» (свежие), потом reverse → ASC для фронта.
    const rows = await db.all(
      `SELECT m.*,
              u.username       AS author_username,
              u.name           AS author_name,
              u.display_name   AS author_display_name,
              r.body           AS reply_body,
              r.author_id      AS reply_author_id,
              r.author_role    AS reply_author_role,
              r.deleted_at     AS reply_deleted_at,
              ru.username      AS reply_author_username,
              ru.name          AS reply_author_name,
              ru.display_name  AS reply_author_display_name
       FROM chat_messages m
       LEFT JOIN usersdb.users u ON u.id = m.author_id
       LEFT JOIN chat_messages r ON r.id = m.reply_to_id
       LEFT JOIN usersdb.users ru ON ru.id = r.author_id
       WHERE ${where.join(' AND ')}
       ORDER BY m.id DESC
       LIMIT ?`,
      ...params, limit
    );
    return rows.reverse();
  }

  static async getById(messageId) {
    const db = getChatDB();
    return db.get('SELECT * FROM chat_messages WHERE id = ?', messageId);
  }

  /**
 * Полное сообщение + данные цитируемого (для DTO и socket payload).
 * Возвращает ту же форму, что listByThread.
 */
  static async getByIdWithReply(messageId) {
    const db = getChatDB();
    return db.get(
      `SELECT m.*,
              u.username       AS author_username,
              u.name           AS author_name,
              u.display_name   AS author_display_name,
              r.body           AS reply_body,
              r.author_id      AS reply_author_id,
              r.author_role    AS reply_author_role,
              r.deleted_at     AS reply_deleted_at,
              ru.username      AS reply_author_username,
              ru.name          AS reply_author_name,
              ru.display_name  AS reply_author_display_name
       FROM chat_messages m
       LEFT JOIN usersdb.users u ON u.id = m.author_id
       LEFT JOIN chat_messages r ON r.id = m.reply_to_id
       LEFT JOIN usersdb.users ru ON ru.id = r.author_id
       WHERE m.id = ?`,
      messageId
    );
  }

  static async deleteByThread(threadId) {
    const db = getChatDB();
    const res = await db.run(
      'DELETE FROM chat_messages WHERE thread_id = ?',
      threadId
    );
    return res.changes || 0;
  }

  /**
   * Мягкое удаление своего сообщения (задел на будущее, пока не используется).
   */
  static async softDelete(messageId) {
    const db = getChatDB();
    const msg = await db.get(
      `SELECT m.id, m.thread_id, m.deleted_at, t.user_id AS owner_id
     FROM chat_messages m
     INNER JOIN chat_threads t ON t.id = m.thread_id
     WHERE m.id = ?`,
      messageId
    );
    if (!msg) return null;
    if (msg.deleted_at != null) {
      return { alreadyDeleted: true, threadId: msg.thread_id, ownerId: msg.owner_id, messageId };
    }
    await db.run(
      'UPDATE chat_messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
      Date.now(), messageId
    );
    return { threadId: msg.thread_id, ownerId: msg.owner_id, messageId, alreadyDeleted: false };
  }
}

module.exports = ChatMessage;