const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
// uuid не нужен: токены генерируются встроенным crypto (randomBytes / randomInt)
const config = require('../config');
const User = require('../models/User');
const { getDB } = require('../config/database');
const crypto = require('crypto');
const EmailVerification = require('../models/EmailVerification');
const PasswordReset = require('../models/PasswordReset');

const EmailService = require('./EmailService');
const NotificationService = require('./NotificationService');
const {
  parsePhone,
  formatPhonePretty,
  parseEmail,
  parseEarningsFactor,
} = require('../utils');

// ============================================================================
// Ссылки на users(id) — очистка «хвостов» при удалении аккаунта.
// ============================================================================

/**
 * Таблицы, строки которых при удалении пользователя СОХРАНЯЮТСЯ: ссылка
 * просто обнуляется. product_stats — статистика товара (материал/цвет/вес),
 * она нужна и без автора записи (колонка user_id у неё nullable).
 * Все остальные таблицы, ссылающиеся на users(id), чистятся удалением строк.
 */
const KEEP_ROWS_ON_USER_DELETE = new Set(['product_stats']);

/** Имя таблицы/колонки SQLite в двойных кавычках (значения приходят из sqlite_master). */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Все пары { table, column } текущей БД, ссылающиеся на users(id).
 * Источник — сама схема (sqlite_master + PRAGMA foreign_key_list), поэтому
 * список не может «отстать» от неё, в отличие от ручного перечня таблиц:
 * когда-то в нём забыли earnings_active, и DELETE FROM users падал с
 * SQLITE_CONSTRAINT: FOREIGN KEY constraint failed (у «легаси»-гостя
 * с заказами и заработком там оставались строки).
 *
 * @param {object} db - открытая БД (sqlite)
 * @returns {Promise<Array<{table: string, column: string}>>}
 */
async function findUserReferences(db) {
  const tables = await db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  );
  const refs = [];
  for (const { name } of tables) {
    const fks = await db.all(`PRAGMA foreign_key_list(${quoteIdent(name)})`);
    for (const fk of fks) {
      if (fk.table === 'users') refs.push({ table: name, column: fk.from });
    }
  }
  return refs;
}

/**
 * Диагностика: какие из найденных ссылок реально содержат строки этого
 * пользователя. SQLite в ошибке FK не называет виновника — показываем сами,
 * чтобы сбой в журнале ошибок был сразу понятен. Никогда не бросает.
 *
 * @returns {Promise<string[]>} например ['earnings_active.user_id (44)']
 */
async function describeUserReferences(db, refs, userId) {
  const found = [];
  for (const ref of refs) {
    try {
      const row = await db.get(
        `SELECT COUNT(*) AS c FROM ${quoteIdent(ref.table)} WHERE ${quoteIdent(ref.column)} = ?`,
        userId
      );
      if (row && row.c) found.push(`${ref.table}.${ref.column} (${row.c})`);
    } catch (e) { /* таблицы могло уже не стать — не критично */ }
  }
  return found;
}

