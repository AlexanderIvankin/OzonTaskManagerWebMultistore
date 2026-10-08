/**
 * Smoke-тест снимка и бэкапа БД через VACUUM INTO.
 * Запуск: node tests/smoke-vacuum-snapshot.js из папки backend/.
 *
 * MULTISTORE: BackupService обходит ВСЕ БД (users / models / notifications /
 * store-N) и кладёт снимки в backups/<label>/. Проверяет, что VACUUM INTO
 * безопасен при параллельной записи и что снимок содержит актуальные данные.
 *
 *  1. Снимок содержит запись, созданную ПРЯМО перед снимком.
 *  2. Явные INTEGER PRIMARY KEY (id пользователей) не пересобраны.
 *  3. AUTOINCREMENT не переиспользует удалённые id.
 *  4. Логическое содержимое всех таблиц + FK-нарушения.
 *  5. Снимок компактнее источника (freelist=0, page_size тот же).
 *  6. toSqliteLiteral безопасно готовит путь для SQL.
 *  7. BackupService.createDbBackup: 4 файла, повторный вызов не пересоздаёт.
 */
const { setup, cleanup } = require('./helpers/setupTestEnv');
const env = setup('1');
const STORE_ID = env.storeId;

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { initDB, closeAll, getUsersDB } = require('../src/config/database');
const { initNotificationsDB, closeNotificationsDB } = require('../src/config/notificationsDatabase');
const { toSqliteLiteral } = require('../src/utils');
const BackupService = require('../src/services/BackupService');
const User = require('../src/models/User');

const TMP_DIR = env.tmpDir;
const SNAPSHOT_PATH = path.join(TMP_DIR, 'snapshot-test.db');

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function openDb(filePath, mode) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, mode, (err) =>
      err ? reject(err) : resolve(db)
    );
  });
}

const rawAll = (db, sql, ...params) =>
  new Promise((res, rej) => db.all(sql, ...params, (e, r) => (e ? rej(e) : res(r))));
const rawRun = (db, sql, ...params) =>
  new Promise((res, rej) => db.run(sql, ...params, (e) => (e ? rej(e) : res())));
const rawClose = (db) => new Promise((res) => db.close(() => res()));

const liveQuery = (db) => (sql) => db.all(sql);
const rawQuery = (db) => (sql) => rawAll(db, sql);
const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');

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
const idsOf = (fp) => fp.users.map((u) => u.id);

