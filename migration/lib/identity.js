const { normalizeEmail, normalizeTgId } = require('./helpers');

/**
 * Bot → Web: найти web-пользователя для бот-сотрудника.
 * Приоритет: tg_user_id → email.
 * @returns {{ userId: number, matchedBy: 'tg_user_id'|'email' } | null}
 */
async function resolveBotToWeb(botEmployee, webDb) {
  const tg = normalizeTgId(botEmployee.tg_user_id);
  if (tg) {
    const u = await webDb.get(
      'SELECT id FROM users WHERE tg_user_id = ?', tg
    );
    if (u) return { userId: u.id, matchedBy: 'tg_user_id' };
  }
  const email = normalizeEmail(botEmployee.email);
  if (email) {
    const u = await webDb.get(
      'SELECT id FROM users WHERE LOWER(TRIM(email)) = ?', email
    );
    if (u) return { userId: u.id, matchedBy: 'email' };
  }
  return null;
}

/**
 * Web → Bot: найти бот-сотрудника для web-пользователя.
 *
 * Приоритет: tg_user_id → email.
 *
 * Особенность BOT-схемы: `employees.email` — БЕЗ UNIQUE, поэтому по одному
 * email может быть несколько записей. Это «плохой» случай (такое бывает
 * только если один человек работал под разными tg, но с одним email, и
 * потом был уволен, а email достался новому).
 *
 * Разрешение коллизии по email:
 *   1. Если найдено ровно одно совпадение — берём его.
 *   2. Если найдено несколько — фильтруем по is_fired = 0 (актуальные).
 *      a. Если остался ровно один — берём его.
 *      b. Иначе (0 или >1 активных) — это неразрешимая неоднозначность:
 *         возвращаем { ambiguous: true, ... }. Вызывающая сторона
 *         (web-to-bot.js) должна залогировать ошибку и пропустить
 *         пользователя, не создавая и не обновляя ничего в bot.
 *
 * @returns {Promise<
 *   | { employeeId: number, matchedBy: 'tg_user_id'|'email', resolvedFromConflict?: boolean, conflictTotal?: number }
 *   | { ambiguous: true, email: string, candidates: Array<{id:number, is_fired:number}>, reason: string }
 *   | null
 * >}
 */
async function resolveWebToBot(webUser, botDb) {
  // 1. По tg_user_id — BOT-таблица UNIQUE по tg, коллизий тут быть не может.
  const tg = normalizeTgId(webUser.tg_user_id);
  if (tg) {
    const e = await botDb.get(
      'SELECT id FROM employees WHERE tg_user_id = ?', tg
    );
    if (e) return { employeeId: e.id, matchedBy: 'tg_user_id' };
  }

  // 2. По email.
  const email = normalizeEmail(webUser.email);
  if (!email) return null;

  const matches = await botDb.all(
    'SELECT id, is_fired FROM employees WHERE LOWER(TRIM(email)) = ? ORDER BY id',
    email
  );

  if (matches.length === 0) return null;
  if (matches.length === 1) {
    return { employeeId: matches[0].id, matchedBy: 'email' };
  }

  // Несколько записей по email: пробуем оставить актуального (is_fired = 0).
  const active = matches.filter((m) => !m.is_fired);

  if (active.length === 1) {
    return {
      employeeId: active[0].id,
      matchedBy: 'email',
      resolvedFromConflict: true,
      conflictTotal: matches.length,
    };
  }

  // 0 или >1 активных — неоднозначность, разрешить не можем.
  return {
    ambiguous: true,
    email,
    candidates: matches.map((m) => ({ id: m.id, is_fired: m.is_fired || 0 })),
    reason:
      active.length === 0
        ? 'все совпадения по email уволены (is_fired=1)'
        : `активных записей по email больше одной (${active.length})`,
  };
}

module.exports = { resolveBotToWeb, resolveWebToBot };