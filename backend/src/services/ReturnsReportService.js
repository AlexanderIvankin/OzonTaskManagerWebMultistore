// src/services/ReturnsReportService.js
//
// Шаг 1 пайплайна возвратов: наполняем returns-N.db из отчёта постингов Ozon.
//
// Цепочка:
//   1. POST /v1/report/postings/create  → { code }
//   2. POST /v1/report/info  (poll)     → { file } (CSV)
//   3. GET <file>                       → CSV
//   4. CSV → parse → фильтр → upsertMany
//
// CSV (зафиксировано по реальному отчёту):
//   • Строка 1 — заголовки.
//   • Колонки (0-indexed):
//       C (2)  «Код этикетки»  → barcode (наш ключ, совпадает с PDF «Штрих-код»)
//       G (6)  «Статус»        → фильтр отменённых
//       P (15) «SKU»
//       Q (16) «Артикул»       → offer_id
//
// Фильтр отменённых:
//   • В запросе: status_alias (опционально, задаётся через env
//     RETURNS_REPORT_STATUS_ALIAS, напр. «Canceled»). Если не задан —
//     передаём пустой массив и полагаемся только на post-фильтр.
//   • ВСЕГДА post-фильтр по колонке G: статус должен содержать «отмен»
//     (ru) или «cancel» (en), case-insensitive. Это двойная защита:
//     Ozon может вернуть больше строк, чем нужно, мы отфильтруем сами.
//
// Дедупликация:
//   Один barcode может встретиться несколько раз (несколько товаров в
//   одном постинге). Берём ПЕРВЫЙ с непустым offer_id, остальные — в
//   warnings. Если на реальных данных коллизий много — мигрируем PK
//   на (barcode, offer_id).

const axios = require('axios');
const XLSX = require('xlsx');
const OzonService = require('./OzonService');
const ReturnsCacheService = require('./ReturnsCacheService');
const { getReturnsDB } = require('../config/returnsDatabase');
const config = require('../config');

const POLL_MAX_ATTEMPTS = 40;
const POLL_INITIAL_DELAY_MS = 3000;
const POLL_MAX_DELAY_MS = 15000;

