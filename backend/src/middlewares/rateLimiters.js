// ============================================================
//  RATE LIMITING
// ============================================================
// Стратегия:
//  1) apiLimiter на весь /api — общий «предохранитель». Считает только
//     НЕуспешные ответы (skipSuccessfulRequests): обычная работа панели
//     никогда не блокируется, купируются лишь ошибочные циклы
//     (401 -> refresh -> повтор, всплески 5xx и т.п.).
//  2) authLimiter (строгий) — ТОЛЬКО на брутфорсимые эндпоинты:
//     login / register / verify-email / resend-code. Его нельзя вешать на
//     весь /api/auth: /auth/refresh и /auth/me — легитимный трафик каждой
//     активной сессии (при ACCESS_TOKEN_EXPIRY=15m это ~2 запроса в окно
//     на пользователя), и раньше они выжигали лимит 30 -> пользователи
//     массово получали 429 и принудительный логаут (см. refresh-интерцептор
//     фронта). Успешные ответы строгий лимитер тоже не считает: перебор
//     пароля — это неуспешные попытки, ограничиваем именно их.
//  3) OPTIONS (CORS-preflight) не тратит корзины ни одного лимитера.
//
// ВАЖНО (продакшен): корзины ключуются по req.ip. За reverse proxy (nginx)
// req.ip без app.set('trust proxy') — IP прокси, т.е. ОДНА корзина на всех
// пользователей. На сервере должно быть TRUST_PROXY=1 в .env, а nginx обязан
// передавать X-Forwarded-For (см. ServerFiles/DEPLOY-NOTE.md).
// Регрессия прикрыта смок-тестом: backend/tests/smoke-rate-limit.js.
const rateLimit = require('express-rate-limit');

// CORS-preflight — служебный запрос браузера, лимиты не тратим
const skipPreflight = (req) => req.method === 'OPTIONS';

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 300, // до 300 неуспешных запросов за окно
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // успешные ответы лимит не тратят
  skip: skipPreflight,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 30, // до 30 неуспешных попыток за окно (логин/регистрация/код из письма)
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // успешные логины/регистрации лимит не тратят
  skip: skipPreflight,
  message: { error: 'Too many auth attempts, please try again later.' },
});

module.exports = { apiLimiter, authLimiter, skipPreflight };
