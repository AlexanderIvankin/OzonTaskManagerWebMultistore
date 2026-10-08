/**
 * Smoke-тест сброса пароля по email (запуск: node tests/smoke-password-reset.js).
 * Использует helpers/setupTestEnv + стабы вместо SMTP, за собой убирает.
 */
const { setup, cleanup } = require('./helpers/setupTestEnv');
setup('1');

const { initDB, closeAll, getUsersDB } = require('../src/config/database');
const { initNotificationsDB, closeNotificationsDB } = require('../src/config/notificationsDatabase');
const User = require('../src/models/User');
const AuthService = require('../src/services/AuthService');
const EmailService = require('../src/services/EmailService');

let verifyCode = null;
let resetCodes = [];
EmailService.sendVerificationEmail = async (email, name, code) => {
  verifyCode = code;
  console.log(`[Стаб Email] Код подтверждения ${code} -> ${email}`);
  return { messageId: 'stub' };
};
EmailService.sendPasswordResetEmail = async (email, name, code) => {
  resetCodes.push(code);
  console.log(`[Стаб Email] Код сброса ${code} -> ${email}`);
  return { messageId: 'stub' };
};

const expectError = async (fn, expectedMessage, label) => {
  let caught = null;
  try { await fn(); } catch (e) { caught = e; }
  if (!caught) throw new Error(`${label}: ожидалась ошибка`);
  if (caught.message !== expectedMessage) {
    throw new Error(`${label}: «${caught.message}» вместо «${expectedMessage}»`);
  }
};

(async () => {
  let userId = null;
  let guestId = null;
  try {
    console.log('=== Smoke-тест сброса пароля ===');
    await initDB();
    await initNotificationsDB();
    const db = getUsersDB();

    const username = 'smoke_reset_user';
    const email = 'smoke_reset_user@example.com';
    const guestEmail = 'smoke_reset_guest@example.com';
    await db.run('DELETE FROM users WHERE username = ? OR email IN (?, ?)',
      username, email, guestEmail);

    // 1. Регистрация + подтверждение -> активный аккаунт
    const registration = await AuthService.register({
      username, email, password: 'secret123', name: 'Smoke Reset',
    });
    userId = registration.user.id;
    if (registration.user.role !== 'guest') throw new Error('Ожидалась роль guest');
    await AuthService.verifyEmail(verifyCode);
    const verifiedUser = await User.getById(userId);
    if (verifiedUser.role !== 'user') throw new Error('Роль не изменилась на user');
    const loginBefore = await AuthService.login(username, 'secret123');
    if (!loginBefore.accessToken) throw new Error('Логин до сброса не работает');
    console.log('1. Регистрация + подтверждение + логин ✅');

    // 2. Анти-enumeration: несуществующий email
    const sentBefore = resetCodes.length;
    const unknown = await AuthService.requestPasswordReset('no-such-user@example.com');
    if (unknown.sent !== true) throw new Error('Для несуществующего нужен sent: true');
    if (resetCodes.length !== sentBefore) throw new Error('Письмо ушло для несуществующего');
    console.log('2. Несуществующий email: no-op ✅');

    // 3. Анти-enumeration: гость
    const guestReg = await AuthService.register({
      username: 'smoke_reset_guest', email: guestEmail, password: 'secret123', name: 'Guest',
    });
    guestId = guestReg.user.id;
    const guest = await AuthService.requestPasswordReset(guestEmail);
    if (guest.sent !== true) throw new Error('Для гостя нужен sent: true');
    if (resetCodes.length !== sentBefore) throw new Error('Письмо ушло для гостя');
    console.log('3. Гость: no-op ✅');

    // 4. Запрос сброса для подтверждённого — письмо с 6-значным кодом
    const first = await AuthService.requestPasswordReset(email);
    if (first.sent !== true) throw new Error('Первый запрос не отправлен');
    if (resetCodes.length !== sentBefore + 1) throw new Error('Письмо не ушло');
    const code = resetCodes[resetCodes.length - 1];
    if (!/^\d{6}$/.test(code)) throw new Error(`Код не 6-значный: ${code}`);
    console.log(`4. Код сброса отправлен (${code}) ✅`);

    // 5. Кулдаун
    const cooldown = await AuthService.requestPasswordReset(email);
    if (cooldown.sent !== false) throw new Error('Кулдаун не сработал');
    if (!(cooldown.retryAfterSec > 0)) throw new Error('Не вернулся retryAfterSec');
    if (resetCodes.length !== sentBefore + 1) throw new Error('Письмо ушло вопреки кулдауну');
    console.log('5. Кулдаун ✅');

    // 6. Неверный код / короткий пароль
    await expectError(
      () => AuthService.resetPassword('000000', 'newSecret456'),
      'Неверный или просроченный код сброса пароля', 'Неверный код'
    );
    await expectError(
      () => AuthService.resetPassword(code, '12345'),
      'Пароль должен содержать минимум 6 символов', 'Короткий пароль'
    );
    console.log('6. Неверный код / короткий пароль ✅');

    // 7. Успешный сброс
    const result = await AuthService.resetPassword(code, 'newSecret456');
    if (result.success !== true) throw new Error('Сброс не вернул success: true');
    const codesLeft = await db.get(
      'SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?', userId
    );
    if (codesLeft.n !== 0) throw new Error('Коды сброса не удалены');
    const tokensLeft = await db.get(
      'SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ?', userId
    );
    if (tokensLeft.n !== 0) throw new Error('Refresh-токены не отозваны');
    console.log('7. Сброс выполнен, коды и токены удалены ✅');

    // 8. Одноразовость кода
    await expectError(
      () => AuthService.resetPassword(code, 'anotherSecret789'),
      'Неверный или просроченный код сброса пароля', 'Повторное использование'
    );
    console.log('8. Повторное использование кода заблокировано ✅');

    // 9. Старый пароль не работает, новый работает
    let oldRejected = false;
    try { await AuthService.login(username, 'secret123'); }
    catch (e) { oldRejected = e.message === 'Invalid credentials'; }
    if (!oldRejected) throw new Error('Старый пароль всё ещё работает');
    const loginAfter = await AuthService.login(username, 'newSecret456');
    if (!loginAfter.accessToken) throw new Error('Новый пароль не работает');
    console.log('9. Старый отклонён, новый принят ✅');

    console.log('=== Smoke-тест пройден ✅ ===');
    process.exitCode = 0;
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    try {
      const db = getUsersDB();
      for (const id of [userId, guestId]) {
        if (!id) continue;
        await db.run('DELETE FROM password_resets WHERE user_id = ?', id);
        await db.run('DELETE FROM refresh_tokens WHERE user_id = ?', id);
        await db.run('DELETE FROM email_verifications WHERE user_id = ?', id);
        await db.run('DELETE FROM user_stores WHERE user_id = ?', id);
        await db.run('DELETE FROM users WHERE id = ?', id);
      }
    } catch { /* ignore */ }
    try { await closeNotificationsDB(); } catch { /* ignore */ }
    try { await closeAll(); } catch { /* ignore */ }
    cleanup();
  }
})();