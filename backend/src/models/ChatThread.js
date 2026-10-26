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
   * Получить тред пользователя или создать новый.
   * @param {number} userId
   * @param {{ withStatus?: boolean }} [opts]
   * @returns {Promise<object|{thread: object, created: boolean}>}
   *   По умолчанию — thread (как раньше).
   *   С withStatus:true — { thread, created } (created=true, если INSERT
   *   реально вставил запись — тред только что создан).
   */
  static async ensureForUser(userId, { withStatus = false } = {}) {
    const db = getChatDB();
    const now = Date.now();
    const result = await db.run(
      `INSERT OR IGNORE INTO chat_threads
         (user_id, created_at, updated_at, unread_for_user, unread_for_staff, status)
       VALUES (?, ?, ?, 0, 0, 'open')`,
      userId, now, now
    );
    const thread = await this.getByUserId(userId);
    return withStatus ? { thread, created: result.changes > 0 } : thread;
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
  static async listForStaff({
    limit = 30,
    offset = 0,
    status = 'open',
    unreadOnly = false,
    excludeUserId = null,
    hideEmpty = true,
  } = {}) {
    const db = getChatDB();
    const where = [];
    const params = [];
    if (status) { where.push('t.status = ?'); params.push(status); }
    if (unreadOnly) where.push('t.unread_for_staff > 0');
    if (excludeUserId) { where.push('t.user_id != ?'); params.push(excludeUserId); }

    // Тред «пустой», если у него нет ни одного НЕ-удалённого сообщения.
    // Покрывает два кейса: (1) создан через ensureForUser, но user так и не
    // написал; (2) все сообщения soft-deleted. Такой тред в списке staff'а
    // бесполезен — ни истории, ни превью, ни действий.
    // EXISTS использует idx_chat_messages_thread (thread_id, created_at) —
    // дёшево для 30 строк на страницу.
    if (hideEmpty) {
      where.push(
        'EXISTS (SELECT 1 FROM chat_messages m ' +
        'WHERE m.thread_id = t.id AND m.deleted_at IS NULL)'
      );
    }

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

  /**
   * Авто-закрытие неактивных тредов. Закрываем ТОЛЬКО треды без непрочитанных
   * сообщений с обеих сторон — иначе скроем от staff/user то, что они ещё
   * не видели.
   *
   * @param {number} cutoffMs — timestamp, до которого updated_at считается «старым»
   * @returns {Promise<{closed: number, ids: number[]}>}
   */
  static async closeInactive(cutoffMs) {
    const db = getChatDB();
    const candidates = await db.all(
      `SELECT id FROM chat_threads
       WHERE status = 'open'
         AND updated_at < ?
         AND unread_for_user = 0
         AND unread_for_staff = 0`,
      cutoffMs
    );
    if (!candidates.length) return { closed: 0, ids: [] };
    const ids = candidates.map((r) => r.id);
    const ph = ids.map(() => '?').join(',');
    await db.run(
      `UPDATE chat_threads SET status = 'closed' WHERE id IN (${ph})`,
      ...ids
    );
    return { closed: ids.length, ids };
  }

  /**
 * Пересчитать last_message_preview/author по последнему НЕудалённому
 * сообщению. Вызывать после soft-delete.
 */
  static async refreshPreview(threadId) {
    const db = getChatDB();
    const last = await db.get(
      `SELECT body, author_role, created_at
     FROM chat_messages
     WHERE thread_id = ? AND deleted_at IS NULL
     ORDER BY id DESC
     LIMIT 1`,
      threadId
    );
    const preview = last
      ? (String(last.body || '').replace(/\s+/g, ' ').trim().slice(0, 100) || null)
      : null;
    const author = last
      ? (last.author_role === 'user' ? 'user' : 'staff')
      : null;
    await db.run(
      `UPDATE chat_threads
     SET last_message_preview = ?,
         last_message_author = ?,
         updated_at = CASE WHEN ? IS NULL THEN updated_at ELSE ? END
     WHERE id = ?`,
      preview, author, last, last ? last.created_at : null, threadId
    );
  }
}

module.exports = ChatThread;