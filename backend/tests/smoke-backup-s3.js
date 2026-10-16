/**
 * Smoke-тест бэкапов БД с выгрузкой на S3 (фейковый S3).
 *
 * Запуск: node tests/smoke-backup-s3.js из папки backend/.
 *
 * MULTISTORE: бэкап обходит ВСЕ БД приложения (users, models, notifications,
 * все store-N.db), делает VACUUM-снимки, собирает их в один ZIP и (если
 * включено) заливает на S3 в отдельный bucket для бэкапов.
 *
 * Проверки:
 *   • createDbBackup делает VACUUM-снимки всех БД (created[] не пуст);
 *   • при BACKUP_S3_ENABLED=true zip собирается и уходит на S3;
 *   • ключ объекта — <prefix>databases_YYYY-MM-DD.zip;
 *   • ручной бэкап (includeTime=true) → имя с временем HH-MM-SS;
 *   • retention на S3 удаляет архивы старше BACKUP_S3_RETENTION_DAYS;
 *   • при BACKUP_S3_ENABLED=false — S3 не трогается вообще;
 *   • ошибка S3 (PutObject) не роняет createDbBackup: errors[] содержит
 *     запись 's3-upload', локальные бэкапы созданы.
 */

'use strict';

const path = require('path');
const fs = require('fs');

// ============================================================================
// ПОРЯДОК ВАЖЕН:
//   1. setup() — устанавливает BACKUP_DIR, DB-пути, .env.store1.
//   2. Устанавливаем BACKUP_S3_* — их setup() не трогает.
//   3. ТОЛЬКО ТЕПЕРЬ require сервисов: config/index.js и config/s3.js
//      читают process.env на этапе первого require и кэшируют результат.
// ============================================================================
const { setup, cleanup } = require('./helpers/setupTestEnv');
const STORE_ID = setup('1').storeId;

process.env.BACKUP_S3_ENABLED = 'true';
process.env.BACKUP_S3_BUCKET = 'test-backup-bucket';
process.env.BACKUP_S3_PREFIX = 'test-backups/';
process.env.BACKUP_S3_RETENTION_DAYS = '7';
process.env.BACKUP_LOCAL_RETENTION_DAYS = '7';

// Явно подменяем креды, чтобы тест был герметичным и НЕ печатал префикс
// реального ключа из .env. Если .env содержит BACKUP_S3_*, dotenv их
// НЕ перезатрёт (уже установлены в process.env) — а нам это и нужно.
process.env.BACKUP_S3_ENDPOINT = 'https://fake-backup-s3.test';
process.env.BACKUP_S3_REGION = 'test-region';
process.env.BACKUP_S3_ACCESS_KEY = 'TEST_ACCESS_KEY';
process.env.BACKUP_S3_SECRET_KEY = 'TEST_SECRET_KEY';

const { initDB, closeAll } = require('../src/config/database');
const { initNotificationsDB, closeNotificationsDB } = require('../src/config/notificationsDatabase');
const { s3Backup, BACKUP_BUCKET, BACKUP_PREFIX } = require('../src/config/s3');
const config = require('../src/config');
const BackupService = require('../src/services/BackupService');

// ---------- Фейковый S3 ----------
const fakeS3 = new Map(); // Key -> Buffer
let s3FailNext = null;    // 'put' | 'list' | null

