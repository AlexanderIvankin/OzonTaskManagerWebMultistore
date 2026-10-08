const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { User, UserStore, Warehouse } = require('../models');
const { getUsersDB, getStoreDB } = require('../config/database');
const stores = require('../config/stores');
const OzonService = require('./OzonService');
const NotificationService = require('./NotificationService');
const {
  getVersionedFileName,
  formatPhonePretty,
  parseEmail,
  parseTgUserId,
  parseCapacity,
  parseEarningsFactor,
} = require('../utils');
const config = require('../config');

// ============================================================================
// SyncService (multistore).
//
// Синхронизация сотрудников из Excel работает В КОНТЕКСТЕ МАГАЗИНА:
//   • users.db — глобальный список пользователей;
//   • user_stores — роль/статус пользователя в ЭТОМ магазине;
//   • store-N.db — склады магазина (user_warehouses).
//
// ПРАВИЛА О Создателе ('god'):
//   • users.role = 'god' — глобальный. НИКОГДА не трогается синхронизацией
//     (не понижается, не увольняется);
//   • user_stores.role = 'god' — то же: если запись есть, оставляем без правок;
//   • если в Excel попала строка Создателя (по GOD_EMAIL/GOD_ID из .env),
//     она полностью игнорируется для per-store обновлений.
//
// Увольнение из магазина НЕ понижает роль в user_stores — просто is_fired=1.
// ============================================================================

/**
 * Идентификаторы Создателя читаются из .env НАПРЯМУЮ (с кэшем по mtime файла),
 * а не из кэша config: правки GOD_EMAIL/GOD_ID подхватываются при следующей
 * синхронизации без перезапуска сервера.
 */
let godEnvCache = { mtime: null, email: '', id: '' };
function readGodEnv() {
  try {
    const envPath = path.resolve(__dirname, '../../.env');
    const mtime = fs.existsSync(envPath) ? fs.statSync(envPath).mtimeMs : null;
    if (godEnvCache.mtime === mtime && mtime !== null) return godEnvCache;
    let email = '';
    let id = '';
    if (mtime !== null) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^\s*(GOD_EMAIL|GOD_ID)\s*=\s*(.*)$/);
        if (!m) continue;
        const raw = m[2].trim();
        const val = raw.split('#')[0].trim().replace(/^["']|["']$/g, '');
        if (m[1] === 'GOD_EMAIL') email = val.toLowerCase();
        else id = val;
      }
    }
    godEnvCache = { mtime, email, id };
    console.log(
      `[SyncService] Идентификаторы Создателя: GOD_EMAIL="${email}", GOD_ID="${id}"`
    );
    return godEnvCache;
  } catch (err) {
    console.warn('[SyncService] Не удалось прочитать .env (GOD_EMAIL/GOD_ID):', err.message);
    return { mtime: null, email: '', id: '' };
  }
}

/**
 * Путь к файлу-экспорту конкретного магазина: outputs/store-<id>/<fileName>.
 * Файлы разных магазинов физически разделены.
 */
