// Локальное хранилище вложений чата. Не S3 — там модели.
// Путь: backend/outputs/chat/thread-<threadId>/<uuid>.<ext>
// Для orphan-загрузок (message_id=NULL, threadId известен) — сразу кладём
// в папку треда: при привязке к сообщению путь уже правильный.

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../outputs/chat');

// Whitelist MIME. Всё остальное — 415.
// SVG и HTML запрещены (XSS).
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
]);

// Расширение по MIME (для storage_path).
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
};

class ChatStorageService {
  static get maxBytes() {
    const mb = parseInt(process.env.CHAT_ATTACHMENT_MAX_MB, 10) || 10;
    return mb * 1024 * 1024;
  }

  static get allowedMime() {
    return ALLOWED_MIME;
  }

  static isAllowed(mimeType) {
    return ALLOWED_MIME.has(String(mimeType || '').toLowerCase());
  }

  /**
   * Сохранить буфер в файл. Возвращает относительный storage_path
   * (относительно backend/ — чтобы бэкапы/экспорт могли его найти).
   *
   * @param {number} threadId
   * @param {string} mimeType
   * @param {Buffer} buffer
   * @returns {Promise<{ storagePath: string, absolutePath: string }>}
   */
  static async saveBuffer(threadId, mimeType, buffer) {
    const ext = EXT_BY_MIME[mimeType] || '';
    const uuid = crypto.randomUUID();
    const relDir = `outputs/chat/thread-${threadId}`;
    const absDir = path.join(ROOT, `thread-${threadId}`);

    await fs.mkdir(absDir, { recursive: true });
    const filename = `${uuid}${ext}`;
    const absPath = path.join(absDir, filename);
    await fs.writeFile(absPath, buffer);

    return {
      storagePath: `${relDir}/${filename}`,
      absolutePath: absPath,
    };
  }

  /** Абсолютный путь по относительному storage_path из БД. */
  static absolutePath(storagePath) {
    return path.resolve(__dirname, '../..', storagePath);
  }

  /** Удалить файл (тихо игнорируя отсутствие). */
  static async deleteFile(storagePath) {
    if (!storagePath) return;
    try {
      await fs.unlink(this.absolutePath(storagePath));
    } catch {
      /* файла нет — ок */
    }
  }
}

module.exports = ChatStorageService;