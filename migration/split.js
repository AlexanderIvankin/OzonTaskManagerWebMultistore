#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { openDb, transaction } = require('./lib/db');
const Logger = require('./lib/logger');
const { normalizeEmail, timestamp } = require('./lib/helpers');
const {
  createUsersSchema,
  createModelsSchema,
  createStoreSchema,
} = require('./lib/schema');

// ============================================================================
//  КОНФИГУРАЦИЯ
// ============================================================================
const CONFIG = {
  inputDir: process.env.SPLIT_INPUT_DIR || path.join(__dirname, 'input'),
  outputDir: process.env.SPLIT_OUTPUT_DIR || path.join(__dirname, 'output'),
  backupDir: path.join(__dirname, 'backups'),
  logsDir: path.join(__dirname, 'logs'),
};

// ============================================================================
//  ПРИОРИТЕТ РОЛЕЙ ДЛЯ КАНОНИЧЕСКОГО ПОРЯДКА ID В users.db
//
//  Меньше число = выше в списке = меньший id.
//  Роли вне списка попадают в конец (приоритет 99).
// ============================================================================
const ROLE_PRIORITY = {
  'god': 0,
  'admin': 1,
  'moderator': 2,
  'employee': 3,
  'user': 4,
  'guest': 5,        // зарегистрировался, но не подтвердил email
};

function getRolePriority(role) {
  return ROLE_PRIORITY[role] !== undefined ? ROLE_PRIORITY[role] : 99;
}

// ============================================================================
//  КЛИ
// ============================================================================
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dryRun: false,
    verbose: false,
    files: null,
  };
  for (const a of args) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a.startsWith('--files=')) {
      opts.files = a.slice(8).split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return opts;
}

function findInputDbs(inputDir) {
  if (!fs.existsSync(inputDir)) {
    throw new Error(`Папка input не найдена: ${inputDir}`);
  }
  return fs.readdirSync(inputDir)
    .filter(f => /^(bot_web|bot)-\d+\.db$/i.test(f))
    .map(f => ({
      name: f,
      path: path.join(inputDir, f),
      version: parseInt((f.match(/-(\d+)\.db$/i) || [])[1] || '0', 10),
    }))
    .sort((a, b) => a.version - b.version);
}

// ============================================================================
//  DRY-RUN: виртуальная БД, которая принимает run(), но не пишет
//  Возвращает инкрементный lastID, чтобы emailToNewId работал корректно.
// ============================================================================
function makeMockWriteDb() {
  let lastId = 0;
  return {
    run: async (sql) => {
      if (/^\s*INSERT/i.test(sql)) {
        lastId++;
        return { lastID: lastId, changes: 1 };
      }
      return { lastID: 0, changes: 0 };
    },
    get: async () => null,
    all: async () => [],
    exec: async () => { },
    close: async () => { },
  };
}

async function createDbWithSchema(dbPath, schemaFn, dryRun) {
  if (dryRun) return makeMockWriteDb();

  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  for (const sidecar of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + sidecar)) fs.unlinkSync(dbPath + sidecar);
  }

  const db = await openDb(dbPath, { readonly: false, create: true });
  await db.exec('PRAGMA foreign_keys = ON');
  await db.exec('PRAGMA journal_mode = WAL');
  await schemaFn(db);
  return db;
}

/**
 * Транзакция с поддержкой dry-run: в dry-run просто вызывает fn().
 */
async function withTransaction(db, dryRun, fn) {
  if (dryRun) return fn();
  return transaction(db, fn);
}

