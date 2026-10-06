const { PDFDocument } = require('pdf-lib');
require('dotenv').config();

const TIMEZONE = process.env.TIMEZONE || 'Europe/Moscow';

/**
 * Объединяет несколько PDF-буферов в один.
 * @param {Buffer[]} pdfBuffers
 * @returns {Promise<Buffer|null>}
 */
async function mergePdfs(pdfBuffers) {
  if (!pdfBuffers || !pdfBuffers.length) return null;
  const mergedPdf = await PDFDocument.create();
  for (const buffer of pdfBuffers) {
    try {
      const pdf = await PDFDocument.load(buffer);
      const indices = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      for (const page of indices) {
        mergedPdf.addPage(page);
      }
    } catch (err) {
      console.error('Ошибка при объединении PDF:', err);
    }
  }
  return Buffer.from(await mergedPdf.save());
}

/**
 * Форматирует дату для имени файла: YYYY-MM-DD_HH-MM-SS в указанном часовом поясе
 */
function formatLocalTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: TIMEZONE
  }).formatToParts(date);

  const getPart = (type) => parts.find(p => p.type === type)?.value || '00';
  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const hour = getPart('hour');
  const minute = getPart('minute');
  const second = getPart('second');
  return `${year}-${month}-${day}_${hour}-${minute}-${second}`;
}

/**
 * Форматирует timestamp (число мс) в DD.MM.YYYY в указанном часовом поясе
 */
function formatDateDDMMYYYY(timestamp) {
  const date = new Date(timestamp);
  const parts = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: TIMEZONE
  }).formatToParts(date);
  const day = parts.find(p => p.type === 'day')?.value || '??';
  const month = parts.find(p => p.type === 'month')?.value || '??';
  const year = parts.find(p => p.type === 'year')?.value || '????';
  return `${day}.${month}.${year}`;
}

/**
 * Возвращает текущую дату и время в указанном часовом поясе как объект Date.
 * @returns {Date}
 */
function getLocalDate() {
  const now = new Date();
  // Формируем строку в локальном времени и парсим обратно в Date
  const formatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: TIMEZONE
  });
  const parts = formatter.formatToParts(now);
  const getPart = (type) => parseInt(parts.find(p => p.type === type)?.value || '0');
  const year = getPart('year');
  const month = getPart('month') - 1; // месяцы в JS 0-11
  const day = getPart('day');
  const hour = getPart('hour');
  const minute = getPart('minute');
  const second = getPart('second');
  return new Date(year, month, day, hour, minute, second);
}

/**
 * Возвращает объект с часами и минутами локального времени.
 * @returns {{ hours: number, minutes: number }}
 */
function getLocalTime() {
  const date = getLocalDate();
  return {
    hours: date.getHours(),
    minutes: date.getMinutes()
  };
}

/**
 * Форматирует дату для логов: YYYY-MM-DD HH:MM:SS в локальном времени.
 * @returns {string}
 */
