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

const config = require('./src/config');
const stores = require('./src/config/stores');
const { initDB } = require('./src/config/database');
const { initNotificationsDB } = require('./src/config/notificationsDatabase');
const { storeResolver, resolveStoreId } = require('./src/middlewares/storeResolver');
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
const PORT = config.port;

// Если сервер стоит за reverse proxy (nginx и т.п.) — rate-limit и req.ip
// иначе видят IP прокси, а не клиента, и все пользователи делят один общий лимит.
if (config.trustProxy) {
  app.set('trust proxy', config.trustProxy);
}

// Страховка от прод-мисконфига
if (process.env.NODE_ENV === 'production' && !process.env.TRUST_PROXY) {
  console.warn(
    '⚠️  [PROD] TRUST_PROXY не задан: за reverse proxy все пользователи будут ' +
    'делить одну корзину rate-limit (массовые 429). Добавьте TRUST_PROXY=1 в .env.'
  );
}
console.log(`[RATE LIMIT] trust proxy = ${app.get('trust proxy')}`);

// Security middleware
app.use(helmet());

// ============================================================
//  CORS (per-store)
// ============================================================
const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:5173'];

function hostnameFromHostHeader(hostHeader) {
  if (!hostHeader) return null;
  return String(hostHeader).split(':')[0].trim().toLowerCase();
}

function hostnameFromOrigin(origin) {
  if (!origin) return null;
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function dynamicCors(req, res, next) {
  const hostname = hostnameFromHostHeader(req.headers.host);
  const storeId = resolveStoreId(hostname);
  const store = storeId ? stores[storeId] : null;

  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (DEV_ORIGINS.includes(origin)) return callback(null, true);

      if (store && store.clientOrigin) {
        const allowed = hostnameFromOrigin(store.clientOrigin);
        const actual = hostnameFromOrigin(origin);
        if (allowed && actual === allowed) return callback(null, true);
      }

      console.warn(
        `[CORS] Отклонён origin: ${origin} (host: ${req.headers.host}, store: ${storeId || '—'})`
      );
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Disposition'],
  })(req, res, next);
}

app.use(dynamicCors);
app.use(express.static('public'));
app.use(express.json());

// ============================================================
//  РЕЗОЛВЕР МАГАЗИНА + ЛИМИТЫ
// ============================================================
app.use('/api', storeResolver);

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

// Error handler
app.use((err, req, res, _next) => {
  console.error(err.stack);
  NotificationService.logServerError(
    'express',
    err,
    req.storeId ? { storeId: req.storeId } : null
  );
  res.status(500).json({ error: 'Internal Server Error' });
});

// HTTP-сервер + Socket.IO
const server = http.createServer(app);
initSocket(server);

// ============================================================
//  ЗАПУСК
// ============================================================
(async () => {
  try {
    await initDB();
    console.log('✅ Подключение к БД установлено');

    await initNotificationsDB();

    // ---------- ПЛАНИРОВЩИКИ ----------
    // ГЛОБАЛЬНЫЕ (одни на всё приложение)
    scheduler.startCooldownCleaner();
    scheduler.startDailyBackupChecker();
    scheduler.startNotificationsCleanup();
    scheduler.startModelsMaintenanceChecker();
    scheduler.startGuestCleanupChecker();

    // PER-STORE (проходят циклом по всем магазинам последовательно)
    const SYNC_ORDERS_TIME = parseInt(process.env.SYNC_ORDERS_TIME, 10) || 60;
    scheduler.startOrderChecker(SYNC_ORDERS_TIME);

    // Ежедневная очистка акций — per-store, флаг CLEAN_PROMOTIONS в .env.storeN
    scheduler.startDailyPromotionCleaner();
    // Ежемесячный экспорт заработка — per-store
    scheduler.startMonthlyExportChecker();

    if (process.env.DELIVER_REMINDER_ENABLED === 'true') {
      scheduler.startAwaitingDeliverReminderChecker();
      console.log('✅ Проверка awaiting_deliver включена');
    } else {
      console.log('⏭️ Проверка awaiting_deliver отключена (DELIVER_REMINDER_ENABLED != true)');
    }

    if (process.env.CANCEL_SYNC_ENABLED === 'true') {
      scheduler.startCancelledOrdersChecker();
      console.log('✅ Сверка отменённых заказов включена');
    } else {
      console.log('⏭️ Сверка отменённых заказов отключена (CANCEL_SYNC_ENABLED != true)');
    }

    if (process.env.ORDER_STATUS_SYNC_ENABLED === 'true') {
      scheduler.startOrderStatusSyncChecker();
      console.log('✅ Синхронизация статусов заказов включена');
    } else {
      console.log('⏭️ Синхронизация статусов заказов отключена (ORDER_STATUS_SYNC_ENABLED != true)');
    }

    console.log('✅ Планировщик запущен');

    // Первоначальная загрузка очереди — ЦИКЛ ПО МАГАЗИНАМ
    setTimeout(async () => {
      for (const storeId of stores.getStoreIds()) {
        try {
          await OrderService.checkNewOrders(storeId);
          console.log(`✅ Первоначальная загрузка очереди заказов для store ${storeId} выполнена`);
        } catch (err) {
          console.error(`❌ Ошибка первоначальной загрузки очереди для store ${storeId}:`, err);
        }
      }
    }, 5000);

    server.listen(PORT, () => {
      console.log(`🚀 Сервер запущен на порту ${PORT}`);
    });
  } catch (err) {
    console.error('❌ Ошибка инициализации БД:', err);
    process.exit(1);
  }
})();