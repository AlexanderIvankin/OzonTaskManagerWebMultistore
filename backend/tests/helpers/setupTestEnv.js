// tests/helpers/setupTestEnv.js
//
// Единая точка настройки временного multistore-окружения для smoke-тестов.
//
// Временные файлы кладутся в backend/tests/tmp/ — там их не видно в корне,
// они не мешают и легко игнорируются в .gitignore.
//
// ВАЖНО: setup() нужно вызывать ДО require('../src/config/database'):
// модуль читает env-переменные и stores.js на этапе загрузки.
//
// ЗАЩИТА .env.storeN ОТ ПЕРЕТИРАНИЯ:
//   Изначально backup .env.storeN хранился в памяти, но некоторые тесты
//   вызывают process.exit(0) внутри try — finally не выполняется, файл
//   остаётся перезаписанным. Следующий setup сохранял битый файл как
//   «оригинал» и восстанавливал его же — ошибка накапливалась.
//   Теперь backup персистентный (tests/tmp/env-backups/.env.storeN.orig):
//     • setup сначала восстанавливает из прошлого незакрытого прогона;
//     • затем сохраняет текущий .env.storeN в backup-файл;
//     • cleanup восстанавливает из backup-файла и удаляет его;
//     • process.on('exit'/'SIGINT'/'SIGTERM') даёт страховку на аварийный
//       выход (например, process.exit() внутри try-блока).

const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '../..');
const TMP_DIR = path.join(BACKEND_DIR, 'tests', 'tmp');
const ENV_BACKUP_DIR = path.join(TMP_DIR, 'env-backups');

const cleanupFns = [];
let exitHandlersRegistered = false;

function ensureDirs() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  if (!fs.existsSync(ENV_BACKUP_DIR)) fs.mkdirSync(ENV_BACKUP_DIR, { recursive: true });
}

function runAllCleanups() {
  while (cleanupFns.length) {
    const fn = cleanupFns.pop();
    try { fn(); } catch (e) { console.warn('[TestEnv] cleanup:', e.message); }
  }
}

function registerExitHandlers() {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;
  // process.on('exit') срабатывает и при process.exit(0) внутри try.
  // Только синхронные операции — fs.writeFileSync/unlinkSync подходят.
  process.on('exit', runAllCleanups);
  process.on('SIGINT', () => { runAllCleanups(); process.exit(130); });
  process.on('SIGTERM', () => { runAllCleanups(); process.exit(143); });
}

function setup(storeId = '1', options = {}) {
  const { ozonMock = false } = options;
  ensureDirs();

  const sid = String(storeId);
  const suffix = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // --- 1. Временные файлы БД в tests/tmp/ ---
  const usersDbPath = path.join(TMP_DIR, `${suffix}-users.db`);
  const modelsDbPath = path.join(TMP_DIR, `${suffix}-models.db`);
  const notificationsDbPath = path.join(TMP_DIR, `${suffix}-notifications.db`);
  const storeDbPath = path.join(TMP_DIR, `${suffix}-store-${sid}.db`);

  // --- 2. Глобальный .env (process.env) ---
  process.env.USERS_DB_PATH = usersDbPath;
  process.env.MODELS_DB_PATH = modelsDbPath;
  process.env.NOTIFICATIONS_DB_PATH = notificationsDbPath;
  process.env.OZON_MOCK_MODE = ozonMock ? 'true' : 'false';
  process.env.BOT_VERSION = '';
  process.env.GOD_ID = '';
  process.env.GOD_EMAIL = '';
  process.env.BACKUP_DIR = path.join(TMP_DIR, 'backups');

  // --- 3. Временный .env.store<storeId> (персистентный backup) ---
  const storeEnvFile = path.join(BACKEND_DIR, `.env.store${sid}`);
  const backupFile = path.join(ENV_BACKUP_DIR, `.env.store${sid}.orig`);

  // 3a. Если от прошлого (упавшего) прогона остался backup — восстановим ДО
  //     того, как будем читать «оригинал». Так не закрепим битое содержимое.
  if (fs.existsSync(backupFile)) {
    console.warn(
      `[TestEnv] Найден незакрытый backup ${path.basename(backupFile)}. ` +
      `Восстанавливаю .env.store${sid} из него.`
    );
    try {
      const orig = fs.readFileSync(backupFile);
      if (orig.length === 0) {
        try { fs.unlinkSync(storeEnvFile); } catch { /* нет файла */ }
      } else {
        fs.writeFileSync(storeEnvFile, orig);
      }
      fs.unlinkSync(backupFile);
    } catch (e) {
      console.error('[TestEnv] Не удалось восстановить из backup:', e.message);
    }
  }

  // 3b. Сохраняем текущий .env.storeN в backup-файл (или пустой маркер).
  if (fs.existsSync(storeEnvFile)) {
    fs.copyFileSync(storeEnvFile, backupFile);
  } else {
    fs.writeFileSync(backupFile, '');
  }

  // 3c. Пишем временный .env.storeN.
  const relStoreDbPath = path.relative(BACKEND_DIR, storeDbPath).replace(/\\/g, '/');
  fs.writeFileSync(storeEnvFile, [
    `STORE_ID=${sid}`,
    `DB_PATH=${relStoreDbPath}`,
    `CLIENT_ORIGIN=http://localhost:3000`,
    `SUBDOMAIN=shop${sid}`,
    `OZON_CLIENT_ID=test-client-${sid}`,
    `OZON_API_KEY=test-key-${sid}`,
    `FILTER_ORDER_SUFFIX=""`,
    `VAPID_SUBJECT=mailto:test@localhost`,
    `DISABLE_MODELS=false`,
    `CLEAN_PROMOTIONS=false`,
  ].join('\n'));

  // --- 4. Уборка ---
  const cleanupFn = () => {
    // 4a. Восстанавливаем .env.storeN из backup-файла.
    try {
      if (fs.existsSync(backupFile)) {
        const orig = fs.readFileSync(backupFile);
        if (orig.length === 0) {
          try { fs.unlinkSync(storeEnvFile); } catch { /* нет файла */ }
        } else {
          fs.writeFileSync(storeEnvFile, orig);
        }
        fs.unlinkSync(backupFile);
      }
    } catch (e) {
      console.warn('[TestEnv] Ошибка восстановления .env.store:', e.message);
    }

    // 4b. Удаляем временные БД.
    for (const p of [usersDbPath, modelsDbPath, notificationsDbPath, storeDbPath]) {
      for (const s of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(p + s); } catch { /* нет файла */ }
      }
    }

    // 4c. Удаляем тестовые бэкапы БД.
    try {
      const backupsDir = path.join(TMP_DIR, 'backups');
      if (fs.existsSync(backupsDir)) {
        fs.rmSync(backupsDir, { recursive: true, force: true });
      }
    } catch { /* не критично */ }
  };
  cleanupFns.push(cleanupFn);

  // 5. Страховка на аварийный выход (process.exit внутри try, Ctrl+C).
  registerExitHandlers();

  return {
    storeId: sid,
    usersDbPath,
    modelsDbPath,
    notificationsDbPath,
    storeDbPath,
    tmpDir: TMP_DIR,
  };
}

function cleanup() {
  runAllCleanups();
}

module.exports = { setup, cleanup, TMP_DIR };