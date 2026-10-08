/**
 * createAccount.js — создать аккаунт в БД веб-версии в обход регистрации.
 *
 * Работает так же, как кнопка «Создать аккаунт» в админке
 * (AuthService.adminRegister): email подтверждается сразу (email_verified = 1),
 * код не генерируется, письмо не отправляется — аккаунт активен и готов к входу.
 *
 * MULTISTORE:
 *   • users.db — общий глобальный пользователь (role = 'user' или 'god');
 *   • user_stores — per-store роль для магазинов из ACCOUNT.storeIds;
 *   • в каждом магазине пользователь может иметь разную роль.
 *
 * Запуск (из корня проекта — там же, где backend/, frontend/, migration/):
 *     node createAccount.js
 *
 * ⚠️  Перед запуском поменяйте значения в блоке ACCOUNT ниже.
 */

// =====================================================================
//  НАСТРОЙКИ АККАУНТА — правьте только этот блок
// =====================================================================
const ACCOUNT = {
  username: 'XXX',
  email: 'xxx@xxx.xx',
  password: 'xXx',
  name: '',                      // имя для Персонала; '' -> как логин
  displayName: '',               // отображаемое имя в Профиле; '' -> как логин
  phone: '',
  capacity: 1337,                   // число принтеров (целое >= 1)
  earningsFactor: 999.99,           // коэффициент заработка (per-store)

  // Роль в магазинах (per-store, user_stores.role):
  //   'employee' | 'moderator' | 'admin' — добавит запись в user_stores;
  //   null                               — глобальный user БЕЗ записи в user_stores
  //                                         (обычный пользователь, может логиниться,
  //                                          но /api/user/* и /api/admin/* вернут 403);
  //   'god'                              — глобально role='god' + во всех магазинах god
  //                                         (нужен OPTIONS.allowGodRole = true).
  storeRole: 'admin',

  // Магазины, в которые добавляем пользователя.
  //   [] — все магазины из .env.storeN;
  //   ['1'] или ['1','2'] — только указанные.
  // Игнорируется, если storeRole === null (пользователь без записи в user_stores).
  storeIds: [],

  takingOrders: true,
};

const OPTIONS = {
  // false — если логин/email уже занят, скрипт сообщит об ошибке;
  // true  — обновит пароль, роль и данные уже существующего аккаунта.
  updateIfExists: false,

  // Разрешить выдачу role='god' (Создатель). Обычно назначается только
  // синхронизацией из Excel по GOD_EMAIL/GOD_ID из .env. true — осознанный
  // обход правила (например, первичная настройка сервера).
  allowGodRole: false,
};
// =====================================================================

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const BACKEND_DIR = path.join(__dirname, 'backend');
if (!fs.existsSync(path.join(BACKEND_DIR, 'package.json'))) {
  console.error(`❌ Рядом со скриптом нет папки backend/: ${BACKEND_DIR}`);
  console.error('   Положите createAccount.js в корень проекта (на уровень backend/ и frontend/).');
  process.exit(1);
}
const backendRequire = createRequire(path.join(BACKEND_DIR, 'package.json'));

backendRequire('dotenv').config({ path: path.join(BACKEND_DIR, '.env') });

const bcrypt = backendRequire('bcrypt');
const stores = backendRequire('./src/config/stores');
const { initDB, closeAll, getUsersDB, getStoreDB } = backendRequire('./src/config/database');
const User = backendRequire('./src/models/User');
const UserStore = backendRequire('./src/models/UserStore');
const AuthService = backendRequire('./src/services/AuthService');

const ROLE_WHITELIST = ['employee', 'moderator', 'admin'];
const PLACEHOLDER_PASSWORD = 'ChangeMe_123';

function normalizeAccount() {
  const cfg = ACCOUNT || {};
  const str = (v) => String(v === undefined || v === null ? '' : v).trim();
  const isBlank = (v) => v === undefined || v === null || v === '';

  const storeRoleRaw = cfg.storeRole;
  const storeRole = storeRoleRaw === null || storeRoleRaw === undefined
    ? null
    : String(storeRoleRaw).toLowerCase() || null;

  const storeIds = Array.isArray(cfg.storeIds)
    ? cfg.storeIds.map((s) => String(s)).filter(Boolean)
    : [];

  return {
    username: str(cfg.username),
    email: str(cfg.email),
    password: typeof cfg.password === 'string' ? cfg.password : String(cfg.password || ''),
    name: str(cfg.name),
    displayName: str(cfg.displayName),
    phone: str(cfg.phone),
    capacity: isBlank(cfg.capacity) ? 1 : Number(cfg.capacity),
    earningsFactor: isBlank(cfg.earningsFactor) ? 1.0 : Number(cfg.earningsFactor),
    storeRole,
    storeIds,
    takingOrders: cfg.takingOrders !== false,
  };
}

