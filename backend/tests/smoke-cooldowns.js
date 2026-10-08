/**
 * Smoke-тест: кулдауны команд веб-версии + middleware с live-оповещением
 * (запуск: node tests/smoke-cooldowns.js из папки backend/).
 *
 * MULTISTORE: ключ кулдауна — 'storeId:userId'. Один и тот же сотрудник в
 * разных магазинах имеет независимые кулдауны. Middleware берёт storeId из
 * req.storeId и пробрасывает его в payload live-оповещения.
 *
 * Реальной БД и WebSocket не нужно: NotificationService.notifyUser подменяется
 * стабом, время в CooldownService передаётся явно (параметры now).
 *
 * Проверяет:
 *   1) check() не блокирует до touch() и блокирует после;
 *   2) кулдауны изолированы между магазинами;
 *   3) чужой пользователь кулдауном не затронут;
 *   4) middleware отвечает 429 { cooldown: true, retryAfterSec } и шлёт
 *      live-оповещение command_cooldown (persist: false, storeId в payload);
 *   5) cleanCooldowns() удаляет устаревшие записи и не трогает свежие;
 *   6) шаблон command_cooldown зарегистрирован в NotificationService,
 *      socket.notifyUser получает storeId первым аргументом.
 */
const assert = require('assert');

const CooldownService = require('../src/services/CooldownService');
const NotificationService = require('../src/services/NotificationService');
const { cooldown } = require('../src/middlewares/cooldown');

