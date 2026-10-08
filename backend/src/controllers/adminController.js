const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { User, UserStore, Assignment, UserStats, Earnings, Warehouse, ProductStat } = require('../models');
const SyncService = require('../services/SyncService');
const OzonService = require('../services/OzonService');
const OrderService = require('../services/OrderService');
const EarningsService = require('../services/EarningsService');
const MaterialsService = require('../services/MaterialsService');
const BackupService = require('../services/BackupService');
const ProductStatsService = require('../services/ProductStatsService');
const ModelService = require('../services/ModelService');
const AuthService = require('../services/AuthService');
const NotificationService = require('../services/NotificationService');
const scheduler = require('../scheduler');
const stores = require('../config/stores');
const { getStoreDB } = require('../config/database');
const {
  getLocalTimestamp,
  getVersionedFileName,
  parseCapacity,
  parseEarningsFactor,
  formatPhonePretty,
  toSqliteLiteral,
  disableCache,
} = require('../utils');

// archiver v8 — чистый ESM-пакет, требует динамического import() в CommonJS.
// Кэшируем класс после первого успешного импорта, чтобы не перезагружать
// модуль на каждый экспорт БД.
let ZipArchiveClass = null;
async function getZipArchiveClass() {
  if (!ZipArchiveClass) {
    const mod = await import('archiver');
    ZipArchiveClass = mod.ZipArchive;
  }
  return ZipArchiveClass;
}

/**
 * Перегенерирует Excel-файлы сотрудников на сервере.
 * TODO (multistore): SyncService.refreshServerExports будет store-aware.
 * Сейчас — вызывается, ошибки не критичны (внутри try/catch).
 */
async function refreshServerExports(storeId) {
  try {
    if (typeof SyncService.refreshServerExports === 'function') {
      await SyncService.refreshServerExports(storeId);
    }
  } catch (err) {
    console.error(`[adminController][store ${storeId}] Ошибка перегенерации Excel-файлов:`, err.message);
  }
}

/**
 * Список сотрудников текущего магазина (с фильтрацией).
 * Источник — users.db + user_stores, роль/is_fired/earnings_factor берутся
 * из user_stores магазина.
 */
exports.getUsers = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const { includeFired, includeAll, role, withWarehouses, cohort } = req.query;

    // getAllInStore — сотрудники, у которых ЕСТЬ запись в user_stores.
    // Для когорты «users» (обычные пользователи, никогда не сотрудники)
    // дополнительно подмешиваем записи users, которых нет в user_stores.
    const filters = {
      includeFired: includeFired === 'true',
      roles: role ? [role] : null,
    };
    if (includeAll === 'true') filters.onlyTakingOrders = false;
    else filters.onlyTakingOrders = true;

    let users = await User.getAllInStore(storeId, filters);

    // Когорта 'users' — только те, кто не имеет записи в user_stores,
    // или уволен, но не был сотрудником (was_employee=0), плюс гости.
    if (cohort === 'users') {
      const allInStoreIds = new Set(users.map((u) => u.id));
      const globalUsers = await User.getAll({ includeGuests: true });
      users = globalUsers.filter((u) => {
        if (u.role === 'guest') return true;
        if (!allInStoreIds.has(u.id)) return true;
        return false;
      });
    }

    if (withWarehouses === 'true') {
      // warehouses + active_count — из store-N.db, issued_offer_ids — из models.db
      const storeDb = getStoreDB(storeId);
      const links = await storeDb.all(`
        SELECT uw.user_id, w.warehouse_id, w.name, w.address, w.is_rfbs
        FROM user_warehouses uw
        JOIN warehouses w ON uw.warehouse_id = w.warehouse_id
        ORDER BY w.name
      `);
      const counts = await storeDb.all(
        "SELECT user_id, COUNT(*) as count FROM assignments WHERE status = 'assigned' GROUP BY user_id"
      );
      const warehousesMap = new Map();
      for (const link of links) {
        if (!warehousesMap.has(link.user_id)) warehousesMap.set(link.user_id, []);
        warehousesMap.get(link.user_id).push({
          warehouse_id: link.warehouse_id,
          name: link.name,
          address: link.address,
          is_rfbs: !!link.is_rfbs,
        });
      }
      const countsMap = new Map(counts.map((c) => [c.user_id, c.count]));

      // issued_models — глобальная таблица, один запрос на всех
      const issuedMap = new Map();
      try {
        const { getModelsDB } = require('../config/database');
        const modelsDb = getModelsDB();
        const issuedRows = await modelsDb.all('SELECT user_id, offer_id FROM issued_models');
        for (const row of issuedRows) {
          if (!issuedMap.has(row.user_id)) issuedMap.set(row.user_id, []);
          issuedMap.get(row.user_id).push(row.offer_id);
        }
      } catch (e) {
        // models.db может быть недоступна — не критично
      }

      res.json(users.map((u) => ({
        ...u,
        warehouses: warehousesMap.get(u.id) || [],
        active_count: countsMap.get(u.id) || 0,
        issued_offer_ids: issuedMap.get(u.id) || [],
      })));
      return;
    }
    res.json(users);
  } catch (err) {
    next(err);
  }
};

/**
 * Детали сотрудника (со статистикой магазина и активными заказами).
 */