function validateConfig(payload) {
  if (!payload.username) throw new Error('В блоке ACCOUNT не заполнен username');
  if (!payload.email) throw new Error('В блоке ACCOUNT не заполнен email');
  if (!payload.password) throw new Error('В блоке ACCOUNT не заполнен password');

  if (payload.storeRole === 'god' && !OPTIONS.allowGodRole) {
    throw new Error(
      "Роль 'god' (Создатель) вручную не выдаётся: её назначает синхронизация из Excel по GOD_EMAIL/GOD_ID из .env.\n" +
      '   Нужно именно так — поставьте OPTIONS.allowGodRole = true.\n' +
      `   Текущий GOD_EMAIL в .env: ${process.env.GOD_EMAIL || '(не задан)'}`
    );
  }
  if (payload.storeRole !== null && payload.storeRole !== 'god' && !ROLE_WHITELIST.includes(payload.storeRole)) {
    throw new Error(
      `Недопустимая роль «${payload.storeRole}». Доступно: ${ROLE_WHITELIST.join(', ')}, null (обычный user), 'god' (с OPTIONS.allowGodRole)`
    );
  }

  // Мягкая валидация (как у админской регистрации)
  const errors = AuthService.validateAdminRegisterData({
    username: payload.username,
    email: payload.email,
    password: payload.password,
    capacity: payload.capacity,
    role: payload.storeRole && payload.storeRole !== 'god' ? payload.storeRole : undefined,
  });
  if (errors.length > 0) throw new Error(errors.join('. '));

  // Магазины: либо пусто (все), либо валидные id из реестра
  const available = stores.getStoreIds();
  if (!available.length) {
    throw new Error('В проекте не зарегистрировано ни одного магазина (.env.storeN)');
  }
  if (payload.storeIds.length) {
    const unknown = payload.storeIds.filter((s) => !available.includes(s));
    if (unknown.length) {
      throw new Error(
        `Магазин(ы) не найдены: ${unknown.join(', ')}. Доступные: ${available.join(', ')}`
      );
    }
  }
}

function printWarnings(payload) {
  if (payload.password.length < 8) {
    console.log(`⚠️  Пароль короче 8 символов (${payload.password.length})`);
  }
  if (payload.password === PLACEHOLDER_PASSWORD) {
    console.log('⚠️  Пароль-заглушка из шаблона не изменён');
  }
  if (payload.username.length < 6) {
    console.log('⚠️  Логин короче 6 символов — обычная регистрация такие не пропускает (админ может)');
  }
}

