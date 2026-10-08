/**
 * Smoke-тест очистки неподтверждённых аккаунтов.
 * Запуск: node tests/smoke-guest-cleanup.js из папки backend/.
 *
 * MULTISTORE: cleanupGuestAccounts(userId) чистит пользователя во ВСЕХ БД:
 *   • users.db: user_stores, refresh_tokens, email_verifications,
 *     password_resets, push_subscriptions, users;
 *   • models.db: issued_models, model_download_tokens, offer_models.uploaded_by → NULL;
 *   • store-N.db: assignments, user_stats, earnings*, user_warehouses,
 *     product_stats.user_id → NULL.
 *
 * Проверяет:
 *   • «старый» гость удаляется целиком;
 *   • «свежий» гость остаётся ждать подтверждения;
 *   • «легаси» аккаунт с просроченным кодом: код удалён, аккаунт жив;
 *   • «гость с историей» (наполнены ВСЕ БД) — удаляется без хвостов;
 *   • product_stats сохраняется с user_id = NULL;
 *   • повторный прогон идемпотентен.
 */
const { setup, cleanup } = require('./helpers/setupTestEnv');
const STORE_ID = setup('1').storeId;

// Порядок как в проде (scheduler тянет OrderService -> NotificationService -> socket)
require('../src/scheduler');

const { initDB, closeAll, getUsersDB, getModelsDB, getStoreDB } = require('../src/config/database');
const { initNotificationsDB, closeNotificationsDB } = require('../src/config/notificationsDatabase');
const User = require('../src/models/User');
const AuthService = require('../src/services/AuthService');
const EmailService = require('../src/services/EmailService');

EmailService.sendVerificationEmail = async (email) => {
  console.log(`[Стаб Email] Письмо -> ${email}`);
  return { messageId: 'stub' };
};

const HOUR_MS = 60 * 60 * 1000;
const TTL_HOURS = 24;
const SUFFIX = '@smoke-guests.local';
const SMOKE_OFFER_ID = 'SMOKE-GUEST-OFFER';
const SMOKE_WAREHOUSE = 'smoke-warehouse';

/**
 * Наполняет ВСЕ таблицы приложения, ссылающиеся на пользователя.
 */
async function fillLinkedData(usersDb, modelsDb, storeDb, userId) {
  const now = Date.now();
  const orderId = `SMOKE-GUEST-${userId}`;

  // store-N.db
  await storeDb.run(
    'INSERT INTO assignments (order_id, user_id, assigned_at, status) VALUES (?, ?, ?, ?)',
    orderId, userId, now, 'assigned'
  );
  await storeDb.run(
    'INSERT INTO user_stats (user_id, total_orders, total_amount, canceled_orders) VALUES (?, ?, ?, ?)',
    userId, 3, 1000, 0
  );
  await storeDb.run(
    'INSERT INTO earnings_history (user_id, order_id, amount, calculated_at) VALUES (?, ?, ?, ?)',
    userId, orderId, 500, now
  );
  await storeDb.run(
    'INSERT INTO earnings_active (user_id, order_id, amount, calculated_at) VALUES (?, ?, ?, ?)',
    userId, orderId, 500, now
  );
  await storeDb.run(
    'INSERT INTO earnings_adjustments (user_id, amount, reason, adjusted_at) VALUES (?, ?, ?, ?)',
    userId, 100, 'smoke', now
  );
  await storeDb.run(
    'INSERT INTO earnings_adjustments_active (user_id, amount, reason, adjusted_at) VALUES (?, ?, ?, ?)',
    userId, 100, 'smoke', now
  );
  // склад
  await storeDb.run(
    'INSERT OR IGNORE INTO warehouses (warehouse_id, name) VALUES (?, ?)',
    SMOKE_WAREHOUSE, 'Smoke Warehouse'
  );
  await storeDb.run(
    'INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)',
    userId, SMOKE_WAREHOUSE
  );
  // product_stats: должно СОХРАНИТЬСЯ после cleanup, user_id → NULL
  await storeDb.run(
    'INSERT INTO product_stats (offer_id, material, color, weight_grams, user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    SMOKE_OFFER_ID, 'PLA', 'Black', 100, userId, now
  );

  // models.db
  await modelsDb.run(
    'INSERT INTO issued_models (user_id, offer_id, issued_at) VALUES (?, ?, ?)',
    userId, SMOKE_OFFER_ID, now
  );
  await modelsDb.run(
    'INSERT INTO model_download_tokens (offer_id, user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    SMOKE_OFFER_ID, userId, `smoke-token-${userId}`, now + HOUR_MS, now
  );
  await modelsDb.run(
    'INSERT INTO offer_models (offer_id, s3_key, uploaded_by) VALUES (?, ?, ?)',
    `SMOKE-GUEST-MODEL-${userId}`, 'smoke/key.zip', userId
  );

  // users.db
  await usersDb.run(
    'INSERT INTO email_verifications (user_id, code, expires_at, created_at) VALUES (?, ?, ?, ?)',
    userId, '111111', now + HOUR_MS, now
  );
  await usersDb.run(
    'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
    userId, `smoke-loaded-token-${userId}`, now + 7 * 24 * HOUR_MS
  );
}