exports.getUserById = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = parseInt(req.params.id);

    const user = await User.getById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const userStore = await UserStore.get(userId, storeId);
    const stats = await UserStats.getStats(storeId, userId);
    const activeOrders = await Assignment.getActiveOrders(storeId, userId);
    const warehouses = await Warehouse.getUserWarehouses(storeId, userId);

    res.json({
      ...user,
      // per-store поля поверх глобальных
      role: userStore?.role || 'user',
      is_fired: userStore?.is_fired ? 1 : 0,
      earnings_factor: userStore?.earnings_factor ?? 1.0,
      was_employee: userStore?.was_employee ? 1 : 0,
      stats,
      activeOrders: activeOrders || [],
      warehouses,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Обновление пользователя.
 * Глобальные поля (name, phone, capacity, display_name) — через User.update.
 * Per-store поля (earnings_factor, is_fired, role сотрудника) — через UserStore.
 */
exports.updateUser = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = parseInt(req.params.id);
    const { name, phone, capacity, earnings_factor, role, is_fired, taking_orders } = req.body;

    const target = await User.getById(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const targetStore = await UserStore.get(userId, storeId);

    // --- Защита Создателя ---
    // Создатель — глобальный (users.role='god'). Защищаем от любых правок,
    // кроме как самим Создателем.
    if (target.role === 'god' && req.user.role !== 'god') {
      return res.status(403).json({ error: 'Профиль Создателя может редактировать только Создатель' });
    }
    if (role !== undefined && role !== targetStore?.role && (role === 'god' || targetStore?.role === 'god')) {
      return res.status(403).json({ error: "Роль 'god' (Создатель) управляется только синхронизацией" });
    }
    if (target.role === 'god' && (is_fired === true || is_fired === 1)) {
      return res.status(403).json({ error: 'Создателя нельзя уволить' });
    }

    // --- Валидация/нормализация ---
    let normalizedPhone = phone;
    if (phone !== undefined && phone !== null && String(phone).trim() !== '') {
      const pretty = formatPhonePretty(phone);
      if (!pretty) {
        return res.status(400).json({
          error: 'Некорректный телефон: укажите номер в формате +7 (999) 999-99-99 (11 цифр)',
        });
      }
      normalizedPhone = pretty;
    }
    let normalizedCapacity = capacity;
    if (capacity !== undefined && capacity !== null && capacity !== '') {
      const parsed = parseCapacity(capacity);
      if (parsed === null) {
        return res.status(400).json({
          error: 'Количество принтеров должно быть целым числом >= 1',
        });
      }
      normalizedCapacity = parsed;
    }
    let normalizedFactor = earnings_factor;
    if (earnings_factor !== undefined && earnings_factor !== null && earnings_factor !== '') {
      const parsed = parseEarningsFactor(earnings_factor);
      if (parsed === null) {
        return res.status(400).json({
          error: 'Коэффициент заработка: положительное число с максимум 2 знаками после запятой (например, 1.5 или 99,99)',
        });
      }
      normalizedFactor = parsed;
    }

    // --- Глобальные поля ---
    const globalFields = {};
    if (name !== undefined) globalFields.name = name;
    if (normalizedPhone !== undefined) globalFields.phone = normalizedPhone;
    if (normalizedCapacity !== undefined) globalFields.capacity = normalizedCapacity;
    if (taking_orders !== undefined) globalFields.taking_orders = taking_orders;
    if (Object.keys(globalFields).length) {
      await User.update(userId, globalFields);
    }

    // --- Per-store поля ---
    const storeFields = {};
    if (role !== undefined) storeFields.role = role;
    if (is_fired !== undefined) storeFields.is_fired = is_fired ? 1 : 0;
    if (normalizedFactor !== undefined) storeFields.earnings_factor = normalizedFactor;

    // Если у пользователя ещё нет записи в user_stores и приходят store-поля —
    // создаём её (например, назначение сотрудником через редактирование).
    if (Object.keys(storeFields).length || !targetStore) {
      // При явном повышении до staff-роли — was_employee=1
      if (role && ['employee', 'moderator', 'admin', 'god'].includes(role)) {
        storeFields.was_employee = 1;
      }
      await UserStore.upsert(userId, storeId, storeFields);
    }

    await refreshServerExports(storeId);

    // Возвращаем объединённый объект
    const updated = await User.getById(userId);
    const updatedStore = await UserStore.get(userId, storeId);
    res.json({
      ...updated,
      role: updatedStore?.role || 'user',
      is_fired: updatedStore?.is_fired ? 1 : 0,
      earnings_factor: updatedStore?.earnings_factor ?? 1.0,
      was_employee: updatedStore?.was_employee ? 1 : 0,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Уволить сотрудника В ТЕКУЩЕМ МАГАЗИНЕ.
 * UserStore.fire (is_fired=1 в user_stores), снимаем активные назначения.
 * Глобальный users.role НЕ понижаем — сотрудник может работать в другом
 * магазине. taking_orders — глобальный, снимаем (паритет с прежним поведением).
 */
exports.fireUser = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = parseInt(req.params.id);
    const target = await User.getById(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'god') {
      return res.status(403).json({ error: 'Создателя нельзя уволить' });
    }

    // Per-store: is_fired=1
    await UserStore.fire(userId, storeId);

    // Глобально: приём заказов выключаем, роль не трогаем
    await User.update(userId, { taking_orders: 0 });

    // Снять активные назначения в ЭТОМ магазине
    const db = getStoreDB(storeId);
    await db.run('DELETE FROM assignments WHERE user_id = ? AND status = "assigned"', userId);

    await refreshServerExports(storeId);
    res.json({ message: 'User fired successfully' });
  } catch (err) {
    next(err);
  }
};

/**
 * Восстановить уволенного сотрудника В ТЕКУЩЕМ МАГАЗИНЕ.
 * UserStore.restore(userId, storeId) → is_fired=0. Роль сохраняется
 * (та, что была в user_stores до увольнения).
 * Глобально включаем приём заказов обратно.
 */
exports.restoreUser = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = parseInt(req.params.id);
    const target = await User.getById(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const record = await UserStore.get(userId, storeId);
    if (!record) {
      return res.status(400).json({ error: 'Пользователь не привязан к магазину' });
    }
    if (!record.is_fired) {
      return res.json({ message: 'Сотрудник уже активен', role: record.role });
    }

    await UserStore.restore(userId, storeId);
    await User.update(userId, { taking_orders: 1 });

    await refreshServerExports(storeId);
    res.json({ message: 'User restored successfully', role: record.role });
  } catch (err) {
    next(err);
  }
};

/**
 * Создать аккаунт администратором — в обход подтверждения email.
 * Создаёт User + UserStore(storeId, role).
 */
exports.createUserByAdmin = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const { username, email, password, name, phone, capacity, earningsFactor, role } = req.body;

    const validationErrors = AuthService.validateAdminRegisterData({
      username, email, password, capacity, role, phone, earningsFactor,
    });
    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: validationErrors.join('. '),
        errors: validationErrors,
      });
    }

    // AuthService.adminRegister теперь создаёт User + UserStore.
    // Передаём storeId в опции.
    const user = await AuthService.adminRegister({
      username, email, password, name, phone, capacity, earningsFactor, role,
      storeId,
    });

    await refreshServerExports(storeId);

    res.status(201).json({
      user,
      message: `Аккаунт ${user.username} создан и подтверждён (роль: ${role || 'employee'})`,
    });
  } catch (err) {
    if (err.message.includes('already taken')) {
      const what = err.message.startsWith('username') ? 'Логин' : 'Email';
      return res.status(409).json({ error: `${what} уже занят` });
    }
    next(err);
  }
};

