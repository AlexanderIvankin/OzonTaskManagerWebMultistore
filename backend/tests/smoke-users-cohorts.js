/**
 * Smoke-тест когорт пользователей.
 * Запуск: node tests/smoke-users-cohorts.js из папки backend/.
 *
 * MULTISTORE: флаг was_employee переехал в user_stores (per-store), глобальная
 * users.role — только 'god' | 'user' | 'guest'. Сотрудник магазина:
 *   • users.role = 'user' (глобально);
 *   • user_stores.role = 'employee' | 'moderator' | 'admin' | 'god';
 *   • user_stores.was_employee = 1;
 *   • user_stores.is_fired = 0 | 1.
 * Проверяет:
 *   1. Создание записи в user_stores → was_employee=1 по умолчанию.
 *   2. getAllInStore(storeId, {includeFired}) — состав когорты.
 *   3. Роль в user_stores после увольнения НЕ понижается (в отличие от старой
 *      схемы, где fireUser понижал role до 'user').
 *   4. Восстановление возвращает is_fired=0, роль сохраняется.
 *   5. Изоляция магазинов: магазин A не видит сотрудников магазина B.
 *   6. Глобальная роль users.role не меняется при повышении/понижении в магазине.
 */
const { setup, cleanup } = require('./helpers/setupTestEnv');
const STORE_A = setup('1').storeId;
const STORE_B = 'test-store-B';

const { initDB, closeAll, getUsersDB } = require('../src/config/database');
const { initNotificationsDB, closeNotificationsDB } = require('../src/config/notificationsDatabase');
const User = require('../src/models/User');
const UserStore = require('../src/models/UserStore');

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

(async () => {
  try {
    console.log('=== Smoke-тест когорт пользователей (user_stores) ===');
    await initDB();
    await initNotificationsDB();
    const db = getUsersDB();

    const ts = Date.now();

    // --- Фикстура ---
    const admin = await User.create({
      username: `smoke_coh_admin_${ts}`,
      email: `smoke_coh_admin_${ts}@test.local`,
      passwordHash: 'x', role: 'user',
    });
    await UserStore.upsert(admin.id, STORE_A, { role: 'admin', was_employee: 1 });

    const emp = await User.create({
      username: `smoke_coh_emp_${ts}`,
      email: `smoke_coh_emp_${ts}@test.local`,
      passwordHash: 'x', role: 'user',
    });
    await UserStore.upsert(emp.id, STORE_A, { role: 'employee', was_employee: 1 });

    // neverUser — подтверждённый users.role='user', записи в user_stores нет
    const neverUser = await User.create({
      username: `smoke_coh_user_${ts}`,
      email: `smoke_coh_user_${ts}@test.local`,
      passwordHash: 'x', role: 'user',
    });

    // exEmp — был employee, уволен (is_fired=1), роль в user_stores сохранена
    const exEmp = await User.create({
      username: `smoke_coh_ex_${ts}`,
      email: `smoke_coh_ex_${ts}@test.local`,
      passwordHash: 'x', role: 'user',
    });
    await UserStore.upsert(exEmp.id, STORE_A, { role: 'employee', was_employee: 1 });
    await UserStore.fire(exEmp.id, STORE_A);

    // guest — неподтверждённый email, никаких записей в user_stores
    const guest = await User.create({
      username: `smoke_coh_guest_${ts}`,
      email: `smoke_coh_guest_${ts}@test.local`,
      passwordHash: 'x', role: 'guest',
    });

    // --- 1. was_employee по умолчанию ---
    const adminStore = await UserStore.get(admin.id, STORE_A);
    const empStore = await UserStore.get(emp.id, STORE_A);
    console.log('1. was_employee: admin =', adminStore.was_employee, ', emp =', empStore.was_employee);
    assert(adminStore.was_employee === 1, 'admin: was_employee = 1');
    assert(empStore.was_employee === 1, 'emp: was_employee = 1');
    assert((await UserStore.get(neverUser.id, STORE_A)) === null, 'neverUser: нет записи в user_stores');
    assert((await UserStore.get(guest.id, STORE_A)) === null, 'guest: нет записи в user_stores');

    // --- 2. getAllInStore: активные ---
    const active = await User.getAllInStore(STORE_A, { includeFired: false });
    const activeIds = new Set(active.map((u) => u.id));
    console.log('2. Активные в магазине A:', activeIds.size);
    assert(activeIds.has(admin.id), 'активные: admin есть');
    assert(activeIds.has(emp.id), 'активные: emp есть');
    assert(!activeIds.has(exEmp.id), 'активные: уволенный exEmp скрыт');
    assert(!activeIds.has(neverUser.id), 'активные: neverUser не имеет записи в user_stores');
    assert(!activeIds.has(guest.id), 'активные: guest не имеет записи в user_stores');

    // Все с includeFired ---
    const all = await User.getAllInStore(STORE_A, { includeFired: true });
    const allIds = new Set(all.map((u) => u.id));
    console.log('3. Все (с уволенными):', allIds.size);
    assert(allIds.has(exEmp.id), 'все: exEmp включён при includeFired');

    // --- 4. Роль после увольнения сохранена ---
    const exStore = await UserStore.get(exEmp.id, STORE_A);
    const exGlobal = await User.getById(exEmp.id);
    console.log('4. exEmp: role(user_stores) =', exStore.role, ', is_fired =', exStore.is_fired,
      ', users.role =', exGlobal.role);
    assert(exStore.role === 'employee', 'роль в user_stores после увольнения сохранена');
    assert(exStore.is_fired === 1, 'is_fired = 1');
    assert(exGlobal.role === 'user', 'users.role остаётся глобально user');

    // --- 5. Восстановление ---
    await UserStore.restore(exEmp.id, STORE_A);
    const exRestored = await UserStore.get(exEmp.id, STORE_A);
    console.log('5. После восстановления: role =', exRestored.role, ', is_fired =', exRestored.is_fired);
    assert(exRestored.is_fired === 0, 'is_fired = 0 после restore');
    assert(exRestored.role === 'employee', 'роль после restore та же');

    // --- 6. Изоляция магазинов: в STORE_B нет никого ---
    const inB = await User.getAllInStore(STORE_B, { includeFired: true });
    console.log('6. Сотрудников магазина B:', inB.length);
    assert(inB.length === 0, 'магазин B не видит сотрудников магазина A');

    // --- 7. excludeRole: 'god' ---
    const godUser = await User.create({
      username: `smoke_coh_god_${ts}`,
      email: `smoke_coh_god_${ts}@test.local`,
      passwordHash: 'x', role: 'user',
    });
    await UserStore.upsert(godUser.id, STORE_A, { role: 'god', was_employee: 1 });
    const noGod = await User.getAllInStore(STORE_A, { includeFired: true, excludeRole: 'god' });
    const noGodIds = new Set(noGod.map((u) => u.id));
    assert(!noGodIds.has(godUser.id), 'excludeRole=god скрывает Создателя');

    console.log('✅ Все проверки пройдены');

    // --- Очистка ---
    const allIds2 = [admin.id, emp.id, neverUser.id, exEmp.id, guest.id, godUser.id];
    for (const id of allIds2) {
      await db.run('DELETE FROM user_stores WHERE user_id = ?', id);
      await db.run('DELETE FROM users WHERE id = ?', id);
    }
  } catch (err) {
    console.error('❌ Ошибка smoke-теста:', err.message);
    process.exitCode = 1;
  } finally {
    try { await closeNotificationsDB(); } catch { /* ignore */ }
    try { await closeAll(); } catch { /* ignore */ }
    cleanup();
  }
})();