s3Backup.send = async (cmd) => {
  const kind = cmd.constructor.name;
  const input = cmd.input || {};

  if (s3FailNext === 'put' && kind === 'PutObjectCommand') {
    s3FailNext = null;
    throw new Error('SMOKE: PutObject simulated failure');
  }
  if (s3FailNext === 'list' && kind === 'ListObjectsV2Command') {
    s3FailNext = null;
    throw new Error('SMOKE: ListObjectsV2 simulated failure');
  }

  switch (kind) {
    case 'PutObjectCommand': {
      if (input.Bucket !== BACKUP_BUCKET) {
        throw new Error(`SMOKE: PutObject в неверный bucket: ${input.Bucket}`);
      }
      const body = Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(input.Body);
      fakeS3.set(input.Key, body);
      return {};
    }
    case 'ListObjectsV2Command': {
      const prefix = input.Prefix || '';
      const contents = Array.from(fakeS3.entries())
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, buf]) => ({ Key: k, Size: buf.length }));
      return { Contents: contents, IsTruncated: false };
    }
    case 'DeleteObjectsCommand': {
      const objects = input.Delete?.Objects || [];
      for (const o of objects) fakeS3.delete(o.Key);
      return {};
    }
    default:
      throw new Error(`SMOKE: неожиданная S3-команда: ${kind}`);
  }
};

// ---------- assert ----------
let assertCount = 0;
function assert(cond, label) {
  assertCount++;
  if (!cond) throw new Error(`Проверка провалена: ${label}`);
  console.log(`  ✔ ${label}`);
}

function findBackupZips() {
  return Array.from(fakeS3.keys()).filter((k) => k.endsWith('.zip'));
}

