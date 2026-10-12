#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { openDb } = require('./lib/db');
const Logger = require('./lib/logger');
const { timestamp, normalizeEmail } = require('./lib/helpers');

// ============================================================================
//  КОНФИГУРАЦИЯ
// ============================================================================
const CONFIG = {
  // Оригиналы — те же bot_web-N.db, что подавались на split
  originalDir: path.join(__dirname, 'web-multistore_input'),
  // Результат merge
  mergedDir: path.join(__dirname, 'web-multistore_output-merged'),
  logsDir: path.join(__dirname, 'logs'),
};

// ============================================================================
//  Спецификация проверки.
//
//  Два режима:
//
//    exact (по умолчанию) — полное совпадение (hash + count). Для таблиц,
//      которые store-scoped и в single-store, и в multistore: их содержимое
//      НЕ дедуплицируется при split, поэтому снимок до и после round-trip
//      должен быть идентичен.
//
//    key-subset — для ГЛОБАЛЬНЫХ таблиц multistore (users, auth-хвосты,
//      models). Эти таблицы при merge выгружаются ЦЕЛИКОМ в каждый
//      bot_web-N.db: оригинальная bot_web-N.db содержала только «свою
//      часть», а merged — полный снимок. Плюс dedup по email может
//      «слить» две записи с одинаковым email и разными полями — в итоге
//      один email останется, но с полями из ведущего файла (bot_web-1).
//      Поэтому сравниваем ТОЛЬКО набор ключей (email, token, endpoint,
//      offer_id, (email,offer_id)), но НЕ значения остальных полей.
//
//      Реальная потеря данных (например, email вообще отсутствует в merged)
//      этим режимом всё равно ловится.
//
//  keyFields — массив колонок, образующих «ключ строки». Для ключей типа
//  user_id применяется маппинг в email (как и в normalizeRow) — это
//  устойчиво к разному id-проставлению в single-store и multistore.
// ============================================================================
const TABLES_TO_VERIFY = [
  // ---- ГЛОБАЛЬНЫЕ таблицы multistore → key-subset ----
  { table: 'users', keyFields: ['email'] },
  { table: 'refresh_tokens', keyFields: ['token'] },
  { table: 'push_subscriptions', keyFields: ['endpoint'] },
  { table: 'offer_models', keyFields: ['offer_id'] },
  { table: 'issued_models', keyFields: ['user_id', 'offer_id'], userColumns: ['user_id'] },

  // ---- STORE-SCOPED таблицы → exact ----
  { table: 'assignments', userColumns: ['user_id'] },
  { table: 'warehouses' },
  { table: 'user_warehouses', userColumns: ['user_id'] },
  { table: 'user_stats', userColumns: ['user_id'] },
  { table: 'product_stats', userColumns: ['user_id'] },
  { table: 'earnings_history', excludeFromHash: ['id'], userColumns: ['user_id'] },
  { table: 'earnings_active', excludeFromHash: ['id'], userColumns: ['user_id'] },
  { table: 'earnings_adjustments', excludeFromHash: ['id'], userColumns: ['user_id'] },
  { table: 'earnings_adjustments_active', excludeFromHash: ['id'], userColumns: ['user_id'] },
];

const TABLES_TO_IGNORE = [
  'model_download_tokens',
  'email_verifications',
  'password_resets',
];

// ============================================================================
//  КЛИ
// ============================================================================
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { verbose: false, showDiff: 3 };
  for (const a of args) {
    if (a === '--verbose') opts.verbose = true;
    else if (a.startsWith('--show-diff=')) {
      opts.showDiff = parseInt(a.slice(12), 10) || 3;
    }
  }
  return opts;
}

// ============================================================================
//  КАРТА user_id → email
// ============================================================================
/**
 * Строит карту user_id → нормализованный email.
 * Используется для замены user_id в других таблицах ПЕРЕД хешированием.
 * @param {Object} db
 * @returns {Promise<Map<number, string>>}
 */
