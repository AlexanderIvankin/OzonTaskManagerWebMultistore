/**
 * createAccount.js — создать аккаунт в БД веб-версии в обход регистрации.
 *
 * Работает так же, как кнопка «Создать аккаунт» в админке
 * (AuthService.adminRegister): email подтверждается сразу (email_verified = 1),
 * код не генерируется, письмо не отправляется — аккаунт активен и готов к входу.
 *
 * Запуск (на сервере, из любой папки — из корня проекта или из backend/):
 *     node createAccount.js
 *
 * Скрипт сам читает backend/.env (DB_PATH, BOT_VERSION, JWT_SECRET, GOD_* ...)
 * и пишет в ту же БД, что и сервер: bot_web-<BOT_VERSION>.db.
 *
 * ⚠️  Перед запуском поменяйте значения в блоке ACCOUNT ниже.
 */

// =====================================================================
//  НАСТРОЙКИ АККАУНТА — правьте только этот блок
// =====================================================================
const ACCOUNT = {
  username: 'XXX',            // логин (вход по логину или email)
  email: 'xxx@xxx.xx',   // email (сразу считается подтверждённым)
  password: 'xXx',      // пароль в открытом виде (в БД уйдёт bcrypt-хеш)
  name: 'XX',           // имя для Персонала; '' -> как логин
  displayName: '',               // отображаемое имя в Профиле; '' -> как логин
  phone: '',                     // телефон; можно ''
  capacity: 1,                   // количество принтеров (целое >= 1)
  earningsFactor: 999.99,           // коэффициент заработка
  role: 'admin',                 // 'user' | 'employee' | 'moderator' | 'admin'
  takingOrders: false,            // принимает ли заказы (false -> taking_orders = 0)
};

const OPTIONS = {
  // false — если логин/email уже занят, скрипт сообщит об этом и завершится с ошибкой;
  // true  — обновит пароль, роль и данные уже существующего аккаунта.
  updateIfExists: false,
  // Роль 'god' (Создатель) вручную не выдаётся (см. AuthService): её назначает только
  // синхронизация из Excel по GOD_EMAIL/GOD_ID из .env. true — разрешить 'god' здесь
  // (осознанный обход правила, например для первичной настройки сервера).
  allowGodRole: false,
};
// =====================================================================

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// Корень проекта = папка этого файла (там же, где backend/ и frontend/)
const BACKEND_DIR = path.join(__dirname, 'backend');

if (!fs.existsSync(path.join(BACKEND_DIR, 'package.json'))) {
  console.error(`❌ Рядом со скриптом нет папки backend/: ${BACKEND_DIR}`);
  console.error('   Положите createAccount.js в корень проекта (на уровень backend/ и frontend/).');
  process.exit(1);
}

// require «как из папки backend/»: так находятся backend/node_modules,
// и модули сервера резолвятся точно так же, как при обычном запуске
const backendRequire = createRequire(path.join(BACKEND_DIR, 'package.json'));

// .env сервера читаем ДО загрузки модулей: config/database.js берёт
// DB_PATH и BOT_VERSION в момент require()
backendRequire('dotenv').config({ path: path.join(BACKEND_DIR, '.env') });

// DB_PATH в .env относительный (./bot_web.db) и считается от рабочей папки,
// поэтому приводим его к абсолютному пути внутри backend/ — как при `npm start` из backend/
const rawDbPath = process.env.DB_PATH || './bot_web.db';
process.env.DB_PATH = path.isAbsolute(rawDbPath) ? rawDbPath : path.resolve(BACKEND_DIR, rawDbPath);

const bcrypt = backendRequire('bcrypt');
const { initDB, getDB, getDBPath } = backendRequire('./src/config/database');
const User = backendRequire('./src/models/User');
const AuthService = backendRequire('./src/services/AuthService');

const ROLE_WHITELIST = ['user', 'employee', 'moderator', 'admin'];
const PLACEHOLDER_PASSWORD = 'ChangeMe_123';

/**
 * Приводит блок ACCOUNT к аккуратному виду (строки/числа) — то, что
 * уйдёт в AuthService.adminRegister / User.update.
 */
function normalizeAccount() {
  const cfg = ACCOUNT || {};
  const str = (v) => String(v === undefined || v === null ? '' : v).trim();
  const isBlank = (v) => v === undefined || v === null || v === '';

  return {
    username: str(cfg.username),
    email: str(cfg.email),
    password: typeof cfg.password === 'string' ? cfg.password : String(cfg.password || ''),
    name: str(cfg.name),
    displayName: str(cfg.displayName),
    phone: str(cfg.phone),
    // Пустое capacity -> 1 (как в adminRegister)
    capacity: isBlank(cfg.capacity) ? 1 : cfg.capacity,
    earningsFactor: isBlank(cfg.earningsFactor) ? 1.0 : Number(cfg.earningsFactor),
    role: (str(cfg.role) || 'employee').toLowerCase(),
    takingOrders: cfg.takingOrders !== false,
  };
}

