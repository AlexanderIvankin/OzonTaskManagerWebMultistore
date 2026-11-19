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
      push_disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Мягкая миграция: push_disabled в users
  const userCols = await db.all('PRAGMA table_info(users)');
  if (!userCols.some((c) => c.name === 'push_disabled')) {
    await db.exec('ALTER TABLE users ADD COLUMN push_disabled INTEGER NOT NULL DEFAULT 0');
    console.log('✅ users: добавлена колонка push_disabled');
  }

  // Мягкая миграция: returns_storage_enabled (глобальный тумблер «хранилище возвратов»)
  const userColsReturns = await db.all('PRAGMA table_info(users)');
  if (!userColsReturns.some((c) => c.name === 'returns_storage_enabled')) {
    await db.exec('ALTER TABLE users ADD COLUMN returns_storage_enabled INTEGER NOT NULL DEFAULT 0');
    console.log('✅ users: добавлена колонка returns_storage_enabled');
  }

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
      -- origin подписки (https://store1.na3d.ru, https://na3d.ru).
      -- Один браузер = отдельная подписка на каждый origin (SW per-origin).
      -- Нужен, чтобы store-уведомление уходило только в контекст магазина,
      -- а не светилось ещё и на основном домене (и наоборот).
      origin TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // --- Мягкая миграция: origin в push_subscriptions (multi-origin push) ---
  const pushCols = await db.all('PRAGMA table_info(push_subscriptions)');
  if (!pushCols.some((c) => c.name === 'origin')) {
    await db.exec('ALTER TABLE push_subscriptions ADD COLUMN origin TEXT');
    console.log('✅ push_subscriptions: добавлена колонка origin');
  }

  // ==========================================================================
  //  ХРАНИЛИЩЕ ВОЗВРАТОВ (глобально; один «склад возвратов» на всю систему)
  // ==========================================================================
  // Одна строка = партия одного lozon_id в одной коробке у одного сотрудника.
  //   • lozon_id  — штрихкод с возвратной этикетки (обязательный);
  //   • offer_id  — артикул (заполняется после резолва; null до него);
  //   • sku       — Ozon sku (заполняется после резолва, опционально);
  //   • box_number — свободный ярлык, который сотрудник сам задаёт
  //                  («Ящик 3», «Красная коробка 8» и т.п.);
  //   • status: 'stored' | 'used' | 'removed';
  //   • resolution_status: 'pending' | 'resolved' | 'unresolved'.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS stored_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      box_number TEXT NOT NULL,
      lozon_id TEXT NOT NULL,
      offer_id TEXT,
      sku TEXT,
      product_name TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      resolution_status TEXT NOT NULL DEFAULT 'pending',
      resolution_attempts INTEGER NOT NULL DEFAULT 0,
      last_resolution_attempt_at INTEGER,
      resolution_error TEXT,
      source_store_id TEXT,
      source_order_id TEXT,
      status TEXT NOT NULL DEFAULT 'stored',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_stored_returns_user_status ON stored_returns(user_id, status)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_stored_returns_offer_status ON stored_returns(offer_id, status)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_stored_returns_sku_status ON stored_returns(sku, status)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_stored_returns_lozon ON stored_returns(lozon_id)');
  // Очередь резолвера: pending / unresolved
  await db.exec(
    "CREATE INDEX IF NOT EXISTS idx_stored_returns_pending ON stored_returns(resolution_status, status) " +
    "WHERE resolution_status IN ('pending','unresolved') AND status = 'stored'"
  );
  // Partial unique index: одна «живая» запись на (user, lozon, box).
  // Обеспечивает идемпотентность upsert'а при повторном скане того же товара.
  await db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_stored_returns_unique_stored " +
    "ON stored_returns(user_id, lozon_id, box_number) WHERE status = 'stored'"
  );

  // Мягкая миграция: resolution_method (как получен offer_id: api | manual)
  const srCols = await db.all('PRAGMA table_info(stored_returns)');
  if (!srCols.some((c) => c.name === 'resolution_method')) {
    await db.exec('ALTER TABLE stored_returns ADD COLUMN resolution_method TEXT');
    console.log('✅ stored_returns: добавлена колонка resolution_method');
  }

  // Мягкая миграция: cargo_box_id — ключ матчинга с returns-N.db
  const srCols2 = await db.all('PRAGMA table_info(stored_returns)');
  if (!srCols2.some((c) => c.name === 'cargo_box_id')) {
    await db.exec('ALTER TABLE stored_returns ADD COLUMN cargo_box_id TEXT');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_stored_returns_cargo_box ON stored_returns(cargo_box_id) WHERE cargo_box_id IS NOT NULL');
    console.log('✅ stored_returns: добавлена колонка cargo_box_id');
  }

  // Мягкая миграция: barcode и source для прямого хранения по offer_id
  const srCols3 = await db.all('PRAGMA table_info(stored_returns)');
  if (!srCols3.some((c) => c.name === 'barcode')) {
    await db.exec('ALTER TABLE stored_returns ADD COLUMN barcode TEXT');
    console.log('✅ stored_returns: добавлена колонка barcode');
  }
  if (!srCols3.some((c) => c.name === 'source')) {
    await db.exec("ALTER TABLE stored_returns ADD COLUMN source TEXT NOT NULL DEFAULT 'lozon_id'");
    await db.exec(
      "CREATE INDEX IF NOT EXISTS idx_stored_returns_source " +
      "ON stored_returns(source) WHERE status = 'stored'"
    );
    console.log('✅ stored_returns: добавлена колонка source');
  }

  // История списаний: аудит + возможность восстановления при отмене заказа.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS stored_returns_consumptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stored_return_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      lozon_id TEXT NOT NULL,
      offer_id TEXT,
      sku TEXT,
      box_number TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      consumed_at INTEGER NOT NULL,
      restored_at INTEGER,
      FOREIGN KEY (stored_return_id) REFERENCES stored_returns(id)
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_sr_consumptions_order ON stored_returns_consumptions(order_id, store_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_sr_consumptions_sr ON stored_returns_consumptions(stored_return_id)');

  // Материалы в наличии у сотрудника — ГЛОБАЛЬНО (не per-store).
  // Строка = «у сотрудника есть цвет X материала Y». Нет строки = нет в наличии.
  // Справочник материалов/цветов — мёрж всех materials-prices-N.json.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_materials (
      user_id INTEGER NOT NULL,
      material TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, material, color),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_user_materials_user ON user_materials(user_id)'
  );

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

  await db.exec(`
    CREATE TABLE IF NOT EXISTS model_download_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_model_tokens_token ON model_download_tokens(token)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_model_tokens_expires ON model_download_tokens(expires_at)');
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