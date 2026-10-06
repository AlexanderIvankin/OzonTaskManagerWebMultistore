/**
 * Smoke-тест: снимок и бэкап БД через VACUUM INTO.
 * Запуск: node tests/smoke-vacuum-snapshot.js из папки backend/.
 * Работает с ВРЕМЕННОЙ БД (env.DB_PATH) и убирает за собой все файлы.
 *
 * Проверяет, что переход с побайтового копирования живого файла на VACUUM INTO
 * безопасен (см. downloadDatabase и BackupService):
 *   1. Снимок содержит АКТУАЛЬНЫЕ данные — включая запись, созданную прямо
 *      перед снимком (отдаётся «сейчас», а не устаревший файл/кэш).
 *   2. Явные INTEGER PRIMARY KEY (id пользователей) не пересобираются:
 *      значения и «дырки» от удалённых строк сохраняются как есть.
 *   3. AUTOINCREMENT не переиспользует удалённые id: sqlite_sequence
 *      переносится в снимок, и новая запись получает id выше всех прежних.
 *   4. Логическое содержимое всех таблиц идентично источнику (MD5 строк
 *      вместе со скрытыми rowid), нарушений внешних ключей нет.
 *   5. Снимок компактнее источника: freelist вычищен, размер кратен
 *      page_size, PRAGMA quick_check = ok, page_size не меняется.
 *   6. toSqliteLiteral безопасно готовит путь для SQL (слэши и кавычки) —
 *      этим helper'ом пользуются и скачивание, и бэкап.
 *   7. BackupService.createDbBackup делает такой же проверенный снимок и
 *      НЕ пересоздаёт ежедневный бэкап повторным вызовом.
 */

// ВАЖНО: env нужно выставить ДО require модуля БД
const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'tmp-smoke-vacuum.db');
process.env.BOT_VERSION = '';

const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { initDB, getDB } = require('../src/config/database');
const { toSqliteLiteral } = require('../src/utils');
const BackupService = require('../src/services/BackupService');
const User = require('../src/models/User');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const SNAPSHOT_PATH = path.join(__dirname, '..', 'tmp-smoke-vacuum-snapshot.db');
// Базовое имя файлов теста: tmp-smoke-vacuum_<дата>.db и т.п.
const TEST_DB_BASENAME = path.basename(process.env.DB_PATH, '.db');

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/**
 * Открывает файл БД в указанном режиме. Для проверок используем READONLY:
 * снимок/бэкап не должны меняться самим фактом проверки.
 */
function openDb(filePath, mode) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, mode, (err) =>
      err ? reject(err) : resolve(db)
    );
  });
}

// Два разных API в тесте:
//   • живая БД (getDB()) — обёртка `sqlite`: методы возвращают Promise;
//   • снимок/бэкап открываем сырым `sqlite3`: там только callback-API.
const rawAll = (db, sql, ...params) =>
  new Promise((res, rej) => db.all(sql, ...params, (e, r) => (e ? rej(e) : res(r))));
const rawRun = (db, sql, ...params) =>
  new Promise((res, rej) => db.run(sql, ...params, (e) => (e ? rej(e) : res())));
const rawClose = (db) => new Promise((res) => db.close(() => res()));

/** Единая функция-запрос для fingerprint: обёртки над обоими API */
const liveQuery = (db) => (sql) => db.all(sql);
const rawQuery = (db) => (sql) => rawAll(db, sql);
const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');

/**
 * «Слепок» БД для сравнения источника, снимка и бэкапа: хеши содержимого всех
 * таблиц (вместе со скрытыми rowid), счётчики страниц/freelist, sqlite_sequence,
 * id пользователей и проверки целостности.
 */
