// backend/scripts/ozon-postings-report-explore.js
//
// Пошаговый исследовательский инструмент для отчёта по отправлениям Ozon
// (/v1/report/postings/create → /v1/report/info → download CSV).
// Ничего не «резолвит» сам — только вызывает методы, сохраняет ответы
// и показывает файлы, чтобы изучить реальные данные.
//
// Запуск (из backend):
//   node scripts/ozon-postings-report-explore.js create-report --days=7
//   node scripts/ozon-postings-report-explore.js report-info --code=REPORT_...
//   node scripts/ozon-postings-report-explore.js download-csv --url=https://...
//   node scripts/ozon-postings-report-explore.js download-csv --code=REPORT_...
//   node scripts/ozon-postings-report-explore.js chain --days=7
//
// Требования: .env.store1 с OZON_CLIENT_ID / OZON_API_KEY, доступ к api-seller.ozon.ru.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const OzonService = require('../src/services/OzonService');
const stores = require('../src/config/stores');

// ── Аргументы ──────────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}
// "a,b,c" → ['a','b','c'] (пустые отбрасываются)
function listArg(name) {
  const v = arg(name);
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}
// То же, но с приведением к числу (для sku / cancel_reason_id)
function numListArg(name) {
  return listArg(name).map((s) => Number(s)).filter((n) => !Number.isNaN(n));
}
// true / false / null (если не задан)
function boolArg(name) {
  const v = arg(name);
  if (v === null) return null;
  return v === 'true' || v === '1' || v === 'yes';
}

const STORE_ID = arg('store', '1');
const OUT_DIR = path.resolve(__dirname, '../outputs/postings-explore');

