/**
 * seed.js — создать dev-аккаунты для тестирования через .http / фронт.
 * Запуск из backend/: node seed.js
 *
 * Создаёт 4 готовых аккаунта (idempotent — при повторном запуске обновляет):
 *   • admin    / admin123    — админ магазина (полный доступ)
 *   • moderator/ moderator123— модератор магазина (полный доступ + live-тосты)
 *   • employee / employee123 — сотрудник (работа с заказами)
 *   • user     / user123     — обычный пользователь (profile, оповещения)
 *
 * Все аккаунты создаются глобально подтверждёнными (email_verified = 1),
 * логин сразу доступен. Per-store роли — в user_stores для магазина,
 * который первый в реестре (.env.store1 обычно).
 *
 * ⚠️  Только для DEV-окружения. НЕ использовать в проде.
 */
require('dotenv').config();

const bcrypt = require('bcrypt');
const stores = require('./src/config/stores');
const { initDB, closeAll, getUsersDB } = require('./src/config/database');
const User = require('./src/models/User');
const UserStore = require('./src/models/UserStore');

const ACCOUNTS = [
  { username: 'admin', email: 'admin@dev.local', password: 'admin123', storeRole: 'admin', name: 'Админ (dev)' },
  { username: 'moderator', email: 'moderator@dev.local', password: 'moderator123', storeRole: 'moderator', name: 'Модератор (dev)' },
  { username: 'employee', email: 'employee@dev.local', password: 'employee123', storeRole: 'employee', name: 'Сотрудник (dev)' },
  { username: 'user', email: 'user@dev.local', password: 'user123', storeRole: null, name: 'Обычный пользователь (dev)' },
];

async function ensureAccount(account, storeId) {
  const db = getUsersDB();
  const passwordHash = await bcrypt.hash(account.password, 10);

  let user = await User.getByUsername(account.username);
  if (user) {
    await db.run(
      'UPDATE users SET password_hash = ?, email_verified = 1, updated_at = ? WHERE id = ?',
      passwordHash, Date.now(), user.id
    );
    await User.update(user.id, { name: account.name, email_verified: 1 });
    console.log(`  ♻️  ${account.username} (id=${user.id}) — пароль обновлён`);
  } else {
    user = await User.create({
      username: account.username,
      email: account.email,
      passwordHash,
      name: account.name,
      displayName: account.name,
      role: 'user',
      emailVerified: 1,
    });
    console.log(`  🆕 ${account.username} (id=${user.id}) — создан`);
  }

  // Per-store роль
  if (account.storeRole) {
    await UserStore.upsert(user.id, storeId, {
      role: account.storeRole,
      was_employee: 1,
      is_fired: 0,
      earnings_factor: 1.0,
    });
    console.log(`      → в магазине ${storeId}: ${account.storeRole}`);
  } else {
    // Обычный user — без записи в user_stores
    const existing = await UserStore.get(user.id, storeId);
    if (existing) {
      await UserStore.remove(user.id, storeId);
      console.log(`      → удалена старая запись в user_stores (обычный user)`);
    }
    console.log(`      → без записи в user_stores (обычный user)`);
  }

  return user;
}

(async () => {
  try {
    const storeIds = stores.getStoreIds();
    if (!storeIds.length) {
      throw new Error('Нет ни одного магазина (.env.storeN). Создайте .env.store1.');
    }
    const storeId = storeIds[0];
    console.log(`[seed] Активный магазин: ${storeId}`);
    console.log('');

    await initDB();

    for (const acc of ACCOUNTS) {
      await ensureAccount(acc, storeId);
    }

    console.log('');
    console.log('=========================================================');
    console.log('  DEV-АККАУНТЫ ГОТОВЫ. Логины / пароли:');
    console.log('    admin     / admin123     — админ магазина');
    console.log('    moderator / moderator123 — модератор магазина');
    console.log('    employee  / employee123  — сотрудник магазина');
    console.log('    user      / user123      — обычный пользователь');
    console.log('');
    console.log('  Используйте в auth.http (loginUser/loginEmployee/loginAdmin)');
    console.log('  или логиньтесь через /api/auth/login вручную.');
    console.log('=========================================================');
    console.log('');
  } catch (err) {
    console.error('[seed] Ошибка:', err.message);
    process.exitCode = 1;
  } finally {
    try { await closeAll(); } catch { /* ok */ }
  }
})();