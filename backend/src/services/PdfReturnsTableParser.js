// src/services/PdfReturnsTableParser.js
//
// Парсит PDF-акт «Приём-передача» → пары { cargo_box_id, barcode }.
//
// Структура (эталонный dump):
//   Заголовок размазан по Y (y=559..584):
//     «Номер предмета»  x≈83
//     «Наименование»    x≈190
//     «Штрих-код»       x≈308
//     «Объявленная стоимость, руб.»  x≈401..421
//     «Вес, г»          x≈498
//   Данные — по одной Y-строке на запись (y-шаг ≈ 14).
//   Заголовок только на первой странице; страницы 2+ — сразу данные.
//
// Логика:
//   1. Извлекаем text-items с (x, y).
//   2. Группируем в строки по Y (tolerance=4 — данные выровнены).
//   3. Ищем строку-заголовок по ключевым словам; собираем items в ±25 Y.
//   4. Определяем X-якоря колонок по заголовку.
//   5. Данные: с первой строки ниже headerY-25. Для каждой строки
//      распределяем items по колонкам по X (item.x — ЛЕВАЯ граница, поэтому
//      длинное «Наименование» не «переползает» в чужую колонку).
//   6. Валидация:
//      • pp должно быть целым числом (отсекает «Итого:», футер, title);
//      • cargo_box_id и barcode — один токен без пробелов, ≤60 симв.
//   7. На страницах без заголовка используем columns с предыдущей.

const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

// ── 1. Извлечение text-items ─────────────────────────────────────────────

async function loadPdfItems(buffer) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  const items = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items) {
      const str = (item.str || '').trim();
      if (!str) continue;
      const t = item.transform || [1, 0, 0, 1, 0, 0];
      items.push({
        page: p,
        str,
        x: t[4],
        y: t[5],
        width: item.width || 0,
        height: item.height || 0,
      });
    }
  }
  return { items, numPages: pdf.numPages };
}

// ── 2. Группировка в строки ───────────────────────────────────────────────

function groupIntoRows(items, tolerance = 4) {
  const sorted = [...items].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y - b.y) > tolerance) return b.y - a.y;
    return a.x - b.x;
  });

  const rows = [];
  let current = null;

  for (const item of sorted) {
    if (
      !current ||
      current.page !== item.page ||
      Math.abs(item.y - current.y) > tolerance
    ) {
      current = { page: item.page, y: item.y, items: [item] };
      rows.push(current);
    } else {
      current.items.push(item);
    }
  }

  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    row.text = row.items.map((i) => i.str).join(' ').trim();
  }
  return rows;
}

// ── 3. Поиск заголовка и определение колонок ─────────────────────────────

