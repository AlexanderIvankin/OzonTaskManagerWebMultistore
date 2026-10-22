// src/services/ChatService.js
//
// Бизнес-логика чата поддержки.
//
// МОДЕЛЬ ДОСТУПА:
//   • Пользователь — видит/пишет только в СВОЙ тред.
//   • «Staff чата» — god глобально, ИЛИ moderator/admin в ЛЮБОМ магазине
//     (is_fired=0). Видят ВСЕ треды всех пользователей (сквозная поддержка).
//     Роль для author_role: god > admin > moderator (по приоритету).
//
// ГДЕ ЖИВЁТ:
//   ChatService не знает про Express / Socket.IO. Возвращает чистые данные.
//   Socket-нотификации добавляются в контроллере (этап 2), сервис отдаёт
//   готовые payload-объекты для emit.
//
// ПРИВАТНОСТЬ:
//   deleteThread удаляет тред + сообщения + вложения (каскадно в БД).
//   Файлы на диске чистит ChatAttachment/сервис отдельно (этап 5).
//   Audit-событие в notifications.db — без содержимого переписки.

const { getUsersDB } = require('../config/database');
const stores = require('../config/stores');
const { ChatThread, ChatMessage, ChatAttachment } = require('../models');

// Максимум сообщений в минуту от одного пользователя (анти-спам).
const RATE_LIMIT_PER_MIN = 20;
// Минимальный интервал между сообщениями одного автора, мс.
const RATE_LIMIT_MIN_INTERVAL_MS = 1500;

// rateLimitStore: Map<userId, number[]> — timestamps последних сообщений.
const rateLimitStore = new Map();

function pruneRateLimit(now) {
  for (const [userId, stamps] of rateLimitStore) {
    const fresh = stamps.filter((t) => now - t < 60_000);
    if (fresh.length) rateLimitStore.set(userId, fresh);
    else rateLimitStore.delete(userId);
  }
}

/**
 * Кто такой пользователь в контексте чата.
 * Отдельно от req.user.role (это роль в текущем магазине) — здесь нужна
 * ГЛОБАЛЬНАЯ staff-роль (модератор любого магазина).
 *
 * @param {number} userId
 * @returns {Promise<{ isStaff: boolean, staffRole: string|null, displayName: string, username: string }>}
 */
async function resolveChatIdentity(userId) {
  const db = getUsersDB();
  const row = await db.get(
    `SELECT
        u.id, u.username, u.name, u.display_name, u.role AS global_role,
        (SELECT us.role FROM user_stores us
          WHERE us.user_id = u.id AND us.is_fired = 0
            AND us.role IN ('moderator', 'admin')
          ORDER BY CASE us.role WHEN 'admin' THEN 1 ELSE 2 END
          LIMIT 1) AS best_store_role
     FROM users u
     WHERE u.id = ?`,
    userId
  );
  if (!row) {
    return { isStaff: false, staffRole: null, displayName: '', username: '' };
  }

  const displayName =
    row.display_name || row.name || row.username || `user#${row.id}`;

  if (row.global_role === 'god') {
    return { isStaff: true, staffRole: 'god', displayName, username: row.username };
  }
  if (row.best_store_role === 'admin') {
    return { isStaff: true, staffRole: 'admin', displayName, username: row.username };
  }
  if (row.best_store_role === 'moderator') {
    return { isStaff: true, staffRole: 'moderator', displayName, username: row.username };
  }
  return { isStaff: false, staffRole: null, displayName, username: row.username };
}

class ChatService {
  /** Публичный хелпер для контроллера/роутов. */
  static resolveChatIdentity = resolveChatIdentity;

  // =========================================================================
  // ТРЕД
  // =========================================================================

  /**
   * Тред текущего пользователя (создаёт при первом обращении).
   * @returns {Promise<{ thread: object, unreadForUser: number }>}
   */
  static async getOrCreateMyThread(userId) {
    const thread = await ChatThread.ensureForUser(userId);
    return {
      thread: this._threadDto(thread),
      unreadForUser: thread.unread_for_user || 0,
    };
  }

  /**
   * Список тредов для staff. Пагинация + сортировка по updated_at.
   */
  static async listStaffThreads({ limit = 30, offset = 0, unreadOnly = false, excludeUserId = null } = {}) {
    const { items, total, hasMore } = await ChatThread.listForStaff({
      limit, offset, status: 'open', unreadOnly, excludeUserId,
    });
    return { items: items.map((t) => this._staffThreadDto(t)), total, hasMore };
  }

