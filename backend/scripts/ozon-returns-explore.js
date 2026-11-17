// backend/scripts/ozon-returns-explore.js
//
// Пошаговый исследовательский инструмент для цепочки резолва возвратов Ozon.
// Не пытается ничего «резолвить» сам — только вызывает методы, сохраняет
// ответы и показывает файлы, чтобы можно было изучить реальные данные.
//
// Запуск (из backend):
//   node scripts/ozon-returns-explore.js create-report --days=7
//   node scripts/ozon-returns-explore.js report-info --code=REPORT_...
//   node scripts/ozon-returns-explore.js download-csv --url=https://...
//   node scripts/ozon-returns-explore.js box-by-barcode --barcode=ii11432853186
//   node scripts/ozon-returns-explore.js chain --barcode=ii11432853186 --days=7
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

const STORE_ID = arg('store', '1');
const OUT_DIR = path.resolve(__dirname, '../outputs/returns-explore');

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

async function request(storeId, path, body, context) {
  const client = OzonService.getClient(storeId);
  // Если OzonService экспортирует requestWithRetry — используем; иначе прямой вызов.
  if (typeof OzonService.requestWithRetry === 'function') {
    return OzonService.requestWithRetry(
      () => client.post(path, body),
      { context: `${context}[${storeId}]` }
    );
  }
  return client.post(path, body);
}

// ── Команды ────────────────────────────────────────────────────────────────

async function cmdCreateReport() {
  const days = Number(arg('days', '7'));
  const dateFrom = arg('date-from', isoDaysAgo(days));
  const dateTo = arg('date-to', new Date().toISOString());
  const status = arg('status', 'MovingToSeller'); // или 'ArrivedAtReturnPlace' и т.п.
  const deliverySchema = arg('delivery-schema', 'fbs');

  const body = {
    filter: {
      delivery_schema: deliverySchema,
      date_from: dateFrom,
      date_to: dateTo,
      ...(status ? { status } : {}),
    },
    language: 'DEFAULT',
  };

  console.log(`[create-report] POST /v2/report/returns/create`, body);
  const res = await request(STORE_ID, '/v2/report/returns/create', body, 'createReturnsReport');
  const data = res.data;
  saveJson('create-report', data);
  const code = data?.result?.code;
  console.log(`✅ code = ${code}`);
  console.log(`Далее: node scripts/ozon-returns-explore.js report-info --code=${code}`);
  return code;
}

async function cmdReportInfo() {
  const code = arg('code');
  if (!code) throw new Error('Укажите --code=REPORT_...');
  console.log(`[report-info] POST /v1/report/info code=${code}`);
  const res = await request(STORE_ID, '/v1/report/info', { code }, 'reportInfo');
  const data = res.data;
  saveJson('report-info', data);
  const r = data?.result || {};
  console.log(`status = ${r.status}`);
  console.log(`file   = ${r.file || '—'}`);
  if (r.file) {
    console.log(`Далее: node scripts/ozon-returns-explore.js download-csv --url="${r.file}"`);
  }
  return r;
}

async function cmdDownloadCsv() {
  let url = arg('url');
  if (!url && arg('code')) {
    const info = await cmdReportInfo(); // повторный вызов, если передали code
    url = info?.file;
  }
  if (!url) throw new Error('Укажите --url=<file> или --code=REPORT_...');

  console.log(`[download-csv] GET ${url}`);
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  ensureOutDir();
  const file = path.join(OUT_DIR, `${stamp()}-returns-report.csv`);
  fs.writeFileSync(file, res.data);
  console.log(`💾 CSV сохранён: ${file}`);

  // Показать заголовки и первые 3 строки (грубо, но достаточно для исследования)
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  console.log(`\n📄 Всего строк (с заголовком): ${lines.length}`);
  if (lines[0]) console.log(`Заголовок: ${lines[0]}`);
  for (let i = 1; i <= Math.min(3, lines.length - 1); i++) {
    console.log(`Строка ${i}: ${lines[i]}`);
  }
  return file;
}

async function cmdBoxByBarcode() {
  const barcode = arg('barcode');
  if (!barcode) throw new Error('Укажите --barcode=...');
  console.log(`[box-by-barcode] POST /v1/return/box/get-by-barcode barcode=${barcode}`);
  const res = await request(
    STORE_ID,
    '/v1/return/box/get-by-barcode',
    { barcode: Number(barcode) || barcode }, // если барcode число — передаём как число
    'getBoxByBarcode'
  );
  const data = res.data;
  saveJson('box-by-barcode', data);
  console.log(JSON.stringify(data, null, 2));
  return data;
}