// ============================================================================
// --- ПАСХАЛКА СОЗДАТЕЛЯ (глобальная, не привязана к магазину) ---
// ============================================================================
let godFakeStats = {
  total_orders: 1337,
  canceled_orders: 666,
  earnings_total: 999999999.99,
  total_amount: 666666666.66,
};

/**
 * Статистика сотрудников ТЕКУЩЕГО магазина.
 * Источник — user_stores (was_employee=1 в этом магазине) + user_stats и
 * earnings_history из store-N.db. Для Создателя (role='god') — фейк.
 */
exports.getStaffStats = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const includeFired = req.query.includeFired === 'true';
    const db = getStoreDB(storeId);

    // JOIN: usersdb.users + usersdb.user_stores + локальные user_stats/earnings_history
    const rows = await db.all(
      `
      SELECT u.id, u.name, u.username,
             us.role          AS role,
             us.is_fired      AS is_fired,
             COALESCE(st.total_orders, 0)    AS total_orders,
             COALESCE(st.canceled_orders, 0) AS canceled_orders,
             COALESCE(st.total_amount, 0)    AS total_amount,
             COALESCE(SUM(eh.amount), 0)     AS earnings_total
      FROM usersdb.users u
      INNER JOIN usersdb.user_stores us
              ON us.user_id = u.id AND us.store_id = ?
      LEFT JOIN user_stats st       ON st.user_id = u.id
      LEFT JOIN earnings_history eh ON eh.user_id = u.id
      WHERE us.was_employee = 1${includeFired ? '' : ' AND us.is_fired = 0'}
      GROUP BY u.id
      ORDER BY u.id
      `,
      storeId
    );

    const stats = rows.map((r) =>
      r.role === 'god' ? { ...r, ...godFakeStats, fake: true } : { ...r, fake: false },
    );
    res.json(stats);
  } catch (err) {
    next(err);
  }
};

/**
 * Редактирование фейковой статистики Создателя (только role 'god').
 */
exports.updateGodFakeStats = async (req, res, next) => {
  try {
    const { total_orders, canceled_orders, total_amount, earnings_total } = req.body;
    const errors = [];
    const updates = {};

    if (total_orders !== undefined) {
      const n = Number(total_orders);
      if (!Number.isInteger(n) || n < 0) errors.push('total_orders: целое число ≥ 0');
      else updates.total_orders = n;
    }
    if (canceled_orders !== undefined) {
      const n = Number(canceled_orders);
      if (!Number.isInteger(n) || n < 0) errors.push('canceled_orders: целое число ≥ 0');
      else updates.canceled_orders = n;
    }
    if (total_amount !== undefined) {
      const n = Number(total_amount);
      if (!Number.isFinite(n) || n < 0) errors.push('total_amount: число ≥ 0');
      else updates.total_amount = n;
    }
    if (earnings_total !== undefined) {
      const n = Number(earnings_total);
      if (!Number.isFinite(n) || n < 0) errors.push('earnings_total: число ≥ 0');
      else updates.earnings_total = n;
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join('. '), errors });
    }

    godFakeStats = { ...godFakeStats, ...updates };
    res.json({
      message: 'Статистика Создателя обновлена 🎃 (живёт в памяти до перезапуска сервера)',
      stats: { ...godFakeStats, fake: true },
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================================
// --- СИНХРОНИЗАЦИЯ ИЗ EXCEL ---
// ============================================================================
// TODO (multistore): SyncService.syncFromExcel будет store-aware (обновляет
// user_stores для магазина). Сейчас передаём storeId в options.

exports.syncEmployees = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const expectedName = getVersionedFileName('team-info', 'xlsx', storeId);
    if (req.file.originalname !== expectedName) {
      try { fs.unlinkSync(req.file.path); } catch { }
      return res.status(400).json({
        error: `Неверное имя файла: "${req.file.originalname}". Ожидается "${expectedName}" (актуальная версия файла сотрудников)`,
      });
    }

    try {
      const warehousesFromOzon = await OzonService.fetchWarehouses(storeId);
      if (warehousesFromOzon.length) {
        await Warehouse.syncAll(storeId, warehousesFromOzon);
        console.log(`[syncEmployees][store ${storeId}] Синхронизировано ${warehousesFromOzon.length} складов перед Excel-sync`);
      }
    } catch (err) {
      console.warn(`[syncEmployees][store ${storeId}] Не удалось синхронизировать склады:`, err.message);
    }

    const result = await SyncService.syncFromExcel(req.file.path, req.user.id, {
      allowPromotion: true,
      storeId,
    });
    try { fs.unlinkSync(req.file.path); } catch { }
    res.json({ message: 'Sync completed', ...result });
  } catch (err) {
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch { }
    }
    next(err);
  }
};

exports.getSyncExpectedFileName = async (req, res, next) => {
  try {
    res.json({ fileName: getVersionedFileName('team-info', 'xlsx', req.storeId) });
  } catch (err) {
    next(err);
  }
};

exports.syncEmployeesServerFile = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const fileName = getVersionedFileName('team-info', 'xlsx', storeId);
    const filePath = path.join(__dirname, '../../', fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: `Файл ${fileName} не найден на сервере. Сначала выгрузите его через «Экспорт данных».`,
      });
    }
    const result = await SyncService.syncFromExcel(filePath, req.user.id, {
      allowPromotion: false,
      storeId,
    });
    res.json({ message: 'Sync completed', ...result });
  } catch (err) {
    next(err);
  }
};

