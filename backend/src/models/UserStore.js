// src/models/UserStore.js
const { getUsersDB } = require('../config/database');

/**
 * Per-store связь пользователя с магазином.
 *
 * Одна запись = «пользователь X имеет статус в магазине Y».
 * Нет записи — не имеет отношения к магазину.
 *
 * Поля:
 *   • role           — 'employee' | 'moderator' | 'admin' | 'god'
 *   • is_fired       — уволен в этом магазине
 *   • earnings_factor — коэффициент заработка в этом магазине
 *   • was_employee   — был ли сотрудником этого магазина (для фильтра «включая уволенных»)
 */
class UserStore {
  static async get(userId, storeId) {
    const db = getUsersDB();
    return (
      (await db.get(
        'SELECT * FROM user_stores WHERE user_id = ? AND store_id = ?',
        userId, String(storeId)
      )) || null
    );
  }

  /**
   * Создать/обновить запись. Все поля опциональны.
   * При обновлении перезаписывается только то, что передано.
   */
  static async upsert(userId, storeId, fields = {}) {
    const db = getUsersDB();
    const sid = String(storeId);
    const existing = await this.get(userId, sid);
    const now = Date.now();

    if (existing) {
      const allowed = ['role', 'is_fired', 'earnings_factor', 'was_employee'];
      const setClauses = [];
      const values = [];
      for (const [k, v] of Object.entries(fields)) {
        if (allowed.includes(k) && v !== undefined) {
          setClauses.push(`${k} = ?`);
          values.push(v);
        }
      }
      if (!setClauses.length) return existing;
      values.push(now, userId, sid);
      await db.run(
        `UPDATE user_stores SET ${setClauses.join(', ')}, updated_at = ?
         WHERE user_id = ? AND store_id = ?`,
        values
      );
    } else {
      await db.run(
        `INSERT INTO user_stores
           (user_id, store_id, role, is_fired, earnings_factor, was_employee,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        userId, sid,
        fields.role || 'employee',
        fields.is_fired || 0,
        fields.earnings_factor ?? 1.0,
        fields.was_employee ?? 1,
        now, now
      );
    }
    return this.get(userId, sid);
  }

  /**
   * Все магазины пользователя.
   */
  static async listByUser(userId) {
    const db = getUsersDB();
    return db.all(
      'SELECT * FROM user_stores WHERE user_id = ? ORDER BY store_id',
      userId
    );
  }

  /**
   * Все записи магазина (сырые факты user_stores).
   */
  static async listByStore(storeId, { includeFired = true } = {}) {
    const db = getUsersDB();
    const conditions = ['store_id = ?'];
    const params = [String(storeId)];
    if (!includeFired) conditions.push('is_fired = 0');
    return db.all(
      `SELECT * FROM user_stores WHERE ${conditions.join(' AND ')} ORDER BY user_id`,
      params
    );
  }

  static async remove(userId, storeId) {
    const db = getUsersDB();
    await db.run(
      'DELETE FROM user_stores WHERE user_id = ? AND store_id = ?',
      userId, String(storeId)
    );
  }

  /** Уволить (сохраняя роль). */
  static async fire(userId, storeId) {
    return this.upsert(userId, storeId, { is_fired: 1 });
  }

  /** Восстановить (is_fired=0, роль сохраняется). */
  static async restore(userId, storeId) {
    return this.upsert(userId, storeId, { is_fired: 0 });
  }

  /** Сменить роль в магазине. */
  static async setRole(userId, storeId, role) {
    return this.upsert(userId, storeId, { role });
  }
}

module.exports = UserStore;