/**
 * Проверки, которые не покрывает AuthService: заполненность блока ACCOUNT
 * и правила для роли 'god'. Обычная валидация — та же, что у админа в API
 * (AuthService.validateAdminRegisterData).
 */
function validateConfig(payload) {
  if (!payload.username) throw new Error('В блоке ACCOUNT не заполнен username');
  if (!payload.email) throw new Error('В блоке ACCOUNT не заполнен email');
  if (!payload.password) throw new Error('В блоке ACCOUNT не заполнен password');

  if (payload.role === 'god' && !OPTIONS.allowGodRole) {
    throw new Error(
      "Роль 'god' (Создатель) вручную не выдаётся: её назначает синхронизация из Excel по GOD_EMAIL/GOD_ID из .env.\n" +
        '   Нужно именно так — поставьте OPTIONS.allowGodRole = true (осознанный обход правила).\n' +
        `   Текущий GOD_EMAIL в .env: ${process.env.GOD_EMAIL || '(не задан)'} — аккаунт с таким email\n` +
        "   получит роль 'god' автоматически после ближайшей синхронизации сотрудников."
    );
  }
  if (payload.role !== 'god' && !ROLE_WHITELIST.includes(payload.role)) {
    throw new Error(
      `Недопустимая роль «${payload.role}». Доступно: ${ROLE_WHITELIST.join(', ')} (плюс 'god' с OPTIONS.allowGodRole)`
    );
  }

  // Та же мягкая валидация, что у админской регистрации: логин/пароль от 1 символа,
  // email — формат *@*.*, capacity — положительное целое, роль — из белого списка
  const errors = AuthService.validateAdminRegisterData({
    username: payload.username,
    email: payload.email,
    password: payload.password,
    capacity: payload.capacity,
    role: payload.role === 'god' ? undefined : payload.role,
  });
  if (errors.length > 0) throw new Error(errors.join('. '));
}

/**
 * Предупреждения: созданию не мешают, но о них стоит знать.
 */
function printWarnings(payload) {
  if (payload.password.length < 8) {
    console.log(`⚠️  Пароль короче 8 символов (${payload.password.length}) — для боевого сервера лучше длиннее`);
  }
  if (payload.password === PLACEHOLDER_PASSWORD) {
    console.log('⚠️  Похоже, пароль-заглушка из шаблона не изменён — поменяйте его в блоке ACCOUNT');
  }
  if (payload.username.length < 6) {
    console.log('⚠️  Логин короче 6 символов — обычная регистрация такие не пропускает (админ создавать может)');
  }
}

/**
 * Ждём снятия блокировки БД. sqlite3 по умолчанию не ждёт вообще, а работающий
 * сервер может прямо сейчас писать в базу (синхронизация заказов, расчёт и т.п.).
 * Отдельным коротким соединением с busyTimeout 5 сек «пробуем» взять write-lock:
 * если он занят — подождём, если взят — сразу отпускаем и работаем дальше.
 *
 * NB: если файла БД ещё нет, probe создаст пустой файл — дальше config/database.js
 * сам достроит всё нужное (таблицы, копию с суффиксом BOT_VERSION).
 */
async function waitForDatabaseUnlock(dbPath) {
  const sqlite3 = backendRequire('sqlite3');
  const probe = new sqlite3.Database(dbPath);
  try {
    await new Promise((resolve, reject) => {
      probe.configure('busyTimeout', 5000);
      probe.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE; COMMIT;', (err) => (err ? reject(err) : resolve()));
    });
  } finally {
    await new Promise((resolve) => probe.close(() => resolve()));
  }
}

