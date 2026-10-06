const { getDB } = require('../config/database');

/**
 * Экранирует спецсимволы LIKE (% _ \), чтобы поиск работал как поиск подстроки
 * (аналогично модели Notification).
 */
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

class Assignment {
  /**
   * Назначить заказ сотруднику (пользователю).
   *
   * UPSERT (а не INSERT OR REPLACE): при повторном назначении того же заказа
   * СОХРАНЯЕМ «замок» earnings_revoked_at. Иначе REPLACE удалил бы строку и
   * обнулил замок — открыв путь ко ВТОРОМУ списанию заработка за тот же заказ
   * (прямое нарушение требования «одна отмена заказа = одно списание»).
   */
  static async assign(orderId, userId) {
    const db = getDB();
    await db.run(
      `INSERT INTO assignments (order_id, user_id, assigned_at, status)
       VALUES (?, ?, ?, 'assigned')
       ON CONFLICT(order_id) DO UPDATE SET
         user_id = excluded.user_id,
         assigned_at = excluded.assigned_at,
         status = excluded.status`,
      orderId, userId, Date.now()
    );
  }

  /**
   * Завершить заказ (обновить статус на 'completed').
   * Опционально сохраняет «слепок» заказа для страницы «Завершённые заказы»:
   *   orderAmount — сумма заказа на момент завершения (из Ozon);
   *   products    — состав заказа [{ offer_id, name, quantity, ... }].
   * offer_ids — уникальные артикулы через пробел (LIKE-поиск по артикулу).
   * Для заказов, завершённых без слепка, колонки остаются NULL.
   */
  static async complete(orderId, { orderAmount = null, products = null } = {}) {
    const db = getDB();
    const list = Array.isArray(products) ? products : null;
    const offerIds = list
      ? Array.from(
          new Set(
            list
              .map((p) => String(p.offer_id || '').trim())
              .filter(Boolean)
          )
        ).join(' ')
      : null;
    const productsJson = list
      ? JSON.stringify(
          list.map((p) => ({
            offer_id: p.offer_id || null,
            name: p.name || null,
            quantity: p.quantity || 1,
          }))
        )
      : null;
    await db.run(
      `UPDATE assignments
       SET status = 'completed', completed_at = ?, order_amount = ?, offer_ids = ?, products_json = ?
       WHERE order_id = ? AND status = 'assigned'`,
      Date.now(),
      orderAmount === undefined ? null : orderAmount,
      offerIds,
      productsJson,
      orderId
    );
  }

  /**
   * АТОМАРНО «забронировать» отмену заработка за заказ (идемпотентность).
   *
   * Обновляет assignments, ТОЛЬКО если заработок по заказу ещё не отменялся
   * (earnings_revoked_at IS NULL). Условие в самом UPDATE + атомарность записи
   * SQLite гарантируют: сколько бы вызовов (два планировщика, повторный прогон,
   * ручной вызов) ни стартовало одновременно — ровно ОДИН получит changes = 1.
   * Это единственная точка «списания», поэтому два списания за один заказ
   * физически невозможны.
   *
   * @param {string} orderId
   * @param {number} userId
   * @param {number} amount - списываемая сумма (для аудита)
   * @param {string|null} reason - причина (для аудита)
   * @returns {Promise<boolean>} true — замок выставлен именно этим вызовом
   */
  static async claimEarningsRevocation(orderId, userId, amount, reason = null) {
    const db = getDB();
    const result = await db.run(
      `UPDATE assignments
       SET earnings_revoked_at = ?, earnings_revoked_amount = ?, earnings_revoke_reason = ?
       WHERE order_id = ? AND user_id = ? AND earnings_revoked_at IS NULL`,
      Date.now(), amount, reason, orderId, userId
    );
    return result.changes === 1;
  }

