/**
 * Smoke-тест синхронизации сотрудников из Excel.
 * Запуск: node tests/smoke-sync-employees.js из папки backend/.
 *
 * MULTISTORE + правила:
 *   • syncFromExcel(storeId) обновляет user_stores магазина;
 *   • users.role никогда не меняется синхронизацией;
 *   • увольнение = UserStore.fire (is_fired=1), роль в user_stores СОХРАНЯЕТСЯ;
 *   • восстановление = upsert is_fired=0, роль та же;
 *   • god НИКОГДА не увольняется и не редактируется;
 *   • гость (users.role='guest') не активируется до подтверждения email.
 *
 * Проверяет:
 *   1. Сотрудник из Excel → обновлён, is_fired=0.
 *   2. Сотрудника нет → уволен (user_stores.is_fired=1), роль сохранена,
 *      активные назначения сняты.
 *   3. Восстановление: снова в Excel → is_fired=0, роль та же.
 *   4. admin отсутствует в файле — не тронут.
 *   5. users.role='user' в Excel → employee в магазине.
 *   6. god защита: строка god в файле игнорируется, god не уволен.
 *   7. Гость: в файле есть, но роль/активность не включается.
 */
const { setup, cleanup } = require('./helpers/setupTestEnv');
const STORE_ID = setup('1').storeId;

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { initDB, closeAll, getUsersDB, getStoreDB } = require('../src/config/database');
const User = require('../src/models/User');
const UserStore = require('../src/models/UserStore');
const SyncService = require('../src/services/SyncService');

const XLSX_PATH = path.join(__dirname, '..', 'tests', 'tmp', 'smoke-sync-team-info.xlsx');
const { getVersionedFileName } = require('../src/utils');
const TEAM_INFO_PATH = path.join(
  __dirname, '..', 'outputs', `store-${STORE_ID}`,
  getVersionedFileName('team-info', 'xlsx', STORE_ID)
);

function assert(cond, message) { if (!cond) throw new Error(message); }

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

