/**
 * Smoke-тест rate-лимитеров (backend/src/middlewares/rateLimiters.js).
 * Запуск из папки backend/: node tests/smoke-rate-limit.js
 *
 * Регрессия прод-инцидента с массовыми 429 (без БД и .env):
 *   1. Строгую auth-корзину выжигают только НЕуспешные логины; при полной
 *      корзине /auth/refresh и /auth/me работают (раньше — 429 и логаут).
 *   2. Успешные логины корзину не тратят (skipSuccessfulRequests).
 *   3. OPTIONS (CORS-preflight) корзин не тратит.
 *   4. trust proxy + X-Forwarded-For: раздельные корзины у разных клиентов.
 *   5. БЕЗ trust proxy все делят одну корзину (прод-баг: req.ip = IP прокси).
 *
 * Минимальный express с теми же лимитерами и порядком монтирования, как в
 * server.js. Идемпотентен: состояние в памяти, порты эфемерные.
 */

const express = require('express');
const { apiLimiter, authLimiter } = require('../src/middlewares/rateLimiters');

const AUTH_LIMIT = 30;

function buildApp({ trustProxy } = {}) {
  const app = express();
  if (trustProxy) app.set('trust proxy', trustProxy);
  app.use(express.json());
  // Порядок монтирования — как в server.js
  app.use('/api', apiLimiter);
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);
  app.use('/api/auth/verify-email', authLimiter);
  app.use('/api/auth/resend-code', authLimiter);
  // Моки контроллеров: логин успешен только с password === 'ok'
  app.post('/api/auth/login', (req, res) => {
    if (req.body && req.body.password === 'ok') return res.json({ ok: true });
    return res.status(401).json({ error: 'Invalid credentials' });
  });
  app.post('/api/auth/refresh', (_req, res) => res.json({ ok: true }));
  app.get('/api/auth/me', (_req, res) => res.json({ ok: true }));
  return app;
}

const listen = (app) => new Promise((r) => { const s = app.listen(0, () => r(s)); });
const close = (server) => new Promise((r) => server.close(r));

async function call(port, path, { method = 'GET', ip, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(ip ? { 'x-forwarded-for': ip } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.status;
}

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? '✅' : '❌'} ${name}: ${actual}${ok ? '' : ` (ожидалось ${expected})`}`);
}

(async () => {
  console.log('=== Smoke-тест rate-лимитеров ===');
  const proxiedServer = await listen(buildApp({ trustProxy: 1 }));
  const pPort = proxiedServer.address().port;

  // 1. Неудачные логины выжигают строгую корзину...
  for (let i = 0; i < AUTH_LIMIT; i += 1) {
    const status = await call(pPort, '/api/auth/login', { method: 'POST', ip: '10.0.0.1', body: { password: 'bad' } });
    if (status !== 401) throw new Error(`Логин #${i + 1} (10.0.0.1): ожидался 401, получен ${status}`);
  }
  check('31-й неудачный логин -> 429',
    await call(pPort, '/api/auth/login', { method: 'POST', ip: '10.0.0.1', body: { password: 'bad' } }), 429);
  // ...но сессии живут: refresh и me строгим лимитом не ограничены
  check('корзина полна, /auth/refresh -> 200',
    await call(pPort, '/api/auth/refresh', { method: 'POST', ip: '10.0.0.1', body: { refreshToken: 'x' } }), 200);
  check('корзина полна, /auth/me -> 200',
    await call(pPort, '/api/auth/me', { ip: '10.0.0.1' }), 200);

  // 2. Успешные логины корзину не тратят
  for (let i = 0; i < AUTH_LIMIT; i += 1) {
    const status = await call(pPort, '/api/auth/login', { method: 'POST', ip: '10.0.0.2', body: { password: 'ok' } });
    if (status !== 200) throw new Error(`Успешный логин #${i + 1} (10.0.0.2): ожидался 200, получен ${status}`);
  }
  check('после 30 успешных логинов неудачный -> 401 (не 429)',
    await call(pPort, '/api/auth/login', { method: 'POST', ip: '10.0.0.2', body: { password: 'bad' } }), 401);

  // 3. OPTIONS не тратит корзину: 40 префлайтов, затем 30 неудач -> 31-я даёт 429
  for (let i = 0; i < 40; i += 1) {
    const status = await call(pPort, '/api/auth/login', { method: 'OPTIONS', ip: '10.0.0.3' });
    if (status >= 400) throw new Error(`OPTIONS #${i + 1}: ожидался 2xx, получен ${status}`);
  }
  for (let i = 0; i < AUTH_LIMIT; i += 1) {
    const status = await call(pPort, '/api/auth/login', { method: 'POST', ip: '10.0.0.3', body: { password: 'bad' } });
    if (status !== 401) throw new Error(`Логин #${i + 1} после 40 OPTIONS (10.0.0.3): ожидался 401, получен ${status}`);
  }
  check('40 OPTIONS не потратили корзину (31-я неудача -> 429)',
    await call(pPort, '/api/auth/login', { method: 'POST', ip: '10.0.0.3', body: { password: 'bad' } }), 429);

  // 4. Разные клиенты за прокси — раздельные корзины
  for (let i = 0; i < AUTH_LIMIT; i += 1) {
    await call(pPort, '/api/auth/login', { method: 'POST', ip: '10.1.0.1', body: { password: 'bad' } });
  }
  check('31-я неудача IP 10.1.0.1 -> 429',
    await call(pPort, '/api/auth/login', { method: 'POST', ip: '10.1.0.1', body: { password: 'bad' } }), 429);
  check('другой клиент 10.1.0.2 -> 401',
    await call(pPort, '/api/auth/login', { method: 'POST', ip: '10.1.0.2', body: { password: 'bad' } }), 401);
  await close(proxiedServer);

  // 5. БЕЗ trust proxy XFF игнорируется: req.ip = 127.0.0.1 у обоих «клиентов»
  // (валидатор express-rate-limit v6 напечатает предупреждение — это ожидаемо)
  const bareServer = await listen(buildApp());
  const bPort = bareServer.address().port;
  for (let i = 0; i < AUTH_LIMIT; i += 1) {
    await call(bPort, '/api/auth/login', { method: 'POST', ip: '10.2.0.1', body: { password: 'bad' } });
  }
  check('без trust proxy «другой клиент» 10.2.0.2 делит корзину -> 429',
    await call(bPort, '/api/auth/login', { method: 'POST', ip: '10.2.0.2', body: { password: 'bad' } }), 429);
  await close(bareServer);

  if (failed > 0) {
    console.error(`❌ Провалено проверок: ${failed}`);
    process.exit(1);
  }
  console.log('✅ Все проверки пройдены');
  process.exit(0);
})().catch((err) => {
  console.error('❌ Ошибка смок-теста:', err);
  process.exit(1);
});
