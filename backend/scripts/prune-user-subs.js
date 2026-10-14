#!/usr/bin/env node
/**
 * prune-user-subs.js
 *
 * Разовая чистка: у каждого пользователя оставляет только N самых свежих
 * push-подписок (по COALESCE(last_used_at, created_at)). Запускать один раз
 * после деплоя фикса с MAX_SUBS_PER_USER, чтобы убрать исторический мусор.
 *
 * Использование:
 *   node scripts/prune-user-subs.js             # dry-run (по умолчанию)
 *   node scripts/prune-user-subs.js --apply
 *   node scripts/prune-user-subs.js --keep=5    # оставить по 5 (по умолчанию 10)
 */

'use strict';

require('dotenv').config();
const { initDB, getUsersDB } = require('../src/config/database');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const KEEP = (() => {
  const arg = argv.find((a) => a.startsWith('--keep='));
  return arg ? Math.max(1, parseInt(arg.slice(7), 10)) : 10;
})();

async function main() {
  await initDB();
  const db = getUsersDB();

  console.log(`Режим: ${APPLY ? '⚠️  APPLY' : '🔍 DRY-RUN'}, оставляем ${KEEP} свежих на пользователя`);

  const users = await db.all(`
    SELECT user_id, COUNT(*) AS cnt
    FROM push_subscriptions
    GROUP BY user_id
    HAVING cnt > ?
    ORDER BY cnt DESC
  `, KEEP);

  if (!users.length) {
    console.log('Все пользователи в лимите — чистить нечего. 🎉');
    return;
  }

  console.log(`\nПользователей сверх лимита: ${users.length}\n`);

  let totalDeleted = 0;
  for (const u of users) {
    const old = await db.all(
      `SELECT id FROM push_subscriptions
       WHERE user_id = ?
       ORDER BY COALESCE(last_used_at, created_at) ASC
       LIMIT ?`,
      u.user_id, u.cnt - KEEP
    );
    const ids = old.map((r) => r.id);
    console.log(`  user=${u.user_id}: ${u.cnt} → ${KEEP} (удалить ${ids.length})`);

    if (APPLY && ids.length) {
      const ph = ids.map(() => '?').join(',');
      const res = await db.run(
        `DELETE FROM push_subscriptions WHERE id IN (${ph})`,
        ...ids
      );
      totalDeleted += res.changes;
    }
  }

  if (APPLY) {
    console.log(`\n✅ Удалено всего: ${totalDeleted}`);
  } else {
    console.log(`\n🔍 DRY-RUN: запусти с --apply, чтобы удалить.`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e); process.exit(1); });