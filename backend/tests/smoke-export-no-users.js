/**
 * Smoke-тест: обычные пользователи (role = 'user') не попадают в Excel-файлы
 * сотрудников и не повышаются до 'employee' серверным файлом
 * (запуск: node tests/smoke-export-no-users.js из папки backend/).
 * Использует временную БД, за собой убирает.
 * Проверяет:
 *   1. exportTeamInfoXlsx (team-info.xlsx): только сотрудники и staff-роли —
 *      обычный 'user' и уволенный ex-сотрудник (роль понижена до 'user')
 *      в файл НЕ попадают, гость — тем более.
 *   2. exportTeamInfoXlsx (employees-db.xlsx, включая уволенных): уволенный
 *      ex-сотрудник в файле ЕСТЬ, обычный 'user' и гость — НЕТ.
 *   3. Синхронизация из СЕРВЕРНОГО файла (allowPromotion: false) НЕ повышает
 *      'user' → employee, даже если его email есть в файле.
 *   4. Синхронизация из ВРУЧНУЮ загруженного файла (allowPromotion: true —
 *      умолчание) повышает 'user' → employee.
 *   5. После повышения refreshServerExports включает нового сотрудника в
 *      перегенерированный team-info.xlsx (уволенный и гость — нет).
 */

// ВАЖНО: env нужно выставить ДО require database-модуля
const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'tmp-smoke-export.db');
process.env.BOT_VERSION = '';

const fs = require('fs');
const XLSX = require('xlsx');
const { initDB, getDB } = require('../src/config/database');
const User = require('../src/models/User');
const SyncService = require('../src/services/SyncService');

const TMP_XLSX_PATH = path.join(__dirname, '..', 'tmp-smoke-export-team-info.xlsx');
const TEAM_INFO_PATH = path.join(__dirname, '..', 'team-info.xlsx');
const EMPLOYEES_DB_PATH = path.join(__dirname, '..', 'employees-db.xlsx');

