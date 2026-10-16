require('dotenv').config();

function int(name, fallback) {
  const v = process.env[name];
  return v !== undefined ? parseInt(v, 10) : fallback;
}

function bool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

function str(name, fallback = '') {
  const v = process.env[name];
  return v !== undefined ? v : fallback;
}

module.exports = {
  // --- Приложение ---
  port: int('PORT', 5000),
  timezone: str('TIMEZONE', 'Europe/Moscow'),
  trustProxy: bool('TRUST_PROXY', false),
  debugOrdersMode: bool('DEBUG_ORDERS_MODE', false),
  ozonMockMode: bool('OZON_MOCK_MODE', false),

  // --- Создатель (глобально, один на всю систему) ---
  god: {
    id: str('GOD_ID', '').trim(),
    email: str('GOD_EMAIL', '').trim().toLowerCase(),
  },

  // --- Ozon (общий идентификатор для ship) ---
  shipIdentifier: str('SHIP_IDENTIFIER', 'offer_id'),

  // --- Контексты (для отображения в UI) ---
  // rootName — название глобального домена (показывается в сайдбаре,
  // когда мы без магазина). Аналог STORE_NAME для поддомена магазина.
  rootName: str('ROOT_NAME', 'Global').trim() || 'Global',

  // --- Пути к общим БД ---
  usersDbPath: str('USERS_DB_PATH', './users.db'),
  modelsDbPath: str('MODELS_DB_PATH', './models.db'),
  notificationsDbPath: str('NOTIFICATIONS_DB_PATH', './notifications.db'),
  legacyDbPath: str('DB_PATH', './bot_web.db'),

  // --- JWT ---
  jwtSecret: str('JWT_SECRET'),
  jwtRefreshSecret: str('JWT_REFRESH_SECRET') || str('JWT_SECRET'),
  accessTokenExpiry: str('ACCESS_TOKEN_EXPIRY', '15m'),
  refreshTokenExpiry: str('REFRESH_TOKEN_EXPIRY', '30d'),

  // --- S3 (модели — общие для всех магазинов) ---
  s3: {
    endpoint: str('MODELS_S3_ENDPOINT'),
    region: str('MODELS_S3_REGION'),
    bucket: str('MODELS_S3_BUCKET'),
    accessKey: str('MODELS_S3_ACCESS_KEY'),
    secretKey: str('MODELS_S3_SECRET_KEY'),
    prefix: str('MODELS_S3_PREFIX', ''),
  },

  // --- Модели (S3-zip first) ---
  models: {
    maxUploadMb: int('MODELS_MAX_UPLOAD_MB', 1024),
    tokenTtlMin: int('MODELS_TOKEN_TTL_MIN', 15),
    cacheTtlMin: int('MODELS_CACHE_TTL_MIN', 60),
  },

  // --- Бэкапы БД (локально + S3) ---
  backup: {
    // Включить выгрузку архива всех БД на S3 после ежедневного бэкапа
    s3Enabled: bool('BACKUP_S3_ENABLED', false),

    // Имя bucket'а для бэкапов (ОТДЕЛЬНЫЙ от моделей!).
    // Если пусто — S3-выгрузка пропускается, даже если s3Enabled=true.
    s3Bucket: str('BACKUP_S3_BUCKET', ''),

    // Префикс ключей внутри bucket'а (папка). Например 'backups/'.
    s3Prefix: str('BACKUP_S3_PREFIX', 'backups/'),

    // Отдельные endpoint/region/credentials для bucket'а бэкапов.
    // Если задан ХОТЯ БЫ ОДИН из них — создаётся отдельный S3Client
    // (см. src/config/s3.js). Если все пусты — используется основной клиент
    // (тот же, что для моделей). Это позволяет:
    //   • один пользователь + два bucket  → оставить эти поля пустыми;
    //   • два пользователя / два провайдера → заполнить все три.
    s3Endpoint: str('BACKUP_S3_ENDPOINT', ''),
    s3Region: str('BACKUP_S3_REGION', ''),
    s3AccessKey: str('BACKUP_S3_ACCESS_KEY', ''),
    s3SecretKey: str('BACKUP_S3_SECRET_KEY', ''),

    // Сколько дней хранить архивы на S3 (по дате в имени файла).
    // 0 — не удалять (хранить вечно).
    s3RetentionDays: int('BACKUP_S3_RETENTION_DAYS', 30),

    // Сколько дней хранить локальные .db в backups/. 0 — не удалять.
    localRetentionDays: int('BACKUP_LOCAL_RETENTION_DAYS', 14),

    // Таймаут на одну S3-операцию (PutObject/ListObjectsV2), мс.
    s3TimeoutMs: int('BACKUP_S3_TIMEOUT_MS', 60000),
  },

  // --- SMTP (общий для всех магазинов) ---
  smtp: {
    host: str('SMTP_HOST'),
    port: int('SMTP_PORT', 587),
    secure: bool('SMTP_SECURE', false),
    user: str('SMTP_USER'),
    pass: str('SMTP_PASS'),
    from: str('SMTP_FROM'),
  },

  // --- Web Push (VAPID ключи глобальные; subject — per-store) ---
  push: {
    vapidPublicKey: str('VAPID_PUBLIC_KEY'),
    vapidPrivateKey: str('VAPID_PRIVATE_KEY'),
    subRetentionDays: int('PUSH_SUB_RETENTION_DAYS', 180),
    vapidDefaultSubject: str('DEFAULT_VAPID_SUBJECT'),
  },

  // --- Guest cleanup ---
  guestTtlHours: int('GUEST_TTL_HOURS', 24),
  resendCodeCooldownSec: int('RESEND_CODE_COOLDOWN_SEC', 60),

  // --- Планировщики заказов ---
  deliverReminder: {
    warnDays: int('DELIVER_REMINDER_WARN_DAYS', 2),
    revokeDays: int('DELIVER_REMINDER_REVOKE_DAYS', 3),
    maxAttempts: int('DELIVER_REMINDER_MAX_ATTEMPTS', 10),
  },
  cancelSync: {
    enabled: bool('CANCEL_SYNC_ENABLED', false),
    hour: int('CANCEL_SYNC_HOUR', 7),
    minute: int('CANCEL_SYNC_MINUTE', 30),
    windowHours: int('CANCEL_SYNC_WINDOW_HOURS', 48),
    maxAttempts: int('CANCEL_SYNC_MAX_ATTEMPTS', 10),
  },
  orderStatusSync: {
    enabled: bool('ORDER_STATUS_SYNC_ENABLED', false),
    intervalMinutes: int('ORDER_STATUS_SYNC_INTERVAL_MINUTES', 60),
  },

  // --- Очистка акций (глобальное время; per-store enabled — в stores.js) ---
  promotions: {
    cleanHour: int('PROMOTION_CLEAN_HOUR', 3),
    cleanMinute: int('PROMOTION_CLEAN_MINUTE', 0),
  },
};