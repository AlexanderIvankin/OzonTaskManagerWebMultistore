#!/usr/bin/env node
// migration/notifications-merge-live.js
//
// Вливает СТАРЫЕ per-store notifications-N.db в УЖЕ СУЩЕСТВУЮЩУЮ
// notifications.db (которая могла быть заполнена работающим backend).
//
// Логика:
//   1. Находит все notifications-*.db в old-dir.
//   2. Для каждого читает old bot_web-N.db → карту old_user_id → email.
//   3. Читает users.db → карту email → new_user_id.
//   4. Идемпотентно вставляет notifications/server_errors в target-DB.
//      Перед каждой вставкой — проверка на дубликат по «естественному ключу».
//
// Естественные ключи:
//   notifications:  (recipient_id, store_id, type, created_at, order_id)
//   server_errors:  (store_id, source, message, created_at)
//
// Повторный запуск НЕ создаст дублей. Можно запускать сколько угодно раз.
//
// Запуск:
//   node notifications-merge-live.js \
//     --target=/var/www/ozon/backend/notifications.db \
//     --users=/var/www/ozon/backend/users.db \
//     --old-dir=/path/to/old/notifications \
//     --botweb-dir=/path/to/bot_web \
//     [--dry-run] [--verbose]
//
// Если --target не задан — берётся web-multistore_output/notifications.db
// рядом со скриптом (сценарий «до отдачи на сервер»).

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { openDb, transaction, backupDb } = require('./lib/db');
const Logger = require('./lib/logger');
const { normalizeEmail, timestamp } = require('./lib/helpers');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    target: null,
    users: null,
    oldDir: null,
    botWebDir: null,
    dryRun: false,
    verbose: false,
  };
  for (const a of args) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a.startsWith('--target=')) opts.target = a.slice(9);
    else if (a.startsWith('--users=')) opts.users = a.slice(8);
    else if (a.startsWith('--old-dir=')) opts.oldDir = a.slice(10);
    else if (a.startsWith('--botweb-dir=')) opts.botWebDir = a.slice(13);
  }
  return opts;
}

/** Строит карту old_user_id → email из bot_web-N.db. */
async function buildOldUserMap(botWebPath) {
  const db = await openDb(botWebPath, { readonly: true });
  try {
    const rows = await db.all('SELECT id, email FROM users');
    const map = new Map();
    for (const r of rows) {
      const email = normalizeEmail(r.email);
      if (email) map.set(r.id, email);
    }
    return map;
  } finally {
    await db.close();
  }
}

/** Строит карту email → new_user_id из users.db. */
async function buildNewUserMap(usersDbPath) {
  const db = await openDb(usersDbPath, { readonly: true });
  try {
    const rows = await db.all('SELECT id, email FROM users');
    const map = new Map();
    for (const r of rows) {
      const email = normalizeEmail(r.email);
      if (email) map.set(email, r.id);
    }
    return map;
  } finally {
    await db.close();
  }
}

/**
 * Идемпотентная вставка notifications.
 * Возвращает 'inserted' | 'skipped'.
 */
