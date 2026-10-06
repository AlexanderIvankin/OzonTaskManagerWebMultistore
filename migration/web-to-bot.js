#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { openDb, backupDb, transaction, assertTables } = require('./lib/db');
const Logger = require('./lib/logger');
const { resolveWebToBot } = require('./lib/identity');
const { normalizeEmail, normalizeTgId, timestamp } = require('./lib/helpers');

// ============================================================================
//  КОНФИГУРАЦИЯ
// ============================================================================
const CONFIG = {
  webDbPath: process.env.WEB_DB || path.join(__dirname, 'output', 'bot_web.db'),
  botDbPath: process.env.BOT_DB || path.join(__dirname, 'input', 'bot.db'),
  backupDir: path.join(__dirname, 'backups'),
  logsDir: path.join(__dirname, 'logs'),
};

// ============================================================================
//  КАРТА МИГРАЦИИ ПОЛЕЙ
//  users (web) → employees (bot)
//
//  Особенности:
//   • tg_user_id — NOT NULL в bot. Если у web-пользователя он пуст,
//     запись уходит в skippedUsers (создание employee невозможно).
//   • tg_username — специфичен для Telegram, в web его нет — не переносим.
//   • name — приоритет: name → display_name → username.
// ============================================================================
const USER_FIELD_MAP = {
  tg_user_id: { from: 'tg_user_id', transform: normalizeTgId },
  email: { from: 'email', transform: normalizeEmail },
  name: {
    from: 'name',
    transform: (v, src) => v || src.display_name || src.username || `user_${src.id}`,
  },
  phone: 'phone',
  capacity: { from: 'capacity', default: 1 },
  earnings_factor: { from: 'earnings_factor', default: 1.0 },
  is_fired: { from: 'is_fired', default: 0 },
  taking_orders: { from: 'taking_orders', default: 1 },
};

// ============================================================================
//  КЛИ
// ============================================================================
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dryRun: false,
    createMissing: false,
    updateExisting: false,
    verbose: false,
    only: ['users', 'earnings', 'assignments', 'stats', 'product_stats', 'issued_models'],
  };
  for (const a of args) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--create-missing') opts.createMissing = true;
    else if (a === '--update-existing') opts.updateExisting = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a.startsWith('--only=')) {
      opts.only = a.slice(7).split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return opts;
}

