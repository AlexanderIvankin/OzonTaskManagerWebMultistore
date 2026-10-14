#!/usr/bin/env node
/**
 * prune-user-subs.js
 *
 * Чистит таблицу push_subscriptions от накопленного мусора:
 *
 *   Проход 1 — ДЕДУПЛИКАЦИЯ по (user_id, user_agent, origin):
 *     Один и тот же браузер с одним origin никогда не должен иметь >1
 *     подписки. Такие дубли появляются при повторных регистрациях SW,
 *     обновлениях Firefox (endpoint меняется), рестартах сервера с
 *     пересозданием подписки и т.п. Оставляем самую свежую, остальные удаляем.
 *
 *   Проход 2 — ЛИМИТ на пользователя:
 *     Если у пользователя всё равно >N подписок (по умолчанию 10) —
 *     оставляем N самых свежих (по COALESCE(last_used_at, created_at)).
 *
 * Безопасность: по умолчанию DRY-RUN, реальные удаления только с --apply.
 *
 * Использование (из /var/www/ozon/backend):
 *   node scripts/prune-user-subs.js             # dry-run
 *   node scripts/prune-user-subs.js --apply     # удалить
 *   node scripts/prune-user-subs.js --keep=5    # лимит 5 (default 10)
 *   node scripts/prune-user-subs.js --user=2    # только user_id=2
 */

'use strict';

require('dotenv').config();
const { initDB, getUsersDB } = require('../src/config/database');

// ---------- CLI ----------
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const KEEP = (() => {
  const a = argv.find((x) => x.startsWith('--keep='));
  return a ? Math.max(1, parseInt(a.slice(7), 10)) : 10;
})();
const ONLY_USER = (() => {
  const a = argv.find((x) => x.startsWith('--user='));
  return a ? parseInt(a.slice(7), 10) : null;
})();

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: node scripts/prune-user-subs.js [options]

Options:
  --apply         Реально удалять (по умолчанию — dry-run)
  --keep=<N>      Максимум подписок на пользователя (default 10)
  --user=<id>     Обрабатывать только user_id=<id>
  --help, -h      Показать справку