async function buildUserIdEmailMap(db) {
  const map = new Map();
  const rows = await db.all('SELECT id, email FROM users');
  for (const r of rows) {
    const email = (r.email || '').trim().toLowerCase();
    if (email) map.set(r.id, email);
  }
  return map;
}

// ============================================================================
//  НОРМАЛИЗАЦИЯ СТРОКИ
// ============================================================================
/**
 * Канонизирует строку: сортирует ключи по алфавиту, чтобы порядок колонок
 * в схеме не влиял на хеш (в оригинале ALTER TABLE ADD COLUMN добавляет
 * колонки в конец, в merged-схеме они идут в «логичном» порядке).
 *
 * @param {Object} row
 * @param {Object} opts
 *   - userColumns:     колонки с user_id → заменяем на email
 *   - excludeFromHash: колонки, исключаемые из хеша
 *   - userIdEmailMap:  карта для подмены
 */
function normalizeRow(row, opts = {}) {
  const { userColumns = [], excludeFromHash = [], userIdEmailMap = new Map() } = opts;
  const sorted = {};
  for (const key of Object.keys(row).sort()) {
    if (excludeFromHash.includes(key)) continue;
    let value = row[key];
    // Замена user_id → email
    if (userColumns.includes(key) && value != null) {
      const email = userIdEmailMap.get(value);
      value = email != null ? email : `ORPHAN:${value}`;
    }
    sorted[key] = value;
  }
  return sorted;
}

// ============================================================================
//  СРАВНЕНИЕ ТАБЛИЦЫ
//
//  exact  — hash полного массива + count
//  subset — каждая строка оригинала должна быть в merged; больше строк в
//           merged допустимо
// ============================================================================
async function compareTable(origDb, mergedDb, spec, origUserMap, mergedUserMap) {
  const { table, userColumns = [], excludeFromHash = [], keyFields = null } = spec;

  let origRaw, mergedRaw;
  try {
    origRaw = await origDb.all(`SELECT * FROM ${table}`);
  } catch (err) {
    return { status: 'ERR', error: `orig: ${err.message}`, count: 0 };
  }
  try {
    mergedRaw = await mergedDb.all(`SELECT * FROM ${table}`);
  } catch (err) {
    return { status: 'ERR', error: `merged: ${err.message}`, count: 0 };
  }

  if (!origRaw.length && !mergedRaw.length) {
    return { status: 'OK', count: 0, hash: 'EMPTY', origCount: 0, mergedCount: 0 };
  }

  // ==========================================================================
  //  key-subset (для глобальных таблиц multistore)
  // ==========================================================================
  if (keyFields) {
    const extractKey = (row, userMap) =>
      keyFields
        .map((f) => {
          let v = row[f];
          // user_id / uploaded_by — заменяем на email, чтобы id-проставление
          // в single-store и multistore не мешало сравнению.
          if (userColumns.includes(f)) {
            v = userMap.get(v) ?? `ORPHAN:${v}`;
          }
          // Email нормализуем — иначе `Ivan@Mail.ru` в bot_web-2 не совпадёт
          // с `ivan@mail.ru` в merged (который унаследовал значение из
          // bot_web-1 — ведущего файла). split.js при дедупе использует
          // normalizeEmail, так что и verify должен делать то же.
          if (f === 'email') {
            v = normalizeEmail(v);
          }
          return String(v ?? '');
        })
        .join('::');

    // Мультимножество ключей merged — на случай, если в merged легитимно
    // оказалось два ряда с одинаковым ключом (не должно быть, но пусть).
    const mergedKeys = new Map();
    for (const r of mergedRaw) {
      const k = extractKey(r, mergedUserMap);
      mergedKeys.set(k, (mergedKeys.get(k) || 0) + 1);
    }

    const missing = [];
    for (const r of origRaw) {
      const k = extractKey(r, origUserMap);
      const cnt = mergedKeys.get(k) || 0;
      if (cnt === 0) {
        missing.push({ key: k, row: r });
      } else {
        mergedKeys.set(k, cnt - 1);
      }
    }

    const status = missing.length === 0 ? 'OK' : 'DIFF';
    return {
      status,
      origCount: origRaw.length,
      mergedCount: mergedRaw.length,
      hash: `key-subset(${origRaw.length}⊆${mergedRaw.length})`,
      origHash: 'key-subset',
      mergedHash: 'key-subset',
      missingSample: missing.slice(0, 5),
    };
  }

  // ==========================================================================
  //  exact (для store-scoped таблиц)
  // ==========================================================================
  const origRows = origRaw.map(r =>
    normalizeRow(r, { userColumns, excludeFromHash, userIdEmailMap: origUserMap })
  );
  const mergedRows = mergedRaw.map(r =>
    normalizeRow(r, { userColumns, excludeFromHash, userIdEmailMap: mergedUserMap })
  );

  const sortKey = r => JSON.stringify(r);
  origRows.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  mergedRows.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));

  const origHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(origRows))
    .digest('hex')
    .slice(0, 16);
  const mergedHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(mergedRows))
    .digest('hex')
    .slice(0, 16);

  const same = origRows.length === mergedRows.length && origHash === mergedHash;

  return {
    status: same ? 'OK' : 'DIFF',
    count: origRaw.length,
    hash: origHash,
    origCount: origRaw.length,
    mergedCount: mergedRaw.length,
    origHash,
    mergedHash,
    diffSample: same ? null : diffRows(origRows, mergedRows, 3),
  };
}

