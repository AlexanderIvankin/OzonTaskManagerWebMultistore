/**
 * Smoke-тест журналирования сбоя очистки неподтверждённых аккаунтов.
 * Запуск: node tests/smoke-auth-error-logging.js из backend/.
 *
 * Какую регрессию защищает:
 *   Продакшн-порядок загрузки (server.js -> scheduler.js -> OrderService.js ->
 *   NotificationService.js -> socket.js) раньше замыкал цикл require
 *   socket.js -> middlewares/auth.js -> AuthService.js -> NotificationService.js.
 *   Из-за этого AuthService получал ПУСТОЙ (ещё не выполненный) exports
 *   NotificationService, и обработчик сбоя падал с
 *   "TypeError: NotificationService.logServerError is not a function".
 *   См. src/config/staffRoles.js (общий модуль ролей разрывает цикл).
 *
 * MULTISTORE: cleanupGuestAccounts чистит пользователя во ВСЕХ БД
 * (users.db + models.db + все store-N.db). Имитируем сбой на самом
 * DELETE FROM users (триггер): транзакция users.db откатывается, ошибка
 * логируется, обработка продолжается.
 */
const path = require('path');

// ВАЖНО: setup() ДО require('../src/scheduler') — тот тянет цепочку require
const { setup, cleanup } = require('./helpers/setupTestEnv');
setup('1');

// Порядок как в server.js (scheduler тянет OrderService -> NotificationService -> socket)
require('../src/scheduler');

const { initDB, closeAll, getUsersDB } = require('../src/config/database');
const { initNotificationsDB, getNotificationsDB, closeNotificationsDB } = require('../src/config/notificationsDatabase');
const User = require('../src/models/User');
const AuthService = require('../src/services/AuthService');
const NotificationService = require('../src/services/NotificationService');
const EmailService = require('../src/services/EmailService');

EmailService.sendVerificationEmail = async (email) => {
  console.log(`[Стаб Email] Письмо -> ${email}`);
  return { messageId: 'stub' };
};

const HOUR_MS = 60 * 60 * 1000;
const TTL_HOURS = 24;
const TEST_EMAIL = 'errlog_guest@smoke-guests.local';

(async () => {
  let failed = false;
  let guestId = null;
  try {
    console.log('=== Smoke-тест журналирования сбоя очистки гостей ===');

    // 0. Продакшн-порядок загрузки не должен ломать ссылку AuthService на сервис
    if (typeof NotificationService.logServerError !== 'function') {
      throw new Error('NotificationService.logServerError не функция (цикл require вернулся)');
    }
    console.log('0. NotificationService.logServerError — функция ✅');

    await initDB();
    await initNotificationsDB();
    const db = getUsersDB();
    const notifDb = getNotificationsDB();

    await db.run('DELETE FROM users WHERE email = ?', TEST_EMAIL);
    await notifDb.run("DELETE FROM server_errors WHERE source = 'auth.cleanupGuestAccounts'");

    // 1. «Старый» гость
    const guest = await AuthService.register({
      username: 'smoke_errlog_guest',
      email: TEST_EMAIL,
      password: 'secret123',
    });
    guestId = guest.user.id;
    const old = Date.now() - (TTL_HOURS + 1) * HOUR_MS;
    await db.run(
      'UPDATE users SET created_at = ?, updated_at = ? WHERE id = ?',
      old, old, guest.user.id
    );
    console.log(`1. «Старый» гость #${guest.user.id} создан и состарен (> ${TTL_HOURS} ч)`);

    // 2. Триггер запрещает DELETE FROM users
    await db.run(
      "CREATE TRIGGER IF NOT EXISTS smoke_fail_user_delete " +
      "BEFORE DELETE ON users BEGIN " +
      "SELECT RAISE(ABORT, 'smoke: запрещено удаление пользователя'); END"
    );
    console.log('2. Триггер smoke_fail_user_delete создан — удаление гостя обязано упасть');

    // 3. Сбой одного гостя не должен вылетать наружу
    const result = await AuthService.cleanupGuestAccounts(TTL_HOURS);
    if (result.deletedUsers !== 0) {
      throw new Error('Сбойный гость не должен считаться удалённым');
    }
    console.log('3. Очистка отработала без исключения, сбойный гость пропущен');

    // 4. В журнал ошибок попала РЕАЛЬНАЯ причина
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
    console.log(`4. Журнал ошибок: source=${rows[0].source} | message=${rows[0].message}`);

    // 5. Транзакция users.db откатилась — аккаунт жив
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
    // Убираем триггер до очистки данных
    try {
      const db = getUsersDB();
      await db.run("DROP TRIGGER IF EXISTS smoke_fail_user_delete");
      if (guestId) {
        await db.run('DELETE FROM email_verifications WHERE user_id = ?', guestId);
        await db.run('DELETE FROM refresh_tokens WHERE user_id = ?', guestId);
        await db.run('DELETE FROM user_stores WHERE user_id = ?', guestId);
        await db.run('DELETE FROM users WHERE id = ?', guestId);
      }
    } catch (e) { /* ignore */ }
    try { await closeNotificationsDB(); } catch { /* ignore */ }
    try { await closeAll(); } catch { /* ignore */ }
    cleanup();
    process.exitCode = failed ? 1 : 0;
  }
})();