const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { User } = require('./models');
// Роли персонала берём из модуля БЕЗ зависимостей: импорт из middlewares/auth
// утаскивал за собой AuthService и создавал цикл require
// (NotificationService -> socket -> middlewares/auth -> AuthService ->
// NotificationService), ломавший журналирование ошибок в AuthService.
const { STAFF_ROLES } = require('./config/staffRoles');

let io;

function initSocket(server) {
  io = new Server(server, {
    cors: {
      // Паритет с HTTP-CORS в server.js: разрешаем dev-порты (3000/5173) и
      // боевой origin из CLIENT_ORIGIN/CLIENT_URL. Раньше здесь был только
      // CLIENT_ORIGIN || CLIENT_URL || 'http://localhost:3000' — в dev на
      // localhost:5173 HTTP-запросы проходили, а handshake сокета отклонялся
      // (CORS), поэтому live-тосты не приходили.
      origin: [
        'http://localhost:3000',
        'http://localhost:5173',
        process.env.CLIENT_ORIGIN,
        process.env.CLIENT_URL,
      ].filter(Boolean),
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Middleware для аутентификации
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }
    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      const user = await User.getById(decoded.userId);
      if (!user) {
        return next(new Error('User not found'));
      }
      socket.user = user;
      socket.userId = user.id;
      socket.role = user.role;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`[Socket] Пользователь ${socket.userId} (${socket.role}) подключился`);

    // Личная комната — всегда (админы/модераторы тоже получают персональные оповещения)
    socket.join(`user_${socket.userId}`);

    // Комната персонала: архив журнала действий сотрудников и ошибки сервера
    // доступны админам, модераторам и Создателю
    if (STAFF_ROLES.includes(socket.role)) {
      socket.join('staff');
    }

    // Live-оповещения о действиях сотрудников приходят ТОЛЬКО модераторам.
    // Остальной персонал (admin, god) читает эти события в архиве журнала.
    if (socket.role === 'moderator') {
      socket.join('moderators');
    }

    socket.on('disconnect', () => {
      console.log(`[Socket] Пользователь ${socket.userId} отключился`);
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.IO не инициализирован');
  return io;
}

// Функции для отправки уведомлений
// Live-оповещения о действиях сотрудников: только модераторам
// (комната 'moderators', см. подключение выше)
function notifyModerators(event, data) {
  if (!io) return;
  io.to('moderators').emit(event, data);
}

// События всему персоналу (admin/moderator/god): например, ошибки сервера
function notifyStaffLive(event, data) {
  if (!io) return;
  io.to('staff').emit(event, data);
}

/**
 * Онлайн ли пользователь: есть хотя бы ОДИН активный сокет.
 * Все вкладки/устройства с открытым сайтом входят в комнату `user_<id>`,
 * поэтому размер комнаты — это и есть «Set активных сокетов»
 * (Socket.IO ведёт его сам, отдельная структура не нужна).
 * Пользователь считается онлайн при количестве сокетов >= 1.
 *
 * ВАЖНО: адаптер in-memory корректен для одного инстанса (PM2 fork,
 * instances: 1). При горизонтальном масштабировании нужен
 * @socket.io/redis-adapter — иначе каждый инстанс видит только свои сокеты.
 */
function isUserOnline(userId) {
  if (!io) return false;
  const room = io.sockets.adapter.rooms.get(`user_${userId}`);
  return Boolean(room && room.size > 0);
}

/**
 * Доставить событие пользователю. Возвращает true, если у него был хотя бы
 * один активный сокет (событие ушло), иначе false — по этому признаку
 * NotificationService решает отправить Web Push офлайн-получателю.
 */
function notifyUser(userId, event, data) {
  if (!isUserOnline(userId)) return false;
  io.to(`user_${userId}`).emit(event, data);
  return true;
}

/**
 * Персональная рассылка нескольким пользователям с онлайн-фильтром.
 * Возвращает массив id тех, кому событие реально ушло в сокет
 * (остальным вызывающий отправляет Web Push).
 */
function notifyUsers(userIds, event, data) {
  const delivered = [];
  for (const id of userIds || []) {
    if (notifyUser(id, event, data)) delivered.push(id);
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