async function insertNotificationIdempotent(db, row, dryRun) {
  const params = [
    row.recipient_id, row.store_id, row.audience, row.type, row.title,
    row.message, row.payload, row.order_id, row.user_name, row.offer_ids,
    row.is_read, row.created_at,
  ];
  // Проверка на дубликат по естественному ключу.
  const exists = await db.get(
    `SELECT 1 FROM notifications
       WHERE recipient_id = ? AND store_id = ? AND type = ?
         AND created_at = ? AND COALESCE(order_id, '') = COALESCE(?, '')
       LIMIT 1`,
    row.recipient_id, row.store_id, row.type, row.created_at, row.order_id
  );
  if (exists) return 'skipped';
  if (dryRun) return 'inserted';
  await db.run(
    `INSERT INTO notifications
       (recipient_id, store_id, audience, type, title, message,
        payload, order_id, user_name, offer_ids, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ...params
  );
  return 'inserted';
}

async function insertServerErrorIdempotent(db, row, dryRun) {
  const exists = await db.get(
    `SELECT 1 FROM server_errors
       WHERE COALESCE(store_id, '') = COALESCE(?, '')
         AND source = ? AND message = ? AND created_at = ?
       LIMIT 1`,
    row.store_id, row.source, row.message, row.created_at
  );
  if (exists) return 'skipped';
  if (dryRun) return 'inserted';
  await db.run(
    `INSERT INTO server_errors
       (store_id, level, source, message, stack, context, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    row.store_id, row.level, row.source, row.message,
    row.stack, row.context, row.is_read, row.created_at
  );
  return 'inserted';
}

async function main() {
  const opts = parseArgs();
  const startedAt = Date.now();
  const ts = timestamp();
  const logPath = path.join(__dirname, 'logs', `notifications-merge_${ts}.log`);
  const logger = new Logger(logPath);

  // Дефолты — если запускаем локально «до отдачи на сервер»
  const TARGET = opts.target || path.join(__dirname, 'web-multistore_output', 'notifications.db');
  const USERS_DB = opts.users || path.join(__dirname, 'web-multistore_output', 'users.db');
  const OLD_DIR = opts.oldDir || path.join(__dirname, 'web-multistore_input');
  const BOTWEB_DIR = opts.botWebDir || OLD_DIR;

  logger.info('=== Notifications: старые per-store → общая notifications.db ===');
  logger.info(`target:       ${TARGET}`);
  logger.info(`users.db:     ${USERS_DB}`);
  logger.info(`old-dir:      ${OLD_DIR}`);
  logger.info(`botweb-dir:   ${BOTWEB_DIR}`);
  logger.info(`опции:        ${JSON.stringify(opts)}`);

  const report = {
    direction: 'notifications-merge-live',
    startedAt,
    finishedAt: null,
    target: TARGET,
    stores: {},
    warnings: [],
    errors: [],
  };

  try {
    // ---- Валидация ----
    if (!fs.existsSync(TARGET)) {
      throw new Error(`Не найден target: ${TARGET}. Скрипт вливает в СУЩЕСТВУЮЩУЮ БД.`);
    }
    if (!fs.existsSync(USERS_DB)) {
      throw new Error(`Не найден users.db: ${USERS_DB}`);
    }
    if (!fs.existsSync(OLD_DIR)) {
      throw new Error(`Не найдена папка старых БД: ${OLD_DIR}`);
    }

    // ---- Старые notifications-*.db ----
    const oldFiles = fs.readdirSync(OLD_DIR)
      .filter((f) => /^notifications(-\d+)?\.db$/i.test(f))
      .map((f) => {
        const m = f.match(/notifications(?:-(\d+))?\.db$/i);
        const version = m && m[1] ? parseInt(m[1], 10) : 1;
        return { name: f, path: path.join(OLD_DIR, f), version };
      })
      .sort((a, b) => a.version - b.version);

    if (!oldFiles.length) {
      logger.info('Старых notifications-*.db не найдено. Нечего вливать.');
      return;
    }
    logger.info(`Найдено старых: ${oldFiles.length}`);
    for (const f of oldFiles) logger.info(`  → ${f.name} (store=${f.version})`);

    // ---- Backup target перед изменениями ----
    if (!opts.dryRun) {
      const backupDir = path.join(__dirname, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(
        backupDir,
        `notifications.before-merge-${ts}.db`
      );
      fs.copyFileSync(TARGET, backupPath);
      logger.info(`📦 Backup: ${backupPath}`);
      report.backupPath = backupPath;
    }

    // ---- Карты email ----
    const newUserMap = await buildNewUserMap(USERS_DB);
    logger.info(`users.db: ${newUserMap.size} пользователей`);

    // ---- Целевая БД ----
    const targetDb = await openDb(TARGET, { readonly: opts.dryRun });
    if (!opts.dryRun) {
      await targetDb.exec('PRAGMA foreign_keys = OFF');
      await targetDb.exec('PRAGMA busy_timeout = 5000');
    }
    const run = (sql, ...p) =>
      opts.dryRun ? Promise.resolve({ changes: 0 }) : targetDb.run(sql, ...p);

    // ---- Обработка каждого магазина ----
    for (const file of oldFiles) {
      const storeId = String(file.version);
      const botWebPath = path.join(BOTWEB_DIR, `bot_web-${storeId}.db`);

      if (!fs.existsSync(botWebPath)) {
        logger.warn(
          `  ⚠️ ${file.name}: не найден ${path.basename(botWebPath)} ` +
          `(для маппинга user_id → email). Пропускаем.`
        );
        report.warnings.push({
          stage: 'store',
          file: file.name,
          reason: `не найден ${path.basename(botWebPath)}`,
        });
        continue;
      }

      const oldUserMap = await buildOldUserMap(botWebPath);
      logger.info(`\n--- ${file.name} (store=${storeId}) ---`);
      logger.info(`  ${path.basename(botWebPath)}: ${oldUserMap.size} пользователей`);

      const srcDb = await openDb(file.path, { readonly: true });
      const counts = {
        inserted: 0, skipped: 0, orphan: 0,
        errorsInserted: 0, errorsSkipped: 0,
      };
      report.stores[file.name] = counts;

      const tables = await srcDb.all(
        `SELECT name FROM sqlite_master WHERE type='table'`
      );
      const names = new Set(tables.map((t) => t.name));

      // Одна транзакция на магазин — для консистентности и производительности.
      // В dry-run не транзакция.
      const work = async () => {
        // --- notifications ---
        if (names.has('notifications')) {
          const srcRows = await srcDb.all('SELECT * FROM notifications');
          logger.info(`  notifications: ${srcRows.length} строк (источник)`);

          for (const r of srcRows) {
            // Маппинг recipient_id
            const email = oldUserMap.get(r.recipient_id);
            const newId = email ? newUserMap.get(email) : null;
            if (!newId) {
              counts.orphan++;
              report.warnings.push({
                stage: 'notification',
                file: file.name,
                old_recipient_id: r.recipient_id,
                old_email: email || null,
                reason: email
                  ? 'email не найден в users.db'
                  : 'recipient_id не найден в bot_web-N.db',
              });
              continue;
            }

            const row = {
              recipient_id: newId,
              store_id: storeId,
              audience: r.audience || 'user',
              type: r.type,
              title: r.title,
              message: r.message || '',
              payload: r.payload || null,
              order_id: r.order_id || null,
              user_name: r.user_name || null,
              offer_ids: r.offer_ids || null,
              is_read: r.is_read || 0,
              created_at: r.created_at || Date.now(),
            };
            const res = await insertNotificationIdempotent(targetDb, row, opts.dryRun);
            if (res === 'inserted') counts.inserted++;
            else counts.skipped++;
          }
        }

        // --- server_errors ---
        if (names.has('server_errors')) {
          const srcRows = await srcDb.all('SELECT * FROM server_errors');
          logger.info(`  server_errors: ${srcRows.length} строк (источник)`);

          for (const r of srcRows) {
            const row = {
              store_id: storeId,
              level: r.level || 'error',
              source: r.source || '',
              message: r.message,
              stack: r.stack || null,
              context: r.context || null,
              is_read: r.is_read || 0,
              created_at: r.created_at || Date.now(),
            };
            const res = await insertServerErrorIdempotent(targetDb, row, opts.dryRun);
            if (res === 'inserted') counts.errorsInserted++;
            else counts.errorsSkipped++;
          }
        }
      };

      if (opts.dryRun) {
        await work();
      } else {
        await transaction(targetDb, work);
      }

      await srcDb.close();

      logger.info(
        `  notifications: вставлено ${counts.inserted}, ` +
        `пропущено (дубли) ${counts.skipped}, orphan ${counts.orphan}`
      );
      logger.info(
        `  server_errors: вставлено ${counts.errorsInserted}, ` +
        `пропущено ${counts.errorsSkipped}`
      );
    }

    if (!opts.dryRun) {
      await targetDb.exec('PRAGMA foreign_keys = ON');
      const fk = await targetDb.all('PRAGMA foreign_key_check');
      if (fk.length) {
        logger.warn(`⚠️ FK violations: ${fk.length}`);
        report.warnings.push({ stage: 'fk_check', count: fk.length });
      }
    }

    // ---- Итоговая статистика по target ----
    logger.info('\n=== ИТОГ ===');
    try {
      const byStore = await targetDb.all(
        `SELECT store_id, COUNT(*) AS c FROM notifications GROUP BY store_id ORDER BY store_id`
      );
      const totalRow = await targetDb.get('SELECT COUNT(*) AS c FROM notifications');
      logger.info(`Всего в target: ${totalRow.c}`);
      for (const s of byStore) {
        logger.info(`  store ${s.store_id || '(null)'}: ${s.c}`);
      }
    } catch (e) {
      logger.warn(`Не удалось посчитать итог: ${e.message}`);
    }
    for (const [f, c] of Object.entries(report.stores)) {
      logger.info(
        `  [${f}] +${c.inserted} (дубли ${c.skipped}, orphan ${c.orphan})`
      );
    }
    if (report.warnings.length) {
      logger.info(`⚠️ Предупреждений: ${report.warnings.length} (см. JSON)`);
    }

    report.finishedAt = Date.now();
    fs.writeFileSync(
      path.join(__dirname, 'logs', `notifications-merge_${ts}.report.json`),
      JSON.stringify(report, null, 2)
    );

    await targetDb.close();
  } catch (err) {
    logger.error(`Критическая ошибка: ${err.stack || err.message}`);
    report.errors.push({ message: err.message, stack: err.stack });
    report.finishedAt = Date.now();
    try {
      fs.writeFileSync(
        path.join(__dirname, 'logs', `notifications-merge_${ts}.report.json`),
        JSON.stringify(report, null, 2)
      );
    } catch (_) {}
    process.exitCode = 1;
  } finally {
    await logger.close();
  }
}

main();