#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { openDb, transaction } = require('./lib/db');
const Logger = require('./lib/logger');
const { timestamp } = require('./lib/helpers');
const { createFullBotWebSchema } = require('./lib/schema-merge');

// ============================================================================
//  КОНФИГУРАЦИЯ
// ============================================================================
const CONFIG = {
  inputDir: process.env.MERGE_INPUT_DIR || path.join(__dirname, 'output'),
  outputDir: process.env.MERGE_OUTPUT_DIR || path.join(__dirname, 'output-merged'),
  logsDir: path.join(__dirname, 'logs'),
};

// ============================================================================
//  КЛИ
// ============================================================================
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, verbose: false };
  for (const a of args) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--verbose') opts.verbose = true;
  }
  return opts;
}

/**
 * Находит все store-N.db в inputDir, сортирует по N.
 */
function findStoreDbs(inputDir) {
  if (!fs.existsSync(inputDir)) {
    throw new Error(`Папка input не найдена: ${inputDir}`);
  }
  return fs.readdirSync(inputDir)
    .filter(f => /^store-\d+\.db$/i.test(f))
    .map(f => ({
      name: f,
      path: path.join(inputDir, f),
      version: parseInt((f.match(/^store-(\d+)\.db$/i) || [])[1] || '0', 10),
    }))
    .sort((a, b) => a.version - b.version);
}

// ============================================================================
//  МОК-ОБЁРТКА ДЛЯ DRY-RUN
//  В dry-run не пишем в БД, но считаем все операции через реальные SELECT-ы.
// ============================================================================
function makeCountingRun(dryRun) {
  if (!dryRun) return null;
  return async () => ({ lastID: 0, changes: 0 });
}