  /**
   * Сообщения треда + данные треда.
   * Проверка прав:
   *   • user — только свой тред (thread.user_id === userId);
   *   • staff — любой.
   */
  static async getThreadMessages(threadId, { userId, isStaff, beforeId = null, limit = 50 }) {
    const thread = await ChatThread.getById(threadId);
    if (!thread) {
      const err = new Error('Тред не найден');
      err.status = 404;
      throw err;
    }
    if (!isStaff && thread.user_id !== userId) {
      const err = new Error('Нет доступа к этому треду');
      err.status = 403;
      throw err;
    }

    const messages = await ChatMessage.listByThread(threadId, { beforeId, limit });

    // Вложения (пока пусто, но задел под этап 5)
    const attachmentsMap = await ChatAttachment.listByMessageIds(
      messages.map((m) => m.id)
    );

    return {
      thread: this._threadDto(thread),
      messages: messages.map((m) => this._messageDto(m, attachmentsMap.get(m.id) || [])),
    };
  }

  // =========================================================================
  // ОТПРАВКА СООБЩЕНИЯ
  // =========================================================================

  /**
   * Отправить сообщение. Определяет автора (user/staff), роли и контекст.
   *
   * @param {object} data
   *   userId      — id отправителя
   *   threadId    — id треда (для staff — любой, для user — свой)
   *   body        — текст (может быть '' если только вложение — пока не используется)
   *   storeId     — контекст ('1'..'3' | null)
   *   replyToId   — id цитируемого сообщения (nullable)
   * @returns {Promise<{
   *   message: object,
   *   threadId: number,
   *   authorRole: string,
   *   targetUnread: 'user'|'staff'|null,
   *   payloadForTarget: object,
   * }>}
   */
  static async sendMessage({ userId, threadId, body, storeId = null, replyToId = null, quotedText = null, attachmentIds = [] }) {
    const trimmedBody = String(body || '').trim();
    const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;

    // Пустое сообщение разрешено ТОЛЬКО если есть вложения
    if (!trimmedBody && !hasAttachments) {
      const err = new Error('Сообщение пустое');
      err.status = 400;
      throw err;
    }
    if (trimmedBody.length > 4000) {
      const err = new Error('Сообщение длиннее 4000 символов');
      err.status = 400;
      throw err;
    }
    if (hasAttachments && attachmentIds.length > 3) {
      const err = new Error('Максимум 3 вложения на сообщение');
      err.status = 400;
      throw err;
    }

    // rate-limit — без изменений
    const now = Date.now();
    pruneRateLimit(now);
    const stamps = rateLimitStore.get(userId) || [];
    const recent = stamps.filter((t) => now - t < 60_000);
    if (recent.length >= RATE_LIMIT_PER_MIN) {
      const err = new Error('Слишком много сообщений, попробуйте позже');
      err.status = 429;
      throw err;
    }
    const lastStamp = recent[recent.length - 1];
    if (lastStamp && now - lastStamp < RATE_LIMIT_MIN_INTERVAL_MS) {
      const waitMs = RATE_LIMIT_MIN_INTERVAL_MS - (now - lastStamp);
      const err = new Error(`Подождите ${Math.ceil(waitMs / 1000)} сек.`);
      err.status = 429;
      throw err;
    }

    const identity = await resolveChatIdentity(userId);
    const authorRole = identity.isStaff ? (identity.staffRole || 'moderator') : 'user';

    let thread = await ChatThread.getById(threadId);
    if (!thread) {
      if (!identity.isStaff) thread = await ChatThread.ensureForUser(userId);
      else { const err = new Error('Тред не найден'); err.status = 404; throw err; }
    }
    if (!identity.isStaff && thread.user_id !== userId) {
      const err = new Error('Нет доступа к этому треду');
      err.status = 403;
      throw err;
    }

    // Валидация replyToId + quotedText
    let effectiveReplyToId = replyToId || null;
    let effectiveQuotedText = null;
    if (effectiveReplyToId) {
      const replyMsg = await ChatMessage.getById(effectiveReplyToId);
      if (!replyMsg || replyMsg.thread_id !== thread.id) {
        effectiveReplyToId = null;
      } else if (quotedText) {
        const trimmed = String(quotedText).trim();
        if (trimmed.length > 0 && trimmed.length <= 500) {
          effectiveQuotedText = trimmed;
        }
      }
    }

    const message = await ChatMessage.create({
      threadId: thread.id,
      authorId: userId,
      authorRole,
      body: trimmedBody,
      storeId,
      replyToId: effectiveReplyToId,
      replyQuoteText: effectiveQuotedText,
    });

    // Привязка вложений (атомарно с точки зрения пользователя: если что-то
    // не так — бросаем 400/403, сообщение уже создано, но пустое — это ОК,
    // фронт откатит UI. Альтернатива — транзакция, но SQLite + наш паттерн
    // (BEGIN IMMEDIATE в ChatMessage.create) усложнит связку с файлами на диске).
    if (hasAttachments) {
      await ChatAttachment.attachToMessage({
        attachmentIds,
        messageId: message.id,
        threadId: thread.id,
        uploaderId: userId,
      });
    }

    // Готовим DTO с вложениями
    const attachmentsMap = await ChatAttachment.listByMessageIds([message.id]);
    const attachments = attachmentsMap.get(message.id) || [];

    const targetUnread = identity.isStaff ? 'user' : 'staff';
    recent.push(now);
    rateLimitStore.set(userId, recent);

    const messageDto = this._messageDto(message, attachments);

    return {
      message: messageDto,
      threadId: thread.id,
      authorRole,
      targetUnread,
      payloadForTarget: {
        threadId: thread.id,
        userId: thread.user_id,
        authorId: userId,
        authorRole,
        authorName: identity.displayName,
        body: message.body,
        preview: message.body
          ? (trimmedBody.length > 100 ? trimmedBody.slice(0, 99) + '…' : trimmedBody)
          : (attachments.length ? `📎 ${attachments.length} вложение` : ''),
        messageId: message.id,
        createdAt: message.created_at,
        storeId: messageDto.storeId,
        storeName: messageDto.storeName,
        replyTo: messageDto.replyTo,
        attachments: messageDto.attachments,
      },
    };
  }