async function waitForDatabaseUnlock(dbPath) {
  const sqlite3 = backendRequire('sqlite3');
  if (!fs.existsSync(dbPath)) return; // файла нет — блокировки быть не может
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

(async () => {
  const payload = normalizeAccount();
  validateConfig(payload);

  // Определяем целевые магазины
  const allStoreIds = stores.getStoreIds();
  const targetStores = payload.storeRole === null
    ? []
    : (payload.storeIds.length ? payload.storeIds : allStoreIds);

  console.log('=== Создание аккаунта в обход регистрации (как adminRegister) ===');
  console.log(`👤 Логин: ${payload.username}`);
  console.log(`📧 Email: ${payload.email}`);
  console.log(`🎭 Роль:  ${payload.storeRole === null ? 'user (без привязки к магазину)' : payload.storeRole}`);
  if (targetStores.length) {
    console.log(`🏬 Магазины: ${targetStores.join(', ')}`);
  }
  printWarnings(payload);
  console.log('');

  // Ждём снятия блокировки users.db (сервер может писать сейчас)
  await waitForDatabaseUnlock(path.join(BACKEND_DIR, 'users.db')).catch(() => { });
  await initDB();

  const usersDb = getUsersDB();
  try { usersDb.configure('busyTimeout', 5000); } catch { /* ok */ }

  console.log(`📁 users.db: ${usersDb.config?.filename || '(ok)'}`);
  console.log('');

  // Проверяем коллизии username/email
  const byUsername = await User.getByUsername(payload.username);
  const byEmail = await User.getByEmail(payload.email);
  if (byUsername && byEmail && byUsername.id !== byEmail.id) {
    throw new Error(
      `Логин «${payload.username}» (id=${byUsername.id}) и email «${payload.email}» (id=${byEmail.id}) ` +
      'принадлежат разным аккаунтам'
    );
  }
  const existing = byUsername || byEmail;

  let user;
  const globalRole = payload.storeRole === 'god' ? 'god' : 'user';

  if (existing) {
    if (!OPTIONS.updateIfExists) {
      const what = byUsername ? `Логин «${payload.username}»` : `Email «${payload.email}»`;
      throw new Error(
        `${what} уже занят аккаунтом id=${existing.id} (${existing.username} / ${existing.email}).\n` +
        '   Поставьте OPTIONS.updateIfExists = true, чтобы обновить пароль и данные.'
      );
    }
    console.log(`♻️  Аккаунт уже есть (id=${existing.id}) — обновляем пароль и данные`);
    const passwordHash = await bcrypt.hash(payload.password, 10);
    await usersDb.run(
      'UPDATE users SET password_hash = ?, email_verified = 1, updated_at = ? WHERE id = ?',
      passwordHash, Date.now(), existing.id
    );
    user = await User.update(existing.id, {
      name: payload.name || payload.username,
      display_name: payload.displayName || payload.username,
      phone: payload.phone,
      capacity: payload.capacity,
      role: globalRole,
      taking_orders: payload.takingOrders ? 1 : 0,
      email_verified: 1,
    });
  } else {
    console.log('🆕 Создаём аккаунт (email подтверждён сразу, письмо не отправляется)');
    // adminRegister создаёт User + UserStore для конкретного магазина.
    // Если магазинов несколько — используем первый, остальные добавим сами.
    // Если storeRole === null — создаём User напрямую без записи в user_stores.
    if (payload.storeRole === null) {
      const passwordHash = await bcrypt.hash(payload.password, 10);
      user = await User.create({
        username: payload.username,
        email: payload.email,
        passwordHash,
        name: payload.name || payload.username,
        displayName: payload.displayName || payload.username,
        phone: payload.phone,
        capacity: payload.capacity,
        role: 'user',
        emailVerified: 1,
      });
      await User.update(user.id, {
        taking_orders: payload.takingOrders ? 1 : 0,
      });
    } else {
      // Есть магазин — идём через adminRegister (единая логика с API)
      user = await AuthService.adminRegister({
        username: payload.username,
        email: payload.email,
        password: payload.password,
        name: payload.name,
        phone: payload.phone,
        capacity: payload.capacity,
        earningsFactor: payload.earningsFactor,
        role: payload.storeRole === 'god' ? undefined : payload.storeRole,
        storeId: targetStores[0],
      });
      // Обновляем глобальные поля, которые adminRegister не покрывает
      const extra = {};
      if (payload.displayName && payload.displayName !== user.display_name) {
        extra.display_name = payload.displayName;
      }
      if (!payload.takingOrders) extra.taking_orders = 0;
      if (payload.storeRole === 'god') extra.role = 'god';
      if (Object.keys(extra).length) {
        user = await User.update(user.id, extra);
      }
    }
  }

  // Досоздаём записи в остальных магазинах
  if (payload.storeRole !== null) {
    for (const sid of targetStores) {
      const existingRecord = await UserStore.get(user.id, sid);
      if (existingRecord) {
        // Обновляем роль/фактор/статус
        await UserStore.upsert(user.id, sid, {
          role: payload.storeRole,
          earnings_factor: payload.earningsFactor,
          is_fired: 0,
          was_employee: 1,
        });
      } else {
        await UserStore.upsert(user.id, sid, {
          role: payload.storeRole,
          earnings_factor: payload.earningsFactor,
          is_fired: 0,
          was_employee: 1,
        });
      }
    }
  }

  console.log('');
  console.log(`✅ Аккаунт готов: ${user.username} (id=${user.id})`);
  console.log(`   email:            ${user.email} (подтверждён: ${user.email_verified ? 'да' : 'нет'})`);
  console.log(`   глобальная роль:  ${user.role}`);
  if (payload.storeRole !== null) {
    for (const sid of targetStores) {
      const rec = await UserStore.get(user.id, sid);
      console.log(`   в магазине ${sid}:   роль=${rec?.role}, коэффициент=${rec?.earnings_factor}`);
    }
  } else {
    console.log('   привязки к магазинам: нет (обычный user)');
  }
  console.log('');
  console.log(`🔑 Вход: логин «${user.username}» или email + пароль из блока ACCOUNT`);
  if (user.role === 'god') {
    console.log('⚠️  Выдана роль god (Создатель)');
  }
  console.log('🧹 Пароль лежит в этом файле открытым текстом — при необходимости смените/уберите его');
})().catch((err) => {
  console.error('');
  if (/SQLITE_BUSY|database is locked/i.test(err.message)) {
    console.error('❌ БД занята (сервер/синхронизация пишет данные).');
    console.error('   Подождите пару секунд и запустите снова.');
  } else {
    console.error(`❌ ${err.message}`);
  }
  process.exitCode = 1;
}).finally(async () => {
  try { await closeAll(); } catch { /* ok */ }
});