class ReturnsReportService {
  static sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /**
   * POST с ретраями и уважением Retry-After (для 429).
   */
  static async _post(storeId, apiPath, body, context, { retries = 3, baseDelay = 2000 } = {}) {
    const client = OzonService.getClient(storeId);
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await client.post(apiPath, body);
      } catch (err) {
        const status = err.response?.status;

        // 403 — не ретраим и явно классифицируем: неверный ключ
        // или нет прав на метод в кабинете Ozon. Retry бессмыслен.
        if (status === 403) {
          const ozonMsg = err.response?.data?.message
            || err.response?.data?.error
            || 'Доступ запрещён';
          const e = new Error(
            `Ozon 403 (${apiPath}): нет прав у магазина ${storeId}. ` +
            `Ответ Ozon: «${ozonMsg}». ` +
            `Проверьте OZON_CLIENT_ID / OZON_API_KEY в .env.store${storeId} ` +
            `и права метода в кабинете Ozon (Настройки → API-ключи).`
          );
          e.code = 'OZON_PERMISSION_DENIED';
          e.storeId = String(storeId);
          e.apiPath = apiPath;
          throw e;
        }

        const isRetryable = !status || status === 429 || [500, 502, 503, 504].includes(status);
        if (!isRetryable || attempt === retries) throw err;

        const retryAfterSec = parseInt(err.response?.headers?.['retry-after'], 10);
        const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.max(retryAfterSec * 1000, 2000)   // минимум 2 сек
          : Math.max(baseDelay * Math.pow(2, attempt - 1), 2000);

        console.warn(
          `[${context}] ${status || 'network'} (попытка ${attempt}/${retries}), ` +
          `жду ${waitMs}мс${Number.isFinite(retryAfterSec) ? ` (Retry-After: ${retryAfterSec}s)` : ''}`
        );
        await this.sleep(waitMs);
      }
    }
  }

  static async createReport(storeId, { dateFrom, dateTo, statusAlias = [] }) {
    const deliverySchema = config.returnsReport.deliverySchema.length
      ? config.returnsReport.deliverySchema
      : ['fbs'];

    const filter = {
      processed_at_from: dateFrom.toISOString(),
      processed_at_to: dateTo.toISOString(),
      delivery_schema: deliverySchema,
    };
    if (statusAlias.length) filter.status_alias = statusAlias;

    const body = { filter, language: 'DEFAULT' };

    console.log(
      `[ReturnsReport][store ${storeId}] create postings: ` +
      `${dateFrom.toISOString()}..${dateTo.toISOString()} schema=${deliverySchema.join(',')}` +
      (statusAlias.length ? ` status_alias=${statusAlias.join(',')}` : '')
    );
    const res = await this._post(
      storeId, '/v1/report/postings/create', body, `createPostingsReport[${storeId}]`,
      { retries: 5, baseDelay: 3000 }
    );
    const code = res.data?.result?.code;
    if (!code) {
      throw new Error(`Ozon не вернул код отчёта: ${JSON.stringify(res.data)}`);
    }
    return code;
  }

  static async waitForReport(storeId, code) {
    let delayMs = POLL_INITIAL_DELAY_MS;
    for (let i = 1; i <= POLL_MAX_ATTEMPTS; i++) {
      await this.sleep(delayMs);
      delayMs = Math.min(Math.floor(delayMs * 1.5), POLL_MAX_DELAY_MS);

      let res;
      try {
        res = await this._post(
          storeId, '/v1/report/info', { code }, `reportInfo[${storeId}]`
        );
      } catch (err) {
        console.warn(`[ReturnsReport][store ${storeId}] poll #${i}: ${err.message}`);
        continue;
      }
      const r = res.data?.result || {};
      if (r.status === 'success' && r.file) return r.file;
      if (r.status === 'error' || (r.error && String(r.error).trim())) {
        throw new Error(`Ozon вернул ошибку отчёта: ${r.error || r.status}`);
      }
      console.log(`[ReturnsReport][store ${storeId}] poll #${i}: status=${r.status}`);
    }
    throw new Error('Таймаут ожидания отчёта Ozon');
  }

  static async downloadReport(url) {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
    return Buffer.from(res.data);
  }

  /**
   * Парсинг CSV. Ozon отдаёт файл с заголовком в первой строке.
   * Используем XLSX (он умеет читать CSV), чтобы не тащить новую зависимость.
   */
  static parseReport(buffer) {
    const wb = XLSX.read(buffer, { type: 'buffer', raw: true });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new Error('Пустой файл — нет листов');
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!rows.length) throw new Error('Пустая таблица');

    // ── Динамическое определение колонок по заголовку ─────────────────────
    const header = rows[0] || [];
    const norm = (s) => String(s || '').toLowerCase().trim();
    const findCol = (pattern, fallback) => {
      for (let i = 0; i < header.length; i++) {
        if (pattern.test(norm(header[i]))) return i;
      }
      return fallback;
    };

    const COL_BARCODE = findCol(/код.*этикет/, 2);
    const COL_STATUS = findCol(/статус/, 6);
    const COL_SKU = findCol(/^sku$/, 15);
    const COL_OFFER = findCol(/артикул/, 16);
    const COL_QUANTITY = findCol(/количеств|кол-во/, 21);

    const isCanceledStatus = (s) => {
      const v = norm(s);
      return v.includes('отмен') || v.includes('cancel');
    };

    // Одиночный ID: alnum + . _ - % : (barcode может быть %301%..., offer_id ARD-001)
    const looksSingle = (s) => /^[A-Za-z0-9_\-%.:]+$/.test(s);

    // Ячейка содержит несколько значений?
    const hasMultipleValues = (s) => {
      const t = String(s || '').trim();
      if (!t) return false;
      if (looksSingle(t)) return false;
      return /[,;\n\t]/.test(t) || /\s/.test(t);
    };

    // ── Парсинг строк ─────────────────────────────────────────────────────
    const rawData = [];
    const stats = {
      totalRows: 0,
      canceledRows: 0,
      skippedEmptyBarcode: 0,
      skippedNotCanceled: 0,
      skippedMultipleInCell: 0,
      skippedNoOffer: 0,
    };

    for (let i = 1; i < rows.length; i++) {
      stats.totalRows++;
      const row = rows[i] || [];
      const barcode = String(row[COL_BARCODE] || '').trim();
      const status = String(row[COL_STATUS] || '').trim();
      const offerRaw = String(row[COL_OFFER] || '').trim();
      const skuRaw = String(row[COL_SKU] || '').trim();
      const qtyRaw = String(row[COL_QUANTITY] || '').trim();

      if (!barcode) { stats.skippedEmptyBarcode++; continue; }
      if (!isCanceledStatus(status)) { stats.skippedNotCanceled++; continue; }
      stats.canceledRows++;

      // Мульти-значение в ячейке → пропускаем строку
      if (hasMultipleValues(offerRaw) || hasMultipleValues(skuRaw)) {
        stats.skippedMultipleInCell++;
        continue;
      }

      if (!offerRaw && !skuRaw) {
        stats.skippedNoOffer++;
        // сохраняем как skip-строку, чтобы знать о «слепом» возврате
      }

      const quantity = Math.max(1, parseInt(qtyRaw, 10) || 1);
      const offerId = offerRaw || null;
      const sku = skuRaw || null;
      const id = `${barcode}|${offerId || sku || 'NO_OFFER'}`;

      rawData.push({
        id,
        barcode,
        offer_id: offerId,
        sku,
        quantity,
        resolution_status: (offerId || sku) ? 'ready' : 'skip',
        resolution_reason: (offerId || sku) ? null : 'no_offer_id',
      });
    }

    // ── Детект multi-product: barcode с >1 уникальным offer_id/sku ────────
    const byBarcode = new Map();
    for (const r of rawData) {
      if (!byBarcode.has(r.barcode)) byBarcode.set(r.barcode, []);
      byBarcode.get(r.barcode).push(r);
    }
    let multiCount = 0;
    for (const [barcode, group] of byBarcode) {
      const uniqueIds = new Set(group.map((r) => r.offer_id || r.sku || 'NO_OFFER'));
      if (uniqueIds.size > 1) {
        // Все строки этого barcode → skip/multiple_products
        for (const r of group) {
          r.resolution_status = 'skip';
          r.resolution_reason = 'multiple_products';
        }
        multiCount++;
      }
    }

    // ── Агрегация quantity по композитному id внутри батча ────────────────
    const aggregated = new Map();
    for (const r of rawData) {
      if (aggregated.has(r.id)) {
        aggregated.get(r.id).quantity += r.quantity;
      } else {
        aggregated.set(r.id, { ...r });
      }
    }

    const data = Array.from(aggregated.values());
    return {
      rows: data,
      stats: {
        ...stats,
        uniqueRows: data.length,
        multiProductBarcodes: multiCount,
        ready: data.filter((r) => r.resolution_status === 'ready').length,
        skip: data.filter((r) => r.resolution_status === 'skip').length,
      },
      warnings: [],
    };
  }

  static computeRange() {
    const now = Date.now();
    const fullDays = config.returnsReport.syncDaysFull;
    return {
      dateFrom: new Date(now - fullDays * 86400000),
      dateTo: new Date(now),
    };
  }

  static async syncRange(storeId, { dateFrom, dateTo, statusAlias }) {
    const startedAt = Date.now();
    const alias = statusAlias !== undefined
      ? statusAlias
      : config.returnsReport.statusAlias;

    const code = await this.createReport(storeId, { dateFrom, dateTo, statusAlias: alias });
    const fileUrl = await this.waitForReport(storeId, code);
    const buffer = await this.downloadReport(fileUrl);
    const parsed = this.parseReport(buffer);
    const upsert = await ReturnsCacheService.upsertMany(storeId, parsed.rows);

    // Плоский summary: всё, что нужно фронту, — на верхнем уровне.
    // Никакого nested parse/stats — фронт-тип стабилен, даже если
    // внутренняя структура stats поменяется.
    const summary = {
      storeId: String(storeId),
      code,
      dateFrom: dateFrom.toISOString(),
      dateTo: dateTo.toISOString(),
      statusAlias: alias,

      // parse stats
      totalRows: parsed.stats.totalRows,
      canceledRows: parsed.stats.canceledRows,
      skippedEmptyBarcode: parsed.stats.skippedEmptyBarcode,
      skippedNotCanceled: parsed.stats.skippedNotCanceled,
      skippedMultipleInCell: parsed.stats.skippedMultipleInCell,
      skippedNoOffer: parsed.stats.skippedNoOffer,
      uniqueRows: parsed.stats.uniqueRows,
      multiProductBarcodes: parsed.stats.multiProductBarcodes,
      ready: parsed.stats.ready,
      skip: parsed.stats.skip,

      // upsert
      inserted: upsert.inserted,
      updated: upsert.updated,

      // diagnostic
      headerWarnings: parsed.warnings,
      durationMs: Date.now() - startedAt,
    };

    console.log(`[ReturnsReport][store ${storeId}] OK: ${JSON.stringify(summary)}`);
    return summary;
  }

  static async syncAuto(storeId) {
    const { dateFrom, dateTo } = this.computeRange();
    return this.syncRange(storeId, { dateFrom, dateTo });
  }
}

module.exports = ReturnsReportService;