exports.exportTeamInfo = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const includeFired = req.query.includeFired === 'true';
    const outputFileName = includeFired ? 'employees-db.xlsx' : 'team-info.xlsx';
    const filePath = await SyncService.exportTeamInfoXlsx(
      req.user.id,
      includeFired,
      outputFileName,
      { storeId }
    );
    disableCache(res);
    // Явно передаём имя — клиент получит корректный Content-Disposition
    const { getVersionedFileName } = require('../utils');
    const baseName = outputFileName.replace(/\.xlsx$/i, '');
    res.download(filePath, getVersionedFileName(baseName, 'xlsx', storeId));
  } catch (err) {
    console.error(`[exportTeamInfo][store ${req.storeId}] Ошибка:`, err);
    next(err);
  }
};

// ============================================================================
// --- СКЛАДЫ ---
// ============================================================================

exports.getWarehouses = async (req, res, next) => {
  try {
    const warehouses = await Warehouse.getAll(req.storeId);
    res.json(warehouses);
  } catch (err) {
    next(err);
  }
};

exports.syncWarehouses = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const warehouses = await OzonService.fetchWarehouses(storeId);
    await Warehouse.syncAll(storeId, warehouses);
    res.json({ message: 'Warehouses synced', count: warehouses.length });
  } catch (err) {
    next(err);
  }
};

// ============================================================================
// --- ЗАКАЗЫ ---
// ============================================================================

exports.getAwaitingOrders = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const { warehouseId } = req.query;
    const allOrders = await OzonService.fetchAwaitingOrders(storeId, warehouseId);

    const db = getStoreDB(storeId);
    const assigned = await db.all('SELECT order_id FROM assignments WHERE status = "assigned"');
    const assignedSet = new Set(assigned.map(a => a.order_id));
    const freeOrders = allOrders.filter(order => !assignedSet.has(order.posting_number));

    const ordersWithImages = await Promise.all(freeOrders.map(async (order) => {
      const details = await OzonService.getOrderDetails(storeId, order.posting_number);
      const sourceProducts = (details && Array.isArray(details.products) && details.products.length)
        ? details.products
        : (order.products || []);
      const products = await OrderService.attachProductImages(storeId, sourceProducts);
      await OrderService.attachProductStats(storeId, products);
      return { ...order, products, details };
    }));

    res.json(ordersWithImages);
  } catch (err) {
    next(err);
  }
};

exports.getOrderDetails = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const { orderId } = req.params;
    const details = await OzonService.getOrderDetails(storeId, orderId);
    if (!details) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json(details);
  } catch (err) {
    next(err);
  }
};

exports.assignOrder = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const { orderId } = req.params;
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    await OrderService.assignOrder(storeId, orderId, userId, req.user.id);
    res.json({ message: 'Order assigned successfully' });
  } catch (err) {
    console.error(`[assignOrder][store ${req.storeId}] Ошибка:`, err);
    if (err.message && (
      err.message.includes('не найден') ||
      err.message.includes('уволен') ||
      err.message.includes('Создателю') ||
      err.message.includes('уже обрабатывается') ||
      err.message.includes('не удалось получить') ||
      err.message.includes('не привязан')
    )) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message && err.message.includes('Ozon')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
};

exports.unassignOrder = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const { orderId } = req.params;
    await OrderService.unassignOrder(storeId, orderId, req.user.id);
    res.json({ message: 'Order unassigned successfully' });
  } catch (err) {
    console.error(`[unassignOrder][store ${req.storeId}] Ошибка:`, err);
    if (err.message && err.message.includes('не назначен')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
};

exports.getActiveOrdersAll = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const active = await Assignment.getAllActive(storeId);
    const storeCfg = stores.getStore(storeId);
    const result = [];

    for (const a of active) {
      const details = await OzonService.getOrderDetails(storeId, a.order_id);

      let statsStatus = 'filled';
      const missingStats = [];
      if (details && details.products) {
        for (const p of details.products) {
          if (!p.offer_id) continue;
          const stat = await ProductStat.get(storeId, p.offer_id);
          if (!stat) {
            statsStatus = 'missing';
            missingStats.push(p.offer_id);
          }
        }
      }

      const products = await OrderService.attachProductImages(storeId, details?.products || []);
      if (!storeCfg.features.disableModels) {
        await ModelService.attachToProducts(products);
      } else {
        for (const p of products) p.model = null;
      }
      await OrderService.attachProductStats(storeId, products);

      result.push({
        orderId: a.order_id,
        userId: a.user_id,
        userName: a.user_name,
        assignedAt: a.assigned_at,
        warehouseName: details?.analytics_data?.warehouse || null,
        warehouseId: details?.delivery_method?.warehouse_id || details?.warehouse_id || null,
        statsStatus,
        missingStats,
        products,
      });
    }
    res.json(result);
  } catch (err) {
    console.error(`[getActiveOrdersAll][store ${req.storeId}] Ошибка:`, err);
    next(err);
  }
};

exports.getUserOrders = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = parseInt(req.params.id);
    const orders = await Assignment.getActiveOrders(storeId, userId);
    res.json(orders);
  } catch (err) {
    next(err);
  }
};

exports.getCompletedOrders = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
    const days = req.query.days ? parseInt(req.query.days, 10) : null;
    let limit = 25;
    if (req.query.limit === 'all') {
      limit = 'all';
    } else if (req.query.limit) {
      const n = parseInt(req.query.limit, 10);
      if (Number.isFinite(n) && n > 0) limit = Math.min(n, 1000);
    }
    const offset = req.query.offset
      ? Math.max(parseInt(req.query.offset, 10) || 0, 0)
      : 0;
    const orderId = String(req.query.orderId || '').trim() || null;
    const offerId = String(req.query.offerId || '').trim() || null;

    const data = await Assignment.getCompletedOrdersPaged(storeId, {
      userId, days, limit, offset, orderId, offerId,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
};

exports.getUserStats = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = parseInt(req.params.id);
    const stats = await UserStats.getStats(storeId, userId);
    res.json(stats);
  } catch (err) {
    next(err);
  }
};

// ============================================================================
// --- ЭКСПОРТ ЗАРАБОТКА ---
// ============================================================================

