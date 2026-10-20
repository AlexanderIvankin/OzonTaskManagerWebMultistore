// src/models/ChatThread.js
//
// Тред поддержки. Один тред на пользователя (user_id UNIQUE).
//
// Все методы работают с chat.db (getChatDB). JOIN usersdb.users сделан
// через ATTACH (см. config/chatDatabase.js) — имя автора треда для списка
// у модераторов.
//
// unread-счётчики:
//   unread_for_user  — сколько сообщений ОТ ПЕРСОНАЛА пользователь ещё не прочитал
//   unread_for_staff — сколько сообщений ОТ ПОЛЬЗОВАТЕЛЯ персонал ещё не прочитал
// Сбрасываются при clearUnread(threadId, 'user'|'staff').
// Инкремент делается в ChatMessage.create в той же транзакции.

const { getChatDB } = require('../config/chatDatabase');

class ChatThread {
  /**
   * Получить тред пользователя или создать новый, если его нет.
   * Атомарно: INSERT OR IGNORE + SELECT — безопасно при параллельных
   * вызовах (первый POST /chat/thread от двух вкладок одновременно).
   *
   * @param {number} userId
   * @returns {Promise<object>}
   */
  static async ensureForUser(userId) {
    const db = getChatDB();
    const now = Date.now();
    await db.run(
      `INSERT OR IGNORE INTO chat_threads
         (user_id, created_at, updated_at, unread_for_user, unread_for_staff, status)
       VALUES (?, ?, ?, 0, 0, 'open')`,
      userId, now, now
    );
    return this.getByUserId(userId);
  }

  static async getById(threadId) {
    const db = getChatDB();
    return db.get('SELECT * FROM chat_threads WHERE id = ?', threadId);
  }

  static async getByUserId(userId) {
    const db = getChatDB();
    return db.get('SELECT * FROM chat_threads WHERE user_id = ?', userId);
  }

  /**
   * Список тредов для персонала — пагинация по updated_at DESC.
   * Подмешивает имя пользователя (display_name || name || username) для
   * отображения в списке.
   *
   * @param {object} opts
   * @param {number} [opts.limit=30]
   * @param {number} [opts.offset=0]
   * @param {'open'|'closed'|null} [opts.status='open']
   * @param {boolean} [opts.unreadOnly=false] — только unread_for_staff > 0
   */
  static async listForStaff({ limit = 30, offset = 0, status = 'open', unreadOnly = false } = {}) {
    const db = getChatDB();
    const where = [];
    const params = [];
    if (status) { where.push('t.status = ?'); params.push(status); }
    if (unreadOnly) where.push('t.unread_for_staff > 0');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = await db.get(
      `SELECT COUNT(*) AS count FROM chat_threads t ${whereSql}`,
      ...params
    );
    const total = totalRow ? totalRow.count : 0;

    const items = await db.all(
      `SELECT t.*,
              u.username       AS user_username,
              u.name           AS user_name,
              u.display_name   AS user_display_name
       FROM chat_threads t
       LEFT JOIN usersdb.users u ON u.id = t.user_id
       ${whereSql}
       ORDER BY t.updated_at DESC
       LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );

    return { items, total, hasMore: offset + items.length < total };
  }

  static async incUnread(threadId, target) {
    const col = target === 'staff' ? 'unread_for_staff' : 'unread_for_user';
    const db = getChatDB();
    await db.run(
      `UPDATE chat_threads SET ${col} = ${col} + 1 WHERE id = ?`,
      threadId
    );
  }

  static async clearUnread(threadId, target) {
    const col = target === 'staff' ? 'unread_for_staff' : 'unread_for_user';
    const db = getChatDB();
    await db.run(`UPDATE chat_threads SET ${col} = 0 WHERE id = ?`, threadId);
  }

  /**
 * Отметить «последнее прочитанное сообщение» для одной стороны.
 * Вызывается из ChatService.markRead вместе с clearUnread.
 *
 * @param {number} threadId
 * @param {'user'|'staff'} target
 * @param {number} messageId — id последнего сообщения в треде на момент чтения
 */
  static async markLastRead(threadId, target, messageId) {
    const col =
      target === 'staff' ? 'staff_last_read_message_id' : 'user_last_read_message_id';
    const db = getChatDB();
    await db.run(
      `UPDATE chat_threads
       SET ${col} = MAX(COALESCE(${col}, 0), ?)
       WHERE id = ?`,
      messageId || 0,
      threadId
    );
  }

  /**
   * Удалить тред. Каскадно удаляет сообщения (FOREIGN KEY ON DELETE CASCADE)
   * и вложения (FOREIGN KEY chat_attachments -> chat_messages ON DELETE CASCADE).
   * Файлы на диске чистит ChatAttachment/сервис отдельно — БД не умеет удалять
   * файлы.
   *
   * @param {number} threadId
   * @returns {Promise<{deletedMessages: number}>} — для аудита и удаления файлов
   */
  static async deleteById(threadId) {
    const db = getChatDB();
    const cntRow = await db.get(
      'SELECT COUNT(*) AS c FROM chat_messages WHERE thread_id = ?',
      threadId
    );
    const deletedMessages = cntRow ? cntRow.c : 0;
    await db.run('DELETE FROM chat_threads WHERE id = ?', threadId);
    return { deletedMessages };
  }

  /** Сводный счётчик непрочитанного для персонала (для бейджа в сайдбаре). */
  static async staffUnreadTotal() {
    const db = getChatDB();
    const row = await db.get(
      'SELECT COALESCE(SUM(unread_for_staff), 0) AS total FROM chat_threads WHERE status = ?',
      'open'
    );
    return row ? row.total : 0;
  }

  /** Количество тредов с непрочитанными сообщениями от пользователей (для бейджа). */
  static async staffUnreadThreadsCount() {
    const db = getChatDB();
    const row = await db.get(
      'SELECT COUNT(*) AS count FROM chat_threads WHERE unread_for_staff > 0 AND status = ?',
      'open'
    );
    return row ? row.count : 0;
  }
}

module.exports = ChatThread;