  /**
   * Отменить заказ (удалить назначение) – для ручной отмены сотрудником
   */
  static async cancel(orderId, userId) {
    const db = getDB();
    // Проверяем, что заказ принадлежит этому пользователю и ещё не завершён
    const assignment = await db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND user_id = ? AND status = "assigned"',
      orderId, userId
    );
    if (!assignment) throw new Error('Order not found or already completed');
    await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);
    // Увеличиваем счётчик отменённых (в UserStats)
    // Это сделаем позже через отдельный метод
  }

  /**
   * Автоматическая отмена (без увеличения счётчика отмен) – используется при очистке
   */
  static async autoCancel(orderId) {
    const db = getDB();
    await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);
  }

  /**
   * Получить активные заказы пользователя.
   * ORDER BY обязателен: порядок строк без него формально не определён, а
   * после восстановления БД из сжатого VACUUM-снимка физическая раскладка
   * страниц может отличаться — сортируем по времени назначения.
   */
  static async getActiveOrders(userId) {
    const db = getDB();
    return db.all(
      'SELECT order_id, assigned_at FROM assignments WHERE user_id = ? AND status = "assigned" ORDER BY assigned_at',
      userId
    );
  }

  /**
   * Получить количество активных заказов пользователя
   */
  static async getActiveOrdersCount(userId) {
    const db = getDB();
    const row = await db.get(
      'SELECT COUNT(*) as count FROM assignments WHERE user_id = ? AND status = "assigned"',
      userId
    );
    return row ? row.count : 0;
  }

  /**
   * Проверить, назначен ли заказ конкретному пользователю
   */
  static async isAssignedToUser(orderId, userId) {
    const db = getDB();
    const row = await db.get(
      'SELECT 1 FROM assignments WHERE order_id = ? AND user_id = ? AND status = "assigned"',
      orderId, userId
    );
    return !!row;
  }

  /**
   * Получить все активные назначения (для админа).
   * ORDER BY обязателен: без сортировки порядок строк зависит от физической
   * раскладки страниц (после восстановления БД из сжатого VACUUM-снимка она
   * может отличаться), а список показывается персоналу.
   */
  static async getAllActive() {
    const db = getDB();
    return db.all(
      `SELECT a.order_id, a.user_id, u.name as user_name, a.assigned_at
       FROM assignments a
       JOIN users u ON a.user_id = u.id
       WHERE a.status = 'assigned'
       ORDER BY a.assigned_at`
    );
  }

  /**
   * Получить назначение по order_id (для проверки)
   */
  static async getByOrderId(orderId) {
    const db = getDB();
    return db.get('SELECT * FROM assignments WHERE order_id = ?', orderId);
  }

  /**
   * Получить завершённые заказы пользователя (для отправки этикеток)
   */
  static async getCompletedOrders(userId) {
    const db = getDB();
    return db.all(
      'SELECT order_id, completed_at FROM assignments WHERE user_id = ? AND status = "completed"',
      userId
    );
  }

  /**
   * Завершённые заказы с фильтрами и пагинацией (страница «Завершённые заказы»).
   * Возвращает заказы от новых к старым: сотрудник, время завершения,
   * сумма заказа (order_amount — слепок при завершении), заработок из
   * earnings_history (LEFT-подзапрос — если заработок не сохранён, amount = 0)
   * и состав заказа (products_json).
   *
   * @param {object} [options]
   * @param {number|null} [options.userId]   — ID сотрудника (null = все сотрудники)
   * @param {number|null} [options.days]     — период: сколько последних дней включать (null = всё время)
   * @param {number|'all'} [options.limit]   — размер страницы или 'all' (полная выгрузка)
   * @param {number} [options.offset]        — смещение (пагинация)
   * @param {string|null} [options.orderId]  — подстрока номера заказа
   * @param {string|null} [options.offerId]  — подстрока артикула (offer_id)
   * @returns {Promise<{items: Array, total: number, hasMore: boolean}>}
   */
  static async getCompletedOrdersPaged({
    userId = null,
    days = null,
    limit = 25,
    offset = 0,
    orderId = null,
    offerId = null,
  } = {}) {
    const db = getDB();

    const where = ["a.status = 'completed'"];
    const params = [];
    if (userId) {
      where.push('a.user_id = ?');
      params.push(userId);
    }
    if (days) {
      where.push('a.completed_at >= ?');
      params.push(Date.now() - days * 24 * 60 * 60 * 1000);
    }
    // Поиск по подстроке номера заказа / артикула
    // (спецсимволы LIKE экранируются — ищем как обычный текст)
    if (orderId) {
      where.push("a.order_id LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(orderId)}%`);
    }
    if (offerId) {
      where.push("a.offer_ids LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(offerId)}%`);
    }
    const whereSql = where.join(' AND ');

    const totalRow = await db.get(
      `SELECT COUNT(*) as count FROM assignments a WHERE ${whereSql}`,
      ...params
    );
    const total = totalRow ? totalRow.count : 0;

    let sql = `
      SELECT a.order_id, a.completed_at, a.user_id, u.name AS user_name,
        a.order_amount, a.offer_ids, a.products_json,
        (SELECT COALESCE(SUM(amount), 0)
         FROM earnings_history eh
         WHERE eh.order_id = a.order_id AND eh.user_id = a.user_id) AS amount
      FROM assignments a
      JOIN users u ON a.user_id = u.id
      WHERE ${whereSql}
      ORDER BY a.completed_at DESC
    `;
    // 'all' — полная выгрузка без LIMIT/OFFSET
    if (limit !== 'all') {
      sql += ' LIMIT ? OFFSET ?';
      params.push(limit, offset);
    }
    const rows = await db.all(sql, ...params);

    const items = rows.map((row) => {
      let products = null;
      if (row.products_json) {
        try {
          products = JSON.parse(row.products_json);
        } catch {
          products = null;
        }
      }
      return {
        order_id: row.order_id,
        completed_at: row.completed_at,
        user_id: row.user_id,
        user_name: row.user_name,
        // Сумма заказа: null — заказ завершён до внедрения слепка
        order_amount:
          row.order_amount === null || row.order_amount === undefined
            ? null
            : Number(row.order_amount),
        // Заработок за заказ (0 — если не рассчитан/не сохранён)
        amount: Number(row.amount) || 0,
        offer_ids: row.offer_ids || null,
        products,
      };
    });

    return {
      items,
      total,
      hasMore: limit === 'all' ? false : offset + items.length < total,
    };
  }
}

module.exports = Assignment;