function storeOutputPath(storeId, fileName) {
  const dir = path.join(__dirname, '../../outputs', `store-${storeId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, fileName);
}

/**
 * Проверяет, принадлежит ли строка из Excel Создателю.
 */
function isGodIdentity(data, godEnv) {
  const godEmail = godEnv.email || config.god.email;
  const godId = godEnv.id || config.god.id;
  const email = String(data.email || '').trim().toLowerCase();
  const tgUserId = String(data.tgUserId || '').trim();
  if (godEmail && email === godEmail) return true;
  if (godId && tgUserId === godId) return true;
  return false;
}

class SyncService {
  /**
   * Перегенерирует серверные Excel-файлы сотрудников МАГАЗИНА
   * (team-info.xlsx и employees-db.xlsx), чтобы они соответствовали
   * состоянию user_stores магазина.
   */
  static async refreshServerExports(storeId) {
    if (!storeId) {
      console.warn('[SyncService] refreshServerExports: storeId не задан, пропускаем');
      return;
    }
    try {
      await this.exportTeamInfoXlsx(null, false, 'team-info.xlsx', {
        storeId,
        syncWarehouses: false,
      });
      await this.exportTeamInfoXlsx(null, true, 'employees-db.xlsx', {
        storeId,
        syncWarehouses: false,
      });
      console.log(`[SyncService][store ${storeId}] Excel-файлы сотрудников перегенерированы`);
    } catch (err) {
      console.warn(`[SyncService][store ${storeId}] Не удалось перегенерировать Excel:`, err.message);
    }
  }

  /**
   * Регистронезависимый поиск пользователя по email (глобально в users.db).
   */
  static async findUserByEmailCI(email) {
    if (!email) return null;
    const db = getUsersDB();
    return db.get(
      'SELECT * FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) LIMIT 1',
      email
    );
  }

  /**
 * Назначить пользователя Создателем ('god').
 *
 * Единственный god на всю систему. Если он уже был назначен (другой id) —
 * снимаем с предыдущего (понижаем до 'admin' глобально и во всех
 * user_stores). Новый god получает:
 *   • users.role = 'god' (глобально);
 *   • user_stores.role = 'god' во ВСЕХ магазинах (is_fired=0, was_employee=1).
 *
 * После этого аккаунт неприкосновенен: syncFromExcel и увольнение его
 * игнорируют (см. continue по user.role === 'god').
 *
 * @param {number} userId
 */
  static async ensureGodStatus(userId) {
    const usersDb = getUsersDB();
    const now = Date.now();

    // 1. Снять god со всех остальных (единственность Создателя).
    // Понижение до 'admin' — права сохраняются, но неприкосновенности больше нет.
    const otherGods = await usersDb.all(
      "SELECT id FROM users WHERE role = 'god' AND id != ?",
      userId
    );
    for (const g of otherGods) {
      await usersDb.run(
        "UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?",
        now, g.id
      );
      await usersDb.run(
        "UPDATE user_stores SET role = 'admin', updated_at = ? WHERE user_id = ? AND role = 'god'",
        now, g.id
      );
      console.log(
        `[SyncService] Роль 'god' снята с #${g.id} (понижен до 'admin') — Создатель один: #${userId}`
      );
    }

    // 2. Глобальная роль
    await usersDb.run(
      "UPDATE users SET role = 'god', updated_at = ? WHERE id = ?",
      now, userId
    );

    // 3. Per-store: god во всех магазинах
    for (const storeId of stores.getStoreIds()) {
      const existing = await UserStore.get(userId, storeId);
      if (existing) {
        await UserStore.upsert(userId, storeId, { role: 'god', is_fired: 0 });
      } else {
        await UserStore.upsert(userId, storeId, {
          role: 'god',
          is_fired: 0,
          was_employee: 1,
        });
      }
    }

    console.log(
      `[SyncService] Пользователь #${userId} назначен Создателем ('god') глобально и во всех магазинах`
    );
  }

  /**
   * Синхронизация сотрудников магазина из Excel.
   *
   * @param {string} filePath
   * @param {number} adminUserId
   * @param {Object} options
   *   storeId        — ОБЯЗАТЕЛЬНО: магазин, в который синхронизируем;
   *   createMissing  — создавать новых пользователей (default: false);
   *   syncBy         — 'email' (default) | 'tg';
   *   allowPromotion — разрешено ли повышать обычного пользователя до
   *                    сотрудника магазина (true — файл загружен вручную;
   *                    false — серверный файл только отражает состояние БД).
   * @returns {Promise<{updated: number, created: number, skipped: number, fired: number}>}
   */
  static async syncFromExcel(filePath, adminUserId, options = {}) {
    const storeId = options.storeId;
    if (!storeId) {
      throw new Error('SyncService.syncFromExcel: storeId обязателен (multistore)');
    }
    const opts = {
      createMissing: false,
      syncBy: 'email',
      allowPromotion: true,
      ...options,
    };

    console.log(`[SyncService][store ${storeId}] Синхронизация из Excel (запустил админ #${adminUserId ?? 'система'})`);
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (!rows || rows.length < 3) {
      throw new Error('Файл слишком короткий или пустой');
    }

    const headerRow = rows[1];
    const emailHeader = (headerRow[1] || '').toLowerCase();
    if (!emailHeader.includes('email')) {
      console.warn('[Sync] Второй столбец, возможно, не email. Проверьте файл.');
    }

    // Колонки складов — начиная с G (индекс 6)
    const warehouseColumns = [];
    for (let col = 6; col < headerRow.length; col++) {
      const cellValue = headerRow[col];
      if (cellValue && typeof cellValue === 'string') {
        const match = cellValue.match(/ID:\s*(\d+)/i);
        if (match) {
          warehouseColumns.push({ colIndex: col, warehouseId: match[1] });
        }
      }
    }

    // Парсим строки
    const usersData = [];
    const problemRows = [];
    for (let i = 2; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 6) continue;

      const name = String(row[0] || '').trim();
      const emailRaw = String(row[1] || '').trim();
      const tgRaw = String(row[2] || '').trim();
      const phoneRaw = String(row[3] || '').trim();
      const capacityRaw = row[4];
      const factorRaw = row[5];

      const email = parseEmail(emailRaw);
      const tgUserId = parseTgUserId(tgRaw);
      const phonePretty = phoneRaw ? formatPhonePretty(phoneRaw) : '';
      const capacity = parseCapacity(capacityRaw);
      const earningsFactor = parseEarningsFactor(factorRaw);
      const hasCapacityValue = String(capacityRaw ?? '').trim() !== '';
      const hasFactorValue = String(factorRaw ?? '').trim() !== '';

      const rowProblems = [];
      if (name) {
        if (emailRaw && !email) rowProblems.push({ field: 'email', raw: emailRaw, note: 'не распознан — синхронизация по нему невозможна' });
        if (tgRaw && !tgUserId) rowProblems.push({ field: 'tg_user_id', raw: tgRaw, note: 'ожидается последовательность цифр — очищен' });
        if (phoneRaw && !phonePretty) rowProblems.push({ field: 'phone', raw: phoneRaw, note: 'не распознан — телефон очищен' });
        if (hasCapacityValue && capacity === null) rowProblems.push({ field: 'capacity', raw: String(capacityRaw).trim(), note: 'ожидается целое >= 1 — заменено на 1' });
        if (hasFactorValue && earningsFactor === null) rowProblems.push({ field: 'earnings_factor', raw: String(factorRaw).trim(), note: 'ожидается число с максимум 2 знаками — заменено на 1.0' });
      }

      if (!name || (!email && !tgUserId)) {
        if (name && !email && !tgUserId) {
          rowProblems.push({
            field: 'identifiers',
            raw: [emailRaw, tgRaw].filter(Boolean).join(' / '),
            note: 'нет корректных E-mail и Telegram ID — строка пропущена',
          });
          problemRows.push({ name, problems: rowProblems });
        }
        continue;
      }

      const warehouses = [];
      for (const colInfo of warehouseColumns) {
        const val = row[colInfo.colIndex];
        if (val === '+' || val === '➕' || val === '✔') {
          warehouses.push(colInfo.warehouseId);
        }
      }

      usersData.push({
        name,
        email,
        tgUserId,
        tgRaw,
        phoneRaw,
        phonePretty,
        capacity: capacity ?? 1,
        earningsFactor: earningsFactor ?? 1.0,
        warehouses,
      });
      if (rowProblems.length) problemRows.push({ name, problems: rowProblems });
    }

    const usersDb = getUsersDB();
    const storeDb = getStoreDB(storeId);
    const godEnv = readGodEnv();

    let updated = 0;
    let created = 0;
    let skipped = 0;

    for (const data of usersData) {
      // 1. Поиск глобального пользователя
      let user = null;
      if (opts.syncBy === 'email' && data.email) {
        user = await this.findUserByEmailCI(data.email);
        if (!user && data.tgUserId) user = await User.findByTgId(data.tgUserId);
      } else if (data.tgUserId) {
        user = await User.findByTgId(data.tgUserId);
        if (!user && data.email) user = await this.findUserByEmailCI(data.email);
      } else {
        skipped++;
        continue;
      }

      // Расширенный поиск Создателя (по .env)
      if (!user && isGodIdentity(data, godEnv)) {
        const godEmail = godEnv.email || config.god.email;
        const godId = godEnv.id || config.god.id;
        if (godEmail || godId) {
          user = await usersDb.get(
            `SELECT * FROM users
             WHERE (LOWER(TRIM(email)) = LOWER(TRIM(?)) AND ? <> '')
                OR (TRIM(COALESCE(tg_user_id, '')) = ? AND ? <> '')
             LIMIT 1`,
            godEmail || '\u0000', godEmail || '',
            godId || '\u0000', godId || ''
          );
          if (user) {
            console.log(`[SyncService][store ${storeId}] Создатель найден по .env: #${user.id} (${user.email || 'без email'})`);
          }
        }
      }

      if (user) {
        // --- Создатель уже назначен глобально ---
        // Полностью игнорируем: он неприкосновенен для любой синхронизации,
        // его нельзя уволить/понизить через Excel.
        if (user.role === 'god') {
          console.log(
            `[SyncService][store ${storeId}] Строка Создателя (#${user.id}) пропущена: уже 'god'`
          );
          continue;
        }

        if (user) {
          // --- Создатель уже назначен глобально ---
          if (user.role === 'god') {
            console.log(
              `[SyncService][store ${storeId}] Строка Создателя (#${user.id}) пропущена: уже 'god'`
            );
            continue;
          }

          // --- Первое назначение Создателя ---
          if (isGodIdentity(data, godEnv)) {
            await this.ensureGodStatus(user.id);
            updated++;
            continue;
          }

          // --- Гость (email не подтверждён) ---
          // Пропускаем полностью: не создаём запись в user_stores и не трогаем
          // users. Гость станет пользователем только после подтверждения email
          // (AuthService.verifyEmail), тогда следующая синхронизация обработает
          // его нормально.
          if (user.role === 'guest') {
            console.log(
              `[SyncService][store ${storeId}] Пользователь #${user.id} (${data.name}) — гость (email не подтверждён), пропускаем`
            );
            skipped++;
            continue;
          }
        }

        // --- Глобальные поля users ---
        const globalFields = {
          name: data.name,
          phone: data.phoneRaw === '' ? (user.phone || '') : (data.phonePretty || ''),
          capacity: data.capacity,
        };
        if (data.tgUserId && user.tg_user_id !== data.tgUserId) {
          globalFields.tg_user_id = data.tgUserId;
        } else if (!data.tgUserId && data.tgRaw) {
          globalFields.tg_user_id = '';
        }
        // Гость (email не подтверждён) — не активируем
        if (user.role !== 'guest') {
          globalFields.taking_orders = 1;
        }
        await User.update(user.id, globalFields);

        // --- Per-store: user_stores ---
        const existing = await UserStore.get(user.id, storeId);
        if (existing) {
          // Если в user_stores роль 'god' — неприкосновенно
          if (existing.role === 'god') {
            console.log(
              `[SyncService][store ${storeId}] Пользователь #${user.id} — 'god' в магазине, per-store поля не трогаем`
            );
          } else {
            await UserStore.upsert(user.id, storeId, {
              is_fired: 0,
              earnings_factor: data.earningsFactor,
              was_employee: 1,
            });
            if (existing.is_fired) {
              console.log(`[SyncService][store ${storeId}] Пользователь #${user.id} (${data.name}) восстановлен`);
            }
          }
        } else if (opts.allowPromotion) {
          // Нового сотрудника магазина создаём с ролью employee
          await UserStore.upsert(user.id, storeId, {
            role: 'employee',
            is_fired: 0,
            earnings_factor: data.earningsFactor,
            was_employee: 1,
          });
          console.log(`[SyncService][store ${storeId}] Пользователь #${user.id} (${data.name}) повышен до сотрудника`);
        } else {
          console.log(
            `[SyncService][store ${storeId}] Пользователь #${user.id} (${data.name}) есть в файле, но роль не создаём (серверный team-info.xlsx не повышает)`
          );
          skipped++;
          continue;
        }

        // --- Склады магазина ---
        await Warehouse.clearUserWarehouses(storeId, user.id);
        for (const whId of data.warehouses) {
          await Warehouse.addUserWarehouse(storeId, user.id, whId);
        }

        updated++;
      } else if (opts.createMissing) {
        // Создание нового глобального пользователя + сотрудника магазина
        const randomPassword = Math.random().toString(36).slice(-8);
        const passwordHash = await bcrypt.hash(randomPassword, 10);

        const newUser = await User.create({
          username: data.email || data.tgUserId || `user_${Date.now()}`,
          email: data.email || `user_${Date.now()}@temp.local`,
          passwordHash,
          name: data.name,
          phone: data.phonePretty || '',
          capacity: data.capacity,
          earningsFactor: data.earningsFactor,
          role: 'user', // глобально всегда 'user' (god назначается только через .env)
          tgUserId: data.tgUserId || null,
        });

        // В магазине — сотрудник
        await UserStore.upsert(newUser.id, storeId, {
          role: 'employee',
          is_fired: 0,
          earnings_factor: data.earningsFactor,
          was_employee: 1,
        });

        for (const whId of data.warehouses) {
          await Warehouse.addUserWarehouse(storeId, newUser.id, whId);
        }
        created++;
      } else {
        skipped++;
        if (isGodIdentity(data, godEnv)) {
          console.warn(
            `[SyncService][store ${storeId}] Строка Создателя (GOD_EMAIL/GOD_ID) в Excel, но пользователь не найден и createMissing выключен. ` +
            `Создайте аккаунт вручную и повторите синхронизацию.`
          );
        }
      }
    }

    // === Оповещение персонала о проблемных данных ===
    if (problemRows.length) {
      const admin = adminUserId ? await User.getById(adminUserId) : null;
      const adminName = (admin && admin.name) || 'Система';
      const flat = problemRows.flatMap((p) =>
        p.problems.map((pr) => ({ name: p.name, field: pr.field, raw: pr.raw, note: pr.note }))
      );
      console.warn(`[SyncService][store ${storeId}] В Excel проблемных значений: ${flat.length}`);
      for (const pr of flat) {
        console.warn(`[SyncService][store ${storeId}]   • ${pr.name || '(без имени)'}: ${pr.field} «${pr.raw}» — ${pr.note}`);
      }
      await NotificationService.notifyStaff(
        'sync_data_invalid',
        {
          fileName: path.basename(filePath),
          adminName,
          problems: flat,
          userName: flat.map((pr) => pr.name).filter(Boolean).slice(0, 3).join(', ') || null,
        },
        { storeId, push: false }
      );
    }

    // === Увольнение сотрудников магазина, отсутствующих в актуальном файле ===
    // Активные сотрудники ЭТОГО магазина: user_stores.was_employee=1, is_fired=0.
    // Исключаем:
    //   • роль 'god' в user_stores — неприкосновенно;
    //   • глобальный users.role='god' (Создатель) — неприкосновенно.
    const excelEmails = new Set(usersData.map((d) => d.email).filter(Boolean));
    const excelTgIds = new Set(usersData.map((d) => d.tgUserId).filter(Boolean));

    // Увольняем ТОЛЬКО сотрудников магазина (us.role = 'employee'), а не
    // admin/moderator/god. Логика паритетна старой версии (users.role =
    // 'employee'): у админов/модераторов членство в Excel не обязательно,
    // их роль назначается вручную и не должна слетать при синхронизации.
    const activeEmployees = await usersDb.all(
      `SELECT u.id, u.username, u.name, u.email, u.tg_user_id, us.role AS store_role
       FROM users u
       INNER JOIN user_stores us ON us.user_id = u.id
       WHERE us.store_id = ?
         AND us.is_fired = 0
         AND us.was_employee = 1
         AND us.role = 'employee'
         AND u.role != 'god'`,
      String(storeId)
    );

    let fired = 0;
    for (const emp of activeEmployees) {
      const inExcel =
        (emp.email && excelEmails.has(String(emp.email).trim().toLowerCase())) ||
        (emp.tg_user_id && excelTgIds.has(String(emp.tg_user_id).trim()));
      if (inExcel) continue;

      console.log(
        `[SyncService][store ${storeId}] Сотрудник #${emp.id} (${emp.name || emp.username}) отсутствует в файле — is_fired=1`
      );
      // Роль в user_stores СОХРАНЯЕТСЯ — только статус
      await UserStore.fire(emp.id, storeId);
      // Снять активные назначения ТОЛЬКО в этом магазине
      await storeDb.run('DELETE FROM assignments WHERE user_id = ? AND status = "assigned"', emp.id);
      fired++;
    }

    console.log(
      `[SyncService][store ${storeId}] Синхронизация завершена: обновлено ${updated}, создано ${created}, пропущено ${skipped}, уволено ${fired}`
    );

    // Перегенерируем серверные Excel этого магазина
    await this.refreshServerExports(storeId);

    return { updated, created, skipped, fired };
  }

  /**
   * Экспорт сотрудников МАГАЗИНА в Excel.
   *
   * Создатель ('god') исключается из списков: он всегда "сотрудник"
   * глобально, но в файле конкретного магазина ему нечего делать —
   * он не увольняется и не синхронизируется.
   *
   * @param {number} adminUserId — для логов
   * @param {boolean} includeFired — включать уволенных (employees-db.xlsx)
   * @param {string} outputFileName — 'team-info.xlsx' | 'employees-db.xlsx'
   * @param {Object} options
   *   storeId        — ОБЯЗАТЕЛЬНО
   *   syncWarehouses — синхронизировать склады из Ozon перед экспортом
   * @returns {Promise<string>} путь к файлу
   */
  static async exportTeamInfoXlsx(adminUserId, includeFired = false, outputFileName = 'team-info.xlsx', { storeId, syncWarehouses = true } = {}) {
    if (!storeId) {
      throw new Error('SyncService.exportTeamInfoXlsx: storeId обязателен (multistore)');
    }
    const usersDb = getUsersDB();
    const storeDb = getStoreDB(storeId);

    // 1. Синхронизация складов (по умолчанию)
    if (syncWarehouses) {
      try {
        const warehousesFromOzon = await OzonService.fetchWarehouses(storeId);
        if (warehousesFromOzon.length) {
          await Warehouse.syncAll(storeId, warehousesFromOzon);
          console.log(`[SyncService][store ${storeId}] Склады синхронизированы перед экспортом`);
        }
      } catch (err) {
        console.warn(`[SyncService][store ${storeId}] Не удалось синхронизировать склады:`, err.message);
      }
    }

    // 2. Получаем сотрудников ЭТОГО магазина, исключая 'god' и гостей.
    // Роль/is_fired/earnings_factor/was_employee — из user_stores.
    const filters = {
      includeFired,
      excludeRole: 'god',
    };
    const users = await User.getAllInStore(storeId, filters);

    const warehouses = await Warehouse.getAll(storeId);

    // 3. Связи пользователь-склад из store-N.db
    const userWarehouses = await storeDb.all('SELECT user_id, warehouse_id FROM user_warehouses');
    const map = new Map();
    for (const uw of userWarehouses) {
      if (!map.has(uw.user_id)) map.set(uw.user_id, new Set());
      map.get(uw.user_id).add(uw.warehouse_id);
    }

    // 4. Создаём Excel
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Сотрудники');

    const header1 = ['Сотрудник', 'E-mail', 'Telegram ID', 'Телефон', 'Число принтеров', 'Коэффициент Заработка', ''];
    const header2 = ['', '', '', '', '', '', ''];
    for (const wh of warehouses) {
      header1.push('');
      header2.push(`${wh.name} (ID: ${wh.warehouse_id})`);
    }

    const row1 = worksheet.addRow(header1);
    const row2 = worksheet.addRow(header2);

    if (warehouses.length) {
      const startCol = 8;
      const endCol = 7 + warehouses.length;
      const startLetter = String.fromCharCode(64 + startCol);
      const endLetter = String.fromCharCode(64 + endCol);
      worksheet.mergeCells(`${startLetter}1:${endLetter}1`);
      row1.getCell(startCol).value = 'Склады';
    }

    [row1, row2].forEach(row => {
      row.eachCell(cell => {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = { bold: true };
      });
    });

    const widths = [45, 45, 30, 30, 30, 30, 15];
    for (let i = 0; i < widths.length; i++) {
      worksheet.getColumn(i + 1).width = widths[i];
    }
    for (let i = 0; i < warehouses.length; i++) {
      worksheet.getColumn(8 + i).width = 75;
    }

    for (const user of users) {
      const whSet = map.get(user.id) || new Set();
      const rowData = [
        user.name,
        user.email || '',
        user.tg_user_id || '',
        formatPhonePretty(user.phone) || user.phone || '',
        user.capacity,
        user.earnings_factor || 1.0,
        '',
      ];
      for (const wh of warehouses) {
        rowData.push(whSet.has(wh.warehouse_id) ? '+' : '');
      }
      const dataRow = worksheet.addRow(rowData);
      dataRow.eachCell((cell, colNum) => {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        if (colNum === 3 || colNum === 4) cell.numFmt = '@';
        if (colNum === 6) cell.numFmt = '0.00';
      });
    }

    // Путь: outputs/store-<id>/<имя>.xlsx
    const baseName = outputFileName.replace(/\.xlsx$/i, '');
    const finalFileName = getVersionedFileName(baseName, 'xlsx', storeId);
    const outputPath = storeOutputPath(storeId, finalFileName);
    await workbook.xlsx.writeFile(outputPath);
    console.log(`[SyncService][store ${storeId}] Экспорт в ${finalFileName} выполнен`);
    return outputPath;
  }
}

module.exports = SyncService;