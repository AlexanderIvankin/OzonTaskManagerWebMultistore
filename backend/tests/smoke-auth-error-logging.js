/**
 * Smoke-тест журналирования сбоя очистки неподтверждённых аккаунтов
 * (запуск: node tests/smoke-auth-error-logging.js из папки backend/).
 * Использует ВРЕМЕННЫЕ БД (основную и notifications.db) и стаб вместо SMTP,
 * за собой убирает (файлы БД удаляются даже при падении теста).
 *
 * Какую регрессию защищает:
 *   Продакшн-порядок загрузки (server.js -> scheduler.js -> OrderService.js ->
 *   NotificationService.js -> socket.js) раньше замыкал цикл require
 *   socket.js -> middlewares/auth.js -> AuthService.js -> NotificationService.js.
 *   Из-за этого AuthService получал ПУСТОЙ (ещё не выполненный) exports
 *   NotificationService, и обработчик сбоя падал с
 *   "TypeError: NotificationService.logServerError is not a function" —
 *   настоящая причина сбоя удаления гостя терялась (в журнале ошибок
 *   оказывался сам TypeError, а источник подменялся на scheduler.guestCleanup).
 *   См. src/config/staffRoles.js (общий модуль ролей разрывает цикл).
 *
 * Проверяет:
 *   • AuthService видит настоящий NotificationService при продакшн-порядке загрузки;
 *   • сбой удаления гостя НЕ роняет очистку наружу (один проблемный гость
 *     не должен ломать всю задачу планировщика);
 *   • сбой попадает в notifications.db -> server_errors с источником
 *     'auth.cleanupGuestAccounts' и РЕАЛЬНОЙ причиной;
 *   • в контексте записи есть диагностика «какие таблицы держат ссылку»
 *     (SQLite в ошибке FK виновника не называет);
 *   • транзакция проблемного гостя откатывается — аккаунт остаётся в БД.
 *
 * Сбой имитируется триггером smoke_fail_user_delete на таблице users:
 * строки ссылающихся таблиц очистка вычищает динамически (PRAGMA), поэтому
 * сбой вызывается на самом DELETE FROM users.
 */

// ВАЖНО: env нужно выставить ДО require database-модулей (они читают пути при загрузке)
const path = require('path');
const fs = require('fs');

const MAIN_DB = path.join(__dirname, '..', 'tmp-smoke-auth-errlog.db');
const NOTIF_DB = path.join(__dirname, '..', 'tmp-smoke-auth-errlog-notifications.db');
process.env.DB_PATH = MAIN_DB;
process.env.NOTIFICATIONS_DB_PATH = NOTIF_DB;
process.env.BOT_VERSION = '';

// ВАЖНО: тот же порядок загрузки, что и в server.js (scheduler тянет OrderService ->
// NotificationService -> socket) — именно он раньше ломал AuthService.
require('../src/scheduler');

const { initDB, getDB } = require('../src/config/database');
const {
  initNotificationsDB,
  getNotificationsDB,
} = require('../src/config/notificationsDatabase');
const User = require('../src/models/User');
const AuthService = require('../src/services/AuthService');
const NotificationService = require('../src/services/NotificationService');
const EmailService = require('../src/services/EmailService');

const HOUR_MS = 60 * 60 * 1000;
const TTL_HOURS = 24;
const TEST_EMAIL = 'errlog_guest@smoke-guests.local';

// Стаб вместо реального SMTP: письмо в тесте не нужно
EmailService.sendVerificationEmail = async (email) => {
  console.log(`[Стаб Email] Письмо -> ${email}`);
  return { messageId: 'stub' };
};