class AuthService {
  /**
   * Минимальная валидация данных регистрации.
   * Возвращает массив текстов ошибок (пустой массив — всё валидно).
   */
  static validateRegisterData(data) {
    const errors = [];
    const { username, email, password, capacity, phone, earningsFactor } = data;

    // Логин: минимум 6 символов (уникальность проверяет User.create)
    if (!username || typeof username !== 'string' || username.trim().length < 6) {
      errors.push('Логин должен содержать минимум 6 символов');
    }
    // Email: только латиница/цифры/._%+- (кириллица и пробелы ломают
    // синхронизацию сотрудника по email — матчинг никогда не совпадёт)
    if (!email || typeof email !== 'string' || !parseEmail(email)) {
      errors.push('Некорректный email (допустимы только латиница, цифры и символы ._%+-)');
    }
    // Пароль: минимум 6 символов
    if (!password || typeof password !== 'string' || password.length < 6) {
      errors.push('Пароль должен содержать минимум 6 символов');
    }
    // Количество принтеров: целое число от 1 до 99 (пустое = значение по умолчанию 1)
    if (capacity !== undefined && capacity !== null && capacity !== '') {
      const n = Number(capacity);
      if (!Number.isInteger(n) || n < 1 || n > 99) {
        errors.push(
          'Количество принтеров должно быть целым числом от 1 до 99 (или оставьте поле пустым — тогда будет 1)'
        );
      }
    }
    // Телефон (опционален): если указан — должен распознаваться
    // ('+7 (999) 999-99-99', '79991234567', '89991234567', '9991234567')
    if (phone !== undefined && phone !== null && String(phone).trim() !== '' && !parsePhone(phone)) {
      errors.push('Некорректный телефон: укажите номер в формате +7 (999) 999-99-99 (11 цифр)');
    }
    // Коэффициент заработка (опционален): положительное число, максимум
    // 2 знака после запятой, оба формата — '99.99' и '99,99'
    if (earningsFactor !== undefined && earningsFactor !== null && earningsFactor !== '') {
      if (parseEarningsFactor(earningsFactor) === null) {
        errors.push(
          'Коэффициент заработка: положительное число с максимум 2 знаками после запятой (например, 1.5 или 99,99)'
        );
      }
    }
    return errors;
  }

  /**
   * Валидация данных при создании аккаунта администратором.
   * Мягче обычной регистрации:
   *   • логин и пароль — минимум 1 символ;
   *   • количество принтеров — любое положительное целое, без верхней границы;
   *   • из проверок email — только формат *@*.*.
   * Уникальность username/email обеспечивает User.create (already taken).
   * Возвращает массив текстов ошибок (пустой массив — всё валидно).
   */
  static validateAdminRegisterData(data) {
    const errors = [];
    const { username, email, password, capacity, role, phone, earningsFactor } = data;

    if (!username || typeof username !== 'string' || username.trim().length < 1) {
      errors.push('Укажите логин (минимум 1 символ)');
    }
    // Email: только латиница/цифры/._%+- (кириллица и пробелы ломают
    // синхронизацию сотрудника по email)
    if (!email || typeof email !== 'string' || !parseEmail(email)) {
      errors.push('Некорректный email (допустимы только латиница, цифры и символы ._%+-)');
    }
    if (!password || typeof password !== 'string' || password.length < 1) {
      errors.push('Укажите пароль (минимум 1 символ)');
    }
    // Количество принтеров: любое положительное целое, без верхней границы
    // (пустое = значение по умолчанию 1)
    if (capacity !== undefined && capacity !== null && capacity !== '') {
      const n = Number(capacity);
      if (!Number.isInteger(n) || n < 1) {
        errors.push(
          'Количество принтеров должно быть положительным целым числом (пусто — тогда будет 1)'
        );
      }
    }
    // Телефон (опционален): если указан — должен распознаваться
    // ('+7 (999) 999-99-99', '79991234567', '89991234567', '9991234567')
    if (phone !== undefined && phone !== null && String(phone).trim() !== '' && !parsePhone(phone)) {
      errors.push('Некорректный телефон: укажите номер в формате +7 (999) 999-99-99 (11 цифр)');
    }
    // Коэффициент заработка (опционален): положительное число, максимум
    // 2 знака после запятой, оба формата — '99.99' и '99,99'
    if (earningsFactor !== undefined && earningsFactor !== null && earningsFactor !== '') {
      if (parseEarningsFactor(earningsFactor) === null) {
        errors.push(
          'Коэффициент заработка: положительное число с максимум 2 знаками после запятой (например, 1.5 или 99,99)'
        );
      }
    }
    // Роль — только из белого списка. 'god' (Создатель) вручную не выдаётся:
    // он назначается только синхронизацией из Excel по GOD_EMAIL/GOD_ID.
    if (role !== undefined && role !== null && role !== '') {
      if (!['user', 'employee', 'moderator', 'admin'].includes(role)) {
        errors.push('Недопустимая роль');
      }
    }
    return errors;
  }

