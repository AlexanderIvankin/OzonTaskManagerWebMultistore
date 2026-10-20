const { normalizeRootDomain } = require('./utils');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { User } = require('./models');
const UserStore = require('./models/UserStore');
// Роли персонала берём из модуля БЕЗ зависимостей: импорт из middlewares/auth
// утаскивал за собой AuthService и создавал цикл require
// (NotificationService -> socket -> middlewares/auth -> AuthService ->
// NotificationService), ломавший журналирование ошибок в AuthService.
const { STAFF_ROLES } = require('./config/staffRoles');
const { resolveStoreId } = require('./middlewares/storeResolver');
const ChatService = require('./services/ChatService');

let io;

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);

        // dev-порты
        const devPatterns = [
          "http://localhost:3000",
          "http://localhost:5173",
        ];
        if (devPatterns.includes(origin)) return callback(null, true);

        let host = null;
        try {
          host = new URL(origin).hostname.toLowerCase();
        } catch { /* ignore */ }

        // dev-поддомены (lvh.me / nip.io)
        if (
          host === "localhost" ||
          host === "127.0.0.1" ||
          host === "lvh.me" ||
          host.endsWith(".lvh.me") ||
          host.endsWith(".nip.io")
        ) {
          return callback(null, true);
        }

        const rootDomain = normalizeRootDomain(process.env.ROOT_DOMAIN);

        if (
          rootDomain &&
          (host === rootDomain || host === `www.${rootDomain}`)
        ) {
          return callback(null, true);
        }

        // Прод: clientOrigin конкретного магазина
        if (
          origin === process.env.CLIENT_ORIGIN ||
          origin === process.env.CLIENT_URL
        ) {
          return callback(null, true);
        }

        // Прод: поддомен магазина (shop1.na3d.ru и т.п.) — берём из реестра
        // через stores: у каждого есть clientOrigin. Если origin совпал
        // с любым clientOrigin — пропускаем.
        try {
          const stores = require("./config/stores");
          for (const storeId of stores.getStoreIds()) {
            const clientOrigin = stores.getStore(storeId).clientOrigin;
            if (!clientOrigin) continue;
            try {
              const coHost = new URL(clientOrigin).hostname.toLowerCase();
              if (coHost === host) return callback(null, true);
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }

        return callback(null, false);
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // Middleware для аутентификации + резолв магазина
  // --- handshake ---
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));

    const hostname = String(socket.handshake.headers.host || '')
      .split(':')[0].trim().toLowerCase();
    const rootDomain = normalizeRootDomain(process.env.ROOT_DOMAIN);
    const isRootHost = Boolean(rootDomain &&
      (hostname === rootDomain || hostname === `www.${rootDomain}`));

    // storeId = null — валидный глобальный контекст (root-домен).
    // Раньше null → reject; теперь root → null → пропускаем.
    let storeId = null;
    if (!isRootHost) {
      storeId = resolveStoreId(hostname);
      if (!storeId) return next(new Error('Store not found'));
    }

    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      const user = await User.getById(decoded.userId);
      if (!user) return next(new Error('User not found'));

      // Per-store роль — только если контекст магазина.
      let effectiveRole;
      if (user.role === 'god') effectiveRole = 'god';
      else if (user.role === 'guest') effectiveRole = 'guest';
      else if (storeId) {
        const storeRecord = await UserStore.get(user.id, storeId);
        effectiveRole = storeRecord && !storeRecord.is_fired ? storeRecord.role : 'user';
      } else effectiveRole = 'user';

      // Chat-identity — ГЛОБАЛЬНАЯ (сквозной чат). Не роняем подключение
      // при ошибке: пользователь просто не попадёт в 'chat:staff'.
      let chatIdentity = { isStaff: false, staffRole: null };
      try {
        chatIdentity = await ChatService.resolveChatIdentity(user.id);
      } catch (err) {
        console.warn(`[Socket] resolveChatIdentity user=${user.id}:`, err.message);
      }

      socket.user = user;
      socket.userId = user.id;
      socket.storeId = storeId ? String(storeId) : null;
      socket.role = effectiveRole;
      socket.chatIdentity = chatIdentity;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const ctx = socket.storeId ? `store ${socket.storeId}` : 'root';
    console.log(
      `[Socket][${ctx}] Пользователь ${socket.userId} (${socket.role}` +
      `${socket.chatIdentity?.isStaff ? `, chat-staff=${socket.chatIdentity.staffRole}` : ''}) подключился`
    );

    // --- Per-store комнаты (только для магазинного контекста) ---
    if (socket.storeId) {
      socket.join(`store_${socket.storeId}:user_${socket.userId}`);
      if (STAFF_ROLES.includes(socket.role)) socket.join(`store_${socket.storeId}:staff`);
      if (socket.role === 'moderator') socket.join(`store_${socket.storeId}:moderators`);
    }

    // --- Chat-комнаты (ГЛОБАЛЬНЫЕ, сквозные) ---
    // Одна персона с N вкладок на разных поддоменах = N сокетов в одной
    // комнате chat:user_<id> — все N получат событие. Это ок.
    socket.join(`chat:user_${socket.userId}`);
    if (socket.chatIdentity?.isStaff) socket.join('chat:staff');

    // ── CHAT: печатает… (client → server, ретрансляция противоположной стороне)
    socket.on('chat_typing', async ({ threadId: rawId } = {}) => {
      try {
        const threadId = parseInt(rawId, 10);
        if (!threadId) return;

        const { ChatThread } = require('./models');
        const thread = await ChatThread.getById(threadId);
        if (!thread) return;

        const isOwner = thread.user_id === socket.userId;
        const isStaff = Boolean(socket.chatIdentity?.isStaff);
        if (!isOwner && !isStaff) return; // чужой человек

        const authorName = isStaff
          ? 'Поддержка'
          : (socket.user.display_name || socket.user.name || socket.user.username || `user#${socket.userId}`);

        const payload = {
          threadId,
          authorId: socket.userId,
          authorName,
          isStaff,
        };

        if (isOwner) {
          io.to('chat:staff').emit('chat_typing', payload);
        } else {
          io.to(`chat:user_${thread.user_id}`).emit('chat_typing', payload);
        }
      } catch {
        /* тишина — typing не критичен */
      }
    });

    socket.on('disconnect', () => {
      console.log(`[Socket][${ctx}] Пользователь ${socket.userId} отключился`);
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.IO не инициализирован');
  return io;
}

/**
 * Live-оповещения о действиях сотрудников: только модераторам магазина.
 * storeId обязателен — комната без него не существует.
 */
function notifyModerators(storeId, event, data) {
  if (!io || !storeId) return;
  io.to(`store_${storeId}:moderators`).emit(event, data);
}

/**
 * События всему персоналу магазина (admin/moderator/god в user_stores).
 */
function notifyStaffLive(storeId, event, data) {
  if (!io || !storeId) return;
  io.to(`store_${storeId}:staff`).emit(event, data);
}

/**
 * Онлайн ли пользователь В КОНКРЕТНОМ МАГАЗИНЕ.
 * storeId обязателен: одна персона на store1 и shop2 — разные соединения
 * в разных поддоменах, разные комнаты.
 */
function isUserOnline(storeId, userId) {
  if (!io || !storeId) return false;
  const room = io.sockets.adapter.rooms.get(`store_${storeId}:user_${userId}`);
  return Boolean(room && room.size > 0);
}

/**
 * Доставить событие пользователю конкретного магазина.
 * Возвращает true, если у него был хотя бы один активный сокет (событие ушло),
 * иначе false — по этому признаку NotificationService решает отправить Web Push.
 */
function notifyUser(storeId, userId, event, data) {
  if (!io || !storeId) return false;
  const room = `store_${storeId}:user_${userId}`;
  const r = io.sockets.adapter.rooms.get(room);
  if (!r || r.size === 0) return false;
  io.to(room).emit(event, data);
  return true;
}

/**
 * Персональная рассылка нескольким пользователям ОДНОГО магазина
 * (у notifyStaff получатели всегда в одном магазине).
 */
function notifyUsers(storeId, userIds, event, data) {
  const delivered = [];
  for (const id of userIds || []) {
    if (notifyUser(storeId, id, event, data)) delivered.push(id);
  }
  return delivered;
}

// ============================================================================
//  CHAT HELPERS — глобальные (не per-store)
//  Все возвращают true, если хотя бы один адресат онлайн (сигнал для push
//  на этапе 3 — если false, NotificationService шлёт Web Push).
// ============================================================================

function notifyChatStaff(event, data) {
  if (!io) return false;
  const room = io.sockets.adapter.rooms.get('chat:staff');
  if (!room || room.size === 0) return false;
  io.to('chat:staff').emit(event, data);
  return true;
}

function notifyChatUser(userId, event, data) {
  if (!io) return false;
  const room = `chat:user_${userId}`;
  const r = io.sockets.adapter.rooms.get(room);
  if (!r || r.size === 0) return false;
  io.to(room).emit(event, data);
  return true;
}

function isChatUserOnline(userId) {
  if (!io) return false;
  const room = io.sockets.adapter.rooms.get(`chat:user_${userId}`);
  return Boolean(room && room.size > 0);
}

module.exports = {
  initSocket,
  getIO,

  notifyModerators,
  notifyStaffLive,
  notifyUser,
  notifyUsers,
  isUserOnline,

  notifyChatStaff,
  notifyChatUser,
  isChatUserOnline,
};