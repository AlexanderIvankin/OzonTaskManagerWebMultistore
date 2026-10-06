/**
 * Smoke-тест когорт пользователей: флаг was_employee и фильтр cohort
 * в User.getAll (запуск: node tests/smoke-users-cohorts.js из папки backend/).
 * Использует временную БД, за собой убирает.
 * Проверяет:
 *   1. User.create: staff-роль → was_employee = 1; роль 'user'/'guest' → 0.
 *   2. Увольнение (role employee → user, is_fired = 1) сохраняет флаг = 1.
 *   3. cohort='users' — никогда-не-сотрудники + гости (неподтверждённые
 *      регистрации видны админу); БЕЗ ex-сотрудников и staff-ролей.
 *   4. cohort='staff' — сотрудники + ex-сотрудники; без includeFired — без уволенных.
 *   5. Клиент не может подменить was_employee напрямую (не входит в allowed).
 *   6. Повышение user → employee выставляет флаг и переводит между когортами;
 *      обратное понижение/увольнение возвращает в ex-сотрудники, не в «users».
 */

// ВАЖНО: env нужно выставить ДО require database-модуля
const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'tmp-smoke-cohort.db');
process.env.BOT_VERSION = '';

const fs = require('fs');
const { initDB, getDB } = require('../src/config/database');
const User = require('../src/models/User');

