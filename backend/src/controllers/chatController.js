// HTTP-обёртка вокруг ChatService + live-emit через socket.js.
// Все эндпоинты требуют authenticate. Проверка «staff чата» делается
// внутри ChatService.resolveChatIdentity (глобальная роль, не per-store).
//
// Live-события (этап 2, подключён):
//   • chat_message_new    — user→staff (комната 'chat:staff')
//                           staff→user (комната 'chat:user_<ownerId>')
//   • chat_thread_deleted — staff всегда; user — только если удалил не он
//
// Web Push для офлайн-адресата — этап 3 (пока только emit, без push).

const multer = require('multer');
const ChatStorageService = require('../services/ChatStorageService');
const { ChatAttachment, ChatThread } = require('../models');
const ChatService = require('../services/ChatService');
const NotificationService = require('../services/NotificationService');
const { notifyChatStaff, notifyChatUser } = require('../socket');

// multer: memory storage — файл сам пишем через ChatStorageService
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ChatStorageService.maxBytes, files: 1 },
});

// Экспортируем middleware, чтобы routes/chat.js навесил его на upload-эндпоинт
exports.uploadMiddleware = upload.single('file');

exports.getMyThread = async (req, res, next) => {
  try {
    const identity = await ChatService.resolveChatIdentity(req.user.id);
    // Staff не имеет своего треда поддержки — он сам поддержка.
    // Не вызываем getOrCreateMyThread, чтобы не плодить «диалоги с собой»
    // в общем списке у всех модераторов.
    if (identity.isStaff) {
      return res.json({ thread: null, unreadForUser: 0, isStaff: true });
    }
    const { thread, unreadForUser } = await ChatService.getOrCreateMyThread(req.user.id);
    res.json({ thread, unreadForUser, isStaff: false });
  } catch (err) {
    next(err);
  }
};

