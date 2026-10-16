const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const config = require('../config');
const stores = require('../config/stores');
const { s3Backup, BACKUP_BUCKET, BACKUP_PREFIX } = require('../config/s3');
const {
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const {
  getUsersDB,
  getModelsDB,
  getStoreDB,
  getStatus,
  resolveDbPath,
} = require('../config/database');
const { getNotificationsDB } = require('../config/notificationsDatabase');
const {
  formatLocalTimestamp,
  getVersionedDatedFileName,
  toSqliteLiteral,
} = require('../utils');

// BACKUP_DIR можно переопределить через .env — нужно для тестов, чтобы они
// не трогали реальную папку backups/ и не удаляли прод-бэкапы. По умолчанию —
// backend/backups.
const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(__dirname, '../../backups');

// ---------- Архиватор (archiver v8 — ESM-only, грузим динамически) ----------
let ZipArchiveClass = null;
async function getZipArchiveClass() {
  if (!ZipArchiveClass) {
    const mod = await import('archiver');
    ZipArchiveClass = mod.ZipArchive;
  }
  return ZipArchiveClass;
}

/** `databases_2026-10-16.zip` или `databases_2026-10-16_15-30-00.zip` */
const BACKUP_ZIP_RE = /^databases_(\d{4}-\d{2}-\d{2})(?:_\d{2}-\d{2}-\d{2})?\.zip$/;

/** Упаковать список .db-файлов в один zip. */
async function buildZipArchive(files, zipPath) {
  const ZipArchive = await getZipArchiveClass();
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on('close', () => resolve(zipPath));
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);
    for (const f of files) {
      archive.file(f, { name: path.basename(f) });
    }
    archive.finalize();
  });
}

/** Залить zip на S3 (backup bucket). */
async function uploadToBackupS3(localPath, keyName) {
  const body = fs.readFileSync(localPath);
  const startedAt = Date.now();
  await s3Backup.send(new PutObjectCommand({
    Bucket: BACKUP_BUCKET,
    Key: keyName,
    Body: body,
    ContentType: 'application/zip',
  }));
  const elapsed = Date.now() - startedAt;
  console.log(
    `[Backup] S3 upload ok: s3://${BACKUP_BUCKET}/${keyName} ` +
    `(${(body.length / 1024 / 1024).toFixed(2)} МБ, ${elapsed} мс)`
  );
}

/** Удалить с S3 архивы старше retentionDays. Возвращает число удалённых. */
async function pruneOldS3Backups(retentionDays) {
  if (!BACKUP_BUCKET || retentionDays <= 0) return 0;
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  let token;
  let deleted = 0;
  do {
    const resp = await s3Backup.send(new ListObjectsV2Command({
      Bucket: BACKUP_BUCKET,
      Prefix: BACKUP_PREFIX,
      ContinuationToken: token,
    }));
    const toDelete = [];
    for (const obj of resp.Contents || []) {
      const name = obj.Key ? obj.Key.slice(BACKUP_PREFIX.length) : '';
      const m = BACKUP_ZIP_RE.exec(name);
      if (!m) continue;
      const dateStr = m[1]; // YYYY-MM-DD
      const fileMs = Date.parse(`${dateStr}T00:00:00Z`);
      if (Number.isNaN(fileMs)) continue;
      if (fileMs < cutoffMs) toDelete.push({ Key: obj.Key });
    }
    if (toDelete.length) {
      await s3Backup.send(new DeleteObjectsCommand({
        Bucket: BACKUP_BUCKET,
        Delete: { Objects: toDelete, Quiet: true },
      }));
      deleted += toDelete.length;
      console.log(`[Backup] S3 retention: удалено ${toDelete.length} старых архивов`);
    }
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);

  return deleted;
}

/** Удалить локальные .db-файлы бэкапа старше retentionDays. */
function pruneOldLocalBackups(retentionDays) {
  if (retentionDays <= 0) return 0;
  if (!fs.existsSync(BACKUP_DIR)) return 0;
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  const subdirs = fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'tmp')
    .map((e) => e.name);

  for (const sub of subdirs) {
    const dir = path.join(BACKUP_DIR, sub);
    for (const name of fs.readdirSync(dir)) {
      const fp = path.join(dir, name);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoffMs) {
          fs.unlinkSync(fp);
          deleted++;
        }
      } catch { /* skip */ }
    }
  }
  return deleted;
}

