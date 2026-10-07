// src/models/User.js
const { getUsersDB } = require('../config/database');

/**
 * Пользователь (users.db).
 *
 * Глобальные поля:
 *   • role          — 'god' | 'user' | 'guest'
 *   • capacity      — число принтеров (сквозное)
 *   • taking_orders — принимает ли заказы вообще (сквозное)
 *
 * Per-store данные (роль в магазине, is_fired, earnings_factor,
 * was_employee) — в модели UserStore (таблица user_stores).
 */
class User {
  // ==========================================================================
  //  CRUD
  // ==========================================================================

  /**
   * Создать пользователя.
   * @param {Object} data
   *   • role — 'god' | 'user' | 'guest' (по умолчанию 'user')
   *   • остальные поля таблицы users
   */
  static async create(data) {
    const db = getUsersDB();
    const {
      username, email, passwordHash,
      name = '', displayName = null, phone = '',
      capacity = 1, takingOrders = 1,
      role = 'user', tgUserId = null,
      emailVerified = 0,
    } = data;

    const existing = await db.get(
      'SELECT id, username, email FROM users WHERE username = ? OR email = ?',
      username, email
    );
    if (existing) {
      const conflict = existing.username === username ? 'username' : 'email';
      throw new Error(`${conflict} already taken`);
    }

    const now = Date.now();
    const result = await db.run(
      `INSERT INTO users
         (username, email, password_hash, name, display_name, phone,
          capacity, taking_orders, role, tg_user_id, email_verified,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      username, email, passwordHash, name, displayName, phone,
      capacity, takingOrders, role, tgUserId, emailVerified, now, now
    );
    return this.getById(result.lastID);
  }

  static async getById(id) {
    const db = getUsersDB();
    return (await db.get(
      `SELECT id, username, email, name, display_name, phone, capacity,
              taking_orders, role, tg_user_id, email_verified,
              created_at, updated_at
       FROM users WHERE id = ?`,
      id
    )) || null;
  }

  static async getByUsername(username) {
    const db = getUsersDB();
    return (await db.get(
      `SELECT id, username, email, password_hash, name, display_name, phone,
              capacity, taking_orders, role, tg_user_id, email_verified,
              created_at, updated_at
       FROM users WHERE username = ?`,
      username
    )) || null;
  }

  static async getByEmail(email) {
    const db = getUsersDB();
    return (await db.get(
      `SELECT id, username, email, password_hash, name, display_name, phone,
              capacity, taking_orders, role, tg_user_id, email_verified,
              created_at, updated_at
       FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))`,
      email
    )) || null;
  }

  static async findByTgId(tgUserId) {
    const db = getUsersDB();
    return db.get('SELECT * FROM users WHERE tg_user_id = ?', String(tgUserId));
  }

  /**
   * Обновление полей users. Per-store поля (is_fired, earnings_factor,
   * роль в магазине) — через UserStore.
   */
  static async update(id, fields) {
    const db = getUsersDB();
    const allowed = [
      'username', 'email', 'name', 'display_name', 'phone',
      'capacity', 'taking_orders', 'role', 'tg_user_id', 'email_verified',
    ];
    const setClauses = [];
    const values = [];
    for (const [key, val] of Object.entries(fields)) {
      if (allowed.includes(key) && val !== undefined) {
        setClauses.push(`${key} = ?`);
        values.push(val);
      }
    }
    if (!setClauses.length) return this.getById(id);
    values.push(Date.now(), id);
    await db.run(
      `UPDATE users SET ${setClauses.join(', ')}, updated_at = ? WHERE id = ?`,
      values
    );
    return this.getById(id);
  }

  static async deleteById(id) {
    const db = getUsersDB();
    await db.run('DELETE FROM users WHERE id = ?', id);
  }

  /**
   * Гости (неподтверждённые аккаунты), созданные раньше cutoffMs.
   */
  static async findGuestsOlderThan(cutoffMs) {
    const db = getUsersDB();
    return db.all(
      `SELECT id, username, email, created_at FROM users
       WHERE role = 'guest' AND created_at < ?
       ORDER BY id`,
      cutoffMs
    );
  }

  static async setPasswordHash(id, hash) {
    const db = getUsersDB();
    await db.run(
      'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
      hash, Date.now(), id
    );
  }

  static async setTelegramId(id, tgUserId) {
    const db = getUsersDB();
    await db.run(
      'UPDATE users SET tg_user_id = ?, updated_at = ? WHERE id = ?',
      tgUserId, Date.now(), id
    );
  }

  static async setRole(id, role) {
    const db = getUsersDB();
    await db.run(
      'UPDATE users SET role = ?, updated_at = ? WHERE id = ?',
      role, Date.now(), id
    );
  }

  /**
   * Обновление по tg_user_id (используется старой синхронизацией).
   * Здесь оставлен для совместимости, но в новой архитектуре
   * per-store поля НЕ обновляются через User.
   */
  static async updateByTgId(tgUserId, updates) {
    const user = await this.findByTgId(tgUserId);
    if (!user) return null;
    const allowed = ['name', 'phone', 'capacity'];
    const filtered = {};
    for (const [k, v] of Object.entries(updates)) {
      if (allowed.includes(k) && v !== undefined) filtered[k] = v;
    }
    if (!Object.keys(filtered).length) return user;
    return this.update(user.id, filtered);
  }

  // ==========================================================================
  //  СПИСКИ И ФИЛЬТРЫ
  // ==========================================================================

  /**
   * Глобальный список пользователей (для админки верхнего уровня).
   * @param {Object} opts
   *   • includeGuests — включать role='guest' (неподтверждённые)
   *   • role          — фильтр по глобальной роли
   *   • search        — поиск по username/email/name/phone
   */
  static async getAll({
    includeGuests = false,
    role = null,
    search = null,
  } = {}) {
    const db = getUsersDB();
    const conditions = [];
    const params = [];

    if (!includeGuests) conditions.push("role != 'guest'");
    if (role) { conditions.push('role = ?'); params.push(role); }
    if (search) {
      const s = `%${search}%`;
      conditions.push('(username LIKE ? OR email LIKE ? OR name LIKE ? OR phone LIKE ?)');
      params.push(s, s, s, s);
    }

    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    return db.all(
      `SELECT id, username, email, name, display_name, phone, capacity,
              taking_orders, role, tg_user_id, email_verified,
              created_at, updated_at
       FROM users${where}
       ORDER BY id`,
      params
    );
  }

  /**
   * Пользователь + его роль/статус в конкретном магазине.
   * @returns {Object|null} { ...user, store: {role,is_fired,...} | null }
   */
  static async getWithStoreDetails(userId, storeId) {
    const user = await this.getById(userId);
    if (!user) return null;

    const UserStore = require('./UserStore');
    const store = await UserStore.get(userId, storeId);
    return { ...user, store };
  }

  /**
   * Все пользователи, имеющие запись в user_stores для магазина.
   *
   * @param {string|number} storeId
   * @param {Object} filters
   *   • includeFired     — включать уволенных (default: false)
   *   • roles            — массив ролей в магазине (['employee','moderator','admin','god'])
   *   • excludeRole      — исключить роль (например, 'god')
   *   • onlyTakingOrders — только принимающие заказы (u.taking_orders=1)
   *   • search           — поиск по имени/email/phone/username
   *
   * Возвращает сотрудников С role из user_stores:
   *   { ..., role, is_fired, earnings_factor, was_employee, global_role }
   */
  static async getAllInStore(storeId, filters = {}) {
    const db = getUsersDB();
    const conditions = ['us.store_id = ?'];
    const params = [String(storeId)];

    if (!filters.includeFired) {
      conditions.push('us.is_fired = 0');
    }
    if (filters.roles && filters.roles.length) {
      const ph = filters.roles.map(() => '?').join(', ');
      conditions.push(`us.role IN (${ph})`);
      params.push(...filters.roles);
    }
    if (filters.excludeRole) {
      conditions.push('us.role != ?');
      params.push(filters.excludeRole);
    }
    if (filters.onlyTakingOrders) {
      conditions.push('u.taking_orders = 1');
    }
    if (filters.search) {
      const s = `%${filters.search}%`;
      conditions.push(
        '(u.name LIKE ? OR u.username LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)'
      );
      params.push(s, s, s, s);
    }

    const rows = await db.all(
      `SELECT
         u.id, u.username, u.email, u.name, u.display_name, u.phone,
         u.capacity, u.taking_orders, u.role AS global_role,
         u.tg_user_id, u.email_verified, u.created_at, u.updated_at,
         us.role          AS store_role,
         us.is_fired      AS is_fired,
         us.earnings_factor,
         us.was_employee
       FROM users u
       INNER JOIN user_stores us ON us.user_id = u.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY u.id`,
      params
    );

    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email,
      name: r.name,
      display_name: r.display_name,
      phone: r.phone,
      capacity: r.capacity,
      taking_orders: r.taking_orders,
      // ВАЖНО: role для магазина (из user_stores)
      role: r.store_role,
      global_role: r.global_role,
      tg_user_id: r.tg_user_id,
      email_verified: r.email_verified,
      is_fired: r.is_fired,
      earnings_factor: r.earnings_factor,
      was_employee: r.was_employee,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  /**
   * @deprecated — это был старый getAll с cohort-логикой.
   * В multistore используйте getAllInStore(storeId, filters)
   * для сотрудников магазина и getAll() для глобального списка.
   */
  static async getAllCohort() {
    throw new Error(
      'User.getAllCohort() устарел. Используйте:\n' +
      '  User.getAll({includeGuests, role, search}) — глобальный список\n' +
      '  User.getAllInStore(storeId, {includeFired, excludeRole, ...}) — сотрудники магазина'
    );
  }
}

module.exports = User;