(async () => {
  const createdBackups = [];
  const tmpSnapshots = [];
  let snapshotDb = null;
  try {
    console.log('=== Smoke-тест: VACUUM INTO (снимок и бэкап БД) ===');
    await initDB();
    await initNotificationsDB();
    const db = getUsersDB();

    // --- 6. toSqliteLiteral ---
    assert(
      toSqliteLiteral("C:\\tmp\\a'b.db") === "'C:/tmp/a''b.db'",
      `toSqliteLiteral: получено ${toSqliteLiteral("C:\\tmp\\a'b.db")}`
    );
    assert(
      toSqliteLiteral('/var/ozon/x.db') === "'/var/ozon/x.db'",
      'toSqliteLiteral: путь *nix изменён'
    );
    console.log('6. toSqliteLiteral ✅');

    // --- Фикстура ---
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
        role: 'user',
      });
    }
    const allIds = (await db.all('SELECT id FROM users ORDER BY id')).map((r) => r.id);
    const deletedIds = [allIds[1], allIds[4]];
    await db.run('DELETE FROM users WHERE id IN (?, ?)', deletedIds[0], deletedIds[1]);
    await db.run('DELETE FROM smoke_vac_filler');

    // --- 1. Запись ПРЯМО перед снимком ---
    const fresh = await User.create({
      username: 'smoke_vac_fresh',
      email: 'smoke_vac_fresh@test.local',
      passwordHash: 'x',
      name: 'Свежий Вак',
      role: 'user',
    });

    const live = await fingerprint(liveQuery(db));
    const livePath = env.usersDbPath;
    const liveBytes = fs.statSync(livePath).size;

    // --- Снимок ---
    try { fs.unlinkSync(SNAPSHOT_PATH); } catch { }
    await db.exec(`VACUUM INTO ${toSqliteLiteral(SNAPSHOT_PATH)}`);
    tmpSnapshots.push(SNAPSHOT_PATH);

    snapshotDb = await openDb(SNAPSHOT_PATH, sqlite3.OPEN_READONLY);
    const snap = await fingerprint(rawQuery(snapshotDb));
    const snapBytes = fs.statSync(SNAPSHOT_PATH).size;

    assert(
      snap.users.some((u) => u.id === fresh.id && u.username === 'smoke_vac_fresh'),
      'Снимок не содержит запись, созданную ПЕРЕД снимком!'
    );
    console.log(`1. Снимок содержит свежую запись id=${fresh.id} ✅`);

    // --- 2. id сохранены ---
    assert(
      JSON.stringify(idsOf(snap)) === JSON.stringify(idsOf(live)),
      `id изменились: [${idsOf(live)}] -> [${idsOf(snap)}]`
    );
    assert(!idsOf(snap).some((id) => deletedIds.includes(id)), 'Удалённые id вернулись');
    console.log(`2. id сохранены, удалённые ${deletedIds.join(', ')} не вернулись ✅`);

    // --- 4. Контент + FK ---
    assert(
      JSON.stringify(snap.tables) === JSON.stringify(live.tables),
      'Список таблиц изменился'
    );
    const changedTables = live.tables.filter((t) => live.hashes[t] !== snap.hashes[t]);
    assert(changedTables.length === 0, `Содержимое изменилось: ${changedTables.join(', ')}`);
    assert(snap.fkViolations === 0, `FK-нарушений: ${snap.fkViolations}`);
    console.log(`4. Содержимое всех ${snap.tables.length} таблиц идентично, FK-нарушений нет ✅`);

    // --- 5. Сжатие + целостность ---
    assert(live.freelist > 0, 'Фикстура не создала фрагментацию');
    assert(snap.freelist === 0, `В снимке остался freelist: ${snap.freelist}`);
    assert(snapBytes < liveBytes, `Снимок не компактнее: ${liveBytes} -> ${snapBytes}`);
    assert(snapBytes % snap.pageSize === 0, 'Размер снимка не кратен page_size');
    assert(snap.pageSize === live.pageSize, 'page_size изменился');
    assert(
      snap.quickCheck.length === 1 && snap.quickCheck[0] === 'ok',
      `quick_check снимка: ${snap.quickCheck.join('; ')}`
    );
    console.log(
      `5. Сжатие: ${liveBytes} Б (freelist ${live.freelist}) -> ${snapBytes} Б, quick_check ok ✅`
    );

    // --- 3. AUTOINCREMENT ---
    const snapSeq = seqOf(snap, 'users');
    assert(snapSeq === seqOf(live, 'users'), `sqlite_sequence.users: ${seqOf(live, 'users')} -> ${snapSeq}`);
    await rawClose(snapshotDb);
    snapshotDb = null;
    const snapRw = await openDb(SNAPSHOT_PATH, sqlite3.OPEN_READWRITE);
    await rawRun(
      snapRw,
      `INSERT INTO users (username, email, password_hash, name, phone, capacity,
        taking_orders, role, email_verified, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'smoke_vac_probe', 'smoke_vac_probe@test.local', 'x', 'Проба', '', 1,
      1, 'user', 1, 'Проба', Date.now(), Date.now()
    );
    const probeRows = await rawAll(snapRw, 'SELECT id FROM users WHERE username = "smoke_vac_probe"');
    await rawClose(snapRw);
    assert(probeRows.length === 1, 'Не удалось вставить запись в снимок');
    const probeId = probeRows[0].id;
    assert(probeId === snapSeq + 1, `Новая запись id=${probeId}, ожидался ${snapSeq + 1}`);
    assert(!deletedIds.includes(probeId), 'Новая запись переиспользовала удалённый id!');
    console.log(`3. AUTOINCREMENT: seq=${snapSeq} перенесён, probe id=${probeId} ✅`);

    // --- 7. BackupService ---
    // Реальная backend/backups/ не тронута: BACKUP_DIR указывает на tests/tmp/backups.
    const manual = await BackupService.createDbBackup({ includeTime: true });
    if (manual.errors.length) {
      throw new Error('BackupService: ошибки — ' + manual.errors.map(e => `${e.label}: ${e.message}`).join('; '));
    }
    console.log(`7. BackupService: создано ${manual.created.length} файлов, пропущено ${manual.skipped.length}`);
    assert(manual.created.length >= 4, `Ожидалось минимум 4 файла, получено ${manual.created.length}`);
    for (const f of manual.created) {
      createdBackups.push(f);
      assert(fs.existsSync(f), `Файл бэкапа не существует: ${f}`);
      assert(fs.statSync(f).size > 0, `Пустой бэкап: ${f}`);
      const bdb = await openDb(f, sqlite3.OPEN_READONLY);
      const qc = await rawAll(bdb, 'PRAGMA quick_check');
      await rawClose(bdb);
      assert(qc[0] && Object.values(qc[0])[0] === 'ok', `quick_check ${path.basename(f)}: ${JSON.stringify(qc)}`);
    }

    // Ежедневный бэкап: created + skipped = минимум 4 (created — если сегодня
    // ещё не было; skipped — если файл уже существует от прошлого прогона).
    const daily = await BackupService.createDbBackup({ includeTime: false });
    assert(daily.errors.length === 0, 'Ежедневный бэкап: ошибки');
    assert(
      daily.created.length + daily.skipped.length >= 4,
      `Ежедневный: обработано ${daily.created.length + daily.skipped.length}, ожидалось >=4`
    );
    for (const f of daily.created) createdBackups.push(f);

    // Повторный ежедневный — всё пропускает (идемпотентность).
    const dailyAgain = await BackupService.createDbBackup({ includeTime: false });
    assert(dailyAgain.created.length === 0, 'Повторный ежедневный создал файлы (должен всё пропустить)');
    assert(
      dailyAgain.skipped.length >= 4,
      `Повторный ежедневный: пропущено ${dailyAgain.skipped.length}, ожидалось >=4`
    );
    console.log('7b. Ежедневный бэкап идемпотентен ✅');

    console.log('✅ Все проверки пройдены');
  } catch (err) {
    console.error('❌ Ошибка smoke-теста:', err.message);
    process.exitCode = 1;
  } finally {
    if (snapshotDb) { try { await rawClose(snapshotDb); } catch { } }
    try { await closeNotificationsDB(); } catch { }
    try { await closeAll(); } catch { }
    // Убираем тестовые снимки и бэкапы
    for (const f of [...tmpSnapshots, ...createdBackups]) {
      try { fs.unlinkSync(f); } catch { }
    }
    // Реальная backend/backups/ не тронута — тест писал в tests/tmp/backups.
    // Явно удалим только те файлы, что создал тест (для страховки — если
    // cleanup из helper не сработал).
    for (const f of createdBackups) {
      try { fs.unlinkSync(f); } catch { }
    }
    cleanup();
  }
})();