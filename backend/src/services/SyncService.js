const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { User, Warehouse } = require('../models');
const { getDB } = require('../config/database');
const bcrypt = require('bcrypt');
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

/**
 * Идентификаторы Создателя читаются из .env НАПРЯМУЮ (с кэшем по mtime файла),
 * а не из кэша config, загруженного при старте сервера. Так правки
 * GOD_EMAIL/GOD_ID подхватываются при следующей синхронизации даже без
 * перезапуска сервера.
 * @returns {{ mtime: number|null, email: string, id: string }}
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
        // Снимаем возможные кавычки и хвостовые комментарии ("значение # коммент")
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
 * Сервис синхронизации пользователей из Excel.
 * Поддерживает синхронизацию по email (основной) или по tg_user_id.
 */
class SyncService {
  /**
   * Проверяет, принадлежит ли запись из Excel Создателю (роль 'god').
   * Создатель всегда в единственном числе; его идентификаторы задаются
   * в .env: GOD_EMAIL (email) и GOD_ID (tg_user_id).
   * @param {{ email?: string, tgUserId?: string }} data
   * @returns {boolean}
   */
  static isGodIdentity(data) {
    const godEnv = readGodEnv();
    const godEmail = godEnv.email || config.godEmail;
    const godId = godEnv.id || config.godId;
    const email = String(data.email || '').trim().toLowerCase();
    const tgUserId = String(data.tgUserId || '').trim();
    if (godEmail && email === godEmail) return true;
    if (godId && tgUserId === godId) return true;
    return false;
  }

  /**
   * Перегенерирует серверные Excel-файлы сотрудников (team-info и employees-db)
   * по текущему состоянию БД. Вызывается после ЛЮБОГО изменения активного
   * состава/ролей/статуса is_fired, чтобы серверный Excel не «откатывал»
   * изменения при следующей синхронизации.
   */
  static async refreshServerExports() {
    try {
      await this.exportTeamInfoXlsx(null, false, 'team-info.xlsx', { syncWarehouses: false });
      await this.exportTeamInfoXlsx(null, true, 'employees-db.xlsx', { syncWarehouses: false });
      console.log('[SyncService] Excel-файлы сотрудников перегенерированы');
    } catch (err) {
      // Перегенерация не критична — логируем и не выбрасываем
      console.warn('[SyncService] Не удалось перегенерировать Excel-файлы:', err.message);
    }
  }

  /**
   * Регистронезависимый поиск пользователя по email.
   * Email в БД может храниться в другом регистре, чем в Excel (например,
   * «Ivan@Mail.Ru»), а точное сравнение не находило запись — и сотрудник
   * пропускался без апгрейда user → employee.
   * @param {string} email - email из Excel (уже в нижнем регистре)
   */
  static async findUserByEmailCI(email) {
    if (!email) return null;
    const db = getDB();
    return db.get(
      'SELECT * FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) LIMIT 1',
      email
    );
  }