// ============================================================================
//  MAIN
// ============================================================================
async function main() {
  const opts = parseArgs();
  const startedAt = Date.now();
  const ts = timestamp();
  const logPath = path.join(CONFIG.logsDir, `web-to-bot_${ts}.log`);
  const reportPath = path.join(CONFIG.logsDir, `web-to-bot_${ts}.report.json`);
  const logger = new Logger(logPath);

  logger.info('=== Миграция web → bot ===');
  logger.info(`WEB_DB: ${CONFIG.webDbPath}`);
  logger.info(`BOT_DB: ${CONFIG.botDbPath}`);
  logger.info(`Опции: ${JSON.stringify(opts)}`);

  const report = {
    direction: 'web-to-bot',
    startedAt,
    finishedAt: null,
    durationMs: null,
    options: opts,
    paths: { webDb: CONFIG.webDbPath, botDb: CONFIG.botDbPath },
    counts: {
      users: { matched: 0, byTg: 0, byEmail: 0, created: 0, updated: 0, skipped: 0 },
      employee_earnings: { inserted: 0, skipped: 0 },
      employee_earnings_active: { inserted: 0, skipped: 0 },
      employee_earnings_adjustments: { inserted: 0, skipped: 0 },
      employee_earnings_adjustments_active: { inserted: 0, skipped: 0 },
      assignments: { inserted: 0, updated: 0, skipped: 0 },
      employee_stats: { inserted: 0, updated: 0, skipped: 0 },
      product_stats: { inserted: 0, updated: 0, skipped: 0, orphanEmployeeId: 0 },
      issued_models: { inserted: 0, skipped: 0, orphanEmployeeId: 0 },
    },
    skippedUsers: [],
    orphanProductStats: [],
    orphanIssuedModels: [],
    errors: [],
  };

  let webDb, botDb;
  try {
    webDb = await openDb(CONFIG.webDbPath, { readonly: true });
    botDb = await openDb(CONFIG.botDbPath, { readonly: opts.dryRun });

    await assertTables(botDb, [
      'employees', 'assignments', 'employee_stats',
      'employee_earnings', 'employee_earnings_active',
      'employee_earnings_adjustments', 'employee_earnings_adjustments_active',
      'product_stats', 'issued_models',
    ], 'BOT_DB');
    await assertTables(webDb, [
      'users', 'assignments', 'user_stats',
      'earnings_history', 'earnings_active',
      'earnings_adjustments', 'earnings_adjustments_active',
      'product_stats', 'issued_models',
    ], 'WEB_DB');
    logger.info('✅ Схема обеих БД проверена');

    if (!opts.dryRun) {
      const backupPath = await backupDb(CONFIG.botDbPath, CONFIG.backupDir);
      logger.info(`📦 Бэкап output-БД: ${backupPath}`);
      report.backupPath = backupPath;
    } else {
      logger.info('🧪 DRY-RUN: запись в БД отключена');
    }

    const idMap = await migrateUsers(webDb, botDb, opts, logger, report);

    if (opts.only.includes('earnings')) {
      await migrateTable(webDb, botDb, 'earnings_history', 'employee_earnings',
        {
          fromField: 'user_id', toField: 'employee_id', idMap, logger, report,
          uniqueWhere: 'employee_id = ? AND order_id = ?',
          uniqueArgs: (row, eid) => [eid, row.order_id],
          columns: ['employee_id', 'order_id', 'amount', 'calculated_at'],
          values: (row, eid) => [eid, row.order_id, row.amount, row.calculated_at],
          counter: 'employee_earnings',
        });
      await migrateTable(webDb, botDb, 'earnings_active', 'employee_earnings_active',
        {
          fromField: 'user_id', toField: 'employee_id', idMap, logger, report,
          uniqueWhere: 'employee_id = ? AND order_id = ?',
          uniqueArgs: (row, eid) => [eid, row.order_id],
          columns: ['employee_id', 'order_id', 'amount', 'calculated_at'],
          values: (row, eid) => [eid, row.order_id, row.amount, row.calculated_at],
          counter: 'employee_earnings_active',
        });
      await migrateTable(webDb, botDb, 'earnings_adjustments', 'employee_earnings_adjustments',
        {
          fromField: 'user_id', toField: 'employee_id', idMap, logger, report,
          uniqueWhere: 'employee_id = ? AND amount = ? AND adjusted_at = ?',
          uniqueArgs: (row, eid) => [eid, row.amount, row.adjusted_at],
          columns: ['employee_id', 'amount', 'reason', 'adjusted_at'],
          values: (row, eid) => [eid, row.amount, row.reason || '', row.adjusted_at],
          counter: 'employee_earnings_adjustments',
        });
      await migrateTable(webDb, botDb, 'earnings_adjustments_active', 'employee_earnings_adjustments_active',
        {
          fromField: 'user_id', toField: 'employee_id', idMap, logger, report,
          uniqueWhere: 'employee_id = ? AND amount = ? AND adjusted_at = ?',
          uniqueArgs: (row, eid) => [eid, row.amount, row.adjusted_at],
          columns: ['employee_id', 'amount', 'reason', 'adjusted_at'],
          values: (row, eid) => [eid, row.amount, row.reason || '', row.adjusted_at],
          counter: 'employee_earnings_adjustments_active',
        });
    }

    if (opts.only.includes('assignments')) {
      await migrateAssignments(webDb, botDb, idMap, opts, logger, report);
    }
    if (opts.only.includes('stats')) {
      await migrateTable(webDb, botDb, 'user_stats', 'employee_stats',
        {
          fromField: 'user_id', toField: 'employee_id', idMap, logger, report,
          uniqueWhere: 'employee_id = ?',
          uniqueArgs: (_row, eid) => [eid],
          columns: ['employee_id', 'total_orders', 'total_amount', 'canceled_orders'],
          values: (row, eid) => [eid, row.total_orders, row.total_amount, row.canceled_orders || 0],
          counter: 'employee_stats',
          idColumn: 'employee_id',
          updateExisting: opts.updateExisting,
          updateColumns: ['total_orders', 'total_amount', 'canceled_orders'],
        });
    }

    // --- PRODUCT STATS ---
    if (opts.only.includes('product_stats')) {
      await migrateProductStatsWebToBot(webDb, botDb, idMap, opts, logger, report);
    }

    // --- ISSUED MODELS ---
    if (opts.only.includes('issued_models')) {
      await migrateIssuedModelsWebToBot(webDb, botDb, idMap, opts, logger, report);
    }

    report.finishedAt = Date.now();
    report.durationMs = report.finishedAt - startedAt;

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    printReport(report, logger);
    logger.info(`\n📄 Отчёт: ${reportPath}`);
    logger.info(`📄 Лог:   ${logPath}`);
  } catch (err) {
    logger.error(`Критическая ошибка: ${err.stack || err.message}`);
    report.errors.push({ message: err.message, stack: err.stack });
    report.finishedAt = Date.now();
    try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8'); } catch (_) { }
    process.exitCode = 1;
  } finally {
    if (webDb) await webDb.close();
    if (botDb) await botDb.close();
    await logger.close();
  }
}