function listLocalDbFiles() {
  const out = [];
  const dir = process.env.BACKUP_DIR;
  if (!dir || !fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.db')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// ---------- main ----------
(async () => {
  try {
    console.log('=== Smoke-тест бэкапов БД + S3 (фейковый) ===');
    await initDB();
    await initNotificationsDB();

    // ---- Санити: env/config подхватились ----
    assert(config.backup.s3Enabled === true, 'config.backup.s3Enabled = true');
    assert(config.backup.s3Bucket === 'test-backup-bucket',
      `config.backup.s3Bucket = ${config.backup.s3Bucket}`);
    assert(BACKUP_BUCKET === 'test-backup-bucket', `BACKUP_BUCKET = ${BACKUP_BUCKET}`);
    assert(BACKUP_PREFIX === 'test-backups/', `BACKUP_PREFIX = ${BACKUP_PREFIX}`);
    assert(config.backup.s3RetentionDays === 7, 'config.backup.s3RetentionDays = 7');
    assert(
      typeof process.env.BACKUP_DIR === 'string'
      && process.env.BACKUP_DIR.includes(path.join('tests', 'tmp')),
      `BACKUP_DIR в tests/tmp (${process.env.BACKUP_DIR})`
    );

    // --------------------------------------------------------------------
    // 1. Ежедневный бэкап (includeTime=false)
    // --------------------------------------------------------------------
    console.log('\n[1] createDbBackup({ includeTime: false })');
    const r1 = await BackupService.createDbBackup({ includeTime: false });
    assert(r1.created.length > 0, `создано локальных снимков: ${r1.created.length}`);
    assert(r1.errors.length === 0, `ошибок нет (${JSON.stringify(r1.errors)})`);
    assert(Array.isArray(r1.skipped), 'вернулся skipped[]');

    const localDbs = listLocalDbFiles();
    assert(localDbs.length === r1.created.length,
      `локальных .db: ${localDbs.length} (совпадает с created[])`);
    for (const f of localDbs) {
      assert(fs.statSync(f).size > 0, `непустой ${path.basename(f)}`);
    }

    const zips1 = findBackupZips();
    assert(zips1.length === 1, `на S3 ровно 1 zip после daily: ${zips1.join(', ')}`);

    const zipName1 = zips1[0].slice(BACKUP_PREFIX.length);
    assert(
      /^databases_\d{4}-\d{2}-\d{2}\.zip$/.test(zipName1),
      `имя zip — databases_YYYY-MM-DD.zip (${zipName1})`
    );
    const zipBody1 = fakeS3.get(zips1[0]);
    assert(zipBody1 && zipBody1.length > 0, `zip непустой (${zipBody1.length} Б)`);
    assert(
      zipBody1[0] === 0x50 && zipBody1[1] === 0x4b,
      'содержимое — ZIP (magic PK)'
    );

    // --------------------------------------------------------------------
    // 2. Ручной бэкап (includeTime=true) — имя с временем
    // --------------------------------------------------------------------
    console.log('\n[2] createDbBackup({ includeTime: true })');
    const r2 = await BackupService.createDbBackup({ includeTime: true });
    assert(r2.errors.length === 0, 'ручной бэкап без ошибок');
    const zips2 = findBackupZips();
    assert(zips2.length === 2, `на S3 теперь 2 zip (daily + manual): ${zips2.length}`);
    const manualName = zips2
      .map((k) => k.slice(BACKUP_PREFIX.length))
      .find((n) => /_\d{2}-\d{2}-\d{2}\.zip$/.test(n));
    assert(
      !!manualName
      && /^databases_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/.test(manualName),
      `ручной zip — databases_YYYY-MM-DD_HH-MM-SS.zip (${manualName})`
    );

    // --------------------------------------------------------------------
    // 3. S3 retention: кладём «старый» объект, следующий прогон его удалит
    // --------------------------------------------------------------------
    console.log('\n[3] S3 retention удаляет старые архивы');
    const oldKey = `${BACKUP_PREFIX}databases_2020-01-01.zip`;
    fakeS3.set(oldKey, Buffer.from('PK\x03\x04old-dummy'));
    assert(fakeS3.has(oldKey), 'старый архив помещён в фейковый S3');

    await BackupService.createDbBackup({ includeTime: false });
    assert(!fakeS3.has(oldKey), 'старый архив удалён retention-логикой');
    assert(findBackupZips().length >= 2, 'свежие архивы не тронуты');

    // --------------------------------------------------------------------
    // 4. s3Enabled=false — S3 не трогаем
    // --------------------------------------------------------------------
    console.log('\n[4] BACKUP_S3_ENABLED=false — S3 не трогаем');
    const beforeCount = fakeS3.size;
    config.backup.s3Enabled = false;
    try {
      const r4 = await BackupService.createDbBackup({ includeTime: true });
      assert(r4.errors.length === 0, 'local-only бэкап без ошибок');
      assert(fakeS3.size === beforeCount, 'новых объектов в S3 нет');
    } finally {
      config.backup.s3Enabled = true;
    }

    // --------------------------------------------------------------------
    // 5. Ошибка S3 (PutObject) не роняет createDbBackup
    // --------------------------------------------------------------------
    console.log('\n[5] Ошибка S3 не роняет createDbBackup');
    const errsBefore = fakeS3.size;
    s3FailNext = 'put';
    const r5 = await BackupService.createDbBackup({ includeTime: true });
    assert(r5.created.length > 0, 'локальные снимки сделаны, несмотря на S3-сбой');
    assert(
      r5.errors.some((e) => e.label === 's3-upload'),
      `errors[] содержит s3-upload (${JSON.stringify(r5.errors)})`
    );
    assert(fakeS3.size === errsBefore, 'новых объектов в S3 нет (upload упал)');

    // --------------------------------------------------------------------
    // 6. Ошибка S3 (ListObjectsV2 / retention) не роняет createDbBackup
    // --------------------------------------------------------------------
    console.log('\n[6] Ошибка retention (ListObjectsV2) не роняет бэкап');
    s3FailNext = 'list';
    const r6 = await BackupService.createDbBackup({ includeTime: true });
    assert(r6.created.length > 0, 'локальный бэкап сделан');
    // upload прошёл, retention просто залогировал warn
    assert(findBackupZips().length > 2, 'upload продолжил работать');

    console.log(`\n=== Smoke-тест пройден ✅ (проверок: ${assertCount}) ===`);
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    // setupTestEnv.cleanup() уже удалит tests/tmp/backups/ и временные БД.
    try { await closeNotificationsDB(); } catch { /* ok */ }
    try { await closeAll(); } catch { /* ok */ }
    cleanup();
  }
})();