const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const config = require('../config');
const stores = require('../config/stores');
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

    return { created, skipped, errors };
  }
}

module.exports = BackupService;