/**
 * Проверяет, что созданный файл — читаемая БД SQLite (PRAGMA quick_check).
 * Файл открывается ТОЛЬКО на чтение: проверка не должна менять бэкап.
 */
function quickCheck(filePath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) return reject(openErr);
      db.get('PRAGMA quick_check', (err, row) => {
        db.close(() => { });
        if (err) return reject(err);
        resolve(row ? String(Object.values(row)[0]) : 'unknown');
      });
    });
  });
}

/**
 * Делает консистентный снимок ОДНОЙ БД через VACUUM INTO и проверяет
 * целостность. Использует УЖЕ ОТКРЫТОЕ соединение приложения (не создаёт
 * своё): второй connection к тому же файлу конкурировал бы за блокировки
 * с обычными запросами API.
 *
 * PRAGMA wal_checkpoint(PASSIVE) перед VACUUM INTO — уменьшает объём WAL,
 * не блокирует писателей (TRUNCATE здесь нельзя: он ждёт всех читателей).
 *
 * @param {object} db - открытое соединение (sqlite)
 * @param {string} backupPath - путь к создаваемому бэкапу
 */
async function createSnapshot(db, backupPath) {
  if (!db) throw new Error('База данных не инициализирована');
  try {
    await db.run('PRAGMA wal_checkpoint(PASSIVE);');
  } catch (err) {
    // Отсутствие WAL — не ошибка; VACUUM INTO сам увидит консистентный снимок
    if (!/wal|no such|not in wal mode/i.test(err.message)) throw err;
  }
  await db.exec(`VACUUM INTO ${toSqliteLiteral(backupPath)}`);
  const check = await quickCheck(backupPath);
  if (check !== 'ok') {
    try { fs.unlinkSync(backupPath); } catch { /* файла может не быть */ }
    throw new Error(`Бэкап не прошёл проверку целостности (quick_check: ${check})`);
  }
}

/**
 * Один бэкап-таск: живой файл + открытое соединение + подпапка внутри backups/.
 *
 * @typedef {Object} BackupTask
 * @property {string} label      - для логов ('users.db', 'store-1.db', ...)
 * @property {string} subdir     - подпапка в backups/ ('users', 'store-1', ...)
 * @property {string} baseName   - базовое имя файла ('users', 'store-1', ...)
 * @property {string} livePath   - абсолютный путь к живой БД
 * @property {object} db         - открытое соединение
 */

class BackupService {
  /**
   * Собирает список задач бэкапа: users.db, models.db, notifications.db и все
   * store-N.db. Пропускает те, чей живой файл или соединение недоступны.
   * @returns {BackupTask[]}
   */
  static _collectTasks() {
    const tasks = [];

    // users.db
    try {
      const status = getStatus();
      tasks.push({
        label: 'users.db',
        subdir: 'users',
        baseName: 'users',
        livePath: status.usersDb.path,
        db: getUsersDB(),
      });
    } catch (err) {
      console.warn('[Backup] users.db недоступна:', err.message);
    }

    // models.db
    try {
      const status = getStatus();
      tasks.push({
        label: 'models.db',
        subdir: 'models',
        baseName: 'models',
        livePath: status.modelsDb.path,
        db: getModelsDB(),
      });
    } catch (err) {
      console.warn('[Backup] models.db недоступна:', err.message);
    }

    // notifications.db
    try {
      const notifPath = resolveDbPath(config.notificationsDbPath);
      tasks.push({
        label: 'notifications.db',
        subdir: 'notifications',
        baseName: 'notifications',
        livePath: notifPath,
        db: getNotificationsDB(),
      });
    } catch (err) {
      console.warn('[Backup] notifications.db недоступна:', err.message);
    }

    // store-N.db
    for (const storeId of stores.getStoreIds()) {
      const store = stores.getStore(storeId);
      try {
        const livePath = resolveDbPath(store.dbPath);
        tasks.push({
          label: `store-${storeId}.db`,
          subdir: `store-${storeId}`,
          baseName: `store-${storeId}`,
          livePath,
          db: getStoreDB(storeId),
        });
      } catch (err) {
        console.warn(`[Backup] store-${storeId}.db недоступна:`, err.message);
      }
    }

    return tasks;
  }

