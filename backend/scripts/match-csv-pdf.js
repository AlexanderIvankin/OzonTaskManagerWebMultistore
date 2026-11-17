// backend/scripts/match-csv-pdf.js
//
// Автономный тест-мэтчер: CSV-отчёт постингов Ozon + PDF-акт приёмки.
// Показывает, какая доля cargo_box_id из PDF резолвится в offer_id через CSV.
// НЕ вызывает Ozon API, НЕ пишет в БД — чистая проверка гипотезы на файлах.
//
// Запуск (из backend):
//   node scripts/match-csv-pdf.js --csv=report.csv --pdf=act.pdf
//   node scripts/match-csv-pdf.js --csv=report.csv --pdf=act.pdf --dump-json
//
// CSV (отчёт постингов):
//   • Строка 1 — заголовки.
//   • Колонки (0-indexed):
//       C (2)  «Код этикетки»  → barcode
//       G (6)  «Статус»        → фильтр «cancelled»
//       P (15) «SKU»
//       Q (16) «Артикул»       → offer_id
//   • Дедупликация: первый barcode выигрывает, последующие тихо пропускаем
//     (идентично parseReport в ReturnsReportService).

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { parseReturnsPdf } = require('../src/services/PdfReturnsTableParser');

// ── Колонки CSV (0-indexed) ────────────────────────────────────────────────
const COL_BARCODE = 2;   // C «Код этикетки»
const COL_STATUS = 6;   // G «Статус»
const COL_SKU = 15;  // P «SKU»
const COL_OFFER = 16;  // Q «Артикул»

function arg(name, def = null) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : def;
}
function flag(name) { return process.argv.includes(`--${name}`); }

function isCanceledStatus(s) {
  const v = String(s || '').toLowerCase().trim();
  return v.includes('отмен') || v.includes('cancel');
}

function loadCsvData(filePath) {
  const wb = XLSX.read(fs.readFileSync(filePath), { type: 'buffer', raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('Пустой CSV — нет данных');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!rows.length) throw new Error('Пустая таблица');

  // Диагностика заголовков
  const header = rows[0] || [];
  const headerWarnings = [];
  const norm = (s) => String(s || '').toLowerCase().trim();
  if (!norm(header[COL_BARCODE]).includes('этикет')) {
    headerWarnings.push(`[2] = «${header[COL_BARCODE]}» — ожидалось «Код этикетки»`);
  }
  if (!norm(header[COL_STATUS]).includes('статус')) {
    headerWarnings.push(`[6] = «${header[COL_STATUS]}» — ожидалось «Статус»`);
  }
  if (!norm(header[COL_SKU]).includes('sku')) {
    headerWarnings.push(`[15] = «${header[COL_SKU]}» — ожидалось «SKU»`);
  }
  if (!norm(header[COL_OFFER]).includes('артикул')) {
    headerWarnings.push(`[16] = «${header[COL_OFFER]}» — ожидалось «Артикул»`);
  }

  const map = new Map();
  let totalRows = 0;
  let canceledRows = 0;
  let skippedNotCanceled = 0;
  let skippedEmptyBarcode = 0;
  let duplicates = 0;

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

    if (map.has(barcode)) { duplicates++; continue; }  // тихо пропускаем
    map.set(barcode, {
      barcode,
      offer_id: offerId || null,
      sku: sku || null,
      status,
    });
  }

  return {
    map,
    stats: {
      totalRows,
      canceledRows,
      skippedNotCanceled,
      skippedEmptyBarcode,
      duplicates,
      uniqueBarcodes: map.size,
    },
    headerWarnings,
    headerSample: header,
  };
}

