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

let io;

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        // dev-порты и любые *.lvh.me / *.nip.io / localhost
        const devPatterns = [
          "http://localhost:3000",
          "http://localhost:5173",
        ];
        if (devPatterns.includes(origin)) return callback(null, true);
        try {
          const host = new URL(origin).hostname;
          if (
            host === "localhost" ||
            host === "127.0.0.1" ||
            host === "lvh.me" ||
            host.endsWith(".lvh.me") ||
            host.endsWith(".nip.io")
          ) {
            return callback(null, true);
          }
        } catch { /* ignore */ }
        // prod: только CLIENT_ORIGIN / CLIENT_URL
        if (
          origin === process.env.CLIENT_ORIGIN ||
          origin === process.env.CLIENT_URL
        ) {
          return callback(null, true);
        }
        return callback(null, false);
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // Middleware для аутентификации + резолв магазина
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    // StoreId — по Host того же handshake (фронт на поддомене shop1
    // подключается к сокету на shop1). Это тот же resolveStoreId, что и в
    // HTTP: single-store fallback работает и здесь (dev на localhost).
    const hostname = String(socket.handshake.headers.host || '')
      .split(':')[0].trim().toLowerCase();
    const storeId = resolveStoreId(hostname);
    if (!storeId) {
      return next(new Error('Store not found'));
    }

    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      const user = await User.getById(decoded.userId);
      if (!user) {
        return next(new Error('User not found'));
      }

      // Роль в магазине — та же логика, что в middlewares/auth.js.
      // Именно per-store роль определяет, попадёт ли сокет в комнату
      // 'staff'/'moderators' ЭТОГО магазина.
      let effectiveRole;
      if (user.role === 'god') {
        effectiveRole = 'god';
      } else if (user.role === 'guest') {
        effectiveRole = 'guest';
      } else {
        const storeRecord = await UserStore.get(user.id, storeId);
        effectiveRole =
          storeRecord && !storeRecord.is_fired ? storeRecord.role : 'user';
      }

      socket.user = user;
      socket.userId = user.id;
      socket.storeId = String(storeId);
      socket.role = effectiveRole;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(
      `[Socket][store ${socket.storeId}] Пользователь ${socket.userId} (${socket.role}) подключился`
    );

    // Личная комната — per-store. Одна и та же персона в разных магазинах
    // заходит через разные поддомены и получает РАЗНЫЕ комнаты: оповещение
    // магазина 1 не прилетит в открытую вкладку магазина 2.
    socket.join(`store_${socket.storeId}:user_${socket.userId}`);

    // Комната персонала магазина
    if (STAFF_ROLES.includes(socket.role)) {
      socket.join(`store_${socket.storeId}:staff`);
    }

    // Live-оповещения о действиях сотрудников — только модераторам магазина
    if (socket.role === 'moderator') {
      socket.join(`store_${socket.storeId}:moderators`);
    }

    socket.on('disconnect', () => {
      console.log(
        `[Socket][store ${socket.storeId}] Пользователь ${socket.userId} отключился`
      );
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
 * storeId обязателен: одна персона на shop1 и shop2 — разные соединения
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

module.exports = {
  initSocket,
  getIO,
  notifyModerators,
  notifyStaffLive,
  notifyUser,
  notifyUsers,
  isUserOnline,
};