#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { openDb } = require('./lib/db');
const Logger = require('./lib/logger');
const { timestamp } = require('./lib/helpers');

// ============================================================================
//  КОНФИГУРАЦИЯ
// ============================================================================
const CONFIG = {
  originalDir: process.env.VERIFY_ORIGINAL_DIR || path.join(__dirname, 'input'),
  mergedDir: process.env.VERIFY_MERGED_DIR || path.join(__dirname, 'output-merged'),
  logsDir: path.join(__dirname, 'logs'),
};

// ============================================================================
//  СПЕЦИФИКАЦИЯ ПРОВЕРКИ
//
//  Для каждой таблицы:
//    - userColumns:     колонки с user_id, которые надо заменить на email
//                       ПЕРЕД хешированием. Позволяет сравнивать данные
//                       логически (у одного сотрудника), а не побайтово
//                       (у которого id при split→merge был нормализован).
//    - excludeFromHash: колонки, которые исключаются из хеша. Например,
//                       users.id — нормализуется намеренно.
//
//  Игнорируются по дизайну (см. TABLES_TO_IGNORE):
//    - model_download_tokens — временные токены, не мигрируются
//    - email_verifications   — при split фильтруются по expires_at > now
//    - password_resets       — аналогично
// ============================================================================
const TABLES_TO_VERIFY = [
  // users — id исключаем (канонизируется при split)
  {
    table: 'users',
    excludeFromHash: ['id'],
  },

  // auth-таблицы
  {
    table: 'refresh_tokens',
    excludeFromHash: ['id'], userColumns: ['user_id']
  },
  {
    table: 'push_subscriptions',
    excludeFromHash: ['id'], userColumns: ['user_id']
  },

  // store-таблицы — PK составные или текстовые, id нет
  { table: 'assignments', userColumns: ['user_id'] },         // PK = order_id
  { table: 'warehouses' },                                    // PK = warehouse_id
  { table: 'user_warehouses', userColumns: ['user_id'] },     // PK composite
  { table: 'user_stats', userColumns: ['user_id'] },          // PK = user_id
  { table: 'product_stats', userColumns: ['user_id'] },       // PK = offer_id

  // earnings — есть AUTOINCREMENT id, исключаем
  {
    table: 'earnings_history',
    excludeFromHash: ['id'], userColumns: ['user_id']
  },
  {
    table: 'earnings_active',
    excludeFromHash: ['id'], userColumns: ['user_id']
  },
  {
    table: 'earnings_adjustments',
    excludeFromHash: ['id'], userColumns: ['user_id']
  },
  {
    table: 'earnings_adjustments_active',
    excludeFromHash: ['id'], userColumns: ['user_id']
  },

  // models
  { table: 'offer_models', userColumns: ['uploaded_by'] },    // PK = offer_id
  {
    table: 'issued_models',
    excludeFromHash: ['id'], userColumns: ['user_id']
  },
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
//  ХЕШ ТАБЛИЦЫ
// ============================================================================
/**
 * Возвращает { hash, count, rows } — канонический хеш содержимого.
 * Ровный для обеих БД, если данные логически одинаковые.
 */
async function hashTable(db, spec, userIdEmailMap) {
  const { table, userColumns = [], excludeFromHash = [] } = spec;
  try {
    const rawRows = await db.all(`SELECT * FROM ${table}`);
    if (!rawRows.length) {
      return { hash: 'EMPTY', count: 0, rows: [] };
    }

    // Нормализация
    const normalized = rawRows.map((row) =>
      normalizeRow(row, { userColumns, excludeFromHash, userIdEmailMap })
    );

    // Сортировка по канонической строке для детерминированного порядка
    normalized.sort((a, b) => {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });

    const json = JSON.stringify(normalized);
    const hash = crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);

    return { hash, count: rawRows.length, rows: normalized };
  } catch (err) {
    return { hash: `ERR:${err.message}`, count: 0, error: err.message, rows: [] };
  }
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
      const origResult = await hashTable(origDb, spec, origUserMap);
      const mergedResult = await hashTable(mergedDb, spec, mergedUserMap);

      const same = origResult.hash === mergedResult.hash
        && origResult.count === mergedResult.count;

      fileReport.tables[spec.table] = {
        original: { count: origResult.count, hash: origResult.hash },
        merged: { count: mergedResult.count, hash: mergedResult.hash },
        status: same ? 'OK' : 'DIFF',
      };

      report.summary.total++;
      if (same) {
        report.summary.ok++;
        if (opts.verbose) {
          logger.info(`  ✅ ${spec.table}: ${origResult.count} строк, hash=${origResult.hash}`);
        }
      } else {
        report.summary.diff++;
        logger.warn(
          `  ⚠️ ${spec.table}: orig(${origResult.count}, ${origResult.hash}) ` +
          `vs merged(${mergedResult.count}, ${mergedResult.hash})`
        );
        // Row-by-row diff
        const diffs = diffRows(origResult.rows || [], mergedResult.rows || [], opts.showDiff);
        fileReport.tables[spec.table].diffSample = diffs;
        for (const d of diffs) {
          logger.warn(`      строка #${d.index}:`);
          logger.warn(`        original: ${JSON.stringify(d.original)}`);
          logger.warn(`        merged:   ${JSON.stringify(d.merged)}`);
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
      // читаем user_stores из output/users.db (рядом с output-merged)
      const usersDbPath = path.join(
        path.dirname(CONFIG.mergedDir), 'output', 'users.db'
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