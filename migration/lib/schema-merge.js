/**
 * Полная схема bot_web-N.db (для merge).
 * ВАЖНО: сохраняем поля was_employee, is_fired, earnings_factor, capacity, taking_orders
 * — при merge восстанавливаем их из users + user_stores.
 */
async function createFullBotWebSchema(db) {
  // --- USERS (полная схема bot_web) ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      phone TEXT,
      capacity INTEGER DEFAULT 1,
      earnings_factor REAL DEFAULT 1.0,
      role TEXT DEFAULT 'user',
      is_fired INTEGER DEFAULT 0,
      taking_orders INTEGER DEFAULT 1,
      tg_user_id TEXT UNIQUE,
      email_verified INTEGER DEFAULT 0,
      was_employee INTEGER NOT NULL DEFAULT 0,
      display_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');

  // --- AUTH-ХВОСТЫ ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_password_resets_code ON password_resets(code)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)');

  // --- ASSIGNMENTS ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS assignments (
      order_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      assigned_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT DEFAULT 'assigned',
      deliver_reminder_sent_at INTEGER,
      deliver_reminder_count INTEGER DEFAULT 0,
      order_amount REAL,
      offer_ids TEXT,
      products_json TEXT,
      earnings_revoked_at INTEGER,
      earnings_revoked_amount REAL,
      earnings_revoke_reason TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_assignments_user_status ON assignments(user_id, status)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_assignments_status ON assignments(status)');

  // --- WAREHOUSES ---
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
    CREATE TABLE IF NOT EXISTS user_warehouses (
      user_id INTEGER NOT NULL,
      warehouse_id TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(warehouse_id),
      PRIMARY KEY (user_id, warehouse_id)
    )
  `);

  // --- STATS ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id INTEGER PRIMARY KEY,
      total_orders INTEGER DEFAULT 0,
      total_amount INTEGER DEFAULT 0,
      canceled_orders INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS product_stats (
      offer_id TEXT PRIMARY KEY,
      material TEXT NOT NULL,
      color TEXT NOT NULL,
      weight_grams REAL NOT NULL,
      user_id INTEGER,
      updated_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // --- EARNINGS ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS earnings_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      amount REAL NOT NULL,
      calculated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_earnings_history_user_id ON earnings_history(user_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_earnings_history_order_id ON earnings_history(order_id)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS earnings_active (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      amount REAL NOT NULL,
      calculated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_earnings_active_user_id ON earnings_active(user_id)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS earnings_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      reason TEXT,
      adjusted_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_adjustments_user_id ON earnings_adjustments(user_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_adjustments_adjusted_at ON earnings_adjustments(adjusted_at)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS earnings_adjustments_active (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      reason TEXT,
      adjusted_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_adjustments_active_user_id ON earnings_adjustments_active(user_id)');

  // --- MODELS ---
  await db.exec(`
    CREATE TABLE IF NOT EXISTS offer_models (
      offer_id TEXT PRIMARY KEY,
      s3_key TEXT NOT NULL,
      file_name TEXT,
      s3_etag TEXT,
      file_size INTEGER,
      uploaded_at INTEGER,
      uploaded_by INTEGER,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_offer_models_offer ON offer_models(offer_id)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS issued_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      offer_id TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE (user_id, offer_id)
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_issued_models_user_offer ON issued_models(user_id, offer_id)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS model_download_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_model_tokens_token ON model_download_tokens(token)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_model_tokens_expires ON model_download_tokens(expires_at)');
}

module.exports = { createFullBotWebSchema };