function getLocalTimestamp() {
  const date = getLocalDate();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Возвращает версию приложения из переменной окружения BOT_VERSION.
 * @returns {string|null} - версия или null, если не задана
 */
function getAppVersion() {
  const version = (process.env.BOT_VERSION || '').trim();
  return version || null;
}

/**
 * Базовое имя файла БД (без пути, расширения и суффикса версии).
 * './bot_web.db' и './bot_web-1.db' -> 'bot_web'; если DB_PATH не задан — 'bot_web'.
 * Суффикс версии срезается только при активном версионировании (BOT_VERSION
 * задан), чтобы getVersionedFileName не задваивал его (файл БД уже
 * версионирован: иначе получилось бы 'bot_web-1-1.db'). Если BOT_VERSION
 * пуст, имя из DB_PATH берётся как есть — версия в нём часть имени.
 * @returns {string}
 */
function getDbBaseName() {
  const dbPath = process.env.DB_PATH || './bot_web.db';
  const fileName = dbPath.split(/[\\/]/).pop() || 'bot_web.db';
  const base = fileName.replace(/\.db$/i, '') || 'bot_web';
  const version = (process.env.BOT_VERSION || '').trim();
  return version ? (base.replace(/-\d+$/, '') || base) : base;
}

/**
 * Формирует имя файла с версией (если BOT_VERSION задан в .env).
 * getVersionedFileName('team-info', 'xlsx') -> 'team-info-1.xlsx' | 'team-info.xlsx'
 * @param {string} base - базовое имя без расширения
 * @param {string} ext - расширение без точки
 * @returns {string}
 */
function getVersionedFileName(base, ext) {
  const version = getAppVersion();
  return version ? `${base}-${version}.${ext}` : `${base}.${ext}`;
}

/**
 * Формирует имя файла с версией (если BOT_VERSION задан) и датой/периодом.
 * getVersionedDatedFileName('bot_web', 'db', '2026-09-04') -> 'bot_web-1_2026-09-04.db' | 'bot_web_2026-09-04.db'
 * @param {string} base - базовое имя без расширения
 * @param {string} ext - расширение без точки
 * @param {string} datePart - часть с датой/временем (вставляется через '_')
 * @returns {string}
 */
function getVersionedDatedFileName(base, ext, datePart) {
  const version = getAppVersion();
  return version ? `${base}-${version}_${datePart}.${ext}` : `${base}_${datePart}.${ext}`;
}

// ============================================================================
// Валидация/парсинг полей сотрудников (телефон, e-mail, Telegram ID, числа).
// Одни и те же правила применяются при регистрации (AuthService), редактировании
// (adminController) и синхронизации из Excel (SyncService) — чтобы в БД всё
// хранилось в едином формате.
// ============================================================================

/**
 * Парсит телефон в любом из принятых форматов и приводит к 11 цифрам вида
 * '7XXXXXXXXXX'. Поддерживает: '+7 (999) 123-45-67', '79991234567',
 * '89991234567' (ведущая «8» → «7»), '9991234567' (10 цифр без кода страны).
 * @param {string|number} raw
 * @returns {string|null} '7XXXXXXXXXX' или null, если распознать не удалось
 */
function parsePhone(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  // Ведущая «8» — российский транк-префикс, приводим к «7»
  if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
  // 10 цифр без кода страны → дописываем 7
  if (digits.length === 10) digits = '7' + digits;
  if (digits.length !== 11 || digits[0] !== '7') return null;
  return digits;
}

/**
 * Красивый формат телефона «+7 (999) 123-45-67» из любого распознаваемого
 * формата (см. parsePhone).
 * @param {string|number} raw
 * @returns {string|null} '+7 (999) 123-45-67' или null
 */
function formatPhonePretty(raw) {
  const digits = parsePhone(raw);
  if (!digits) return null;
  return `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`;
}

// Базовая проверка email: только латиница, цифры и символы ._%+- в локальной
// части. Кириллица/пробелы/прочие символы не допускаются — такой email никогда
// не совпадёт с БД при синхронизации (ломает матчинг сотрудника по email).
const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)+$/;

/**
 * Парсит email: trim + нижний регистр; null, если пусто или формат невалиден
 * (например, кириллица, пробелы внутри).
 * @param {string} raw
 * @returns {string|null}
 */
function parseEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  return EMAIL_RE.test(s) ? s : null;
}

/**
 * Парсит Telegram ID: ТОЛЬКО непустая последовательность цифр.
 * @param {string|number} raw
 * @returns {string|null}
 */
function parseTgUserId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  return /^\d+$/.test(s) ? s : null;
}

/**
 * Парсит число принтеров: целое число >= 1.
 * null — если пусто или невалидно (дробные, 0, буквы и т.п.).
 * @param {string|number} raw
 * @returns {number|null}
 */
function parseCapacity(raw) {
  const s = String(raw ?? '').trim();
  if (!s || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Парсит коэффициент заработка: положительное число с максимум 2 знаками
 * после запятой; принимает оба формата — '99.99' и '99,99'.
 * null — если пусто или невалидно (отрицательные, >2 знаков, буквы и т.п.).
 * @param {string|number} raw
 * @returns {number|null}
 */
function parseEarningsFactor(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/,/g, '.');
  if (!s || !/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Функция для формирования вывода в HTML parse mode
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ============================================================================
// Бэкапы/отдача файлов: SQL-литералы и запрет кэширования
// ============================================================================

/**
 * Готовит строковый литерал SQLite для подстановки в SQL. Нужен там, где
 * SQLite требует именно текстовый литерал (например, путь в `VACUUM INTO '...'`):
 * одинарные кавычки удваиваются, обратные слэши заменяются на прямые — иначе
 * путь Windows ('C:\...\outputs\x.db') вёл бы себя непредсказуемо.
 * @param {string} value - путь или другое строковое значение
 * @returns {string} готовый литерал вместе с обрамляющими кавычками
 */
function toSqliteLiteral(value) {
  return `'${String(value).replace(/\\/g, '/').replace(/'/g, "''")}'`;
}

/**
 * Запрещает кэширование приватной бинарной отдачи (снимок БД, Excel, PDF,
 * zip-модель). Без этих заголовков ответ 200 с Last-Modified формально
 * кэшируем эвристически — браузер или прокси вправе отдать старую копию
 * файла, а для «скачать свежий снимок БД» это недопустимо.
 * @param {import('express').Response} res
 */
function disableCache(res) {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

module.exports = {
  mergePdfs,
  formatLocalTimestamp,
  formatDateDDMMYYYY,
  getLocalDate,
  getLocalTime,
  getLocalTimestamp,
  escapeHtml,
  getAppVersion,
  getDbBaseName,
  getVersionedFileName,
  getVersionedDatedFileName,
  parsePhone,
  formatPhonePretty,
  parseEmail,
  parseTgUserId,
  parseCapacity,
  parseEarningsFactor,
  toSqliteLiteral,
  disableCache,
};