async function fingerprint(query) {
  const tables = (
    await query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  ).map((r) => r.name);
  const hashes = {};
  for (const table of tables) {
    hashes[table] = md5(
      JSON.stringify(await query(`SELECT rowid AS _rid, * FROM "${table}"`))
    );
  }
  const rows = await query('SELECT id, username FROM users ORDER BY id');
  return {
    tables,
    hashes,
    users: rows.map((r) => ({ id: r.id, username: r.username })),
    sequence: await query('SELECT name, seq FROM sqlite_sequence ORDER BY name'),
    pageSize: (await query('PRAGMA page_size'))[0].page_size,
    pageCount: (await query('PRAGMA page_count'))[0].page_count,
    freelist: (await query('PRAGMA freelist_count'))[0].freelist_count,
    quickCheck: (await query('PRAGMA quick_check')).map((r) => Object.values(r)[0]),
    fkViolations: (await query('PRAGMA foreign_key_check')).length,
  };
}

function seqOf(fp, table) {
  const row = fp.sequence.find((s) => s.name === table);
  return row ? row.seq : null;
}

function idsOf(fp) {
  return fp.users.map((u) => u.id);
}

(async () => {
  const createdBackups = [];
  let snapshotDb = null;
  let backupDb = null;
  try {
    console.log('=== Smoke-тест: VACUUM INTO (снимок и бэкап БД) ===');
    await initDB();
    const db = getDB();

    // --- 6. Подготовка SQL-литерала пути (общий helper скачивания и бэкапа) ---
    assert(
      toSqliteLiteral("C:\\tmp\\a'b.db") === "'C:/tmp/a''b.db'",
      `toSqliteLiteral: получено ${toSqliteLiteral("C:\\tmp\\a'b.db")}`
    );
    assert(
      toSqliteLiteral('/var/ozon/x.db') === "'/var/ozon/x.db'",
      'toSqliteLiteral: путь *nix изменён'
    );
    console.log('6. toSqliteLiteral: обратные слэши и кавычка в пути подготовлены верно');

    // --- Фикстура: пользователи, «дырки» в id и фрагментация файла ---
    await db.run('DELETE FROM users WHERE username LIKE "smoke_vac_%"');
    await db.exec(
      'CREATE TABLE IF NOT EXISTS smoke_vac_filler (id INTEGER PRIMARY KEY AUTOINCREMENT, blob TEXT)'
    );
    await db.run('DELETE FROM smoke_vac_filler');
    const filler = 'x'.repeat(400);
    for (let i = 0; i < 500; i++) {
      await db.run('INSERT INTO smoke_vac_filler (blob) VALUES (?)', filler);
    }
    for (let i = 1; i <= 6; i++) {
      await User.create({
        username: `smoke_vac_${i}`,
        email: `smoke_vac_${i}@test.local`,
        passwordHash: 'x',
        name: `Вак ${i}`,
        phone: '',
        capacity: 1,
        earningsFactor: 1.0,
        role: 'user',
      });
    }
    const allIds = (await db.all('SELECT id FROM users ORDER BY id')).map((r) => r.id);
    const deletedIds = [allIds[1], allIds[4]];
    await db.run('DELETE FROM users WHERE id IN (?, ?)', deletedIds[0], deletedIds[1]);
    // Освобождаем страницы фикстуры: источник становится «дырявым» (freelist > 0),
    // чтобы проверить, что VACUUM INTO действительно сжимает файл
    await db.run('DELETE FROM smoke_vac_filler');

    // --- 1. Запись ПРЯМО перед снимком должна попасть в снимок ---
    const fresh = await User.create({
      username: 'smoke_vac_fresh',
      email: 'smoke_vac_fresh@test.local',
      passwordHash: 'x',
      name: 'Свежий Вак',
      phone: '',
      capacity: 1,
      earningsFactor: 1.0,
      role: 'user',
    });

    const live = await fingerprint(liveQuery(db));
    const liveBytes = fs.statSync(process.env.DB_PATH).size;

    // --- Снимок: ровно тот же вызов, что делает downloadDatabase ---
    try { fs.unlinkSync(SNAPSHOT_PATH); } catch { /* файла может не быть */ }
    await db.exec(`VACUUM INTO ${toSqliteLiteral(SNAPSHOT_PATH)}`);

    snapshotDb = await openDb(SNAPSHOT_PATH, sqlite3.OPEN_READONLY);
    const snap = await fingerprint(rawQuery(snapshotDb));
    const snapBytes = fs.statSync(SNAPSHOT_PATH).size;

    assert(
      snap.users.some((u) => u.id === fresh.id && u.username === 'smoke_vac_fresh'),
      'Снимок не содержит запись, созданную ПЕРЕД снимком — данные устарели!'
    );
    console.log(`1. Снимок содержит свежую запись id=${fresh.id} («сейчас», а не кэш)`);

    // --- 2. Явные INTEGER PRIMARY KEY не пересобраны ---
    assert(
      JSON.stringify(idsOf(snap)) === JSON.stringify(idsOf(live)),
      `id пользователей изменились: [${idsOf(live)}] -> [${idsOf(snap)}]`
    );
    assert(
      !idsOf(snap).some((id) => deletedIds.includes(id)),
      'Удалённые id вернулись в снимок'
    );
    console.log(
      `2. id сохранены ([${idsOf(snap)}]), удалённые ${deletedIds.join(', ')} не вернулись`
    );

    // --- 4. Логическое содержимое всех таблиц + внешние ключи ---
    assert(
      JSON.stringify(snap.tables) === JSON.stringify(live.tables),
      `Список таблиц изменился: [${live.tables}] -> [${snap.tables}]`
    );
    const changedTables = live.tables.filter((t) => live.hashes[t] !== snap.hashes[t]);
    assert(
      changedTables.length === 0,
      `Содержимое таблиц изменилось: ${changedTables.join(', ')}`
    );
    assert(snap.fkViolations === 0, `FK-нарушений в снимке: ${snap.fkViolations}`);
    console.log(
      `4. Содержимое всех ${snap.tables.length} таблиц (вместе с rowid) идентично, FK-нарушений нет`
    );

    // --- 5. Сжатие и целостность ---
    assert(
      live.freelist > 0,
      'Фикстура не создала фрагментацию (freelist = 0) — проверка сжатия бессмысленна'
    );
    assert(snap.freelist === 0, `В снимке остался freelist: ${snap.freelist}`);
    assert(
      snap.pageCount <= live.pageCount,
      `Страниц в снимке больше: ${snap.pageCount} > ${live.pageCount}`
    );
    assert(snapBytes < liveBytes, `Снимок не компактнее источника: ${liveBytes} -> ${snapBytes}`);
    assert(snapBytes % snap.pageSize === 0, 'Размер снимка не кратен page_size');
    assert(snap.pageSize === live.pageSize, 'page_size изменился');
    assert(
      snap.quickCheck.length === 1 && snap.quickCheck[0] === 'ok',
      `quick_check снимка: ${snap.quickCheck.join('; ')}`
    );
    console.log(
      `5. Сжатие и целостность: ${liveBytes} Б (freelist ${live.freelist}, стр. ${live.pageCount})` +
      ` -> ${snapBytes} Б (freelist 0, стр. ${snap.pageCount}), quick_check ok`
    );

    // --- 7. BackupService: тот же механизм, проверенный снимок ---
    const daily = await BackupService.createDbBackup();
    assert(daily && fs.existsSync(daily), 'Ежедневный бэкап не создан');
    createdBackups.push(daily);
    const dailyMtime = fs.statSync(daily).mtimeMs;
    const dailyAgain = await BackupService.createDbBackup();
    assert(dailyAgain === daily, 'Повторный вызов должен вернуть тот же ежедневный бэкап');
    assert(fs.statSync(dailyAgain).mtimeMs === dailyMtime, 'Ежедневный бэкап был пересоздан');

    const manual = await BackupService.createDbBackup({ includeTime: true });
    assert(manual && fs.existsSync(manual), 'Ручной бэкап не создан');
    createdBackups.push(manual);
    const manualBytes = fs.statSync(manual).size;

    backupDb = await openDb(manual, sqlite3.OPEN_READONLY);
    const bkp = await fingerprint(rawQuery(backupDb));
    assert(
      bkp.quickCheck.length === 1 && bkp.quickCheck[0] === 'ok',
      `quick_check бэкапа: ${bkp.quickCheck.join('; ')}`
    );
    const changedInBackup = live.tables.filter((t) => live.hashes[t] !== bkp.hashes[t]);
    assert(
      changedInBackup.length === 0,
      `Бэкап отличается от источника: ${changedInBackup.join(', ')}`
    );
    assert(bkp.freelist === 0, `В бэкапе остался freelist: ${bkp.freelist}`);
    assert(manualBytes % bkp.pageSize === 0, 'Размер бэкапа не кратен page_size');
    console.log(
      `7. BackupService: ежедневный и ручной бэкапы созданы (${manualBytes} Б), содержимое ` +
      'идентично источнику, quick_check ok, ежедневный повторно не пересоздаётся'
    );

    // --- 3. AUTOINCREMENT: новая запись в СНИМКЕ не переиспользует удалённые id ---
    const snapSeq = seqOf(snap, 'users');
    assert(
      snapSeq === seqOf(live, 'users'),
      `sqlite_sequence.users: ${seqOf(live, 'users')} -> ${snapSeq}`
    );
    await rawClose(snapshotDb);
    snapshotDb = null;
    const snapRw = await openDb(SNAPSHOT_PATH, sqlite3.OPEN_READWRITE);
    await rawRun(
      snapRw,
      `INSERT INTO users (username, email, password_hash, name, phone, capacity,
        earnings_factor, role, is_fired, taking_orders, email_verified, was_employee,
        display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'smoke_vac_probe', 'smoke_vac_probe@test.local', 'x', 'Проба', '', 1, 1,
      'user', 0, 1, 1, 0, 'Проба', Date.now(), Date.now()
    );
    const probeRows = await rawAll(
      snapRw,
      'SELECT id FROM users WHERE username = "smoke_vac_probe"'
    );
    await rawClose(snapRw);
    assert(probeRows.length === 1, 'Не удалось вставить запись в снимок');
    const probeId = probeRows[0].id;
    assert(
      probeId === snapSeq + 1,
      `Новая запись получила id=${probeId}, ожидался ${snapSeq + 1} (счётчик не перенесён)`
    );
    assert(!deletedIds.includes(probeId), 'Новая запись переиспользовала удалённый id!');
    console.log(
      `3. AUTOINCREMENT: sqlite_sequence.users=${snapSeq} перенесён, новая запись в снимке ` +
      `получила id=${probeId}; удалённые ${deletedIds.join(', ')} не переиспользованы`
    );

    console.log('✅ Все проверки пройдены');
  } catch (err) {
    console.error('❌ Ошибка smoke-теста:', err.message);
    process.exitCode = 1;
  } finally {
    if (snapshotDb) { try { await rawClose(snapshotDb); } catch { /* уже закрыта */ } }
    if (backupDb) { try { await rawClose(backupDb); } catch { /* уже закрыта */ } }
    // Соединение с БД закрываем до удаления файлов — иначе SQLite держит
    // временную БД открытой и файл не удаляется (Windows)
    try { await getDB().close(); } catch { /* БД могла не открыться */ }
    try { fs.unlinkSync(SNAPSHOT_PATH); } catch { /* не критично */ }
    for (const file of createdBackups) {
      try { fs.unlinkSync(file); } catch { /* не критично */ }
    }
    // Подчищаем все бэкапы этого теста (в т.ч. если упали до записи в массив)
    try {
      for (const name of fs.readdirSync(BACKUP_DIR)) {
        if (name.startsWith(TEST_DB_BASENAME)) {
          try { fs.unlinkSync(path.join(BACKUP_DIR, name)); } catch { /* не критично */ }
        }
      }
    } catch { /* папки бэкапов может не быть */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* не критично */ }
    }
  }
})();
