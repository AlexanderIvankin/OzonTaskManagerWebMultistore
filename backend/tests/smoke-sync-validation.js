/**
 * Smoke-тест валидации полей при синхронизации из Excel.
 * Запуск: node tests/smoke-sync-validation.js из папки backend/.
 *
 * MULTISTORE: syncFromExcel(storeId) — всё обновление в user_stores магазина.
 * Проверяет:
 *   1. Телефон нормализуется во всех форматах (+7/7/8/10 цифр), мусор → ''.
 *   2. Кириллица в email → матчинг по tg, + оповещение.
 *   3. tg_user_id: 'abc123' → '' + оповещение.
 *   4. capacity 'abc' → 1; factor '1.234' → 1.0.
 *   5. Агрегированное оповещение sync_data_invalid с перечнем.
 *   6. Юнит-проверки парсеров из ../src/utils.
 *   7. validateRegisterData/validateAdminRegisterData.
 *   8. adminRegister: normalize phone/factor.
 */
const { setup, cleanup } = require('./helpers/setupTestEnv');
const STORE_ID = setup('1').storeId;

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { initDB, closeAll, getUsersDB } = require('../src/config/database');
const { initNotificationsDB, getNotificationsDB, closeNotificationsDB } = require('../src/config/notificationsDatabase');
const User = require('../src/models/User');
const UserStore = require('../src/models/UserStore');
const SyncService = require('../src/services/SyncService');
const AuthService = require('../src/services/AuthService');
const {
  parsePhone, formatPhonePretty, parseEmail, parseTgUserId, parseCapacity, parseEarningsFactor,
} = require('../src/utils');

const XLSX_PATH = path.join(__dirname, '..', 'tests', 'tmp', 'smoke-val-team-info.xlsx');
const { getVersionedFileName } = require('../src/utils');
const TEAM_INFO_PATH = path.join(
  __dirname, '..', 'outputs', `store-${STORE_ID}`,
  getVersionedFileName('team-info', 'xlsx', STORE_ID)
);

function writeTeamInfoXlsx(employees) {
  const header1 = ['Сотрудник', 'E-mail', 'Telegram ID', 'Телефон', 'Число принтеров', 'Коэффициент Заработка', ''];
  const header2 = ['', '', '', '', '', '', ''];
  const rows = [header1, header2];
  for (const e of employees) {
    rows.push([e.name, e.email, e.tgUserId, e.phone ?? '', e.capacity ?? '', e.factor ?? '', '']);
  }
  XLSX.writeFile({
    SheetNames: ['Сотрудники'],
    Sheets: { 'Сотрудники': XLSX.utils.aoa_to_sheet(rows) },
  }, XLSX_PATH);
}

function assert(cond, message) { if (!cond) throw new Error(message); }

function testParsers() {
  assert(parsePhone('+7 (999) 123-45-67') === '79991234567', 'parsePhone красивый');
  assert(parsePhone('89991234567') === '79991234567', 'parsePhone 8→7');
  assert(parsePhone('9991234567') === '79991234567', 'parsePhone 10 цифр');
  assert(parsePhone('abc') === null, 'parsePhone мусор → null');
  assert(formatPhonePretty('79991234567') === '+7 (999) 123-45-67', 'formatPhonePretty');
  assert(parseEmail(' Ivan@Mail.RU ') === 'ivan@mail.ru', 'parseEmail');
  assert(parseEmail('иван@яндекс.ру') === null, 'parseEmail кириллица');
  assert(parseTgUserId('12345') === '12345', 'parseTgUserId ок');
  assert(parseTgUserId('12a34') === null, 'parseTgUserId мусор');
  assert(parseCapacity('3') === 3, 'parseCapacity');
  assert(parseCapacity('2.5') === null, 'parseCapacity дробное');
  assert(parseEarningsFactor('99,99') === 99.99, 'parseEarningsFactor 99,99');
  assert(parseEarningsFactor('1.234') === null, 'parseEarningsFactor 3 знака');
  console.log('1. Парсеры ✅');
}

function testValidators() {
  let e = AuthService.validateRegisterData({
    username: 'superlogin1', email: 'иван@почта.ру', password: '123456',
  });
  assert(e.some((x) => x.includes('email')), 'validateRegisterData: кириллица');
  e = AuthService.validateRegisterData({
    username: 'superlogin1', email: 'a@b.ru', password: '123456', phone: 'abc',
  });
  assert(e.some((x) => x.includes('телефон')), 'validateRegisterData: телефон');
  e = AuthService.validateRegisterData({
    username: 'superlogin1', email: 'a@b.ru', password: '123456',
    phone: '+7 (999) 123-45-67', earningsFactor: '99,99',
  });
  assert(e.length === 0, 'validateRegisterData: валидные');
  console.log('2. Валидаторы ✅');
}

