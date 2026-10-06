// src/scheduler.js
const { getLocalTime, getLocalDate, getLocalTimestamp } = require('./utils');
const path = require('path');
const { getDB } = require('./config/database');
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
// УСИЛЕННАЯ ЗАЩИТА ОТ ПРОПУСКОВ ПРОВЕРОК (единые правила для всех задач):
//   1) «Догонялка»: интервал тикает часто (минута), а задача запускается при
//      первом тике ПОСЛЕ целевого времени — если сервер был выключен/перезапущен
//      в целевое время, задача выполнится сразу после старта, а не пропадёт
//      до следующих суток.
//   2) Маркер успешного запуска (last...Date / lastExportedMonth) выставляется
//      ТОЛЬКО после успешного выполнения: сбойный день/месяц повторяется на
//      следующем тике.
//   3) Лимит попыток в сутки/месяц (gate): сбойная задача не спамит каждую
//      минуту до конца суток — после N неуспешных попыток сдаётся до следующего
//      дня, а сбой фиксируется в notifications.db (server_errors).
//   4) Guard is...Running у каждой задачи: долгий прогон не наслаивается сам
//      на себя (перекрывающиеся запуски исключены).
//   5) Все сбои журналируются (logServerError) — пропуск проверки не остаётся
//      незамеченным: он виден во вкладке «Ошибки» персонала.
// ============================================================================

/**
 * Безопасный разбор целого числа из .env с допустимым диапазоном:
 * мусорное значение или значение вне диапазона -> значение по умолчанию.
 * @param {string} name - имя переменной окружения
 * @param {number} defaultValue - значение по умолчанию
 * @param {number} [min] - минимум (включительно)
 * @param {number} [max] - максимум (включительно)
 * @returns {number}
 */
function envInt(name, defaultValue, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const value = parseInt(raw, 10);
  if (Number.isNaN(value)) return defaultValue;
  if (min !== undefined && value < min) return defaultValue;
  if (max !== undefined && value > max) return defaultValue;
  return value;
}

/** Ключ текущих суток в локальном времени (например, 'Sat Sep 12 2026'). */
function todayKey() {
  return getLocalDate().toDateString();
}