// ============================================================================
//  MAIN
// ============================================================================
async function main() {
  const opts = parseArgs();
  const startedAt = Date.now();
  const ts = timestamp();

  const logPath = path.join(CONFIG.logsDir, `split_${ts}.log`);
  const reportPath = path.join(CONFIG.logsDir, `split_${ts}.report.json`);
  const logger = new Logger(logPath);

  logger.info('=== Split bot_web-N → users.db + models.db + store-N.db ===');
  logger.info(`input:  ${CONFIG.inputDir}`);
  logger.info(`output: ${CONFIG.outputDir}`);
  logger.info(`опции:  ${JSON.stringify(opts)}`);

  const report = {
    direction: 'split',
    startedAt,
    finishedAt: null,
    durationMs: null,
    options: opts,
    inputFiles: [],
    outputFiles: {},
    counts: {
      users: { fromAllDbs: 0, unique: 0, duplicates: 0, byRole: {} },
      auth: { refreshTokens: 0, emailVerifications: 0, passwordResets: 0, pushSubscriptions: 0 },
      models: { offerModels: 0, issuedModels: 0, issuedDuplicates: 0 },
      store: {},
    },
    warnings: [],
    errors: [],
  };

  const openedDbs = {};
  try {
    // 1. Находим входные файлы
    const inputFiles = opts.files
      ? opts.files.map(f => ({
        name: path.basename(f),
        path: path.join(CONFIG.inputDir, path.basename(f)),
        version: parseInt((path.basename(f).match(/-(\d+)\.db$/i) || [])[1] || '0', 10),
      }))
      : findInputDbs(CONFIG.inputDir);

    if (!inputFiles.length) {
      throw new Error(`В ${CONFIG.inputDir} не найдено ни одного bot_web-*.db`);
    }
    logger.info(`Найдено входных БД: ${inputFiles.length}`);
    for (const f of inputFiles) logger.info(`  → ${f.name} (version=${f.version})`);
    report.inputFiles = inputFiles.map(f => f.name);

    // 2. Открываем входные БД (readonly)
    for (const f of inputFiles) {
      openedDbs[f.name] = await openDb(f.path, { readonly: true });
      logger.info(`Открыта: ${f.name}`);
    }

    // 3. Проверка схемы
    for (const f of inputFiles) {
      await assertSourceSchema(openedDbs[f.name], f.name);
    }
    logger.info('✅ Схема всех входных БД проверена');

    // 4. Подготавливаем output
    if (!opts.dryRun) {
      if (!fs.existsSync(CONFIG.outputDir)) {
        fs.mkdirSync(CONFIG.outputDir, { recursive: true });
      }
      for (const f of fs.readdirSync(CONFIG.outputDir)) {
        if (/^(users|models|store-\d+)\.db(-wal|-shm)?$/i.test(f)) {
          fs.unlinkSync(path.join(CONFIG.outputDir, f));
        }
      }
    } else {
      logger.info('🧪 DRY-RUN: запись в БД отключена (счётчики работают)');
    }

    // ========================================================================
    //  ФАЗА 1: users.db + user_stores
    // ========================================================================
    const usersDbPath = path.join(CONFIG.outputDir, 'users.db');
    const usersDb = await createDbWithSchema(usersDbPath, createUsersSchema, opts.dryRun);

    // 1.1. Собираем ВСЕ строки users из всех БД
    const oldIdToEmail = new Map();
    const allUsers = [];

    let totalUserRows = 0;
    for (const f of inputFiles) {
      const db = openedDbs[f.name];
      const rows = await db.all('SELECT * FROM users ORDER BY id ASC');
      logger.info(`  [${f.name}] users: ${rows.length}`);
      totalUserRows += rows.length;

      for (const row of rows) {
        const email = normalizeEmail(row.email);
        if (!email) {
          report.warnings.push({
            stage: 'users', file: f.name, userId: row.id,
            reason: 'нет email — пропущен',
          });
          continue;
        }
        oldIdToEmail.set(`${f.name}::${row.id}`, email);
        allUsers.push({
          row, email,
          sourceVersion: f.version,
          sourceId: row.id,
          sourceDbName: f.name,
        });
      }
    }

    // 1.2. Дедупликация по email
    const seenEmails = new Set();
    const uniqueUsers = [];
    for (const u of allUsers) {
      if (seenEmails.has(u.email)) {
        report.counts.users.duplicates++;
        continue;
      }
      seenEmails.add(u.email);
      uniqueUsers.push(u);
    }

    // 1.3. Сортировка: god → admin → moderator → employee → user → guest
    uniqueUsers.sort((a, b) => {
      const pa = getRolePriority(a.row.role || 'user');
      const pb = getRolePriority(b.row.role || 'user');
      if (pa !== pb) return pa - pb;
      if (a.sourceVersion !== b.sourceVersion) return a.sourceVersion - b.sourceVersion;
      return a.sourceId - b.sourceId;
    });

    // 1.4. Подсчёт по ролям
    for (const u of uniqueUsers) {
      const role = u.row.role || 'user';
      report.counts.users.byRole[role] = (report.counts.users.byRole[role] || 0) + 1;
    }

    // 1.5. Вставка в users.db — role приводится к 'god'|'user'|'guest'
    const emailToNewId = new Map();

    for (const u of uniqueUsers) {
      const r = u.row;
      const globalRole =
        r.role === 'god' ? 'god' :
          r.role === 'guest' ? 'guest' :
            'user';

      const result = await usersDb.run(
        `INSERT INTO users
           (username, email, password_hash, name, phone, capacity, taking_orders,
            role, tg_user_id, email_verified, display_name,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.username, r.email, r.password_hash, r.name, r.phone,
        r.capacity ?? 1, r.taking_orders ?? 1,
        globalRole, r.tg_user_id ?? null,
        r.email_verified ?? 0, r.display_name ?? null,
        r.created_at ?? Date.now(), r.updated_at ?? Date.now()
      );
      emailToNewId.set(u.email, result.lastID);
    }

    report.counts.users.fromAllDbs = totalUserRows;
    report.counts.users.unique = uniqueUsers.length;
    logger.info(
      `USERS: собрано ${totalUserRows}, уникальных по email ${uniqueUsers.length}, ` +
      `дубликатов ${report.counts.users.duplicates}`
    );
    logger.info(`  порядок id: ${Object.entries(report.counts.users.byRole)
      .sort((a, b) => getRolePriority(a[0]) - getRolePriority(b[0]))
      .map(([role, n]) => `${role}=${n}`)
      .join(', ')}`);

    // 1.6. user_stores — по одной записи на (user_id, store_id)
    for (const f of inputFiles) {
      const db = openedDbs[f.name];
      const rows = await db.all('SELECT * FROM users ORDER BY id ASC');
      const storeIdStr = String(f.version);

      for (const row of rows) {
        const email = normalizeEmail(row.email);
        if (!email) continue;
        const newUserId = emailToNewId.get(email);
        if (!newUserId) continue;

        // Определяем, что писать в user_stores
        let usRole = null;
        let usIsFired = 0;
        let usWasEmployee = 0;
        let usEarningsFactor = row.earnings_factor ?? 1.0;

        if (row.role === 'god') {
          usRole = 'god';
          usIsFired = 0;
          usWasEmployee = 1;
          usEarningsFactor = row.earnings_factor ?? 999.99;
        } else if (['admin', 'moderator', 'employee'].includes(row.role)) {
          usRole = row.role;
          usIsFired = row.is_fired ? 1 : 0;
          usWasEmployee = 1;
        } else if (row.role === 'user' && row.is_fired === 1) {
          // Уволенный, но роль в bot_web уже понижена до 'user'.
          // Восстанавливаем роль сотрудника через 'employee' по умолчанию.
          usRole = 'employee';
          usIsFired = 1;
          usWasEmployee = 1;
        }

        if (!usRole) continue; // обычный user / guest — записи нет

        const now = Date.now();
        const existing = await usersDb.get(
          'SELECT 1 FROM user_stores WHERE user_id = ? AND store_id = ?',
          newUserId, storeIdStr
        );

        if (existing) {
          await usersDb.run(
            `UPDATE user_stores
               SET role = ?, is_fired = ?, earnings_factor = ?, was_employee = ?, updated_at = ?
             WHERE user_id = ? AND store_id = ?`,
            usRole, usIsFired, usEarningsFactor, usWasEmployee, now,
            newUserId, storeIdStr
          );
        } else {
          await usersDb.run(
            `INSERT INTO user_stores
               (user_id, store_id, role, is_fired, earnings_factor, was_employee, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            newUserId, storeIdStr, usRole, usIsFired, usEarningsFactor, usWasEmployee, now, now
          );
        }
      }
    }
    logger.info(`✅ user_stores: заполнен для ${inputFiles.length} магазинов`);

    // ========================================================================
    //  ФАЗА 2: auth-хвосты в users.db
    // ========================================================================
    await withTransaction(usersDb, opts.dryRun, async () => {
      // refresh_tokens
      for (const f of inputFiles) {
        const db = openedDbs[f.name];
        const rows = await db.all('SELECT * FROM refresh_tokens');
        for (const r of rows) {
          const email = oldIdToEmail.get(`${f.name}::${r.user_id}`);
          if (!email) continue;
          const newUserId = emailToNewId.get(email);
          if (!newUserId) continue;
          await usersDb.run(
            `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)`,
            newUserId, r.token, r.expires_at
          );
          report.counts.auth.refreshTokens++;
        }
      }

      // email_verifications (только не истёкшие)
      for (const f of inputFiles) {
        const db = openedDbs[f.name];
        const rows = await db.all(
          'SELECT * FROM email_verifications WHERE expires_at > ?', Date.now()
        );
        for (const r of rows) {
          const email = oldIdToEmail.get(`${f.name}::${r.user_id}`);
          if (!email) continue;
          const newUserId = emailToNewId.get(email);
          if (!newUserId) continue;
          await usersDb.run(
            `INSERT INTO email_verifications (user_id, code, expires_at, created_at)
             VALUES (?, ?, ?, ?)`,
            newUserId, r.code, r.expires_at, r.created_at ?? null
          );
          report.counts.auth.emailVerifications++;
        }
      }

      // password_resets (только не истёкшие)
      for (const f of inputFiles) {
        const db = openedDbs[f.name];
        const rows = await db.all(
          'SELECT * FROM password_resets WHERE expires_at > ?', Date.now()
        );
        for (const r of rows) {
          const email = oldIdToEmail.get(`${f.name}::${r.user_id}`);
          if (!email) continue;
          const newUserId = emailToNewId.get(email);
          if (!newUserId) continue;
          await usersDb.run(
            `INSERT INTO password_resets (user_id, code, expires_at, created_at)
             VALUES (?, ?, ?, ?)`,
            newUserId, r.code, r.expires_at, r.created_at ?? Date.now()
          );
          report.counts.auth.passwordResets++;
        }
      }

      // push_subscriptions (дедупликация по endpoint)
      const seenEndpoints = new Set();
      for (const f of inputFiles) {
        const db = openedDbs[f.name];
        const rows = await db.all('SELECT * FROM push_subscriptions');
        for (const r of rows) {
          if (seenEndpoints.has(r.endpoint)) continue;
          seenEndpoints.add(r.endpoint);
          const email = oldIdToEmail.get(`${f.name}::${r.user_id}`);
          if (!email) continue;
          const newUserId = emailToNewId.get(email);
          if (!newUserId) continue;
          await usersDb.run(
            `INSERT INTO push_subscriptions
               (user_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            newUserId, r.endpoint, r.p256dh, r.auth,
            r.user_agent ?? null, r.created_at ?? Date.now(), r.last_used_at ?? null
          );
          report.counts.auth.pushSubscriptions++;
        }
      }
    });
    logger.info(
      `✅ users.db: refresh=${report.counts.auth.refreshTokens}, ` +
      `verify=${report.counts.auth.emailVerifications}, ` +
      `reset=${report.counts.auth.passwordResets}, ` +
      `push=${report.counts.auth.pushSubscriptions}`
    );

    // ========================================================================
    //  ФАЗА 3: models.db
    // ========================================================================
    const modelsDbPath = path.join(CONFIG.outputDir, 'models.db');
    const modelsDb = await createDbWithSchema(modelsDbPath, createModelsSchema, opts.dryRun);

    await withTransaction(modelsDb, opts.dryRun, async () => {
      // offer_models (дедупликация по offer_id)
      const seenOfferIds = new Set();
      for (const f of inputFiles) {
        const db = openedDbs[f.name];
        const rows = await db.all('SELECT * FROM offer_models');
        for (const r of rows) {
          if (seenOfferIds.has(r.offer_id)) continue;
          seenOfferIds.add(r.offer_id);
          let newUploaderId = null;
          if (r.uploaded_by) {
            const email = oldIdToEmail.get(`${f.name}::${r.uploaded_by}`);
            if (email) newUploaderId = emailToNewId.get(email) ?? null;
          }
          await modelsDb.run(
            `INSERT INTO offer_models
               (offer_id, s3_key, file_name, s3_etag, file_size, uploaded_at, uploaded_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            r.offer_id, r.s3_key, r.file_name ?? null, r.s3_etag ?? null,
            r.file_size ?? null, r.uploaded_at ?? null, newUploaderId
          );
          report.counts.models.offerModels++;
        }
      }

      // issued_models (дедупликация по email + offer_id)
      const seenIssued = new Set();
      for (const f of inputFiles) {
        const db = openedDbs[f.name];
        const rows = await db.all('SELECT * FROM issued_models');
        for (const r of rows) {
          const email = oldIdToEmail.get(`${f.name}::${r.user_id}`);
          if (!email) {
            report.warnings.push({
              stage: 'issued_models',
              file: f.name,
              userId: r.user_id,
              offerId: r.offer_id,
              reason: 'user_id не сматчился по email',
            });
            continue;
          }
          const newUserId = emailToNewId.get(email);
          if (!newUserId) continue;
          const key = `${newUserId}::${r.offer_id}`;
          if (seenIssued.has(key)) {
            report.counts.models.issuedDuplicates++;
            continue;
          }
          seenIssued.add(key);
          await modelsDb.run(
            `INSERT INTO issued_models (user_id, offer_id, issued_at) VALUES (?, ?, ?)`,
            newUserId, r.offer_id, r.issued_at ?? Date.now()
          );
          report.counts.models.issuedModels++;
        }
      }
    });
    logger.info(
      `✅ models.db: offer=${report.counts.models.offerModels}, ` +
      `issued=${report.counts.models.issuedModels}, ` +
      `дубликатов issued=${report.counts.models.issuedDuplicates}`
    );

    // ========================================================================
    //  ФАЗА 4: store-N.db (по одной на каждый bot_web-N)
    // ========================================================================
    for (const f of inputFiles) {
      const storeDbPath = path.join(CONFIG.outputDir, `store-${f.version}.db`);
      logger.info(`\n--- store-${f.version}.db ← ${f.name} ---`);

      const storeCounts = {
        assignments: 0,
        warehouses: 0,
        user_warehouses: 0,
        product_stats: 0,
        user_stats: 0,
        earnings_history: 0,
        earnings_active: 0,
        earnings_adjustments: 0,
        earnings_adjustments_active: 0,
        skippedUserIds: [],
      };
      report.counts.store[f.name] = storeCounts;

      const storeDb = await createDbWithSchema(storeDbPath, createStoreSchema, opts.dryRun);
      const srcDb = openedDbs[f.name];

      const mapOldUser = (oldId) => {
        const email = oldIdToEmail.get(`${f.name}::${oldId}`);
        if (!email) return null;
        return emailToNewId.get(email) ?? null;
      };

      await withTransaction(storeDb, opts.dryRun, async () => {
        // warehouses
        const whs = await srcDb.all('SELECT * FROM warehouses');
        for (const w of whs) {
          await storeDb.run(
            `INSERT INTO warehouses (warehouse_id, name, address, is_rfbs, last_synced_at)
             VALUES (?, ?, ?, ?, ?)`,
            w.warehouse_id, w.name, w.address ?? null,
            w.is_rfbs ?? 0, w.last_synced_at ?? null
          );
          storeCounts.warehouses++;
        }

        // user_warehouses
        const uws = await srcDb.all('SELECT * FROM user_warehouses');
        for (const uw of uws) {
          const newUserId = mapOldUser(uw.user_id);
          if (!newUserId) {
            storeCounts.skippedUserIds.push({ table: 'user_warehouses', oldId: uw.user_id });
            continue;
          }
          await storeDb.run(
            `INSERT OR IGNORE INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)`,
            newUserId, uw.warehouse_id
          );
          storeCounts.user_warehouses++;
        }

        // assignments
        const assigns = await srcDb.all('SELECT * FROM assignments');
        for (const a of assigns) {
          const newUserId = mapOldUser(a.user_id);
          if (!newUserId) {
            storeCounts.skippedUserIds.push({ table: 'assignments', oldId: a.user_id, orderId: a.order_id });
            continue;
          }
          await storeDb.run(
            `INSERT INTO assignments
               (order_id, user_id, assigned_at, completed_at, status,
                deliver_reminder_sent_at, deliver_reminder_count,
                order_amount, offer_ids, products_json,
                earnings_revoked_at, earnings_revoked_amount, earnings_revoke_reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            a.order_id, newUserId, a.assigned_at, a.completed_at ?? null,
            a.status ?? 'assigned',
            a.deliver_reminder_sent_at ?? null, a.deliver_reminder_count ?? 0,
            a.order_amount ?? null, a.offer_ids ?? null, a.products_json ?? null,
            a.earnings_revoked_at ?? null, a.earnings_revoked_amount ?? null,
            a.earnings_revoke_reason ?? null
          );
          storeCounts.assignments++;
        }

        // product_stats
        const pstats = await srcDb.all('SELECT * FROM product_stats');
        for (const p of pstats) {
          const newUserId = p.user_id ? mapOldUser(p.user_id) : null;
          await storeDb.run(
            `INSERT INTO product_stats (offer_id, material, color, weight_grams, user_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            p.offer_id, p.material, p.color, p.weight_grams,
            newUserId, p.updated_at ?? null
          );
          storeCounts.product_stats++;
        }

        // user_stats
        const ustats = await srcDb.all('SELECT * FROM user_stats');
        for (const s of ustats) {
          const newUserId = mapOldUser(s.user_id);
          if (!newUserId) {
            storeCounts.skippedUserIds.push({ table: 'user_stats', oldId: s.user_id });
            continue;
          }
          await storeDb.run(
            `INSERT INTO user_stats (user_id, total_orders, total_amount, canceled_orders)
             VALUES (?, ?, ?, ?)`,
            newUserId, s.total_orders ?? 0, s.total_amount ?? 0, s.canceled_orders ?? 0
          );
          storeCounts.user_stats++;
        }

        // earnings_history
        const eh = await srcDb.all('SELECT * FROM earnings_history');
        for (const e of eh) {
          const newUserId = mapOldUser(e.user_id);
          if (!newUserId) {
            storeCounts.skippedUserIds.push({ table: 'earnings_history', oldId: e.user_id, orderId: e.order_id });
            continue;
          }
          await storeDb.run(
            `INSERT INTO earnings_history (user_id, order_id, amount, calculated_at)
             VALUES (?, ?, ?, ?)`,
            newUserId, e.order_id, e.amount, e.calculated_at
          );
          storeCounts.earnings_history++;
        }

        // earnings_active
        const ea = await srcDb.all('SELECT * FROM earnings_active');
        for (const e of ea) {
          const newUserId = mapOldUser(e.user_id);
          if (!newUserId) {
            storeCounts.skippedUserIds.push({ table: 'earnings_active', oldId: e.user_id, orderId: e.order_id });
            continue;
          }
          await storeDb.run(
            `INSERT INTO earnings_active (user_id, order_id, amount, calculated_at)
             VALUES (?, ?, ?, ?)`,
            newUserId, e.order_id, e.amount, e.calculated_at
          );
          storeCounts.earnings_active++;
        }

        // earnings_adjustments
        const eadj = await srcDb.all('SELECT * FROM earnings_adjustments');
        for (const e of eadj) {
          const newUserId = mapOldUser(e.user_id);
          if (!newUserId) {
            storeCounts.skippedUserIds.push({ table: 'earnings_adjustments', oldId: e.user_id });
            continue;
          }
          await storeDb.run(
            `INSERT INTO earnings_adjustments (user_id, amount, reason, adjusted_at)
             VALUES (?, ?, ?, ?)`,
            newUserId, e.amount, e.reason ?? '', e.adjusted_at
          );
          storeCounts.earnings_adjustments++;
        }

        // earnings_adjustments_active
        const eadja = await srcDb.all('SELECT * FROM earnings_adjustments_active');
        for (const e of eadja) {
          const newUserId = mapOldUser(e.user_id);
          if (!newUserId) {
            storeCounts.skippedUserIds.push({ table: 'earnings_adjustments_active', oldId: e.user_id });
            continue;
          }
          await storeDb.run(
            `INSERT INTO earnings_adjustments_active (user_id, amount, reason, adjusted_at)
             VALUES (?, ?, ?, ?)`,
            newUserId, e.amount, e.reason ?? '', e.adjusted_at
          );
          storeCounts.earnings_adjustments_active++;
        }
      });

      logger.info(
        `  assignments=${storeCounts.assignments}, ` +
        `earnings_history=${storeCounts.earnings_history}, ` +
        `earnings_active=${storeCounts.earnings_active}, ` +
        `skipped=${storeCounts.skippedUserIds.length}`
      );

      if (storeCounts.skippedUserIds.length) {
        logger.warn(`  ⚠️ ${f.name}: пропущено ${storeCounts.skippedUserIds.length} строк из-за отсутствия user_id в users.db`);
      }
    }

    // Закрытие БД
    if (usersDb && usersDb.close) await usersDb.close();
    if (modelsDb && modelsDb.close) await modelsDb.close();

    report.finishedAt = Date.now();
    report.durationMs = report.finishedAt - startedAt;

    if (!opts.dryRun) {
      report.outputFiles = fs.readdirSync(CONFIG.outputDir)
        .filter(f => /\.db$/i.test(f))
        .reduce((acc, f) => {
          acc[f] = fs.statSync(path.join(CONFIG.outputDir, f)).size;
          return acc;
        }, {});
    }

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
    for (const db of Object.values(openedDbs)) {
      try { await db.close(); } catch (_) { }
    }
    await logger.close();
  }
}

// ============================================================================
//  ХЕЛПЕРЫ
// ============================================================================
async function assertSourceSchema(db, label) {
  const required = [
    'users', 'refresh_tokens', 'email_verifications', 'password_resets',
    'push_subscriptions', 'assignments', 'warehouses', 'user_warehouses',
    'product_stats', 'user_stats',
    'earnings_history', 'earnings_active',
    'earnings_adjustments', 'earnings_adjustments_active',
    'offer_models', 'issued_models',
  ];
  const rows = await db.all(`SELECT name FROM sqlite_master WHERE type='table'`);
  const have = new Set(rows.map(r => r.name));
  const missing = required.filter(t => !have.has(t));
  if (missing.length) {
    throw new Error(
      `${label}: отсутствуют обязательные таблицы: ${missing.join(', ')}`
    );
  }
}

function printReport(report, logger) {
  logger.info('\n============ ИТОГОВЫЙ ОТЧЁТ ============');
  logger.info(`Направление: split${report.options.dryRun ? ' (dry-run)' : ''}`);
  logger.info(`Длительность: ${(report.durationMs / 1000).toFixed(2)} с`);
  logger.info(`\nВходных файлов: ${report.inputFiles.length}`);
  for (const f of report.inputFiles) logger.info(`  ← ${f}`);
  logger.info(`\nUSERS:`);
  logger.info(`  строк во всех БД:    ${report.counts.users.fromAllDbs}`);
  logger.info(`  уникальных по email: ${report.counts.users.unique}`);
  logger.info(`  дубликатов:          ${report.counts.users.duplicates}`);
  logger.info(`  по ролям:`);
  const sortedRoles = Object.entries(report.counts.users.byRole)
    .sort((a, b) => getRolePriority(a[0]) - getRolePriority(b[0]));
  for (const [role, n] of sortedRoles) {
    logger.info(`    ${role.padEnd(12)} ${n}`);
  }
  logger.info(`\nAUTH:`);
  logger.info(`  refresh_tokens:       ${report.counts.auth.refreshTokens}`);
  logger.info(`  email_verifications:  ${report.counts.auth.emailVerifications}`);
  logger.info(`  password_resets:      ${report.counts.auth.passwordResets}`);
  logger.info(`  push_subscriptions:   ${report.counts.auth.pushSubscriptions}`);
  logger.info(`\nMODELS:`);
  logger.info(`  offer_models:         ${report.counts.models.offerModels}`);
  logger.info(`  issued_models:        ${report.counts.models.issuedModels}`);
  logger.info(`  дубликатов issued:    ${report.counts.models.issuedDuplicates}`);
  logger.info(`\nSTORE-N:`);
  for (const [file, c] of Object.entries(report.counts.store)) {
    logger.info(`  [${file}]`);
    logger.info(`    assignments:              ${c.assignments}`);
    logger.info(`    warehouses:               ${c.warehouses}`);
    logger.info(`    user_warehouses:          ${c.user_warehouses}`);
    logger.info(`    product_stats:            ${c.product_stats}`);
    logger.info(`    user_stats:               ${c.user_stats}`);
    logger.info(`    earnings_history:         ${c.earnings_history}`);
    logger.info(`    earnings_active:          ${c.earnings_active}`);
    logger.info(`    earnings_adjustments:     ${c.earnings_adjustments}`);
    logger.info(`    earnings_adjustments_act: ${c.earnings_adjustments_active}`);
    logger.info(`    skipped:                  ${c.skippedUserIds.length}`);
  }
  if (report.warnings.length) {
    logger.info(`\n⚠️ Предупреждений: ${report.warnings.length} (см. отчёт JSON)`);
  }
  if (report.errors.length) {
    logger.info(`\n❌ Ошибок: ${report.errors.length}`);
  }
  logger.info('=========================================');
}

main();