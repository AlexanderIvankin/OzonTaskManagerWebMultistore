// src/services/ReturnsPdfService.js
//
// Шаг 2 пайплайна: модератор загружает пачку PDF-актов «Приём-передача».
// Сервис парсит каждый PDF, извлекает пары { cargo_box_id, barcode }
// и применяет к returns-N.db через ReturnsCacheService.

const { parseReturnsPdf } = require('./PdfReturnsTableParser');
const ReturnsCacheService = require('./ReturnsCacheService');

class ReturnsPdfService {
  /**
   * Один PDF → парсинг → применение.
   * @returns {Promise<object>} per-file summary
   */
  static async processOne(storeId, buffer, fileName) {
    const startedAt = Date.now();
    let parseResult;
    try {
      parseResult = await parseReturnsPdf(buffer);
    } catch (err) {
      return {
        fileName,
        ok: false,
        error: `Не удалось распарсить PDF: ${err.message}`,
        pairs: 0,
        updated: 0,
        notFound: 0,
        alreadySet: 0,
        conflicts: 0,
        warnings: [],
        isLikelyScanned: false,
        durationMs: Date.now() - startedAt,
      };
    }

    if (parseResult.isLikelyScanned) {
      return {
        fileName,
        ok: false,
        error: 'PDF без текстового слоя (скан) — распознавание невозможно',
        pairs: 0,
        updated: 0,
        notFound: 0,
        alreadySet: 0,
        conflicts: 0,
        warnings: parseResult.warnings,
        isLikelyScanned: true,
        numPages: parseResult.numPages,
        durationMs: Date.now() - startedAt,
      };
    }

    let apply = { updated: 0, alreadySet: 0, notFound: 0, conflicts: 0 };
    let applyError = null;
    if (parseResult.pairs.length) {
      try {
        apply = await ReturnsCacheService.applyCargoBoxIdBatch(storeId, parseResult.pairs);
      } catch (err) {
        applyError = err.message;
      }
    }

    return {
      fileName,
      ok: !applyError,
      error: applyError,
      pairs: parseResult.pairs.length,
      updated: apply.updated,
      alreadySet: apply.alreadySet,
      notFound: apply.notFound,
      conflicts: apply.conflicts,
      warnings: parseResult.warnings,
      isLikelyScanned: false,
      numPages: parseResult.numPages,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Пачка PDF (до 10). Один битый не валит остальные.
   */
  static async processBatch(storeId, files) {
    const startedAt = Date.now();
    const items = [];
    let totalPairs = 0;
    let totalUpdated = 0;
    let totalNotFound = 0;
    let okCount = 0;
    let failCount = 0;

    for (const file of files || []) {
      const summary = await this.processOne(
        storeId,
        file.buffer,
        file.originalName || 'file.pdf'
      );
      items.push(summary);
      totalPairs += summary.pairs || 0;
      totalUpdated += summary.updated || 0;
      totalNotFound += summary.notFound || 0;
      if (summary.ok) okCount++; else failCount++;
    }

    return {
      total: items.length,
      okCount,
      failCount,
      totalPairs,
      totalUpdated,
      totalNotFound,
      durationMs: Date.now() - startedAt,
      items,
    };
  }
}

module.exports = ReturnsPdfService;