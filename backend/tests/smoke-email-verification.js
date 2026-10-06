/**
 * Smoke-тест подтверждения email (запуск: node tests/smoke-email-verification.js из папки backend/).
 * Использует временную БД и стаб вместо реального SMTP, за собой убирает.
 * Проверяет: регистрация -> роль guest (is_fired = 1, вне списков персонала) ->
 * блокировка логина -> кулдаун повторной отправки -> resend -> повторная регистрация
 * тем же логином/email до подтверждения (замена гостя + новый код) -> верный код ->
 * роль user + email_verified + активность -> логин -> защита подтверждённых логина/email.
 */

// ВАЖНО: env нужно выставить ДО require database-модуля (он читает DB_PATH/BOT_VERSION при загрузке)
const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'tmp-smoke-email.db');
process.env.BOT_VERSION = '';

const fs = require('fs');
const { initDB, getDB } = require('../src/config/database');
const User = require('../src/models/User');
const AuthService = require('../src/services/AuthService');
const EmailService = require('../src/services/EmailService');

// Стаб вместо реального SMTP: перехватываем код подтверждения
let lastSentCode = null;
let sentCount = 0;
EmailService.sendVerificationEmail = async (email, name, code) => {
  lastSentCode = code;
  sentCount += 1;
  console.log(`[Стаб Email] Код ${code} -> ${email}`);
  return { messageId: 'stub' };
};

