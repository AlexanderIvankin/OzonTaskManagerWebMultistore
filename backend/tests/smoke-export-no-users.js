/**
 * Smoke-тест: обычные пользователи (role = 'user') не попадают в Excel-файлы
 * сотрудников и не повышаются серверным файлом.
 * Запуск: node tests/smoke-export-no-users.js из папки backend/.
 *
 * MULTISTORE: экспорт работает в контексте магазина. Состав файла —
 * сотрудники user_stores магазина (role != 'god', includeFired по параметру).
 * Обычные users и гости в user_stores не имеют записи — их в файле нет.
 * Проверяет:
 *   1. team-info.xlsx (активные): сотрудники + staff-роли, без 'user' и god.
 *   2. employees-db.xlsx (с уволенными): ex-сотрудник есть, 'user' и god — нет.
 *   3. Серверный файл (allowPromotion: false) НЕ повышает user → employee.
 *   4. Ручной файл (allowPromotion: true) повышает.
 *   5. Перегенерированный team-info включает нового сотрудника.
 */
const { setup, cleanup } = require('./helpers/setupTestEnv');
const STORE_ID = setup('1').storeId;

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { initDB, closeAll, getUsersDB } = require('../src/config/database');
const User = require('../src/models/User');
const UserStore = require('../src/models/UserStore');
const SyncService = require('../src/services/SyncService');

const TMP_XLSX_PATH = path.join(__dirname, '..', 'tests', 'tmp', 'smoke-export-team-info.xlsx');
const OUTPUT_DIR = path.join(__dirname, '..', 'outputs', `store-${STORE_ID}`);
const TEAM_INFO_PATH = path.join(OUTPUT_DIR, 'team-info.xlsx');
const EMPLOYEES_DB_PATH = path.join(OUTPUT_DIR, 'employees-db.xlsx');

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

function assert(cond, message) { if (!cond) throw new Error(message); }

function readExportedNames(filePath) {
  const wb = XLSX.readFile(filePath);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  return rows.slice(2).map((r) => String(r[0] || '').trim()).filter(Boolean);
}

(async () => {
  const createdUserIds = [];
  try {
    console.log('=== Smoke-тест: «user» не попадает в Excel-списки сотрудников ===');
    await initDB();
    const db = getUsersDB();
    const ts = Date.now();

    const mk = async (username, role, extra = {}) => {
      const u = await User.create({
        username, email: `${username}@test.local`, passwordHash: 'x',
        name: extra.name || username, role: extra.globalRole || 'user',
        tgUserId: extra.tgUserId || null,
      });
      createdUserIds.push(u.id);
      if (role) {
        await UserStore.upsert(u.id, STORE_ID, {
          role, was_employee: 1, is_fired: extra.isFired ? 1 : 0,
        });
      }
      return u;
    };

    const admin = await mk(`smoke_exp_admin_${ts}`, 'admin', { name: 'Экспорт Админ', tgUserId: '3001' });
    const emp = await mk(`smoke_exp_emp_${ts}`, 'employee', { name: 'Экспорт Сотрудник', tgUserId: '3002' });
    const plainUser = await mk(`smoke_exp_user_${ts}`, null, { name: 'Просто Пользователь', tgUserId: '3003' });
    const exEmp = await mk(`smoke_exp_fired_${ts}`, 'employee', { name: 'Уволенный Бывший', tgUserId: '3004', isFired: true });
    const guest = await mk(`smoke_exp_guest_${ts}`, null, { name: 'Гость Скрытый', tgUserId: '3005', globalRole: 'guest' });
    const god = await mk(`smoke_exp_god_${ts}`, 'god', { name: 'Создатель Незримый', tgUserId: '3006' });

    // 1. team-info.xlsx
    await SyncService.exportTeamInfoXlsx(null, false, 'team-info.xlsx', { storeId: STORE_ID, syncWarehouses: false });
    const teamNames = readExportedNames(TEAM_INFO_PATH);
    console.log('1. team-info.xlsx:', teamNames.join(', '));
    assert(teamNames.includes('Экспорт Сотрудник'), 'Сотрудник должен быть');
    assert(teamNames.includes('Экспорт Админ'), 'admin остаётся');
    assert(!teamNames.includes('Просто Пользователь'), 'user НЕ должен попадать');
    assert(!teamNames.includes('Уволенный Бывший'), 'уволенный НЕ должен попадать');
    assert(!teamNames.includes('Гость Скрытый'), 'guest НЕ должен попадать');
    assert(!teamNames.includes('Создатель Незримый'), 'god исключён (excludeRole)');

    // 2. employees-db.xlsx
    await SyncService.exportTeamInfoXlsx(null, true, 'employees-db.xlsx', { storeId: STORE_ID, syncWarehouses: false });
    const dbNames = readExportedNames(EMPLOYEES_DB_PATH);
    console.log('2. employees-db.xlsx:', dbNames.join(', '));
    assert(dbNames.includes('Экспорт Сотрудник'), 'Сотрудник в employees-db');
    assert(dbNames.includes('Уволенный Бывший'), 'ex-сотрудник в employees-db');
    assert(!dbNames.includes('Просто Пользователь'), 'user не в employees-db');
    assert(!dbNames.includes('Создатель Незримый'), 'god не в employees-db');

    // 3. Серверный файл (allowPromotion: false)
    writeTeamInfoXlsx([
      { name: 'Экспорт Сотрудник', email: `smoke_exp_emp_${ts}@test.local`, tgUserId: '3002' },
      { name: 'Просто Пользователь', email: `smoke_exp_user_${ts}@test.local`, tgUserId: '3003' },
    ]);
    const serverResult = await SyncService.syncFromExcel(TMP_XLSX_PATH, null, {
      allowPromotion: false, storeId: STORE_ID,
    });
    console.log('3. Серверный файл:', JSON.stringify(serverResult));
    const u3 = await UserStore.get(plainUser.id, STORE_ID);
    assert(u3 === null, 'серверный файл НЕ создаёт запись в user_stores');
    assert(serverResult.fired === 0, 'сотрудник из файла не уволен');

    // 4. Ручной файл (allowPromotion: true)
    const manualResult = await SyncService.syncFromExcel(TMP_XLSX_PATH, null, { storeId: STORE_ID });
    console.log('4. Ручной файл:', JSON.stringify(manualResult));
    const u4 = await UserStore.get(plainUser.id, STORE_ID);
    assert(u4 && u4.role === 'employee' && !u4.is_fired, 'ручной файл повысил до employee');

    // 5. Перегенерированный team-info
    const teamAfter = readExportedNames(TEAM_INFO_PATH);
    console.log('5. team-info после повышения:', teamAfter.join(', '));
    assert(teamAfter.includes('Просто Пользователь'), 'повышенный в team-info');
    assert(!teamAfter.includes('Уволенный Бывший'), 'уволенный не вернулся');
    assert(!teamAfter.includes('Создатель Незримый'), 'god не вернулся');

    console.log('✅ Все проверки пройдены');
  } catch (err) {
    console.error('❌ Ошибка smoke-теста:', err.message);
    process.exitCode = 1;
  } finally {
    try {
      const db = getUsersDB();
      for (const id of createdUserIds) {
        await db.run('DELETE FROM user_stores WHERE user_id = ?', id);
        await db.run('DELETE FROM users WHERE id = ?', id);
      }
    } catch { /* ignore */ }
    for (const f of [TMP_XLSX_PATH, TEAM_INFO_PATH, EMPLOYEES_DB_PATH]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    try { await closeAll(); } catch { /* ignore */ }
    cleanup();
  }
})();