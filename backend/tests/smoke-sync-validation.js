/**
 * Smoke-тест валидации полей при синхронизации из Excel и форматирования
 * телефона в экспорте (запуск: node tests/smoke-sync-validation.js из папки backend/).
 * Использует временные БД и Excel, за собой убирает.
 * Проверяет:
 *   1. Телефон: '+7 (999) 111-22-33' / '79991234567' / '9991234568' (10 цифр) /
 *      '89991234569' → единый красивый формат; мусор → '' + оповещение;
 *      пустая ячейка → прежний телефон сохраняется.
 *   2. E-mail: кириллица → не используется для матчинга + оповещение
 *      (матчинг по Telegram ID продолжает работать).
 *   3. tg_user_id: 'abc123' → очищен (дефолт '') + оповещение.
 *   4. capacity: 'abc' → 1 (дефолт) + оповещение.
 *   5. earnings_factor: '1.234' → 1.0 (дефолт) + оповещение; '99,99' → 99.99.
 *   6. Строка без корректных идентификаторов → пропущена + оповещение.
 *   7. Одно агрегированное оповещение персонала (sync_data_invalid) со всеми
 *      проблемами; уведомление получает персонал (админ).
 *   8. exportTeamInfoXlsx: все телефоны в красивом формате +7 (999) 999-99-99.
 *   9. Валидаторы регистрации (AuthService): кириллица в email и мусорный
 *      телефон/коэффициент отклоняются; '99,99' принимается.
 *  10. adminRegister: телефон/коэффициент нормализуются ('+7 999 555-11-22' и
 *      '1,5' → '+7 (999) 555-11-22' и 1.5).
 *  11. Юнит-проверки parsePhone/formatPhonePretty/parseEmail/parseTgUserId/
 *      parseCapacity/parseEarningsFactor.
 */

// ВАЖНО: env нужно выставить ДО require database-модулей
const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'tmp-smoke-syncval.db');
process.env.NOTIFICATIONS_DB_PATH = path.join(__dirname, '..', 'tmp-smoke-syncval-notif.db');
process.env.BOT_VERSION = '';

const fs = require('fs');
const XLSX = require('xlsx');
const { initDB, getDB } = require('../src/config/database');
const { initNotificationsDB, getNotificationsDB, getNotificationsDBPath } = require('../src/config/notificationsDatabase');
const User = require('../src/models/User');
const SyncService = require('../src/services/SyncService');
const AuthService = require('../src/services/AuthService');
const {
  parsePhone,
  formatPhonePretty,
  parseEmail,
  parseTgUserId,
  parseCapacity,
  parseEarningsFactor,
} = require('../src/utils');

const XLSX_PATH = path.join(__dirname, '..', 'tmp-smoke-syncval-team-info.xlsx');
const TEAM_INFO_PATH = path.join(__dirname, '..', 'team-info.xlsx');
const EMPLOYEES_DB_PATH = path.join(__dirname, '..', 'employees-db.xlsx');

