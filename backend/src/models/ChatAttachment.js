const { getChatDB } = require('../config/chatDatabase');

class ChatAttachment {
  /**
   * Создать ORPHAN-вложение (message_id = NULL). Привязка к сообщению
   * произойдёт позже через attachToMessage().
   */
  static async createOrphan({
    threadId, uploaderId, fileName, mimeType, fileSize, storagePath, previewPath = null,
  }) {
    const db = getChatDB();
    const now = Date.now();
    const result = await db.run(
      `INSERT INTO chat_attachments
         (message_id, thread_id, uploader_id, file_name, mime_type, file_size,
          storage_path, preview_path, created_at)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      threadId, uploaderId, fileName, mimeType, fileSize, storagePath, previewPath, now
    );
    return this.getById(result.lastID);
  }

  static async getById(id) {
    const db = getChatDB();
    return db.get('SELECT * FROM chat_attachments WHERE id = ?', id);
  }

  /**
   * Привязать orphan-вложения к сообщению. Проверяет:
   *   • вложение существует и принадлежит этому threadId;
   *   • ещё не привязано (message_id IS NULL);
   *   • загружено этим же пользователем.
   * Возвращает массив привязанных id (или бросает 400).
   */
  static async attachToMessage({ attachmentIds, messageId, threadId, uploaderId }) {
    if (!Array.isArray(attachmentIds) || !attachmentIds.length) return [];
    const db = getChatDB();
    const placeholders = attachmentIds.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT id, thread_id, uploader_id, message_id
       FROM chat_attachments WHERE id IN (${placeholders})`,
      ...attachmentIds
    );
    if (rows.length !== attachmentIds.length) {
      const err = new Error('Некоторые вложения не найдены');
      err.status = 400;
      throw err;
    }
    for (const r of rows) {
      if (r.message_id != null) {
        const err = new Error('Вложение уже привязано к другому сообщению');
        err.status = 400;
        throw err;
      }
      if (r.thread_id !== threadId) {
        const err = new Error('Вложение из другого треда');
        err.status = 400;
        throw err;
      }
      if (r.uploader_id !== uploaderId) {
        const err = new Error('Нельзя прикрепить чужое вложение');
        err.status = 403;
        throw err;
      }
    }
    await db.run(
      `UPDATE chat_attachments SET message_id = ? WHERE id IN (${placeholders})`,
      messageId, ...attachmentIds
    );
    return attachmentIds;
  }

  static async listByMessageIds(messageIds) {
    const result = new Map();
    if (!Array.isArray(messageIds) || !messageIds.length) return result;
    const db = getChatDB();
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT * FROM chat_attachments WHERE message_id IN (${placeholders}) ORDER BY id`,
      ...messageIds
    );
    for (const row of rows) {
      if (!result.has(row.message_id)) result.set(row.message_id, []);
      result.get(row.message_id).push(row);
    }
    return result;
  }

  static async deleteByThread(threadId) {
    const db = getChatDB();
    const rows = await db.all(
      `SELECT id, storage_path, preview_path FROM chat_attachments WHERE thread_id = ?`,
      threadId
    );
    await db.run('DELETE FROM chat_attachments WHERE thread_id = ?', threadId);
    return rows;
  }

  /** Cleanup: удалить orphan'ы старше N мс. Возвращает массив storage_path. */
  static async deleteOrphansOlderThan(olderThanMs) {
    const db = getChatDB();
    const cutoff = Date.now() - olderThanMs;
    const rows = await db.all(
      `SELECT id, storage_path FROM chat_attachments
       WHERE message_id IS NULL AND created_at < ?`,
      cutoff
    );
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    await db.run(`DELETE FROM chat_attachments WHERE id IN (${placeholders})`, ...ids);
    return rows.map((r) => r.storage_path);
  }
}

module.exports = ChatAttachment;