exports.exportMonthlyEarnings = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const { month } = req.query;
    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Неверный формат месяца. Используйте YYYY-MM' });
    }
    const filePath = await EarningsService.exportMonthlyEarnings(storeId, month);
    disableCache(res);
    res.download(filePath);
  } catch (err) {
    console.error(`[exportMonthlyEarnings][store ${req.storeId}] Ошибка:`, err);
    if (err.message && err.message.includes('Нет данных')) {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
};

exports.exportProductStats = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const filePath = await ProductStatsService.exportProductStatsXlsx(storeId);
    disableCache(res);
    res.download(filePath, getVersionedFileName('product-stats', 'xlsx', storeId));
  } catch (err) {
    console.error(`[exportProductStats][store ${req.storeId}] Ошибка:`, err);
    if (err.message && err.message.includes('Нет данных')) {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
};

// ============================================================================
// --- СКАЧИВАНИЕ БД ---
//
// downloadDatabase      — снимок store-N.db текущего магазина
// downloadUsersDb       — снимок users.db (глобальная)
// downloadModelsDb      — снимок models.db (глобальная)
// downloadNotificationsDb — снимок notifications.db (глобальная)
// downloadStoreAllDatabases — ZIP: store-N.db текущего магазина + 3 глобальные
// downloadAllDatabases  — ZIP: все БД приложения (все store-N + 3 глобальные)
//
// Все снимки — через VACUUM INTO (консистентны при параллельной записи).
// ============================================================================

/**
 * Создать VACUUM-снимок одной БД в outputs/store-<id>/tmp/.
 * Возвращает путь к снимку.
 * @param {object} db   — открытое соединение
 * @param {string} label — имя БД для имени файла ('users', 'store-1', ...)
 * @param {string} outputDir — куда писать
 */
async function vacuumSnapshot(db, label, outputDir) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const snapshotPath = path.join(
    outputDir,
    `${label}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.db`
  );
  await db.exec(`VACUUM INTO ${toSqliteLiteral(snapshotPath)}`);
  return snapshotPath;
}

/**
 * Отдать один снимок через res.download + убрать после отправки.
 */
function sendSnapshot(res, snapshotPath, downloadName, logLabel) {
  disableCache(res);
  res.download(snapshotPath, downloadName, (err) => {
    fs.unlink(snapshotPath, () => { });
    if (err) console.error(`[${logLabel}] Ошибка отправки файла:`, err);
  });
}

exports.downloadDatabase = async (req, res, next) => {
  let snapshotPath = null;
  try {
    const storeId = req.storeId;
    const db = getStoreDB(storeId);
    const outputDir = path.join(__dirname, '../../outputs', `store-${storeId}`, 'tmp');
    snapshotPath = await vacuumSnapshot(db, `store-${storeId}`, outputDir);

    const storeCfg = stores.getStore(storeId);
    const livePath = require('../config/database').resolveDbPath(storeCfg.dbPath);
    const liveSize = fs.existsSync(livePath) ? fs.statSync(livePath).size : null;
    const snapshotSize = fs.statSync(snapshotPath).size;
    console.log(
      `[downloadDatabase][store ${storeId}] ${livePath}: живой=${liveSize} Б, снимок=${snapshotSize} Б`
    );

    sendSnapshot(res, snapshotPath, `store-${storeId}.db`, `downloadDatabase[store ${storeId}]`);
  } catch (err) {
    if (snapshotPath) { try { fs.unlinkSync(snapshotPath); } catch { } }
    console.error(`[downloadDatabase][store ${req.storeId}] Ошибка:`, err);
    next(err);
  }
};

exports.downloadUsersDb = async (req, res, next) => {
  let snapshotPath = null;
  try {
    const db = require('../config/database').getUsersDB();
    const outputDir = path.join(__dirname, '../../outputs', 'tmp');
    snapshotPath = await vacuumSnapshot(db, 'users', outputDir);
    sendSnapshot(res, snapshotPath, 'users.db', 'downloadUsersDb');
  } catch (err) {
    if (snapshotPath) { try { fs.unlinkSync(snapshotPath); } catch { } }
    console.error('[downloadUsersDb] Ошибка:', err);
    next(err);
  }
};

exports.downloadModelsDb = async (req, res, next) => {
  let snapshotPath = null;
  try {
    const db = require('../config/database').getModelsDB();
    const outputDir = path.join(__dirname, '../../outputs', 'tmp');
    snapshotPath = await vacuumSnapshot(db, 'models', outputDir);
    sendSnapshot(res, snapshotPath, 'models.db', 'downloadModelsDb');
  } catch (err) {
    if (snapshotPath) { try { fs.unlinkSync(snapshotPath); } catch { } }
    console.error('[downloadModelsDb] Ошибка:', err);
    next(err);
  }
};

exports.downloadNotificationsDb = async (req, res, next) => {
  let snapshotPath = null;
  try {
    const { getNotificationsDB } = require('../config/notificationsDatabase');
    const db = getNotificationsDB();
    const outputDir = path.join(__dirname, '../../outputs', 'tmp');
    snapshotPath = await vacuumSnapshot(db, 'notifications', outputDir);
    sendSnapshot(res, snapshotPath, 'notifications.db', 'downloadNotificationsDb');
  } catch (err) {
    if (snapshotPath) { try { fs.unlinkSync(snapshotPath); } catch { } }
    console.error('[downloadNotificationsDb] Ошибка:', err);
    next(err);
  }
};

/**
 * Собрать снимки ВСЕХ переданных БД в один ZIP и отправить.
 * После завершения потока — удалить временные снимки.
 *
 * archiver v8 (ESM-only): класс ZipArchive подгружается через динамический
 * import() и кэшируется в getZipArchiveClass(). Синтаксис создания архива
 * и API (.pipe/.file/.finalize) совместимы с v7.
 *
 * @param {import('express').Response} res
 * @param {Array<{db: object, label: string}>} targets
 * @param {string} zipName
 * @param {string} logLabel
 */