  /**
   * Создаёт бэкапы ВСЕХ БД приложения.
   *
   * Папки per-DB (backups/users/, backups/models/, backups/store-1/, ...),
   * чтобы бэкап одного магазина можно было чинить/восстанавливать, не трогая
   * остальные.
   *
   * @param {{ includeTime?: boolean }} options
   *   includeTime=true  — ручной бэкап: имя с локальным временем (уникальное);
   *   includeTime=false — ежедневный: имя только с датой; если за сегодня
   *                       уже есть — пропускаем (идемпотентно).
   * @returns {Promise<{created: string[], skipped: string[], errors: {label: string, message: string}[]}>}
   */
  static async createDbBackup({ includeTime = false } = {}) {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      console.log(`[Backup] Создана папка бэкапов: ${BACKUP_DIR}`);
    }

    const tasks = this._collectTasks();
    const created = [];
    const skipped = [];
    const errors = [];

    const ts = formatLocalTimestamp();          // '2026-10-07_13-45-12'
    const datePart = includeTime ? ts : ts.slice(0, 10); // '2026-10-07'

    for (const task of tasks) {
      // Пропускаем задачу, если живой файл не найден (например, БД ещё не создана)
      if (!fs.existsSync(task.livePath)) {
        console.log(`[Backup] ${task.label}: живой файл не найден (${task.livePath}), пропускаем`);
        skipped.push(task.label);
        continue;
      }

      const dir = path.join(BACKUP_DIR, task.subdir);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const fileName = getVersionedDatedFileName(task.baseName, 'db', datePart);
      const backupPath = path.join(dir, fileName);

      // Ежедневный бэкап за сегодня не пересоздаём
      if (!includeTime && fs.existsSync(backupPath)) {
        console.log(`[Backup] ${task.label}: бэкап за сегодня уже есть (${backupPath})`);
        skipped.push(task.label);
        continue;
      }

      try {
        await createSnapshot(task.db, backupPath);
        const size = fs.statSync(backupPath).size;
        console.log(
          `[Backup] ${task.label}: бэкап создан (VACUUM INTO, quick_check: ok) — ${backupPath} (${size} Б)`
        );
        created.push(backupPath);
      } catch (err) {
        // Неудачный снимок мог остаться частично записанным — убираем мусор.
        try { fs.unlinkSync(backupPath); } catch { /* файла может не быть */ }
        console.error(`[Backup] ${task.label}: ошибка — ${err.message}`);
        errors.push({ label: task.label, message: err.message });
      }
    }

    // ========== S3: упаковать и залить ==========
    if (config.backup.s3Enabled && created.length) {
      if (!BACKUP_BUCKET) {
        console.warn(
          '[Backup] BACKUP_S3_ENABLED=true, но BACKUP_S3_BUCKET не задан — S3-выгрузка пропущена'
        );
      } else {
        const tmpDir = path.join(BACKUP_DIR, 'tmp');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        // Имя: databases_YYYY-MM-DD.zip (ежедневный) или
        // databases_YYYY-MM-DD_HH-MM-SS.zip (ручной, includeTime=true).
        const zipName = includeTime
          ? `databases_${ts}.zip`              // ts = '2026-10-16_15-30-00'
          : `databases_${ts.slice(0, 10)}.zip`;
        const keyName = `${BACKUP_PREFIX}${zipName}`;
        const tmpZip = path.join(tmpDir, zipName);

        try {
          await buildZipArchive(created, tmpZip);
          const zipSize = fs.statSync(tmpZip).size;
          console.log(
            `[Backup] ZIP собран: ${path.basename(tmpZip)} ` +
            `(${created.length} БД, ${(zipSize / 1024 / 1024).toFixed(2)} МБ)`
          );
          await uploadToBackupS3(tmpZip, keyName);
        } catch (err) {
          console.error('[Backup] S3-выгрузка не удалась:', err.message);
          errors.push({ label: 's3-upload', message: err.message });
        } finally {
          try { fs.unlinkSync(tmpZip); } catch { /* ok */ }
        }
      }
    }

    // ========== Retention ==========
    if (config.backup.s3Enabled) {
      try {
        await pruneOldS3Backups(config.backup.s3RetentionDays);
      } catch (err) {
        console.warn('[Backup] S3 retention не сработал:', err.message);
      }
    }
    try {
      const n = pruneOldLocalBackups(config.backup.localRetentionDays);
      if (n > 0) console.log(`[Backup] Локально удалено старых файлов: ${n}`);
    } catch (err) {
      console.warn('[Backup] Локальная retention:', err.message);
    }

    return { created, skipped, errors };
  }
}

module.exports = BackupService;