const { getDB } = require('../config/database');

class EmailVerification {
  static async create(userId, code, expiresInMinutes = 15) {
    const db = getDB();
    const now = Date.now();
    const expiresAt = now + expiresInMinutes * 60 * 1000;
    await db.run(
      `INSERT INTO email_verifications (user_id, code, expires_at, created_at) VALUES (?, ?, ?, ?)`,
      userId, code, expiresAt, now
    );
  }

  static async findByCode(code) {
    const db = getDB();
    return db.get(
      `SELECT * FROM email_verifications WHERE code = ? AND expires_at > ?`,
      code, Date.now()
    );
  }

  /**
   * Последний (самый свежий) код пользователя — для антифлуда повторной
   * отправки письма (не чаще, чем раз в RESEND_CODE_COOLDOWN_SEC секунд).
   */
  static async getLatestByUserId(userId) {
    const db = getDB();
    return db.get(
      `SELECT * FROM email_verifications
       WHERE user_id = ?
       ORDER BY COALESCE(created_at, expires_at) DESC, id DESC
       LIMIT 1`,
      userId
    );
  }

  static async deleteByUserId(userId) {
    const db = getDB();
    await db.run('DELETE FROM email_verifications WHERE user_id = ?', userId);
  }

  static async deleteByCode(code) {
    const db = getDB();
    await db.run('DELETE FROM email_verifications WHERE code = ?', code);
  }

  /**
   * Удаляет все просроченные коды — в том числе «легаси»-строки аккаунтов,
   * которые так и не подтвердили email. Возвращает число удалённых строк.
   */
  static async deleteExpired() {
    const db = getDB();
    const result = await db.run(
      'DELETE FROM email_verifications WHERE expires_at < ?',
      Date.now()
    );
    return (result && result.changes) || 0;
  }
}

module.exports = EmailVerification;