  // =========================================================================
  // ПРОЧИТАНО / НЕПРОЧИТАНО
  // =========================================================================

  /**
   * Отметить тред прочитанным. Для user — обнуляет unread_for_user в своём
   * треде; для staff — unread_for_staff в указанном (или всех, если threadId
   * не передан — «прочитать всё» на дашборде staff).
   */
  static async markRead({ userId, isStaff, threadId = null }) {
    if (!threadId) {
      if (!isStaff) {
        const err = new Error('threadId обязателен');
        err.status = 400;
        throw err;
      }
      // staff — все треды
      const db = await require('../config/chatDatabase').getChatDB();
      const maxRow = await db.get(
        'SELECT MAX(id) AS maxId FROM chat_messages WHERE thread_id IN (SELECT id FROM chat_threads WHERE status = ?)',
        'open'
      );
      await db.run("UPDATE chat_threads SET unread_for_staff = 0 WHERE status = 'open'");
      await db.run(
        `UPDATE chat_threads
         SET staff_last_read_message_id = (
           SELECT COALESCE(MAX(id), 0) FROM chat_messages cm WHERE cm.thread_id = chat_threads.id
         )
         WHERE status = 'open'`
      );
      return { ok: true, scope: 'all-staff' };
    }

    const thread = await ChatThread.getById(threadId);
    if (!thread) {
      const err = new Error('Тред не найден');
      err.status = 404;
      throw err;
    }
    if (!isStaff && thread.user_id !== userId) {
      const err = new Error('Нет доступа к этому треду');
      err.status = 403;
      throw err;
    }

    // Максимум id в треде — это и есть «последнее прочитанное».
    const db = require('../config/chatDatabase').getChatDB();
    const row = await db.get(
      'SELECT COALESCE(MAX(id), 0) AS maxId FROM chat_messages WHERE thread_id = ?',
      threadId
    );
    const maxId = row?.maxId || 0;

    await ChatThread.clearUnread(threadId, isStaff ? 'staff' : 'user');
    await ChatThread.markLastRead(threadId, isStaff ? 'staff' : 'user', maxId);

    return {
      ok: true,
      scope: isStaff ? 'staff' : 'user',
      threadId,
      lastReadMessageId: maxId,
    };
  }

  /**
   * Счётчики для бейджа:
   *   • user — unread_for_user своего треда (0, если треда нет);
   *   • staff — сумма unread_for_staff по всем тредам + количество тредов.
   */
  static async getUnreadCounts({ userId, isStaff }) {
    if (isStaff) {
      const total = await ChatThread.staffUnreadTotal();
      const threads = await ChatThread.staffUnreadThreadsCount();
      return { isStaff: true, total, threads };
    }
    const thread = await ChatThread.getByUserId(userId);
    return {
      isStaff: false,
      total: thread ? thread.unread_for_user || 0 : 0,
      threads: thread && thread.unread_for_user > 0 ? 1 : 0,
    };
  }

  /**
 * Обёртка для планировщика: закрыть неактивные треды старше days дней.
 * Возвращает { closed, days }.
 */
  static async closeInactiveThreads(days = 30) {
    const d = Math.max(1, parseInt(days, 10) || 30);
    const cutoff = Date.now() - d * 24 * 60 * 60 * 1000;
    const result = await ChatThread.closeInactive(cutoff);
    return { closed: result.closed, days: d };
  }

  // =========================================================================
  // УДАЛЕНИЕ (приватность)
  // =========================================================================