async function sendZipOfSnapshots(res, targets, zipName, logLabel) {
  const tmpDir = path.join(__dirname, '../../outputs', 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const created = []; // [{ path, nameInZip }]

  for (const t of targets) {
    if (!t.db) continue;
    const snapPath = path.join(
      tmpDir,
      `${t.label}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.db`
    );
    try {
      await t.db.exec(`VACUUM INTO ${toSqliteLiteral(snapPath)}`);
      created.push({ path: snapPath, nameInZip: `${t.label}.db` });
    } catch (err) {
      console.error(`[${logLabel}] Снимок ${t.label}: ${err.message}`);
    }
  }

  if (!created.length) {
    return res.status(500).json({ error: 'Не удалось создать ни одного снимка БД' });
  }

  // До первого byte в ответ ничего не должно было уйти: файлы готовы,
  // заголовки выставляем сейчас.
  let ZipArchive;
  try {
    ZipArchive = await getZipArchiveClass();
  } catch (err) {
    // Пакет не установлен / ESM-модуль не загрузился — чистим снимки
    for (const c of created) {
      try { fs.unlinkSync(c.path); } catch { }
    }
    console.error(`[${logLabel}] Не удалось загрузить archiver:`, err.message);
    return res.status(500).json({ error: 'Модуль архивации недоступен' });
  }

  disableCache(res);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const cleanup = () => {
    for (const c of created) {
      try { fs.unlinkSync(c.path); } catch { }
    }
  };

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error(`[${logLabel}] archive error:`, err);
    cleanup();
    if (!res.headersSent) res.status(500).end(); else res.end();
  });
  archive.on('end', cleanup);
  res.on('close', cleanup); // обрыв соединения клиентом — тоже чистим

  archive.pipe(res);
  for (const c of created) archive.file(c.path, { name: c.nameInZip });
  await archive.finalize();
}

/**
 * ZIP: store-N.db текущего магазина + 3 общие БД (users, models, notifications).
 * «Полный контекст одного магазина» — удобно для восстановления/передачи.
 */
exports.downloadStoreAllDatabases = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const targets = [
      { db: require('../config/database').getUsersDB(), label: 'users' },
      { db: require('../config/database').getModelsDB(), label: 'models' },
      { db: require('../config/notificationsDatabase').getNotificationsDB(), label: 'notifications' },
      { db: getStoreDB(storeId), label: `store-${storeId}` },
    ];
    const ts = getLocalTimestamp().replace(/[:\s]/g, '_');
    await sendZipOfSnapshots(res, targets, `store-${storeId}_all_${ts}.zip`, 'downloadStoreAllDatabases');
  } catch (err) {
    console.error(`[downloadStoreAllDatabases][store ${req.storeId}] Ошибка:`, err);
    next(err);
  }
};

/**
 * ZIP: АБСОЛЮТНО ВСЕ БД приложения:
 *   • users.db, models.db, notifications.db;
 *   • store-N.db всех магазинов.
 * Для резервной копии всего стенда.
 */
exports.downloadAllDatabases = async (req, res, next) => {
  try {
    const dbCfg = require('../config/database');
    const targets = [
      { db: dbCfg.getUsersDB(), label: 'users' },
      { db: dbCfg.getModelsDB(), label: 'models' },
      { db: require('../config/notificationsDatabase').getNotificationsDB(), label: 'notifications' },
    ];
    for (const storeId of stores.getStoreIds()) {
      try {
        targets.push({ db: getStoreDB(storeId), label: `store-${storeId}` });
      } catch (e) {
        console.warn(`[downloadAllDatabases] store-${storeId} недоступна:`, e.message);
      }
    }
    const ts = getLocalTimestamp().replace(/[:\s]/g, '_');
    await sendZipOfSnapshots(res, targets, `all_databases_${ts}.zip`, 'downloadAllDatabases');
  } catch (err) {
    console.error('[downloadAllDatabases] Ошибка:', err);
    next(err);
  }
};

/**
 * Ручной бэкап ВСЕХ БД приложения.
 * Папки per-DB: backups/users/, backups/models/, backups/notifications/,
 * backups/store-N/. Ошибка хотя бы по одной БД — 500 с перечнем.
 */
exports.createBackup = async (req, res, next) => {
  try {
    const result = await BackupService.createDbBackup({ includeTime: true });

    if (result.errors.length) {
      return res.status(500).json({
        error: 'Часть БД не удалось забэкапить',
        created: result.created.map((p) => path.basename(path.dirname(p)) + '/' + path.basename(p)),
        skipped: result.skipped,
        errors: result.errors,
      });
    }

    console.log(
      `[ADMIN][store ${req.storeId}] ${req.user?.name || req.user?.id} создал бэкап: ` +
      `${result.created.length} файл(ов), пропущено ${result.skipped.length}`
    );
    res.json({
      message: `Бэкап создан (${result.created.length} файл(ов))`,
      created: result.created.map((p) => path.basename(path.dirname(p)) + '/' + path.basename(p)),
      skipped: result.skipped,
    });
  } catch (err) {
    console.error('[createBackup] Ошибка:', err);
    next(err);
  }
};

// ============================================================================
// --- АДМИНСКИЕ ИНСТРУМЕНТЫ ---
// ============================================================================

exports.getSchedulerStatus = async (req, res) => {
  res.json({ paused: scheduler.isCheckerPaused(req.storeId) });
};

exports.pauseScheduler = async (req, res) => {
  const wasPaused = scheduler.isCheckerPaused(req.storeId);
  scheduler.pauseChecker(req.storeId);
  console.log(`[ADMIN][store ${req.storeId}] ${req.user?.name || req.user?.id} приостановил авто-проверку`);
  res.json({
    paused: true,
    message: wasPaused
      ? 'Авто-проверка уже была приостановлена'
      : 'Автоматическая проверка заказов приостановлена',
  });
};

exports.resumeScheduler = async (req, res) => {
  const wasPaused = scheduler.isCheckerPaused(req.storeId);
  scheduler.resumeChecker(req.storeId);
  console.log(`[ADMIN][store ${req.storeId}] ${req.user?.name || req.user?.id} возобновил авто-проверку`);
  res.json({
    paused: false,
    message: wasPaused
      ? 'Автоматическая проверка заказов возобновлена'
      : 'Авто-проверка уже работает',
  });
};

exports.deleteProductStats = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const { offerId } = req.params;
    const existing = await ProductStat.get(storeId, offerId);
    if (!existing) {
      return res.status(404).json({ error: `Статистика для ${offerId} не найдена` });
    }
    await ProductStat.delete(storeId, offerId);
    console.log(`[ADMIN][store ${storeId}] ${req.user?.name || req.user?.id} удалил статистику ${offerId}`);
    res.json({ message: `Статистика для ${offerId} удалена` });
  } catch (err) {
    console.error('[deleteProductStats] Ошибка:', err);
    next(err);
  }
};