/** Ключ текущего месяца в локальном времени ('2026-09'). */
function currentMonthKey() {
  const d = getLocalDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * «Привратник» ежедневной задачи: гарантирует один УСПЕШНЫЙ запуск в сутки
 * и ограничивает число повторов после сбоев (защита от бесконечного спама).
 * @param {number} maxAttempts - максимум попыток в сутки после сбоев
 */
function createDailyGate(maxAttempts = 10) {
  let lastSuccessDate = null; // дата последнего УСПЕШНОГО запуска
  let attempts = 0;           // счётчик попыток с момента последнего успеха
  let lastAttemptDate = null; // дата последней попытки (для сброса счётчика)
  return {
    /** Задача уже успешно выполнена сегодня? */
    isDone() {
      return lastSuccessDate === todayKey();
    },
    /** Остались ли попытки сегодня? */
    canAttempt() {
      if (lastAttemptDate !== todayKey()) attempts = 0; // новый день — счётчик обнуляем
      return attempts < maxAttempts;
    },
    onSuccess() {
      lastSuccessDate = todayKey();
      attempts = 0;
    },
    onFailure() {
      attempts += 1;
      lastAttemptDate = todayKey();
    },
  };
}

/**
 * «Привратник» ежемесячной задачи: один УСПЕШНЫЙ запуск за календарный месяц.
 * @param {number} maxAttempts - максимум попыток за месяц после сбоев
 */
function createMonthlyGate(maxAttempts = 10) {
  let lastSuccessMonth = null;
  let attempts = 0;
  return {
    isDone() {
      return lastSuccessMonth === currentMonthKey();
    },
    canAttempt() {
      if (lastSuccessMonth !== currentMonthKey()) attempts = 0;
      return attempts < maxAttempts;
    },
    onSuccess() {
      lastSuccessMonth = currentMonthKey();
      attempts = 0;
    },
    onFailure() {
      attempts += 1;
    },
  };
}

let checkInterval = null;
let isPaused = false;
let isOrderCheckerRunning = false;

/**
 * Запускает периодическую проверку новых заказов из Ozon.
 * Guard isOrderCheckerRunning: если очередной тик наступает, пока предыдущая
 * проверка ещё выполняется (медленный Ozon API), он пропускается —
 * перекрывающиеся запуски исключены.
 */
function startOrderChecker(intervalMinutes, callback) {
  if (checkInterval) clearInterval(checkInterval);
  isOrderCheckerRunning = false;

  const intervalMs = Math.max(1, parseInt(intervalMinutes, 10) || 1) * 60 * 1000;

  checkInterval = setInterval(async () => {
    if (isPaused) return;
    if (isOrderCheckerRunning) {
      console.warn('[SCHEDULER] Предыдущая проверка заказов ещё выполняется — тик пропущен');
      return;
    }
    isOrderCheckerRunning = true;
    console.log(`[SCHEDULER] Проверка заказов в ${getLocalTimestamp()}`);
    try {
      await callback();
    } catch (err) {
      console.error('[SCHEDULER] Ошибка в планировщике:', err);
      NotificationService.logServerError('scheduler.orderChecker', err);
    } finally {
      isOrderCheckerRunning = false;
    }
  }, intervalMs);
}

function stopOrderChecker() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

function pauseChecker() { isPaused = true; }
function resumeChecker() { isPaused = false; }
function isCheckerPaused() { return isPaused; }

// --- Очистка кулдаунов (по аналогии с BOTFILES/scheduler.js) ---
// Кулдауны команд хранятся в памяти процесса (CooldownService) и чистятся
// раз в час; guard isCooldownCleanRunning исключает перекрывающиеся прогоны.
let cooldownCleanInterval = null;
let isCooldownCleanRunning = false;

function startCooldownCleaner() {
  if (cooldownCleanInterval) {
    clearInterval(cooldownCleanInterval);
    cooldownCleanInterval = null;
  }

  isCooldownCleanRunning = false;

  cooldownCleanInterval = setInterval(() => {
    if (isCooldownCleanRunning) {
      console.log('[SCHEDULER] Очистка кулдаунов уже выполняется, пропускаем');
      return;
    }

    isCooldownCleanRunning = true;

    try {
      CooldownService.cleanCooldowns();
    } catch (err) {
      console.error(
        '[SCHEDULER] Ошибка при очистке кулдаунов:',
        err
      );
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

// --- Ежедневный бэкап БД ---
// Было: точное совпадение 00:00 на часовом тике — если сервер был выключен
// или занят в эту минуту, бэкап пропадал до следующих суток.
// Теперь: тик каждую минуту, запуск при первом тике после целевого времени
// (BACKUP_HOUR / BACKUP_MINUTE, по умолчанию 00:00), но не чаще одного раза
// в сутки и не более BACKUP_MAX_ATTEMPTS попыток после сбоев.
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
    if (backupGate.isDone()) return; // сегодня уже успешно

    // «Догонялка»: любой тик после целевого времени, а не точное совпадение.
    const localTime = getLocalTime();
    if (localTime.hours * 60 + localTime.minutes < targetHour * 60 + targetMinute) return;
    if (!backupGate.canAttempt()) return; // попытки на сегодня исчерпаны

    isBackupRunning = true;
    try {
      console.log('[SCHEDULER] Запуск ежедневного автобэкапа БД...');
      await BackupService.createDbBackup();
      backupGate.onSuccess(); // маркер только после успеха
      // Можно отправить уведомление администратору (через WebSocket или email)
    } catch (err) {
      console.error('[SCHEDULER] Ошибка автобэкапа:', err);
      backupGate.onFailure();
      NotificationService.logServerError('scheduler.backup', err);
    } finally {
      isBackupRunning = false;
    }
  }, 60 * 1000);

  console.log(
    `[SCHEDULER] Ежедневный автобэкап запланирован на ${targetHour}:${String(targetMinute).padStart(2, '0')} (с догонялкой после сбоев)`
  );
}
function stopDailyBackupChecker() {
  if (backupInterval) {
    clearInterval(backupInterval);
    backupInterval = null;
  }
}

// --- Очистка акций (ежедневно) ---
let promotionCleanInterval = null;
let isPromotionCleanRunning = false;
let promotionCleanGate = null;

function startDailyPromotionCleaner() {
  if (promotionCleanInterval) {
    clearInterval(promotionCleanInterval);
    promotionCleanInterval = null;
  }

  isPromotionCleanRunning = false;
  promotionCleanGate = createDailyGate(envInt('PROMOTION_CLEAN_MAX_ATTEMPTS', 5, 1, 60));

  const targetHour = envInt('PROMOTION_CLEAN_HOUR', 3, 0, 23);
  const targetMinute = envInt('PROMOTION_CLEAN_MINUTE', 0, 0, 59);

  promotionCleanInterval = setInterval(async () => {
    if (isPromotionCleanRunning) {
      console.log('[SCHEDULER] Очистка акций уже выполняется, пропускаем');
      return;
    }
    if (promotionCleanGate.isDone()) return; // сегодня уже успешно

    // «Догонялка»: запуск при первом тике после целевого времени —
    // сервер, выключенный в 03:00, выполнит очистку сразу после старта.
    const localTime = getLocalTime();
    if (localTime.hours * 60 + localTime.minutes < targetHour * 60 + targetMinute) return;
    if (!promotionCleanGate.canAttempt()) return; // попытки на сегодня исчерпаны

    isPromotionCleanRunning = true;
    try {
      console.log('[SCHEDULER] Запуск ежедневной очистки акций...');
      const progressCallback = (text) => {
        console.log(`[PROMOTION_CLEAN] ${text}`);
        // Можно отправлять уведомления через WebSocket или в лог
      };
      const result = await OzonService.removeAllPromotions(progressCallback);
      console.log(`[SCHEDULER] Очистка акций завершена: ${result.actionsProcessed} акций, ${result.totalProductsRemoved} товаров`);
      promotionCleanGate.onSuccess(); // маркер только после успеха
    } catch (err) {
      console.error('[SCHEDULER] Ошибка очистки акций:', err);
      promotionCleanGate.onFailure();
      NotificationService.logServerError('scheduler.promotionClean', err);
    } finally {
      isPromotionCleanRunning = false;
    }
  }, 60 * 1000); // проверяем каждую минуту

  console.log(`[SCHEDULER] Ежедневная очистка акций запланирована на ${targetHour}:${String(targetMinute).padStart(2, '0')} (с догонялкой после сбоев)`);
}

function stopDailyPromotionCleaner() {
  if (promotionCleanInterval) {
    clearInterval(promotionCleanInterval);
    promotionCleanInterval = null;
  }
  isPromotionCleanRunning = false;
}

// --- Ежемесячный экспорт заработка ---
// Было: тик раз в час, запуск в ПОСЛЕДНИЙ день месяца после 23:00, причём
// экспортировался ПРЕДЫДУЩИЙ месяц (выдавал 23:59 за прошлый месяц и пропадал,
// если сервер был выключен вечером последнего дня).
// Теперь (паритет с бот-версией): запуск при первом тике С 1-ГО числа месяца
// («догонялка» — сервер, выключенный ночью 1-го числа, экспортирует сразу
// после старта), экспорт ЗАВЕРШАЮЩЕГОСЯ (предыдущего) месяца, не чаще одного
// раза за календарный месяц, лимит попыток, guard и запись в журнал персонала.
let monthlyExportInterval = null;
let isMonthlyExportRunning = false;
let monthlyExportGate = null;

function startMonthlyExportChecker() {
  if (monthlyExportInterval) clearInterval(monthlyExportInterval);
  isMonthlyExportRunning = false;
  monthlyExportGate = createMonthlyGate(envInt('MONTHLY_EXPORT_MAX_ATTEMPTS', 10, 1, 60));

  monthlyExportInterval = setInterval(async () => {
    if (isMonthlyExportRunning) return;
    if (monthlyExportGate.isDone()) return; // за этот месяц уже успешно

    // Только с 1-го числа месяца («догонялка» весь день, до 23:59).
    const localDate = getLocalDate();
    if (localDate.getDate() !== 1) return;
    if (!monthlyExportGate.canAttempt()) return; // попытки за месяц исчерпаны

    isMonthlyExportRunning = true;
    try {
      // Завершающийся месяц = предыдущий календарный месяц.
      const prevMonth = new Date(localDate.getFullYear(), localDate.getMonth() - 1, 1);
      const monthStr =
        `${prevMonth.getFullYear()}-` +
        `${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;

      console.log(`[SCHEDULER] Запуск автоматического экспорта за ${monthStr}`);
      const outputPath = await EarningsService.exportMonthlyEarnings(monthStr);

      monthlyExportGate.onSuccess(); // маркер только после успеха

      // Запись в журнал действий персонала (модераторы получат её и live).
      // Без Web Push: итоговая/информационная запись — телефон не будим.
      const baseName = outputPath ? path.basename(outputPath) : null;
      NotificationService.notifyStaff(
        'monthly_export_done',
        {
          month: monthStr,
          file: baseName,
        },
        { push: false }
      );
    } catch (err) {
      console.error('[SCHEDULER] Ошибка автоматического экспорта:', err);
      monthlyExportGate.onFailure();
      NotificationService.logServerError('scheduler.monthlyExport', err);
    } finally {
      isMonthlyExportRunning = false;
    }
  }, 60 * 1000);

  console.log('[SCHEDULER] Ежемесячный экспорт запланирован на 1-е число месяца (с догонялкой после сбоев)');
}

function stopMonthlyExportChecker() {
  if (monthlyExportInterval) {
    clearInterval(monthlyExportInterval);
    monthlyExportInterval = null;
  }
}

// --- Ежедневная очистка notifications.db (ретенция оповещений и ошибок) ---
// Запускается раз в сутки по локальному времени (по умолчанию в 03:00 —
// NOTIFICATIONS_CLEANUP_HOUR / NOTIFICATIONS_CLEANUP_MINUTE):
//   • оповещения старше NOTIFICATIONS_RETENTION_DAYS дней (по умолчанию 7);
//   • ошибки сервера старше SERVER_ERRORS_RETENTION_DAYS дней (по умолчанию 14).
// Если сервер в целевое время был выключен — очистка выполнится при первом
// запуске планировщика после него (но не чаще одного раза в сутки).
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
    if (notificationsCleanupGate.isDone()) return; // сегодня уже успешно

    // «Догонялка»: запуск при первом тике после целевого времени сегодня
    const localTime = getLocalTime();
    const minutesNow = localTime.hours * 60 + localTime.minutes;
    const minutesTarget = targetHour * 60 + targetMinute;
    if (minutesNow < minutesTarget) return;
    if (!notificationsCleanupGate.canAttempt()) return; // попытки на сегодня исчерпаны

    isNotificationsCleanupRunning = true;
    try {
      const notifDays = envInt('NOTIFICATIONS_RETENTION_DAYS', 7, 1, 3650);
      const errorDays = envInt('SERVER_ERRORS_RETENTION_DAYS', 14, 1, 3650);

      const result = await Notification.pruneOld(notifDays, errorDays);
      notificationsCleanupGate.onSuccess(); // маркер только после успеха
      if (result.notifications > 0 || result.errors > 0) {
        console.log(
          `[SCHEDULER] Очистка notifications.db: удалено ${result.notifications} оповещений старше ${notifDays} дн., ${result.errors} ошибок старше ${errorDays} дн.`
        );
      }

      // Заодно чистим «залежавшиеся» подписки Web Push (браузер отписался,
      // устройство выброшено, аккаунт сменился): те, что не использовались
      // PUSH_SUB_RETENTION_DAYS дней. Активные устройства переподписываются при
      // каждом входе в приложение (upsert обновляет last_used_at) и не удаляются.
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
  }, 60 * 1000); // проверка каждую минуту

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
// Ежедневная проверка заказов «ожидает отправки» (awaiting_deliver).
//
// Аналог BOTFILES/scheduler.js -> startAwaitingDeliverReminderChecker, но
// ВМЕСТО сообщений Telegram-бота напоминания отправляются в оповещения:
//   • лично сотруднику, чей заказ завершён, но не отправлен (notifications.db
//     -> audience 'user' + live WebSocket);
//   • копией в журнал действий персоналу (audience 'staff': каждый админ,
//     модератор и Создатель получают свою запись, модераторы — ещё и live).
//
// Правила единой защиты от пропусков:
//   • «Догонялка» — тик каждую минуту, запуск при первом тике ПОСЛЕ целевого
//     времени (DELIVER_REMINDER_HOUR / DELIVER_REMINDER_MINUTE, по умолчанию
//     07:00): сервер, выключенный в целевое время, проверит заказы сразу
//     после старта;
//   • напоминание по заказу отправляется один раз в сутки (маркер
//     deliver_reminder_sent_at обновляется только при успешной отправке);
//   • ежедневно один успешный прогон; сбой повторяется на следующем тике,
//     но не более DELIVER_REMINDER_MAX_ATTEMPTS раз в сутки;
//   • guard isDeliverReminderRunning от перекрывающихся прогонов;
//   • все сбои журналируются в notifications.db (server_errors).
// ============================================================================
let deliverReminderInterval = null;
let isDeliverReminderRunning = false;
let deliverReminderGate = null;

/**
 * Запускает ежедневную проверку заказов в статусе awaiting_deliver.
 * Находит заказы, завершённые более DELIVER_REMINDER_DELAY_HOURS назад,
 * и отправляет напоминание сотруднику и персоналу (один раз на заказ в сутки).
 */
function startAwaitingDeliverReminderChecker() {
  if (deliverReminderInterval) {
    clearInterval(deliverReminderInterval);
    deliverReminderInterval = null;
  }

  isDeliverReminderRunning = false;
  deliverReminderGate = createDailyGate(envInt('DELIVER_REMINDER_MAX_ATTEMPTS', 10, 1, 60));

  const targetHour = envInt('DELIVER_REMINDER_HOUR', 7, 0, 23);
  const targetMinute = envInt('DELIVER_REMINDER_MINUTE', 0, 0, 59);

  deliverReminderInterval = setInterval(async () => {
    if (isDeliverReminderRunning) return;
    if (deliverReminderGate.isDone()) return; // сегодня уже успешно

    // «Догонялка»: любой тик после целевого времени, а не точное совпадение.
    const localTime = getLocalTime();
    if (localTime.hours * 60 + localTime.minutes < targetHour * 60 + targetMinute) return;
    if (!deliverReminderGate.canAttempt()) return; // попытки на сегодня исчерпаны

    isDeliverReminderRunning = true;
    try {
      const delayHours = envInt('DELIVER_REMINDER_DELAY_HOURS', 24, 1, 24 * 30);
      await runAwaitingDeliverReminder(delayHours);
      deliverReminderGate.onSuccess(); // маркер только после успешного прогона
    } catch (err) {
      console.error('[SCHEDULER] Ошибка напоминаний awaiting_deliver:', err);
      deliverReminderGate.onFailure();
      NotificationService.logServerError('scheduler.awaitingDeliverReminder', err);
    } finally {
      isDeliverReminderRunning = false;
    }
  }, 60 * 1000);

  console.log(
    `[SCHEDULER] Проверка awaiting_deliver запланирована на ` +
    `${targetHour}:${String(targetMinute).padStart(2, '0')} (с догонялкой после сбоев)`
  );
}

/**
 * Один прогон проверки awaiting_deliver.
 *
 * Три шага по возрасту заказа (сколько ПОЛНЫХ дней прошло с завершения):
 *   1) daysPassed >= 1 — напоминание №1;
 *   2) daysPassed >= warnDays (по умолчанию 2) — напоминание №2 + ПРЕДУПРЕЖДЕНИЕ,
 *      что завтра заказ будет снят, а заработок обнулён;
 *   3) daysPassed >= revokeDays (по умолчанию 3) — заработок за заказ обнуляется
 *      сторнирующей корректировкой + итоговое оповещение (см.
 *      EarningsService.revokeOrderEarnings — идемпотентно, без двойных списаний).
 * Напоминание по заказу отправляется не чаще одного раза в сутки
 * (маркер deliver_reminder_sent_at), а обнуление заработка — строго один раз
 * (замок assignments.earnings_revoked_at).
 *
 * @param {number} delayHours - минимальный возраст заказа (с момента завершения)
 * @param {object} [options] - warnDays/revokeDays (для тестов; иначе из .env)
 */
async function runAwaitingDeliverReminder(delayHours, options = {}) {
  console.log('[REMINDER] Запуск проверки awaiting_deliver...');

  const db = getDB();
  const warnDays = options.warnDays != null
    ? options.warnDays
    : envInt('DELIVER_REMINDER_WARN_DAYS', 2, 1, 60);
  const revokeDays = options.revokeDays != null
    ? options.revokeDays
    : envInt('DELIVER_REMINDER_REVOKE_DAYS', 3, 1, 90);

  // 1. Список заказов в статусе awaiting_deliver из Ozon.
  let orders;
  try {
    orders = await OzonService.fetchAwaitingDeliverOrders();
  } catch (err) {
    console.error('[REMINDER] Не удалось получить список заказов:', err.message);
    throw err; // проброс: планировщик не должен считать прогон успешным
  }

  if (!Array.isArray(orders)) {
    throw new Error('fetchAwaitingDeliverOrders() вернул не массив');
  }

  console.log(`[REMINDER] Получено ${orders.length} заказов в awaiting_deliver`);
  if (!orders.length) return { found: 0, sent: 0, revoked: 0 };

  const orderIds = orders.map((order) => order.posting_number).filter(Boolean);
  if (!orderIds.length) {
    console.log('[REMINDER] В ответе нет posting_number');
    return { found: 0, sent: 0, revoked: 0 };
  }

  // 2. Кандидаты: завершённые назначения по этим заказам, старше delayHours и
  //    ещё НЕ сторнированные. Отбор «сегодня уже напоминали» делаем в JS: для
  //    заказов, дошедших до порога обнуления, прошлое напоминание не мешает
  //    списать заработок.
  const placeholders = orderIds.map(() => '?').join(',');
  const cutoff = Date.now() - delayHours * 60 * 60 * 1000;

  const todayStart = getLocalDate();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  const completedAssignments = await db.all(
    `SELECT
        a.order_id,
        a.user_id,
        a.completed_at,
        a.deliver_reminder_sent_at,
        u.name AS user_name,
        u.is_fired,
        COALESCE(a.deliver_reminder_count, 0) AS reminder_count
     FROM assignments a
     JOIN users u ON a.user_id = u.id
     WHERE a.status = 'completed'
       AND a.completed_at IS NOT NULL
       AND a.completed_at < ?
       AND a.earnings_revoked_at IS NULL
       AND a.order_id IN (${placeholders})`,
    cutoff, ...orderIds
  );

  if (!completedAssignments.length) {
    console.log('[REMINDER] Нет заказов, требующих напоминания');
    return { found: 0, sent: 0, revoked: 0 };
  }

  console.log(`[REMINDER] Найдено ${completedAssignments.length} заказов (порог обнуления — ${revokeDays} дн.)`);
  let sent = 0;
  let revoked = 0;

  // 3. Обработка каждого проблемного заказа.
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

    // --- 3-й шаг: заказ слишком долго «ожидает отправки» -> обнуляем заработок ---
    if (daysPassed >= revokeDays) {
      try {
        const result = await EarningsService.revokeOrderEarnings(userId, orderId, {
          reason: `Заказ ${orderId} не отправлен ${daysPassed} дн. — заработок обнулён автоматически`,
          notificationType: 'deliver_earnings_revoked',
          userName: userName || null,
          daysPassed,
          source: 'scheduler.awaitingDeliver',
        });
        if (result.revoked) {
          revoked += 1;
          console.log(
            `[REMINDER] Заказ ${orderId}: заработок обнулён (${result.amount} руб.), сотрудник ${userName || userId}`
          );
        }
      } catch (err) {
        console.error(`[REMINDER] Не удалось обнулить заработок по заказу ${orderId}:`, err.message);
        NotificationService.logServerError('scheduler.awaitingDeliverRevoke', err, { orderId, userId });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }

    // Напоминание по заказу — не чаще одного раза в сутки.
    if (sentAt && Number(sentAt) >= todayStartMs) continue;

    // --- 1-2-й шаг: напоминание (второе — с предупреждением об обнулении) ---
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
      console.warn(`[REMINDER] Не удалось получить заработок заказа ${orderId}:`, err.message);
    }

    // Детали заказа (товары — для текста оповещения и поиска по offer_id).
    let details = null;
    try {
      details = await OzonService.getOrderDetails(orderId);
    } catch (err) {
      console.warn(`[REMINDER] Не удалось получить детали заказа ${orderId}:`, err.message);
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

    // 3a. Сотруднику (не уволенному) — личное оповещение + WebSocket.
    if (!isFired && userId) {
      try {
        await NotificationService.notifyUser(userId, 'deliver_reminder', payload);
        userNotified = true;
        sent++;
      } catch (err) {
        console.error(`[REMINDER] Не удалось отправить напоминание сотруднику ${userName || userId} (${orderId}):`, err.message);
      }
    }

    // 3b. Копия в журнал действий персоналу (админы/модераторы/Создатель).
    try {
      await NotificationService.notifyStaff('deliver_reminder', payload);
    } catch (err) {
      console.error(`[REMINDER] Не удалось записать напоминание в журнал персонала (${orderId}):`, err.message);
    }

    // 3c. Маркер ставится ТОЛЬКО при доставке хотя бы одному получателю:
    // сбойный заказ повторится на следующем суточном прогоне.
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
        console.error(`[REMINDER] Не удалось пометить напоминание по заказу ${orderId}:`, err.message);
      }
    }

    // Пауза между заказами, чтобы не заливать получателей пачкой.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`[REMINDER] Отправлено напоминаний сотрудникам: ${sent}, обнулено заработка: ${revoked}`);

  // 4. Итог проверки — запись в журнал действий персонала.
  try {
    // Без Web Push: сводка для архива — сотрудникам уже ушли личные пуши.
    await NotificationService.notifyStaff(
      'deliver_reminder_summary',
      {
        found: completedAssignments.length,
        sent,
        revoked,
      },
      { push: false }
    );
  } catch (err) {
    console.error('[REMINDER] Не удалось отправить сводку персоналу:', err.message);
  }

  return { found: completedAssignments.length, sent, revoked };
}

function stopAwaitingDeliverReminderChecker() {
  if (deliverReminderInterval) {
    clearInterval(deliverReminderInterval);
    deliverReminderInterval = null;
  }
  isDeliverReminderRunning = false;
}

// ============================================================================
// Ежедневная сверка ОТМЕНЁННЫХ заказов Ozon и сторнирование заработка.
//
// Зачем: сотрудник мог завершить заказ (упаковать), но не отправить его. В
// этом случае заработок уже начислен. Если Ozon затем отменяет заказ
// (автоматически по таймауту либо иначе), заработок нужно снять — иначе мы
// «теряем» заказ, заплатив за неотправленный товар.
//
// Логика: берём список заказов в статусе 'cancelled' из Ozon
// (OzonService.fetchCancelledOrders, окно CANCEL_SYNC_WINDOW_HOURS) и по каждому
// ищем завершённое назначение нашего сотрудника, которое ещё НЕ сторнировано.
// Сторнирование — зарплатная КОРРЕКТИРОВКА на -сумму (см.
// EarningsService.revokeOrderEarnings): если расчёт уже был, удаление истории
// бессмысленно, а корректировка учтётся при следующем расчёте.
//
// ИДЕМПОТЕНТНОСТЬ: сколько бы раз заказ ни попал в выборку (широкое окно,
// повторные прогоны) и что бы ни делал второй планировщик — списание произойдёт
// РОВНО ОДИН РАЗ (атомарный замок assignments.earnings_revoked_at).
//
// Правила единой защиты от пропусков — как у прочих суточных задач
// (догонялка + daily-gate + guard + журнал сбоев).
// ============================================================================
let cancelledOrdersInterval = null;
let isCancelledOrdersRunning = false;
let cancelledOrdersGate = null;

/**
 * Запускает ежедневную сверку отменённых заказов.
 */
function startCancelledOrdersChecker() {
  if (cancelledOrdersInterval) {
    clearInterval(cancelledOrdersInterval);
    cancelledOrdersInterval = null;
  }

  isCancelledOrdersRunning = false;
  cancelledOrdersGate = createDailyGate(envInt('CANCEL_SYNC_MAX_ATTEMPTS', 10, 1, 60));

  const targetHour = envInt('CANCEL_SYNC_HOUR', 7, 0, 23);
  const targetMinute = envInt('CANCEL_SYNC_MINUTE', 30, 0, 59);

  cancelledOrdersInterval = setInterval(async () => {
    if (isCancelledOrdersRunning) return;
    if (cancelledOrdersGate.isDone()) return; // сегодня уже успешно

    // «Догонялка»: любой тик после целевого времени, а не точное совпадение.
    const localTime = getLocalTime();
    if (localTime.hours * 60 + localTime.minutes < targetHour * 60 + targetMinute) return;
    if (!cancelledOrdersGate.canAttempt()) return; // попытки на сегодня исчерпаны

    isCancelledOrdersRunning = true;
    try {
      await runCancelledOrdersEarningsRevocation({
        windowHours: envInt('CANCEL_SYNC_WINDOW_HOURS', 48, 1, 24 * 30),
      });
      cancelledOrdersGate.onSuccess(); // маркер только после успешного прогона
    } catch (err) {
      console.error('[SCHEDULER] Ошибка сверки отменённых заказов:', err);
      cancelledOrdersGate.onFailure();
      NotificationService.logServerError('scheduler.cancelledOrders', err);
    } finally {
      isCancelledOrdersRunning = false;
    }
  }, 60 * 1000);

  console.log(
    `[SCHEDULER] Сверка отменённых заказов запланирована на ` +
    `${targetHour}:${String(targetMinute).padStart(2, '0')} (с догонялкой после сбоев)`
  );
}

/**
 * Один прогон сверки отменённых заказов.
 * @param {object} [options]
 * @param {number} [options.windowHours] - глубина окна выборки (часы)
 * @returns {Promise<{found:number, revoked:number}>}
 */
async function runCancelledOrdersEarningsRevocation(options = {}) {
  console.log('[CANCEL] Запуск сверки отменённых заказов...');

  const db = getDB();
  const windowHours = options.windowHours != null
    ? options.windowHours
    : envInt('CANCEL_SYNC_WINDOW_HOURS', 48, 1, 24 * 30);

  // 1. Список отменённых заказов из Ozon.
  let orders;
  try {
    orders = await OzonService.fetchCancelledOrders(100, windowHours);
  } catch (err) {
    console.error('[CANCEL] Не удалось получить список отменённых заказов:', err.message);
    throw err; // проброс: планировщик не должен считать прогон успешным
  }

  if (!Array.isArray(orders)) {
    throw new Error('fetchCancelledOrders() вернул не массив');
  }

  console.log(`[CANCEL] Получено ${orders.length} отменённых заказов за ${windowHours} ч`);
  if (!orders.length) return { found: 0, revoked: 0 };

  const orderIds = orders.map((order) => order.posting_number).filter(Boolean);
  if (!orderIds.length) {
    console.log('[CANCEL] В ответе нет posting_number');
    return { found: 0, revoked: 0 };
  }

  // 2. Завершённые сотрудником заказы, по которым заработок ещё не сторнирован.
  const placeholders = orderIds.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT a.order_id, a.user_id, a.completed_at, u.name AS user_name
     FROM assignments a
     JOIN users u ON a.user_id = u.id
     WHERE a.status = 'completed'
       AND a.earnings_revoked_at IS NULL
       AND a.order_id IN (${placeholders})`,
    ...orderIds
  );

  if (!rows.length) {
    console.log('[CANCEL] Нет завершённых заказов, требующих сторнирования');
    return { found: 0, revoked: 0 };
  }

  console.log(`[CANCEL] Найдено ${rows.length} завершённых заказов с отменой Ozon`);
  let revoked = 0;

  for (const row of rows) {
    const orderId = row.order_id;
    const userId = row.user_id;
    const userName = row.user_name;
    try {
      const result = await EarningsService.revokeOrderEarnings(userId, orderId, {
        reason: `Заказ ${orderId} отменён Ozon (был завершён, но не отправлен)`,
        notificationType: 'order_cancelled_earnings_revoked',
        userName: userName || null,
        source: 'scheduler.cancelledOrders',
      });
      if (result.revoked) {
        revoked += 1;
        console.log(
          `[CANCEL] Заказ ${orderId} отменён — заработок ${result.amount} руб. сторнирован (${userName || userId})`
        );
        // Снимок заказа в кэше больше не нужен: заказ вышел из «живых» статусов.
        try {
          OrderService.forgetOrderState(orderId);
        } catch (forgetErr) {
          console.warn(`[CANCEL] forgetOrderState(${orderId}):`, forgetErr.message);
        }
      }
    } catch (err) {
      console.error(`[CANCEL] Не удалось сторнировать заработок по заказу ${orderId}:`, err.message);
      NotificationService.logServerError('scheduler.cancelledOrders', err, { orderId, userId });
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`[CANCEL] Сторнировано заработка по заказам: ${revoked}`);

  // 3. Итог — запись в журнал действий персонала (без Web Push).
  try {
    await NotificationService.notifyStaff(
      'cancelled_orders_summary',
      { found: rows.length, revoked, windowHours },
      { push: false }
    );
  } catch (err) {
    console.error('[CANCEL] Не удалось отправить сводку персоналу:', err.message);
  }

  return { found: rows.length, revoked };
}

function stopCancelledOrdersChecker() {
  if (cancelledOrdersInterval) {
    clearInterval(cancelledOrdersInterval);
    cancelledOrdersInterval = null;
  }
  isCancelledOrdersRunning = false;
}

// ============================================================================
// Ежечасная синхронизация статусов кэша заказов (2 запроса к Ozon).
//
// Зачем: вкладки «📮 Активные» и «🗳️ Завершённые» страницы «Мои заказы»
// строятся по серверному кэшу состояния заказов (state.orderStateCache), а
// фотографии товаров живут, пока заказ в awaiting_packaging / awaiting_deliver.
// Раз в час двумя запросами получаем списки заказов в этих двух статусах:
//   • заказ есть в списке -> обновляем сохранённый статус;
//   • заказа нет ни в одном списке (отправлен/отменён/возврат) -> убираем снимок
//     из кэша и чистим фотографии его артикулов (если их не использует другой
//     заказ) — карточка исчезает из «Завершённых заказов».
// Та же операция запускается кнопкой «Обновить» на странице заказов.
// ============================================================================
let orderStatusSyncInterval = null;
let isOrderStatusSyncRunning = false;

function startOrderStatusSyncChecker() {
  if (orderStatusSyncInterval) clearInterval(orderStatusSyncInterval);
  isOrderStatusSyncRunning = false;

  const intervalMinutes = envInt('ORDER_STATUS_SYNC_INTERVAL_MINUTES', 60, 5, 24 * 60);

  orderStatusSyncInterval = setInterval(async () => {
    if (isOrderStatusSyncRunning) return;
    isOrderStatusSyncRunning = true;
    try {
      const result = await OrderService.syncOrderStatuses();
      if (result.removed || result.photosRemoved) {
        console.log(
          `[SCHEDULER] Синхронизация заказов: проверено ${result.checked}, ` +
          `убрано из кэша ${result.removed}, удалено фото ${result.photosRemoved}`
        );
      }
    } catch (err) {
      console.error('[SCHEDULER] Ошибка синхронизации статусов заказов:', err.message);
      NotificationService.logServerError('scheduler.orderStatusSync', err);
    } finally {
      isOrderStatusSyncRunning = false;
    }
  }, intervalMinutes * 60 * 1000);

  console.log(
    `[SCHEDULER] Синхронизация статусов заказов запущена (каждые ${intervalMinutes} мин.)`
  );
}

function stopOrderStatusSyncChecker() {
  if (orderStatusSyncInterval) {
    clearInterval(orderStatusSyncInterval);
    orderStatusSyncInterval = null;
  }
  isOrderStatusSyncRunning = false;
}

// ============================================================================
// Обслуживание 3D-моделей (ежечасно, дешёвые идемпотентные операции):
//   • чистка просроченного локального кэша zip (models-cache/, TTL —
//     MODELS_CACHE_TTL_MIN, по умолчанию 1 час) — StorageService.cleanCache();
//   • удаление использованных и просроченных одноразовых токенов скачивания —
//     OfferModel.pruneExpiredTokens();
//   • синхронизация S3 -> offer_models: метаданные всех zip в бакете
//     upsert'ятся (ListObjectsV2 отдаёт ETag/size/lastModified без скачивания
//     тела): zip, залитые мимо приложения, регистрируются и становятся доступны
//     при выдаче, а у изменённых (новый ETag) сбрасывается устаревший локальный
//     кэш и сотрудникам уходит model_updated — ModelService.syncFromStorage().
//     Сбой S3 не отменяет чистку кэша/токенов (отдельный try).
// В отличие от суточных задач здесь не нужен daily-gate: операция лёгкая,
// и пропуск тика не является проблемой (кэш просто живёт дольше на час).
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
      // Синхронизация S3 -> offer_models (отдельный try: недоступность S3
      // не должна маскировать результат чистки кэша/токенов выше).
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
  }, 60 * 60 * 1000); // ежечасно

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
// Очистка неподтверждённых аккаунтов (ежечасно, дешёвая идемпотентная операция):
//   • гости (role = 'guest' — зарегистрировались, но не ввели код из письма)
//     удаляются целиком вместе с кодами подтверждения, refresh-токенами и
//     связями со складами, если не подтвердили email более GUEST_TTL_HOURS
//     часов (по умолчанию 24) — AuthService.cleanupGuestAccounts();
//   • заодно вычищаются все просроченные коды подтверждения.
// Гость при регистрации создаётся как is_fired = 1 / taking_orders = 0
// (в команде не числится), поэтому до удаления он нигде не виден.
// Как и у обслуживания моделей, daily-gate здесь не нужен: операция лёгкая.
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
  }, 60 * 60 * 1000); // ежечасно

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