// src/services/LozonResolver.js
//
// Единственная задача: lozon_id (label_barcode с этикетки) → cargo_box_id.
// Offer_id/sku здесь НЕ ищем — за это отвечает ReturnsCacheService по
// cargo_box_id из returns-N.db.
//
// Если Ozon вернул ошибку/404/пустой ответ — бросаем/возвращаем null,
// вызывающий (StoredReturnsService.addManual) отказывает пользователю.
const OzonService = require('./OzonService');

class LozonResolver {
  /**
   * @param {string|number} lozonId — label_barcode с возвратной этикетки
   * @param {object} ctx — { storeId }
   * @returns {Promise<{ cargo_box_id: string, box_barcode: string|null, label_barcode: string|null }|null>}
   */
  static async resolveCargoBoxId(lozonId, ctx = {}) {
    const raw = String(lozonId || '').trim();
    if (!raw) return null;
    if (!ctx.storeId) throw new Error('LozonResolver.resolveCargoBoxId: не передан storeId');

    const client = OzonService.getClient(ctx.storeId);

    // Ozon ждёт barcode как число ИЛИ строку — спецификация допускает оба.
    // Отправляем как есть (строка), Ozon сам распарсит.
    const body = { barcode: /^\d+$/.test(raw) ? Number(raw) : raw };

    let res;
    try {
      res = await client.post('/v1/return/box/get-by-barcode', body);
    } catch (err) {
      const status = err.response?.status;
      // 404 / 400 — товар не найден по barcode, это не «сбой», а нормальный
      // сценарий «нет такого возврата». Возвращаем null, вызывающий откажет.
      if (status === 404 || status === 400) return null;
      throw err;
    }

    const data = res.data || {};
    const cargoBoxId = data.cargo_box_id ? String(data.cargo_box_id).trim() : null;
    if (!cargoBoxId) return null;

    return {
      cargo_box_id: cargoBoxId,
      box_barcode: data.box_barcode ? String(data.box_barcode) : null,
      label_barcode: data.label_barcode != null ? String(data.label_barcode) : null,
    };
  }
}

module.exports = LozonResolver;