(async () => {
  let failed = false;
  try {
    console.log('=== Smoke-тест журналирования сбоя очистки гостей ===');

    // 0. Продакшн-порядок загрузки не должен ломать ссылку AuthService на сервис
    if (typeof NotificationService.logServerError !== 'function') {
      throw new Error('NotificationService.logServerError не функция (цикл require вернулся)');
    }
    console.log('0. NotificationService.logServerError — функция ✅');

    await initDB();
    await initNotificationsDB();
    const db = getDB();
    const notifDb = getNotificationsDB();

    // Мусор от прошлых запусков (если тест падал, не убравшись)
    await db.run('DELETE FROM users WHERE email = ?', TEST_EMAIL);
    await notifDb.run("DELETE FROM server_errors WHERE source = 'auth.cleanupGuestAccounts'");

    // 1. Гость, который не подтвердил email дольше TTL
    const guest = await AuthService.register({
      username: 'smoke_errlog_guest',
      email: TEST_EMAIL,
      password: 'secret123',
    });
    const old = Date.now() - (TTL_HOURS + 1) * HOUR_MS;
    await db.run(
      'UPDATE users SET created_at = ?, updated_at = ? WHERE id = ?',
      old, old, guest.user.id
    );
    console.log(`1. «Старый» гость #${guest.user.id} создан и состарен (> ${TTL_HOURS} ч)`);

    // 2. Имитация сбоя удаления: триггер запрещает удалять пользователя
    //    (аналог «легаси»-схем, из-за которых DELETE FROM users падает).
    //    Строки ссылающихся таблиц вычищаются динамически, поэтому сбой
    //    вызываем на самом DELETE FROM users.
    await db.run(
      "CREATE TRIGGER IF NOT EXISTS smoke_fail_user_delete " +
      "BEFORE DELETE ON users BEGIN " +
      "SELECT RAISE(ABORT, 'smoke: запрещено удаление пользователя'); END"
    );
    console.log('2. Триггер smoke_fail_user_delete создан — удаление гостя обязано упасть');

    // 3. Сбой одного гостя не должен вылетать наружу (иначе падает вся задача)
    const result = await AuthService.cleanupGuestAccounts(TTL_HOURS);
    if (result.deletedUsers !== 0) {
      throw new Error('Сбойный гость не должен считаться удалённым');
    }
    console.log('3. Очистка отработала без исключения, сбойный гость пропущен');

    // 4. В журнал ошибок попала РЕАЛЬНАЯ причина (а не TypeError про logServerError)
    //    + диагностика: какие таблицы ещё держат ссылку на аккаунт
    const rows = await notifDb.all(
      "SELECT source, message, context FROM server_errors WHERE source = 'auth.cleanupGuestAccounts' ORDER BY id DESC"
    );
    if (!rows.length) {
      throw new Error('Сбой удаления гостя не попал в журнал ошибок (server_errors)');
    }
    if (/logServerError is not a function/.test(rows[0].message)) {
      throw new Error(`В журнал попал TypeError вместо причины: ${rows[0].message}`);
    }
    if (!/запрещено удаление пользователя/i.test(rows[0].message)) {
      throw new Error(`Ожидалась реальная причина сбоя, получено: ${rows[0].message}`);
    }
    if (!/email_verifications\.user_id/.test(String(rows[0].context))) {
      throw new Error(`В контексте нет диагностики «кто держит ссылку»: ${rows[0].context}`);
    }
    console.log(`4. Журнал ошибок: source=${rows[0].source} | message=${rows[0].message}`);
    console.log(`4b. Диагностика в контексте: ${rows[0].context} ✅`);

    // 5. Транзакция гостя откатилась — аккаунт жив
    const alive = await User.getById(guest.user.id);
    if (!alive) {
      throw new Error('Гость удалён, хотя транзакция должна была откатиться (ROLLBACK)');
    }
    console.log('5. Гость остался в БД (ROLLBACK сработал)');

    console.log('=== Smoke-тест пройден ✅ ===');
  } catch (err) {
    failed = true;
    console.error('❌ Smoke-тест не пройден:', err.message);
  } finally {
    // Уборка: закрываем БД и удаляем временные файлы (включая -wal/-shm)
    try { const d = getDB(); if (d) await d.close(); } catch (e) { /* не инициализирована */ }
    try { const n = getNotificationsDB(); if (n) await n.close(); } catch (e) { /* не инициализирована */ }
    for (const f of [
      MAIN_DB, `${MAIN_DB}-wal`, `${MAIN_DB}-shm`,
      NOTIF_DB, `${NOTIF_DB}-wal`, `${NOTIF_DB}-shm`,
    ]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* занят — не критично */ }
    }
    process.exitCode = failed ? 1 : 0;
  }
})();