exports.downloadMaterials = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const filePath = MaterialsService.getFilePath(storeId);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error:
          `Файл настроек материалов для магазина ${storeId} не найден. ` +
          `Ожидается ${MaterialsService.getFileName(storeId)} в папке backend/. ` +
          `Загрузите его через POST /api/admin/materials/upload или посмотрите ` +
          `текущие (дефолтные) значения в GET /api/admin/materials.`,
      });
    }

    disableCache(res);
    res.download(filePath, MaterialsService.getFileName(storeId));
  } catch (err) {
    console.error(`[downloadMaterials][store ${req.storeId}] Ошибка:`, err);
    next(err);
  }
};

exports.getActiveEarningsAll = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const users = await User.getAllInStore(storeId, { includeFired: false });
    const result = [];
    for (const user of users) {
      if (user.role === 'user' || user.role === 'god') continue;
      const base = await Earnings.getActiveSum(storeId, user.id, 0, Date.now());
      const adjustments = await Earnings.getActiveAdjustmentsSum(storeId, user.id, 0, Date.now());
      const total = base + adjustments;
      result.push({
        ...user,
        activeEarningsBase: base,
        activeEarningsAdjustments: adjustments,
        activeEarningsTotal: total,
      });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
};

exports.addEarningsAdjustment = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const { userId, amount, reason } = req.body;
    if (!userId || amount === undefined) {
      return res.status(400).json({ error: 'userId and amount are required' });
    }
    await EarningsService.addAdjustment(
      storeId,
      userId,
      amount,
      reason || '',
      req.user?.name || null,
    );
    res.json({ message: 'Adjustment added successfully' });
  } catch (err) {
    next(err);
  }
};

exports.settleEarnings = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const userId = parseInt(req.params.id);
    const { clearedAmount } = await EarningsService.settleEmployee(
      storeId,
      userId,
      req.user?.name || null,
    );
    res.json({ message: 'Settled', clearedAmount });
  } catch (err) {
    next(err);
  }
};

exports.resetAllEarnings = async (req, res, next) => {
  try {
    const db = getStoreDB(req.storeId);
    await db.run('BEGIN TRANSACTION');
    await db.run('DELETE FROM earnings_history');
    await db.run('DELETE FROM earnings_active');
    await db.run('DELETE FROM earnings_adjustments');
    await db.run('DELETE FROM earnings_adjustments_active');
    await db.run('COMMIT');
    res.json({ message: 'All earnings data cleared' });
  } catch (err) {
    try { await getStoreDB(req.storeId).run('ROLLBACK'); } catch { }
    next(err);
  }
};

exports.clearAssignments = async (req, res, next) => {
  try {
    const db = getStoreDB(req.storeId);
    await db.run('DELETE FROM assignments WHERE status = "assigned"');

    // Чистим in-memory состояния только для ЭТОГО магазина (префикс storeId:)
    const {
      pendingForms,
      pendingFinishConfirmations,
      finishingOrders,
    } = require('../state');
    const prefix = `${req.storeId}_`;
    for (const key of Array.from(pendingForms.keys())) {
      if (key.startsWith(prefix)) pendingForms.delete(key);
    }
    // finishing/pendingFinishConfirmations префиксуются как '<storeId>:<orderId>'
    const statePrefix = `${req.storeId}:`;
    for (const key of Array.from(pendingFinishConfirmations.keys())) {
      if (key.startsWith(statePrefix)) pendingFinishConfirmations.delete(key);
    }
    for (const key of Array.from(finishingOrders.keys())) {
      if (key.startsWith(statePrefix)) finishingOrders.delete(key);
    }

    res.json({ message: 'All assignments cleared' });
  } catch (err) {
    next(err);
  }
};

exports.reloadQueue = async (req, res, next) => {
  try {
    await OrderService.reloadQueue(req.storeId);
    res.json({ message: 'Queue reloaded' });
  } catch (err) {
    next(err);
  }
};

// ============================================================================
// --- MATERIALS (файл глобальный) ---
// ============================================================================

exports.uploadMaterials = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const expectedName = MaterialsService.getFileName(storeId);
    if (req.file.originalname !== expectedName) {
      try { fs.unlinkSync(req.file.path); } catch { }
      return res.status(400).json({
        error: `Неверное имя файла: "${req.file.originalname}". Ожидается "${expectedName}"`,
      });
    }
    const filePath = req.file.path;
    let data;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      data = JSON.parse(content);
    } catch (parseErr) {
      return res.status(400).json({ error: 'Invalid JSON file' });
    }
    if (!data.materials || typeof data.materials !== 'object') {
      throw new Error('Invalid materials format');
    }
    MaterialsService.updateMaterials(storeId, data);
    fs.unlinkSync(filePath);
    res.json({ message: 'Materials updated successfully' });
  } catch (err) {
    console.error(`[uploadMaterials][store ${req.storeId}] Ошибка:`, err);
    if (err.message && err.message.includes('Invalid')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
};

exports.getMaterials = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const data = {
      materials: MaterialsService.getMaterials(storeId),
      specialOffers: MaterialsService.getSpecialOffers(storeId),
      minEarnings: MaterialsService.getMinEarnings(storeId),
      colors: MaterialsService.getColors(storeId),
      fileName: MaterialsService.getFileName(storeId),
    };
    res.json(data);
  } catch (err) {
    console.error(`[getMaterials][store ${req.storeId}] Ошибка:`, err);
    next(err);
  }
};

// ============================================================================
// --- ЭТИКЕТКИ ---
// ============================================================================

async function ensureLabelAvailable(storeId, orderId) {
  const details = await OzonService.getOrderDetails(storeId, orderId);
  if (!details) {
    const err = new Error(`Не удалось получить заказ ${orderId}`);
    err.statusCode = 404;
    throw err;
  }
  if (details.status !== 'awaiting_deliver') {
    const err = new Error(
      `Заказ ${orderId} не в статусе "awaiting_deliver" (текущий: ${details.status}). Этикетка недоступна.`
    );
    err.statusCode = 400;
    throw err;
  }
  return details;
}

