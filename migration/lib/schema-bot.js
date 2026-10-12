// migration/lib/schema-bot.js
//
// Минимальная DDL-схема BOT-версии (bot-N.db).
// Используется web-to-bot.js для создания файла «с нуля» (например, при
// проверке round-trip или тестовом прогоне).
//
// ⚠️ Все CREATE — IF NOT EXISTS, поэтому вызов безопасен на существующей
// БД: ничего не сломает. Список колонок совпадает с bot/db.js.

async function createBotSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_user_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      capacity INTEGER DEFAULT 1,
      email TEXT,
      phone TEXT,
      is_fired INTEGER DEFAULT 0,
      earnings_factor REAL DEFAULT 1.0,
      taking_orders INTEGER DEFAULT 1,
      tg_username TEXT
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS assignments (
      order_id TEXT PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      assigned_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT DEFAULT 'assigned',
      deliver_reminder_sent_at INTEGER,
      deliver_reminder_count INTEGER DEFAULT 0,
      order_amount REAL,
      offer_ids TEXT,
      products_json TEXT,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS warehouses (
      warehouse_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      is_rfbs INTEGER DEFAULT 0,
      last_synced_at INTEGER
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS employee_warehouses (
      employee_id INTEGER NOT NULL,
      warehouse_id TEXT NOT NULL,
      FOREIGN KEY (employee_id) REFERENCES employees(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(warehouse_id),
      PRIMARY KEY (employee_id, warehouse_id)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS employee_stats (
      employee_id INTEGER PRIMARY KEY,
      total_orders INTEGER DEFAULT 0,
      total_amount INTEGER DEFAULT 0,
      canceled_orders INTEGER DEFAULT 0,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS employee_earnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      amount REAL NOT NULL,
      calculated_at INTEGER NOT NULL,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_employee_earnings_employee_id ON employee_earnings(employee_id)`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS employee_earnings_active (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      amount REAL NOT NULL,
      calculated_at INTEGER NOT NULL,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS employee_earnings_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      reason TEXT,
      adjusted_at INTEGER NOT NULL,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_adjustments_employee_id ON employee_earnings_adjustments(employee_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_adjustments_adjusted_at ON employee_earnings_adjustments(adjusted_at)`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS employee_earnings_adjustments_active (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      reason TEXT,
      adjusted_at INTEGER NOT NULL,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_adjustments_active_employee_id ON employee_earnings_adjustments_active(employee_id)`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS product_stats (
      offer_id TEXT PRIMARY KEY,
      material TEXT NOT NULL,
      color TEXT NOT NULL,
      weight_grams REAL NOT NULL,
      employee_id INTEGER,
      updated_at INTEGER,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS product_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      file_name TEXT,
      file_size INTEGER,
      uploaded_at INTEGER
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_product_models_offer_id ON product_models(offer_id)`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS issued_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      offer_id TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_issued_models_employee_offer ON issued_models(employee_id, offer_id)`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS skipped_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      reason TEXT,
      file_size_mb REAL,
      created_at INTEGER
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_skipped_models_offer_id ON skipped_models(offer_id)`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS migration_status (
      migration TEXT PRIMARY KEY,
      completed_at INTEGER NOT NULL
    )
  `);
}

module.exports = { createBotSchema };