  /**
   * Регистрация аккаунта администратором — в обход подтверждения email:
   * аккаунт создаётся сразу подтверждённым (email_verified = 1) и активным
   * с выбранной ролью (по умолчанию 'employee'). Код не генерируется,
   * письмо не отправляется.
   */
  static async adminRegister(data) {
    const { username, email, password, name, phone, capacity, earningsFactor, role } = data;
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const created = await User.create({
      username: String(username).trim(),
      email: String(email).trim(),
      passwordHash,
      // Имя для Персонала: если не указано — используем логин
      name: name && String(name).trim() ? String(name).trim() : String(username).trim(),
      // Отображаемое имя для самого пользователя: по умолчанию логин,
      // он сам сможет поменять его в Профиле
      displayName: String(username).trim(),
      // Телефон храним в едином красивом формате +7 (999) 123-45-67;
      // пусто/невалидно → ''
      phone: formatPhonePretty(phone) || '',
      // Положительность capacity проверена в validateAdminRegisterData;
      // пустое -> дефолт 1
      capacity:
        capacity === undefined || capacity === null || capacity === ''
          ? 1
          : Number(capacity),
      // Коэффициент: положительное число, максимум 2 знака ('99,99' и '99.99');
      // пустое/невалидное → 1.0
      earningsFactor: parseEarningsFactor(earningsFactor) ?? 1.0,
      // 'god' не входит в белый список — роль по умолчанию 'employee'
      role: role && ['user', 'employee', 'moderator', 'admin'].includes(role)
        ? role
        : 'employee',
    });
    // Сразу подтверждаем email, чтобы аккаунт был готов к входу без кода
    await User.update(created.id, { email_verified: 1 });
    return User.getById(created.id);
  }

  static async register(data) {
    // Логин/email нормализуем trim'ом ДО проверки занятости и создания:
    // replacePendingGuests ищет по trim-значениям, а resendCode и повторная
    // регистрация ищут аккаунт по email из формы — в БД должны храниться
    // те же значения, по которым ищем (иначе « a@b.ru » из формы не найдётся)
    const username = String(data.username || '').trim();
    const email = String(data.email || '').trim();
    const { password, name, phone, capacity, earningsFactor } = data;
    // Логин/email могли «зависнуть» на неподтверждённой регистрации
    // (роль 'guest'). Это тот же человек — повторную регистрацию разрешаем:
    // гостевые записи удаляются, код генерируется и отправляется заново.
    // Подтверждённые аккаунты по-прежнему заняты (409 в контроллере).
    const resent = await this.replacePendingGuests({ username, email });
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const user = await User.create({
      username,
      email,
      passwordHash,
      // Регистрация самим пользователем: указанное имя — это его отображаемое
      // имя (display_name), которое он видит в Профиле и может менять сам.
      // name (имя для Персонала) пока ставим из логина — позже его поправит Персонал.
      name: String(username).trim(),
      displayName: name && String(name).trim() ? String(name).trim() : String(username).trim(),
      phone: formatPhonePretty(phone) || '',
      capacity: capacity || 1,
      // Коэффициент: положительное число, максимум 2 знака ('99,99' и '99.99');
      // пустое/невалидное → 1.0
      earningsFactor: parseEarningsFactor(earningsFactor) ?? 1.0,
      // До подтверждения email пользователь — 'guest' и НЕ состоит в команде:
      // is_fired = 1, приём заказов выключен. Роль 'user' и активность
      // возвращаются только после ввода кода из письма (см. verifyEmail).
      role: 'guest',
      isFired: 1,
      takingOrders: 0,
    });

    // Генерируем код
    const code = this.generateVerificationCode();
    await EmailVerification.create(user.id, code);

    // Отправляем письмо: ЖДЁМ результат, чтобы не отвечать 201,
    // когда письмо реально не ушло (иначе пользователь застрянет без кода).
    try {
      await EmailService.sendVerificationEmail(user.email, user.name, code);
    } catch (err) {
      // Откатываем регистрацию: удаляем коды и пользователя, чтобы
      // username/email освободились и регистрацию можно было повторить.
      console.error('[Auth] Ошибка отправки письма при регистрации:', err.message);
      await EmailVerification.deleteByUserId(user.id);
      await User.deleteById(user.id);
      throw new Error(`Не удалось отправить письмо с кодом подтверждения: ${err.message}`);
    }

    // role 'guest' — ждём подтверждения email; resent — была ли заменена
    // предыдущая неподтверждённая регистрация (контроллер покажет текст
    // «код отправлен повторно»)
    return { user, resent };
  }