function ensureOutDir() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function saveJson(label, data) {
  ensureOutDir();
  const file = path.join(OUT_DIR, `${stamp()}-${label}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`💾 JSON сохранён: ${file}`);
  return file;
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - Number(days));
  return d.toISOString();
}

async function request(storeId, apiPath, body, context, { retries = 3, baseDelay = 2000 } = {}) {
  const client = OzonService.getClient(storeId);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await client.post(apiPath, body);
    } catch (err) {
      const status = err.response?.status;
      if (status !== 429 || attempt === retries) throw err;

      const retryAfter = parseInt(err.response?.headers?.['retry-after'], 10);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : baseDelay * Math.pow(2, attempt - 1);

      console.warn(
        `[${context}] 429 (попытка ${attempt}/${retries}), ` +
        `жду ${waitMs}мс${Number.isFinite(retryAfter) ? ` (Retry-After: ${retryAfter}s)` : ''}`
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

// ── Команды ────────────────────────────────────────────────────────────────

async function cmdCreateReport() {
  const days = Number(arg('days', '7'));
  const dateFrom = arg('date-from', isoDaysAgo(days));
  const dateTo = arg('date-to', new Date().toISOString());

  const deliverySchema = listArg('delivery-schema');       // ['fbo'] / ['fbs'] / ...
  const statuses = listArg('statuses');                     // ['delivered', ...]
  const statusAlias = listArg('status-alias');              // ['...']
  const sku = numListArg('sku');
  const cancelReasonId = numListArg('cancel-reason-id');
  const offerId = arg('offer-id', '');
  const title = arg('title', '');
  const isExpress = boolArg('is-express');                  // true / false / null

  const filter = {
    processed_at_from: dateFrom,
    processed_at_to: dateTo,
  };
  if (deliverySchema.length) filter.delivery_schema = deliverySchema;
  if (isExpress !== null) filter.is_express = isExpress;
  if (sku.length) filter.sku = sku;
  if (cancelReasonId.length) filter.cancel_reason_id = cancelReasonId;
  if (offerId) filter.offer_id = offerId;
  if (statusAlias.length) filter.status_alias = statusAlias;
  if (statuses.length) filter.statuses = statuses;
  if (title) filter.title = title;

  // with-флаги: по умолчанию всё false
  const withObj = {
    additional_data: !!flag('with-additional-data'),
    analytics_data: !!flag('with-analytics-data'),
    customer_data: !!flag('with-customer-data'),
    jewelry_codes: !!flag('with-jewelry-codes'),
  };

  const body = {
    filter,
    language: arg('language', 'DEFAULT'),
    with: withObj,
  };

  console.log(`[create-report] POST /v1/report/postings/create`);
  console.log(JSON.stringify(body, null, 2));
  const res = await request(STORE_ID, '/v1/report/postings/create', body, 'createPostingsReport');
  const data = res.data;
  saveJson('create-report', data);
  const code = data?.result?.code;
  console.log(`✅ code = ${code}`);
  console.log(`Далее: node scripts/ozon-postings-report-explore.js report-info --code=${code}`);
  return code;
}

async function cmdReportInfo(codeArg = null) {
  const code = codeArg || arg('code');
  if (!code) throw new Error('Укажите --code=REPORT_...');
  console.log(`[report-info] POST /v1/report/info code=${code}`);
  const res = await request(STORE_ID, '/v1/report/info', { code }, 'reportInfo');
  const data = res.data;
  saveJson('report-info', data);
  const r = data?.result || {};
  console.log(`status = ${r.status}`);
  console.log(`file   = ${r.file || '—'}`);
  if (r.file) {
    console.log(`Далее: node scripts/ozon-postings-report-explore.js download-csv --url="${r.file}"`);
  }
  return r;
}

async function cmdDownloadCsv(urlArg = null, codeArg = null) {
  let url = urlArg || arg('url');
  if (!url && (codeArg || arg('code'))) {
    const info = await cmdReportInfo(codeArg || arg('code'));
    url = info?.file;
  }
  if (!url) throw new Error('Укажите --url=<file> или --code=REPORT_...');

  console.log(`[download-csv] GET ${url}`);
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  ensureOutDir();
  const file = path.join(OUT_DIR, `${stamp()}-postings-report.csv`);
  fs.writeFileSync(file, res.data);
  console.log(`💾 CSV сохранён: ${file}`);

  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  console.log(`\n📄 Всего строк (с заголовком): ${lines.length}`);
  if (lines[0]) console.log(`Заголовок: ${lines[0]}`);
  for (let i = 1; i <= Math.min(3, lines.length - 1); i++) {
    console.log(`Строка ${i}: ${lines[i]}`);
  }
  return file;
}

async function cmdChain() {
  const days = Number(arg('days', '7'));

  console.log(`\n=== Шаг 1: create-report (за ${days} дн.) ===`);
  const code = await cmdCreateReport();

  console.log(`\n=== Шаг 2: ожидание отчёта (poll) ===`);
  let info = null;
  for (let attempt = 1; attempt <= 12; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    console.log(`poll #${attempt}...`);
    info = await cmdReportInfo(code);
    if (info?.status === 'success' && info?.file) break;
    if (info?.status && info.status !== 'processing' && info.status !== 'waiting') break;
  }

  if (!info?.file) {
    console.log('❌ Отчёт не готов или пуст. Дальше идти некуда.');
    return;
  }

  console.log(`\n=== Шаг 3: download-csv ===`);
  const csvFile = await cmdDownloadCsv(info.file);

  console.log(`\n=== Шаг 4: краткий разбор заголовков CSV ===`);
  const text = fs.readFileSync(csvFile, 'utf8');
  const lines = text.split(/\r?\n/);
  const header = lines[0] || '';
  const cols = header.split(/[;,]/).map((c) => c.trim());
  console.log(`Колонок: ${cols.length}`);
  cols.forEach((c, i) => console.log(`  [${i}] ${c}`));
}

// ── Роутер команд ──────────────────────────────────────────────────────────

(async () => {
  const cmd = process.argv[2];
  if (!cmd || flag('help') || cmd === 'help') {
    console.log(`
Команды:
  create-report   [--days=7] [--date-from=ISO] [--date-to=ISO]
                  [--delivery-schema=fbo,fbs] [--is-express=true|false]
                  [--sku=1,2] [--cancel-reason-id=1,2]
                  [--offer-id=...] [--statuses=a,b] [--status-alias=a,b] [--title=...]
                  [--with-additional-data] [--with-analytics-data]
                  [--with-customer-data] [--with-jewelry-codes]
                  [--language=DEFAULT]
  report-info     --code=REPORT_...
  download-csv    --url=<file> | --code=REPORT_...
  chain           [--days=7] [--delivery-schema=fbo,...] ...

Все ответы сохраняются в outputs/postings-explore/.
    `);
    return;
  }
  if (!stores[STORE_ID]) {
    throw new Error(`Магазин ${STORE_ID} не найден. Доступны: ${stores.getStoreIds().join(', ')}`);
  }
  console.log(`[store ${STORE_ID}]`);

  switch (cmd) {
    case 'create-report': await cmdCreateReport(); break;
    case 'report-info': await cmdReportInfo(); break;
    case 'download-csv': await cmdDownloadCsv(); break;
    case 'chain': await cmdChain(); break;
    default:
      throw new Error(`Неизвестная команда: ${cmd}`);
  }
})().catch((err) => {
  console.error('❌', err.message);
  if (err.response) {
    console.error('HTTP', err.response.status);
    console.error(JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});