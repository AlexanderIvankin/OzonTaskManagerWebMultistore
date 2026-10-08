/**
 * Smoke-тест подтверждения email (запуск: node tests/smoke-email-verification.js).
 *
 * MULTISTORE: гость НЕ создаётся как «уволенный сотрудник», он просто
 * глобальный users.role='guest' без записи в user_stores. Поэтому проверки
 * «is_fired = 1» заменены на:
 *   • роль = 'guest';
 *   • taking_orders = 0;
 *   • отсутствие записи в user_stores (для магазина из env).
 *
 * Использует helpers/setupTestEnv + стаб вместо SMTP, за собой убирает.
 */
const { setup, cleanup } = require('./helpers/setupTestEnv');
const env = setup('1');
const STORE_ID = env.storeId;

const { initDB, closeAll, getUsersDB } = require('../src/config/database');
const { initNotificationsDB, closeNotificationsDB } = require('../src/config/notificationsDatabase');
const User = require('../src/models/User');
const UserStore = require('../src/models/UserStore');
const AuthService = require('../src/services/AuthService');
const EmailService = require('../src/services/EmailService');

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
    await initNotificationsDB();
    const db = getUsersDB();

    const username = 'smoke_verify_user';
    const email = 'smoke_verify_user@example.com';
    await db.run('DELETE FROM users WHERE username = ? OR email = ?', username, email);

    // 0. Минимальная валидация регистрационных данных
    const badLogin = AuthService.validateRegisterData({ username: 'abc12', email: 'a@b.ru', password: 'secret123' });
    const badEmail = AuthService.validateRegisterData({ username: 'abcdef', email: 'not-an-email', password: 'secret123' });
    const badPass = AuthService.validateRegisterData({ username: 'abcdef', email: 'a@b.ru', password: '12345' });
    if (badLogin.length !== 1 || badEmail.length !== 1 || badPass.length !== 1) {
      throw new Error('Валидация регистрационных данных работает неверно');
    }

    // 1. Регистрация: role='guest', capacity=1, taking_orders=0
    const registration = await AuthService.register({
      username, email, password: 'secret123', name: 'Smoke Test',
    });
    const user = registration.user;
    createdUserId = user.id;
    console.log('1. Регистрация: role =', user.role, ', capacity =', user.capacity,
      ', taking_orders =', user.taking_orders);
    if (user.role !== 'guest') throw new Error('Ожидалась роль guest');
    if (user.capacity !== 1) throw new Error('Дефолтный capacity должен быть 1');
    if (user.taking_orders !== 0) throw new Error('Гость не должен принимать заказы');
    if (registration.resent) throw new Error('Первая регистрация не должна считаться повторной');
    if (!lastSentCode) throw new Error('Код не отправлен');

    // У гостя нет записи в user_stores ни в одном магазине
    const guestStoreRecord = await UserStore.get(user.id, STORE_ID);
    if (guestStoreRecord) throw new Error('У гостя не должно быть записи в user_stores');
    console.log('1a. Записи в user_stores у гостя нет ✅');

    // 2. Логин до подтверждения запрещён
    let blocked = false;
    try { await AuthService.login(username, 'secret123'); }
    catch (e) { blocked = e.message === 'Email not verified'; }
    if (!blocked) throw new Error('Логин гостя не заблокирован');
    console.log('2. Логин гостя заблокирован ✅');

    // 3. Неверный код отклоняется
    let wrongRejected = false;
    try { await AuthService.verifyEmail(lastSentCode === '000000' ? '111111' : '000000'); }
    catch (e) { wrongRejected = e.message === 'Неверный или просроченный код'; }
    if (!wrongRejected) throw new Error('Неверный код принят');
    console.log('3. Неверный код отклонён ✅');

    // 4. Кулдаун повторной отправки
    const sentBeforeCooldown = sentCount;
    const immediateResend = await AuthService.resendCode(email);
    if (immediateResend.sent !== false) throw new Error('Кулдаун не работает');
    if (sentCount !== sentBeforeCooldown) throw new Error('Письмо ушло вопреки кулдауну');
    if (!(immediateResend.retryAfterSec > 0)) throw new Error('Не вернулся retryAfterSec');
    console.log('4. Кулдаун повторной отправки ✅');

    // 4a. После кулдауна — новый код, старый недействителен
    const oldCode = lastSentCode;
    await db.run(
      'UPDATE email_verifications SET created_at = ? WHERE user_id = ?',
      Date.now() - 61000, createdUserId
    );
    const resendAfterCooldown = await AuthService.resendCode(email);
    if (resendAfterCooldown.sent !== true) throw new Error('Отправка после кулдауна не сработала');
    if (lastSentCode === oldCode) throw new Error('Новый код не сгенерирован');
    let oldRejected = false;
    try { await AuthService.verifyEmail(oldCode); } catch { oldRejected = true; }
    if (!oldRejected) throw new Error('Старый код всё ещё действует');
    console.log('4a. Resend после кулдауна ✅');

    // 5. Повторная регистрация до подтверждения — замена гостя
    const secondRegistration = await AuthService.register({
      username, email, password: 'secret123', name: 'Smoke Test',
    });
    const reRegistered = secondRegistration.user;
    if (!secondRegistration.resent) throw new Error('Повторная регистрация не распознана');
    if (reRegistered.role !== 'guest') throw new Error('После повторной регистрации ожидался guest');
    if (reRegistered.taking_orders !== 0) throw new Error('Гость не должен принимать заказы');
    if (reRegistered.id === user.id) throw new Error('Гостевая запись не заменена');
    if (lastSentCode === oldCode) throw new Error('Код не отправлен повторно');
    const sameIdentity = await db.all(
      'SELECT id FROM users WHERE username = ? OR email = ?', username, email
    );
    if (sameIdentity.length !== 1) throw new Error('Не одна запись под одним логином/email');
    createdUserId = reRegistered.id;

    // 6. Верный код -> role='user', email_verified=1, taking_orders=1
    const verified = await AuthService.verifyEmail(lastSentCode);
    const fresh = await User.getById(createdUserId);
    console.log('6. Подтверждение: role =', fresh.role, ', email_verified =', verified.email_verified,
      ', taking_orders =', fresh.taking_orders);
    if (fresh.role !== 'user') throw new Error('Роль не изменилась на user');
    if (verified.email_verified !== 1) throw new Error('email_verified не установлен');
    if (fresh.taking_orders !== 1) throw new Error('Подтверждённому должно вернуться taking_orders = 1');
    const codesLeft = await db.get(
      'SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?', createdUserId
    );
    if (codesLeft.n !== 0) throw new Error('Коды не удалены после подтверждения');

    // 7. Логин после подтверждения работает
    const loginResult = await AuthService.login(username, 'secret123');
    if (loginResult.user.role !== 'user') throw new Error('Неожиданная роль при логине');
    console.log('7. Логин после подтверждения ✅');

    // 8. Resend для подтверждённого — тихий no-op
    const sentBefore = sentCount;
    const resendForVerified = await AuthService.resendCode(email);
    if (sentCount !== sentBefore) throw new Error('Resend для подтверждённого отправил письмо');
    if (resendForVerified.sent !== false) throw new Error('Resend вернул sent = true');
    console.log('8. Resend для подтверждённого: no-op ✅');

    // 9. Resend для несуществующего — no-op
    await AuthService.resendCode('no-such-user@example.com');
    if (sentCount !== sentBefore) throw new Error('Resend для несуществующего отправил письмо');
    console.log('9. Resend для несуществующего: no-op ✅');

    // 10. Повторная регистрация на подтверждённый логин/email — занято
    let usernameTaken = false;
    try { await AuthService.register({ username, email: `other_${email}`, password: 'secret123' }); }
    catch (e) { usernameTaken = e.message === 'username already taken'; }
    if (!usernameTaken) throw new Error('Подтверждённый логин не защищён');
    let emailTaken = false;
    try { await AuthService.register({ username: `${username}_x`, email, password: 'secret123' }); }
    catch (e) { emailTaken = e.message === 'email already taken'; }
    if (!emailTaken) throw new Error('Подтверждённый email не защищён');
    console.log('10. Подтверждённые логин/email защищены ✅');

    console.log('=== Smoke-тест пройден ✅ ===');
    process.exitCode = 0;
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    try {
      const db = getUsersDB();
      if (createdUserId) {
        await db.run('DELETE FROM email_verifications WHERE user_id = ?', createdUserId);
        await db.run('DELETE FROM refresh_tokens WHERE user_id = ?', createdUserId);
        await db.run('DELETE FROM user_stores WHERE user_id = ?', createdUserId);
        await db.run('DELETE FROM users WHERE id = ?', createdUserId);
      }
    } catch { /* ignore */ }
    try { await closeNotificationsDB(); } catch { /* ignore */ }
    try { await closeAll(); } catch { /* ignore */ }
    cleanup();
  }
})();