  /**
   * Освобождает логин/email от «зависших» неподтверждённых регистраций.
   * Вызывается из register(): подтверждённые аккаунты (сотрудник, админ,
   * создатель, обычный user) освобождать нельзя — для них ошибка
   * 'username already taken' / 'email already taken' (контроллер → 409),
   * как и раньше. Записи с ролью 'guest' удаляются вместе с кодами
   * подтверждения, refresh-токенами и связями со складами (у гостя
   * заказов/статистики быть не может).
   *
   * @returns {Promise<boolean>} true, если гостевые записи были заменены
   */
  static async replacePendingGuests({ username, email }) {
    const byUsername = username ? await User.getByUsername(String(username).trim()) : null;
    const byEmail = email ? await User.getByEmail(String(email).trim()) : null;

    if (byUsername && byUsername.role !== 'guest') {
      throw new Error('username already taken');
    }
    if (byEmail && byEmail.role !== 'guest') {
      throw new Error('email already taken');
    }

    // Логин и email могут указывать на две разные неподтверждённые записи —
    // дедуплицируем по id и освобождаем обе
    const unique = [
      ...new Map([byUsername, byEmail].filter(Boolean).map((u) => [u.id, u])).values(),
    ];
    if (unique.length === 0) return false;

    const db = getDB();
    for (const guest of unique) {
      console.log(
        `[Auth] Повторная регистрация: заменяем неподтверждённый аккаунт #${guest.id} (${guest.username} / ${guest.email})`
      );
      // Полная очистка ссылающихся таблиц — иначе DELETE FROM users может
      // упасть с SQLITE_CONSTRAINT: FOREIGN KEY constraint failed.
      try {
        await db.run('BEGIN IMMEDIATE');
        await EmailVerification.deleteByUserId(guest.id);
        await db.run('DELETE FROM refresh_tokens WHERE user_id = ?', guest.id);
        await db.run('DELETE FROM user_warehouses WHERE user_id = ?', guest.id);
        await db.run('DELETE FROM assignments WHERE user_id = ?', guest.id);
        await db.run('DELETE FROM user_stats WHERE user_id = ?', guest.id);
        await db.run('DELETE FROM earnings_history WHERE user_id = ?', guest.id);
        await db.run('DELETE FROM earnings_adjustments WHERE user_id = ?', guest.id);
        await db.run('DELETE FROM earnings_adjustments_active WHERE user_id = ?', guest.id);
        await db.run('DELETE FROM issued_models WHERE user_id = ?', guest.id);
        await db.run('DELETE FROM model_download_tokens WHERE user_id = ?', guest.id);
        await db.run('DELETE FROM offer_models WHERE uploaded_by = ?', guest.id);
        await db.run('UPDATE product_stats SET user_id = NULL WHERE user_id = ?', guest.id);
        await db.run('DELETE FROM users WHERE id = ?', guest.id);
        await db.run('COMMIT');
      } catch (err) {
        try { await db.run('ROLLBACK'); } catch (e) { /* не был в транзакции */ }
        console.error(`[Auth] Не удалось заменить неподтверждённый аккаунт #${guest.id}:`, err.message);
        throw err;
      }
    }
    return true;
  }

