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
 * Приоритет: tg_user_id → email.
 * @returns {{ employeeId: number, matchedBy: 'tg_user_id'|'email' } | null}
 */
async function resolveWebToBot(webUser, botDb) {
  const tg = normalizeTgId(webUser.tg_user_id);
  if (tg) {
    const e = await botDb.get(
      'SELECT id FROM employees WHERE tg_user_id = ?', tg
    );
    if (e) return { employeeId: e.id, matchedBy: 'tg_user_id' };
  }
  const email = normalizeEmail(webUser.email);
  if (email) {
    const e = await botDb.get(
      'SELECT id FROM employees WHERE LOWER(TRIM(email)) = ?', email
    );
    if (e) return { employeeId: e.id, matchedBy: 'email' };
  }
  return null;
}

module.exports = { resolveBotToWeb, resolveWebToBot };