(async () => {
  let createdUserId = null;
  try {
    console.log('=== Smoke-тест подтверждения email ===');
    await initDB();
    const db = getDB();

    const username = 'smoke_verify_user';
    const email = 'smoke_verify_user@example.com';
    // Чистим возможный мусор от прошлого запуска
    await db.run('DELETE FROM users WHERE username = ? OR email = ?', username, email);

    // 0. Минимальная валидация регистрационных данных
    const badLogin = AuthService.validateRegisterData({ username: 'abc12', email: 'a@b.ru', password: 'secret123' });
    const badEmail = AuthService.validateRegisterData({ username: 'abcdef', email: 'not-an-email', password: 'secret123' });
    const badPass = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: '12345' });
    const capZero = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: 'secret123', capacity: 0 });
    const capOver = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: 'secret123', capacity: 100 });
    const capNeg = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: 'secret123', capacity: -1 });
    const capFrac = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: 'secret123', capacity: 2.5 });
    const okOne = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: 'secret123', capacity: 1 });
    const okStr99 = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: 'secret123', capacity: '99' });
    const okNoCap = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: 'secret123' });
    console.log('0. Валидация: логин/Email/пароль/cap0/cap100/cap-1/cap2.5 отклонены:',
      badLogin.length === 1 && badEmail.length === 1 && badPass.length === 1 &&
      capZero.length === 1 && capOver.length === 1 && capNeg.length === 1 && capFrac.length === 1);
    console.log('   Валидация: cap 1 / "99" / без capacity приняты:',
      okOne.length === 0 && okStr99.length === 0 && okNoCap.length === 0);
    if (badLogin.length !== 1 || badEmail.length !== 1 || badPass.length !== 1 ||
        capZero.length !== 1 || capOver.length !== 1 || capNeg.length !== 1 || capFrac.length !== 1 ||
        okOne.length !== 0 || okStr99.length !== 0 || okNoCap.length !== 0) {
      throw new Error('Валидация регистрационных данных работает неверно');
    }

    // 1. Регистрация: роль guest, код отправлен, без capacity -> дефолт 1.
    // Гость НЕ состоит в команде: is_fired = 1, приём заказов выключен,
    // в списках персонала (User.getAll) его нет ни с какими фильтрами
    const registration = await AuthService.register({
      username, email, password: 'secret123', name: 'Smoke Test',
    });
    const user = registration.user;
    createdUserId = user.id;
    console.log('1. Регистрация: role =', user.role, ', capacity =', user.capacity,
      ', is_fired =', user.is_fired, ', taking_orders =', user.taking_orders);
    if (user.role !== 'guest') throw new Error('Ожидалась роль guest');
    if (user.capacity !== 1) throw new Error('Дефолтный capacity должен быть 1');
    if (user.is_fired !== 1) throw new Error('Гость должен быть is_fired = 1');
    if (user.taking_orders !== 0) throw new Error('Гость не должен принимать заказы');
    if (registration.resent) throw new Error('Первая регистрация не должна считаться повторной');
    if (!lastSentCode) throw new Error('Код не отправлен');

    const visibleAfterRegister = await User.getAll({ includeFired: true, includeAll: true });
    if (visibleAfterRegister.some((u) => u.id === user.id)) {
      throw new Error('Гость виден в списке пользователей (должен быть скрыт везде)');
    }
    console.log('1a. Гость скрыт из списка пользователей:', true);

    // 2. Логин до подтверждения запрещён
    let blocked = false;
    try {
      await AuthService.login(username, 'secret123');
    } catch (e) {
      blocked = e.message === 'Email not verified';
    }
    console.log('2. Логин гостя заблокирован:', blocked);
    if (!blocked) throw new Error('Логин гостя не заблокирован');

    // 3. Неверный код отклоняется
    let wrongRejected = false;
    try {
      await AuthService.verifyEmail(lastSentCode === '000000' ? '111111' : '000000');
    } catch (e) {
      wrongRejected = e.message === 'Неверный или просроченный код';
    }
    console.log('3. Неверный код отклонён:', wrongRejected);
    if (!wrongRejected) throw new Error('Неверный код принят');

    // 4. Антифлуд: повторная отправка сразу после регистрации — no-op
    //    (кулдаун RESEND_CODE_COOLDOWN_SEC), письмо не уходит
    const sentBeforeCooldown = sentCount;
    const immediateResend = await AuthService.resendCode(email);
    console.log('4. Повторная отправка в кулдауне: sent =', immediateResend.sent,
      ', retryAfterSec =', immediateResend.retryAfterSec);
    if (immediateResend.sent !== false) throw new Error('Кулдаун повторной отправки не работает');
    if (sentCount !== sentBeforeCooldown) throw new Error('Письмо ушло вопреки кулдауну');
    if (!(immediateResend.retryAfterSec > 0)) throw new Error('Не вернулся retryAfterSec');

    // 4a. «Старим» код на 61 секунду: отправка разрешена, новый код отправлен,
    //     старый перестаёт действовать
    const oldCode = lastSentCode;
    await db.run(
      'UPDATE email_verifications SET created_at = ? WHERE user_id = ?',
      Date.now() - 61000, createdUserId
    );
    const resendAfterCooldown = await AuthService.resendCode(email);
    if (resendAfterCooldown.sent !== true) throw new Error('Отправка после кулдауна не сработала');
    if (lastSentCode === oldCode) throw new Error('Новый код не сгенерирован');
    let oldRejected = false;
    try {
      await AuthService.verifyEmail(oldCode);
    } catch (e) {
      oldRejected = true;
    }
    console.log('4a. Resend после кулдауна: старый код недействителен:', oldRejected);
    if (!oldRejected) throw new Error('Старый код всё ещё действует');

    // 5. Повторная регистрация тем же логином/email ДО подтверждения:
    //    гостевую запись заменяем и отправляем новый код (resent = true)
    const secondRegistration = await AuthService.register({
      username, email, password: 'secret123', name: 'Smoke Test',
    });
    const reRegistered = secondRegistration.user;
    console.log('5. Повторная регистрация: resent =', secondRegistration.resent,
      ', role =', reRegistered.role, ', код отправлен заново:', lastSentCode !== oldCode);
    if (!secondRegistration.resent) throw new Error('Повторная регистрация не распознана');
    if (reRegistered.role !== 'guest') throw new Error('После повторной регистрации ожидался guest');
    if (reRegistered.is_fired !== 1 || reRegistered.taking_orders !== 0) {
      throw new Error('Повторно созданный гость должен быть вне команды');
    }
    if (reRegistered.id === user.id) throw new Error('Гостевая запись не заменена');
    if (lastSentCode === oldCode) throw new Error('Код не отправлен повторно');
    const sameIdentity = await db.all(
      'SELECT id FROM users WHERE username = ? OR email = ?', username, email
    );
    if (sameIdentity.length !== 1) throw new Error('Осталось несколько записей под одним логином/email');
    createdUserId = reRegistered.id;

    // 6. Верный код -> роль user, is_fired = 0, приём заказов включён,
    //    email_verified = 1, все коды удалены, пользователь снова виден в списке
    const verified = await AuthService.verifyEmail(lastSentCode);
    const fresh = await User.getById(createdUserId);
    console.log('6. Подтверждение: role =', fresh.role, ', email_verified =', verified.email_verified,
      ', is_fired =', fresh.is_fired, ', taking_orders =', fresh.taking_orders);
    if (fresh.role !== 'user') throw new Error('Роль не изменилась на user');
    if (verified.email_verified !== 1) throw new Error('email_verified не установлен');
    if (fresh.is_fired !== 0) throw new Error('Подтверждённый аккаунт должен быть is_fired = 0');
    if (fresh.taking_orders !== 1) throw new Error('Подтверждённому должно вернуться taking_orders = 1');
    const codesLeft = await db.get(
      'SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?', createdUserId
    );
    if (codesLeft.n !== 0) throw new Error('Коды не удалены после подтверждения');
    const visibleAfterVerify = await User.getAll({ includeFired: false, includeAll: true });
    if (!visibleAfterVerify.some((u) => u.id === createdUserId)) {
      throw new Error('Подтверждённый пользователь не виден в списке пользователей');
    }

    // 7. Логин после подтверждения работает
    const loginResult = await AuthService.login(username, 'secret123');
    console.log('7. Логин после подтверждения: OK, role =', loginResult.user.role);
    if (loginResult.user.role !== 'user') throw new Error('Неожиданная роль при логине');

    // 8. Resend для подтверждённого аккаунта — тихий no-op (письмо не уходит)
    const sentBefore = sentCount;
    const resendForVerified = await AuthService.resendCode(email);
    if (sentCount !== sentBefore) throw new Error('Resend для подтверждённого отправил письмо');
    if (resendForVerified.sent !== false) throw new Error('Resend для подтверждённого вернул sent = true');
    console.log('8. Resend для подтверждённого: OK (no-op)');

    // 9. Resend для несуществующего email — тихий no-op (не раскрываем регистрацию)
    await AuthService.resendCode('no-such-user@example.com');
    if (sentCount !== sentBefore) throw new Error('Resend для несуществующего отправил письмо');
    console.log('9. Resend для несуществующего: OK (no-op)');

    // 10. Повторная регистрация на ПОДТВЕРЖДЁННЫЙ логин/email — по-прежнему занято
    let usernameTaken = false;
    try {
      await AuthService.register({ username, email: `other_${email}`, password: 'secret123' });
    } catch (e) {
      usernameTaken = e.message === 'username already taken';
    }
    if (!usernameTaken) throw new Error('Подтверждённый логин не защищён от перезаписи');
    let emailTaken = false;
    try {
      await AuthService.register({ username: `${username}_x`, email, password: 'secret123' });
    } catch (e) {
      emailTaken = e.message === 'email already taken';
    }
    if (!emailTaken) throw new Error('Подтверждённый email не защищён от перезаписи');
    console.log('10. Подтверждённые логин/email не перезаписываются: OK');

    console.log('=== Smoke-тест пройден ✅ ===');
    process.exitCode = 0;
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    // Чистим за собой: тестового пользователя и временную БД
    try {
      const db = getDB();
      if (createdUserId) {
        await db.run('DELETE FROM email_verifications WHERE user_id = ?', createdUserId);
        await db.run('DELETE FROM refresh_tokens WHERE user_id = ?', createdUserId);
        await db.run('DELETE FROM users WHERE id = ?', createdUserId);
      }
      await db.close();
    } catch (e) { /* БД могла не открыться — не критично */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch (e) { /* нет файла */ }
    }
  }
})();
