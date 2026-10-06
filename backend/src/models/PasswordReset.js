const { getDB } = require('../config/database');

class PasswordReset {
  static async create(userId, code, expiresInMinutes = 15) {
    const db = getDB();
    const now = Date.now();
    const expiresAt = now + expiresInMinutes * 60 * 1000;
    await db.run(
      `INSERT INTO password_resets (user_id, code, expires_at, created_at) VALUES (?, ?, ?, ?)`,
      userId, code, expiresAt, now
    );
  }

  static async findByCode(code) {
    const db = getDB();
    return db.get(
      `SELECT * FROM password_resets WHERE code = ? AND expires_at > ? ORDER BY id DESC LIMIT 1`,
      code, Date.now()
    );
  }

  static async getLatestByUserId(userId) {
    const db = getDB();
    return db.get(
      `SELECT * FROM password_resets
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      userId
    );
  }

  static async deleteByUserId(userId) {
    const db = getDB();
    await db.run('DELETE FROM password_resets WHERE user_id = ?', userId);
  }

  static async deleteByCode(code) {
    const db = getDB();
    await db.run('DELETE FROM password_resets WHERE code = ?', code);
  }

  static async deleteExpired() {
    const db = getDB();
    const result = await db.run(
      'DELETE FROM password_resets WHERE expires_at < ?',
      Date.now()
    );
    return (result && result.changes) || 0;
  }
}

module.exports = PasswordReset;
