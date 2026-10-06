/**
 * Smoke-тест сброса пароля по email (запуск: node tests/smoke-password-reset.js из папки backend/).
 * Использует временную БД и стабы вместо реального SMTP, за собой убирает.
 * Проверяет: регистрация -> подтверждение email -> requestPasswordReset
 * (анти-enumeration: несуществующий email и гость — письмо не уходит) ->
 * 6-значный код -> кулдаун -> сброс по неверному коду/короткому паролю отклонён ->
 * успешный сброс -> старый пароль не работает, новый работает ->
 * коды сброса и refresh-токены удалены.
 */

// ВАЖНО: env нужно выставить ДО require database-модуля (он читает DB_PATH при загрузке)
const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'tmp-smoke-password-reset.db');
process.env.BOT_VERSION = '';

const fs = require('fs');
const { initDB, getDB } = require('../src/config/database');
const User = require('../src/models/User');
const PasswordReset = require('../src/models/PasswordReset');
const AuthService = require('../src/services/AuthService');
const EmailService = require('../src/services/EmailService');

// Стабы вместо реального SMTP
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
  if (!caught) throw new Error(`${label}: ожидалась ошибка, но вызов прошёл`);
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
    const db = getDB();

    const username = 'smoke_reset_user';
    const email = 'smoke_reset_user@example.com';
    const guestEmail = 'smoke_reset_guest@example.com';
    // Чистим возможный мусор от прошлого запуска
    await db.run('DELETE FROM users WHERE username = ? OR email IN (?, ?)',
      username, email, guestEmail);
    await db.run(
      'DELETE FROM password_resets WHERE user_id NOT IN (SELECT id FROM users)'
    );

    // 1. Регистрация + подтверждение email -> активный аккаунт
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
    console.log('1. Регистрация + подтверждение + логин: OK');

    // 2. Анти-enumeration: несуществующий email — ответ успешный, письмо не уходит
    const sentBefore = resetCodes.length;
    const unknown = await AuthService.requestPasswordReset('no-such-user@example.com');
    if (unknown.sent !== true) throw new Error('Для несуществующего нужен ответ sent: true');
    if (resetCodes.length !== sentBefore) throw new Error('Письмо ушло для несуществующего email');
    console.log('2. Несуществующий email: тихий no-op (анти-enumeration): OK');

    // 3. Анти-enumeration: гость (email не подтверждён) — письмо не уходит
    const guestReg = await AuthService.register({
      username: 'smoke_reset_guest', email: guestEmail, password: 'secret123', name: 'Guest',
    });
    guestId = guestReg.user.id;
    const guest = await AuthService.requestPasswordReset(guestEmail);
    if (guest.sent !== true) throw new Error('Для гостя нужен ответ sent: true');
    if (resetCodes.length !== sentBefore) throw new Error('Письмо ушло для гостя');
    console.log('3. Гость (неподтверждённый): тихий no-op: OK');

    // 4. Запрос сброса для подтверждённого аккаунта — письмо с 6-значным кодом
    const first = await AuthService.requestPasswordReset(email);
    if (first.sent !== true) throw new Error('Первый запрос сброса не отправлен');
    if (resetCodes.length !== sentBefore + 1) throw new Error('Письмо со сбросом не ушло');
    const code = resetCodes[resetCodes.length - 1];
    if (!/^\d{6}$/.test(code)) throw new Error(`Код не 6-значный: ${code}`);
    console.log(`4. Код сброса отправлен (${code}): OK`);

    // 5. Кулдаун: повторный запрос сразу — без письма, с retryAfterSec
    const cooldown = await AuthService.requestPasswordReset(email);
    if (cooldown.sent !== false) throw new Error('Кулдаун сброса не сработал');
    if (!(cooldown.retryAfterSec > 0)) throw new Error('Не вернулся retryAfterSec');
    if (resetCodes.length !== sentBefore + 1) throw new Error('Письмо ушло вопреки кулдауну');
    console.log('5. Кулдаун повторного запроса: OK');

    // 6. Неверный код и короткий пароль отклоняются (код при этом не сгорает)
    await expectError(
      () => AuthService.resetPassword('000000', 'newSecret456'),
      'Неверный или просроченный код сброса пароля', 'Неверный код'
    );
    await expectError(
      () => AuthService.resetPassword(code, '12345'),
      'Пароль должен содержать минимум 6 символов', 'Короткий пароль'
    );
    console.log('6. Неверный код / короткий пароль отклонены: OK');

    // 7. Успешный сброс: старый пароль перестаёт работать, новый — работает,
    //    коды сброса и refresh-токены удалены
    const result = await AuthService.resetPassword(code, 'newSecret456');
    if (result.success !== true) throw new Error('Сброс не вернул success: true');
    const codesLeft = await db.get(
      'SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?', userId
    );
    if (codesLeft.n !== 0) throw new Error('Коды сброса не удалены после использования');
    const tokensLeft = await db.get(
      'SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ?', userId
    );
    if (tokensLeft.n !== 0) throw new Error('Refresh-токены не отозваны после сброса');
    console.log('7. Сброс выполнен, коды и refresh-токены удалены: OK');

    // 8. Использованный код одноразовован
    await expectError(
      () => AuthService.resetPassword(code, 'anotherSecret789'),
      'Неверный или просроченный код сброса пароля', 'Повторное использование кода'
    );
    console.log('8. Повторное использование кода заблокировано: OK');

    // 9. Логин: старый пароль отклонён, новый — принят
    let oldRejected = false;
    try { await AuthService.login(username, 'secret123'); }
    catch (e) { oldRejected = e.message === 'Invalid credentials'; }
    if (!oldRejected) throw new Error('Старый пароль всё ещё работает');
    const loginAfter = await AuthService.login(username, 'newSecret456');
    if (!loginAfter.accessToken) throw new Error('Новый пароль не работает');
    console.log('9. Старый пароль отклонён, новый принят: OK');

    console.log('=== Smoke-тест пройден ✅ ===');
    process.exitCode = 0;
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    // Чистим за собой: тестовых пользователей и временную БД
    try {
      const db = getDB();
      for (const id of [userId, guestId]) {
        if (!id) continue;
        await db.run('DELETE FROM password_resets WHERE user_id = ?', id);
        await db.run('DELETE FROM refresh_tokens WHERE user_id = ?', id);
        await db.run('DELETE FROM email_verifications WHERE user_id = ?', id);
        try { await db.run('DELETE FROM notifications WHERE user_id = ?', id); } catch (e) { /* нет колонки/таблицы */ }
        await db.run('DELETE FROM users WHERE id = ?', id);
      }
      await db.close();
    } catch (e) { /* БД могла не открыться — не критично */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch (e) { /* нет файла */ }
    }
  }
})();

