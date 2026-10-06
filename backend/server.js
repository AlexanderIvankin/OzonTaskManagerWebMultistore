const { getLocalTimestamp } = require('./src/utils');
require('dotenv').config();

// ============================================================
//  ДОБАВЛЕНИЕ ВРЕМЕННЫХ МЕТОК КО ВСЕМ ЛОГАМ
// ============================================================
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function withTimestamp(originalFn) {
  return function (...args) {
    const timestamp = getLocalTimestamp();
    originalFn(`[${timestamp}]`, ...args);
  };
}

console.log = withTimestamp(originalLog);
console.error = withTimestamp(originalError);
console.warn = withTimestamp(originalWarn);

const express = require('express');
const cors = require('cors');
const http = require('http');
const helmet = require('helmet');

const { initDB } = require('./src/config/database');
const { initNotificationsDB } = require('./src/config/notificationsDatabase');
const scheduler = require('./src/scheduler');
const OrderService = require('./src/services/OrderService');
const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/user');
const adminRoutes = require('./src/routes/admin');
const notificationsRoutes = require('./src/routes/notifications');
const modelsRoutes = require('./src/routes/models');
const NotificationService = require('./src/services/NotificationService');
const { initSocket } = require('./src/socket');
const { apiLimiter, authLimiter } = require('./src/middlewares/rateLimiters');

const app = express();
const PORT = process.env.PORT || 5000;

// Если сервер стоит за reverse proxy (nginx и т.п.) — rate-limit и req.ip
// иначе видят IP прокси, а не клиента, и все пользователи делят один общий лимит.
// В dev (localhost) это не требуется.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', parseInt(process.env.TRUST_PROXY, 10) || 1);
}

// Страховка от прод-мисконфига: за reverse proxy без trust proxy все клиенты
// получают req.ip прокси (127.0.0.1) и делят ОДНУ корзину rate-limit ->
// массовые 429 и принудительные логауты. nginx при этом обязан передавать
// X-Forwarded-For (см. ServerFiles/DEPLOY-NOTE.md).
if (process.env.NODE_ENV === 'production' && !process.env.TRUST_PROXY) {
  console.warn(
    '⚠️  [PROD] TRUST_PROXY не задан: за reverse proxy все пользователи будут ' +
    'делить одну корзину rate-limit (массовые 429). Добавьте TRUST_PROXY=1 ' +
    'в .env (см. ServerFiles/DEPLOY-NOTE.md).'
  );
}
console.log(`[RATE LIMIT] trust proxy = ${app.get('trust proxy')}`);

