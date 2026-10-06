/**
 * Smoke-тест синхронизации сотрудников из Excel (запуск: node tests/smoke-sync-employees.js из папки backend/).
 * Использует временную БД, за собой убирает.
 * Проверяет:
 *   1. Сотрудник, ЕСТЬ в Excel  → обновляется, is_fired = 0, taking_orders = 1.
 *   2. Сотрудник, НЕТ в Excel   → уволен (is_fired = 1, taking_orders = 0, роль employee → user),
 *                                  активные назначения сняты.
 *   3. Уволенный, снова ЕСТЬ в Excel → восстановлен (is_fired = 0, role user → employee).
 *   4. admin отсутствует в Excel — НЕ увольняется.
 *   5. Пользователь с ролью 'user', появившись в Excel, становится сотрудником.
 *   6. Гость (email не подтверждён), есть в Excel — НЕ восстанавливается
 *      (остаётся is_fired = 1 / taking_orders = 0 до подтверждения).
 */

// ВАЖНО: env нужно выставить ДО require database-модуля
const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'tmp-smoke-sync.db');
process.env.BOT_VERSION = '';

const fs = require('fs');
const XLSX = require('xlsx');
const { initDB, getDB } = require('../src/config/database');
const User = require('../src/models/User');
const SyncService = require('../src/services/SyncService');

const XLSX_PATH = path.join(__dirname, '..', 'tmp-smoke-team-info.xlsx');

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
  XLSX.writeFile(wb, XLSX_PATH);
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
    // Гость создаётся вне команды — как AuthService.register
    // (undefined -> дефолты 0 / 1)
    isFired: extra.isFired,
    takingOrders: extra.takingOrders,
    tgUserId: extra.tgUserId || null,
  });
}