function findHeaderAndColumns(pageRows) {
  // Ищем строку с максимумом ключевых слов
  let bestRow = -1;
  let bestScore = 0;
  for (let i = 0; i < pageRows.length; i++) {
    const text = pageRows[i].text.toLowerCase();
    let score = 0;
    if (/номер\s+предмета/.test(text)) score += 3;
    if (/штрих[-\s]?код/.test(text)) score += 3;
    if (/наименование/.test(text)) score += 3;
    if (score > bestScore) { bestScore = score; bestRow = i; }
  }
  // Нужны минимум 2 из 3 ключевых — иначе это не заголовок
  if (bestRow < 0 || bestScore < 6) return null;

  const headerY = pageRows[bestRow].y;

  // Собираем ВСЕ items в радиусе ±25 Y — заголовок многострочный
  const headerItems = [];
  for (const row of pageRows) {
    if (Math.abs(row.y - headerY) > 25) continue;
    for (const item of row.items) headerItems.push(item);
  }

  const columns = {
    pp: null,
    cargoBoxId: null,
    name: null,
    barcode: null,
    declaredValue: null,
    weight: null,
  };

  // Нормализуем: trim, срезаем концевую пунктуацию, lowercase
  const norm = (s) => String(s || '').trim().replace(/[.,:;]+$/, '').toLowerCase();

  for (const item of headerItems) {
    const s = norm(item.str);
    if (!s) continue;
    if (columns.pp === null && /^(пп|№|#)$/i.test(s)) columns.pp = item.x;
    if (columns.cargoBoxId === null && /^номер\s+предмета$/.test(s)) columns.cargoBoxId = item.x;
    if (columns.name === null && /^наименование$/.test(s)) columns.name = item.x;
    if (columns.barcode === null && /^штрих[-\s]?код$/.test(s)) columns.barcode = item.x;
    if (columns.declaredValue === null && /^(объявленная|стоимость|руб)$/.test(s)) columns.declaredValue = item.x;
    if (columns.weight === null && /^вес(\s*,?\s*г)?$/.test(s)) columns.weight = item.x;
  }

  // Данные начинаются с первой строки ниже headerY - 25
  let dataStart = bestRow + 1;
  for (let i = bestRow + 1; i < pageRows.length; i++) {
    if (pageRows[i].y < headerY - 25) { dataStart = i; break; }
  }

  return { columns, dataStart };
}

// ── 4. Распределение items строки по колонкам ────────────────────────────
// item.x — ЛЕВАЯ граница фрагмента, поэтому длинное «Наименование»,
// начавшееся в своей колонке, остаётся в ней, даже если визуально тянется
// вправо через границу. Именно это свойство делает метод устойчивым
// к «переползающим» наименованиям.

function pickColumnValues(row, columns) {
  const entries = Object.entries(columns).filter(([, x]) => x !== null);
  if (!entries.length) return {};
  const sorted = entries.map(([key, x]) => ({ key, x })).sort((a, b) => a.x - b.x);
  const bounds = [];
  for (let i = 0; i < sorted.length; i++) {
    const left = i === 0 ? -Infinity : (sorted[i - 1].x + sorted[i].x) / 2;
    const right = i === sorted.length - 1 ? Infinity : (sorted[i].x + sorted[i + 1].x) / 2;
    bounds.push({ key: sorted[i].key, left, right });
  }
  const result = {};
  for (const item of row.items) {
    for (const b of bounds) {
      if (item.x >= b.left && item.x < b.right) {
        if (!result[b.key]) result[b.key] = '';
        result[b.key] = (result[b.key] ? result[b.key] + ' ' : '') + item.str;
        break;
      }
    }
  }
  return result;
}

// ── 5. Валидация идентификаторов ─────────────────────────────────────────
// Один токен, ASCII, ≤60 символов. Допускаем `%` (формат %301%...),
// `-` (sr01-bx...), `_`. Кириллица и пробелы — отсекаются.

function looksLikeId(s) {
  if (!s) return false;
  const t = s.trim();
  if (!t) return false;
  if (t.length > 60) return false;
  return /^[A-Za-z0-9_%\-]+$/.test(t);
}

// ── 6. Главный метод ─────────────────────────────────────────────────────

/**
 * @param {Buffer} buffer — содержимое PDF
 * @returns {Promise<{
 *   pairs: Array<{ cargo_box_id: string, barcode: string, page: number }>,
 *   warnings: string[],
 *   numPages: number,
 *   isLikelyScanned: boolean,
 * }>}
 */
async function parseReturnsPdf(buffer) {
  const { items, numPages } = await loadPdfItems(buffer);
  const isLikelyScanned = items.length === 0;
  const warnings = [];

  if (isLikelyScanned) {
    return {
      pairs: [],
      warnings: ['PDF без текстового слоя (скан) — OCR не поддерживается'],
      numPages,
      isLikelyScanned,
    };
  }

  const rows = groupIntoRows(items);

  // Разбиваем по страницам
  const pages = new Map();
  for (const row of rows) {
    if (!pages.has(row.page)) pages.set(row.page, []);
    pages.get(row.page).push(row);
  }

  const pairs = [];
  let lastColumns = null;

  for (const [pageNum, pageRows] of pages) {
    const header = findHeaderAndColumns(pageRows);
    let columns;
    let dataStart;

    if (header) {
      columns = header.columns;
      dataStart = header.dataStart;
      lastColumns = columns;
      if (columns.cargoBoxId === null || columns.barcode === null) {
        warnings.push(
          `Стр. ${pageNum}: заголовок найден, но колонки не определены ` +
          `(cargoBoxId=${columns.cargoBoxId}, barcode=${columns.barcode})`
        );
      }
    } else if (lastColumns) {
      columns = lastColumns;
      dataStart = 0;
      warnings.push(`Стр. ${pageNum}: заголовка нет — использую колонки с предыдущей страницы`);
    } else {
      warnings.push(`Стр. ${pageNum}: заголовка нет и нет предыдущего — пропуск`);
      continue;
    }

    if (columns.cargoBoxId === null || columns.barcode === null) continue;

    for (let i = dataStart; i < pageRows.length; i++) {
      const cells = pickColumnValues(pageRows[i], columns);
      const pp = (cells.pp || '').trim();

      // Сильный фильтр данных: pp должно быть целым числом.
      // Отсекает «Итого:», футер, заголовок «Акт приёма-передачи...».
      if (!/^\d+$/.test(pp)) continue;

      const cargoBoxId = (cells.cargoBoxId || '').trim();
      const barcode = (cells.barcode || '').trim();

      if (!cargoBoxId || !barcode) continue;

      if (!looksLikeId(cargoBoxId)) {
        warnings.push(`Стр. ${pageNum}: cargo_box_id «${cargoBoxId}» не похож на ID — пропущено`);
        continue;
      }
      if (!looksLikeId(barcode)) {
        warnings.push(`Стр. ${pageNum}: barcode «${barcode}» не похож на ID — пропущено`);
        continue;
      }

      pairs.push({ cargo_box_id: cargoBoxId, barcode, page: pageNum });
    }
  }

  return { pairs, warnings, numPages, isLikelyScanned };
}

module.exports = { parseReturnsPdf };