exports.listThreads = async (req, res, next) => {
  try {
    const identity = await ChatService.resolveChatIdentity(req.user.id);
    if (!identity.isStaff) {
      return res.status(403).json({ error: 'Доступно только персоналу' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';

    const data = await ChatService.listStaffThreads({ limit, offset, unreadOnly, excludeUserId: req.user.id, });
    res.json(data);
  } catch (err) {
    next(err);
  }
};

exports.getMessages = async (req, res, next) => {
  try {
    const identity = await ChatService.resolveChatIdentity(req.user.id);
    const threadId = parseInt(req.params.id, 10);
    if (!Number.isInteger(threadId) || threadId <= 0) {
      return res.status(400).json({ error: 'Некорректный id треда' });
    }
    const beforeId = req.query.before ? parseInt(req.query.before, 10) : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    const data = await ChatService.getThreadMessages(threadId, {
      userId: req.user.id,
      isStaff: identity.isStaff,
      beforeId,
      limit,
    });
    res.json(data);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

exports.sendMessage = async (req, res, next) => {
  try {
    const { threadId, body, replyToId, quotedText, attachmentIds } = req.body || {};
    const result = await ChatService.sendMessage({
      userId: req.user.id,
      threadId: threadId ? parseInt(threadId, 10) : null,
      body,
      storeId: req.storeId || null,
      replyToId: replyToId ? parseInt(replyToId, 10) : null,
      quotedText: typeof quotedText === 'string' ? quotedText : null,
      attachmentIds: Array.isArray(attachmentIds)
        ? attachmentIds.map((x) => parseInt(x, 10)).filter(Number.isInteger)
        : [],
    });

    // Live-доставка + push офлайн-адресату.
    //
    // Эмитим ВСЕГДА в обе стороны (owner + staff) — так автор видит своё
    // сообщение через socket (не дублируем вручную в handleSend), а
    // коллеги-модераторы видят активность. Это часть фикса race UI.
    //
    // Push — ТОЛЬКО противоположной стороне и ТОЛЬКО если она офлайн.
    // notifyChatStaff / notifyChatUser возвращают false, если комната пуста.
    try {
      const staffOnline = notifyChatStaff('chat_message_new', result.payloadForTarget);
      const ownerId = result.payloadForTarget?.userId;
      const userOnline = ownerId
        ? notifyChatUser(ownerId, 'chat_message_new', result.payloadForTarget)
        : false;

      // user → staff (targetUnread='staff'): push всем staff только если
      // в комнате 'chat:staff' никого нет.
      if (result.targetUnread === 'staff' && !staffOnline) {
        NotificationService.notifyChatStaffGlobal({
          threadId: result.threadId,
          threadOwnerId: ownerId,
          authorName: result.payloadForTarget?.authorName,
          preview: result.payloadForTarget?.preview,
        }).catch(() => { });
      }

      // staff → user (targetUnread='user'): push owner'у если он офлайн.
      // Если staff пишет в СВОЙ тред (ownerId === автор), userOnline=true —
      // push не уйдёт (это и правильно: себе push не шлём).
      if (result.targetUnread === 'user' && ownerId && !userOnline) {
        NotificationService.notifyChatUser(ownerId, {
          threadId: result.threadId,
          authorName: result.payloadForTarget?.authorName,
          preview: result.payloadForTarget?.preview,
          isStaffMessage: true,
        }).catch(() => { });
      }
    } catch (socketErr) {
      console.warn('[chatController] socket/push failed (sendMessage):', socketErr.message);
    }

    res.json({
      message: result.message,
      threadId: result.threadId,
    });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.status === 403) return res.status(403).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.status === 429) return res.status(429).json({ error: err.message });
    next(err);
  }
};

exports.markRead = async (req, res, next) => {
  try {
    const identity = await ChatService.resolveChatIdentity(req.user.id);
    const threadId = req.body?.threadId ? parseInt(req.body.threadId, 10) : null;
    const result = await ChatService.markRead({
      userId: req.user.id,
      isStaff: identity.isStaff,
      threadId,
    });

    try {
      if (result.threadId) {
        // Сам читатель обновит у себя локально через /chat/unread-count;
        // эмит нужен ДРУГОЙ стороне, чтобы показать ✓✓ на её сообщениях.
        const payload = {
          threadId: result.threadId,
          by: result.scope === 'user' ? 'user' : 'staff',
          lastReadMessageId: result.lastReadMessageId || 0,
          scope: result.scope,
        };
        if (result.scope === 'user') {
          notifyChatStaff('chat_read', payload);
          notifyChatUser(req.user.id, 'chat_read', payload);
        } else if (result.scope === 'staff') {
          notifyChatStaff('chat_read', payload);
          const thread = await require('../models').ChatThread.getById(result.threadId);
          if (thread) notifyChatUser(thread.user_id, 'chat_read', payload);
        }
      } else if (result.scope === 'all-staff') {
        notifyChatStaff('chat_read', { scope: 'all-staff', by: 'staff' });
      }
    } catch (socketErr) {
      console.warn('[chatController] socket emit failed (markRead):', socketErr.message);
    }

    res.json(result);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.status === 403) return res.status(403).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
};

exports.unreadCounts = async (req, res, next) => {
  try {
    const identity = await ChatService.resolveChatIdentity(req.user.id);
    const data = await ChatService.getUnreadCounts({
      userId: req.user.id,
      isStaff: identity.isStaff,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
};

exports.deleteThread = async (req, res, next) => {
  try {
    const identity = await ChatService.resolveChatIdentity(req.user.id);

    // threadId: body ИЛИ query (query надёжнее для DELETE — некоторые
    // http-клиенты не передают body при DELETE).
    const rawId = req.body?.threadId ?? req.query?.threadId;
    const threadId = rawId ? parseInt(rawId, 10) : null;
    if (!threadId) {
      return res.status(400).json({ error: 'threadId обязателен' });
    }

    const result = await ChatService.deleteThread({
      userId: req.user.id,
      isStaff: identity.isStaff,
      staffRole: identity.staffRole,
      threadId,
    });

    // Audit-запись (без содержимого переписки).
    try {
      NotificationService.notifyStaff(
        'chat_thread_deleted',
        {
          threadId: result.threadId,
          ownerId: result.threadOwnerId,
          deletedBy: result.deletedByUserId,
          deletedMessages: result.deletedMessages,
          deletedByOwner: result.wasOwner,
        },
        { storeId: null, push: false }
      );
    } catch { /* audit не должен ронять ответ */ }

    // Live-emit:
    //   • staff — всегда (чтобы список тредов у модераторов обновился);
    //   • owner — только если удалил не он (god удалил чужой тред).
    try {
      notifyChatStaff('chat_thread_deleted', {
        threadId: result.threadId,
        ownerId: result.threadOwnerId,
      });
      if (!result.wasOwner) {
        notifyChatUser(result.threadOwnerId, 'chat_thread_deleted', {
          threadId: result.threadId,
        });
      }
    } catch (socketErr) {
      console.warn('[chatController] socket emit failed (deleteThread):', socketErr.message);
    }

    res.json({ ok: true, deletedMessages: result.deletedMessages });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.status === 403) return res.status(403).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
};

exports.deleteMessage = async (req, res, next) => {
  try {
    const messageId = parseInt(req.params.id, 10);
    if (!Number.isInteger(messageId) || messageId <= 0) {
      return res.status(400).json({ error: 'Некорректный id' });
    }
    const identity = await ChatService.resolveChatIdentity(req.user.id);
    const result = await ChatService.deleteMessage({
      userId: req.user.id,
      isStaff: identity.isStaff,
      messageId,
    });
    try {
      const payload = {
        threadId: result.threadId,
        messageId: result.messageId,
        authorId: result.authorId,
        alreadyDeleted: result.alreadyDeleted,
      };
      notifyChatStaff('chat_message_deleted', payload);
      notifyChatUser(result.threadOwnerId, 'chat_message_deleted', payload);
    } catch (socketErr) {
      console.warn('[chatController] emit failed (deleteMessage):', socketErr.message);
    }
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

exports.uploadAttachment = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не передан' });

    const { threadId: rawThreadId } = req.body || {};
    const threadId = parseInt(rawThreadId, 10);
    if (!threadId) return res.status(400).json({ error: 'threadId обязателен' });

    // Права: user — только свой тред, staff — любой
    const identity = await ChatService.resolveChatIdentity(req.user.id);
    const thread = await ChatThread.getById(threadId);
    if (!thread) return res.status(404).json({ error: 'Тред не найден' });
    if (!identity.isStaff && thread.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Нет доступа к этому треду' });
    }

    if (!ChatStorageService.isAllowed(req.file.mimetype)) {
      return res.status(415).json({ error: 'Недопустимый тип файла' });
    }

    const { storagePath } = await ChatStorageService.saveBuffer(
      threadId,
      req.file.mimetype,
      req.file.buffer
    );

    const att = await ChatAttachment.createOrphan({
      threadId,
      uploaderId: req.user.id,
      fileName: req.file.originalname || 'file',
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
      storagePath,
    });

    res.json({
      id: att.id,
      fileName: att.file_name,
      mimeType: att.mime_type,
      fileSize: att.file_size,
      url: `/api/chat/attachments/${att.id}`,
      previewUrl: att.mime_type && att.mime_type.startsWith('image/')
        ? `/api/chat/attachments/${att.id}?inline=1`
        : null,
    });
  } catch (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `Файл больше ${Math.round(ChatStorageService.maxBytes / 1024 / 1024)} МБ` });
    }
    next(err);
  }
};

exports.downloadAttachment = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Некорректный id' });

    const att = await ChatAttachment.getById(id);
    if (!att) return res.status(404).json({ error: 'Вложение не найдено' });

    const identity = await ChatService.resolveChatIdentity(req.user.id);

    // Права: staff — любой тред, user — только свой, orphan (message_id IS NULL) —
    // только сам загрузивший (он может его ещё не отправить)
    if (att.message_id == null) {
      if (att.uploader_id !== req.user.id) {
        return res.status(403).json({ error: 'Нет доступа' });
      }
    } else if (!identity.isStaff) {
      const thread = await ChatThread.getById(att.thread_id);
      if (!thread || thread.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Нет доступа' });
      }
    }

    const isInline = req.query.inline === '1';
    const disposition = isInline ? 'inline' : 'attachment';
    // Content-Disposition с filename* для UTF-8 имён
    const encodedName = encodeURIComponent(att.file_name || 'file');
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename*=UTF-8''${encodedName}`
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(att.file_size));

    const fs = require('fs');
    const absPath = ChatStorageService.absolutePath(att.storage_path);
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'Файл не найден на диске' });
    }
    fs.createReadStream(absPath).pipe(res);
  } catch (err) {
    next(err);
  }
};