// Собираем Excel в формате team-info (строка 2 — заголовки, данные с 3-й строки)
function writeTeamInfoXlsx(employees) {
  const header1 = ['Сотрудник', 'E-mail', 'Telegram ID', 'Телефон', 'Число принтеров', 'Коэффициент Заработка', ''];
  const header2 = ['', '', '', '', '', '', ''];
  const rows = [header1, header2];
  for (const e of employees) {
    rows.push([e.name, e.email, e.tgUserId, e.phone ?? '', e.capacity ?? '', e.factor ?? '', '']);
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Сотрудники');
  XLSX.writeFile(wb, XLSX_PATH);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function createUser(username, email, role, extra = {}) {
  return User.create({
    username,
    email,
    passwordHash: 'x',
    name: extra.name || username,
    phone: extra.phone || '',
    capacity: extra.capacity ?? 1,
    earningsFactor: extra.factor ?? 1.0,
    role,
    tgUserId: extra.tgUserId || null,
  });
}

// Юнит-проверки парсеров из ../utils
function testParsers() {
  // Телефон
  assert(parsePhone('+7 (999) 123-45-67') === '79991234567', 'parsePhone: красивый формат');
  assert(parsePhone('79991234567') === '79991234567', 'parsePhone: 11 цифр с 7');
  assert(parsePhone('89991234567') === '79991234567', 'parsePhone: 11 цифр с 8 → 7');
  assert(parsePhone('9991234567') === '79991234567', 'parsePhone: 10 цифр → +7');
  assert(parsePhone('') === null && parsePhone('abc') === null && parsePhone('12345') === null, 'parsePhone: мусор → null');
  assert(parsePhone('+7 (999) 123-45-67 89') === null, 'parsePhone: 13 цифр → null');
  assert(formatPhonePretty('79991234567') === '+7 (999) 123-45-67', 'formatPhonePretty: базовый');
  assert(formatPhonePretty('9991234567') === '+7 (999) 123-45-67', 'formatPhonePretty: 10 цифр');
  assert(formatPhonePretty('abc') === null, 'formatPhonePretty: мусор → null');
  // Email
  assert(parseEmail(' Ivan@Mail.RU ') === 'ivan@mail.ru', 'parseEmail: trim + нижний регистр');
  assert(parseEmail('иван@яндекс.ру') === null, 'parseEmail: кириллица → null');
  assert(parseEmail('a b@x.ru') === null, 'parseEmail: пробел внутри → null');
  assert(parseEmail('') === null, 'parseEmail: пусто → null');
  // Telegram ID
  assert(parseTgUserId('12345') === '12345', 'parseTgUserId: цифры ок');
  assert(parseTgUserId(2001) === '2001', 'parseTgUserId: число ок');
  assert(parseTgUserId('12a34') === null && parseTgUserId('') === null, 'parseTgUserId: не только цифры → null');
  // Число принтеров
  assert(parseCapacity('3') === 3 && parseCapacity(3) === 3, 'parseCapacity: 3 ок');
  assert(parseCapacity('0') === null && parseCapacity('2.5') === null && parseCapacity('abc') === null, 'parseCapacity: 0/дробное/мусор → null');
  // Коэффициент
  assert(parseEarningsFactor('99,99') === 99.99, 'parseEarningsFactor: 99,99');
  assert(parseEarningsFactor('99.99') === 99.99, 'parseEarningsFactor: 99.99');
  assert(parseEarningsFactor('2') === 2, 'parseEarningsFactor: целое ок');
  assert(parseEarningsFactor('1.234') === null, 'parseEarningsFactor: 3 знака → null');
  assert(parseEarningsFactor('-2') === null && parseEarningsFactor('0') === null, 'parseEarningsFactor: <=0 → null');
  assert(parseEarningsFactor('abc') === null && parseEarningsFactor('') === null, 'parseEarningsFactor: мусор → null');
  console.log('1. Юнит-проверки парсеров utils ✅');
}

// Валидаторы AuthService
function testValidators() {
  let errors = AuthService.validateRegisterData({
    username: 'superlogin1', email: 'иван@почта.ру', password: '123456',
  });
  assert(errors.some((e) => e.includes('email')), 'validateRegisterData: кириллица в email отклоняется');

  errors = AuthService.validateRegisterData({
    username: 'superlogin1', email: 'a@b.ru', password: '123456', phone: 'abc',
  });
  assert(errors.some((e) => e.includes('телефон')), 'validateRegisterData: мусорный телефон отклоняется');

  errors = AuthService.validateRegisterData({
    username: 'superlogin1', email: 'a@b.ru', password: '123456',
    phone: '+7 (999) 123-45-67', earningsFactor: '99,99',
  });
  assert(errors.length === 0, `validateRegisterData: валидные данные приняты (получено: ${errors.join('; ')})`);

  errors = AuthService.validateAdminRegisterData({
    username: 'a', email: 'a@b.ru', password: 'p', earningsFactor: '1.234',
  });
  assert(errors.some((e) => e.includes('Коэффициент')), 'validateAdminRegisterData: 3 знака у коэффициента отклоняются');
  console.log('2. Валидаторы регистрации (AuthService) ✅');
}

(async () => {
  try {
    console.log('=== Smoke-тест валидации синхронизации из Excel ===');
    await initDB();
    await initNotificationsDB();
    console.log('Файл БД оповещений:', getNotificationsDBPath());

    testParsers();
    testValidators();

    const db = getDB();

    // Чистим мусор от прошлых запусков
    await db.run('DELETE FROM users WHERE username LIKE "smoke_val_%"');

    // --- Фикстура: персонал (получатель оповещений) + сотрудники ---
    const admin = await createUser('smoke_val_admin', 'valadmin@test.local', 'admin');
    const empValid = await createUser('smoke_val_emp1', 'valid1@test.local', 'employee', { tgUserId: '2001' });
    const empPhone11 = await createUser('smoke_val_emp2', 'emp2@test.local', 'employee', { tgUserId: '2002' });
    const empPhone10 = await createUser('smoke_val_emp3', 'emp3@test.local', 'employee', { tgUserId: '2003', capacity: 2, factor: 2.5 });
    const empPhone8 = await createUser('smoke_val_emp4', 'emp4@test.local', 'employee', { tgUserId: '2004' });
    const empBadPhone = await createUser('smoke_val_emp5', 'emp5@test.local', 'employee', { tgUserId: '2005' });
    const empBadTg = await createUser('smoke_val_emp6', 'badtg@test.local', 'employee', { tgUserId: '2006', phone: '+7 (999) 777-77-77', capacity: 2 });
    const empBadEmail = await createUser('smoke_val_emp7', 'bademail@test.local', 'employee', { tgUserId: '2007' });
    const empBadNumbers = await createUser('smoke_val_emp8', 'emp8@test.local', 'employee', { tgUserId: '2008', capacity: 4, factor: 2.5 });
    const empCommaFactor = await createUser('smoke_val_emp9', 'emp9@test.local', 'employee', { tgUserId: '2009' });

    // --- Excel со всеми форматами и проблемами ---
    writeTeamInfoXlsx([
      // 1. красивый формат + capacity 3 + '1,5' → фактор 1.5
      { name: 'Сотрудник Валидный', email: 'valid1@test.local', tgUserId: '2001', phone: '+7 (999) 111-22-33', capacity: 3, factor: '1,5' },
      // 2. телефон '79991234567' → '+7 (999) 123-45-67'; пустые capacity/фактор → 1 / 1.0
      { name: 'Телефон Семёрка', email: 'emp2@test.local', tgUserId: '2002', phone: '79991234567' },
      // 3. телефон 10 цифр '9991234568' → '+7 (999) 123-45-68'
      { name: 'Телефон Десять', email: 'emp3@test.local', tgUserId: '2003', phone: '9991234568', capacity: 2, factor: 2.5 },
      // 4. телефон '89991234569' → '+7 (999) 123-45-69'
      { name: 'Телефон Восьмёрка', email: 'emp4@test.local', tgUserId: '2004', phone: '89991234569' },
      // 5. телефон-мусор → '' + оповещение
      { name: 'Телефон Мусор', email: 'emp5@test.local', tgUserId: '2005', phone: 'abc-нет телефона' },
      // 6. tg 'abc123' → очищен; телефон в Excel пуст → прежний сохраняется; матч по email
      { name: 'Плохой Тг', email: 'badtg@test.local', tgUserId: 'abc123' },
      // 7. email с кириллицей → не матчится по email; матч по tg 2007 + оповещение
      { name: 'Плохой Имейл', email: 'Иван@Яндекс.Ру', tgUserId: '2007' },
      // 8. capacity 'abc' → 1; фактор '1.234' → 1.0 (оба дефолта) + 2 оповещения
      { name: 'Плохие Числа', email: 'emp8@test.local', tgUserId: '2008', capacity: 'abc', factor: '1.234' },
      // 9. фактор '99,99' → 99.99 (валидный формат с запятой)
      { name: 'Коэф Запятая', email: 'emp9@test.local', tgUserId: '2009', phone: '+7 (999) 555-00-11', capacity: 2, factor: '99,99' },
      // 10. имя есть, корректных идентификаторов нет → строка пропущена + оповещение
      { name: 'Строка Без Ид', email: 'Петя@Маил.Ру', tgUserId: 'xx' },
    ]);

    const result = await SyncService.syncFromExcel(XLSX_PATH, admin.id);
    console.log('Результат синхронизации:', JSON.stringify(result));
    assert(result.updated === 9, `Ожидалось updated=9, получено ${result.updated}`);
    // Строка «Строка Без Ид» пропускается молча (как и раньше), но проблема
    // уходит в оповещение персонала — потому в счётчике skipped её нет
    assert(result.skipped === 0, `Ожидался skipped=0, получено ${result.skipped}`);
    assert(result.fired === 0, `Ожидался fired=0, получено ${result.fired}`);

    const fresh = (id) => User.getById(id);

    // 3. Телефоны в БД
    const e1 = await fresh(empValid.id);
    console.log('3. emp1:', e1.phone, '| capacity:', e1.capacity, '| фактор:', e1.earnings_factor);
    assert(e1.phone === '+7 (999) 111-22-33', `emp1: телефон должен быть '+7 (999) 111-22-33', получено '${e1.phone}'`);
    assert(e1.capacity === 3 && e1.earnings_factor === 1.5, "emp1: capacity=3, фактор=1.5 ('1,5')");

    const e2 = await fresh(empPhone11.id);
    console.log('4. emp2:', e2.phone);
    assert(e2.phone === '+7 (999) 123-45-67', `emp2: '79991234567' → красивый формат, получено '${e2.phone}'`);
    assert(e2.capacity === 1 && e2.earnings_factor === 1.0, 'emp2: пустые capacity/фактор → дефолты 1 / 1.0');

    const e3 = await fresh(empPhone10.id);
    console.log('5. emp3:', e3.phone);
    assert(e3.phone === '+7 (999) 123-45-68', `emp3: 10 цифр → '+7 (999) 123-45-68', получено '${e3.phone}'`);
    assert(e3.capacity === 2 && e3.earnings_factor === 2.5, 'emp3: валидные числа сохранены');

    const e4 = await fresh(empPhone8.id);
    console.log('6. emp4:', e4.phone);
    assert(e4.phone === '+7 (999) 123-45-69', `emp4: '89991234569' → '+7 (999) 123-45-69', получено '${e4.phone}'`);

    const e5 = await fresh(empBadPhone.id);
    console.log('7. emp5 (телефон-мусор):', JSON.stringify(e5.phone));
    assert(e5.phone === '', `emp5: мусорный телефон → '', получено '${e5.phone}'`);

    const e6 = await fresh(empBadTg.id);
    console.log('8. emp6 (плохой tg):', JSON.stringify(e6.tg_user_id), '| телефон:', JSON.stringify(e6.phone), '| capacity:', e6.capacity);
    assert(e6.tg_user_id === '', `emp6: некорректный tg_user_id → '', получено '${e6.tg_user_id}'`);
    assert(e6.phone === '+7 (999) 777-77-77', 'emp6: пустой телефон в Excel — прежний сохраняется');
    // Пустая ячейка capacity в Excel → дефолт 1 (так было и раньше:
    // parseInt('') || 1; нераспознаваемое значение тоже даёт 1)
    assert(e6.capacity === 1, `emp6: пустая ячейка capacity → дефолт 1, получено ${e6.capacity}`);

    const e7 = await fresh(empBadEmail.id);
    console.log('9. emp7 (кириллица в email):', e7.email, '| tg:', e7.tg_user_id);
    assert(e7.tg_user_id === '2007', 'emp7: матчинг по Telegram ID сработал, tg не тронут');
    assert(e7.email === 'bademail@test.local', 'emp7: email в БД не перезаписан');

    const e8 = await fresh(empBadNumbers.id);
    console.log('10. emp8 (плохие числа): capacity:', e8.capacity, '| фактор:', e8.earnings_factor);
    assert(e8.capacity === 1, `emp8: capacity 'abc' → дефолт 1 (было 4), получено ${e8.capacity}`);
    assert(e8.earnings_factor === 1.0, `emp8: фактор '1.234' → дефолт 1.0 (было 2.5), получено ${e8.earnings_factor}`);

    const e9 = await fresh(empCommaFactor.id);
    console.log('11. emp9 (99,99): фактор:', e9.earnings_factor, '| телефон:', e9.phone);
    assert(e9.earnings_factor === 99.99, `emp9: '99,99' → 99.99, получено ${e9.earnings_factor}`);
    assert(e9.phone === '+7 (999) 555-00-11', 'emp9: красивый телефон сохранён');

    // 12. Оповещение персонала (sync_data_invalid): агрегированное, адресовано персоналу
    const notif = await getNotificationsDB().get(
      `SELECT * FROM notifications WHERE type = 'sync_data_invalid' ORDER BY id DESC LIMIT 1`
    );
    assert(notif, 'Оповещение sync_data_invalid не создано');
    assert(String(notif.recipient_id) === String(admin.id), 'Оповещение адресовано персоналу (админу)');
    const msg = notif.message || '';
    console.log('12. Оповещение персонала:', notif.title);
    console.log(msg.split('\n').map((l) => '    ' + l).join('\n'));
    for (const part of ['abc-нет телефона', 'abc123', 'Иван@Яндекс.Ру', '1.234', 'abc', 'Петя@Маил.Ру', 'Строка Без Ид']) {
      assert(msg.includes(part), `Оповещение должно упоминать «${part}»`);
    }

    // 13. Экспорт: все непустые телефоны в красивом формате
    const outPath = await SyncService.exportTeamInfoXlsx(null, false, 'team-info.xlsx', { syncWarehouses: false });
    console.log('13. Экспорт:', path.basename(outPath));
    const wb = XLSX.readFile(outPath);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    const phoneRe = /^\+7 \(\d{3}\) \d{3}-\d{2}-\d{2}$/;
    let checked = 0;
    for (const r of rows.slice(2)) {
      const name = String(r[0] || '').trim();
      if (!name) continue;
      const phone = String(r[3] ?? '');
      if (phone !== '') {
        assert(phoneRe.test(phone), `В экспорте телефон «${name}» должен быть '+7 (999) 123-45-67', получено '${phone}'`);
        checked++;
      }
    }
    assert(checked >= 6, `В экспорте ожидались заполненные телефоны, найдено ${checked}`);
    console.log(`    все непустые телефоны в экспорте красивые (${checked} шт.) ✅`);

    // 14. adminRegister: нормализация телефона и коэффициента
    const created = await AuthService.adminRegister({
      username: 'smoke_val_newacc',
      email: 'newacc@test.local',
      password: 'password1',
      phone: '+7 999 555-11-22',
      earningsFactor: '1,5',
    });
    console.log('14. adminRegister:', created.phone, '| фактор:', created.earnings_factor);
    assert(created.phone === '+7 (999) 555-11-22', `adminRegister: телефон нормализован, получено '${created.phone}'`);
    assert(created.earnings_factor === 1.5, `adminRegister: '1,5' → 1.5, получено ${created.earnings_factor}`);

    console.log('✅ Все проверки пройдены');
  } catch (err) {
    console.error('❌ Ошибка smoke-теста:', err.message);
    process.exitCode = 1;
  } finally {
    // За собой убираем. Соединения закрываем ДО удаления файлов — иначе
    // SQLite держит файлы открытыми и они не удаляются (Windows)
    try { await getDB().close(); } catch { /* не критично */ }
    try {
      const notifDB = getNotificationsDB();
      await notifDB.close();
    } catch { /* не критично */ }
    for (const f of [
      XLSX_PATH,
      TEAM_INFO_PATH,
      EMPLOYEES_DB_PATH,
      process.env.DB_PATH,
      process.env.NOTIFICATIONS_DB_PATH,
    ]) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(f + suffix); } catch { /* не критично */ }
      }
    }
  }
})();