async function main() {
  const payload = normalizeAccount();
  validateConfig(payload);

  console.log('=== Создание аккаунта в обход регистрации (как adminRegister) ===');
  console.log(`👤 Логин: ${payload.username}`);
  console.log(`📧 Email: ${payload.email}`);
  console.log(`🎭 Роль:  ${payload.role}`);
  printWarnings(payload);
  console.log('');

  const dbExistedBefore = fs.existsSync(process.env.DB_PATH);
  // Ждём, если сервер сейчас пишет в БД (иначе initDB/INSERT упадут с SQLITE_BUSY)
  await waitForDatabaseUnlock(process.env.DB_PATH);
  await initDB();
  console.log(`📁 БД: ${getDBPath()}${dbExistedBefore ? '' : ' (файла не было — база создана заново)'}`);
  console.log('');

  const db = getDB();
  try {
    // Если сервер сейчас работает и держит БД — подождём снятие блокировки до 5 сек
    db.configure('busyTimeout', 5000);
  } catch (err) {
    console.log(`ℹ️  busyTimeout не применён: ${err.message}`);
  }

  // Проверяем, не занят ли логин/email (как User.create, но с понятным сообщением)
  const byUsername = await User.getByUsername(payload.username);
  const byEmail = await User.getByEmail(payload.email);
  if (byUsername && byEmail && byUsername.id !== byEmail.id) {
    throw new Error(
      `Логин «${payload.username}» (id=${byUsername.id}) и email «${payload.email}» (id=${byEmail.id}) ` +
        'принадлежат разным аккаунтам — исправьте username или email в блоке ACCOUNT'
    );
  }
  const existing = byUsername || byEmail;

  let user;
  if (existing) {
    if (!OPTIONS.updateIfExists) {
      const what = byUsername ? `Логин «${payload.username}»` : `Email «${payload.email}»`;
      throw new Error(
        `${what} уже занят аккаунтом id=${existing.id} (${existing.username} / ${existing.email}).\n` +
          '   Поставьте OPTIONS.updateIfExists = true, чтобы обновить пароль и данные этого аккаунта,\n' +
          '   или укажите в блоке ACCOUNT другой логин/email.'
      );
    }
    console.log(`♻️  Аккаунт уже есть (id=${existing.id}, ${existing.username}) — обновляем пароль и данные`);
    await User.setPasswordHash(existing.id, await bcrypt.hash(payload.password, 10));
    user = await User.update(existing.id, {
      name: payload.name || payload.username,
      display_name: payload.displayName || payload.username,
      phone: payload.phone,
      capacity: Number(payload.capacity),
      earnings_factor: Number(payload.earningsFactor),
      role: payload.role,
      taking_orders: payload.takingOrders ? 1 : 0,
      email_verified: 1,
    });
  } else {
    console.log('🆕 Создаём аккаунт (email подтверждён сразу, письмо не отправляется)');
    user = await AuthService.adminRegister({
      username: payload.username,
      email: payload.email,
      password: payload.password,
      name: payload.name,
      phone: payload.phone,
      capacity: payload.capacity,
      earningsFactor: payload.earningsFactor,
      // 'god' не входит в белый список adminRegister — доставляем роль отдельно
      role: payload.role === 'god' ? undefined : payload.role,
    });
    const extra = {};
    if (payload.role === 'god') extra.role = 'god';
    if (payload.displayName && payload.displayName !== user.display_name) extra.display_name = payload.displayName;
    if (!payload.takingOrders) extra.taking_orders = 0;
    if (Object.keys(extra).length > 0) {
      user = await User.update(user.id, extra);
    }
  }

  console.log('');
  console.log(`✅ Аккаунт готов: ${user.username} (id=${user.id})`);
  console.log(`   email:            ${user.email} (подтверждён: ${user.email_verified ? 'да' : 'нет'})`);
  console.log(`   роль:             ${user.role}`);
  console.log(`   имя (Персонал):   ${user.name}`);
  console.log(`   отображаемое имя: ${user.display_name || '—'}`);
  console.log(`   телефон:          ${user.phone || '—'}`);
  console.log(`   принтеров:        ${user.capacity} (коэффициент ${user.earnings_factor})`);
  console.log(`   принимает заказы: ${user.taking_orders ? 'да' : 'нет'}`);
  console.log('');
  console.log(`🔑 Вход: логин «${user.username}» или email + пароль из блока ACCOUNT`);
  if (user.role === 'god') {
    console.log('⚠️  Выдана роль god (Создатель) — доступ ко всему, используйте осознанно');
  }
  console.log('🧹 Пароль лежит в этом файле открытым текстом — при необходимости смените/уберите его');
}

main()
  .catch((err) => {
    console.error('');
    if (/SQLITE_BUSY|database is locked/i.test(err.message)) {
      console.error('❌ БД занята другой операцией (сервер/синхронизация записывает данные).');
      console.error('   Подождите пару секунд и запустите скрипт снова.');
    } else {
      console.error(`❌ ${err.message}`);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const db = getDB(); // бросит, если БД не инициализирована — это нормально
      if (db) await db.close();
    } catch (err) {
      /* БД не открывалась — закрывать нечего */
    }
  });