// ============================================================================
//  USERS
// ============================================================================
async function migrateUsers(webDb, botDb, opts, logger, report) {
  logger.info('\n--- Миграция пользователей ---');
  const users = await webDb.all('SELECT * FROM users WHERE was_employee = 1');
  logger.info(`В web.users: ${users.length}`);

  const idMap = new Map(); // webUserId → botEmployeeId

  for (const user of users) {
    const resolved = await resolveWebToBot(user, botDb);
    if (resolved) {
      idMap.set(user.id, resolved.employeeId);
      report.counts.users.matched++;
      if (resolved.matchedBy === 'tg_user_id') report.counts.users.byTg++;
      else report.counts.users.byEmail++;

      if (opts.updateExisting && !opts.dryRun) {
        const updates = buildFromMap(USER_FIELD_MAP, user, { skipNull: false });
        await updateBotEmployee(botDb, resolved.employeeId, updates);
        report.counts.users.updated++;
      }
      continue;
    }

    // Пользователь не найден в bot.
    if (!user.tg_user_id) {
      report.counts.users.skipped++;
      report.skippedUsers.push({
        webId: user.id, username: user.username, email: user.email, name: user.name,
        reason: 'нет tg_user_id → нельзя создать employee (NOT NULL)',
      });
      continue;
    }

    if (!opts.createMissing) {
      report.counts.users.skipped++;
      report.skippedUsers.push({
        webId: user.id, username: user.username, email: user.email, name: user.name,
        reason: 'нет соответствующего employee (используйте --create-missing)',
      });
      continue;
    }

    try {
      const newId = await createBotEmployee(botDb, user, opts, logger);
      idMap.set(user.id, newId);
      report.counts.users.created++;
    } catch (err) {
      report.counts.users.skipped++;
      report.skippedUsers.push({
        webId: user.id, username: user.username, email: user.email, name: user.name,
        reason: `create failed: ${err.message}`,
      });
      logger.warn(`Не удалось создать employee для ${user.username}: ${err.message}`);
    }
  }

  logger.info(
    `Сопоставлено: ${report.counts.users.matched} ` +
    `(tg: ${report.counts.users.byTg}, email: ${report.counts.users.byEmail}); ` +
    `создано: ${report.counts.users.created}; ` +
    `пропущено: ${report.counts.users.skipped}`
  );
  return idMap;
}