async function cmdChain() {
  const barcode = arg('barcode');
  const days = Number(arg('days', '7'));
  if (!barcode) throw new Error('Укажите --barcode=...');

  console.log(`\n=== Шаг 1: box-by-barcode (${barcode}) ===`);
  const box = await cmdBoxByBarcode();
  const cargoBoxId = box?.cargo_box_id;
  console.log(`cargo_box_id = ${cargoBoxId || '—'}`);

  console.log(`\n=== Шаг 2: create-report (за ${days} дн.) ===`);
  const code = await cmdCreateReport();

  console.log(`\n=== Шаг 3: ожидание отчёта (poll) ===`);
  let info = null;
  for (let attempt = 1; attempt <= 12; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    console.log(`poll #${attempt}...`);
    info = await cmdReportInfo();
    if (info?.status === 'success' && info?.file) break;
    if (info?.status && info.status !== 'processing' && info.status !== 'waiting') break;
  }

  if (!info?.file) {
    console.log('❌ Отчёт не готов или пуст. Дальше идти некуда.');
    return;
  }

  console.log(`\n=== Шаг 4: download-csv ===`);
  const csvFile = await cmdDownloadCsv();

  console.log(`\n=== Шаг 5: поиск cargo_box_id в CSV ===`);
  const text = fs.readFileSync(csvFile, 'utf8');
  const lines = text.split(/\r?\n/);
  const header = lines[0] || '';
  const cols = header.split(/[;,]/).map((c) => c.trim());
  const idxCargo = cols.findIndex((c) => /cargo_box_id|box_id|коробк/i.test(c));
  const idxOffer = cols.findIndex((c) => /offer_id|артикул/i.test(c));
  const idxBarcode = cols.findIndex((c) => /barcode|штрихкод/i.test(c));

  console.log(`Индексы колонок: cargo_box_id=${idxCargo}, offer_id=${idxOffer}, barcode=${idxBarcode}`);
  console.log(`Заголовок: ${header}`);

  if (idxCargo >= 0 && cargoBoxId) {
    let found = 0;
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(/[;,]/).map((c) => c.trim().replace(/^"|"$/g, ''));
      if (cells[idxCargo] === String(cargoBoxId)) {
        console.log(`\n✅ Совпадение в строке ${i}:`);
        console.log(`  cargo_box_id = ${cells[idxCargo]}`);
        if (idxOffer >= 0) console.log(`  offer_id     = ${cells[idxOffer]}`);
        if (idxBarcode >= 0) console.log(`  barcode      = ${cells[idxBarcode]}`);
        found++;
      }
    }
    if (!found) {
      console.log(`❌ cargo_box_id ${cargoBoxId} в CSV не найден.`);
      console.log(`   Возможно, отчёт за другой период или статус.`);
    }
  } else {
    console.log('⚠️  Не удалось определить колонку cargo_box_id или cargoBoxId пуст.');
    console.log('   Изучите заголовок CSV и первые строки выше.');
  }
}

// ── Роутер команд ──────────────────────────────────────────────────────────

(async () => {
  const cmd = process.argv[2];
  if (!cmd || flag('help') || cmd === 'help') {
    console.log(`
Команды:
  create-report   [--days=7] [--status=MovingToSeller] [--delivery-schema=fbs] [--date-from=ISO] [--date-to=ISO]
  report-info     --code=REPORT_...
  download-csv    --url=<file> | --code=REPORT_...
  box-by-barcode  --barcode=...
  chain           --barcode=... [--days=7]

Все ответы сохраняются в outputs/returns-explore/.
    `);
    return;
  }
  if (!stores[STORE_ID]) {
    throw new Error(`Магазин ${STORE_ID} не найден. Доступны: ${stores.getStoreIds().join(', ')}`);
  }
  console.log(`[store ${STORE_ID}]`);

  switch (cmd) {
    case 'create-report': await cmdCreateReport(); break;
    case 'report-info':   await cmdReportInfo(); break;
    case 'download-csv':  await cmdDownloadCsv(); break;
    case 'box-by-barcode':await cmdBoxByBarcode(); break;
    case 'chain':         await cmdChain(); break;
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