async function main() {
  const csvPath = arg('csv');
  const pdfPath = arg('pdf');
  if (!csvPath || !pdfPath) {
    console.error('Укажите --csv=<path> и --pdf=<path>');
    process.exit(1);
  }
  if (!fs.existsSync(csvPath)) { console.error('CSV не найден:', csvPath); process.exit(1); }
  if (!fs.existsSync(pdfPath)) { console.error('PDF не найден:', pdfPath); process.exit(1); }

  console.log(`[match] csv=${csvPath}`);
  console.log(`[match] pdf=${pdfPath}`);

  // 1. CSV
  console.log('\n[1/3] Читаем CSV...');
  const csv = loadCsvData(csvPath);
  console.log(`      строк данных:        ${csv.stats.totalRows}`);
  console.log(`      со статусом cancelled: ${csv.stats.canceledRows}`);
  console.log(`      пропущено (не отмена): ${csv.stats.skippedNotCanceled}`);
  console.log(`      пропущено (пустой barcode): ${csv.stats.skippedEmptyBarcode}`);
  console.log(`      дубликатов barcode:   ${csv.stats.duplicates}`);
  console.log(`      уникальных barcode:   ${csv.stats.uniqueBarcodes}`);
  if (csv.headerWarnings.length) {
    console.log('      ⚠️  заголовки:');
    for (const w of csv.headerWarnings) console.log(`         • ${w}`);
  }

  // 2. PDF
  console.log('\n[2/3] Парсим PDF...');
  const parsed = await parseReturnsPdf(fs.readFileSync(pdfPath));
  console.log(`      страниц: ${parsed.numPages}, пар: ${parsed.pairs.length}`);
  if (parsed.isLikelyScanned) {
    console.log('      ❌ PDF — скан, распознать невозможно');
    return;
  }
  if (parsed.warnings.length) {
    console.log(`      ⚠️  warnings: ${parsed.warnings.length}`);
    for (const w of parsed.warnings.slice(0, 5)) console.log(`         • ${w}`);
  }

  // 3. Мэтчинг
  console.log('\n[3/3] Мэтчинг cargo_box_id → barcode → offer_id...');
  let matchedWithOffer = 0;
  let matchedNoOffer = 0;
  let barcodeNotInCsv = 0;
  const examples = [];
  const unmatchedNotInCsv = [];
  const unmatchedNoOffer = [];

  for (const p of parsed.pairs) {
    const row = csv.map.get(p.barcode);
    if (!row) {
      barcodeNotInCsv++;
      if (unmatchedNotInCsv.length < 20) unmatchedNotInCsv.push(p);
      continue;
    }
    if (row.offer_id || row.sku) {
      matchedWithOffer++;
      if (examples.length < 20) {
        examples.push({
          cargo_box_id: p.cargo_box_id,
          barcode: p.barcode,
          offer_id: row.offer_id,
          sku: row.sku,
        });
      }
    } else {
      matchedNoOffer++;
      if (unmatchedNoOffer.length < 20) unmatchedNoOffer.push({ ...p, status: row.status });
    }
  }

  const pct = (a, b) => (b === 0 ? '0%' : `${((a / b) * 100).toFixed(1)}%`);

  console.log('\n════════ РЕЗУЛЬТАТ ════════');
  console.log(`Всего пар в PDF:                ${parsed.pairs.length}`);
  console.log(`Резолвится в offer_id/sku:      ${matchedWithOffer}  (${pct(matchedWithOffer, parsed.pairs.length)})`);
  console.log(`Barcode есть, но без offer_id:  ${matchedNoOffer}`);
  console.log(`Barcode нет в CSV:              ${barcodeNotInCsv}`);
  console.log('');

  if (examples.length) {
    console.log('Примеры успешного резолва:');
    for (const e of examples) {
      console.log(`  ${e.cargo_box_id}  →  ${e.offer_id || '—'}  (sku=${e.sku || '—'}, barcode=${e.barcode})`);
    }
  }
  if (unmatchedNotInCsv.length) {
    console.log(`\nПримеры «нет в CSV» (${Math.min(10, unmatchedNotInCsv.length)} из ${barcodeNotInCsv}):`);
    for (const u of unmatchedNotInCsv.slice(0, 10)) {
      console.log(`  ${u.cargo_box_id}  →  barcode=${u.barcode}`);
    }
  }
  if (unmatchedNoOffer.length) {
    console.log(`\nПримеры «есть, но без offer_id» (${Math.min(10, unmatchedNoOffer.length)} из ${matchedNoOffer}):`);
    for (const u of unmatchedNoOffer.slice(0, 10)) {
      console.log(`  ${u.cargo_box_id}  →  barcode=${u.barcode}  (статус=${u.status})`);
    }
  }

  // Сохранение JSON
  if (flag('dump-json')) {
    const outDir = path.resolve(__dirname, '../outputs/match');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(outDir, `${ts}-match.json`);
    fs.writeFileSync(outPath, JSON.stringify({
      csvPath, pdfPath,
      csv: { stats: csv.stats, headerWarnings: csv.headerWarnings, headerSample: csv.headerSample },
      pdf: { numPages: parsed.numPages, pairs: parsed.pairs.length, warnings: parsed.warnings },
      result: { matchedWithOffer, matchedNoOffer, barcodeNotInCsv },
      examples,
      unmatchedNotInCsv,
      unmatchedNoOffer,
    }, null, 2));
    console.log(`\n💾 JSON: ${outPath}`);
  }
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});