(async () => {
  console.log('=== Smoke-тест: кулдауны команд (CooldownService + middleware) ===');

  const STORE_A = 'test-store-A';
  const STORE_B = 'test-store-B';
  const USER = 777;
  const OTHER = 888;
  const now = Date.now();

  // --- 1. До touch() кулдаун не блокирует ---
  for (const kind of ['label', 'allLabels', 'toggleOrders', 'refreshOrders']) {
    assert.strictEqual(
      CooldownService.check(kind, STORE_A, USER, now).blocked, false,
      `${kind}: до touch() не должен блокировать`
    );
  }
  console.log('1. До touch() кулдауны не блокируют ✅');

  // --- 2. touch() -> блокировка с корректным retryAfterSec ---
  CooldownService.touch('label', STORE_A, USER, 0, now);
  const labelBlocked = CooldownService.check('label', STORE_A, USER, now + 1000);
  assert.strictEqual(labelBlocked.blocked, true, 'label: после touch() блокирует');
  assert.ok(
    labelBlocked.retryAfterSec >= 59 && labelBlocked.retryAfterSec <= 60,
    `label: retryAfterSec ≈ 60, получено ${labelBlocked.retryAfterSec}`
  );
  assert.ok(
    labelBlocked.message.includes('этикетки'),
    'label: текст как в боте (упоминает этикетку)'
  );
  // Через 60 секунд — снова можно
  assert.strictEqual(
    CooldownService.check('label', STORE_A, USER, now + 60 * 1000).blocked, false,
    'label: по истечении 60 сек разрешает'
  );
  // Другой пользователь не затронут
  assert.strictEqual(
    CooldownService.check('label', STORE_A, OTHER, now).blocked, false,
    'label: кулдаун персональный'
  );
  // ДРУГОЙ МАГАЗИН того же пользователя — независимая корзина
  assert.strictEqual(
    CooldownService.check('label', STORE_B, USER, now).blocked, false,
    'label: кулдаун магазина A не действует в магазине B'
  );
  console.log('2. label: 60-секундный персональный кулдаун + изоляция магазинов ✅');

  // allLabels: длинный (успех) и короткий (пусто)
  CooldownService.touch('allLabels', STORE_A, USER, 0, now);
  const longBlocked = CooldownService.check('allLabels', STORE_A, USER, now + 60 * 1000);
  assert.strictEqual(longBlocked.blocked, true, 'allLabels[0]: час после успеха');
  assert.ok(
    longBlocked.message.includes('раз в час'),
    'allLabels[0]: текст как в боте («раз в час»)'
  );
  assert.strictEqual(
    CooldownService.check('allLabels', STORE_A, USER, now + 3600 * 1000).blocked, false,
    'allLabels[0]: по истечении часа разрешает'
  );

  // Короткий кулдаун — на ДРУГОМ пользователе (у USER уже активен длинный)
  CooldownService.touch('allLabels', STORE_A, OTHER, 1, now);
  const shortBlocked = CooldownService.check('allLabels', STORE_A, OTHER, now + 30 * 1000);
  assert.strictEqual(shortBlocked.blocked, true, 'allLabels[1]: 60 сек после пустого');
  assert.ok(
    !shortBlocked.message.includes('раз в час'),
    'allLabels[1]: короткий текст без «раз в час»'
  );
  assert.strictEqual(
    CooldownService.check('allLabels', STORE_A, OTHER, now + 60 * 1000).blocked, false,
    'allLabels[1]: по истечении 60 сек разрешает'
  );
  console.log('3. allLabels: час после успеха / 60 сек после пустого ✅');

  CooldownService.touch('toggleOrders', STORE_A, USER, 0, now);
  const toggleBlocked = CooldownService.check('toggleOrders', STORE_A, USER, now + 5000);
  assert.strictEqual(toggleBlocked.blocked, true, 'toggleOrders: после touch() блокирует');
  assert.ok(
    toggleBlocked.message.includes('статуса'),
    'toggleOrders: текст как в боте («изменением статуса»)'
  );
  console.log('4. toggleOrders: 60-секундный кулдаун работает ✅');

  CooldownService.touch('refreshOrders', STORE_A, USER, 0, now);
  const refreshBlocked = CooldownService.check('refreshOrders', STORE_A, USER, now + 5000);
  assert.strictEqual(refreshBlocked.blocked, true, 'refreshOrders: после touch() блокирует');
  assert.ok(
    refreshBlocked.message.includes('обновлени'),
    'refreshOrders: текст про повторное обновление заказов'
  );
  assert.strictEqual(
    CooldownService.check('refreshOrders', STORE_A, USER, now + 60 * 1000).blocked, false,
    'refreshOrders: по истечении 60 сек разрешает'
  );
  console.log('4b. refreshOrders: 60-секундный кулдаун работает ✅');

  // --- 5. Middleware: 429 + live-оповещение ---
  const notifications = [];
  const originalNotifyUser = NotificationService.notifyUser;
  NotificationService.notifyUser = async (userId, type, payload, opts) => {
    notifications.push({ userId, type, payload, opts });
  };

  const makeRes = () => ({
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  });

  try {
    // 5a. Кулдаун сработал -> 429 + live-тост
    const mwBlocked = cooldown('label', 'Скачивание этикетки');
    const resBlocked = makeRes();
    let nextCalledBlocked = false;
    mwBlocked(
      { user: { id: USER }, storeId: STORE_A },
      resBlocked,
      () => { nextCalledBlocked = true; }
    );

    assert.strictEqual(resBlocked.statusCode, 429, 'middleware: статус 429');
    assert.strictEqual(resBlocked.body.cooldown, true, 'middleware: флаг cooldown');
    assert.ok(resBlocked.body.retryAfterSec > 0, 'middleware: retryAfterSec > 0');
    assert.strictEqual(nextCalledBlocked, false, 'middleware: next() не вызывается при блоке');
    assert.strictEqual(notifications.length, 1, 'middleware: отправлено одно оповещение');
    assert.strictEqual(notifications[0].type, 'command_cooldown', 'middleware: тип command_cooldown');
    assert.strictEqual(notifications[0].userId, USER, 'middleware: получатель — текущий пользователь');
    assert.strictEqual(notifications[0].opts.persist, false, 'middleware: persist=false');
    assert.strictEqual(notifications[0].payload.storeId, STORE_A, 'middleware: storeId в payload');
    assert.strictEqual(notifications[0].payload.command, 'Скачивание этикетки', 'middleware: имя команды');
    console.log('5. Middleware: 429 + live-оповещение command_cooldown (storeId проброшен) ✅');

    // 5b. Кулдаун не сработал -> next()
    const mwPass = cooldown('label', 'Скачивание этикетки');
    const resPass = makeRes();
    let nextCalledPass = false;
    mwPass(
      { user: { id: OTHER }, storeId: STORE_A },
      resPass,
      () => { nextCalledPass = true; }
    );
    assert.strictEqual(nextCalledPass, true, 'middleware: next() вызывается без кулдауна');
    assert.strictEqual(resPass.statusCode, 200, 'middleware: ответ не тронут');
    assert.strictEqual(notifications.length, 1, 'middleware: без блока оповещений нет');
    console.log('6. Middleware: пропускает без кулдауна ✅');
  } finally {
    NotificationService.notifyUser = originalNotifyUser;
  }

  // --- 6. cleanCooldowns(): устаревшие удаляются, свежие остаются ---
  const before = CooldownService.stats();
  console.log('   sizes до очистки:', JSON.stringify(before));

  CooldownService.touch('toggleOrders', STORE_A, 999001, 0, now - 2 * 3600 * 1000);
  CooldownService.touch('label', STORE_A, 999002, 0, now);

  const deleted = CooldownService.cleanCooldowns(now);
  assert.ok(deleted >= 1, 'cleanCooldowns: удалена хотя бы одна устаревшая запись');
  const after = CooldownService.stats();
  assert.ok(
    after.toggleOrders[0] < before.toggleOrders[0] + 1,
    'cleanCooldowns: устаревшая запись toggleOrders удалена'
  );
  assert.notStrictEqual(
    CooldownService.check('label', STORE_A, 999002, now).blocked, false,
    'cleanCooldowns: свежая запись не удалена'
  );
  console.log(`7. cleanCooldowns: удалено ${deleted}, свежие записи целы ✅`);

  // --- 7. Шаблон command_cooldown: socket.notifyUser вызывается с storeId ---
  const socket = require('../src/socket');
  const originalSocketNotify = socket.notifyUser;
  const socketCalls = [];
  // Новая сигнатура socket.notifyUser: (storeId, userId, event, data)
  socket.notifyUser = (storeId, userId, event, data) => {
    socketCalls.push({ storeId, userId, event, data });
  };
  const nsPath = require.resolve('../src/services/NotificationService');
  const originalNsModule = require.cache[nsPath];
  try {
    delete require.cache[nsPath]; // перезагрузка -> захватит патченный socket
    const ReloadedNS = require(nsPath);
    await ReloadedNS.notifyUser(
      USER,
      'command_cooldown',
      {
        storeId: STORE_A,
        command: 'Скачивание этикетки',
        retryAfterSec: 42,
        message: '⏳ Подождите 42 сек.',
      },
      { persist: false }
    );
    assert.strictEqual(socketCalls.length, 1, 'socket.notifyUser вызван (шаблон есть)');
    assert.strictEqual(socketCalls[0].storeId, STORE_A, 'storeId проброшен в socket');
    assert.strictEqual(socketCalls[0].userId, USER, 'userId проброшен в socket');
    assert.strictEqual(socketCalls[0].event, 'notification_new', 'событие notification_new');
    assert.ok(socketCalls[0].data.title.includes('кулдаун'), 'заголовок тоста содержит «кулдаун»');
    assert.strictEqual(socketCalls[0].data.transient, true, 'transient=true (persist:false)');
  } finally {
    socket.notifyUser = originalSocketNotify;
    delete require.cache[nsPath];
    if (originalNsModule) require.cache[nsPath] = originalNsModule;
  }
  console.log('8. Шаблон command_cooldown: socket получает storeId первым ✅');

  console.log('=== Все проверки кулдаунов пройдены ✅ ===');
  process.exit(0);
})().catch((err) => {
  console.error('❌ Smoke-тест кулдаунов провален:', err);
  process.exit(1);
});