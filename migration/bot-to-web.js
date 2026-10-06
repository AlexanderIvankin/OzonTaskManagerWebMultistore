#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { openDb, backupDb, transaction, assertTables } = require('./lib/db');
const Logger = require('./lib/logger');
const { resolveBotToWeb } = require('./lib/identity');
const { normalizeEmail, normalizeTgId, timestamp } = require('./lib/helpers');

// ============================================================================
//  КОНФИГУРАЦИЯ
// ============================================================================
const CONFIG = {
  botDbPath: process.env.BOT_DB || path.join(__dirname, 'input', 'bot-1.db'),
  webDbPath: process.env.WEB_DB || path.join(__dirname, 'output', 'bot_web-1.db'),
  backupDir: path.join(__dirname, 'backups'),
  logsDir: path.join(__dirname, 'logs'),
};

// ============================================================================
//  КАРТА МИГРАЦИИ ПОЛЕЙ
//  employees (bot) → users (web)
//
//  Формат:
//     'target_field': 'source_field'                               // shorthand
//     'target_field': { from, transform?, default? }               // полная форма
//
//  Спецполя web, генерируемые при создании нового пользователя:
//     username      — из email/tg_user_id (уникальный)
//     display_name  — по ТЗ = username (пользователь может сменить позже)
//     password_hash — placeholder, требует сброса пароля
//     role          — 'employee'
//     email_verified — 1
//     created_at / updated_at — now
//
//  Не мигрируем: tg_username (специфичен для Telegram, в web не используется)
// ============================================================================
const USER_FIELD_MAP = {
  tg_user_id: { from: 'tg_user_id', transform: normalizeTgId },
  email: { from: 'email', transform: normalizeEmail },
  name: 'name',
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
  const logPath = path.join(CONFIG.logsDir, `bot-to-web_${ts}.log`);
  const reportPath = path.join(CONFIG.logsDir, `bot-to-web_${ts}.report.json`);
  const logger = new Logger(logPath);

  logger.info('=== Миграция bot → web ===');
  logger.info(`BOT_DB: ${CONFIG.botDbPath}`);
  logger.info(`WEB_DB: ${CONFIG.webDbPath}`);
  logger.info(`Опции: ${JSON.stringify(opts)}`);

  const report = {
    direction: 'bot-to-web',
    startedAt,
    finishedAt: null,
    durationMs: null,
    options: opts,
    paths: { botDb: CONFIG.botDbPath, webDb: CONFIG.webDbPath },
    counts: {
      users: { matched: 0, byTg: 0, byEmail: 0, created: 0, updated: 0, skipped: 0 },
      earnings_history: { inserted: 0, skipped: 0 },
      earnings_active: { inserted: 0, skipped: 0 },
      earnings_adjustments: { inserted: 0, skipped: 0 },
      earnings_adjustments_active: { inserted: 0, skipped: 0 },
      assignments: { inserted: 0, updated: 0, skipped: 0 },
      user_stats: { inserted: 0, updated: 0, skipped: 0 },
      product_stats: { inserted: 0, updated: 0, skipped: 0, orphanUserId: 0 },
      issued_models: { inserted: 0, skipped: 0, orphanUserId: 0 },
    },
    skippedUsers: [],
    orphanProductStats: [],
    orphanIssuedModels: [],
    errors: [],
  };

  let botDb, webDb;
  try {
    botDb = await openDb(CONFIG.botDbPath, { readonly: true });
    webDb = await openDb(CONFIG.webDbPath, { readonly: opts.dryRun });

    // Проверка схемы
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
      const backupPath = await backupDb(CONFIG.webDbPath, CONFIG.backupDir);
      logger.info(`📦 Бэкап output-БД: ${backupPath}`);
      report.backupPath = backupPath;
    } else {
      logger.info('🧪 DRY-RUN: запись в БД отключена');
    }

    // --- USERS ---
    const idMap = await migrateUsers(botDb, webDb, opts, logger, report);

    // --- EARNINGS ---
    if (opts.only.includes('earnings')) {
      await migrateTable(botDb, webDb, 'employee_earnings', 'earnings_history',
        {
          fromField: 'employee_id', toField: 'user_id', idMap, logger, report,
          uniqueWhere: 'user_id = ? AND order_id = ?',
          uniqueArgs: (row, uid) => [uid, row.order_id],
          columns: ['user_id', 'order_id', 'amount', 'calculated_at'],
          values: (row, uid) => [uid, row.order_id, row.amount, row.calculated_at],
          counter: 'earnings_history',
        });

      await migrateTable(botDb, webDb, 'employee_earnings_active', 'earnings_active',
        {
          fromField: 'employee_id', toField: 'user_id', idMap, logger, report,
          uniqueWhere: 'user_id = ? AND order_id = ?',
          uniqueArgs: (row, uid) => [uid, row.order_id],
          columns: ['user_id', 'order_id', 'amount', 'calculated_at'],
          values: (row, uid) => [uid, row.order_id, row.amount, row.calculated_at],
          counter: 'earnings_active',
        });

      await migrateTable(botDb, webDb, 'employee_earnings_adjustments', 'earnings_adjustments',
        {
          fromField: 'employee_id', toField: 'user_id', idMap, logger, report,
          uniqueWhere: 'user_id = ? AND amount = ? AND adjusted_at = ?',
          uniqueArgs: (row, uid) => [uid, row.amount, row.adjusted_at],
          columns: ['user_id', 'amount', 'reason', 'adjusted_at'],
          values: (row, uid) => [uid, row.amount, row.reason || '', row.adjusted_at],
          counter: 'earnings_adjustments',
        });

      await migrateTable(botDb, webDb, 'employee_earnings_adjustments_active', 'earnings_adjustments_active',
        {
          fromField: 'employee_id', toField: 'user_id', idMap, logger, report,
          uniqueWhere: 'user_id = ? AND amount = ? AND adjusted_at = ?',
          uniqueArgs: (row, uid) => [uid, row.amount, row.adjusted_at],
          columns: ['user_id', 'amount', 'reason', 'adjusted_at'],
          values: (row, uid) => [uid, row.amount, row.reason || '', row.adjusted_at],
          counter: 'earnings_adjustments_active',
        });
    }

    // --- ASSIGNMENTS ---
    if (opts.only.includes('assignments')) {
      await migrateAssignments(botDb, webDb, idMap, opts, logger, report);
    }

    // --- USER STATS ---
    if (opts.only.includes('stats')) {
      await migrateTable(botDb, webDb, 'employee_stats', 'user_stats',
        {
          fromField: 'employee_id', toField: 'user_id', idMap, logger, report,
          uniqueWhere: 'user_id = ?',
          uniqueArgs: (_row, uid) => [uid],
          columns: ['user_id', 'total_orders', 'total_amount', 'canceled_orders'],
          values: (row, uid) => [uid, row.total_orders, row.total_amount, row.canceled_orders || 0],
          counter: 'user_stats',
          idColumn: 'user_id',
          updateExisting: opts.updateExisting,
          updateColumns: ['total_orders', 'total_amount', 'canceled_orders'],
        });
    }

    // --- PRODUCT STATS ---
    if (opts.only.includes('product_stats')) {
      await migrateProductStatsBotToWeb(botDb, webDb, idMap, opts, logger, report);
    }

    // --- ISSUED MODELS ---
    if (opts.only.includes('issued_models')) {
      await migrateIssuedModelsBotToWeb(botDb, webDb, idMap, opts, logger, report);
    }

    report.finishedAt = Date.now();
    report.durationMs = report.finishedAt - startedAt;

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    printReport(report, logger);
    logger.info(`\n📄 Полный отчёт: ${reportPath}`);
    logger.info(`📄 Лог: ${logPath}`);
  } catch (err) {
    logger.error(`Критическая ошибка: ${err.stack || err.message}`);
    report.errors.push({ message: err.message, stack: err.stack });
    report.finishedAt = Date.now();
    try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8'); } catch (_) { }
    process.exitCode = 1;
  } finally {
    if (botDb) await botDb.close();
    if (webDb) await webDb.close();
    await logger.close();
  }
}

