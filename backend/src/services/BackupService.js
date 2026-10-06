const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { getDB, getDBPath } = require('../config/database');
const {
  formatLocalTimestamp,
  getDbBaseName,
  getVersionedDatedFileName,
  toSqliteLiteral,
} = require('../utils');

const BACKUP_DIR = path.join(__dirname, '../../backups');

/**
 * Проверяет, что созданный файл — читаемая БД SQLite (PRAGMA quick_check).
 * Файл открывается ТОЛЬКО на чтение: проверка не должна менять бэкап.
 * @param {string} filePath
 * @returns {Promise<string>} результат quick_check ('ok' — БД в порядке)
 */
function quickCheck(filePath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) return reject(openErr);
      db.get('PRAGMA quick_check', (err, row) => {
        db.close(() => {});
        if (err) return reject(err);
        resolve(row ? String(Object.values(row)[0]) : 'unknown');
      });
    });
  });
}

/**
 * Делает консистентный снимок живой БД в файл backupPath через VACUUM INTO
 * (SQLite сам пересобирает БД в новый файл) и проверяет его целостность.
 * @param {string} backupPath
 */
async function createSnapshot(backupPath) {
  const db = getDB();
  if (!db) throw new Error('База данных не инициализирована');
  // Синхронизация WAL (если режим когда-нибудь будет включён): на
  // консистентность VACUUM INTO это не влияет — он в любом случае читает все
  // зафиксированные данные, — но уменьшает объём читаемого журнала.
  await db.run('PRAGMA wal_checkpoint;');
  // VACUUM INTO требует литерал пути в SQL (toSqliteLiteral) и падает, если
  // файл назначения уже существует — имя бэкапа всегда уникально/проверено.
  await db.exec(`VACUUM INTO ${toSqliteLiteral(backupPath)}`);
  const check = await quickCheck(backupPath);
  if (check !== 'ok') {
    // Битый бэкап в папке backups хуже, чем его отсутствие: убираем и сообщаем
    try { fs.unlinkSync(backupPath); } catch { /* файла может не быть */ }
    throw new Error(`Бэкап не прошёл проверку целостности (quick_check: ${check})`);
  }
}

/**
 * Сервис для создания бэкапов базы данных.
 *
 * Бэкап = консистентный снимок (VACUUM INTO) — тот же результат, что отдаёт
 * кнопка «Скачать базу данных»: снимок на момент вызова, без freelist и
 * фрагментации, с проверкой целостности. Побайтовое копирование живого файла
 * (fs.copyFileSync) не используется: в режиме rollback-journal оно может
 * поймать БД в середине транзакции (оригиналы страниц ещё лежат в -journal),
 * а при включённом WAL потеряло бы незачекпойнченный хвост.
 */
class BackupService {
  /**
   * Создаёт бэкап базы данных в папку backups.
   * Ежедневный бэкап (includeTime: false) за сегодня не пересоздаётся.
   * @param {{ includeTime?: boolean }} options
   * @returns {Promise<string|null>} путь к бэкапу или null (файл БД не найден)
   */
  static async createDbBackup({ includeTime = false } = {}) {
    // Путь создаваемого бэкапа — нужен и в catch, чтобы убрать недописанный файл
    let backupPath = null;
    try {
      // Создаём папку для бэкапов, если её нет
      if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        console.log(`[Backup] Создана папка бэкапов: ${BACKUP_DIR}`);
      }

      const dbPath = getDBPath();
      if (!fs.existsSync(dbPath)) {
        console.error('[Backup] Файл базы данных не найден:', dbPath);
        return null;
      }

      let backupName;
      if (includeTime) {
        // Ручной бэкап (команда админа): уникальное имя с локальным временем
        // bot_web-1_2026-09-04_13-28-13.db | bot_web_2026-09-04_13-28-13.db
        backupName = getVersionedDatedFileName(getDbBaseName(), 'db', formatLocalTimestamp());
      } else {
        // Ежедневный бэкап (планировщик): только дата, один раз в день.
        // Локальная дата (TIMEZONE), а не UTC: бэкап в 00:00 по Москве
        // должен попадать на сегодняшний день, а не на вчерашний.
        const dateStr = formatLocalTimestamp().slice(0, 10); // YYYY-MM-DD
        // bot_web-1_2026-09-04.db | bot_web_2026-09-04.db
        backupName = getVersionedDatedFileName(getDbBaseName(), 'db', dateStr);
      }
      backupPath = path.join(BACKUP_DIR, backupName);

      // Проверяем существование только для ежедневных бэкапов (без времени)
      if (!includeTime && fs.existsSync(backupPath)) {
        console.log(`[Backup] Бэкап за сегодня уже существует: ${backupPath}`);
        return backupPath;
      }

      await createSnapshot(backupPath);

      const size = fs.statSync(backupPath).size;
      console.log(
        `[Backup] Бэкап создан (VACUUM INTO, quick_check: ok): ${backupPath} (${size} Б)`
      );
      return backupPath;
    } catch (err) {
      // Неудачный снимок мог остаться частично записанным — убираем мусор,
      // чтобы в папке backups не лежал файл, похожий на валидный бэкап
      if (backupPath) {
        try { fs.unlinkSync(backupPath); } catch { /* файла может не быть */ }
      }
      console.error('[Backup] Ошибка создания бэкапа:', err);
      throw err;
    }
  }
}

module.exports = BackupService;