(async () => {
  const createdIds = [];
  try {
    console.log('=== Smoke-тест валидации синхронизации ===');
    await initDB();
    await initNotificationsDB();
    const db = getUsersDB();
    const ndb = getNotificationsDB();
    const ts = Date.now();

    testParsers();
    testValidators();

    const mk = async (key, extra = {}) => {
      const u = await User.create({
        username: `smoke_val_${key}_${ts}`, email: `smoke_val_${key}_${ts}@test.local`,
        passwordHash: 'x', name: extra.name || key, role: 'user',
        phone: extra.phone || '', capacity: extra.capacity ?? 1,
        tgUserId: extra.tgUserId || null,
      });
      createdIds.push(u.id);
      await UserStore.upsert(u.id, STORE_ID, {
        role: extra.storeRole || 'employee', was_employee: 1,
        earnings_factor: extra.factor ?? 1.0,
      });
      return u;
    };

    const admin = await mk('admin', { storeRole: 'admin' });
    const emp1 = await mk('emp1', { tgUserId: '2001' });
    const emp2 = await mk('emp2', { tgUserId: '2002' });
    const emp3 = await mk('emp3', { tgUserId: '2003', capacity: 2, factor: 2.5 });
    const emp4 = await mk('emp4', { tgUserId: '2004' });
    const emp5 = await mk('emp5', { tgUserId: '2005' });
    const emp6 = await mk('emp6', { tgUserId: '2006', phone: '+7 (999) 777-77-77', capacity: 2 });
    const emp7 = await mk('emp7', { tgUserId: '2007' });
    const emp8 = await mk('emp8', { tgUserId: '2008', capacity: 4, factor: 2.5 });
    const emp9 = await mk('emp9', { tgUserId: '2009' });

    writeTeamInfoXlsx([
      { name: 'Сотрудник Валидный', email: `smoke_val_emp1_${ts}@test.local`, tgUserId: '2001', phone: '+7 (999) 111-22-33', capacity: 3, factor: '1,5' },
      { name: 'Телефон Семёрка', email: `smoke_val_emp2_${ts}@test.local`, tgUserId: '2002', phone: '79991234567' },
      { name: 'Телефон Десять', email: `smoke_val_emp3_${ts}@test.local`, tgUserId: '2003', phone: '9991234568', capacity: 2, factor: 2.5 },
      { name: 'Телефон Восьмёрка', email: `smoke_val_emp4_${ts}@test.local`, tgUserId: '2004', phone: '89991234569' },
      { name: 'Телефон Мусор', email: `smoke_val_emp5_${ts}@test.local`, tgUserId: '2005', phone: 'abc-нет телефона' },
      { name: 'Плохой Тг', email: `smoke_val_emp6_${ts}@test.local`, tgUserId: 'abc123' },
      { name: 'Плохой Имейл', email: 'Иван@Яндекс.Ру', tgUserId: '2007' },
      { name: 'Плохие Числа', email: `smoke_val_emp8_${ts}@test.local`, tgUserId: '2008', capacity: 'abc', factor: '1.234' },
      { name: 'Коэф Запятая', email: `smoke_val_emp9_${ts}@test.local`, tgUserId: '2009', phone: '+7 (999) 555-00-11', capacity: 2, factor: '99,99' },
      { name: 'Строка Без Ид', email: 'Петя@Маил.Ру', tgUserId: 'xx' },
    ]);

    const result = await SyncService.syncFromExcel(XLSX_PATH, admin.id, { storeId: STORE_ID });
    console.log('Результат:', JSON.stringify(result));
    assert(result.updated === 9, `updated=${result.updated}, ожидалось 9`);
    assert(result.fired === 0, `fired=${result.fired}`);

    const u1 = await User.getById(emp1.id);
    console.log(`3. emp1: phone=${u1.phone}, capacity=${u1.capacity}`);
    assert(u1.phone === '+7 (999) 111-22-33', 'emp1 phone');
    const u1s = await UserStore.get(emp1.id, STORE_ID);
    assert(u1s.earnings_factor === 1.5, `emp1 factor=1.5 (получено ${u1s.earnings_factor})`);

    const u2 = await User.getById(emp2.id);
    assert(u2.phone === '+7 (999) 123-45-67', `emp2 phone (${u2.phone})`);

    const u3 = await User.getById(emp3.id);
    assert(u3.phone === '+7 (999) 123-45-68', `emp3 phone (${u3.phone})`);

    const u4 = await User.getById(emp4.id);
    assert(u4.phone === '+7 (999) 123-45-69', `emp4 phone (${u4.phone})`);

    const u5 = await User.getById(emp5.id);
    assert(u5.phone === '', `emp5 phone (${u5.phone})`);

    const u6 = await User.getById(emp6.id);
    assert(u6.tg_user_id === '', `emp6 tg (${u6.tg_user_id})`);
    assert(u6.phone === '+7 (999) 777-77-77', 'emp6 phone сохранён');

    const u7 = await User.getById(emp7.id);
    assert(u7.tg_user_id === '2007', 'emp7 tg');

    const u8s = await UserStore.get(emp8.id, STORE_ID);
    const u8 = await User.getById(emp8.id);
    assert(u8.capacity === 1, `emp8 capacity=${u8.capacity}`);
    assert(u8s.earnings_factor === 1.0, `emp8 factor=${u8s.earnings_factor}`);

    const u9s = await UserStore.get(emp9.id, STORE_ID);
    const u9 = await User.getById(emp9.id);
    assert(u9s.earnings_factor === 99.99, `emp9 factor=${u9s.earnings_factor}`);
    assert(u9.phone === '+7 (999) 555-00-11', 'emp9 phone');
    console.log('3. Валидация полей в БД ✅');

    // 4. Оповещение
    const notif = await ndb.get(
      `SELECT * FROM notifications WHERE type = 'sync_data_invalid' AND store_id = ? ORDER BY id DESC LIMIT 1`,
      STORE_ID
    );
    assert(notif, 'Оповещение sync_data_invalid');
    for (const part of ['abc-нет телефона', 'abc123', 'Иван@Яндекс.Ру', '1.234', 'abc', 'Петя@Маил.Ру', 'Строка Без Ид']) {
      assert(notif.message.includes(part), `Оповещение упоминает «${part}»`);
    }
    console.log('4. Оповещение персонала ✅');

    // 5. Экспорт: телефоны в красивом формате
    await SyncService.exportTeamInfoXlsx(null, false, 'team-info.xlsx', { storeId: STORE_ID, syncWarehouses: false });
    const wb = XLSX.readFile(TEAM_INFO_PATH);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    const phoneRe = /^\+7 \(\d{3}\) \d{3}-\d{2}-\d{2}$/;
    let checked = 0;
    for (const r of rows.slice(2)) {
      const name = String(r[0] || '').trim();
      if (!name) continue;
      const phone = String(r[3] ?? '');
      if (phone !== '') { assert(phoneRe.test(phone), `Экспорт ${name}: ${phone}`); checked++; }
    }
    assert(checked >= 6, `В экспорте ${checked} телефонов`);
    console.log(`5. Экспорт: ${checked} телефонов в красивом формате ✅`);

    // 6. adminRegister normalize
    const created = await AuthService.adminRegister({
      username: `smoke_val_new_${ts}`,
      email: `smoke_val_new_${ts}@test.local`,
      password: 'password1',
      phone: '+7 999 555-11-22',
      earningsFactor: '1,5',
      storeId: STORE_ID,
    });
    console.log(`6. adminRegister: ${created.phone} | factor=${created.earnings_factor}`);
    assert(created.phone === '+7 (999) 555-11-22', `adminRegister phone (${created.phone})`);
    assert(created.earnings_factor === 1.5, `adminRegister factor (${created.earnings_factor})`);
    createdIds.push(created.id);

    console.log('✅ Все проверки пройдены');
  } catch (err) {
    console.error('❌ Ошибка smoke-теста:', err.message);
    process.exitCode = 1;
  } finally {
    try {
      const db = getUsersDB();
      for (const id of createdIds) {
        await db.run('DELETE FROM user_stores WHERE user_id = ?', id);
        await db.run('DELETE FROM users WHERE id = ?', id);
      }
    } catch { /* ignore */ }
    for (const f of [XLSX_PATH, TEAM_INFO_PATH]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    try { await closeNotificationsDB(); } catch { /* ignore */ }
    try { await closeAll(); } catch { /* ignore */ }
    cleanup();
  }
})();