  /**
   * Удалить тред. Только пользователь (свой) — либо god (на будущее).
   * Возвращает audit-payload.
   */
  static async deleteThread({ userId, isStaff, staffRole = null, threadId }) {
    const thread = await ChatThread.getById(threadId);
    if (!thread) {
      const err = new Error('Тред не найден');
      err.status = 404;
      throw err;
    }

    const isOwner = thread.user_id === userId;
    const isGod = staffRole === 'god';
    if (!isOwner && !isGod) {
      const err = new Error('Удалить переписку может только владелец');
      err.status = 403;
      throw err;
    }

    // Вложения — сначала соберём пути (файлы на диске удалим на этапе 5).
    const attachments = await ChatAttachment.deleteByThread(threadId).catch(() => []);
    const { deletedMessages } = await ChatThread.deleteById(threadId);

    return {
      ok: true,
      threadId,
      deletedMessages,
      deletedAttachments: attachments.length,
      deletedByUserId: userId,
      threadOwnerId: thread.user_id,
      wasOwner: isOwner,
      wasGod: isGod,
    };
  }

  static async deleteMessage({ userId, isStaff, messageId }) {
    const db = getChatDB();
    const msg = await db.get(
      `SELECT m.*, t.user_id AS thread_owner_id
     FROM chat_messages m
     INNER JOIN chat_threads t ON t.id = m.thread_id
     WHERE m.id = ?`,
      messageId
    );
    if (!msg) {
      const err = new Error('Сообщение не найдено');
      err.status = 404;
      throw err;
    }
    if (!isStaff && msg.author_id !== userId) {
      const err = new Error('Можно удалять только свои сообщения');
      err.status = 403;
      throw err;
    }
    const result = await ChatMessage.softDelete(messageId);
    if (result && !result.alreadyDeleted) {
      await ChatThread.refreshPreview(msg.thread_id);
    }
    return {
      threadId: msg.thread_id,
      threadOwnerId: msg.thread_owner_id,
      messageId,
      authorId: msg.author_id,
      alreadyDeleted: !!result?.alreadyDeleted,
    };
  }

  // =========================================================================
  // DTO (единый формат ответа)
  // =========================================================================

  static _threadDto(t) {
    return {
      id: t.id,
      userId: t.user_id,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      lastMessagePreview: t.last_message_preview,
      lastMessageAuthor: t.last_message_author,
      unreadForUser: t.unread_for_user,
      unreadForStaff: t.unread_for_staff,
      userLastReadMessageId: t.user_last_read_message_id || 0,
      staffLastReadMessageId: t.staff_last_read_message_id || 0,
      status: t.status,
    };
  }

  static _staffThreadDto(t) {
    return {
      ...this._threadDto(t),
      user: {
        id: t.user_id,
        username: t.user_username,
        // Для staff приоритет — NAME (настоящее имя из users.name), а не
        // display_name (которое user мог сам себе придумать как ник).
        // Fallback: display_name → username → user#id.
        displayName:
          t.user_name ||
          t.user_display_name ||
          t.user_username ||
          `user#${t.user_id}`,
      },
    };
  }

  static _messageDto(m, attachments) {

    // Человеческое имя магазина (STORE_NAME из .env.storeN) — для UI-подписи
    // «🏬 {name}» под сообщением. Если store_id = null (глобальный домен) или
    // магазин удалён из реестра — отдаём null, фронт покажет fallback.
    const storeName = m.store_id && stores[String(m.store_id)]
      ? stores[String(m.store_id)].name
      : null;

    return {
      id: m.id,
      threadId: m.thread_id,
      authorId: m.author_id,
      authorRole: m.author_role,
      author: {
        username: m.author_username || null,
        displayName: m.author_display_name || m.author_name || m.author_username || `user#${m.author_id}`,
      },
      body: m.deleted_at ? '' : m.body,
      storeId: m.store_id,
      storeName,
      replyToId: m.reply_to_id,
      replyTo: m.reply_to_id && m.reply_author_id != null
        ? {
          id: m.reply_to_id,
          authorId: m.reply_author_id,
          authorRole: m.reply_author_role,
          authorName:
            m.reply_author_display_name ||
            m.reply_author_name ||
            m.reply_author_username ||
            `user#${m.reply_author_id}`,
          body: m.reply_deleted_at
            ? '(сообщение удалено)'
            : (m.reply_body || ''),
          quotedText: m.reply_quote_text || null,
          deleted: !!m.reply_deleted_at,
        }
        : null,
      createdAt: m.created_at,
      editedAt: m.edited_at,
      deletedAt: m.deleted_at,
      attachments: m.deleted_at ? [] : (attachments || []).map((a) => ({
        id: a.id,
        fileName: a.file_name,
        mimeType: a.mime_type,
        fileSize: a.file_size,
        url: `/api/chat/attachments/${a.id}`,
        previewUrl: a.mime_type && a.mime_type.startsWith('image/')
          ? `/api/chat/attachments/${a.id}?inline=1`
          : null,
      })),
    };
  }
}

module.exports = ChatService;