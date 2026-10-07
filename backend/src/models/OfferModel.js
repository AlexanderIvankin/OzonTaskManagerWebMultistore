const crypto = require('crypto');
const { getModelsDB } = require('../config/database');

/**
 * 3D-модели (models.db, общая для ВСЕХ магазинов).
 *
 * БЕЗ storeId — модели и факты выдачи глобальны.
 * JOIN с users через схему 'usersdb' (ATTACH users.db).
 */
class OfferModel {
  // ============================ offer_models ============================

  static async get(offerId) {
    const db = getModelsDB();
    return db.get('SELECT * FROM offer_models WHERE offer_id = ?', offerId);
  }

  static async set(offerId, { s3Key, fileName, fileSize, uploadedBy, etag = null, uploadedAt = null }) {
    const db = getModelsDB();
    await db.run(
      `INSERT INTO offer_models
         (offer_id, s3_key, file_name, s3_etag, file_size, uploaded_at, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(offer_id) DO UPDATE SET
         s3_key = excluded.s3_key,
         file_name = excluded.file_name,
         s3_etag = excluded.s3_etag,
         file_size = excluded.file_size,
         uploaded_at = excluded.uploaded_at,
         uploaded_by = excluded.uploaded_by`,
      offerId, s3Key, fileName || `${offerId}.zip`, etag, fileSize,
      uploadedAt || Date.now(), uploadedBy
    );
    return this.get(offerId);
  }

  static async syncEntry(offerId, { s3Key, fileName, fileSize = null, uploadedAt = null, etag = null }) {
    const db = getModelsDB();
    const prev = await db.get('SELECT s3_etag FROM offer_models WHERE offer_id = ?', offerId);
    await db.run(
      `INSERT INTO offer_models
         (offer_id, s3_key, file_name, s3_etag, file_size, uploaded_at, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(offer_id) DO UPDATE SET
         s3_key = excluded.s3_key,
         file_name = excluded.file_name,
         s3_etag = COALESCE(excluded.s3_etag, offer_models.s3_etag),
         file_size = COALESCE(excluded.file_size, offer_models.file_size),
         uploaded_at = COALESCE(excluded.uploaded_at, offer_models.uploaded_at)`,
      offerId, s3Key, fileName || `${offerId}.zip`, etag, fileSize, uploadedAt
    );
    const created = !prev;
    const changed = !!(prev && prev.s3_etag && etag && prev.s3_etag !== etag);
    return { created, changed, record: await this.get(offerId) };
  }

  static async delete(offerId) {
    const db = getModelsDB();
    await db.run('DELETE FROM offer_models WHERE offer_id = ?', offerId);
  }

  static async getAll() {
    const db = getModelsDB();
    return db.all(`
      SELECT om.*, u.name AS uploaded_by_name,
        (SELECT COUNT(DISTINCT im.user_id)
           FROM issued_models im
           JOIN usersdb.users us ON us.id = im.user_id AND us.taking_orders = 1
          WHERE im.offer_id = om.offer_id
             OR im.offer_id = om.offer_id || 'R'
             OR im.offer_id = om.offer_id || 'L') AS issued_count
      FROM offer_models om
      LEFT JOIN usersdb.users u ON u.id = om.uploaded_by
      ORDER BY om.offer_id
    `);
  }

  static async getBatch(offerIds) {
    const result = new Map();
    if (!Array.isArray(offerIds) || !offerIds.length) return result;
    const db = getModelsDB();
    const placeholders = offerIds.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT * FROM offer_models WHERE offer_id IN (${placeholders})`,
      ...offerIds
    );
    for (const row of rows) result.set(row.offer_id, row);
    return result;
  }

  static async getUsersWithIssuedAny(offerId) {
    const db = getModelsDB();
    return db.all(
      `SELECT DISTINCT im.user_id, u.taking_orders
       FROM issued_models im
       LEFT JOIN usersdb.users u ON im.user_id = u.id
       WHERE im.offer_id = ?
          OR im.offer_id = ? || 'R'
          OR im.offer_id = ? || 'L'`,
      offerId, offerId, offerId
    );
  }

  // ============================ issued_models ============================

  static async addIssued(userId, offerId) {
    const db = getModelsDB();
    const existing = await db.get(
      'SELECT id FROM issued_models WHERE user_id = ? AND offer_id = ?',
      userId, offerId
    );
    if (existing) return false;
    await db.run(
      'INSERT INTO issued_models (user_id, offer_id, issued_at) VALUES (?, ?, ?)',
      userId, offerId, Date.now()
    );
    return true;
  }

  static async getIssuedOfferIds(userId) {
    const db = getModelsDB();
    const rows = await db.all(
      'SELECT offer_id FROM issued_models WHERE user_id = ?',
      userId
    );
    return rows.map((r) => r.offer_id);
  }

  static async hasIssuedAny(userId, offerIds) {
    if (!Array.isArray(offerIds) || !offerIds.length) return false;
    const db = getModelsDB();
    const placeholders = offerIds.map(() => '?').join(',');
    const row = await db.get(
      `SELECT 1 FROM issued_models
       WHERE user_id = ? AND offer_id IN (${placeholders}) LIMIT 1`,
      userId, ...offerIds
    );
    return !!row;
  }

  static async matchIssued(userId, offerIds) {
    if (!Array.isArray(offerIds) || !offerIds.length) return null;
    const db = getModelsDB();
    for (const offerId of offerIds) {
      const row = await db.get(
        'SELECT offer_id FROM issued_models WHERE user_id = ? AND offer_id = ? LIMIT 1',
        userId, offerId
      );
      if (row) return row.offer_id;
    }
    return null;
  }

  static async getIssuedCount(userId) {
    const db = getModelsDB();
    const row = await db.get(
      'SELECT COUNT(*) AS count FROM issued_models WHERE user_id = ?',
      userId
    );
    return row ? row.count : 0;
  }

  // ======================= model_download_tokens ========================

  static async createToken(offerId, userId, ttlMs = 15 * 60 * 1000) {
    const db = getModelsDB();
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + ttlMs;
    await db.run(
      `INSERT INTO model_download_tokens
         (offer_id, user_id, token, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      offerId, userId, token, expiresAt, Date.now()
    );
    return { token, expiresAt };
  }

  static async getLiveToken(token) {
    const db = getModelsDB();
    const row = await db.get('SELECT * FROM model_download_tokens WHERE token = ?', token);
    if (!row) return null;
    if (row.used_at) return null;
    if (row.expires_at <= Date.now()) return null;
    return row;
  }

  static async markTokenUsed(token) {
    const db = getModelsDB();
    await db.run(
      'UPDATE model_download_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL',
      Date.now(), token
    );
  }

  static async pruneExpiredTokens() {
    const db = getModelsDB();
    const res = await db.run(
      'DELETE FROM model_download_tokens WHERE expires_at < ? OR used_at IS NOT NULL',
      Date.now()
    );
    return res.changes || 0;
  }
}

module.exports = OfferModel;