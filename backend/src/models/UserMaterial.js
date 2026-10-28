// Глобальная таблица материалов в наличии у сотрудника (users.db).
// Строка = наличие одного цвета одного материала. Отсутствие строки = нет.
// Используется страницей «Мои материалы» (глобальной) и (в будущем)
// приоритетом назначения заказов по наличию.

const { getUsersDB } = require('../config/database');

class UserMaterial {
  /** @returns {Promise<Record<string, string[]>>} material -> [colors] */
  static async listByUser(userId) {
    const db = getUsersDB();
    const rows = await db.all(
      'SELECT material, color FROM user_materials WHERE user_id = ? ORDER BY material, color',
      userId
    );
    const result = {};
    for (const r of rows) {
      if (!result[r.material]) result[r.material] = [];
      result[r.material].push(r.color);
    }
    return result;
  }

  /**
   * Заменить цвета одного материала (атомарно).
   * Пустой массив = удалить все цвета этого материала.
   */
  static async replaceMaterial(userId, material, colors) {
    const db = getUsersDB();
    const now = Date.now();
    const unique = Array.from(new Set(colors));

    await db.run('BEGIN IMMEDIATE');
    try {
      await db.run(
        'DELETE FROM user_materials WHERE user_id = ? AND material = ?',
        userId, material
      );
      for (const color of unique) {
        await db.run(
          'INSERT INTO user_materials (user_id, material, color, created_at) VALUES (?, ?, ?, ?)',
          userId, material, color, now
        );
      }
      await db.run('COMMIT');
    } catch (err) {
      try { await db.run('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  static async deleteAllForUser(userId) {
    const db = getUsersDB();
    await db.run('DELETE FROM user_materials WHERE user_id = ?', userId);
  }
}

module.exports = UserMaterial;