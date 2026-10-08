/**
 * Smoke-тест-регрессия прод-инцидента: «502 на /api/auth/login после обновления».
 * Подменяет загрузчик модулей так, будто web-push отсутствует, и проверяет,
 * что API/планировщик всё равно загружаются, а PushService.enabled === false.
 *
 * MULTISTORE: используем helpers/setupTestEnv, чтобы initDB() получил валидный
 * .env.store1 (иначе упадёт на валидации магазина).
 *
 * Запуск: node tests/smoke-push-no-module.js
 */
require('dotenv').config();

// Подменяем загрузку ДО первого require('web-push')
const Module = require('module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'web-push') {
    const err = new Error("Cannot find module 'web-push'");
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { setup, cleanup } = require('./helpers/setupTestEnv');
const env = setup('1');

const { initDB, closeAll, getUsersDB } = require('../src/config/database');
const { initNotificationsDB, closeNotificationsDB } = require('../src/config/notificationsDatabase');

const ENDPOINT = 'https://example.invalid/smoke-no-webpush';

function assert(condition, message) {
  if (!condition) throw new Error(`ПРОВАЛ: ${message}`);
  console.log(`✅ ${message}`);
}

(async () => {
  try {
    console.log('=== Smoke-тест: API работает без пакета web-push ===');

    // Именно эти модули подключает server.js — раньше они падали целиком
    require('../src/routes/auth');
    require('../src/routes/user');
    require('../src/routes/notifications');
    require('../src/scheduler');
    assert(
      true,
      'Маршруты и планировщик загрузились без web-push (сервер стартует, 502 не будет)'
    );

    const PushService = require('../src/services/PushService');
    assert(PushService.enabled === false, 'PushService.enabled = false (Web Push отключён)');

    const result = await PushService.sendToUser(1, { title: 'x', body: 'y' });
    assert(
      result.sent === 0 && result.failed === 0 && result.removed === 0,
      'sendToUser безопасен без web-push (нулевой результат, без исключения)'
    );

    await initDB();
    await initNotificationsDB();
    const db = getUsersDB();
    // Создаём тестового пользователя — иначе проверки БД пропускаются
    const User = require('../src/models/User');
    const user = await User.create({
      username: `smoke_no_push_${Date.now()}`,
      email: `smoke_no_push_${Date.now()}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeNoPush',
      role: 'user',
    });
    await PushService.subscribe(
      user.id,
      { endpoint: ENDPOINT, keys: { p256dh: 'a', auth: 'b' } }
    );
    assert(
      (await PushService.countForUser(user.id)) >= 1,
      'subscribe работает без web-push (операция только с БД)'
    );
    await PushService.unsubscribe(user.id, ENDPOINT);
    assert(
      (await PushService.countForUser(user.id)) === 0,
      'unsubscribe работает без web-push'
    );

    // Убираем тестового пользователя
    await db.run('DELETE FROM users WHERE id = ?', user.id);

    console.log('=== Тест пройден ✅ ===');
  } catch (err) {
    console.error('❌', err.message);
    process.exitCode = 1;
  } finally {
    Module._load = originalLoad;
    try {
      await getUsersDB().run('DELETE FROM push_subscriptions WHERE endpoint = ?', ENDPOINT);
    } catch { /* БД могла не инициализироваться */ }
    try { await closeNotificationsDB(); } catch { /* ignore */ }
    try { await closeAll(); } catch { /* ignore */ }
    cleanup();
  }
})();