// Security middleware
app.use(helmet());
const corsOptions = {
  origin: function (origin, callback) {
    // Запросы без Origin (curl, серверные вызовы, Postman) — пропускаем
    if (!origin) return callback(null, true);

    const allowed = [
      'http://localhost:3000',
      'http://localhost:5173',
      process.env.CLIENT_ORIGIN,
    ].filter(Boolean);

    if (allowed.includes(origin)) {
      return callback(null, true);
    }

    // Мягкая блокировка: без CORS-заголовков, без 500.
    // Браузер сам заблокирует ответ, сервер продолжит работу спокойно.
    console.warn(`[CORS] Отклонён origin: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  // Разрешаем фронту читать имя файла из Content-Disposition
  // (версионированные имена: materials-prices-1.json, bot_web-1.db и т.п.)
  exposedHeaders: ['Content-Disposition'],
};

app.use(cors(corsOptions));
app.use(express.static('public'));
app.use(express.json());

// Rate limiting — конфигурация лимитеров в src/middlewares/rateLimiters.js.
// Общий apiLimiter — на весь /api. Строгий authLimiter — ТОЛЬКО на
// брутфорсимые auth-эндпоинты (логин, регистрация, код из письма).
// /auth/refresh и /auth/me под него НЕ подпадают: это легитимный трафик
// каждой активной сессии (при ACCESS_TOKEN_EXPIRY=15m — ~2 запроса в окно
// на пользователя), раньше они выжигали лимит /api/auth и пользователи
// массово получали 429 с принудительным логаутом (refresh-интерцептор фронта).
app.use('/api', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/verify-email', authLimiter);
app.use('/api/auth/resend-code', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);


// Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/models', modelsRoutes);

// Error handling middleware.
// ВАЖНО: сигнатура обязана иметь 4 аргумента (даже если некоторые не используются) —
// по длине функции (fn.length === 4) Express понимает, что это обработчик ошибок.
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  // Журналируем ошибку в отдельную БД (notifications.db -> server_errors)
  NotificationService.logServerError('express', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Создаём HTTP-сервер
const server = http.createServer(app);

// Инициализируем Socket.IO
initSocket(server);

// Запускаем сервер после инициализации БД и планировщика
(async () => {
  try {
    await initDB();
    console.log('✅ Подключение к БД установлено');

    // Отдельная база оповещений (notifications.db): история действий + ошибки сервера
    await initNotificationsDB();

    // Запускаем планировщик
    const SYNC_ORDERS_TIME = parseInt(process.env.SYNC_ORDERS_TIME) || 60;
    scheduler.startOrderChecker(SYNC_ORDERS_TIME, OrderService.checkNewOrders);
    scheduler.startCooldownCleaner();
    scheduler.startDailyBackupChecker();
    scheduler.startNotificationsCleanup();
    scheduler.startDailyPromotionCleaner();
    scheduler.startMonthlyExportChecker();
    // 3D-модели: ежечасная чистка просроченного локального кэша zip
    // (TTL — MODELS_CACHE_TTL_MIN) и использованных/просроченных токенов скачивания.
    scheduler.startModelsMaintenanceChecker();

    // Неподтверждённые аккаунты (роль 'guest'): ежечасная очистка —
    // гость удаляется целиком, если не подтвердил email более GUEST_TTL_HOURS
    // часов (по умолчанию 24). До удаления он не числится в команде
    // (is_fired = 1, приём заказов выключен).
    scheduler.startGuestCleanupChecker();

    // Ежедневная проверка заказов «ожидает отправки» (awaiting_deliver):
    // напоминания уходят в оповещения сотруднику и персоналу (модераторам
    // и остальным staff-ролям), а не сообщениями Telegram-бота.
    // На 3-й день заработок за неотправленный заказ обнуляется сторнирующей
    // корректировкой (см. scheduler.runAwaitingDeliverReminder).
    if (process.env.DELIVER_REMINDER_ENABLED === 'true') {
      scheduler.startAwaitingDeliverReminderChecker();
      console.log('✅ Проверка awaiting_deliver включена');
    } else {
      console.log('⏭️ Проверка awaiting_deliver отключена (DELIVER_REMINDER_ENABLED != true)');
    }

    // Ежедневная сверка отменённых Ozon заказов: если завершённый, но не
    // отправленный заказ Ozon перевёл в статус «Отменён», заработок за него
    // сторнируется корректировкой (идемпотентно, без двойных списаний).
    if (process.env.CANCEL_SYNC_ENABLED === 'true') {
      scheduler.startCancelledOrdersChecker();
      console.log('✅ Сверка отменённых заказов включена');
    } else {
      console.log('⏭️ Сверка отменённых заказов отключена (CANCEL_SYNC_ENABLED != true)');
    }

    // Ежечасная синхронизация статусов кэша заказов (вкладка «Завершённые
    // заказы»): 2 запроса к Ozon (awaiting_packaging + awaiting_deliver).
    // Заказы, вышедшие из этих статусов, убираются из кэша вместе с фото.
    // Ту же синхронизацию запускает кнопка «Обновить» на странице «Мои заказы».
    if (process.env.ORDER_STATUS_SYNC_ENABLED === 'true') {
      scheduler.startOrderStatusSyncChecker();
      console.log('✅ Синхронизация статусов заказов включена');
    } else {
      console.log('⏭️ Синхронизация статусов заказов отключена (ORDER_STATUS_SYNC_ENABLED != true)');
    }

    console.log('✅ Планировщик запущен');

    // Первоначальная загрузка очереди
    setTimeout(async () => {
      try {
        await OrderService.checkNewOrders();
        console.log('✅ Первоначальная загрузка очереди заказов выполнена');
      } catch (err) {
        console.error('❌ Ошибка первоначальной загрузки очереди:', err);
      }
    }, 5000);

    // Запускаем сервер
    server.listen(PORT, () => {
      console.log(`🚀 Сервер запущен на порту ${PORT}`);
    });
  } catch (err) {
    console.error('❌ Ошибка инициализации БД:', err);
    process.exit(1);
  }
})();