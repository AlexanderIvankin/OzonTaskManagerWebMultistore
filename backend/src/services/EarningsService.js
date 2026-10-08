const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const NotificationService = require('./NotificationService');
const { Earnings, User, Assignment } = require('../models');
const ProductStat = require('../models/ProductStat');
const MaterialsService = require('./MaterialsService');
const { getLocalDate, getVersionedDatedFileName } = require('../utils');

/**
 * Сервис заработка: расчёт, экспорт, корректировки.
 * Все методы — store-scoped (storeId первым аргументом).
 */
class EarningsService {
  /**
   * Рассчитать заработок по заказу В МАГАЗИНЕ.
   * @param {string|number} storeId
   * @param {object} orderDetails
   * @param {object} user — { earnings_factor } (из user_stores магазина)
   */
  static async calculateOrderEarnings(storeId, orderDetails, user) {
    const { products } = orderDetails;
    const earningsDetails = [];
    let totalEarnings = 0;
    let allHaveStats = true;
    const factor = user.earnings_factor || 1.0;
    const materials = MaterialsService.getMaterials(storeId);
    const MIN_EARNINGS = MaterialsService.getMinEarnings(storeId);

    for (const product of products) {
      const offerId = product.offer_id;
      if (!offerId) continue;

      // Специальное предложение (глобальные materials — общие для всех магазинов)
      const specialPrice = MaterialsService.getSpecialOffer(storeId, offerId);
      if (specialPrice !== null) {
        const earningsPerUnit = specialPrice * factor;
        const quantity = product.quantity || 1;
        totalEarnings += earningsPerUnit * quantity;
        earningsDetails.push({
          offerId,
          productName: product.name,
          material: 'Спецпредложение',
          weight: 0,
          quantity,
          earningsPerUnit,
          totalForProduct: earningsPerUnit * quantity,
          isSpecial: true,
        });
        continue;
      }

      // Обычный расчёт (product_stats лежит в store-N.db)
      const stats = await ProductStat.get(storeId, offerId);
      if (!stats) {
        allHaveStats = false;
        console.warn(`[Earnings][store ${storeId}] Для товара ${offerId} нет статистики, пропускаем`);
        continue;
      }

      const materialPrice = materials[stats.material] || 0;
      const weight = stats.weight_grams || 0;
      let earningsPerUnit = materialPrice * weight;
      if (earningsPerUnit < MIN_EARNINGS) earningsPerUnit = MIN_EARNINGS;
      earningsPerUnit = earningsPerUnit * factor;

      const quantity = product.quantity || 1;
      const totalForProduct = earningsPerUnit * quantity;
      totalEarnings += totalForProduct;

      earningsDetails.push({
        offerId,
        productName: product.name,
        material: stats.material,
        weight,
        quantity,
        earningsPerUnit,
        totalForProduct,
        isSpecial: false,
      });
    }

    return { total: totalEarnings, details: earningsDetails, allHaveStats };
  }

