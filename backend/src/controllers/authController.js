const AuthService = require('../services/AuthService');

exports.register = async (req, res, next) => {
  try {
    const { username, email, password, name, phone, capacity, earningsFactor } = req.body;
    // Валидация
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const validationErrors = AuthService.validateRegisterData({
      username, email, password, capacity, phone, earningsFactor,
    });
    if (validationErrors.length > 0) {
      // error — текст для показа в интерфейсе, errors — массив по полям (структурированно)
      return res.status(400).json({
        error: validationErrors.join('. '),
        errors: validationErrors,
      });
    }
    const { user, resent } = await AuthService.register({
      username, email, password, name, phone, capacity, earningsFactor
    });
    res.status(201).json({
      user,
      // resent: заменили «зависшую» неподтверждённую регистрацию тем же
      // логином/email — код сгенерирован и отправлен заново
      message: resent
        ? 'Код подтверждения отправлен повторно на указанный email'
        : 'Код подтверждения отправлен на указанный email',
      resent,
    });
  } catch (err) {
    if (err.message.includes('already taken')) {
      const what = err.message.startsWith('username') ? 'Логин' : 'Email';
      return res.status(409).json({ error: `${what} уже занят` });
    }
    if (err.message.includes('Не удалось отправить письмо')) {
      return res.status(502).json({ error: err.message });
    }
    next(err);
  }
};

exports.verifyEmail = async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });
    const user = await AuthService.verifyEmail(code);
    res.json({
      message: 'Email подтверждён. Присвоена роль user — теперь войдите в аккаунт.',
      user,
    });
  } catch (err) {
    if (err.message === 'Неверный или просроченный код') {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
};

exports.resendCode = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const result = await AuthService.resendCode(email);
    // Ответ одинаковый независимо от того, существует ли аккаунт,
    // чтобы не раскрывать список зарегистрированных email.
    // sent = false — письмо не отправлено (аккаунта нет / уже подтверждён /
    // не истёк кулдаун RESEND_CODE_COOLDOWN_SEC), retryAfterSec нужен
    // фронтенду для таймера на кнопке «Отправить код повторно»
    res.json({
      message: 'Если аккаунт существует и email ещё не подтверждён, новое письмо отправлено',
      sent: result.sent,
      retryAfterSec: result.retryAfterSec,
    });
  } catch (err) {
    if (err.message.includes('Не удалось отправить письмо')) {
      return res.status(502).json({ error: err.message });
    }
    next(err);
  }
};

exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email обязателен' });
    const result = await AuthService.requestPasswordReset(email);
    res.json({
      message: 'Если учетная запись с указанным email существует, на неё отправлено письмо с кодом сброса пароля.',
      sent: result.sent,
      retryAfterSec: result.retryAfterSec,
    });
  } catch (err) {
    if (err.message.includes('Не удалось отправить письмо')) {
      return res.status(502).json({ error: err.message });
    }
    next(err);
  }
};

exports.resetPassword = async (req, res, next) => {
  try {
    const { code, newPassword } = req.body;
    if (!code || !newPassword) {
      return res.status(400).json({ error: 'Код и новый пароль обязательны' });
    }
    const result = await AuthService.resetPassword(code, newPassword);
    res.json(result);
  } catch (err) {
    if (
      err.message === 'Неверный или просроченный код сброса пароля' ||
      err.message === 'Пароль должен содержать минимум 6 символов' ||
      err.message === 'Код обязателен'
    ) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
};


exports.login = async (req, res, next) => {
  try {
    const { usernameOrEmail, password } = req.body;
    if (!usernameOrEmail || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }
    const result = await AuthService.login(usernameOrEmail, password);
    res.json(result);
  } catch (err) {
    if (err.message === 'Invalid credentials') {
      return res.status(401).json({ error: err.message });
    }
    if (err.message === 'Email not verified') {
      return res.status(403).json({
        error: 'Email не подтверждён. Введите код из письма.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }
    next(err);
  }
};

exports.refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Missing refresh token' });
    }
    const result = await AuthService.refresh(refreshToken);
    res.json(result);
  } catch (err) {
    if (err.message.includes('Invalid') || err.message.includes('expired')) {
      return res.status(401).json({ error: err.message });
    }
    next(err);
  }
};

exports.logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Missing refresh token' });
    }
    await AuthService.logout(refreshToken);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

exports.me = async (req, res) => {
  // req.user уже собран в middleware authenticate.
  // Дополнительно — has_store_access: true, если у user есть доступ
  // хотя бы к одному магазину (активная запись в user_stores) или он god.
  // Нужно для глобальных страниц («Мои материалы»), которые открываются
  // и на root-домене, где user.role = 'user'/'god'/'guest' (без per-store).
  let hasStoreAccess = req.user.role === 'god';
  if (!hasStoreAccess) {
    try {
      const { getUsersDB } = require('../config/database');
      const row = await getUsersDB().get(
        'SELECT 1 AS x FROM user_stores WHERE user_id = ? AND is_fired = 0 LIMIT 1',
        req.user.id
      );
      hasStoreAccess = !!row;
    } catch {
      /* не критично: в худшем случае ссылка не покажется */
    }
  }
  res.json({ ...req.user, has_store_access: hasStoreAccess });
};