// ============================================================================
//  USERS
// ============================================================================
async function migrateUsers(botDb, webDb, opts, logger, report) {
  logger.info('\n--- Миграция пользователей ---');
  const employees = await botDb.all('SELECT * FROM employees');
  logger.info(`В bot.employees: ${employees.length}`);

  const idMap = new Map(); // botEmployee.id → webUserId

  for (const emp of employees) {
    const resolved = await resolveBotToWeb(emp, webDb);

    if (resolved) {
      idMap.set(emp.id, resolved.userId);
      report.counts.users.matched++;
      if (resolved.matchedBy === 'tg_user_id') report.counts.users.byTg++;
      else report.counts.users.byEmail++;

      if (!opts.dryRun) {
        const updates = { was_employee: 1 };
        if (opts.updateExisting) {
          Object.assign(updates, buildFromMap(USER_FIELD_MAP, emp, { skipNull: false }));
          report.counts.users.updated++;
        }
        await updateWebUser(webDb, resolved.userId, updates);
      }
      continue;
    }

    if (opts.createMissing) {
      try {
        const newUserId = await createWebUser(webDb, emp, opts, logger);
        idMap.set(emp.id, newUserId);
        report.counts.users.created++;
      } catch (err) {
        report.counts.users.skipped++;
        report.skippedUsers.push({
          botId: emp.id, tg: emp.tg_user_id, email: emp.email, name: emp.name,
          reason: `create failed: ${err.message}`,
        });
        logger.warn(`Не удалось создать пользователя для ${emp.name}: ${err.message}`);
      }
    } else {
      report.counts.users.skipped++;
      report.skippedUsers.push({
        botId: emp.id, tg: emp.tg_user_id, email: emp.email, name: emp.name,
        reason: 'нет соответствующего web-пользователя (используйте --create-missing)',
      });
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

async function updateWebUser(webDb, userId, updates) {
  const fields = Object.keys(updates);
  if (!fields.length) return;
  const setSql = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => updates[f]);
  values.push(userId);
  await webDb.run(`UPDATE users SET ${setSql}, updated_at = ? WHERE id = ?`,
    [...values.slice(0, -1), Date.now(), userId]);
}

function generateUsername(botEmp) {
  const email = normalizeEmail(botEmp.email);
  if (email) {
    const local = email.split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '');
    if (local) return local;
  }
  const tg = normalizeTgId(botEmp.tg_user_id);
  if (tg) return `bot_${tg}`;
  return `user_${botEmp.id}_${Date.now()}`;
}

async function generateUniqueUsername(webDb, base) {
  let candidate = base;
  let i = 0;
  while (await webDb.get('SELECT id FROM users WHERE username = ?', candidate)) {
    i++;
    candidate = `${base}_${i}`;
    if (i > 200) throw new Error('Не удалось сгенерировать уникальный username');
  }
  return candidate;
}

async function createWebUser(webDb, botEmp, opts, logger) {
  const baseUsername = generateUsername(botEmp);
  const username = await generateUniqueUsername(webDb, baseUsername);
  const displayName = username; // по ТЗ: display_name = username

  const fields = buildFromMap(USER_FIELD_MAP, botEmp, { skipNull: false });
  if (!fields.email) fields.email = `${username}@migrated.local`;

  const passwordHash = bcrypt.hashSync(`migrated_${Date.now()}_${Math.random()}`, 10);
  const now = Date.now();

  const insert = {
    username,
    display_name: displayName,
    password_hash: passwordHash,
    role: 'employee',
    email_verified: 1,
    was_employee: 1,
    created_at: now,
    updated_at: now,
    ...fields,
  };

  const cols = Object.keys(insert);
  const placeholders = cols.map(() => '?').join(', ');
  const values = cols.map(c => insert[c]);

  const result = await webDb.run(
    `INSERT INTO users (${cols.join(', ')}) VALUES (${placeholders})`, values
  );
  logger.info(`Создан web-user #${result.lastID}: ${username} <${insert.email}>`);
  return result.lastID;
}

// ============================================================================
//  GENERIC TABLE MIGRATION
// ============================================================================
async function migrateTable(botDb, webDb, botTable, webTable, cfg) {
  const { idMap, logger, report, counter } = cfg;
  logger.info(`\n--- ${botTable} → ${webTable} ---`);
  const rows = await botDb.all(`SELECT * FROM ${botTable}`);
  logger.info(`Найдено записей: ${rows.length}`);

  const dryRun = report.options.dryRun;

  await transaction(webDb, async () => {
    for (const row of rows) {
      const targetId = idMap.get(row[cfg.fromField]);
      if (!targetId) { report.counts[counter].skipped++; continue; }

      const exists = await webDb.get(
        `SELECT ${cfg.idColumn || 'id'} FROM ${webTable} WHERE ${cfg.uniqueWhere}`,
        cfg.uniqueArgs(row, targetId)
      );

      if (exists) {
        if (cfg.updateExisting && cfg.updateColumns && !dryRun) {
          const setSql = cfg.updateColumns.map(c => `${c} = ?`).join(', ');
          const values = cfg.values(row, targetId).slice(
            cfg.columns.findIndex(c => c === cfg.updateColumns[0]),
            cfg.columns.findIndex(c => c === cfg.updateColumns[0]) + cfg.updateColumns.length
          );
          values.push(targetId);
          await webDb.run(
            `UPDATE ${webTable} SET ${setSql} WHERE user_id = ?`, values
          );
          report.counts[counter].updated = (report.counts[counter].updated || 0) + 1;
        } else {
          report.counts[counter].skipped++;
        }
        continue;
      }

      if (dryRun) { report.counts[counter].inserted++; continue; }

      const placeholders = cfg.columns.map(() => '?').join(', ');
      await webDb.run(
        `INSERT INTO ${webTable} (${cfg.columns.join(', ')}) VALUES (${placeholders})`,
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
//  ASSIGNMENTS (отдельно, т.к. порядок колонок отличается)
// ============================================================================
async function migrateAssignments(botDb, webDb, idMap, opts, logger, report) {
  logger.info('\n--- assignments → assignments ---');
  const rows = await botDb.all('SELECT * FROM assignments');
  logger.info(`Найдено записей: ${rows.length}`);

  await transaction(webDb, async () => {
    for (const row of rows) {
      const uid = idMap.get(row.employee_id);
      if (!uid) { report.counts.assignments.skipped++; continue; }

      const exists = await webDb.get(
        'SELECT user_id FROM assignments WHERE order_id = ?', row.order_id
      );

      if (exists) {
        if (opts.updateExisting && exists.user_id !== uid && !opts.dryRun) {
          await webDb.run(
            'UPDATE assignments SET user_id = ? WHERE order_id = ?',
            uid, row.order_id
          );
          report.counts.assignments.updated++;
        } else {
          report.counts.assignments.skipped++;
        }
        continue;
      }
      if (opts.dryRun) { report.counts.assignments.inserted++; continue; }

      await webDb.run(
        `INSERT INTO assignments
           (order_id, user_id, assigned_at, completed_at, status,
            deliver_reminder_sent_at, deliver_reminder_count,
            order_amount, offer_ids, products_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.order_id,
        uid,
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
async function migrateProductStatsBotToWeb(botDb, webDb, idMap, opts, logger, report) {
  logger.info('\n--- product_stats → product_stats ---');
  const rows = await botDb.all('SELECT * FROM product_stats');
  logger.info(`Найдено записей: ${rows.length}`);

  const dryRun = opts.dryRun;

  await transaction(webDb, async () => {
    for (const row of rows) {
      const targetUserId = row.employee_id
        ? (idMap.get(row.employee_id) ?? null)
        : null;
      const orphan = row.employee_id && !targetUserId;
      if (orphan) {
        report.counts.product_stats.orphanUserId++;
        report.orphanProductStats.push({
          offer_id: row.offer_id,
          bot_employee_id: row.employee_id,
          reason: 'employee_id не сматчился с web-user; user_id будет NULL',
        });
      }

      const exists = await webDb.get(
        'SELECT offer_id FROM product_stats WHERE offer_id = ?', row.offer_id
      );

      if (exists) {
        if (opts.updateExisting && !dryRun) {
          await webDb.run(
            `UPDATE product_stats
               SET material = ?, color = ?, weight_grams = ?, user_id = ?, updated_at = ?
             WHERE offer_id = ?`,
            row.material, row.color, row.weight_grams,
            targetUserId, row.updated_at || Date.now(),
            row.offer_id
          );
          report.counts.product_stats.updated++;
        } else {
          report.counts.product_stats.skipped++;
        }
        continue;
      }

      if (dryRun) { report.counts.product_stats.inserted++; continue; }

      await webDb.run(
        `INSERT INTO product_stats
           (offer_id, material, color, weight_grams, user_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        row.offer_id, row.material, row.color, row.weight_grams,
        targetUserId, row.updated_at || Date.now()
      );
      report.counts.product_stats.inserted++;
    }
  });

  const c = report.counts.product_stats;
  logger.info(`Вставлено: ${c.inserted}, обновлено: ${c.updated}, пропущено: ${c.skipped}, orphan(user_id=NULL): ${c.orphanUserId}`);
}

// ============================================================================
//  ISSUED MODELS
// ============================================================================
async function migrateIssuedModelsBotToWeb(botDb, webDb, idMap, opts, logger, report) {
  logger.info('\n--- issued_models → issued_models ---');
  const rows = await botDb.all('SELECT * FROM issued_models');
  logger.info(`Найдено записей: ${rows.length}`);

  const dryRun = opts.dryRun;

  await transaction(webDb, async () => {
    for (const row of rows) {
      const targetUserId = idMap.get(row.employee_id);
      if (!targetUserId) {
        report.counts.issued_models.skipped++;
        report.counts.issued_models.orphanUserId++;
        report.orphanIssuedModels.push({
          bot_employee_id: row.employee_id,
          offer_id: row.offer_id,
          reason: 'employee_id не сматчился с web-user',
        });
        continue;
      }

      const exists = await webDb.get(
        'SELECT id FROM issued_models WHERE user_id = ? AND offer_id = ?',
        targetUserId, row.offer_id
      );

      if (exists) { report.counts.issued_models.skipped++; continue; }
      if (dryRun) { report.counts.issued_models.inserted++; continue; }

      await webDb.run(
        'INSERT INTO issued_models (user_id, offer_id, issued_at) VALUES (?, ?, ?)',
        targetUserId, row.offer_id, row.issued_at || Date.now()
      );
      report.counts.issued_models.inserted++;
    }
  });

  const c = report.counts.issued_models;
  logger.info(`Вставлено: ${c.inserted}, пропущено: ${c.skipped} (orphan: ${c.orphanUserId})`);
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
    'earnings_history', 'earnings_active',
    'earnings_adjustments', 'earnings_adjustments_active',
  ]) {
    const c = report.counts[key];
    logger.info(`${key}: inserted=${c.inserted}, skipped=${c.skipped}`);
  }

  const a = report.counts.assignments;
  logger.info(`assignments: inserted=${a.inserted}, updated=${a.updated}, skipped=${a.skipped}`);

  const s = report.counts.user_stats;
  logger.info(`user_stats: inserted=${s.inserted}, updated=${s.updated || 0}, skipped=${s.skipped}`);

  const ps = report.counts.product_stats;
  logger.info(`product_stats: inserted=${ps.inserted}, updated=${ps.updated}, skipped=${ps.skipped}, orphanUserId=${ps.orphanUserId}`);

  const im = report.counts.issued_models;
  logger.info(`issued_models: inserted=${im.inserted}, skipped=${im.skipped}, orphanUserId=${im.orphanUserId}`);

  if (report.skippedUsers.length) {
    logger.info(`\n⚠️ Пропущено пользователей: ${report.skippedUsers.length} (см. отчёт JSON)`);
  }
  if (report.errors.length) {
    logger.info(`\n❌ Ошибок: ${report.errors.length}`);
  }
  logger.info('=========================================');
}

main();