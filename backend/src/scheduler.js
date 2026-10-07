// src/scheduler.js
const path = require('path');
const { getLocalTime, getLocalDate, getLocalTimestamp } = require('./utils');
const { getStoreDB } = require('./config/database');
const stores = require('./config/stores');
const OrderService = require('./services/OrderService');
const OzonService = require('./services/OzonService');
const EarningsService = require('./services/EarningsService');
const BackupService = require('./services/BackupService');
const StorageService = require('./services/StorageService');
const ModelService = require('./services/ModelService');
const OfferModel = require('./models/OfferModel');
const Notification = require('./models/Notification');
const NotificationService = require('./services/NotificationService');
const PushService = require('./services/PushService');
const AuthService = require('./services/AuthService');
const CooldownService = require('./services/CooldownService');

// ============================================================================
// УСИЛЕННАЯ ЗАЩИТА ОТ ПРОПУСКОВ ПРОВЕРОК:
//   1) «Догонялка»: интервал тикает часто (минута), а задача запускается при
//      первом тике ПОСЛЕ целевого времени;
//   2) Маркер успешного запуска выставляется ТОЛЬКО после успешного выполнения;
//   3) Лимит попыток в сутки/месяц (gate);
//   4) Guard is...Running у каждой задачи;
//   5) Все сбои журналируются (logServerError).
//
// MULTISTORE:
//   • Per-store задачи выполняются ПОСЛЕДОВАТЕЛЬНО по всем магазинам в одном
//     процессе (не параллельно), чтобы не перегружать Ozon/SQLite.
//   • У каждого магазина свой gate (daily/monthly): магазин 1 может уже
//     успешно отработать, а магазин 2 — ещё нет (или упасть).
//   • Глобальные задачи (backup, notificationsCleanup, guestCleanup,
//     modelsMaintenance, cooldownCleaner) работают на уровне всего приложения.
// ============================================================================

// ============================================================================
//  HELPERS
// ============================================================================

function envInt(name, defaultValue, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const value = parseInt(raw, 10);
  if (Number.isNaN(value)) return defaultValue;
  if (min !== undefined && value < min) return defaultValue;
  if (max !== undefined && value > max) return defaultValue;
  return value;
}

function todayKey() {
  return getLocalDate().toDateString();
}

