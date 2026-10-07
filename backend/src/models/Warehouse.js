const { getStoreDB } = require('../config/database');

/**
 * Склады и связи пользователь↔склад (store-N.db).
 * Все методы принимают storeId первым аргументом.
 */
class Warehouse {
  /**
   * Синхронизировать список складов (upsert + удаление отсутствующих
   * вместе со связями user_warehouses).
   */
  static async syncAll(storeId, warehouses) {
    const db = getStoreDB(storeId);
    const now = Date.now();
    const incomingIds = new Set(warehouses.map((w) => String(w.warehouse_id)));

    const existing = await db.all('SELECT warehouse_id FROM warehouses');
    for (const row of existing) {
      if (incomingIds.has(String(row.warehouse_id))) continue;
      await db.run('DELETE FROM user_warehouses WHERE warehouse_id = ?', row.warehouse_id);
      await db.run('DELETE FROM warehouses WHERE warehouse_id = ?', row.warehouse_id);
    }

    for (const wh of warehouses) {
      await db.run(
        `INSERT INTO warehouses (warehouse_id, name, address, is_rfbs, last_synced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(warehouse_id) DO UPDATE SET
           name = excluded.name,
           address = excluded.address,
           is_rfbs = excluded.is_rfbs,
           last_synced_at = excluded.last_synced_at`,
        wh.warehouse_id, wh.name, wh.address || null,
        wh.is_rfbs ? 1 : 0, now
      );
    }
  }

  static async getAll(storeId) {
    const db = getStoreDB(storeId);
    return db.all('SELECT warehouse_id, name, address, is_rfbs FROM warehouses ORDER BY name');
  }

  static async getById(storeId, warehouseId) {
    const db = getStoreDB(storeId);
    return db.get('SELECT * FROM warehouses WHERE warehouse_id = ?', warehouseId);
  }

  static async getNameById(storeId, warehouseId) {
    const db = getStoreDB(storeId);
    const result = await db.get(
      'SELECT name FROM warehouses WHERE warehouse_id = ?', warehouseId
    );
    return result ? result.name : warehouseId;
  }

  static async addUserWarehouse(storeId, userId, warehouseId) {
    const db = getStoreDB(storeId);
    const exists = await db.get(
      'SELECT 1 FROM warehouses WHERE warehouse_id = ?', warehouseId
    );
    if (!exists) {
      console.warn(`[Warehouse] store=${storeId}: склад ${warehouseId} отсутствует, пропускаем связь с user ${userId}`);
      return false;
    }
    await db.run(
      `INSERT OR IGNORE INTO user_warehouses (user_id, warehouse_id)
       VALUES (?, ?)`,
      userId, warehouseId
    );
    return true;
  }

  static async removeUserWarehouse(storeId, userId, warehouseId) {
    const db = getStoreDB(storeId);
    await db.run(
      'DELETE FROM user_warehouses WHERE user_id = ? AND warehouse_id = ?',
      userId, warehouseId
    );
  }

  static async getUserWarehouses(storeId, userId) {
    const db = getStoreDB(storeId);
    return db.all(`
      SELECT w.warehouse_id, w.name, w.address, w.is_rfbs
      FROM user_warehouses uw
      JOIN warehouses w ON uw.warehouse_id = w.warehouse_id
      WHERE uw.user_id = ?
      ORDER BY w.name
    `, userId);
  }

  static async clearUserWarehouses(storeId, userId) {
    const db = getStoreDB(storeId);
    await db.run('DELETE FROM user_warehouses WHERE user_id = ?', userId);
  }
}

module.exports = Warehouse;