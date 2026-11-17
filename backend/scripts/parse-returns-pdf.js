// backend/scripts/parse-returns-pdf.js
//
// Исследовательский парсер PDF-акта возвратов.
//
// Запуск:
//   node scripts/parse-returns-pdf.js --file=path/to/act.pdf --dump
//   node scripts/parse-returns-pdf.js --file=path/to/act.pdf
//
// --dump — сначала выгружает «сырую» структуру (строки с Y и текстом),
//          чтобы понять, как реально расположены колонки в вашем PDF.
// Без --dump — сразу парсит и показывает найденные пары.

const fs = require('fs');
const path = require('path');
const { parseReturnsPdf } = require('../src/services/PdfReturnsTableParser');

function arg(name, fallback = null) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }

async function main() {
  const filePath = arg('file');
  if (!filePath) {
    console.error('Укажите --file=path/to/act.pdf');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error('Файл не найден:', filePath);
    process.exit(1);
  }
  const buf = fs.readFileSync(filePath);

  if (flag('dump')) {
    // Рекурсивно достаём items для дампа
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const outDir = path.resolve(__dirname, '../outputs/returns-explore');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const base = path.basename(filePath, '.pdf');
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items = content.items
        .map((it) => {
          const t = it.transform || [1, 0, 0, 1, 0, 0];
          return { str: (it.str || '').trim(), x: t[4], y: t[5] };
        })
        .filter((it) => it.str);
      // Группируем по Y, чтобы вывести человеко-читаемо
      const byY = new Map();
      for (const it of items) {
        const key = Math.round(it.y);
        if (!byY.has(key)) byY.set(key, []);
        byY.get(key).push(it);
      }
      const sortedY = [...byY.keys()].sort((a, b) => b - a);
      lines.push(`\n=== PAGE ${p} (${items.length} items) ===`);
      for (const y of sortedY) {
        const row = byY.get(y).sort((a, b) => a.x - b.x);
        lines.push(`[y=${y}] ` + row.map((r) => `x=${r.x.toFixed(1)}:"${r.str}"`).join('  '));
      }
    }
    const dumpPath = path.join(outDir, `${base}.dump.txt`);
    fs.writeFileSync(dumpPath, lines.join('\n'));
    console.log(`💾 Dump сохранён: ${dumpPath}`);
    console.log(lines.slice(0, 40).join('\n'));
    console.log(`\n(полный дамп — в файле, ${lines.length} строк)`);
    return;
  }

  const result = await parseReturnsPdf(buf);
  console.log(`\n📄 Страниц: ${result.numPages}`);
  console.log(`🎯 Пар: ${result.pairs.length}`);
  if (result.isLikelyScanned) {
    console.log('⚠️  Похоже на сканированный PDF (нет текстового слоя). OCR не поддерживается.');
    return;
  }
  if (result.warnings.length) {
    console.log(`\n⚠️  Предупреждения (${result.warnings.length}):`);
    for (const w of result.warnings.slice(0, 20)) console.log('  •', w);
    if (result.warnings.length > 20) console.log(`  … и ещё ${result.warnings.length - 20}`);
  }
  console.log('\nПервые 20 пар cargo_box_id → barcode:');
  for (const p of result.pairs.slice(0, 20)) {
    console.log(`  ${p.cargo_box_id.padEnd(20)} → ${p.barcode}  (стр. ${p.page})`);
  }

  // Сохраним результат для дальнейшего анализа
  const outDir = path.resolve(__dirname, '../outputs/returns-explore');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(filePath, '.pdf');
  const outPath = path.join(outDir, `${base}.pairs.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n💾 Сохранено: ${outPath}`);
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});