function currentMonthKey() {
  const d = getLocalDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function createDailyGate(maxAttempts = 10) {
  let lastSuccessDate = null;
  let attempts = 0;
  let lastAttemptDate = null;
  return {
    isDone() { return lastSuccessDate === todayKey(); },
    canAttempt() {
      if (lastAttemptDate !== todayKey()) attempts = 0;
      return attempts < maxAttempts;
    },
    onSuccess() { lastSuccessDate = todayKey(); attempts = 0; },
    onFailure() { attempts += 1; lastAttemptDate = todayKey(); },
  };
}

function createMonthlyGate(maxAttempts = 10) {
  let lastSuccessMonth = null;
  let attempts = 0;
  return {
    isDone() { return lastSuccessMonth === currentMonthKey(); },
    canAttempt() {
      if (lastSuccessMonth !== currentMonthKey()) attempts = 0;
      return attempts < maxAttempts;
    },
    onSuccess() { lastSuccessMonth = currentMonthKey(); attempts = 0; },
    onFailure() { attempts += 1; },
  };
}

/**
 * Per-store DAILY runner.
 * Тик раз в минуту. При первом тике после целевого времени запускает
 * задачу для каждого магазина ПО ОЧЕРЕДИ (последовательно). У каждого
 * магазина свой gate: если магазин 1 успешно отработал — больше сегодня не
 * трогаем; магазин 2 в это же время может ещё не запускаться или упасть.
 *
 * @param {string}   name        — имя для логов и source в server_errors
 * @param {number}   targetHour
 * @param {number}   targetMinute
 * @param {number}   maxAttempts
 * @param {(storeId: string) => Promise<void>} run
 * @param {(storeId: string) => boolean} [isEnabled] — выключенные магазины пропускаются
 */
function createPerStoreDailyRunner({
  name, targetHour, targetMinute, maxAttempts, run, isEnabled,
}) {
  const gates = new Map();
  let timer = null;
  let running = false;

  return {
    start() {
      if (timer) clearInterval(timer);
      running = false;
      timer = setInterval(async () => {
        if (running) return;
        const localTime = getLocalTime();
        if (localTime.hours * 60 + localTime.minutes < targetHour * 60 + targetMinute) return;
        running = true;
        try {
          for (const storeId of stores.getStoreIds()) {
            if (isEnabled && !isEnabled(storeId)) continue;
            let gate = gates.get(storeId);
            if (!gate) {
              gate = createDailyGate(maxAttempts);
              gates.set(storeId, gate);
            }
            if (gate.isDone()) continue;
            if (!gate.canAttempt()) continue;

            try {
              await run(storeId);
              gate.onSuccess();
            } catch (err) {
              console.error(`[SCHEDULER][${name}][store ${storeId}] Ошибка:`, err);
              gate.onFailure();
              NotificationService.logServerError(`scheduler.${name}`, err, { storeId });
            }
          }
        } finally {
          running = false;
        }
      }, 60 * 1000);

      console.log(
        `[SCHEDULER] ${name}: запланирован на ${targetHour}:${String(targetMinute).padStart(2, '0')} ` +
        `(per-store, с догонялкой после сбоев)`
      );
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      running = false;
      gates.clear();
    },
  };
}

/**
 * Per-store MONTHLY runner (для monthlyExport).
 */
function createPerStoreMonthlyRunner({ name, maxAttempts, run }) {
  const gates = new Map();
  let timer = null;
  let running = false;

  return {
    start() {
      if (timer) clearInterval(timer);
      running = false;
      timer = setInterval(async () => {
        if (running) return;
        const localDate = getLocalDate();
        if (localDate.getDate() !== 1) return;
        running = true;
        try {
          for (const storeId of stores.getStoreIds()) {
            let gate = gates.get(storeId);
            if (!gate) {
              gate = createMonthlyGate(maxAttempts);
              gates.set(storeId, gate);
            }
            if (gate.isDone()) continue;
            if (!gate.canAttempt()) continue;

            try {
              await run(storeId);
              gate.onSuccess();
            } catch (err) {
              console.error(`[SCHEDULER][${name}][store ${storeId}] Ошибка:`, err);
              gate.onFailure();
              NotificationService.logServerError(`scheduler.${name}`, err, { storeId });
            }
          }
        } finally {
          running = false;
        }
      }, 60 * 1000);
      console.log(`[SCHEDULER] ${name}: 1-е число месяца (per-store, с догонялкой)`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      running = false;
      gates.clear();
    },
  };
}

/**
 * Per-store INTERVAL runner (orderChecker, orderStatusSync).
 */
function createPerStoreIntervalRunner({ name, intervalMs, run }) {
  let timer = null;
  let running = false;
  return {
    start() {
      if (timer) clearInterval(timer);
      running = false;
      timer = setInterval(async () => {
        if (running) {
          console.warn(`[SCHEDULER][${name}] Предыдущий прогон ещё идёт — тик пропущен`);
          return;
        }
        running = true;
        try {
          for (const storeId of stores.getStoreIds()) {
            try {
              await run(storeId);
            } catch (err) {
              console.error(`[SCHEDULER][${name}][store ${storeId}] Ошибка:`, err);
              NotificationService.logServerError(`scheduler.${name}`, err, { storeId });
            }
          }
        } finally {
          running = false;
        }
      }, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      running = false;
    },
  };
}

// ============================================================================
//  1. ПРОВЕРКА НОВЫХ ЗАКАЗОВ (per-store, интервальная)
// ============================================================================
// Пауза — per-store: админ магазина 1 не должен останавливать магазин 2.
// Set хранит storeId приостановленных магазинов.

let orderCheckerRunner = null;
const pausedStores = new Set(); // Set<string> приостановленных storeId

function startOrderChecker(intervalMinutes) {
  const intervalMs = Math.max(1, parseInt(intervalMinutes, 10) || 1) * 60 * 1000;
  if (orderCheckerRunner) orderCheckerRunner.stop();

  orderCheckerRunner = createPerStoreIntervalRunner({
    name: 'orderChecker',
    intervalMs,
    run: async (storeId) => {
      if (pausedStores.has(String(storeId))) return;
      console.log(`[SCHEDULER] Проверка заказов [store ${storeId}] в ${getLocalTimestamp()}`);
      await OrderService.checkNewOrders(storeId);
    },
  });
  orderCheckerRunner.start();
}

function stopOrderChecker() {
  if (orderCheckerRunner) {
    orderCheckerRunner.stop();
    orderCheckerRunner = null;
  }
}

function pauseChecker(storeId) {
  if (storeId == null || storeId === '') return;
  pausedStores.add(String(storeId));
}

function resumeChecker(storeId) {
  if (storeId == null || storeId === '') return;
  pausedStores.delete(String(storeId));
}

function isCheckerPaused(storeId) {
  if (storeId == null || storeId === '') return false;
  return pausedStores.has(String(storeId));
}

// ============================================================================
//  2. ОЧИСТКА КУЛДАУНОВ (глобальная, раз в час)
// ============================================================================
let cooldownCleanInterval = null;
let isCooldownCleanRunning = false;

function startCooldownCleaner() {
  if (cooldownCleanInterval) clearInterval(cooldownCleanInterval);
  isCooldownCleanRunning = false;

  cooldownCleanInterval = setInterval(() => {
    if (isCooldownCleanRunning) return;
    isCooldownCleanRunning = true;
    try {
      CooldownService.cleanCooldowns();
    } catch (err) {
      console.error('[SCHEDULER] Ошибка при очистке кулдаунов:', err);
    } finally {
      isCooldownCleanRunning = false;
    }
  }, 60 * 60 * 1000);

  console.log('[SCHEDULER] Очистка кулдаунов запланирована каждый час');
}

function stopCooldownCleaner() {
  if (cooldownCleanInterval) {
    clearInterval(cooldownCleanInterval);
    cooldownCleanInterval = null;
  }
  isCooldownCleanRunning = false;
}

// ============================================================================
//  3. ЕЖЕДНЕВНЫЙ БЭКАП (глобальный)
// ============================================================================
// ВНИМАНИЕ (multistore): BackupService в старой версии опирается на getDBPath()
// и getDB() — в новой архитектуре их нет. Бэкап должен обходить ВСЕ файлы БД
// (users.db, models.db, store-N.db) и делать VACUUM INTO в backups/.
// Пока вызывается как есть — при срабатывании упадёт с понятной ошибкой;
// это отдельный батч (переделка BackupService).
let backupInterval = null;
let isBackupRunning = false;
let backupGate = null;

function startDailyBackupChecker() {
  if (backupInterval) clearInterval(backupInterval);
  isBackupRunning = false;
  backupGate = createDailyGate(envInt('BACKUP_MAX_ATTEMPTS', 3, 1, 60));

  const targetHour = envInt('BACKUP_HOUR', 0, 0, 23);
  const targetMinute = envInt('BACKUP_MINUTE', 0, 0, 59);

  backupInterval = setInterval(async () => {
    if (isBackupRunning) return;
    if (backupGate.isDone()) return;
    const localTime = getLocalTime();
    if (localTime.hours * 60 + localTime.minutes < targetHour * 60 + targetMinute) return;
    if (!backupGate.canAttempt()) return;

    isBackupRunning = true;
    try {
      console.log('[SCHEDULER] Запуск ежедневного автобэкапа БД...');
      const result = await BackupService.createDbBackup();

      if (result.errors.length) {
        // Хотя бы одна БД не забэкапилась — сутки не закрываем, повторим позже.
        const summary = result.errors.map((e) => `${e.label}: ${e.message}`).join('; ');
        const err = new Error(`Автобэкап: часть БД не удалось сохранить — ${summary}`);
        console.error('[SCHEDULER]', err.message);
        backupGate.onFailure();
        NotificationService.logServerError('scheduler.backup', err, {
          created: result.created.length,
          skipped: result.skipped,
          errors: result.errors,
        });
      } else {
        console.log(
          `[SCHEDULER] Автобэкап завершён: создано ${result.created.length}, пропущено ${result.skipped.length}`
        );
        backupGate.onSuccess();
      }
    } catch (err) {
      console.error('[SCHEDULER] Ошибка автобэкапа:', err);
      backupGate.onFailure();
      NotificationService.logServerError('scheduler.backup', err);
    } finally {
      isBackupRunning = false;
    }
  }, 60 * 1000);

  console.log(
    `[SCHEDULER] Ежедневный автобэкап запланирован на ${targetHour}:${String(targetMinute).padStart(2, '0')}`
  );
}
function stopDailyBackupChecker() {
  if (backupInterval) {
    clearInterval(backupInterval);
    backupInterval = null;
  }
}

// ============================================================================
//  4. ОЧИСТКА АКЦИЙ (per-store, ежедневно)
// ============================================================================
const promotionCleanerRunner = createPerStoreDailyRunner({
  name: 'promotionCleaner',
  targetHour: envInt('PROMOTION_CLEAN_HOUR', 3, 0, 23),
  targetMinute: envInt('PROMOTION_CLEAN_MINUTE', 0, 0, 59),
  maxAttempts: envInt('PROMOTION_CLEAN_MAX_ATTEMPTS', 5, 1, 60),
  // Магазин включается флагом CLEAN_PROMOTIONS в .env.storeN
  isEnabled: (storeId) => stores.getStore(storeId).features.cleanPromotions,
  run: async (storeId) => {
    console.log(`[SCHEDULER] Запуск очистки акций [store ${storeId}]...`);
    const progressCallback = (text) => console.log(`[PROMOTION_CLEAN][store ${storeId}] ${text}`);
    const result = await OzonService.removeAllPromotions(storeId, progressCallback);
    console.log(
      `[SCHEDULER][store ${storeId}] Очистка акций завершена: ` +
      `${result.actionsProcessed} акций, ${result.totalProductsRemoved} товаров`
    );
  },
});

function startDailyPromotionCleaner() {
  promotionCleanerRunner.start();
}
function stopDailyPromotionCleaner() {
  promotionCleanerRunner.stop();
}

// ============================================================================
//  5. ЕЖЕМЕСЯЧНЫЙ ЭКСПОРТ (per-store)
// ============================================================================
const monthlyExportRunner = createPerStoreMonthlyRunner({
  name: 'monthlyExport',
  maxAttempts: envInt('MONTHLY_EXPORT_MAX_ATTEMPTS', 10, 1, 60),
  run: async (storeId) => {
    const localDate = getLocalDate();
    const prevMonth = new Date(localDate.getFullYear(), localDate.getMonth() - 1, 1);
    const monthStr =
      `${prevMonth.getFullYear()}-` +
      `${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;

    console.log(`[SCHEDULER][store ${storeId}] Запуск экспорта заработка за ${monthStr}`);
    const outputPath = await EarningsService.exportMonthlyEarnings(storeId, monthStr);

    const baseName = outputPath ? path.basename(outputPath) : null;
    NotificationService.notifyStaff(
      'monthly_export_done',
      { month: monthStr, file: baseName },
      { storeId, push: false }
    );
  },
});

function startMonthlyExportChecker() {
  monthlyExportRunner.start();
}
function stopMonthlyExportChecker() {
  monthlyExportRunner.stop();
}

// ============================================================================
//  6. ОЧИСТКА NOTIFICATIONS.DB (глобальная)
// ============================================================================
let notificationsCleanupInterval = null;
let isNotificationsCleanupRunning = false;
let notificationsCleanupGate = null;

function startNotificationsCleanup() {
  if (notificationsCleanupInterval) clearInterval(notificationsCleanupInterval);
  isNotificationsCleanupRunning = false;
  notificationsCleanupGate = createDailyGate(envInt('NOTIFICATIONS_CLEANUP_MAX_ATTEMPTS', 5, 1, 60));

  const targetHour = envInt('NOTIFICATIONS_CLEANUP_HOUR', 3, 0, 23);
  const targetMinute = envInt('NOTIFICATIONS_CLEANUP_MINUTE', 0, 0, 59);

  notificationsCleanupInterval = setInterval(async () => {
    if (isNotificationsCleanupRunning) return;
    if (notificationsCleanupGate.isDone()) return;
    const localTime = getLocalTime();
    if (localTime.hours * 60 + localTime.minutes < targetHour * 60 + targetMinute) return;
    if (!notificationsCleanupGate.canAttempt()) return;

    isNotificationsCleanupRunning = true;
    try {
      const notifDays = envInt('NOTIFICATIONS_RETENTION_DAYS', 7, 1, 3650);
      const errorDays = envInt('SERVER_ERRORS_RETENTION_DAYS', 14, 1, 3650);

      const result = await Notification.pruneOld(notifDays, errorDays);
      notificationsCleanupGate.onSuccess();
      if (result.notifications > 0 || result.errors > 0) {
        console.log(
          `[SCHEDULER] Очистка notifications.db: удалено ${result.notifications} оповещений старше ${notifDays} дн., ${result.errors} ошибок старше ${errorDays} дн.`
        );
      }

      const pushDays = envInt('PUSH_SUB_RETENTION_DAYS', 180, 7, 3650);
      const removedSubs = await PushService.pruneStale(pushDays);
      if (removedSubs > 0) {
        console.log(
          `[SCHEDULER] Очистка Web Push: удалено ${removedSubs} неактивных подписок (старше ${pushDays} дн.)`
        );
      }
    } catch (err) {
      console.error('[SCHEDULER] Ошибка очистки оповещений:', err);
      notificationsCleanupGate.onFailure();
      NotificationService.logServerError('scheduler.notificationsCleanup', err);
    } finally {
      isNotificationsCleanupRunning = false;
    }
  }, 60 * 1000);

  console.log(
    `[SCHEDULER] Ежедневная очистка оповещений запланирована на ${targetHour}:${String(targetMinute).padStart(2, '0')}`
  );
}

function stopNotificationsCleanup() {
  if (notificationsCleanupInterval) {
    clearInterval(notificationsCleanupInterval);
    notificationsCleanupInterval = null;
  }
}

// ============================================================================
//  7. НАПОМИНАНИЯ AWAITING_DELIVER (per-store)
// ============================================================================
const deliverReminderRunner = createPerStoreDailyRunner({
  name: 'awaitingDeliverReminder',
  targetHour: envInt('DELIVER_REMINDER_HOUR', 7, 0, 23),
  targetMinute: envInt('DELIVER_REMINDER_MINUTE', 0, 0, 59),
  maxAttempts: envInt('DELIVER_REMINDER_MAX_ATTEMPTS', 10, 1, 60),
  run: async (storeId) => {
    const delayHours = envInt('DELIVER_REMINDER_DELAY_HOURS', 24, 1, 24 * 30);
    await runAwaitingDeliverReminder(storeId, delayHours);
  },
});

function startAwaitingDeliverReminderChecker() {
  deliverReminderRunner.start();
}
function stopAwaitingDeliverReminderChecker() {
  deliverReminderRunner.stop();
}

/**
 * Один прогон проверки awaiting_deliver ДЛЯ КОНКРЕТНОГО МАГАЗИНА.
 */
async function runAwaitingDeliverReminder(storeId, delayHours, options = {}) {
  console.log(`[REMINDER][store ${storeId}] Запуск проверки awaiting_deliver...`);

  const db = getStoreDB(storeId);
  const warnDays = options.warnDays != null
    ? options.warnDays
    : envInt('DELIVER_REMINDER_WARN_DAYS', 2, 1, 60);
  const revokeDays = options.revokeDays != null
    ? options.revokeDays
    : envInt('DELIVER_REMINDER_REVOKE_DAYS', 3, 1, 90);

  let orders;
  try {
    orders = await OzonService.fetchAwaitingDeliverOrders(storeId);
  } catch (err) {
    console.error(`[REMINDER][store ${storeId}] Не удалось получить список заказов:`, err.message);
    throw err;
  }

  if (!Array.isArray(orders)) {
    throw new Error('fetchAwaitingDeliverOrders() вернул не массив');
  }

  console.log(`[REMINDER][store ${storeId}] Получено ${orders.length} заказов в awaiting_deliver`);
  if (!orders.length) return { found: 0, sent: 0, revoked: 0 };

  const orderIds = orders.map((order) => order.posting_number).filter(Boolean);
  if (!orderIds.length) {
    console.log(`[REMINDER][store ${storeId}] В ответе нет posting_number`);
    return { found: 0, sent: 0, revoked: 0 };
  }

  const placeholders = orderIds.map(() => '?').join(',');
  const cutoff = Date.now() - delayHours * 60 * 60 * 1000;

  const todayStart = getLocalDate();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  // is_fired теперь в user_stores, не в users. JOIN по (user_id, store_id).
  const completedAssignments = await db.all(
    `SELECT
        a.order_id,
        a.user_id,
        a.completed_at,
        a.deliver_reminder_sent_at,
        u.name AS user_name,
        COALESCE(us.is_fired, 0) AS is_fired,
        COALESCE(a.deliver_reminder_count, 0) AS reminder_count
     FROM assignments a
     LEFT JOIN usersdb.users u ON u.id = a.user_id
     LEFT JOIN usersdb.user_stores us ON us.user_id = a.user_id AND us.store_id = ?
     WHERE a.status = 'completed'
       AND a.completed_at IS NOT NULL
       AND a.completed_at < ?
       AND a.earnings_revoked_at IS NULL
       AND a.order_id IN (${placeholders})`,
    storeId, cutoff, ...orderIds
  );

  if (!completedAssignments.length) {
    console.log(`[REMINDER][store ${storeId}] Нет заказов, требующих напоминания`);
    return { found: 0, sent: 0, revoked: 0 };
  }

  console.log(
    `[REMINDER][store ${storeId}] Найдено ${completedAssignments.length} заказов ` +
    `(порог обнуления — ${revokeDays} дн.)`
  );
  let sent = 0;
  let revoked = 0;

  for (const assignment of completedAssignments) {
    const {
      order_id: orderId,
      user_id: userId,
      completed_at: completedAt,
      deliver_reminder_sent_at: sentAt,
      user_name: userName,
      is_fired: isFired,
      reminder_count: reminderCount,
    } = assignment;

    const daysPassed = Math.max(
      0,
      Math.floor((Date.now() - Number(completedAt)) / (24 * 60 * 60 * 1000))
    );

    // --- 3-й шаг: обнуляем заработок ---
    if (daysPassed >= revokeDays) {
      try {
        const result = await EarningsService.revokeOrderEarnings(storeId, userId, orderId, {
          reason: `Заказ ${orderId} не отправлен ${daysPassed} дн. — заработок обнулён автоматически`,
          notificationType: 'deliver_earnings_revoked',
          userName: userName || null,
          daysPassed,
          source: 'scheduler.awaitingDeliver',
        });
        if (result.revoked) {
          revoked += 1;
          console.log(
            `[REMINDER][store ${storeId}] Заказ ${orderId}: заработок обнулён (${result.amount} руб.), сотрудник ${userName || userId}`
          );
        }
      } catch (err) {
        console.error(`[REMINDER][store ${storeId}] Не удалось обнулить заработок по заказу ${orderId}:`, err.message);
        NotificationService.logServerError('scheduler.awaitingDeliverRevoke', err, { storeId, orderId, userId });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }

    // Напоминание — не чаще одного раза в сутки
    if (sentAt && Number(sentAt) >= todayStartMs) continue;

    let amount = null;
    try {
      const earningRow = await db.get(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM earnings_history
         WHERE order_id = ? AND user_id = ?`,
        orderId, userId
      );
      amount = Number(earningRow?.total) || 0;
    } catch (err) {
      console.warn(`[REMINDER][store ${storeId}] Не удалось получить заработок заказа ${orderId}:`, err.message);
    }

    let details = null;
    try {
      details = await OzonService.getOrderDetails(storeId, orderId);
    } catch (err) {
      console.warn(`[REMINDER][store ${storeId}] Не удалось получить детали заказа ${orderId}:`, err.message);
    }

    const isFinalWarning = daysPassed >= warnDays;
    const payload = {
      orderId,
      userId,
      userName: userName || null,
      daysPassed,
      amount,
      reminderCount,
      details,
      isFinalWarning,
    };

    let userNotified = false;

    if (!isFired && userId) {
      try {
        await NotificationService.notifyUser(userId, 'deliver_reminder', payload, { storeId });
        userNotified = true;
        sent++;
      } catch (err) {
        console.error(
          `[REMINDER][store ${storeId}] Не удалось отправить напоминание сотруднику ${userName || userId} (${orderId}):`,
          err.message
        );
      }
    }

    try {
      await NotificationService.notifyStaff('deliver_reminder', payload, { storeId });
    } catch (err) {
      console.error(`[REMINDER][store ${storeId}] Не удалось записать напоминание в журнал (${orderId}):`, err.message);
    }

    if (userNotified) {
      try {
        await db.run(
          `UPDATE assignments
           SET deliver_reminder_sent_at = ?,
               deliver_reminder_count = COALESCE(deliver_reminder_count, 0) + 1
           WHERE order_id = ?`,
          Date.now(), orderId
        );
      } catch (err) {
        console.error(`[REMINDER][store ${storeId}] Не удалось пометить напоминание по заказу ${orderId}:`, err.message);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(
    `[REMINDER][store ${storeId}] Отправлено напоминаний: ${sent}, обнулено заработка: ${revoked}`
  );

  try {
    await NotificationService.notifyStaff(
      'deliver_reminder_summary',
      { found: completedAssignments.length, sent, revoked },
      { storeId, push: false }
    );
  } catch (err) {
    console.error(`[REMINDER][store ${storeId}] Не удалось отправить сводку персоналу:`, err.message);
  }

  return { found: completedAssignments.length, sent, revoked };
}

// ============================================================================
//  8. СВЕРКА ОТМЕНЁННЫХ ЗАКАЗОВ (per-store)
// ============================================================================
const cancelledOrdersRunner = createPerStoreDailyRunner({
  name: 'cancelledOrders',
  targetHour: envInt('CANCEL_SYNC_HOUR', 7, 0, 23),
  targetMinute: envInt('CANCEL_SYNC_MINUTE', 30, 0, 59),
  maxAttempts: envInt('CANCEL_SYNC_MAX_ATTEMPTS', 10, 1, 60),
  run: async (storeId) => {
    await runCancelledOrdersEarningsRevocation(storeId, {
      windowHours: envInt('CANCEL_SYNC_WINDOW_HOURS', 48, 1, 24 * 30),
    });
  },
});

function startCancelledOrdersChecker() {
  cancelledOrdersRunner.start();
}
function stopCancelledOrdersChecker() {
  cancelledOrdersRunner.stop();
}

/**
 * Один прогон сверки отменённых заказов ДЛЯ КОНКРЕТНОГО МАГАЗИНА.
 */
async function runCancelledOrdersEarningsRevocation(storeId, options = {}) {
  console.log(`[CANCEL][store ${storeId}] Запуск сверки отменённых заказов...`);

  const db = getStoreDB(storeId);
  const windowHours = options.windowHours != null
    ? options.windowHours
    : envInt('CANCEL_SYNC_WINDOW_HOURS', 48, 1, 24 * 30);

  let orders;
  try {
    orders = await OzonService.fetchCancelledOrders(storeId, 100, windowHours);
  } catch (err) {
    console.error(`[CANCEL][store ${storeId}] Не удалось получить список отменённых заказов:`, err.message);
    throw err;
  }

  if (!Array.isArray(orders)) {
    throw new Error('fetchCancelledOrders() вернул не массив');
  }

  console.log(`[CANCEL][store ${storeId}] Получено ${orders.length} отменённых заказов за ${windowHours} ч`);
  if (!orders.length) return { found: 0, revoked: 0 };

  const orderIds = orders.map((order) => order.posting_number).filter(Boolean);
  if (!orderIds.length) {
    console.log(`[CANCEL][store ${storeId}] В ответе нет posting_number`);
    return { found: 0, revoked: 0 };
  }

  const placeholders = orderIds.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT a.order_id, a.user_id, a.completed_at, u.name AS user_name
     FROM assignments a
     LEFT JOIN usersdb.users u ON u.id = a.user_id
     WHERE a.status = 'completed'
       AND a.earnings_revoked_at IS NULL
       AND a.order_id IN (${placeholders})`,
    ...orderIds
  );

  if (!rows.length) {
    console.log(`[CANCEL][store ${storeId}] Нет завершённых заказов, требующих сторнирования`);
    return { found: 0, revoked: 0 };
  }

  console.log(`[CANCEL][store ${storeId}] Найдено ${rows.length} завершённых заказов с отменой Ozon`);
  let revoked = 0;

  for (const row of rows) {
    const orderId = row.order_id;
    const userId = row.user_id;
    const userName = row.user_name;
    try {
      const result = await EarningsService.revokeOrderEarnings(storeId, userId, orderId, {
        reason: `Заказ ${orderId} отменён Ozon (был завершён, но не отправлен)`,
        notificationType: 'order_cancelled_earnings_revoked',
        userName: userName || null,
        source: 'scheduler.cancelledOrders',
      });
      if (result.revoked) {
        revoked += 1;
        console.log(
          `[CANCEL][store ${storeId}] Заказ ${orderId} отменён — заработок ${result.amount} руб. сторнирован (${userName || userId})`
        );
        try {
          OrderService.forgetOrderState(storeId, orderId);
        } catch (forgetErr) {
          console.warn(`[CANCEL][store ${storeId}] forgetOrderState(${orderId}):`, forgetErr.message);
        }
      }
    } catch (err) {
      console.error(`[CANCEL][store ${storeId}] Не удалось сторнировать заработок по заказу ${orderId}:`, err.message);
      NotificationService.logServerError('scheduler.cancelledOrders', err, { storeId, orderId, userId });
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`[CANCEL][store ${storeId}] Сторнировано заработка по заказам: ${revoked}`);

  try {
    await NotificationService.notifyStaff(
      'cancelled_orders_summary',
      { found: rows.length, revoked, windowHours },
      { storeId, push: false }
    );
  } catch (err) {
    console.error(`[CANCEL][store ${storeId}] Не удалось отправить сводку персоналу:`, err.message);
  }

  return { found: rows.length, revoked };
}

// ============================================================================
//  9. СИНХРОНИЗАЦИЯ СТАТУСОВ КЭША ЗАКАЗОВ (per-store, интервальная)
// ============================================================================
let orderStatusSyncRunner = null;

function startOrderStatusSyncChecker() {
  const intervalMinutes = envInt('ORDER_STATUS_SYNC_INTERVAL_MINUTES', 60, 5, 24 * 60);
  if (orderStatusSyncRunner) orderStatusSyncRunner.stop();

  orderStatusSyncRunner = createPerStoreIntervalRunner({
    name: 'orderStatusSync',
    intervalMs: intervalMinutes * 60 * 1000,
    run: async (storeId) => {
      const result = await OrderService.syncOrderStatuses(storeId);
      if (result.removed || result.photosRemoved) {
        console.log(
          `[SCHEDULER][store ${storeId}] Синхронизация заказов: проверено ${result.checked}, ` +
          `убрано из кэша ${result.removed}, удалено фото ${result.photosRemoved}`
        );
      }
    },
  });
  orderStatusSyncRunner.start();

  console.log(
    `[SCHEDULER] Синхронизация статусов заказов запущена (per-store, каждые ${intervalMinutes} мин.)`
  );
}

function stopOrderStatusSyncChecker() {
  if (orderStatusSyncRunner) {
    orderStatusSyncRunner.stop();
    orderStatusSyncRunner = null;
  }
}

// ============================================================================
//  10. ОБСЛУЖИВАНИЕ 3D-МОДЕЛЕЙ (глобально, ежечасно)
// ============================================================================
let modelsMaintenanceInterval = null;
let isModelsMaintenanceRunning = false;

function startModelsMaintenanceChecker() {
  if (modelsMaintenanceInterval) clearInterval(modelsMaintenanceInterval);
  isModelsMaintenanceRunning = false;

  modelsMaintenanceInterval = setInterval(async () => {
    if (isModelsMaintenanceRunning) return;
    isModelsMaintenanceRunning = true;
    try {
      const removed = StorageService.cleanCache();
      const pruned = await OfferModel.pruneExpiredTokens();
      if (removed || pruned) {
        console.log(
          `[SCHEDULER] Обслуживание моделей: удалено ${removed} файл(ов) кэша, ${pruned} токен(ов)`
        );
      }
      try {
        const sync = await ModelService.syncFromStorage();
        if (sync.registered || sync.updated) {
          console.log(
            `[SCHEDULER] Синхронизация моделей из S3: +${sync.registered} новых, ~${sync.updated} обновлённых из ${sync.found} zip`
          );
        }
      } catch (syncErr) {
        console.error('[SCHEDULER] Ошибка синхронизации моделей из S3:', syncErr.message);
        NotificationService.logServerError('scheduler.modelsSync', syncErr);
      }
    } catch (err) {
      console.error('[SCHEDULER] Ошибка обслуживания моделей:', err.message);
      NotificationService.logServerError('scheduler.modelsMaintenance', err);
    } finally {
      isModelsMaintenanceRunning = false;
    }
  }, 60 * 60 * 1000);

  console.log('[SCHEDULER] Ежечасное обслуживание моделей запущено (кэш + токены + синхронизация S3)');
}

function stopModelsMaintenanceChecker() {
  if (modelsMaintenanceInterval) {
    clearInterval(modelsMaintenanceInterval);
    modelsMaintenanceInterval = null;
  }
  isModelsMaintenanceRunning = false;
}

// ============================================================================
//  11. ОЧИСТКА НЕПОДТВЕРЖДЁННЫХ АККАУНТОВ (глобально, ежечасно)
// ============================================================================
let guestCleanupInterval = null;
let isGuestCleanupRunning = false;

function startGuestCleanupChecker() {
  if (guestCleanupInterval) clearInterval(guestCleanupInterval);
  isGuestCleanupRunning = false;

  const ttlHours = envInt('GUEST_TTL_HOURS', 24, 1, 24 * 30);

  guestCleanupInterval = setInterval(async () => {
    if (isGuestCleanupRunning) return;
    isGuestCleanupRunning = true;
    try {
      const ttl = envInt('GUEST_TTL_HOURS', 24, 1, 24 * 30);
      const result = await AuthService.cleanupGuestAccounts(ttl);
      if (result.deletedUsers || result.deletedCodes) {
        console.log(
          `[SCHEDULER] Очистка неподтверждённых аккаунтов: удалено ${result.deletedUsers} аккаунт(ов), ${result.deletedCodes} просроченных код(ов)`
        );
      }
    } catch (err) {
      console.error('[SCHEDULER] Ошибка очистки неподтверждённых аккаунтов:', err.message);
      NotificationService.logServerError('scheduler.guestCleanup', err);
    } finally {
      isGuestCleanupRunning = false;
    }
  }, 60 * 60 * 1000);

  console.log(
    `[SCHEDULER] Ежечасная очистка неподтверждённых аккаунтов запущена (TTL ${ttlHours} ч)`
  );
}

function stopGuestCleanupChecker() {
  if (guestCleanupInterval) {
    clearInterval(guestCleanupInterval);
    guestCleanupInterval = null;
  }
  isGuestCleanupRunning = false;
}

module.exports = {
  startOrderChecker,
  stopOrderChecker,
  pauseChecker,
  resumeChecker,
  isCheckerPaused,
  startCooldownCleaner,
  stopCooldownCleaner,
  startDailyBackupChecker,
  stopDailyBackupChecker,
  startDailyPromotionCleaner,
  stopDailyPromotionCleaner,
  startMonthlyExportChecker,
  stopMonthlyExportChecker,
  startNotificationsCleanup,
  stopNotificationsCleanup,
  startAwaitingDeliverReminderChecker,
  stopAwaitingDeliverReminderChecker,
  runAwaitingDeliverReminder,
  startCancelledOrdersChecker,
  stopCancelledOrdersChecker,
  runCancelledOrdersEarningsRevocation,
  startOrderStatusSyncChecker,
  stopOrderStatusSyncChecker,
  startModelsMaintenanceChecker,
  stopModelsMaintenanceChecker,
  startGuestCleanupChecker,
  stopGuestCleanupChecker,
};