// src/controllers/chatController.js
//
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

const ChatService = require('../services/ChatService');
const NotificationService = require('../services/NotificationService');
const { notifyChatStaff, notifyChatUser } = require('../socket');

exports.getMyThread = async (req, res, next) => {
  try {
    const identity = await ChatService.resolveChatIdentity(req.user.id);
    const { thread, unreadForUser } = await ChatService.getOrCreateMyThread(req.user.id);
    res.json({ thread, unreadForUser, isStaff: identity.isStaff });
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

    const data = await ChatService.listStaffThreads({ limit, offset, unreadOnly });
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
    const { threadId, body, replyToId } = req.body || {};
    const result = await ChatService.sendMessage({
      userId: req.user.id,
      threadId: threadId ? parseInt(threadId, 10) : null,
      body,
      storeId: req.storeId || null,
      replyToId: replyToId ? parseInt(replyToId, 10) : null,
    });

    // Live-доставка противоположной стороне:
    //   user написал  → notifyChatStaff   (все staff всех магазинов)
    //   staff написал → notifyChatUser    (конкретный ownerId)
    // Ошибка emit не должна ронять HTTP-ответ: сообщение уже в БД,
    // а клиент-адресат получит его при следующем reload через REST.
    // Стало: всегда эмитим и стаффу, и владельцу треда.
    // Автор тоже получит свой emit — через chat:staff (если staff)
    // или через chat:user_<ownerId> (если user и он владелец).
    try {
      notifyChatStaff('chat_message_new', result.payloadForTarget);
      if (result.payloadForTarget?.userId) {
        notifyChatUser(
          result.payloadForTarget.userId,
          'chat_message_new',
          result.payloadForTarget
        );
      }
    } catch (socketErr) {
      console.warn('[chatController] socket emit failed (sendMessage):', socketErr.message);
    }

    // TODO(этап 3): если адресат офлайн — Web Push через NotificationService.
    // notifyChatStaff/notifyChatUser вернут false, если комната пуста —
    // по этому признаку здесь будет fallback на push.

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

    // Live-emit для синхронизации бейджа «Поддержка» в Layout у всех
    // заинтересованных сокетов: сам читатель обновит счётчик через /chat/unread-count.
    try {
      if (result.scope === 'all-staff' || result.scope === 'staff') {
        notifyChatStaff('chat_read', { threadId: result.threadId, by: 'staff', scope: result.scope });
      } else if (result.scope === 'user' && result.threadId) {
        // User прочитал — не нужно дёргать «staff», но нужно, чтобы сам user
        // (на других вкладках/устройствах) и staff-панель знали, что тред
        // прочитан — обновим staff, чтобы они видели актуальный unread.
        notifyChatStaff('chat_read', { threadId: result.threadId, by: 'user' });
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