#!/usr/bin/env node
/**
 * prune-push-subs.js
 *
 * Проверяет все Web Push подписки тестовым уведомлением и удаляет мёртвые.
 * Безопасно: живые (200/201/202) НЕ удаляются. По умолчанию — dry-run.
 *
 * Использование (из /var/www/ozon/backend):
 *   node scripts/prune-push-subs.js                    # dry-run (ничего не удаляем)
 *   node scripts/prune-push-subs.js --apply            # удалить мёртвые
 *   node scripts/prune-push-subs.js --user=20          # только подписки user_id=20
 *   node scripts/prune-push-subs.js --apply --user=20  # удалить только у user_id=20
 *   node scripts/prune-push-subs.js --delay=500        # пауза между отправками (мс)
 */

'use strict';

require('dotenv').config();

const path = require('path');

// Скрипт лежит в backend/scripts/, конфиги — в backend/src/.
// Подключаемся к тем же модулям, что и сервер, чтобы использовать
// реальные VAPID-ключи и per-store subject из stores.js.
const config = require('../src/config');
const stores = require('../src/config/stores');
const { initDB, getUsersDB } = require('../src/config/database');

let webpush;
try {
  webpush = require('web-push');
} catch (err) {
  console.error('web-push не установлен:', err.message);
  process.exit(1);
}

// ---------- CLI ----------
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const USER_ARG = argv.find((a) => a.startsWith('--user='));
const DELAY_ARG = argv.find((a) => a.startsWith('--delay='));
const ONLY_USER = USER_ARG ? parseInt(USER_ARG.slice(7), 10) : null;
const DELAY_MS = DELAY_ARG ? Math.max(0, parseInt(DELAY_ARG.slice(8), 10)) : 200;

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: node scripts/prune-push-subs.js [options]

Options:
  --apply         Реально удалять мёртвые подписки (по умолчанию — dry-run)
  --user=<id>     Проверять только подписки указанного user_id
  --delay=<ms>    Пауза между отправками (по умолчанию 200 мс)
  --help, -h      Показать справку
`);
  process.exit(0);
}

// ---------- VAPID ----------
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  console.error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY не заданы в .env — push не настроен.');
  process.exit(1);
}

/**
 * VAPID-детали для конкретной отправки. Аналогично PushService.getVapidDetails:
 * subject — per-store, если магазин известен.
 * Скрипт используется для диагностики, поэтому subject берём общий дефолт:
 * магазин пользователя неизвестен (подписка глобальная).
 */
const defaultSubject =
  (config.push && config.push.vapidDefaultSubject) ||
  process.env.DEFAULT_VAPID_SUBJECT ||
  'mailto:admin@your-domain.com';

// ---------- Коды ответов push-сервисов ----------
/**
 * Мёртвая подписка: удаляем без раздумий.
 *   400 — битые ключи (p256dh/auth повреждены);
 *   403 — VAPID subject отклонён;
 *   404/410 — браузер отписался / подписка удалена;
 *   413 — payload слишком большой (FCM 4KB).
 */
function isDead(code) {
  return code === 400 || code === 403 || code === 404 || code === 410 || code === 413;
}

// ---------- Main ----------
async function main() {
  console.log(`VAPID subject (default): ${defaultSubject}`);
  console.log(`Режим: ${APPLY ? '⚠️  APPLY (удаляем мёртвые)' : '🔍 DRY-RUN (только показываем)'}`);
  if (ONLY_USER) console.log(`Фильтр: только user_id=${ONLY_USER}`);
  console.log(`Задержка между отправками: ${DELAY_MS} мс`);
  console.log('');

  await initDB();
  const db = getUsersDB();

  const where = ONLY_USER ? 'WHERE user_id = ?' : '';
  const params = ONLY_USER ? [ONLY_USER] : [];
  const subs = await db.all(
    `SELECT id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at
     FROM push_subscriptions ${where}
     ORDER BY id`,
    ...params
  );

  if (!subs.length) {
    console.log('Подписок не найдено. Нечего проверять.');
    return;
  }

  console.log(`Проверяем ${subs.length} подписок...\n`);

  const payload = JSON.stringify({
    title: 'Проверка подписки',
    body: 'Если вы видите это — push работает.',
    tag: 'prune-check',
    url: '/',
  });

  const alive = [];
  const dead = [];
  const unknown = [];

  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    const prefix = `[${String(i + 1).padStart(3, ' ')}/${subs.length}] #${s.id} user=${s.user_id}`;

    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        {
          TTL: 60,
          vapidDetails: {
            subject: defaultSubject,
            publicKey: process.env.VAPID_PUBLIC_KEY,
            privateKey: process.env.VAPID_PRIVATE_KEY,
          },
        }
      );
      alive.push(s.id);
      console.log(`${prefix} ✅ alive`);
    } catch (err) {
      const code = err?.statusCode ?? '?';
      const msg = (err?.message || '').split('\n')[0];
      if (isDead(code)) {
        dead.push(s.id);
        console.log(`${prefix} 💀 DEAD (status=${code}) — ${msg}`);
      } else {
        unknown.push({ id: s.id, code, msg });
        console.log(`${prefix} ⚠️  UNKNOWN (status=${code}) — ${msg}`);
      }
    }

    if (DELAY_MS > 0 && i < subs.length - 1) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  // ---------- Итог ----------
  console.log('\n═══════════════════ ИТОГ ═══════════════════');
  console.log(`  ✅ Живых:           ${alive.length}`);
  console.log(`  💀 Мёртвых:         ${dead.length}`);
  console.log(`  ⚠️  Неизвестных:    ${unknown.length}`);

  if (unknown.length) {
    const codes = [...new Set(unknown.map((u) => u.code))].sort();
    console.log(`     Коды "неизвестных": ${codes.join(', ')}`);
    console.log('     (это не 400/403/404/410/413 — возможно, временный сбой push-сервиса)');
  }

  if (!dead.length) {
    console.log('\nМёртвых подписок нет — чистить нечего. 🎉');
    return;
  }

  if (!APPLY) {
    console.log(`\n🔍 DRY-RUN: реально НЕ удалено. Запусти с --apply, чтобы удалить ${dead.length} мёртвых подписок.`);
    console.log(`   Список id для удаления: ${dead.join(', ')}`);
    return;
  }

  // ---------- DELETE ----------
  const placeholders = dead.map(() => '?').join(',');
  const res = await db.run(
    `DELETE FROM push_subscriptions WHERE id IN (${placeholders})`,
    ...dead
  );
  console.log(`\n🗑  Удалено подписок: ${res.changes}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nFATAL:', err);
    process.exit(1);
  });