// ============================================================================
//  MAIN
// ============================================================================
async function main() {
  const opts = parseArgs();
  const startedAt = Date.now();
  const ts = timestamp();

  const logPath = path.join(CONFIG.logsDir, `merge_${ts}.log`);
  const reportPath = path.join(CONFIG.logsDir, `merge_${ts}.report.json`);
  const logger = new Logger(logPath);

  logger.info('=== Merge users.db + models.db + store-N.db → bot_web-N.db ===');
  logger.info(`input:  ${CONFIG.inputDir}`);
  logger.info(`output: ${CONFIG.outputDir}`);
  logger.info(`опции:  ${JSON.stringify(opts)}`);

  const report = {
    direction: 'merge',
    startedAt,
    finishedAt: null,
    durationMs: null,
    options: opts,
    inputFiles: {},
    outputFiles: {},
    counts: {
      users: 0,
      auth: { refreshTokens: 0, emailVerifications: 0, passwordResets: 0, pushSubscriptions: 0 },
      models: { offerModels: 0, issuedModels: 0 },
      stores: {},
    },
    warnings: [],
    errors: [],
  };

  let usersDb, modelsDb;
  const storeDbs = {};

  try {
    // 1. Находим users.db и models.db
    const usersDbPath = path.join(CONFIG.inputDir, 'users.db');
    const modelsDbPath = path.join(CONFIG.inputDir, 'models.db');

    if (!fs.existsSync(usersDbPath)) {
      throw new Error(`Не найден ${usersDbPath}`);
    }
    if (!fs.existsSync(modelsDbPath)) {
      throw new Error(`Не найден ${modelsDbPath}`);
    }

    usersDb = await openDb(usersDbPath, { readonly: true });
    modelsDb = await openDb(modelsDbPath, { readonly: true });

    logger.info(`Открыт: users.db`);
    logger.info(`Открыт: models.db`);

    // 2. Читаем users + auth из users.db
    const users = await usersDb.all('SELECT * FROM users ORDER BY id');
    const refreshTokens = await usersDb.all('SELECT * FROM refresh_tokens');
    const emailVerifications = await usersDb.all('SELECT * FROM email_verifications');
    const passwordResets = await usersDb.all('SELECT * FROM password_resets');
    const pushSubscriptions = await usersDb.all('SELECT * FROM push_subscriptions');

    report.counts.users = users.length;
    report.counts.auth.refreshTokens = refreshTokens.length;
    report.counts.auth.emailVerifications = emailVerifications.length;
    report.counts.auth.passwordResets = passwordResets.length;
    report.counts.auth.pushSubscriptions = pushSubscriptions.length;

    // Читаем user_stores один раз (общий для всех магазинов)
    const allUserStores = await usersDb.all('SELECT * FROM user_stores');
    const userStoresByStore = new Map(); // store_id → Map<user_id, us>
    for (const us of allUserStores) {
      if (!userStoresByStore.has(us.store_id)) {
        userStoresByStore.set(us.store_id, new Map());
      }
      userStoresByStore.get(us.store_id).set(us.user_id, us);
    }

    logger.info(
      `USERS: ${users.length}, ` +
      `refresh=${refreshTokens.length}, verify=${emailVerifications.length}, ` +
      `reset=${passwordResets.length}, push=${pushSubscriptions.length}`
    );

    // 3. Читаем models
    const offerModels = await modelsDb.all('SELECT * FROM offer_models');
    const issuedModels = await modelsDb.all('SELECT * FROM issued_models');

    report.counts.models.offerModels = offerModels.length;
    report.counts.models.issuedModels = issuedModels.length;

    logger.info(
      `MODELS: offer=${offerModels.length}, issued=${issuedModels.length}`
    );

    // 4. Находим store-N.db
    const storeFiles = findStoreDbs(CONFIG.inputDir);
    if (!storeFiles.length) {
      throw new Error(`Не найдено ни одного store-N.db в ${CONFIG.inputDir}`);
    }

    logger.info(`Найдено store-N.db: ${storeFiles.length}`);
    for (const s of storeFiles) logger.info(`  → ${s.name} (version=${s.version})`);

    // 5. Подготавливаем output
    if (!opts.dryRun) {
      if (!fs.existsSync(CONFIG.outputDir)) {
        fs.mkdirSync(CONFIG.outputDir, { recursive: true });
      }
      for (const f of fs.readdirSync(CONFIG.outputDir)) {
        if (/^bot_web-\d+\.db(-wal|-shm)?$/i.test(f)) {
          fs.unlinkSync(path.join(CONFIG.outputDir, f));
        }
      }
    }

    // 6. Собираем userId-множество для валидации
    const userIdSet = new Set(users.map(u => u.id));

    // 7. Для каждого store-N.db создаём bot_web-N.db
    for (const store of storeFiles) {
      const botDbPath = path.join(CONFIG.outputDir, `bot_web-${store.version}.db`);
      logger.info(`\n--- bot_web-${store.version}.db ← ${store.name} ---`);

      const storeCounts = {
        users: 0,
        refreshTokens: 0,
        emailVerifications: 0,
        passwordResets: 0,
        pushSubscriptions: 0,
        offerModels: 0,
        issuedModels: 0,
        assignments: 0,
        warehouses: 0,
        user_warehouses: 0,
        product_stats: 0,
        user_stats: 0,
        earnings_history: 0,
        earnings_active: 0,
        earnings_adjustments: 0,
        earnings_adjustments_active: 0,
        orphanUserIds: [],
      };
      report.counts.stores[store.name] = storeCounts;

      // Открываем store-N.db (readonly)
      storeDbs[store.name] = await openDb(store.path, { readonly: true });
      const srcStore = storeDbs[store.name];

      // Создаём bot_web-N.db
      let botDb = null;
      if (!opts.dryRun) {
        if (fs.existsSync(botDbPath)) fs.unlinkSync(botDbPath);
        for (const sidecar of ['-wal', '-shm']) {
          if (fs.existsSync(botDbPath + sidecar)) fs.unlinkSync(botDbPath + sidecar);
        }
        botDb = await openDb(botDbPath, { readonly: false, create: true });
        // Отключаем FK на время массовой вставки — проверим целостность вручную.
        // Включим обратно после коммита.
        await botDb.exec('PRAGMA foreign_keys = OFF');
        await createFullBotWebSchema(botDb);
      }

      // Обёртка: dry-run → no-op, но счётчики работают.
      const fakeRun = makeCountingRun(opts.dryRun);
      const runFn = fakeRun || ((sql, ...args) => botDb.run(sql, ...args));

      const runner = opts.dryRun
        ? async (fn) => fn()
        : async (fn) => transaction(botDb, fn);

      await runner(async () => {

        // 7.1. USERS — с восстановлением per-store ролей/статусов
        const storeIdStr = String(store.version);
        const userStoresMap = userStoresByStore.get(storeIdStr) || new Map();

        for (const u of users) {
          let finalRole, finalIsFired, finalEarningsFactor, finalWasEmployee;

          if (u.role === 'god') {
            // god — сквозной, всегда с ролью god
            finalRole = 'god';
            finalIsFired = 0;
            const us = userStoresMap.get(u.id);
            finalEarningsFactor = us ? (us.earnings_factor ?? 1.0) : 999.99;
            finalWasEmployee = us ? (us.was_employee ?? 1) : 1;
          } else {
            const us = userStoresMap.get(u.id);
            if (us) {
              finalRole = us.is_fired ? 'user' : us.role;
              finalIsFired = us.is_fired ?? 0;
              finalEarningsFactor = us.earnings_factor ?? 1.0;
              finalWasEmployee = us.was_employee ?? 1;
            } else {
              finalRole = u.role;   // 'user' или 'guest'
              finalIsFired = 0;
              finalEarningsFactor = 1.0;
              finalWasEmployee = 0;
            }
          }

          await runFn(
            `INSERT INTO users
               (id, username, email, password_hash, name, phone, capacity, earnings_factor,
                role, is_fired, taking_orders, tg_user_id, email_verified, was_employee,
                display_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            u.id, u.username, u.email, u.password_hash, u.name, u.phone,
            u.capacity,
            finalEarningsFactor,
            finalRole,
            finalIsFired,
            u.taking_orders,
            u.tg_user_id, u.email_verified, finalWasEmployee,
            u.display_name, u.created_at, u.updated_at
          );
          storeCounts.users++;
        }

        // 7.2. AUTH-ХВОСТЫ
        for (const t of refreshTokens) {
          await runFn(
            `INSERT INTO refresh_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)`,
            t.id, t.user_id, t.token, t.expires_at
          );
          storeCounts.refreshTokens++;
        }
        for (const e of emailVerifications) {
          await runFn(
            `INSERT INTO email_verifications (id, user_id, code, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            e.id, e.user_id, e.code, e.expires_at, e.created_at ?? null
          );
          storeCounts.emailVerifications++;
        }
        for (const p of passwordResets) {
          await runFn(
            `INSERT INTO password_resets (id, user_id, code, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            p.id, p.user_id, p.code, p.expires_at, p.created_at
          );
          storeCounts.passwordResets++;
        }
        for (const s of pushSubscriptions) {
          await runFn(
            `INSERT INTO push_subscriptions
               (id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            s.id, s.user_id, s.endpoint, s.p256dh, s.auth,
            s.user_agent ?? null, s.created_at, s.last_used_at ?? null
          );
          storeCounts.pushSubscriptions++;
        }

        // 7.3. MODELS
        for (const m of offerModels) {
          await runFn(
            `INSERT INTO offer_models
               (offer_id, s3_key, file_name, s3_etag, file_size, uploaded_at, uploaded_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            m.offer_id, m.s3_key, m.file_name, m.s3_etag,
            m.file_size, m.uploaded_at, m.uploaded_by ?? null
          );
          storeCounts.offerModels++;
        }
        for (const im of issuedModels) {
          await runFn(
            `INSERT INTO issued_models (id, user_id, offer_id, issued_at)
             VALUES (?, ?, ?, ?)`,
            im.id, im.user_id, im.offer_id, im.issued_at
          );
          storeCounts.issuedModels++;
        }

        // 7.4. STORE-DATA из store-N.db
        // — assignments
        const assignments = await srcStore.all('SELECT * FROM assignments');
        for (const a of assignments) {
          if (!userIdSet.has(a.user_id)) {
            storeCounts.orphanUserIds.push({ table: 'assignments', orderId: a.order_id, userId: a.user_id });
            report.warnings.push({
              stage: 'assignments', file: store.name,
              orderId: a.order_id, userId: a.user_id,
              reason: 'user_id отсутствует в users.db',
            });
          }
          await runFn(
            `INSERT INTO assignments
               (order_id, user_id, assigned_at, completed_at, status,
                deliver_reminder_sent_at, deliver_reminder_count,
                order_amount, offer_ids, products_json,
                earnings_revoked_at, earnings_revoked_amount, earnings_revoke_reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            a.order_id, a.user_id, a.assigned_at, a.completed_at,
            a.status, a.deliver_reminder_sent_at, a.deliver_reminder_count,
            a.order_amount, a.offer_ids, a.products_json,
            a.earnings_revoked_at, a.earnings_revoked_amount, a.earnings_revoke_reason
          );
          storeCounts.assignments++;
        }

        // — warehouses
        const whs = await srcStore.all('SELECT * FROM warehouses');
        for (const w of whs) {
          await runFn(
            `INSERT INTO warehouses (warehouse_id, name, address, is_rfbs, last_synced_at)
             VALUES (?, ?, ?, ?, ?)`,
            w.warehouse_id, w.name, w.address, w.is_rfbs, w.last_synced_at
          );
          storeCounts.warehouses++;
        }

        // — user_warehouses
        const uws = await srcStore.all('SELECT * FROM user_warehouses');
        for (const uw of uws) {
          if (!userIdSet.has(uw.user_id)) {
            storeCounts.orphanUserIds.push({ table: 'user_warehouses', userId: uw.user_id });
          }
          await runFn(
            `INSERT OR IGNORE INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)`,
            uw.user_id, uw.warehouse_id
          );
          storeCounts.user_warehouses++;
        }

        // — product_stats
        const pstats = await srcStore.all('SELECT * FROM product_stats');
        for (const p of pstats) {
          await runFn(
            `INSERT INTO product_stats (offer_id, material, color, weight_grams, user_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            p.offer_id, p.material, p.color, p.weight_grams, p.user_id, p.updated_at
          );
          storeCounts.product_stats++;
        }

        // — user_stats
        const ustats = await srcStore.all('SELECT * FROM user_stats');
        for (const s of ustats) {
          if (!userIdSet.has(s.user_id)) {
            storeCounts.orphanUserIds.push({ table: 'user_stats', userId: s.user_id });
          }
          await runFn(
            `INSERT INTO user_stats (user_id, total_orders, total_amount, canceled_orders)
             VALUES (?, ?, ?, ?)`,
            s.user_id, s.total_orders, s.total_amount, s.canceled_orders
          );
          storeCounts.user_stats++;
        }

        // — earnings_history
        const eh = await srcStore.all('SELECT * FROM earnings_history');
        for (const e of eh) {
          if (!userIdSet.has(e.user_id)) {
            storeCounts.orphanUserIds.push({ table: 'earnings_history', userId: e.user_id, orderId: e.order_id });
          }
          await runFn(
            `INSERT INTO earnings_history (id, user_id, order_id, amount, calculated_at)
             VALUES (?, ?, ?, ?, ?)`,
            e.id, e.user_id, e.order_id, e.amount, e.calculated_at
          );
          storeCounts.earnings_history++;
        }

        // — earnings_active
        const ea = await srcStore.all('SELECT * FROM earnings_active');
        for (const e of ea) {
          if (!userIdSet.has(e.user_id)) {
            storeCounts.orphanUserIds.push({ table: 'earnings_active', userId: e.user_id, orderId: e.order_id });
          }
          await runFn(
            `INSERT INTO earnings_active (id, user_id, order_id, amount, calculated_at)
             VALUES (?, ?, ?, ?, ?)`,
            e.id, e.user_id, e.order_id, e.amount, e.calculated_at
          );
          storeCounts.earnings_active++;
        }

        // — earnings_adjustments
        const eadj = await srcStore.all('SELECT * FROM earnings_adjustments');
        for (const e of eadj) {
          if (!userIdSet.has(e.user_id)) {
            storeCounts.orphanUserIds.push({ table: 'earnings_adjustments', userId: e.user_id });
          }
          await runFn(
            `INSERT INTO earnings_adjustments (id, user_id, amount, reason, adjusted_at)
             VALUES (?, ?, ?, ?, ?)`,
            e.id, e.user_id, e.amount, e.reason, e.adjusted_at
          );
          storeCounts.earnings_adjustments++;
        }

        // — earnings_adjustments_active
        const eadja = await srcStore.all('SELECT * FROM earnings_adjustments_active');
        for (const e of eadja) {
          if (!userIdSet.has(e.user_id)) {
            storeCounts.orphanUserIds.push({ table: 'earnings_adjustments_active', userId: e.user_id });
          }
          await runFn(
            `INSERT INTO earnings_adjustments_active (id, user_id, amount, reason, adjusted_at)
             VALUES (?, ?, ?, ?, ?)`,
            e.id, e.user_id, e.amount, e.reason, e.adjusted_at
          );
          storeCounts.earnings_adjustments_active++;
        }
      });

      // Проверка foreign_keys после вставки
      if (!opts.dryRun && botDb) {
        await botDb.exec('PRAGMA foreign_keys = ON');
        const fkCheck = await botDb.all('PRAGMA foreign_key_check');
        if (fkCheck.length) {
          logger.warn(`  ⚠️ FK violation после merge: ${fkCheck.length} строк`);
          report.warnings.push({
            stage: 'fk_check', file: store.name, count: fkCheck.length,
            sample: fkCheck.slice(0, 5),
          });
        }
      }

      logger.info(
        `  users=${storeCounts.users}, assignments=${storeCounts.assignments}, ` +
        `earnings_history=${storeCounts.earnings_history}, ` +
        `orphans=${storeCounts.orphanUserIds.length}`
      );

      // Финальный размер файла
      if (!opts.dryRun && fs.existsSync(botDbPath)) {
        report.outputFiles[`bot_web-${store.version}.db`] = fs.statSync(botDbPath).size;
      }
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
    if (usersDb) await usersDb.close();
    if (modelsDb) await modelsDb.close();
    for (const db of Object.values(storeDbs)) {
      try { await db.close(); } catch (_) { }
    }
    await logger.close();
  }
}

// ============================================================================
//  PRINT REPORT
// ============================================================================
function printReport(report, logger) {
  logger.info('\n============ ИТОГОВЫЙ ОТЧЁТ ============');
  logger.info(`Направление: merge`);
  logger.info(`Длительность: ${(report.durationMs / 1000).toFixed(2)} с`);
  logger.info(`\nUSERS: ${report.counts.users}`);
  logger.info(`AUTH:  refresh=${report.counts.auth.refreshTokens}, ` +
    `verify=${report.counts.auth.emailVerifications}, ` +
    `reset=${report.counts.auth.passwordResets}, ` +
    `push=${report.counts.auth.pushSubscriptions}`);
  logger.info(`MODELS: offer=${report.counts.models.offerModels}, issued=${report.counts.models.issuedModels}`);
  logger.info(`\nSTORE-N → bot_web-N:`);
  for (const [file, c] of Object.entries(report.counts.stores)) {
    logger.info(`  [${file}]`);
    logger.info(`    users:                    ${c.users}`);
    logger.info(`    assignments:              ${c.assignments}`);
    logger.info(`    earnings_history:         ${c.earnings_history}`);
    logger.info(`    orphan user_ids:          ${c.orphanUserIds.length}`);
  }
  if (report.warnings.length) logger.info(`\n⚠️ Предупреждений: ${report.warnings.length} (см. JSON)`);
  if (report.errors.length) logger.info(`\n❌ Ошибок: ${report.errors.length}`);
  logger.info('=========================================');
}

main();