/**
 * Smoke-тест-регрессия прод-инцидента: «502 на /api/auth/login после обновления».
 *
 * Причина того инцидента: PushService подключается при СТАРТЕ сервера
 * (NotificationService -> AuthService -> routes/auth). Если пакет web-push не
 * установлен (на сервере не выполнен `npm install` после обновления кода),
 * require('web-push') бросал MODULE_NOT_FOUND и ронял ВЕСЬ API — nginx отдавал
 * 502 на все запросы, включая логин.
 *
 * Тест подменяет загрузчик модулей так, будто web-push отсутствует, и проверяет:
 *   • маршруты и планировщик всё равно загружаются (сервер стартует → 502 нет);
 *   • PushService.enabled === false;
 *   • sendToUser() возвращает нулевой результат и не бросает;
 *   • subscribe()/unsubscribe() продолжают работать (это только БД).
 *
 * Запуск из папки backend/: node tests/smoke-push-no-module.js
 * Тестовые данные удаляются в конце.
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

const { initDB, getDB } = require('../src/config/database');
const { initNotificationsDB } = require('../src/config/notificationsDatabase');

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
    const db = getDB();
    const user = await db.get('SELECT id FROM users ORDER BY id LIMIT 1');
    if (user) {
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
    } else {
      console.log('⚠️ В БД нет пользователей — проверки БД пропущены');
    }

    console.log('=== Тест пройден ✅ ===');
  } catch (err) {
    console.error('❌', err.message);
    process.exitCode = 1;
  } finally {
    Module._load = originalLoad;
    try {
      await getDB().run('DELETE FROM push_subscriptions WHERE endpoint = ?', ENDPOINT);
    } catch {
      /* БД могла не инициализироваться — чистить нечего */
    }
  }
})();