(async () => {
  const created = {};
  try {
    console.log('=== Smoke-тест синхронизации сотрудников из Excel ===');
    await initDB();
    const db = getUsersDB();
    const storeDb = getStoreDB(STORE_ID);
    const ts = Date.now();

    const mk = async (key, role, extra = {}) => {
      const u = await User.create({
        username: `smoke_sync_${key}_${ts}`, email: `smoke_sync_${key}_${ts}@test.local`,
        passwordHash: 'x',
        // ?? — чтобы пустое '' НЕ заменялось на key (иначе не сможем
        // проверить, что sync заполняет пустые поля god из Excel).
        name: extra.name !== undefined ? extra.name : key,
        role: extra.globalRole || 'user', tgUserId: extra.tgUserId || null,
      });
      created[key] = u;
      if (role) {
        await UserStore.upsert(u.id, STORE_ID, {
          role, was_employee: 1, is_fired: extra.isFired ? 1 : 0,
          earnings_factor: extra.factor ?? 1.0,
        });
      }
      return u;
    };

    const emp1 = await mk('emp1', 'employee', { name: 'Сотрудник Один', tgUserId: '1001' });
    const emp2 = await mk('emp2', 'employee', { name: 'Сотрудник Два', tgUserId: '1002' });
    const fired = await mk('fired', 'employee', { name: 'Возвращенец', tgUserId: '1003', isFired: true });
    const plain = await mk('user', null, { name: 'Новый Сотрудник', tgUserId: '1004' });
    const guest = await mk('guest', null, { name: 'Не подтвердил', tgUserId: '1006', globalRole: 'guest' });
    const admin = await mk('admin', 'admin', { name: 'Админ', tgUserId: '1005' });
    // god — с ПУСТЫМИ полями, проверим что Excel их заполнит
    const god = await mk('god', 'god', { name: '', tgUserId: null, globalRole: 'god' });

    // Активное назначение для emp2 — должно быть снято при увольнении
    await storeDb.run(
      'INSERT INTO assignments (order_id, user_id, assigned_at) VALUES (?, ?, ?)',
      'SMOKE-ORDER-1', emp2.id, Date.now()
    );

    // Excel: emp1, fired, plain, guest, god; emp2 и admin отсутствуют
    writeTeamInfoXlsx([
      { name: 'Сотрудник Один', email: `smoke_sync_emp1_${ts}@test.local`, tgUserId: '1001' },
      { name: 'Возвращенец', email: `smoke_sync_fired_${ts}@test.local`, tgUserId: '1003' },
      { name: 'Новый Сотрудник', email: `smoke_sync_user_${ts}@test.local`, tgUserId: '1004' },
      { name: 'Не подтвердил', email: `smoke_sync_guest_${ts}@test.local`, tgUserId: '1006' },
      { name: 'Создатель', email: `smoke_sync_god_${ts}@test.local`, tgUserId: '1007' },
    ]);

    const result = await SyncService.syncFromExcel(XLSX_PATH, null, { storeId: STORE_ID });
    console.log('Результат:', JSON.stringify(result));

    // 1. emp1 активен
    const e1 = await UserStore.get(emp1.id, STORE_ID);
    assert(e1 && e1.is_fired === 0, '1. emp1: is_fired=0');

    // 2. emp2 уволен, роль сохранена, назначения сняты
    const e2 = await UserStore.get(emp2.id, STORE_ID);
    const assignLeft = await storeDb.get(
      'SELECT COUNT(*) AS n FROM assignments WHERE user_id = ? AND status = "assigned"', emp2.id
    );
    console.log(`2. emp2: is_fired=${e2.is_fired}, role=${e2.role}, назначений=${assignLeft.n}`);
    assert(e2.is_fired === 1, '2. emp2 уволен');
    assert(e2.role === 'employee', '2. emp2 роль сохранена');
    assert(assignLeft.n === 0, '2. назначения сняты');

    // 3. fired восстановлен
    const f = await UserStore.get(fired.id, STORE_ID);
    console.log(`3. fired: is_fired=${f.is_fired}, role=${f.role}`);
    assert(f.is_fired === 0, '3. fired восстановлен');
    assert(f.role === 'employee', '3. fired роль сохранена');

    // 4. admin не тронут
    const a = await UserStore.get(admin.id, STORE_ID);
    console.log(`4. admin: is_fired=${a.is_fired}, role=${a.role}`);
    assert(a.is_fired === 0 && a.role === 'admin', '4. admin не уволен');

    // 5. plain → employee
    const u = await UserStore.get(plain.id, STORE_ID);
    console.log(`5. plain: role=${u?.role}, is_fired=${u?.is_fired}`);
    assert(u && u.role === 'employee' && u.is_fired === 0, '5. plain повышен');

    // 6. god защита
    const g = await UserStore.get(god.id, STORE_ID);
    const gGlobal = await User.getById(god.id);
    console.log(`6. god: role=${g?.role}, is_fired=${g?.is_fired}, global_role=${gGlobal.role}`);
    assert(g && g.role === 'god' && g.is_fired === 0, '6. god не тронут');
    assert(gGlobal.role === 'god', '6. users.role=god сохранён');

    // 7. guest не активирован
    const gu = await UserStore.get(guest.id, STORE_ID);
    const guGlobal = await User.getById(guest.id);
    console.log(`7. guest: user_stores=${gu === null ? 'нет' : 'есть'}, global_role=${guGlobal.role}`);
    assert(gu === null, '7. у guest нет записи в user_stores');
    assert(guGlobal.role === 'guest', '7. guest остаётся guest');

    // 7a. God: заполнены ПУСТЫЕ поля, role/is_fired не тронуты
    const gDb = await User.getById(god.id);
    const gStore = await UserStore.get(god.id, STORE_ID);
    console.log(`7a. god: name="${gDb.name}", tg=${gDb.tg_user_id}, store.role=${gStore.role}, is_fired=${gStore.is_fired}`);
    assert(gDb.name === 'Создатель', '7a. god: пустое name заполнено из Excel');
    assert(gDb.tg_user_id === '1007', '7a. god: пустое tg_user_id заполнено');
    assert(gStore.role === 'god', '7a. god: роль в магазине не тронута');
    assert(gStore.is_fired === 0, '7a. god: is_fired не тронут');

    // 7b. Staff (admin): в файле ЕСТЬ — глобальные поля обновились,
    // роль в user_stores сохранена (не понижен до employee)
    // Пересоберём Excel, добавив admin с новыми данными
    writeTeamInfoXlsx([
      { name: 'Сотрудник Один', email: `smoke_sync_emp1_${ts}@test.local`, tgUserId: '1001' },
      { name: 'Админ Обновлённый', email: `smoke_sync_admin_${ts}@test.local`, tgUserId: '1005', phone: '+7 (999) 555-55-55', capacity: 5 },
    ]);
    await SyncService.syncFromExcel(XLSX_PATH, null, { storeId: STORE_ID });
    const aDb = await User.getById(admin.id);
    const aStore = await UserStore.get(admin.id, STORE_ID);
    console.log(`7b. admin: name="${aDb.name}", phone="${aDb.phone}", cap=${aDb.capacity}, role=${aStore.role}, is_fired=${aStore.is_fired}`);
    assert(aDb.name === 'Админ Обновлённый', '7b. admin: name обновлён');
    assert(aDb.phone === '+7 (999) 555-55-55', '7b. admin: phone обновлён');
    assert(aDb.capacity === 5, '7b. admin: capacity обновлён');
    assert(aStore.role === 'admin', '7b. admin: роль в магазине сохранена (не понижен)');
    assert(aStore.is_fired === 0, '7b. admin: не уволен');

    // 8. Экспорт: emp2 нет, восстановленные есть
    const wb2 = XLSX.readFile(TEAM_INFO_PATH);
    const rows2 = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]], { header: 1, defval: '' });
    const excelNames = rows2.slice(2).map(r => String(r[0] || '').trim()).filter(Boolean);
    console.log('8. team-info после sync:', excelNames.join(', '));
    assert(!excelNames.includes('Сотрудник Два'), '8. emp2 не в team-info');
    assert(excelNames.includes('Сотрудник Один'), '8. emp1 в team-info');
    assert(excelNames.includes('Возвращенец'), '8. fired в team-info');
    assert(!excelNames.includes('Создатель'), '8. god не в team-info');

    console.log('✅ Все проверки пройдены');
  } catch (err) {
    console.error('❌ Ошибка smoke-теста:', err.message);
    process.exitCode = 1;
  } finally {
    try {
      const db = getUsersDB();
      const storeDb = getStoreDB(STORE_ID);
      for (const u of Object.values(created)) {
        await storeDb.run('DELETE FROM assignments WHERE user_id = ?', u.id);
        await db.run('DELETE FROM user_stores WHERE user_id = ?', u.id);
        await db.run('DELETE FROM users WHERE id = ?', u.id);
      }
    } catch { /* ignore */ }
    try { fs.unlinkSync(XLSX_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(TEAM_INFO_PATH); } catch { /* ignore */ }
    try { await closeAll(); } catch { /* ignore */ }
    cleanup();
  }
})();