`);
  process.exit(0);
}

// ---------- Хелпер: SQL-условие по user_id (опциональный фильтр) ----------
function userFilter(alias = '') {
  const col = alias ? `${alias}.user_id` : 'user_id';
  return ONLY_USER ? `${col} = ${Number(ONLY_USER)}` : '1=1';
}

async function main() {
  console.log(`Режим: ${APPLY ? '⚠️  APPLY (удаляем)' : '🔍 DRY-RUN (только показываем)'}`);
  console.log(`Лимит подписок на пользователя: ${KEEP}`);
  if (ONLY_USER) console.log(`Фильтр: user_id=${ONLY_USER}`);
  console.log('');

  await initDB();
  const db = getUsersDB();

  // =============================================================
  // ПРОХОД 1 — дедупликация по (user_id, user_agent, origin)
  // =============================================================
  console.log('═══ Проход 1: дедупликация по (user_id, user_agent, origin) ═══');

  // Группы, где больше 1 подписки на одинаковый UA+origin.
  // COALESCE(NULLIF(...)) — пустые/незаданные значения в одну группу.
  const dupGroups = await db.all(`
    SELECT user_id,
           COALESCE(user_agent, '') AS ua,
           COALESCE(origin, '')     AS og,
           COUNT(*)                 AS cnt
    FROM push_subscriptions
    WHERE ${userFilter()}
    GROUP BY user_id, COALESCE(user_agent, ''), COALESCE(origin, '')
    HAVING cnt > 1
    ORDER BY cnt DESC, user_id
  `);

  const dupsToDelete = []; // [{id, userId, ua, og}]

  for (const g of dupGroups) {
    // Все подписки группы, самые свежие первыми.
    const rows = await db.all(
      `SELECT id, COALESCE(last_used_at, created_at) AS fresh
       FROM push_subscriptions
       WHERE user_id = ?
         AND COALESCE(user_agent, '') = ?
         AND COALESCE(origin, '') = ?
       ORDER BY fresh DESC, id DESC`,
      g.user_id, g.ua, g.og
    );
    // Первую оставляем, остальные — в удаление.
    const [keep, ...drop] = rows;
    if (drop.length) {
      const uaShort = g.ua ? g.ua.slice(0, 45) : '—';
      const ogShort = g.og || '—';
      console.log(
        `  user=${g.user_id} ua="${uaShort}" origin="${ogShort}" ` +
        `→ оставляю #${keep.id}, удаляю: ${drop.map((r) => '#' + r.id).join(', ')}`
      );
      for (const r of drop) {
        dupsToDelete.push({ id: r.id, userId: g.user_id });
      }
    }
  }

  if (!dupsToDelete.length) {
    console.log('  дубликатов не найдено ✅');
  }

  // =============================================================
  // ПРОХОД 2 — лимит на пользователя (после дедупликации)
  // =============================================================
  console.log('');
  console.log(`═══ Проход 2: лимит на пользователя (${KEEP}) ═══`);

  // Считаем «эффективное» количество — сколько останется после дедупликации.
  // Это позволяет не удалять лишнее, если после прохода 1 всё уже в норме.
  const dupsByUser = new Map();
  for (const d of dupsToDelete) {
    dupsByUser.set(d.userId, (dupsByUser.get(d.userId) || 0) + 1);
  }

  const userRows = await db.all(`
    SELECT user_id, COUNT(*) AS cnt
    FROM push_subscriptions
    WHERE ${userFilter()}
    GROUP BY user_id
    ORDER BY cnt DESC
  `);

  const overflowToDelete = []; // [{id, userId}]

  for (const u of userRows) {
    const effective = u.cnt - (dupsByUser.get(u.user_id) || 0);
    if (effective <= KEEP) continue;

    // Полный отсортированный список подписок пользователя (свежие первыми).
    const rows = await db.all(
      `SELECT id FROM push_subscriptions
       WHERE user_id = ?
       ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC`,
      u.user_id
    );

    // Отбрасываем те, что и так уже в dupsToDelete.
    const dupIds = new Set(
      dupsToDelete.filter((d) => d.userId === u.user_id).map((d) => d.id)
    );
    const survivors = rows.filter((r) => !dupIds.has(r.id));

    if (survivors.length <= KEEP) continue;

    const overflow = survivors.slice(KEEP);
    console.log(
      `  user=${u.user_id}: было ${u.cnt}, после дедупа ${effective}, ` +
      `оставляю ${KEEP}, удаляю сверх: ${overflow.map((r) => '#' + r.id).join(', ')}`
    );
    for (const r of overflow) {
      overflowToDelete.push({ id: r.id, userId: u.user_id });
    }
  }

  if (!overflowToDelete.length) {
    console.log('  превышений лимита нет ✅');
  }

  // =============================================================
  // ИТОГ
  // =============================================================
  const allIds = [
    ...dupsToDelete.map((d) => d.id),
    ...overflowToDelete.map((o) => o.id),
  ];
  const uniqueIds = [...new Set(allIds)];

  console.log('');
  console.log('═══════════════════ ИТОГ ═══════════════════');
  console.log(`  Дубликатов (проход 1):  ${dupsToDelete.length}`);
  console.log(`  Сверх лимита (проход 2): ${overflowToDelete.length}`);
  console.log(`  Всего к удалению:        ${uniqueIds.length}`);

  if (!uniqueIds.length) {
    console.log('\nЧистить нечего. 🎉');
    return;
  }

  if (!APPLY) {
    console.log('\n🔍 DRY-RUN: реально НЕ удалено. Запусти с --apply, чтобы удалить.');
    return;
  }

  // =============================================================
  // DELETE
  // =============================================================
  // Батчим по 100, чтобы не упереться в SQLITE_MAX_VARIABLE_NUMBER.
  let totalDeleted = 0;
  const BATCH = 100;
  for (let i = 0; i < uniqueIds.length; i += BATCH) {
    const batch = uniqueIds.slice(i, i + BATCH);
    const ph = batch.map(() => '?').join(',');
    const res = await db.run(
      `DELETE FROM push_subscriptions WHERE id IN (${ph})`,
      ...batch
    );
    totalDeleted += res.changes || 0;
  }
  console.log(`\n🗑  Удалено подписок: ${totalDeleted}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nFATAL:', err);
    process.exit(1);
  });