  static async verifyEmail(code) {
    const record = await EmailVerification.findByCode(code);
    if (!record) throw new Error('Неверный или просроченный код');

    const user = await User.getById(record.user_id);
    if (!user) throw new Error('Неверный или просроченный код');

    // Подтверждаем email и выдаём роль 'user'. Роль меняем только у 'guest',
    // чтобы не понизить роль уже существующего сотрудника/админа.
    const updates = { email_verified: 1 };
    if (user.role === 'guest') {
      updates.role = 'user';
      // Гость не состоял в команде (is_fired = 1, приём заказов выключен) —
      // после подтверждения возвращаем обычное состояние аккаунта
      updates.is_fired = 0;
      updates.taking_orders = 1;
    }
    const updated = await User.update(user.id, updates);

    // Коды одноразовые: чистим все коды этого пользователя
    await EmailVerification.deleteByUserId(user.id);

    return updated;
  }

  /**
   * Повторная отправка кода подтверждения (например, письмо не пришло).
   * Для несуществующего или уже подтверждённого аккаунта — тихий no-op,
   * чтобы не раскрывать факт регистрации по email.
   */
  static async resendCode(email) {
    // Кулдаун повторной отправки (RESEND_CODE_COOLDOWN_SEC, по умолчанию 60 с)
    const cooldownSec = config.resendCodeCooldownSec;
    const user = await User.getByEmail(email);
    // Несуществующий или уже подтверждённый аккаунт — тихий no-op,
    // чтобы не раскрывать факт регистрации по email
    if (!user || user.role !== 'guest') {
      return { sent: false, retryAfterSec: cooldownSec };
    }

    // Антифлуд: письмо уходит не чаще, чем раз в cooldownSec секунд
    const last = await EmailVerification.getLatestByUserId(user.id);
    if (last && last.created_at && cooldownSec > 0) {
      const elapsedMs = Date.now() - last.created_at;
      if (elapsedMs < cooldownSec * 1000) {
        return {
          sent: false,
          retryAfterSec: Math.ceil((cooldownSec * 1000 - elapsedMs) / 1000),
        };
      }
    }

    const code = this.generateVerificationCode();
    // Старые коды становятся недействительными
    await EmailVerification.deleteByUserId(user.id);
    await EmailVerification.create(user.id, code);
    await EmailService.sendVerificationEmail(user.email, user.name, code);
    return { sent: true, retryAfterSec: cooldownSec };
  }

  /**
   * Запрос на сброс пароля.
   * Принимает email, отправляет письмо с 6-значным кодом подтверждения.
   * Для предотвращения перечисления пользователей (enumeration attacks),
   * если email не найден или аккаунт гостевой (неподтверждённый) —
   * возвращает успешный ответ с кулдауном без фактической отправки.
   */
  static async requestPasswordReset(email) {
    const cooldownSec = config.resendCodeCooldownSec;
    const cleanEmail = email ? String(email).trim() : '';
    if (!cleanEmail) {
      throw new Error('Email обязателен');
    }

    const user = await User.getByEmail(cleanEmail);
    // Гости (email не подтверждён) и несуществующие пользователи не сбрасывают пароль
    if (!user || user.role === 'guest') {
      return { sent: true, retryAfterSec: cooldownSec };
    }

    // Антифлуд: проверяем время последней отправки кода сброса пароля
    const last = await PasswordReset.getLatestByUserId(user.id);
    if (last && last.created_at && cooldownSec > 0) {
      const elapsedMs = Date.now() - last.created_at;
      if (elapsedMs < cooldownSec * 1000) {
        return {
          sent: false,
          retryAfterSec: Math.ceil((cooldownSec * 1000 - elapsedMs) / 1000),
        };
      }
    }

    const code = this.generateVerificationCode();
    await PasswordReset.deleteByUserId(user.id);
    await PasswordReset.create(user.id, code);

    try {
      await EmailService.sendPasswordResetEmail(user.email, user.name || user.username, code);
    } catch (err) {
      console.error('[Auth] Ошибка отправки письма сброса пароля:', err.message);
      await PasswordReset.deleteByUserId(user.id);
      throw new Error(`Не удалось отправить письмо со сбросом пароля: ${err.message}`);
    }

    return { sent: true, retryAfterSec: cooldownSec };
  }