// ============================================================================
//  ROW-BY-ROW DIFF (для отладки расхождений)
// ============================================================================
/**
 * Возвращает первые N отличающихся строк (индекс, оригинал, merged).
 * Использует уже отсортированные нормализованные массивы.
 */
function diffRows(origRows, mergedRows, maxShow = 3) {
  const diffs = [];
  const maxLen = Math.max(origRows.length, mergedRows.length);
  for (let i = 0; i < maxLen && diffs.length < maxShow; i++) {
    const left = i < origRows.length ? origRows[i] : null;
    const right = i < mergedRows.length ? mergedRows[i] : null;
    const leftStr = left ? JSON.stringify(left) : null;
    const rightStr = right ? JSON.stringify(right) : null;
    if (leftStr !== rightStr) {
      diffs.push({
        index: i,
        original: left,
        merged: right,
      });
    }
  }
  return diffs;
}

// ============================================================================
//  MAIN
// ============================================================================
async function main() {
  const opts = parseArgs();
  const startedAt = Date.now();
  const ts = timestamp();
  const logPath = path.join(CONFIG.logsDir, `verify_${ts}.log`);
  const reportPath = path.join(CONFIG.logsDir, `verify_${ts}.report.json`);
  const logger = new Logger(logPath);

  logger.info('=== Verify round-trip: original vs merged ===');
  logger.info(`original: ${CONFIG.originalDir}`);
  logger.info(`merged:   ${CONFIG.mergedDir}`);
  logger.info(`опции:    ${JSON.stringify(opts)}`);

  const report = {
    direction: 'verify-roundtrip',
    startedAt,
    finishedAt: null,
    durationMs: null,
    options: opts,
    files: {},
    summary: { total: 0, ok: 0, diff: 0, error: 0, ignored: 0 },
    errors: [],
  };

  // Находим все bot_web-N.db в original
  const originalFiles = fs.readdirSync(CONFIG.originalDir)
    .filter((f) => /^bot_web-\d+\.db$/i.test(f))
    .map((f) => ({
      name: f,
      version: parseInt((f.match(/^bot_web-(\d+)\.db$/i) || [])[1] || '0', 10),
      path: path.join(CONFIG.originalDir, f),
    }))
    .sort((a, b) => a.version - b.version);

  if (!originalFiles.length) {
    throw new Error(`В ${CONFIG.originalDir} не найдено bot_web-N.db`);
  }

  logger.info(`Найдено оригиналов: ${originalFiles.length}`);

  for (const orig of originalFiles) {
    const mergedPath = path.join(CONFIG.mergedDir, orig.name);
    if (!fs.existsSync(mergedPath)) {
      logger.error(`❌ ${orig.name}: merged-версия не найдена (${mergedPath})`);
      report.files[orig.name] = { status: 'MISSING_MERGED' };
      report.summary.error++;
      continue;
    }

    logger.info(`\n--- ${orig.name} ---`);
    const fileReport = {
      version: orig.version,
      isCanonical: orig.version === 1,
      tables: {},
      fkCheck: null,
    };

    const origDb = await openDb(orig.path, { readonly: true });
    const mergedDb = await openDb(mergedPath, { readonly: true });

    // Карты user_id → email для каждой БД
    const origUserMap = await buildUserIdEmailMap(origDb);
    const mergedUserMap = await buildUserIdEmailMap(mergedDb);

    // Проверка каждой таблицы
    for (const spec of TABLES_TO_VERIFY) {
      const result = await compareTable(origDb, mergedDb, spec, origUserMap, mergedUserMap);

      fileReport.tables[spec.table] = {
        original: { count: result.origCount ?? result.count, hash: result.origHash ?? result.hash },
        merged: { count: result.mergedCount ?? result.count, hash: result.mergedHash ?? result.hash },
        mode: spec.keyFields ? 'key-subset' : 'exact',
        status: result.status,
      };

      report.summary.total++;
      if (result.status === 'OK') {
        report.summary.ok++;
        if (opts.verbose) {
          const suffix = spec.keyFields
            ? ` (${result.origCount} ⊆ ${result.mergedCount}, глобальная таблица)`
            : ` (${result.count}, hash=${result.hash})`;
          logger.info(`  ✅ ${spec.table}${suffix}`);
        }
      } else {
        report.summary.diff++;
        const mode = spec.keyFields ? 'key-subset' : 'exact';
        logger.warn(
          `  ⚠️ ${spec.table} [${mode}]: ` +
          `orig=${result.origCount}, merged=${result.mergedCount}`
        );
        if (spec.keyFields && result.missingSample?.length) {
          for (const m of result.missingSample) {
            logger.warn(`      отсутствует в merged: key=${m.key}`);
            logger.warn(`        row: ${JSON.stringify(m.row)}`);
          }
          fileReport.tables[spec.table].missingSample = result.missingSample;
        } else if (!spec.keyFields && result.diffSample) {
          fileReport.tables[spec.table].diffSample = result.diffSample;
          for (const d of result.diffSample) {
            logger.warn(`      строка #${d.index}:`);
            logger.warn(`        original: ${JSON.stringify(d.original)}`);
            logger.warn(`        merged:   ${JSON.stringify(d.merged)}`);
          }
        }
      }
    }

    // Игнорируемые таблицы — информационно
    for (const t of TABLES_TO_IGNORE) {
      try {
        const o = await origDb.get(`SELECT COUNT(*) AS c FROM ${t}`);
        const m = await mergedDb.get(`SELECT COUNT(*) AS c FROM ${t}`);
        fileReport.tables[t] = {
          original: { count: o.c },
          merged: { count: m.c },
          status: 'IGNORED',
        };
        report.summary.ignored++;
        logger.info(
          `  ℹ️ ${t}: original=${o.c}, merged=${m.c} (игнорируется по дизайну)`
        );
      } catch (_) {
        // Таблицы может не быть в одной из БД — норм
      }
    }

    // --- Проверка user_stores: сверка количества сотрудников в users.db
    //     с количеством staff-ролей в оригинальной bot_web-N.db ---
    if (orig.version === 1) {
      // читаем user_stores из web-multistore_output/users.db (рядом с output-merged)
      const usersDbPath = path.join(
        __dirname, 'web-multistore_output', 'users.db'
      );
      if (fs.existsSync(usersDbPath)) {
        const usersDb = await openDb(usersDbPath, { readonly: true });
        const usRows = await usersDb.all(
          'SELECT role, is_fired, COUNT(*) as cnt FROM user_stores WHERE store_id = ? GROUP BY role, is_fired',
          String(orig.version)
        );
        await usersDb.close();

        // Считаем staff в оригинале: god + admin + moderator + employee + уволенные user
        const origStaff = await origDb.get(`
          SELECT COUNT(*) as cnt FROM users
          WHERE role IN ('god', 'admin', 'moderator', 'employee')
             OR (role = 'user' AND is_fired = 1)
        `);

        const usTotal = usRows.reduce((sum, r) => sum + r.cnt, 0);
        fileReport.userStoresCheck = {
          userStoresCount: usTotal,
          originalStaffCount: origStaff.cnt,
          status: usTotal === origStaff.cnt ? 'OK' : 'DIFF',
          breakdown: usRows,
        };
        if (usTotal === origStaff.cnt) {
          logger.info(`  ✅ user_stores(store=${orig.version}): ${usTotal} записей = staff в оригинале`);
        } else {
          logger.warn(
            `  ⚠️ user_stores(store=${orig.version}): ` +
            `${usTotal} записей ≠ ${origStaff.cnt} staff в оригинале`
          );
        }
      }
    }

    // FK-целостность merged
    try {
      const fkCheck = await mergedDb.all('PRAGMA foreign_key_check');
      fileReport.fkCheck = {
        violations: fkCheck.length,
        sample: fkCheck.slice(0, 5),
      };
      if (fkCheck.length) {
        logger.warn(`  ⚠️ FK violations в merged: ${fkCheck.length}`);
        for (const v of fkCheck.slice(0, 5)) {
          logger.warn(`      ${JSON.stringify(v)}`);
        }
      } else {
        logger.info(`  ✅ FK integrity: OK`);
      }
    } catch (err) {
      fileReport.fkCheck = { error: err.message };
    }

    await origDb.close();
    await mergedDb.close();

    report.files[orig.name] = fileReport;
  }

  report.finishedAt = Date.now();
  report.durationMs = report.finishedAt - startedAt;

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  printReport(report, logger);
  logger.info(`\n📄 Отчёт: ${reportPath}`);
  logger.info(`📄 Лог:   ${logPath}`);

  await logger.close();

  // Код выхода: 0 — всё OK, 1 — есть DIFF или ошибки
  if (report.summary.diff > 0 || report.summary.error > 0) process.exit(1);
}

