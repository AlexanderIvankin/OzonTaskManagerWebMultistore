const { S3Client } = require('@aws-sdk/client-s3');

/**
 * Основной S3-клиент — модели (и любой общий трафик).
 * Все подписки создаются с одним applicationServerKey... (не относится,
 * это отдельная тема — тут про S3).
 */
const s3 = new S3Client({
  endpoint: process.env.MODELS_S3_ENDPOINT,
  region: process.env.MODELS_S3_REGION || 'ru-1',
  credentials: {
    accessKeyId: process.env.MODELS_S3_ACCESS_KEY,
    secretAccessKey: process.env.MODELS_S3_SECRET_KEY,
  },
  forcePathStyle: true, // Beget требует path-style
});

// Префикс ключей моделей внутри бакета — по умолчанию ПУСТО.
const MODELS_PREFIX = process.env.MODELS_S3_PREFIX || '';

/**
 * ─── Бэкапы ────────────────────────────────────────────────────────────────
 *
 * Два сценария:
 *
 * 1. Bucket бэкапов в ТОМ ЖЕ аккаунте, что и модели (обычный случай).
 *    Достаточно указать BACKUP_S3_BUCKET — используем тот же S3-клиент.
 *
 * 2. Bucket бэкапов у ДРУГОГО провайдера / другого аккаунта.
 *    Задаём BACKUP_S3_ENDPOINT + BACKUP_S3_ACCESS_KEY + BACKUP_S3_SECRET_KEY —
 *    создаётся отдельный клиент. Если они не заданы, переиспользуем основной.
 *
 * Достаточно задавать BACKUP_S3_BUCKET. Остальное — опционально.
 */

const BACKUP_BUCKET = process.env.BACKUP_S3_BUCKET || '';
const BACKUP_PREFIX = process.env.BACKUP_S3_PREFIX || 'backups/';

let s3Backup = s3; // по умолчанию — тот же клиент

const hasSeparateBackupCreds =
  Boolean(process.env.BACKUP_S3_ENDPOINT) ||
  Boolean(process.env.BACKUP_S3_ACCESS_KEY) ||
  Boolean(process.env.BACKUP_S3_SECRET_KEY);

if (hasSeparateBackupCreds) {
  // Если задан хотя бы один параметр — считаем, что провайдер/аккаунт
  // отдельный. Остальные значения берём из основных, чтобы не падать
  // при частичном заполнении (например, задан только access key — secret
  // возьмём общий; endpoint оставим общий).
  const backupEndpoint = process.env.BACKUP_S3_ENDPOINT || process.env.MODELS_S3_ENDPOINT;
  const backupRegion = process.env.BACKUP_S3_REGION || process.env.MODELS_S3_REGION || 'ru-1';
  const backupKey = process.env.BACKUP_S3_ACCESS_KEY || process.env.MODELS_S3_ACCESS_KEY;
  const backupSecret = process.env.BACKUP_S3_SECRET_KEY || process.env.MODELS_S3_SECRET_KEY;

  s3Backup = new S3Client({
    endpoint: backupEndpoint,
    region: backupRegion,
    credentials: { accessKeyId: backupKey, secretAccessKey: backupSecret },
    forcePathStyle: true,
  });

  console.log(
    `[S3] Бэкапы: отдельный клиент — endpoint=${backupEndpoint}, ` +
    `bucket=${BACKUP_BUCKET || '—'}, accessKey=${backupKey ? backupKey.slice(0, 6) + '…' : '—'}`
  );
} else {
  console.log(
    `[S3] Бэкапы: используется основной клиент — endpoint=${process.env.MODELS_S3_ENDPOINT || '—'}, ` +
    `bucket=${BACKUP_BUCKET || '—'}`
  );
}

module.exports = {
  s3,
  BUCKET: process.env.MODELS_S3_BUCKET,
  MODELS_PREFIX,

  // Бэкапы
  s3Backup,
  BACKUP_BUCKET,
  BACKUP_PREFIX,
};