function buildFromMap(map, source, { skipNull = true } = {}) {
  const out = {};
  for (const [target, spec] of Object.entries(map)) {
    const conf = typeof spec === 'string' ? { from: spec } : spec;
    let value = source[conf.from];
    if (conf.transform) value = conf.transform(value, source);
    if (value === undefined || value === null || value === '') {
      if (skipNull) continue;
      if (conf.default !== undefined) {
        value = typeof conf.default === 'function' ? conf.default(source) : conf.default;
      } else continue;
    }
    out[target] = value;
  }
  return out;
}

async function updateBotEmployee(botDb, employeeId, updates) {
  const fields = Object.keys(updates);
  if (!fields.length) return;
  const setSql = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => updates[f]);
  values.push(employeeId);
  await botDb.run(`UPDATE employees SET ${setSql} WHERE id = ?`, values);
}

async function createBotEmployee(botDb, webUser, opts, logger) {
  const fields = buildFromMap(USER_FIELD_MAP, webUser, { skipNull: false });
  if (!fields.tg_user_id) {
    throw new Error('tg_user_id отсутствует (web-пользователь не привязан к Telegram)');
  }
  if (!fields.name) fields.name = webUser.username || `user_${webUser.id}`;

  const cols = Object.keys(fields);
  const placeholders = cols.map(() => '?').join(', ');
  const values = cols.map(c => fields[c]);

  const result = await botDb.run(
    `INSERT INTO employees (${cols.join(', ')}) VALUES (${placeholders})`, values
  );
  logger.info(
    `Создан bot.employee #${result.lastID}: ${fields.name} ` +
    `<tg=${fields.tg_user_id}, email=${fields.email || '—'}>`
  );
  return result.lastID;
}

// ============================================================================
//  GENERIC TABLE MIGRATION
// ============================================================================
async function migrateTable(webDb, botDb, webTable, botTable, cfg) {
  const { idMap, logger, report, counter } = cfg;
  logger.info(`\n--- ${webTable} → ${botTable} ---`);
  const rows = await webDb.all(`SELECT * FROM ${webTable}`);
  logger.info(`Найдено записей: ${rows.length}`);

  const dryRun = report.options.dryRun;

  await transaction(botDb, async () => {
    for (const row of rows) {
      const targetId = idMap.get(row[cfg.fromField]);
      if (!targetId) { report.counts[counter].skipped++; continue; }

      const exists = await botDb.get(
        `SELECT ${cfg.idColumn || 'id'} FROM ${botTable} WHERE ${cfg.uniqueWhere}`,
        cfg.uniqueArgs(row, targetId)
      );
      if (exists) {
        if (cfg.updateExisting && cfg.updateColumns && !dryRun) {
          const setSql = cfg.updateColumns.map(c => `${c} = ?`).join(', ');
          const allValues = cfg.values(row, targetId);
          const idx = cfg.columns.findIndex(c => c === cfg.updateColumns[0]);
          const subset = allValues.slice(idx, idx + cfg.updateColumns.length);
          subset.push(targetId);
          await botDb.run(
            `UPDATE ${botTable} SET ${setSql} WHERE employee_id = ?`, subset
          );
          report.counts[counter].updated = (report.counts[counter].updated || 0) + 1;
        } else {
          report.counts[counter].skipped++;
        }
        continue;
      }
      if (dryRun) { report.counts[counter].inserted++; continue; }

      const placeholders = cfg.columns.map(() => '?').join(', ');
      await botDb.run(
        `INSERT INTO ${botTable} (${cfg.columns.join(', ')}) VALUES (${placeholders})`,
        cfg.values(row, targetId)
      );
      report.counts[counter].inserted++;
    }
  });

  const c = report.counts[counter];
  logger.info(
    `Вставлено: ${c.inserted}, ` +
    (c.updated !== undefined ? `обновлено: ${c.updated}, ` : '') +
    `пропущено: ${c.skipped}`
  );
}

