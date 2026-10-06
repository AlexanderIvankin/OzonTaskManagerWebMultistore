// ============================================================================
//  Схемы БД, создаваемых split'ом
// ============================================================================

/**
 * users.db — каноничный список сотрудников.
 * Здесь: users, user_stores (per-store роли/статусы), auth-хвосты, push.
 */
async function createUsersSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      phone TEXT,
      capacity INTEGER DEFAULT 1,                 -- сквозное
      taking_orders INTEGER DEFAULT 1,            -- сквозное
      role TEXT NOT NULL DEFAULT 'user',          -- 'god' | 'user' | 'guest'
      tg_user_id TEXT UNIQUE,
      email_verified INTEGER DEFAULT 0,
      display_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Per-store роли и статусы.
  // Нет записи = пользователь не имеет отношения к магазину
  // (обычный user, зарегистрированный на этом субдомене, но не сотрудник).
  // Запись появляется:
  //   • при переносе bot_web-N, где user.role ∈ {employee, moderator, admin};
  //   • при переносе уволенного (user.role='user' AND is_fired=1) —
  //     чтобы отличать его от «никогда не был»;
  //   • при первом назначении сотрудника магазина.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_stores (
      user_id INTEGER NOT NULL,
      store_id TEXT NOT NULL,
      -- Значение по умолчанию — 'employee'. Допустимы любые строки,
      -- включая 'employee', 'moderator', 'admin', 'god' и др.
      -- Валидация — на уровне приложения.
      role TEXT NOT NULL DEFAULT 'employee',
      is_fired INTEGER NOT NULL DEFAULT 0,
      earnings_factor REAL NOT NULL DEFAULT 1.0,
      was_employee INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, store_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_user_stores_store ON user_stores(store_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_user_stores_user ON user_stores(user_id)');

  // auth-хвосты
  await db.exec(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

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

  // Индексы
  await db.exec('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_users_tg ON users(tg_user_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_password_resets_code ON password_resets(code)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)');
}

/**
 * models.db — S3-метаданные и глобальная выдача моделей.
 */
async function createModelsSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS offer_models (
      offer_id TEXT PRIMARY KEY,
      s3_key TEXT NOT NULL,
      file_name TEXT,
      s3_etag TEXT,
      file_size INTEGER,
      uploaded_at INTEGER,
      uploaded_by INTEGER
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_offer_models_offer ON offer_models(offer_id)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS issued_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      offer_id TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      UNIQUE (user_id, offer_id)
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_issued_models_user_offer ON issued_models(user_id, offer_id)');
}

/**
 * store-N.db — операционные данные одного магазина.
 */
async function createStoreSchema(db) {
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
      earnings_revoke_reason TEXT
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_assignments_user_status ON assignments(user_id, status)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_assignments_status ON assignments(status)');

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
      PRIMARY KEY (user_id, warehouse_id)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS product_stats (
      offer_id TEXT PRIMARY KEY,
      material TEXT NOT NULL,
      color TEXT NOT NULL,
      weight_grams REAL NOT NULL,
      user_id INTEGER,
      updated_at INTEGER
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id INTEGER PRIMARY KEY,
      total_orders INTEGER DEFAULT 0,
      total_amount INTEGER DEFAULT 0,
      canceled_orders INTEGER DEFAULT 0
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS earnings_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      amount REAL NOT NULL,
      calculated_at INTEGER NOT NULL
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
      calculated_at INTEGER NOT NULL
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_earnings_active_user_id ON earnings_active(user_id)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS earnings_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      reason TEXT,
      adjusted_at INTEGER NOT NULL
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
      adjusted_at INTEGER NOT NULL
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_adjustments_active_user_id ON earnings_adjustments_active(user_id)');
}

module.exports = {
  createUsersSchema,
  createModelsSchema,
  createStoreSchema,
};