(async () => {
  let staleGuestId = null;
  let freshGuestId = null;
  let legacyUserId = null;
  let loadedGuestId = null;
  try {
    console.log('=== Smoke-тест очистки неподтверждённых аккаунтов ===');
    await initDB();
    await initNotificationsDB();
    const usersDb = getUsersDB();
    const modelsDb = getModelsDB();
    const storeDb = getStoreDB(STORE_ID);

    // Чистим мусор от прошлых запусков
    await usersDb.run(`DELETE FROM users WHERE email LIKE '%${SUFFIX}'`);

    // 1. «Старый» гость
    const stale = await AuthService.register({
      username: 'smoke_stale_guest',
      email: `stale${SUFFIX}`,
      password: 'secret123',
    });
    staleGuestId = stale.user.id;
    const staleCreatedAt = Date.now() - (TTL_HOURS + 1) * HOUR_MS;
    await usersDb.run(
      'UPDATE users SET created_at = ?, updated_at = ? WHERE id = ?',
      staleCreatedAt, staleCreatedAt, staleGuestId
    );
    await usersDb.run(
      'UPDATE email_verifications SET created_at = ?, expires_at = ? WHERE user_id = ?',
      staleCreatedAt, Date.now() - HOUR_MS, staleGuestId
    );
    await usersDb.run(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      staleGuestId, 'smoke_guest_token', Date.now() + 7 * 24 * HOUR_MS
    );
    console.log(`1. «Старый» гость #${staleGuestId}: role=${stale.user.role}, возраст > TTL`);

    // 2. «Свежий» гость
    const fresh = await AuthService.register({
      username: 'smoke_fresh_guest',
      email: `fresh${SUFFIX}`,
      password: 'secret123',
    });
    freshGuestId = fresh.user.id;
    console.log(`2. «Свежий» гость #${freshGuestId}: ожидает подтверждения`);

    // 3. «Легаси» аккаунт с просроченным кодом
    const legacy = await User.create({
      username: 'smoke_legacy_user',
      email: `legacy${SUFFIX}`,
      passwordHash: 'not-a-real-hash',
      name: 'Legacy',
      role: 'user',
    });
    legacyUserId = legacy.id;
    await usersDb.run(
      'INSERT INTO email_verifications (user_id, code, expires_at, created_at) VALUES (?, ?, ?, ?)',
      legacyUserId, '000001', Date.now() - HOUR_MS, Date.now() - 2 * HOUR_MS
    );

    // 4. Прогон очистки
    const result = await AuthService.cleanupGuestAccounts(TTL_HOURS);
    console.log(`4. Очистка: удалено аккаунтов = ${result.deletedUsers}, кодов = ${result.deletedCodes}`);

    // 5. «Старый» гость удалён
    const staleAfter = await User.getById(staleGuestId);
    const staleCodes = await usersDb.get('SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?', staleGuestId);
    const staleTokens = await usersDb.get('SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ?', staleGuestId);
    console.log(`5. «Старый» гость: запись=${staleAfter}, коды=${staleCodes.n}, токены=${staleTokens.n}`);
    if (staleAfter !== null) throw new Error('«Старый» гость не удалён');
    if (staleCodes.n !== 0 || staleTokens.n !== 0) throw new Error('Остались связанные данные');

    // 6. «Свежий» гость на месте
    const freshAfter = await User.getById(freshGuestId);
    const freshCodes = await usersDb.get('SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?', freshGuestId);
    if (!freshAfter) throw new Error('«Свежий» гость удалён раньше TTL');
    console.log(`6. «Свежий» гость: role=${freshAfter.role}, taking_orders=${freshAfter.taking_orders}, коды=${freshCodes.n}`);
    if (freshAfter.role !== 'guest' || freshAfter.taking_orders !== 0) {
      throw new Error('«Свежий» гость должен быть вне команды');
    }
    if (freshCodes.n !== 1) throw new Error('Код «свежего» гостя не должен удаляться');

    // 7. «Легаси» код удалён, аккаунт жив
    const legacyCodes = await usersDb.get('SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?', legacyUserId);
    const legacyAfter = await User.getById(legacyUserId);
    console.log(`7. «Легаси»: коды=${legacyCodes.n}, аккаунт жив=${legacyAfter !== null}`);
    if (legacyCodes.n !== 0) throw new Error('Просроченный код не удалён');
    if (!legacyAfter) throw new Error('Аккаунт с просроченным кодом удалён зря');
    if (result.deletedUsers !== 1) throw new Error('Ожидалось удаление ровно одного гостя');

    // 8. Повторный прогон идемпотентен
    const again = await AuthService.cleanupGuestAccounts(TTL_HOURS);
    console.log(`8. Повторный прогон: удалено = ${again.deletedUsers}`);
    if (again.deletedUsers !== 0) throw new Error('Повторный прогон удалил лишнее');

    // 9. «Гость с историей»: наполняем все БД
    const loaded = await AuthService.register({
      username: 'smoke_loaded_guest',
      email: `loaded${SUFFIX}`,
      password: 'secret123',
    });
    loadedGuestId = loaded.user.id;
    const loadedCreatedAt = Date.now() - (TTL_HOURS + 1) * HOUR_MS;
    await usersDb.run(
      'UPDATE users SET created_at = ?, updated_at = ? WHERE id = ?',
      loadedCreatedAt, loadedCreatedAt, loadedGuestId
    );
    await fillLinkedData(usersDb, modelsDb, storeDb, loadedGuestId);
    console.log(`9. «Гость с историей» #${loadedGuestId}: наполнены users.db, models.db, store-N.db`);

    // 10. Очистка удаляет такого гостя без ошибок
    const loadedResult = await AuthService.cleanupGuestAccounts(TTL_HOURS);
    console.log(`10. Очистка «гостя с историей»: удалено = ${loadedResult.deletedUsers}`);
    if (loadedResult.deletedUsers !== 1) throw new Error('«Гость с историей» не удалён');
    if (await User.getById(loadedGuestId)) throw new Error('Аккаунт «гостя с историей» остался');

    // 11. Ни в одной БД не осталось хвостов
    const leftovers = [];
    // users.db
    const uChecks = [
      ['user_stores', 'user_id'],
      ['refresh_tokens', 'user_id'],
      ['email_verifications', 'user_id'],
      ['password_resets', 'user_id'],
      ['push_subscriptions', 'user_id'],
    ];
    for (const [t, c] of uChecks) {
      const r = await usersDb.get(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, loadedGuestId);
      if (r.n) leftovers.push(`users.db.${t}.${c}=${r.n}`);
    }
    // models.db
    const mChecks = [
      ['issued_models', 'user_id'],
      ['model_download_tokens', 'user_id'],
    ];
    for (const [t, c] of mChecks) {
      const r = await modelsDb.get(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, loadedGuestId);
      if (r.n) leftovers.push(`models.db.${t}.${c}=${r.n}`);
    }
    const offerRow = await modelsDb.get('SELECT uploaded_by FROM offer_models WHERE s3_key = ?', 'smoke/key.zip');
    if (offerRow && offerRow.uploaded_by !== null) {
      leftovers.push(`models.db.offer_models.uploaded_by=${offerRow.uploaded_by}`);
    }
    // store-N.db
    const sChecks = [
      ['assignments', 'user_id'],
      ['user_stats', 'user_id'],
      ['earnings_history', 'user_id'],
      ['earnings_active', 'user_id'],
      ['earnings_adjustments', 'user_id'],
      ['earnings_adjustments_active', 'user_id'],
      ['user_warehouses', 'user_id'],
    ];
    for (const [t, c] of sChecks) {
      const r = await storeDb.get(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, loadedGuestId);
      if (r.n) leftovers.push(`store-${STORE_ID}.db.${t}.${c}=${r.n}`);
    }
    console.log('11. Остатки ссылок:', leftovers.length ? leftovers.join(', ') : 'нет ✅');
    if (leftovers.length) throw new Error('Остались ссылки: ' + leftovers.join(', '));

    // product_stats сохранён, user_id = NULL
    const keptStat = await storeDb.get('SELECT user_id FROM product_stats WHERE offer_id = ?', SMOKE_OFFER_ID);
    if (!keptStat) throw new Error('product_stats удалён, хотя должен сохраниться');
    if (keptStat.user_id !== null) throw new Error('product_stats.user_id не обнулён');
    console.log('11b. product_stats сохранён с user_id = NULL ✅');

    console.log('=== Smoke-тест пройден ✅ ===');
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    try {
      const usersDb = getUsersDB();
      const modelsDb = getModelsDB();
      const storeDb = getStoreDB(STORE_ID);
      for (const id of [staleGuestId, freshGuestId, legacyUserId, loadedGuestId]) {
        if (!id) continue;
        for (const [sql] of [
          ['DELETE FROM email_verifications WHERE user_id = ?'],
          ['DELETE FROM refresh_tokens WHERE user_id = ?'],
          ['DELETE FROM user_stores WHERE user_id = ?'],
        ]) { try { await usersDb.run(sql, id); } catch { } }
        for (const sql of [
          'DELETE FROM issued_models WHERE user_id = ?',
          'DELETE FROM model_download_tokens WHERE user_id = ?',
          'UPDATE offer_models SET uploaded_by = NULL WHERE uploaded_by = ?',
        ]) { try { await modelsDb.run(sql, id); } catch { } }
        for (const sql of [
          'DELETE FROM assignments WHERE user_id = ?',
          'DELETE FROM user_stats WHERE user_id = ?',
          'DELETE FROM earnings_history WHERE user_id = ?',
          'DELETE FROM earnings_active WHERE user_id = ?',
          'DELETE FROM earnings_adjustments WHERE user_id = ?',
          'DELETE FROM earnings_adjustments_active WHERE user_id = ?',
          'DELETE FROM user_warehouses WHERE user_id = ?',
          'UPDATE product_stats SET user_id = NULL WHERE user_id = ?',
        ]) { try { await storeDb.run(sql, id); } catch { } }
        await usersDb.run('DELETE FROM users WHERE id = ?', id);
      }
      try { await storeDb.run('DELETE FROM product_stats WHERE offer_id = ?', SMOKE_OFFER_ID); } catch { }
      try { await storeDb.run('DELETE FROM warehouses WHERE warehouse_id = ?', SMOKE_WAREHOUSE); } catch { }
      try { await modelsDb.run('DELETE FROM offer_models WHERE s3_key = ?', 'smoke/key.zip'); } catch { }
      try { await modelsDb.run('DELETE FROM offer_models WHERE offer_id LIKE ?', 'SMOKE-GUEST-MODEL-%'); } catch { }
    } catch (e) { /* ignore */ }
    try { await closeNotificationsDB(); } catch { }
    try { await closeAll(); } catch { }
    cleanup();
  }
})();