// ============================================================================
//  ASSIGNMENTS
// ============================================================================
async function migrateAssignments(webDb, botDb, idMap, opts, logger, report) {
  logger.info('\n--- assignments (web) → assignments (bot) ---');
  const rows = await webDb.all('SELECT * FROM assignments');
  logger.info(`Найдено записей: ${rows.length}`);

  await transaction(botDb, async () => {
    for (const row of rows) {
      const eid = idMap.get(row.user_id);
      if (!eid) { report.counts.assignments.skipped++; continue; }

      const exists = await botDb.get(
        'SELECT employee_id FROM assignments WHERE order_id = ?', row.order_id
      );

      if (exists) {
        if (opts.updateExisting && exists.employee_id !== eid && !opts.dryRun) {
          await botDb.run(
            'UPDATE assignments SET employee_id = ? WHERE order_id = ?',
            eid, row.order_id
          );
          report.counts.assignments.updated++;
        } else {
          report.counts.assignments.skipped++;
        }
        continue;
      }
      if (opts.dryRun) { report.counts.assignments.inserted++; continue; }

      await botDb.run(
        `INSERT INTO assignments
           (order_id, employee_id, assigned_at, completed_at, status,
            deliver_reminder_sent_at, deliver_reminder_count,
            order_amount, offer_ids, products_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.order_id,
        eid,
        row.assigned_at,
        row.completed_at || null,
        row.status || 'assigned',
        row.deliver_reminder_sent_at || null,
        row.deliver_reminder_count || 0,
        row.order_amount || null,
        row.offer_ids || null,
        row.products_json || null
      );
      report.counts.assignments.inserted++;
    }
  });

  const c = report.counts.assignments;
  logger.info(`Вставлено: ${c.inserted}, обновлено: ${c.updated}, пропущено: ${c.skipped}`);
}

// ============================================================================
//  PRODUCT STATS
// ============================================================================
async function migrateProductStatsWebToBot(webDb, botDb, idMap, opts, logger, report) {
  logger.info('\n--- product_stats (web) → product_stats (bot) ---');
  const rows = await webDb.all('SELECT * FROM product_stats');
  logger.info(`Найдено записей: ${rows.length}`);

  const dryRun = opts.dryRun;

  await transaction(botDb, async () => {
    for (const row of rows) {
      const targetEmployeeId = row.user_id
        ? (idMap.get(row.user_id) ?? null)
        : null;
      const orphan = row.user_id && !targetEmployeeId;
      if (orphan) {
        report.counts.product_stats.orphanEmployeeId++;
        report.orphanProductStats.push({
          offer_id: row.offer_id,
          web_user_id: row.user_id,
          reason: 'user_id не сматчился с bot-employee; employee_id будет NULL',
        });
      }

      const exists = await botDb.get(
        'SELECT offer_id FROM product_stats WHERE offer_id = ?', row.offer_id
      );

      if (exists) {
        if (opts.updateExisting && !dryRun) {
          await botDb.run(
            `UPDATE product_stats
               SET material = ?, color = ?, weight_grams = ?, employee_id = ?, updated_at = ?
             WHERE offer_id = ?`,
            row.material, row.color, row.weight_grams,
            targetEmployeeId, row.updated_at || Date.now(),
            row.offer_id
          );
          report.counts.product_stats.updated++;
        } else {
          report.counts.product_stats.skipped++;
        }
        continue;
      }

      if (dryRun) { report.counts.product_stats.inserted++; continue; }

      await botDb.run(
        `INSERT INTO product_stats
           (offer_id, material, color, weight_grams, employee_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        row.offer_id, row.material, row.color, row.weight_grams,
        targetEmployeeId, row.updated_at || Date.now()
      );
      report.counts.product_stats.inserted++;
    }
  });

  const c = report.counts.product_stats;
  logger.info(`Вставлено: ${c.inserted}, обновлено: ${c.updated}, пропущено: ${c.skipped}, orphan(employee_id=NULL): ${c.orphanEmployeeId}`);
}

// ============================================================================
//  ISSUED MODELS
// ============================================================================
async function migrateIssuedModelsWebToBot(webDb, botDb, idMap, opts, logger, report) {
  logger.info('\n--- issued_models (web) → issued_models (bot) ---');
  const rows = await webDb.all('SELECT * FROM issued_models');
  logger.info(`Найдено записей: ${rows.length}`);

  const dryRun = opts.dryRun;

  await transaction(botDb, async () => {
    for (const row of rows) {
      const targetEmployeeId = idMap.get(row.user_id);
      if (!targetEmployeeId) {
        report.counts.issued_models.skipped++;
        report.counts.issued_models.orphanEmployeeId++;
        report.orphanIssuedModels.push({
          web_user_id: row.user_id,
          offer_id: row.offer_id,
          reason: 'user_id не сматчился с bot-employee',
        });
        continue;
      }

      const exists = await botDb.get(
        'SELECT id FROM issued_models WHERE employee_id = ? AND offer_id = ?',
        targetEmployeeId, row.offer_id
      );
      if (exists) { report.counts.issued_models.skipped++; continue; }
      if (dryRun) { report.counts.issued_models.inserted++; continue; }

      await botDb.run(
        'INSERT INTO issued_models (employee_id, offer_id, issued_at) VALUES (?, ?, ?)',
        targetEmployeeId, row.offer_id, row.issued_at || Date.now()
      );
      report.counts.issued_models.inserted++;
    }
  });

  const c = report.counts.issued_models;
  logger.info(`Вставлено: ${c.inserted}, пропущено: ${c.skipped} (orphan: ${c.orphanEmployeeId})`);
}

// ============================================================================
//  PRINT REPORT
// ============================================================================
function printReport(report, logger) {
  logger.info('\n============ ИТОГОВЫЙ ОТЧЁТ ============');
  logger.info(`Направление: ${report.direction}`);
  logger.info(`Длительность: ${(report.durationMs / 1000).toFixed(2)} с`);
  logger.info(`BACKUP: ${report.backupPath || '(dry-run — не создавался)'}`);
  const u = report.counts.users;
  logger.info(`Пользователи: matched=${u.matched} (tg=${u.byTg}, email=${u.byEmail}), created=${u.created}, updated=${u.updated}, skipped=${u.skipped}`);
  for (const key of [
    'employee_earnings', 'employee_earnings_active',
    'employee_earnings_adjustments', 'employee_earnings_adjustments_active',
  ]) {
    const c = report.counts[key];
    logger.info(`${key}: inserted=${c.inserted}, skipped=${c.skipped}`);
  }

  const a = report.counts.assignments;
  logger.info(`assignments: inserted=${a.inserted}, updated=${a.updated}, skipped=${a.skipped}`);

  const s = report.counts.employee_stats;
  logger.info(`employee_stats: inserted=${s.inserted}, updated=${s.updated || 0}, skipped=${s.skipped}`);

  const ps = report.counts.product_stats;
  logger.info(`product_stats: inserted=${ps.inserted}, updated=${ps.updated}, skipped=${ps.skipped}, orphanEmployeeId=${ps.orphanEmployeeId}`);

  const im = report.counts.issued_models;
  logger.info(`issued_models: inserted=${im.inserted}, skipped=${im.skipped}, orphanEmployeeId=${im.orphanEmployeeId}`);

  if (report.skippedUsers.length) {
    logger.info(`\n⚠️ Пропущено пользователей: ${report.skippedUsers.length} (см. отчёт JSON)`);
  }
  if (report.errors.length) logger.info(`\n❌ Ошибок: ${report.errors.length}`);
  logger.info('=========================================');
}

main();