function assert(cond, message) {
  if (!cond) throw new Error(message);
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

// Множество id пользователей когорты
async function cohortIds(opts) {
  const rows = await User.getAll(opts);
  return new Set(rows.map((r) => r.id));
}

(async () => {
  try {
    console.log('=== Smoke-тест когорт users/staff (was_employee) ===');
    await initDB();
    const db = getDB();

    // Чистим мусор от прошлых запусков
    await db.run('DELETE FROM users WHERE username LIKE "smoke_coh_%"');

    // --- Фикстура ---
    const admin = await createUser('smoke_coh_admin', 'cohadmin@test.local', 'admin');
    const emp = await createUser('smoke_coh_emp', 'cohe1@test.local', 'employee');
    // neverUser — подтвердил email (как verifyEmail), но ещё НЕ сотрудник
    const neverUser = await createUser('smoke_coh_user', 'cohu1@test.local', 'user');
    // exEmp — создан сотрудником, затем уволен (fireUser: role → 'user', is_fired → 1)
    const exEmp = await createUser('smoke_coh_ex', 'cohe2@test.local', 'employee');
    await User.update(exEmp.id, { is_fired: 1, taking_orders: 0, role: 'user' });
    // guest — не подтвердил email
    const guest = await createUser('smoke_coh_guest', 'cohg1@test.local', 'guest', { isFired: 1, takingOrders: 0 });

    // --- 1. Флаг при создании ---
    const a1 = await fresh(admin.id);
    const e1 = await fresh(emp.id);
    const n1 = await fresh(neverUser.id);
    const x1 = await fresh(exEmp.id);
    const g1 = await fresh(guest.id);
    console.log('1. was_employee: admin =', a1.was_employee, ', emp =', e1.was_employee,
      ', user =', n1.was_employee, ', exEmp =', x1.was_employee, ', guest =', g1.was_employee);
    assert(a1.was_employee === 1, 'admin: был staff → was_employee = 1');
    assert(e1.was_employee === 1, 'employee: был staff → was_employee = 1');
    assert(n1.was_employee === 0, 'user: ещё не сотрудник → was_employee = 0');
    assert(x1.was_employee === 1, 'уволенный ex-сотрудник → was_employee = 1');
    assert(g1.was_employee === 0, 'guest → was_employee = 0');

    // --- 2. Когорты ---
    const usersCohort = await cohortIds({ cohort: 'users', includeFired: true, includeAll: true });
    const staffAll = await cohortIds({ cohort: 'staff', includeFired: true, includeAll: true });
    const staffActive = await cohortIds({ cohort: 'staff', includeFired: false, includeAll: true });
    console.log('2. users:', usersCohort.size, '| staff (с уволенными):', staffAll.size, '| staff (активные):', staffActive.size);
    assert(usersCohort.has(neverUser.id), 'cohort users: содержит обычного пользователя');
    assert(!usersCohort.has(exEmp.id), 'cohort users: НЕ содержит уволенного ex-сотрудника');
    assert(!usersCohort.has(admin.id) && !usersCohort.has(emp.id), 'cohort users: НЕ содержит staff-роли');
    assert(usersCohort.has(guest.id), 'cohort users: СОДЕРЖИТ гостя (неподтверждённая регистрация видна админу)');
    assert(staffAll.has(admin.id) && staffAll.has(emp.id) && staffAll.has(exEmp.id), 'cohort staff: staff + ex-сотрудники');
    assert(!staffAll.has(neverUser.id), 'cohort staff: НЕ содержит обычного пользователя');
    assert(!staffAll.has(guest.id), 'cohort staff: НЕ содержит гостя');
    assert(!staffActive.has(exEmp.id), 'cohort staff без includeFired: без уволенных');

    // --- 2а. Гость виден в «users» и БЕЗ includeFired (он всегда is_fired=1) ---
    const usersNoFired = await cohortIds({ cohort: 'users', includeFired: false, includeAll: true });
    assert(usersNoFired.has(guest.id), 'cohort users без includeFired: гость всё равно виден');
    assert(usersNoFired.has(neverUser.id), 'cohort users без includeFired: обычный пользователь виден');
    assert(!usersNoFired.has(exEmp.id), 'cohort users без includeFired: ex-сотрудник по-прежнему скрыт');

    // --- 3. Прежнее поведение без cohort (обратная совместимость) ---
    const legacy = await cohortIds({ includeFired: true, includeAll: true });
    assert(legacy.has(neverUser.id) && legacy.has(exEmp.id), 'без cohort: прежний список всех, кроме гостей');

    // --- 4. Клиент не может подменить was_employee напрямую ---
    await User.update(neverUser.id, { was_employee: 1 });
    const n2 = await fresh(neverUser.id);
    console.log('4. Прямая подмена was_employee: получено', n2.was_employee);
    assert(n2.was_employee === 0, 'was_employee не должен меняться напрямую (не в allowed)');

    // --- 5. Повышение user → employee (кабинет/ручной файл) ---
    await User.update(neverUser.id, { role: 'employee', is_fired: 0, taking_orders: 1 });
    const n3 = await fresh(neverUser.id);
    assert(n3.was_employee === 1, 'после повышения was_employee = 1');
    const usersAfter = await cohortIds({ cohort: 'users', includeFired: true, includeAll: true });
    const staffAfter = await cohortIds({ cohort: 'staff', includeFired: true, includeAll: true });
    assert(!usersAfter.has(neverUser.id), 'после повышения пользователь исчез из cohort users');
    assert(staffAfter.has(neverUser.id), 'после повышения пользователь появился в cohort staff');

    // --- 6. Понижение/увольнение обратно: ex-сотрудник, а не «user» ---
    await User.update(neverUser.id, { role: 'user', is_fired: 1, taking_orders: 0 });
    const n4 = await fresh(neverUser.id);
    assert(n4.was_employee === 1, 'после понижения флаг остаётся 1');
    const usersFinal = await cohortIds({ cohort: 'users', includeFired: true, includeAll: true });
    const staffFinal = await cohortIds({ cohort: 'staff', includeFired: true, includeAll: true });
    assert(!usersFinal.has(neverUser.id), 'пониженный ex-сотрудник НЕ возвращается в cohort users');
    assert(staffFinal.has(neverUser.id), 'пониженный ex-сотрудник остаётся в cohort staff (уволенные)');

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
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* не критично */ }
    }
  }
})();
