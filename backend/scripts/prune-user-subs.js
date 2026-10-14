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

  // ВАЖНО: дедуплицируем ТОЛЬКО строки с ЗАПОЛНЕННЫМ origin.
  // При origin = NULL нельзя понять — это дубликаты одной подписки или
  // РАЗНЫЕ origin'ы (na3d.ru vs store1.na3d.ru) одного браузера.
  // Такие строки не трогаем — они и так схлопнутся, когда юзер перезайдёт
  // на каждый домен (origin заполнится через subscribe()).
  const dupGroups = await db.all(`
    SELECT user_id,
           COALESCE(user_agent, '') AS ua,
           origin                   AS og,
           COUNT(*)                 AS cnt
    FROM push_subscriptions
    WHERE ${userFilter()}
      AND origin IS NOT NULL
      AND origin != ''
    GROUP BY user_id, COALESCE(user_agent, ''), origin
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
  // ПРОХОД 2 — лимит УСТРОЙСТВ на пользователя (после дедупликации)
  // =============================================================
  //
  // Одно устройство = один user_agent. У устройства может быть МНОГО
  // подписок (по одной на origin: na3d.ru + каждый поддомен магазина).
  // Лимит — на устройства, а не на подписки.
  console.log('');
  console.log(`═══ Проход 2: лимит УСТРОЙСТВ на пользователя (${KEEP}) ═══`);

  // Собираем «выживших» после Прохода 1 — чтобы не учитывать уже удалённых.
  const dupIdsSet = new Set(dupsToDelete.map((d) => d.id));
  const allRows = await db.all(
    `SELECT id, user_id, COALESCE(user_agent,'') AS ua,
            COALESCE(last_used_at, created_at) AS fresh
     FROM push_subscriptions
     WHERE ${userFilter()}
     ORDER BY user_id, fresh ASC, id ASC`
  );
  const survivors = allRows.filter((r) => !dupIdsSet.has(r.id));

  // Группируем по user_id → ua
  const devicesByUser = new Map(); // user_id -> [{ua, ids, oldest}]
  for (const r of survivors) {
    if (!devicesByUser.has(r.user_id)) devicesByUser.set(r.user_id, new Map());
    const m = devicesByUser.get(r.user_id);
    if (!m.has(r.ua)) m.set(r.ua, { ua: r.ua, ids: [], oldest: r.fresh });
    const d = m.get(r.ua);
    d.ids.push(r.id);
    if (r.fresh < d.oldest) d.oldest = r.fresh;
  }

  const overflowToDelete = []; // [{id, userId}]

  for (const [userId, devMap] of devicesByUser) {
    const devices = [...devMap.values()].sort((a, b) => a.oldest - b.oldest);
    if (devices.length <= KEEP) continue;

    const excess = devices.slice(0, devices.length - KEEP);
    for (const d of excess) {
      const uaShort = d.ua ? d.ua.slice(0, 45) : '—';
      console.log(
        `  user=${userId}: устройств ${devices.length} > ${KEEP}, ` +
        `удаляю старое устройство ua="${uaShort}" ` +
        `(подписок: ${d.ids.length}, ids: ${d.ids.map((x) => '#' + x).join(', ')})`
      );
      for (const id of d.ids) overflowToDelete.push({ id, userId });
    }
  }

  if (!overflowToDelete.length) {
    console.log('  превышений лимита устройств нет ✅');
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
  console.log(`  Подписок старых устройств:   ${overflowToDelete.length}`);
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