  /**
   * Завершение сброса пароля по коду.
   * Устанавливает новый пароль, хэширует bcrypt, удаляет использованный код
   * и отзывает текущие refresh-токены пользователя.
   */
  static async resetPassword(code, newPassword) {
    if (!code || typeof code !== 'string') {
      throw new Error('Код обязателен');
    }
    const cleanCode = code.trim();
    if (!cleanCode) {
      throw new Error('Код обязателен');
    }

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
      throw new Error('Пароль должен содержать минимум 6 символов');
    }

    const record = await PasswordReset.findByCode(cleanCode);
    if (!record) {
      throw new Error('Неверный или просроченный код сброса пароля');
    }

    const user = await User.getById(record.user_id);
    if (!user) {
      throw new Error('Пользователь не найден');
    }

    // Хэшируем новый пароль (без проверки на совпадение с предыдущим)
    const newHash = await bcrypt.hash(newPassword, 10);
    await User.setPasswordHash(user.id, newHash);

    // Удаляем все коды сброса пароля этого пользователя
    await PasswordReset.deleteByUserId(user.id);

    // Инвалидируем существующие refresh-токены для безопасности
    const db = getDB();
    await db.run('DELETE FROM refresh_tokens WHERE user_id = ?', user.id);

    // Оповещение персонала в журнал действий
    NotificationService.notifyStaff('password_reset_success', {
      userId: user.id,
      userName: user.name || user.username,
      email: user.email,
    });