  /**
   * Синхронизация из файла team-info.xlsx
   * @param {string} filePath - путь к файлу
   * @param {number} adminUserId - ID администратора (для лога)
   * @param {Object} options - { createMissing: boolean, syncBy: 'email' | 'tg',
   *   allowPromotion: boolean }
   *   allowPromotion — разрешено ли повышение user → employee. true (по
   *   умолчанию) — файл загружен персоналом ВРУЧНУЮ: добавление email в
   *   team-info.xlsx осознанное действие. false — файл сгенерирован самим
   *   сервером (кнопка «Обновить» читает серверный team-info.xlsx): такой
   *   файл лишь отражает состояние БД и НЕ вправе менять роли, иначе
   *   подтверждённый 'user', случайно попавший в файл, автоматически
   *   становился бы сотрудником.
   * @returns {Promise<{ updated: number, created: number, skipped: number, fired: number }>}
   */
  static async syncFromExcel(filePath, adminUserId, options = { createMissing: false, syncBy: 'email', allowPromotion: true }) {
    console.log(`[SyncService] Синхронизация из Excel (запустил админ #${adminUserId ?? 'система'})`);
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (!rows || rows.length < 3) {
      throw new Error('Файл слишком короткий или пустой');
    }

    // --- Заголовки: строка 1 (индекс 1) ---
    const headerRow = rows[1];
    // Проверяем, что в столбце B есть '@' – значит это email
    const emailHeader = (headerRow[1] || '').toLowerCase();
    if (!emailHeader.includes('email')) {
      console.warn('[Sync] Второй столбец, возможно, не email. Проверьте файл.');
    }

    // --- Определяем колонки складов (начиная с индекса 6, т.е. столбец G) ---
    const warehouseColumns = [];
    for (let col = 6; col < headerRow.length; col++) {
      const cellValue = headerRow[col];
      if (cellValue && typeof cellValue === 'string') {
        const match = cellValue.match(/ID:\s*(\d+)/i);
        if (match) {
          warehouseColumns.push({
            colIndex: col,
            warehouseId: match[1]
          });
        }
      }
    }

    // --- Парсим данные сотрудников (начиная со строки 2) ---
    // Все поля проходят парсинг/валидацию (см. ../utils):
    //   • email      — латиница/цифры/._%+- (кириллица и пробелы ломают
    //                  матчинг сотрудника по email);
    //   • tg_user_id — только последовательность цифр;
    //   • телефон    — '+7 (999) 123-45-67' / '79991234567' / '89991234567' /
    //                  '9991234567' (10 цифр) → единый красивый формат;
    //   • capacity   — целое число >= 1;
    //   • factor     — положительное число, максимум 2 знака ('99,99' и '99.99').
    // При ошибке парсинга значение заменяется на дефолт (телефон/Telegram ID —
    // '', число принтеров — 1, коэффициент — 1.0), а проблема уходит в
    // агрегированное оповещение персоналу (sync_data_invalid, в конце синха).
    const usersData = [];
    const problemRows = []; // { name, problems: [{ field, raw, note }] }
    for (let i = 2; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 6) continue; // минимум 6 колонок (A–F)

      const name = String(row[0] || '').trim();
      const emailRaw = String(row[1] || '').trim();
      const tgRaw = String(row[2] || '').trim();
      const phoneRaw = String(row[3] || '').trim();
      const capacityRaw = row[4];
      const factorRaw = row[5];

      const email = parseEmail(emailRaw);          // null, если пусто/невалидно
      const tgUserId = parseTgUserId(tgRaw);       // только цифры
      const phonePretty = phoneRaw ? formatPhonePretty(phoneRaw) : '';
      const capacity = parseCapacity(capacityRaw); // null, если пусто/невалидно
      const earningsFactor = parseEarningsFactor(factorRaw);
      const hasCapacityValue = String(capacityRaw ?? '').trim() !== '';
      const hasFactorValue = String(factorRaw ?? '').trim() !== '';

      // Проблемы строки. Пустые строки-«хвосты» (без имени) игнорируем молча —
      // это обычное заполнение файла, а не ошибка данных.
      const rowProblems = [];
      if (name) {
        if (emailRaw && !email) {
          rowProblems.push({
            field: 'email',
            raw: emailRaw,
            note: 'не распознан (кириллица/пробелы/неверный формат) — синхронизация по нему невозможна',
          });
        }
        if (tgRaw && !tgUserId) {
          rowProblems.push({
            field: 'tg_user_id',
            raw: tgRaw,
            note: 'ожидается последовательность цифр — Telegram ID очищен',
          });
        }
        if (phoneRaw && !phonePretty) {
          rowProblems.push({
            field: 'phone',
            raw: phoneRaw,
            note: 'не распознан (нужно 11 цифр: +7/7/8… или 10 цифр без кода страны) — телефон очищен',
          });
        }
        if (hasCapacityValue && capacity === null) {
          rowProblems.push({
            field: 'capacity',
            raw: String(capacityRaw).trim(),
            note: 'ожидается целое число >= 1 — заменено на 1',
          });
        }
        if (hasFactorValue && earningsFactor === null) {
          rowProblems.push({
            field: 'earnings_factor',
            raw: String(factorRaw).trim(),
            note: 'ожидается положительное число с максимум 2 знаками после запятой (99,99 или 99.99) — заменено на 1.0',
          });
        }
      }

      if (!name || (!email && !tgUserId)) {
        // Пропускаем строки без имени и без идентификатора. Если имя есть,
        // но нет НИ ОДНОГО корректного идентификатора — сотрудника нечем
        // синхронизировать: сообщаем персоналу.
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

      // Собираем склады
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

    const db = getDB();
    let updated = 0, created = 0, skipped = 0;

    for (const data of usersData) {
      // Поиск пользователя: если syncBy = 'email' и email есть – ищем по email
      // (регистронезависимо — регистр в БД и Excel может отличаться),
      // иначе по tgUserId
      let user = null;
      if (options.syncBy === 'email' && data.email) {
        user = await this.findUserByEmailCI(data.email);
        // Фолбэк: если по email не нашли (например, у Создателя в Excel новый
        // email, а в БД старый) — пробуем по tg_user_id
        if (!user && data.tgUserId) {
          user = await User.findByTgId(data.tgUserId);
        }
      } else if (data.tgUserId) {
        // Ищем по tg_user_id (если email не найден или syncBy = 'tg')
        user = await User.findByTgId(data.tgUserId);
        // Если не нашли по tg, но есть email – пробуем по email (запасной вариант)
        if (!user && data.email) {
          user = await this.findUserByEmailCI(data.email);
        }
      } else {
        // Нет ни email, ни tg – пропускаем
        skipped++;
        continue;
      }

      // Расширенный поиск для Создателя: роль выдаётся по GOD_EMAIL/GOD_ID
      // из .env, поэтому ищем дополнительно без учёта регистра email —
      // даже если в Excel email новый, а в БД записан в другом регистре
      if (!user && this.isGodIdentity(data)) {
        const godEnv = readGodEnv();
        const godEmail = godEnv.email || config.godEmail;
        const godId = godEnv.id || config.godId;
        if (godEmail || godId) {
          user = await db.get(
            `SELECT * FROM users
             WHERE (LOWER(TRIM(email)) = LOWER(TRIM(?)) AND ? <> '')
                OR (TRIM(COALESCE(tg_user_id, '')) = ? AND ? <> '')
             LIMIT 1`,
            godEmail || '\u0000', godEmail || '',
            godId || '\u0000', godId || ''
          );
          if (user) {
            console.log(`[SyncService] Создатель найден по идентификаторам из .env: #${user.id} (${user.email || 'без email'})`);
          }
        }
      }

      if (user) {
        // Обновляем существующего
        const updateFields = {
          name: data.name,
          // Телефон: в Excel пусто — оставляем прежний; некорректный — очищаем;
          // корректный — канонический красивый формат +7 (999) 123-45-67
          phone: data.phoneRaw === '' ? (user.phone || '') : (data.phonePretty || ''),
          // Число принтеров и коэффициент: некорректные/пустые значения уже
          // заменены на дефолты при парсинге (1 и 1.0)
          capacity: data.capacity,
          earnings_factor: data.earningsFactor,
        };
        // Telegram ID: корректный и изменившийся — обновляем; указан в Excel,
        // но не распознан (не последовательность цифр) — очищаем (дефолт '')
        if (data.tgUserId && user.tg_user_id !== data.tgUserId) {
          updateFields.tg_user_id = data.tgUserId;
        } else if (!data.tgUserId && data.tgRaw) {
          updateFields.tg_user_id = '';
        }
        // Пользователь есть в актуальном team-info.xlsx → он работает:
        // восстанавливаем (is_fired = 0), включаем приём заказов.
        // Исключение — гость (email ещё не подтверждён): он остаётся
        // невидимым (is_fired = 1, приём заказов выключен), пока не введёт
        // код из письма (AuthService.verifyEmail).
        if (user.role === 'guest') {
          console.log(
            `[SyncService] Пользователь #${user.id} есть в team-info.xlsx, но email не подтверждён — активность не включаем`
          );
        } else {
          updateFields.is_fired = 0;
          updateFields.taking_orders = 1;
        }
        // Роль 'god' (Создатель) выдаётся ТОЛЬКО по идентификаторам из .env
        if (this.isGodIdentity(data)) {
          updateFields.role = 'god';
        } else if (user.role === 'user') {
          // Повышение user → employee — ТОЛЬКО по инициативе персонала:
          // email добавлен в team-info.xlsx вручную и файл загружен вручную
          // (allowPromotion = true). Серверный файл (allowPromotion = false)
          // роли не повышает: он сгенерирован экспортом из БД, и обычный
          // подтверждённый 'user' не должен становиться сотрудником только
          // потому, что его email оказался в файле. admin/moderator не
          // трогаем — их роли назначаются вручную.
          if (options.allowPromotion === false) {
            console.log(
              `[SyncService] Пользователь #${user.id} (${data.name}) есть в файле, но роль не меняется: серверный team-info.xlsx не повышает user → employee`
            );
          } else {
            updateFields.role = 'employee';
          }
        }
        if (user.is_fired && user.role !== 'guest') {
          console.log(`[SyncService] Пользователь #${user.id} (${user.name || data.name}) восстановлен — присутствует в актуальном team-info.xlsx`);
        }
        await User.update(user.id, updateFields);

        // Создатель — в единственном числе: если роль 'god' выдана по .env,
        // снимаем её со всех остальных (понижаем до 'admin', права сохраняются)
        if (updateFields.role === 'god') {
          const otherGods = await db.all(
            "SELECT id FROM users WHERE role = 'god' AND id != ?",
            user.id
          );
          for (const g of otherGods) {
            await User.update(g.id, { role: 'admin' });
            console.log(`[SyncService] Роль 'god' снята с пользователя #${g.id} (понижен до 'admin') — Создатель один: #${user.id}`);
          }
        }

        // Обновляем склады
        await Warehouse.clearUserWarehouses(user.id);
        for (const whId of data.warehouses) {
          await Warehouse.addUserWarehouse(user.id, whId);
        }
        updated++;
      } else if (options.createMissing) {
        // Создаём нового пользователя с минимальными данными (без пароля)
        // Для веб-версии мы не создаём пользователей автоматически, т.к. они должны регистрироваться сами.
        // Но если опция включена – создаём с ролью 'user' и без пароля (требуется сброс пароля).
        // Лучше пропустить, поэтому создание отключим по умолчанию.
        // Однако для полноты реализуем:
        const randomPassword = Math.random().toString(36).slice(-8);
        const passwordHash = await bcrypt.hash(randomPassword, 10);
        const newUser = await User.create({
          username: data.email || data.tgUserId || `user_${Date.now()}`,
          email: data.email || `user_${Date.now()}@temp.local`,
          passwordHash,
          name: data.name,
          // Телефон храним в едином красивом формате; некорректный — ''
          phone: data.phonePretty || '',
          capacity: data.capacity,
          earningsFactor: data.earningsFactor,
          // Создатель создаётся сразу с ролью 'god', остальные — 'employee'
          role: this.isGodIdentity(data) ? 'god' : 'employee',
          tgUserId: data.tgUserId || null,
        });
        // Обновляем склады
        for (const whId of data.warehouses) {
          await Warehouse.addUserWarehouse(newUser.id, whId);
        }
        // Единственность Создателя: если создан новый 'god', снимаем роль
        // со всех остальных (понижаем до 'admin')
        if (newUser.role === 'god') {
          const otherGods = await db.all(
            "SELECT id FROM users WHERE role = 'god' AND id != ?",
            newUser.id
          );
          for (const g of otherGods) {
            await User.update(g.id, { role: 'admin' });
            console.log(`[SyncService] Роль 'god' снята с пользователя #${g.id} (понижен до 'admin') — Создатель один: #${newUser.id}`);
          }
        }
        created++;
      } else {
        skipped++;
        // Понятная диагностика, если строка Создателя не нашлась в БД
        if (this.isGodIdentity(data)) {
          console.warn(
            '[SyncService] В Excel есть строка Создателя (GOD_EMAIL/GOD_ID), но пользователь в БД не найден ' +
            'и createMissing выключен — роль не выдана. Создайте аккаунт с этим email через ' +
            '«Создать аккаунт» на странице «Пользователи» и повторите синхронизацию.'
          );
        }
      }
    }

    // --- Оповещение персонала о проблемных данных в Excel ---
    if (problemRows.length) {
      const admin = adminUserId ? await User.getById(adminUserId) : null;
      const adminName = (admin && admin.name) || 'Система';
      const flat = problemRows.flatMap((p) =>
        p.problems.map((pr) => ({ name: p.name, field: pr.field, raw: pr.raw, note: pr.note }))
      );
      console.warn(`[SyncService] В Excel найдено проблемных значений: ${flat.length}`);
      for (const pr of flat) {
        console.warn(`[SyncService]   • ${pr.name || '(без имени)'}: ${pr.field} «${pr.raw}» — ${pr.note}`);
      }
      // Без Web Push: отчёт для архива — синхронизацию запускает сам персонал
      // из админки, он и так смотрит на экран.
      await NotificationService.notifyStaff(
        'sync_data_invalid',
        {
          fileName: path.basename(filePath),
          adminName,
          problems: flat,
          userName: flat.map((pr) => pr.name).filter(Boolean).slice(0, 3).join(', ') || null,
        },
        { push: false }
      );
    }

    // --- Увольнение сотрудников, отсутствующих в актуальном team-info.xlsx ---
    // Считаем сотрудниками (и кандидатами на увольнение) активных пользователей
    // с ролью 'employee'; admin/moderator/god не трогаем — их членство в
    // Excel не обязательно. Увольнение — по образцу fireUser (кнопка «🗑️»
    // на странице «Пользователи»): is_fired=1, приём заказов выключается,
    // роль понижается employee → user, активные назначения снимаются.
    const excelEmails = new Set(usersData.map(d => d.email).filter(Boolean));
    const excelTgIds = new Set(usersData.map(d => d.tgUserId).filter(Boolean));
    const activeEmployees = await db.all(
      "SELECT id, username, name, email, tg_user_id FROM users WHERE is_fired = 0 AND role = 'employee'"
    );
    let fired = 0;
    for (const emp of activeEmployees) {
      const inExcel =
        (emp.email && excelEmails.has(String(emp.email).trim().toLowerCase())) ||
        (emp.tg_user_id && excelTgIds.has(String(emp.tg_user_id).trim()));
      if (inExcel) continue;

      console.log(`[SyncService] Сотрудник #${emp.id} (${emp.name || emp.username}) отсутствует в team-info.xlsx — помечается уволенным`);
      // is_fired=1, приём заказов выключается, роль понижается employee → user
      await User.update(emp.id, { is_fired: 1, taking_orders: 0, role: 'user' });
      // Снять все активные назначения (как fireUser в adminController)
      await db.run('DELETE FROM assignments WHERE user_id = ? AND status = "assigned"', emp.id);
      fired++;
    }

    console.log(`[SyncService] Синхронизация завершена: обновлено ${updated}, создано ${created}, пропущено ${skipped}, уволено ${fired}`);

    // Роли/состав/is_fired изменились — сразу перегенерируем серверный Excel,
    // иначе при следующей синхронизации изменения могли бы «откатиться»
    await this.refreshServerExports();

    return { updated, created, skipped, fired };
  }

  /**
    * Экспортирует пользователей и их склады в Excel (обратная синхронизация)
    * @param {number} adminUserId - ID администратора (для лога)
    * @param {boolean} includeFired - включать уволенных
    * @param {string} outputFileName - имя файла
    * @returns {Promise<string>} - путь к созданному файлу
    */
  static async exportTeamInfoXlsx(adminUserId, includeFired = false, outputFileName = 'team-info.xlsx', { syncWarehouses = true } = {}) {
    const db = getDB();

    // 1. Синхронизируем склады перед экспортом (по умолчанию; отключается при фоновой перегенерации)
    if (syncWarehouses) {
      try {
        const warehousesFromOzon = await OzonService.fetchWarehouses();
        if (warehousesFromOzon.length) {
          await Warehouse.syncAll(warehousesFromOzon);
          console.log('[SyncService] Склады синхронизированы перед экспортом');
        }
      } catch (err) {
        console.warn('[SyncService] Не удалось синхронизировать склады перед экспортом:', err.message);
      }
    }

    // 2. Получаем пользователей. В Excel попадают только сотрудники и
    //    staff-роли (admin/moderator/god). Обычные пользователи (role = 'user'
    //    — подтвердили email, но ещё НЕ сотрудники) в файл НЕ включаются:
    //    иначе следующая синхронизация находила бы их по email в этом же
    //    файле и автоматически повышала до 'employee' без ведома персонала.
    //    Гостей User.getAll исключает всегда. Исключение из фильтра —
    //    employees-db.xlsx (includeFired = true): уволенный сотрудник должен
    //    остаться в файле, даже если при увольнении его роль была понижена
    //    до 'user' (так делают fireUser и синхронизация).
    const allUsers = await User.getAll({ includeFired, includeAll: true });
    const users = allUsers.filter(
      (u) => u.role !== 'user' || (includeFired && u.is_fired)
    );
    const warehouses = await Warehouse.getAll();

    // 3. Получаем связи пользователь-склад
    const userWarehouses = await db.all('SELECT user_id, warehouse_id FROM user_warehouses');
    const map = new Map();
    for (const uw of userWarehouses) {
      if (!map.has(uw.user_id)) map.set(uw.user_id, new Set());
      map.get(uw.user_id).add(uw.warehouse_id);
    }

    // 4. Создаём Excel
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Сотрудники');

    // Заголовки: Сотрудник, E-mail, Telegram ID, Телефон, Принтеров, Коэф., разделитель, склады
    const header1 = ['Сотрудник', 'E-mail', 'Telegram ID', 'Телефон', 'Число принтеров', 'Коэффициент Заработка', ''];
    const header2 = ['', '', '', '', '', '', ''];
    for (const wh of warehouses) {
      header1.push('');
      header2.push(`${wh.name} (ID: ${wh.warehouse_id})`);
    }

    const row1 = worksheet.addRow(header1);
    const row2 = worksheet.addRow(header2);

    // Слияние для "Склады"
    if (warehouses.length) {
      const startCol = 8;
      const endCol = 7 + warehouses.length;
      const startLetter = String.fromCharCode(64 + startCol);
      const endLetter = String.fromCharCode(64 + endCol);
      worksheet.mergeCells(`${startLetter}1:${endLetter}1`);
      row1.getCell(startCol).value = 'Склады';
    }

    // Стили
    [row1, row2].forEach(row => {
      row.eachCell(cell => {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = { bold: true };
      });
    });

    // Ширина
    const widths = [45, 45, 30, 30, 30, 30, 15];
    for (let i = 0; i < widths.length; i++) {
      worksheet.getColumn(i + 1).width = widths[i];
    }
    for (let i = 0; i < warehouses.length; i++) {
      worksheet.getColumn(8 + i).width = 75;
    }

    // Данные
    for (const user of users) {
      const whSet = map.get(user.id) || new Set();
      const rowData = [
        user.name,
        user.email || '',
        user.tg_user_id || '',
        // Телефон ВСЕГДА в красивом виде +7 (999) 123-45-67 (какой бы формат
        // ни хранился в БД); нераспознаваемое значение выводим как есть
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
        if (colNum === 3 || colNum === 4) cell.numFmt = '@'; // TG и телефон текстом
        if (colNum === 6) cell.numFmt = '0.00';
      });
    }

    // Имя файла версонируется, если задан BOT_VERSION:
    // team-info-1.xlsx | team-info.xlsx; employees-db-1.xlsx | employees-db.xlsx
    const baseName = outputFileName.replace(/\.xlsx$/i, '');
    const finalFileName = getVersionedFileName(baseName, 'xlsx');
    const outputPath = path.join(__dirname, '../../', finalFileName);
    await workbook.xlsx.writeFile(outputPath);
    console.log(`[SyncService] Экспорт в ${finalFileName} выполнен`);
    return outputPath;
  }
}

module.exports = SyncService;