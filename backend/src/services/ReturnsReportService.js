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
          ? retryAfterSec * 1000
          : baseDelay * Math.pow(2, attempt - 1);

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
      storeId, '/v1/report/postings/create', body, `createPostingsReport[${storeId}]`
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

    // Индексы колонок (по факту)
    const COL_BARCODE = 2; // C
    const COL_STATUS = 6;  // G
    const COL_SKU = 15;    // P
    const COL_OFFER = 16;  // Q

    // Проверим, что заголовки совпадают — если Ozon поменяет порядок, увидим
    const header = rows[0] || [];
    const headerWarnings = [];
    const norm = (s) => String(s || '').toLowerCase().trim();
    if (!norm(header[COL_BARCODE]).includes('код') && !norm(header[COL_BARCODE]).includes('этикет')) {
      headerWarnings.push(
        `Колонка C («${header[COL_BARCODE]}») не похожа на «Код этикетки» — проверьте маппинг`
      );
    }
    if (!norm(header[COL_OFFER]).includes('артикул')) {
      headerWarnings.push(
        `Колонка Q («${header[COL_OFFER]}») не похожа на «Артикул» — проверьте маппинг`
      );
    }
    if (!norm(header[COL_SKU]).includes('sku')) {
      headerWarnings.push(
        `Колонка P («${header[COL_SKU]}») не похожа на «SKU» — проверьте маппинг`
      );
    }

    // Фильтр «отменённых». Ищем в статусе «отмен» или «cancel».
    const isCanceledStatus = (s) => {
      const v = norm(s);
      return v.includes('отмен') || v.includes('cancel');
    };

    // Дедупликация по barcode: берём первую с непустым offer_id/sku
    const byBarcode = new Map();
    const collisions = [];
    let totalRows = 0;
    let canceledRows = 0;
    let skippedEmptyBarcode = 0;
    let skippedNotCanceled = 0;
    let skippedNoOffer = 0;

    for (let i = 1; i < rows.length; i++) {
      totalRows++;
      const row = rows[i] || [];
      const barcode = String(row[COL_BARCODE] || '').trim();
      const status = String(row[COL_STATUS] || '').trim();
      const offerId = String(row[COL_OFFER] || '').trim();
      const sku = String(row[COL_SKU] || '').trim();

      if (!barcode) { skippedEmptyBarcode++; continue; }
      if (!isCanceledStatus(status)) { skippedNotCanceled++; continue; }
      canceledRows++;

      if (!offerId && !sku) {
        skippedNoOffer++;
        // Сохраняем как 'skip', чтобы barcode был в БД, но без матчинга
        if (!byBarcode.has(barcode)) {
          byBarcode.set(barcode, {
            id: barcode,
            barcode,
            offer_id: null,
            sku: null,
            resolution_status: 'skip',
          });
        }
        continue;
      }

      if (!byBarcode.has(barcode)) {
        byBarcode.set(barcode, {
          id: barcode,
          barcode,
          offer_id: offerId || null,
          sku: sku || null,
          resolution_status: 'ready',
        });
      } else {
        const existing = byBarcode.get(barcode);
        if (existing.resolution_status === 'skip') {
          // Апгрейд: был skip, теперь есть offer_id
          existing.offer_id = offerId || null;
          existing.sku = sku || null;
          existing.resolution_status = 'ready';
        } else if (existing.offer_id !== (offerId || null) || existing.sku !== (sku || null)) {
          collisions.push({ barcode, kept: existing.offer_id, dropped: offerId });
        }
      }
    }

    const data = Array.from(byBarcode.values());
    return {
      rows: data,
      stats: {
        totalRows,
        canceledRows,
        skippedEmptyBarcode,
        skippedNotCanceled,
        skippedNoOffer,
        deduplicated: data.length,
        collisions: collisions.length,
      },
      warnings: headerWarnings,
      collisions: collisions.slice(0, 20), // первые 20 для лога
    };
  }

  static computeRange(maxTsMs) {
    const now = Date.now();
    const fullDays = config.returnsReport.syncDaysFull;
    const overlapHours = config.returnsReport.syncOverlapHours;
    const fullMs = fullDays * 86400000;
    const overlapMs = overlapHours * 3600000;

    let dateFromMs;
    if (maxTsMs && maxTsMs > now - fullMs) {
      dateFromMs = Math.max(maxTsMs - overlapMs, now - fullMs);
    } else {
      dateFromMs = now - fullMs;
      if (maxTsMs) {
        const gapDays = ((now - maxTsMs) / 86400000).toFixed(1);
        console.warn(`[ReturnsReport] Гэп ${gapDays} дн. > окна ${fullDays} дн. — беру ${fullDays} дн.`);
      }
    }
    return { dateFrom: new Date(dateFromMs), dateTo: new Date(now) };
  }

  static async syncRange(storeId, { dateFrom, dateTo, statusAlias }) {
    const startedAt = Date.now();
    const alias = statusAlias !== undefined ? statusAlias : config.returnsReport.statusAlias;

    const code = await this.createReport(storeId, { dateFrom, dateTo, statusAlias: alias });
    const fileUrl = await this.waitForReport(storeId, code);
    const buffer = await this.downloadReport(fileUrl);
    const parsed = this.parseReport(buffer);
    const upsert = await ReturnsCacheService.upsertMany(storeId, parsed.rows);

    const summary = {
      storeId, code,
      dateFrom: dateFrom.toISOString(),
      dateTo: dateTo.toISOString(),
      statusAlias: alias,
      parse: parsed.stats,
      headerWarnings: parsed.warnings,
      collisionsSample: parsed.collisions,
      inserted: upsert.inserted,
      updated: upsert.updated,
      ready: parsed.rows.filter((r) => r.resolution_status === 'ready').length,
      skip: parsed.rows.filter((r) => r.resolution_status === 'skip').length,
      durationMs: Date.now() - startedAt,
    };
    console.log(`[ReturnsReport][store ${storeId}] OK: ${JSON.stringify(summary)}`);
    return summary;
  }

  static async syncAuto(storeId) {
    const db = getReturnsDB(storeId);
    const row = await db.get('SELECT MAX(updated_at) AS max_ts FROM returns');
    const { dateFrom, dateTo } = this.computeRange(row?.max_ts);
    return this.syncRange(storeId, { dateFrom, dateTo });
  }
}

module.exports = ReturnsReportService;