    return {
      success: true,
      message: 'Пароль успешно изменён. Теперь вы можете войти с новым паролем.',
    };
  }


  /**
   * Удаляет «зависшие» неподтверждённые аккаунты (роль 'guest') старше
   * ttlHours вместе со всеми ссылающимися на них данными (коды подтверждения,
   * refresh-токены, назначения, заработок, выданные модели, связи со складами
   * и т.п.). Вызывается планировщиком (startGuestCleanupChecker,
   * TTL — GUEST_TTL_HOURS, по умолчанию 24 ч).
   * Заодно вычищает все просроченные коды подтверждения — в том числе
   * «легаси»-строки аккаунтов, которые так и не подтвердили email.
   *
   * Список «хвостов» берётся из схемы БД (PRAGMA foreign_key_list), поэтому
   * очистка автоматически покрывает и таблицы, добавленные позже — ручной
   * перечень когда-то забыл earnings_active, и удаление падало с
   * SQLITE_CONSTRAINT: FOREIGN KEY constraint failed.
   *
   * @param {number} ttlHours
   * @returns {Promise<{deletedUsers: number, deletedCodes: number}>}
   */
  static async cleanupGuestAccounts(ttlHours = config.guestTtlHours) {
    const db = getDB();
    const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
    const guests = await User.findGuestsOlderThan(cutoff);

    // Все ссылки на users(id) в текущей схеме (один раз на прогон).
    const refs = await findUserReferences(db);
    const deletedUsers = [];

    for (const guest of guests) {
      try {
        await db.run('BEGIN IMMEDIATE');
        // Проверку FK переносим на момент COMMIT: порядок удалений не важен,
        // а для «легаси»-схем (где FK мог проверяться сразу) это безопаснее.
        await db.run('PRAGMA defer_foreign_keys = ON');
        for (const ref of refs) {
          const table = quoteIdent(ref.table);
          const column = quoteIdent(ref.column);
          if (KEEP_ROWS_ON_USER_DELETE.has(ref.table)) {
            // Строку сохраняем, ссылку на удаляемого пользователя обнуляем
            // (product_stats — статистика товара, нужна и без автора)
            await db.run(`UPDATE ${table} SET ${column} = NULL WHERE ${column} = ?`, guest.id);
          } else {
            await db.run(`DELETE FROM ${table} WHERE ${column} = ?`, guest.id);
          }
        }
        await db.run('DELETE FROM users WHERE id = ?', guest.id);
        await db.run('COMMIT');
        deletedUsers.push(guest.id);
        console.log(
          `[Auth] Неподтверждённый аккаунт #${guest.id} (${guest.username} / ${guest.email}) удалён: email не подтверждён более ${ttlHours} ч`
        );
      } catch (err) {
        // Один проблемный гость не должен валиль всю очистку — откатываем
        // его транзакцию и переходим к следующему, сбой журналируется.
        try { await db.run('ROLLBACK'); } catch (e) { /* не был в транзакции */ }
        // Диагностика: SQLite в ошибке FK не называет виновника — после
        // ROLLBACK считаем, какие таблицы всё ещё держат ссылку на аккаунт.
        const blockedBy = await describeUserReferences(db, refs, guest.id);
        console.error(
          `[Auth] Не удалось удалить неподтверждённый аккаунт #${guest.id}:`,
          err.message,
          blockedBy.length ? `| держат ссылки: ${blockedBy.join(', ')}` : ''
        );
        NotificationService.logServerError('auth.cleanupGuestAccounts', err, {
          guestId: guest.id,
          username: guest.username,
          blockedBy: blockedBy.length ? blockedBy.join(', ') : null,
        });
      }
    }

    const deletedCodes = await EmailVerification.deleteExpired();
    await PasswordReset.deleteExpired();

    return { deletedUsers: deletedUsers.length, deletedCodes };
  }

  static generateVerificationCode() {
    // 6-значный цифровой код
    return crypto.randomInt(100000, 999999).toString();
  }

  static async login(usernameOrEmail, password) {
    // Ищем по username или email
    let user = await User.getByUsername(usernameOrEmail);
    if (!user) {
      user = await User.getByEmail(usernameOrEmail);
    }
    if (!user) {
      throw new Error('Invalid credentials');
    }
    // Проверяем пароль
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      throw new Error('Invalid credentials');
    }
    // Неподтверждённые (гости) не допускаются до ввода кода из письма
    if (user.role === 'guest') {
      throw new Error('Email not verified');
    }
    // Генерируем токены
    const accessToken = this.generateAccessToken(user.id);
    const refreshToken = this.generateRefreshToken();
    // Сохраняем refresh-токен в БД
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 дней
    const db = getDB();
    await db.run(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      user.id, refreshToken, expiresAt
    );

    // Удаляем пароль из объекта
    delete user.password_hash;
    return {
      user,
      accessToken,
      refreshToken,
    };
  }

  static async refresh(refreshToken) {
    const db = getDB();
    // Ищем токен в БД
    const record = await db.get(
      'SELECT user_id, expires_at FROM refresh_tokens WHERE token = ?',
      refreshToken
    );
    if (!record) {
      throw new Error('Invalid refresh token');
    }
    if (record.expires_at < Date.now()) {
      // Удаляем просроченный
      await db.run('DELETE FROM refresh_tokens WHERE token = ?', refreshToken);
      throw new Error('Refresh token expired');
    }
    // Проверяем, существует ли пользователь
    const user = await User.getById(record.user_id);
    if (!user) {
      throw new Error('User not found');
    }
    // Генерируем новый access token
    const accessToken = this.generateAccessToken(user.id);
    // Можно обновить refresh token (опционально) – для простоты оставляем тот же
    return { accessToken };
  }

  static async logout(refreshToken) {
    const db = getDB();
    await db.run('DELETE FROM refresh_tokens WHERE token = ?', refreshToken);
  }

  static generateAccessToken(userId) {
    return jwt.sign({ userId }, config.jwtSecret, { expiresIn: config.accessTokenExpiry });
  }

  static generateRefreshToken() {
    // Генерируем случайную строку
    return crypto.randomBytes(64).toString('hex');
  }

  static verifyAccessToken(token) {
    try {
      return jwt.verify(token, config.jwtSecret);
    } catch (err) {
      return null;
    }
  }
}

module.exports = AuthService;