(async () => {
  try {
    console.log('=== Smoke-тест синхронизации сотрудников из Excel ===');
    await initDB();
    const db = getDB();

    // Чистим мусор от прошлых запусков
    await db.run('DELETE FROM users WHERE username LIKE "smoke_sync_%"');

    // --- Фикстура ---
    // emp1 — активный сотрудник, будет в Excel
    const emp1 = await createUser('smoke_sync_emp1', 'emp1@test.local', 'employee', { tgUserId: '1001' });
    // emp2 — активный сотрудник, НЕ будет в Excel (должен быть уволен)
    const emp2 = await createUser('smoke_sync_emp2', 'emp2@test.local', 'employee', { tgUserId: '1002' });
    // fired — уже уволенный, вернётся в Excel (должен быть восстановлен)
    const fired = await createUser('smoke_sync_fired', 'fired@test.local', 'user', { tgUserId: '1003' });
    await User.update(fired.id, { is_fired: 1, taking_orders: 0 });
    // plainUser — обычный подтверждённый пользователь, будет в Excel (user → employee)
    const plainUser = await createUser('smoke_sync_user', 'user1@test.local', 'user', { tgUserId: '1004' });
    // guest — НЕ подтвердил email (роль guest, вне команды), но есть в Excel:
    // активность включать нельзя, пока не введёт код из письма
    const guest = await createUser('smoke_sync_guest', 'guest1@test.local', 'guest', {
      tgUserId: '1006',
      isFired: 1,
      takingOrders: 0,
    });
    // admin — админ, НЕ будет в Excel (не должен быть уволен)
    const admin = await createUser('smoke_sync_admin', 'admin@test.local', 'admin', { tgUserId: '1005' });

    // Активное назначение для emp2 — должно быть снято при увольнении
    await db.run(
      'INSERT INTO assignments (order_id, user_id, assigned_at) VALUES (?, ?, ?)',
      'SMOKE-ORDER-1', emp2.id, Date.now()
    );

    // --- Excel: emp1, fired, plainUser; emp2 и admin отсутствуют ---
    // Внимание: email emp1 записан в ДРУГОМ регистре, чем в БД — проверка
    // регистронезависимого поиска (раньше из-за этого не срабатывал апгрейд
    // user → employee и восстановление)
    writeTeamInfoXlsx([
      { name: 'Сотрудник Один', email: 'EMP1@TEST.LOCAL', tgUserId: '1001' },
      { name: 'Возвращенец', email: 'Fired@Test.Local', tgUserId: '1003' },
      { name: 'Новый Сотрудник', email: 'user1@test.local', tgUserId: '1004' },
      { name: 'Не подтвердил', email: 'guest1@test.local', tgUserId: '1006' },
    ]);

    const result = await SyncService.syncFromExcel(XLSX_PATH, null);
    console.log('Результат синхронизации:', result);

    const fresh = (id) => User.getById(id);

    // 1. emp1: остался активным сотрудником
    const e1 = await fresh(emp1.id);
    console.log('1. emp1: is_fired =', e1.is_fired, ', taking_orders =', e1.taking_orders, ', role =', e1.role);
    if (e1.is_fired !== 0 || e1.taking_orders !== 1 || e1.role !== 'employee') {
      throw new Error('Активный сотрудник из Excel должен остаться сотрудником');
    }

    // 2. emp2: уволен, роль понижена, назначения сняты
    const e2 = await fresh(emp2.id);
    const assignmentsLeft = await db.get(
      'SELECT COUNT(*) AS n FROM assignments WHERE user_id = ? AND status = "assigned"', emp2.id
    );
    console.log('2. emp2: is_fired =', e2.is_fired, ', taking_orders =', e2.taking_orders, ', role =', e2.role, ', активных назначений:', assignmentsLeft.n);
    if (e2.is_fired !== 1 || e2.taking_orders !== 0 || e2.role !== 'user' || assignmentsLeft.n !== 0) {
      throw new Error('Сотрудник, отсутствующий в Excel, должен быть уволен');
    }

    // 3. fired: восстановлен
    const f = await fresh(fired.id);
    console.log('3. fired: is_fired =', f.is_fired, ', taking_orders =', f.taking_orders, ', role =', f.role);
    if (f.is_fired !== 0 || f.taking_orders !== 1 || f.role !== 'employee') {
      throw new Error('Уволенный сотрудник из Excel должен быть восстановлен (user → employee)');
    }

    // 4. admin: не тронут
    const a = await fresh(admin.id);
    console.log('4. admin: is_fired =', a.is_fired, ', role =', a.role);
    if (a.is_fired !== 0 || a.role !== 'admin') {
      throw new Error('Админ без записи в Excel не должен увольняться');
    }

    // 5. plainUser: user → employee
    const u = await fresh(plainUser.id);
    console.log('5. plainUser: role =', u.role, ', is_fired =', u.is_fired);
    if (u.role !== 'employee' || u.is_fired !== 0) {
      throw new Error('Пользователь из Excel должен стать сотрудником');
    }

    // 6. guest (email не подтверждён): есть в Excel, но активность не включаем
    const g = await fresh(guest.id);
    console.log('5a/6. guest: role =', g.role, ', is_fired =', g.is_fired, ', taking_orders =', g.taking_orders);
    if (g.role !== 'guest' || g.is_fired !== 1 || g.taking_orders !== 0) {
      throw new Error('Гость из Excel должен оставаться вне команды до подтверждения email');
    }

    // 7. Результат содержит fired = 1
    if (result.fired !== 1) {
      throw new Error(`Ожидался fired = 1, получено ${result.fired}`);
    }

    // 8. Серверный Excel перегенерирован под новое состояние БД:
    //    emp2 (уволен) в team-info отсутствует, восстановленные — присутствуют
    // BOT_VERSION пуст → имя без версии (team-info.xlsx)
    const teamInfoPath = path.join(__dirname, '..', 'team-info.xlsx');
    const wb2 = XLSX.readFile(teamInfoPath);
    const rows2 = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]], { header: 1, defval: '' });
    const excelNames = rows2.slice(2).map(r => String(r[0] || '').trim()).filter(Boolean);
    console.log('8. team-info после перегенерации:', excelNames.join(', '));
    if (excelNames.some(n => n === 'smoke_sync_emp2')) {
      throw new Error('Уволенный emp2 не должен попасть в перегенерированный team-info');
    }
    for (const expectedName of ['Сотрудник Один', 'Возвращенец', 'Новый Сотрудник']) {
      if (!excelNames.includes(expectedName)) {
        throw new Error(`В перегенерированном team-info нет "${expectedName}"`);
      }
    }

    console.log('✅ Все проверки пройдены');
  } catch (err) {
    console.error('❌ Ошибка smoke-теста:', err.message);
    process.exitCode = 1;
  } finally {
    // За собой убираем (включая перегенерированные тестом серверные Excel)
    // Соединение с БД закрываем до удаления файлов — иначе SQLite держит
    // временную БД открытой и файл не удаляется (Windows)
    try {
      await getDB().close();
    } catch { /* БД могла не открыться — не критично */ }
    for (const f of [
      XLSX_PATH,
      path.join(__dirname, '..', 'team-info.xlsx'),
      path.join(__dirname, '..', 'employees-db.xlsx'),
    ]) {
      try { fs.unlinkSync(f); } catch { /* не критично */ }
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* не критично */ }
    }
  }
})();

