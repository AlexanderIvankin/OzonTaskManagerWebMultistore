// src/models/ChatAttachment.js
//
// Вложения к сообщениям чата (файлы/картинки).
// Схема готова, upload будет на этапе 5. Модель минимальная — только
// CRUD-заготовки, чтобы сервис и контроллер могли её использовать сразу.

const { getChatDB } = require('../config/chatDatabase');

class ChatAttachment {
  /**
   * @param {object} data
   *   messageId    — id сообщения
   *   fileName     — оригинальное имя (для скачивания)
   *   mimeType     — content-type
   *   fileSize     — размер в байтах
   *   storagePath  — относительный путь (outputs/chat/thread-N/...)
   *   previewPath  — превью для картинок (nullable)
   */
  static async create({
    messageId, fileName, mimeType, fileSize, storagePath, previewPath = null,
  }) {
    const db = getChatDB();
    const now = Date.now();
    const result = await db.run(
      `INSERT INTO chat_attachments
         (message_id, file_name, mime_type, file_size, storage_path, preview_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      messageId, fileName, mimeType, fileSize, storagePath, previewPath, now
    );
    return this.getById(result.lastID);
  }

  static async getById(id) {
    const db = getChatDB();
    return db.get('SELECT * FROM chat_attachments WHERE id = ?', id);
  }

  /**
   * Батч-выборка для списка сообщений: не N запросов, а один.
   * @param {number[]} messageIds
   * @returns {Promise<Map<number, object[]>>} — messageId -> [attachments]
   */
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

  /**
   * Удалить все вложения треда (перед DELETE треда).
   * Возвращает список storage_path — сервис удалит файлы с диска.
   */
  static async deleteByThread(threadId) {
    const db = getChatDB();
    const rows = await db.all(
      `SELECT a.id, a.storage_path, a.preview_path
       FROM chat_attachments a
       INNER JOIN chat_messages m ON m.id = a.message_id
       WHERE m.thread_id = ?`,
      threadId
    );
    await db.run(
      `DELETE FROM chat_attachments WHERE id IN (
         SELECT a.id FROM chat_attachments a
         INNER JOIN chat_messages m ON m.id = a.message_id
         WHERE m.thread_id = ?
       )`,
      threadId
    );
    return rows;
  }
}

module.exports = ChatAttachment;