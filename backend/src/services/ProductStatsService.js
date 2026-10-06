const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const ProductStat = require('../models/ProductStat');
const { formatDateDDMMYYYY, getVersionedFileName } = require('../utils');

/**
 * Сервис экспорта статистики товаров (материал/цвет/вес) в Excel.
 * Аналог exportProductStats из Telegram-бота.
 */
class ProductStatsService {
  /**
   * Экспортирует всю статистику товаров в Excel.
   * @returns {Promise<string>} - путь к созданному файлу
   */
  static async exportProductStatsXlsx() {
    const stats = await ProductStat.getAll();
    if (!stats.length) {
      throw new Error('Нет данных о статистике товаров.');
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Статистика');

    // Заголовки (как в бот-версии)
    const headers = ['Артикул', 'Материал', 'Цвет', 'Вес (г)', 'Кто заполнил', 'Дата'];
    const headerRow = worksheet.addRow(headers);
    headerRow.eachCell((cell) => {
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { bold: true };
    });

    // Данные
    for (const s of stats) {
      const rowData = [
        s.offer_id,
        s.material,
        s.color,
        s.weight_grams,
        s.user_name || 'Неизвестно',
        formatDateDDMMYYYY(s.updated_at),
      ];
      const row = worksheet.addRow(rowData);
      row.eachCell((cell) => {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
    }

    // Ширина столбцов
    const columnWidths = [20, 20, 20, 15, 40, 20];
    worksheet.columns.forEach((col, index) => {
      col.width = columnWidths[index] || 20;
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const outputDir = path.join(__dirname, '../../outputs');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    // product-stats-1.xlsx | product-stats.xlsx (как в бот-версии)
    const outputPath = path.join(outputDir, getVersionedFileName('product-stats', 'xlsx'));
    fs.writeFileSync(outputPath, buffer);
    console.log(`[ProductStatsService] Экспорт статистики товаров сохранён: ${outputPath}`);
    return outputPath;
  }
}

module.exports = ProductStatsService;