  /**
   * Экспорт заработка за месяц в Excel (для конкретного магазина).
   * Файл: outputs/store-<id>_monthly_earnings_<YYYY-MM>.xlsx
   * @param {string|number} storeId
   * @param {string|null} monthStr — YYYY-MM (null = текущий месяц)
   * @returns {Promise<string>} путь к файлу
   */
  static async exportMonthlyEarnings(storeId, monthStr = null) {
    let fromDate, toDate, monthLabel;
    if (monthStr) {
      if (!/^\d{4}-\d{2}$/.test(monthStr)) {
        throw new Error('Неверный формат. Используйте YYYY-MM');
      }
      monthLabel = monthStr;
      const [year, month] = monthStr.split('-').map(Number);
      fromDate = new Date(year, month - 1, 1).getTime();
      toDate = new Date(year, month, 1).getTime() - 1;
    } else {
      const now = getLocalDate();
      const year = now.getFullYear();
      const month = now.getMonth();
      monthLabel = `${year}-${String(month + 1).padStart(2, '0')}`;
      fromDate = new Date(year, month, 1).getTime();
      toDate = new Date(year, month + 1, 1).getTime() - 1;
    }

    // История из БД магазина (JOIN с usersdb.users для имени)
    const earningsData = await Earnings.getAllHistoryForPeriod(storeId, fromDate, toDate);
    if (!earningsData.length) {
      throw new Error('Нет данных о заработке за указанный период.');
    }

    const userMap = new Map();
    for (const row of earningsData) {
      const userId = row.id;
      if (!userMap.has(userId)) {
        userMap.set(userId, {
          name: row.name,
          totalAmount: 0,
          orderCount: 0,
        });
      }
      const user = userMap.get(userId);
      user.totalAmount += row.amount;
      user.orderCount += 1;
    }

    const rows = [];
    for (const [userId, user] of userMap) {
      rows.push({
        'ID сотрудника': userId,
        'Сотрудник': user.name,
        'Количество заказов': user.orderCount,
        'Средний чек': (user.orderCount > 0 ? (user.totalAmount / user.orderCount).toFixed(2) : 0),
        'Заработок': user.totalAmount.toFixed(2),
      });
    }
    rows.sort((a, b) => parseFloat(b['Заработок']) - parseFloat(a['Заработок']));

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Заработок (месяц)');
    const headers = ['ID сотрудника', 'Сотрудник', 'Количество заказов', 'Средний чек', 'Заработок'];
    const headerRow = worksheet.addRow(headers);
    headerRow.eachCell(cell => {
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { bold: true };
    });
    for (const rowData of rows) {
      const row = worksheet.addRow(Object.values(rowData));
      row.eachCell(cell => {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
    }
    const columnWidths = [15, 40, 25, 15, 20];
    worksheet.columns.forEach((col, index) => {
      col.width = columnWidths[index] || 20;
    });

    const buffer = await workbook.xlsx.writeBuffer();

    // Файл per-store: сохраняем в outputs/store-<id>/ и в имени тоже store
    const outputDir = path.join(__dirname, '../../outputs', `store-${storeId}`);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    // store-1_monthly_earnings_2026-09.xlsx
    const fileName = getVersionedDatedFileName('monthly_earnings', 'xlsx', monthLabel, storeId);
    const outputPath = path.join(outputDir, fileName);
    fs.writeFileSync(outputPath, buffer);
    console.log(`[EarningsService][store ${storeId}] Файл сохранён: ${outputPath}`);
    return outputPath;
  }

  /**
   * Добавить корректировку и оповестить сотрудника + журнал персонала.
   */
  static async addAdjustment(storeId, userId, amount, reason = '', adminName = null) {
    await Earnings.addAdjustment(storeId, userId, amount, reason);
    await Earnings.addActiveAdjustment(storeId, userId, amount, reason);

    const user = await User.getById(userId).catch(() => null);
    const userName = user?.name || null;
    const payload = { amount, reason, adminName, userName };

    NotificationService.notifyUser(userId, 'earnings_adjusted', payload, { storeId });
    NotificationService.notifyStaff('earnings_adjusted', payload, { storeId });
  }

  /**
   * Произвести расчёт с сотрудником (обнуляет активный заработок и
   * активные корректировки) и оповестить его.
   */
  static async settleEmployee(storeId, userId, adminName = null) {
    const baseActive = await Earnings.getActiveSum(storeId, userId, 0, Date.now());
    const adjustmentsActive = await Earnings.getActiveAdjustmentsSum(storeId, userId, 0, Date.now());
    const totalActive = baseActive + adjustmentsActive;

    await Earnings.clearActive(storeId, userId);
    await Earnings.clearActiveAdjustments(storeId, userId);

    const user = await User.getById(userId).catch(() => null);
    const userName = user?.name || null;

    if (totalActive > 0) {
      const payload = { amount: totalActive, adminName, userName };
      NotificationService.notifyUser(userId, 'earnings_settled', payload, { storeId });
      NotificationService.notifyStaff('earnings_settled', payload, { storeId });
    } else {
      NotificationService.notifyUser(
        userId,
        'earnings_settled_zero',
        { adminName, userName },
        { storeId, persist: false }
      );
    }

    return { clearedAmount: totalActive, userName };
  }

  /**
   * Отмена (сторнирование) заработка за заказ в магазине.
   * Идемпотентность — атомарный замок assignments.earnings_revoked_at
   * (Assignment.claimEarningsRevocation(storeId, ...)).
   */
  static async revokeOrderEarnings(storeId, userId, orderId, {
    reason = '',
    notificationType = null,
    userName = null,
    daysPassed = null,
    source = 'manual',
  } = {}) {
    if (!userId || !orderId) return { revoked: false, reason: 'invalid' };

    const amountRaw = await Earnings.getOrderEarningsSum(storeId, userId, orderId);
    const amount = Math.round((Number(amountRaw) || 0) * 100) / 100;

    const claimed = await Assignment.claimEarningsRevocation(storeId, orderId, userId, amount, reason);
    if (!claimed) {
      return { revoked: false, reason: 'already_revoked' };
    }

    if (amount > 0) {
      await Earnings.addAdjustment(storeId, userId, -amount, reason);
      await Earnings.addActiveAdjustment(storeId, userId, -amount, reason);
    }

    if (amount > 0 && notificationType) {
      const user = userName ? null : await User.getById(userId).catch(() => null);
      const name = userName || user?.name || null;
      const payload = { orderId, userId, userName: name, amount, reason, daysPassed, source };
      await NotificationService.notifyUser(userId, notificationType, payload, { storeId });
      await NotificationService.notifyStaff(notificationType, payload, { storeId });
    }

    return { revoked: true, amount };
  }
}

module.exports = EarningsService;