// ============================================================================
//  PRINT REPORT
// ============================================================================
function printReport(report, logger) {
  logger.info('\n============ ИТОГ VERIFY ============');
  logger.info(`Файлов проверено:  ${Object.keys(report.files).length}`);
  logger.info(`Таблиц проверено:  ${report.summary.total}`);
  logger.info(`  ✅ OK:           ${report.summary.ok}`);
  logger.info(`  ⚠️ DIFF:         ${report.summary.diff}`);
  logger.info(`  ℹ️ Игнорировано: ${report.summary.ignored}`);
  logger.info(`Длительность:      ${(report.durationMs / 1000).toFixed(2)} с`);

  if (report.summary.diff > 0) {
    logger.warn(`\n⚠️ Обнаружены РАСХОЖДЕНИЯ:`);
    for (const [file, fr] of Object.entries(report.files)) {
      if (!fr.tables) continue;
      for (const [table, tr] of Object.entries(fr.tables)) {
        if (tr.status === 'DIFF') {
          logger.warn(
            `  [${file}] ${table}: ` +
            `orig=${tr.original.count} (${tr.original.hash}) ` +
            `merged=${tr.merged.count} (${tr.merged.hash})`
          );
        }
      }
    }
  } else if (report.summary.error === 0) {
    logger.info(`\n🎉 Все таблицы логически совпадают! Round-trip успешен.`);
  }
  logger.info('=====================================');
}

main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});