exports.downloadOrderLabel = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const { orderId } = req.params;
    await ensureLabelAvailable(storeId, orderId);
    const labelBuffer = await OzonService.getPackageLabel(storeId, orderId);
    if (!labelBuffer) {
      return res.status(404).json({ error: `Не удалось получить этикетку для заказа ${orderId}` });
    }
    console.log(`[ADMIN][store ${storeId}] ${req.user?.name || req.user?.id} скачал этикетку ${orderId}`);
    disableCache(res);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=label_${orderId}.pdf`);
    res.send(labelBuffer);
  } catch (err) {
    console.error(`[downloadOrderLabel][store ${req.storeId}] Ошибка:`, err);
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
};

exports.sendOrderLabelToEmployee = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const { orderId } = req.params;
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'Выберите сотрудника' });
    }
    const employee = await User.getById(parseInt(userId, 10));
    if (!employee) return res.status(404).json({ error: 'Сотрудник не найден' });

    const employeeStore = await UserStore.get(employee.id, storeId);
    if (!employeeStore) {
      return res.status(400).json({ error: `Сотрудник ${employee.name} не привязан к магазину` });
    }
    if (employeeStore.is_fired) {
      return res.status(400).json({ error: `Сотрудник ${employee.name} уволен` });
    }

    await ensureLabelAvailable(storeId, orderId);
    const labelBuffer = await OzonService.getPackageLabel(storeId, orderId);
    if (!labelBuffer) {
      return res.status(404).json({ error: `Не удалось получить этикетку для заказа ${orderId}` });
    }

    const safeOrderId = String(orderId).replace(/[^\w.-]/g, '_');
    // Папка labels per-store: outputs/store-<id>/labels/
    const labelsDir = path.join(__dirname, '../../outputs', `store-${storeId}`, 'labels');
    fs.mkdirSync(labelsDir, { recursive: true });
    fs.writeFileSync(path.join(labelsDir, `${safeOrderId}.pdf`), labelBuffer);

    await NotificationService.notifyUser(employee.id, 'label_sent', {
      orderId,
      adminName: req.user?.name || 'Администратор',
      userName: employee.name,
    }, { storeId });

    console.log(
      `[ADMIN][store ${storeId}] ${req.user?.name || req.user?.id} отправил этикетку ${orderId} сотруднику ${employee.name}`
    );
    res.json({
      message: `Этикетка заказа ${orderId} отправлена сотруднику ${employee.name}`,
    });
  } catch (err) {
    console.error(`[sendOrderLabelToEmployee][store ${req.storeId}] Ошибка:`, err);
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
};

// ============================================================================
// --- 3D-МОДЕЛИ (models.db + S3 — глобальные, но проверяем disableModels) ---
// ============================================================================

exports.listModels = async (req, res, next) => {
  try {
    if (stores.getStore(req.storeId).features.disableModels) {
      return res.json([]);
    }
    const models = await ModelService.listModels();
    res.json(models);
  } catch (err) {
    console.error('[listModels] Ошибка:', err);
    next(err);
  }
};

exports.uploadModel = async (req, res, next) => {
  try {
    if (stores.getStore(req.storeId).features.disableModels) {
      return res.status(403).json({ error: 'Работа с моделями отключена для этого магазина' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не передан (поле file)' });
    }

    let offerId = req.body.offerId || req.body.offer_id || '';
    if (!offerId) {
      const original = req.file.originalname || '';
      offerId = original.replace(/\.zip$/i, '');
    }

    const buffer = fs.readFileSync(req.file.path);
    try { fs.unlinkSync(req.file.path); } catch { }

    const record = await ModelService.uploadModel(
      offerId,
      buffer,
      req.user.id,
      req.file.originalname || null,
      { storeId: req.storeId, uploaderName: req.user?.name || null }
    );

    console.log(`[ADMIN][store ${req.storeId}] ${req.user?.name || req.user?.id} загрузил модель ${record.offer_id}`);
    res.json({
      message: `Модель ${record.offer_id} загружена (${record.entries.length} файл(ов) в архиве)`,
      model: record,
    });
  } catch (err) {
    console.error('[uploadModel] Ошибка:', err);
    const isValidation =
      err.validation === true || (err.message && !err.message.includes('S3'));
    if (isValidation) {
      await NotificationService.notifyUser(
        req.user.id,
        'model_upload_rejected',
        {
          offerId: req.body.offerId || req.body.offer_id || null,
          fileName: req.file?.originalname || null,
          error: err.message,
        },
        { storeId: req.storeId, persist: false },
      );
      return res.status(400).json({ error: err.message, rejected: true });
    }
    next(err);
  }
};

exports.deleteModel = async (req, res, next) => {
  try {
    if (stores.getStore(req.storeId).features.disableModels) {
      return res.status(403).json({ error: 'Работа с моделями отключена для этого магазина' });
    }
    const { offerId } = req.params;
    const normalized = String(offerId).trim().replace(/\.zip$/i, '');
    if (!normalized) {
      return res.status(400).json({ error: 'Некорректный артикул' });
    }
    await ModelService.deleteModel(normalized, req.user.id, {
      storeId: req.storeId,
      adminName: req.user?.name || null,
    });
    console.log(`[ADMIN][store ${req.storeId}] ${req.user?.name || req.user?.id} удалил модель ${normalized}`);
    res.json({ message: `Модель ${normalized} удалена` });
  } catch (err) {
    console.error('[deleteModel] Ошибка:', err);
    next(err);
  }
};

exports.downloadModel = async (req, res, next) => {
  try {
    if (stores.getStore(req.storeId).features.disableModels) {
      return res.status(403).json({ error: 'Работа с моделями отключена для этого магазина' });
    }
    const { offerId } = req.params;
    const normalized = String(offerId).trim().replace(/\.zip$/i, '');
    const info = await ModelService.getDownloadInfo(normalized, { storeId: req.storeId });
    if (!fs.existsSync(info.path)) {
      return res.status(404).json({ error: 'Файл модели не найден в хранилище' });
    }
    disableCache(res);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${info.fileName}"`);
    if (info.size) res.setHeader('Content-Length', String(info.size));
    if (info.version) res.setHeader('X-Model-Version', String(info.version));
    const stream = fs.createReadStream(info.path);
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.end(); });
    stream.pipe(res);
  } catch (err) {
    console.error('[downloadModel] Ошибка:', err);
    if (err.message && err.message.includes('ENOENT')) {
      return res.status(404).json({ error: 'Модель не найдена' });
    }
    next(err);
  }
};