// Собираем Excel в формате team-info (строка 2 — заголовки, данные с 3-й строки)
function writeTeamInfoXlsx(employees) {
  const header1 = ['Сотрудник', 'E-mail', 'Telegram ID', 'Телефон', 'Число принтеров', 'Коэффициент Заработка', ''];
  const header2 = ['', '', '', '', '', '', ''];
  const rows = [header1, header2];
  for (const e of employees) {
    rows.push([e.name, e.email, String(e.tgUserId), e.phone || '', e.capacity || 1, e.factor || 1.0, '']);
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Сотрудники');
  XLSX.writeFile(wb, TMP_XLSX_PATH);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// Имена (колонка «Сотрудник») из экспортированного файла
function readExportedNames(filePath) {
  const wb = XLSX.readFile(filePath);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  return rows.slice(2).map((r) => String(r[0] || '').trim()).filter(Boolean);
}

async function createUser(username, email, role, extra = {}) {
  return User.create({
    username,
    email,
    passwordHash: 'x',
    name: extra.name || username,
    phone: '',
    capacity: 1,
    earningsFactor: 1.0,
    role,
    isFired: extra.isFired,
    takingOrders: extra.takingOrders,
    tgUserId: extra.tgUserId || null,
  });
}

async function fresh(id) {
  return User.getById(id);
}

(async () => {
  try {
    console.log('=== Smoke-тест: «user» не попадает в Excel-списки сотрудников ===');
    await initDB();
    const db = getDB();

    // Чистим мусор от прошлых запусков
    await db.run('DELETE FROM users WHERE username LIKE "smoke_exp_%"');

    // --- Фикстура ---
    const admin = await createUser('smoke_exp_admin', 'expadmin@test.local', 'admin', { name: 'Экспорт Админ', tgUserId: '3001' });
    const emp = await createUser('smoke_exp_emp', 'expemp@test.local', 'employee', { name: 'Экспорт Сотрудник', tgUserId: '3002' });
    // plainUser — подтвердил email (роль 'user'), но ещё НЕ сотрудник
    const plainUser = await createUser('smoke_exp_user', 'expuser@test.local', 'user', { name: 'Просто Пользователь', tgUserId: '3003' });
    // firedUser — уволенный ex-сотрудник: fireUser понижает роль до 'user'
    const firedUser = await createUser('smoke_exp_fired', 'expfired@test.local', 'user', { name: 'Уволенный Бывший', tgUserId: '3004', isFired: 1, takingOrders: 0 });
    // guest — email не подтверждён
    const guest = await createUser('smoke_exp_guest', 'expguest@test.local', 'guest', { name: 'Гость Скрытый', tgUserId: '3005', isFired: 1, takingOrders: 0 });

    // --- 1. team-info.xlsx: только сотрудники и staff ---
    await SyncService.exportTeamInfoXlsx(null, false, 'team-info.xlsx', { syncWarehouses: false });
    const teamNames = readExportedNames(TEAM_INFO_PATH);
    console.log('1. team-info.xlsx:', teamNames.join(', '));
    assert(teamNames.includes('Экспорт Сотрудник'), 'Сотрудник должен быть в team-info.xlsx');
    assert(teamNames.includes('Экспорт Админ'), 'staff-роль (admin) остаётся в team-info.xlsx');
    assert(!teamNames.includes('Просто Пользователь'), 'Обычный user НЕ должен попадать в team-info.xlsx');
    assert(!teamNames.includes('Уволенный Бывший'), 'Уволенный НЕ должен попадать в team-info.xlsx');
    assert(!teamNames.includes('Гость Скрытый'), 'Гость НЕ должен попадать в team-info.xlsx');

    // --- 2. employees-db.xlsx (с уволенными) ---
    await SyncService.exportTeamInfoXlsx(null, true, 'employees-db.xlsx', { syncWarehouses: false });
    const dbNames = readExportedNames(EMPLOYEES_DB_PATH);
    console.log('2. employees-db.xlsx:', dbNames.join(', '));
    assert(dbNames.includes('Экспорт Сотрудник'), 'Сотрудник должен быть в employees-db.xlsx');
    assert(dbNames.includes('Уволенный Бывший'), 'Уволенный ex-сотрудник должен оставаться в employees-db.xlsx');
    assert(!dbNames.includes('Просто Пользователь'), 'Обычный user НЕ должен попадать в employees-db.xlsx');
    assert(!dbNames.includes('Гость Скрытый'), 'Гость НЕ должен попадать в employees-db.xlsx');

    // --- 3. Серверный файл НЕ повышает роли ---
    // Готовим файл, где есть и сотрудник, и обычный 'user' (как в «залётом»
    // старом файле): серверная синхронизация не должна тронуть роль 'user'
    writeTeamInfoXlsx([
      { name: 'Экспорт Сотрудник', email: 'expemp@test.local', tgUserId: '3002' },
      { name: 'Просто Пользователь', email: 'expuser@test.local', tgUserId: '3003' },
    ]);
    const serverResult = await SyncService.syncFromExcel(TMP_XLSX_PATH, null, { allowPromotion: false });
    console.log('3. Синхронизация серверного файла:', JSON.stringify(serverResult));
    const u3 = await fresh(plainUser.id);
    assert(u3.role === 'user', `Серверный файл НЕ должен повышать роль, получено '${u3.role}'`);
    assert(u3.is_fired === 0, 'Активность обычного user не должна сбиваться');
    assert(serverResult.fired === 0, 'Присутствующий в файле сотрудник не должен увольняться');

    // --- 4. Ручная загрузка файла повышает user → employee ---
    const manualResult = await SyncService.syncFromExcel(TMP_XLSX_PATH, null);
    console.log('4. Синхронизация ручного файла:', JSON.stringify(manualResult));
    const u4 = await fresh(plainUser.id);
    console.log('4. plainUser: role =', u4.role, ', is_fired =', u4.is_fired);
    assert(u4.role === 'employee', `Ручной файл должен повышать user → employee, получено '${u4.role}'`);
    assert(u4.is_fired === 0, 'Новый сотрудник должен быть активен');
    assert(manualResult.fired === 0, 'Сотрудники из файла не должны увольняться');

    // --- 5. Перегенерированный team-info включает нового сотрудника ---
    // (refreshServerExports уже выполнен внутри syncFromExcel)
    const teamNamesAfter = readExportedNames(TEAM_INFO_PATH);
    console.log('5. team-info после повышения:', teamNamesAfter.join(', '));
    assert(teamNamesAfter.includes('Просто Пользователь'), 'Новый сотрудник должен появиться в перегенерированном team-info.xlsx');
    assert(!teamNamesAfter.includes('Уволенный Бывший'), 'Уволенный не должен вернуться в team-info.xlsx');
    assert(!teamNamesAfter.includes('Гость Скрытый'), 'Гость не должен попасть в team-info.xlsx');

    console.log('✅ Все проверки пройдены');
  } catch (err) {
    console.error('❌ Ошибка smoke-теста:', err.message);
    process.exitCode = 1;
  } finally {
    // За собой убираем. Соединение с БД закрываем до удаления файлов —
    // иначе SQLite держит временную БД открытой и файл не удаляется (Windows)
    try {
      await getDB().close();
    } catch { /* БД могла не открыться — не критично */ }
    for (const f of [
      TMP_XLSX_PATH,
      TEAM_INFO_PATH,
      EMPLOYEES_DB_PATH,
    ]) {
      try { fs.unlinkSync(f); } catch { /* не критично */ }
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* не критично */ }
    }
  }
})();
