const { getUsersDB } = require('../config/database');
const Notification = require('../models/Notification');
const PushService = require('./PushService');
const {
  notifyUser,
  notifyUsers,
  notifyModerators,
  isUserOnline,
} = require('../socket');
const { STAFF_ROLES } = require('../config/staffRoles');

// ============================================================================
// Мультистор-модель доставки:
//   • storeId обязателен для любой адресной доставки (Socket.IO / Web Push);
//     если его нет — запись пишется в notifications.db с store_id = NULL,
//     но «живьём» никому не уходит (это системные события уровня приложения:
//     ошибки initDB, ошибки express без определённого магазина и т.п.);
//   • получатели notifyStaff ищутся в user_stores по store_id — у каждого
//     магазина свой персонал;
//   • live-доставка адресуется комнате store_<id>:... (см. socket.js).
// ============================================================================

// ============================================================================
// Шаблоны текстов оповещений (без изменений).
// ============================================================================
const TEMPLATES = {
  order_assigned: (p) => {
    const productsCount = p.details?.products?.length || 0;
    const missing =
      Array.isArray(p.missingStats) && p.missingStats.length
        ? `Требуется заполнить статистику: ${p.missingStats.join(', ')}.`
        : '';
    const assignedBy = p.adminName ? `Назначил: ${p.adminName}.` : '';
    return {
      user: {
        title: `📦 Заказ ${p.orderId} назначен вам`,
        message: `Вам назначен заказ ${p.orderId}.\nТоваров: ${productsCount}.\n${missing}`,
      },
      staff: {
        title: `📦 ${p.userName}: назначен заказ ${p.orderId}`,
        message: `Заказ ${p.orderId} назначен сотруднику ${p.userName}.\nТоваров: ${productsCount}.\n${missing}\n${assignedBy}`,
      },
    };
  },

  order_finished: (p) => {
    const earningsStr =
      p.earnings !== null && p.earnings !== undefined
        ? `Заработок: ${p.earnings} руб.`
        : '';
    return {
      user: {
        title: `✅ Заказ ${p.orderId} завершён`,
        message: p.labelAvailable
          ? `Заказ ${p.orderId} завершён. Этикетка доступна для скачивания.\n${earningsStr}`
          : `Заказ ${p.orderId} завершён.\n${earningsStr}`,
      },
      staff: {
        title: `✅ ${p.userName}: завершил заказ ${p.orderId}`,
        message: `Сотрудник ${p.userName} завершил заказ ${p.orderId}.\n${earningsStr}`,
      },
    };
  },

  order_cancelled: (p) => ({
    user: {
      title: `❌ Вы отменили заказ ${p.orderId}`,
      message: `Заказ ${p.orderId} отменён и возвращён в очередь.`,
    },
    staff: {
      title: `❌ ${p.userName}: отменил заказ ${p.orderId}`,
      message: `Сотрудник ${p.userName} отменил заказ ${p.orderId} (возвращён в очередь).`,
    },
  }),

  order_unassigned: (p) => {
    if (p.auto) {
      return {
        user: {
          title: `↩️ Заказ ${p.orderId} снят автоматически`,
          message: `Заказ ${p.orderId} снят с вас автоматически.\nПричина: ${p.reason || 'не указана'}.`,
        },
        staff: {
          title: `↩️ ${p.userName}: заказ ${p.orderId} снят автоматически`,
          message: `Заказ ${p.orderId} автоматически снят с ${p.userName}.\nПричина: ${p.reason || 'не указана'}.`,
        },
      };
    }
    return {
      user: {
        title: `↩️ Заказ ${p.orderId} снят администратором`,
        message: `Заказ ${p.orderId} снят с вас администратором.`,
      },
      staff: {
        title: `↩️ ${p.userName}: снят заказ ${p.orderId}`,
        message: `Заказ ${p.orderId} снят с сотрудника ${p.userName}.\nПричина: ${p.reason || 'не указана'}.${p.adminName ? `\nАдминистратор: ${p.adminName}.` : ''}`,
      },
    };
  },

  earnings_adjusted: (p) => ({
    user: {
      title: `💰 Корректировка заработка: ${p.amount > 0 ? '+' : ''}${p.amount} руб.`,
      message: `Ваш заработок скорректирован на ${p.amount > 0 ? '+' : ''}${p.amount} руб.${p.adminName ? `\nАдминистратор: ${p.adminName}.` : ''}${p.reason ? `\nПричина: ${p.reason}` : ''}`,
    },
    staff: {
      title: `💰 Корректировка заработка: ${p.amount > 0 ? '+' : ''}${p.amount} руб.`,
      message: `Заработок сотрудника ${p.userName} скорректирован на ${p.amount > 0 ? '+' : ''}${p.amount} руб.${p.reason ? `\nПричина: ${p.reason}` : ''}${p.adminName ? `\nАдминистратор: ${p.adminName}.` : ''}`,
    },
  }),

  earnings_settled: (p) => ({
    user: {
      title: `🏦 Произведён расчёт заработка`,
      message: `Активный заработок обнулён.\nВыплачено: ${Number(p.amount || 0).toFixed(2)} руб.${p.adminName ? `\nРасчёт произвёл: ${p.adminName}.` : ''}`,
    },
    staff: {
      title: `🏦 Произведён расчёт заработка`,
      message: `Активный заработок сотрудника ${p.userName} обнулён.\nВыплачено: ${Number(p.amount || 0).toFixed(2)} руб.${p.adminName ? `\nРасчёт произвёл: ${p.adminName}.` : ''}`,
    },
  }),

  earnings_settled_zero: (p) => ({
    user: {
      title: `🏦 Расчёт заработка`,
      message: `Активный заработок пуст (0 руб.) — рассчитывать нечего.${p.adminName ? `\nЗапросил: ${p.adminName}.` : ''}`,
    },
    staff: null,
  }),

  stats_filled: (p) => ({
    user: null,
    staff: {
      title: `📝 ${p.userName}: заполнил статистику ${p.offerId}`,
      message: `Сотрудник ${p.userName} заполнил статистику для ${p.offerId}: \nМатериал — ${p.material}\nЦвет — ${p.color}\nВес — ${p.weight} г.`,
    },
  }),

  taking_orders_changed: (p) => ({
    user: null,
    staff: {
      title: `🔄 ${p.userName}: ${p.takingOrders ? 'включил' : 'выключил'} приём заказов`,
      message: `Сотрудник ${p.userName} ${p.takingOrders ? 'снова принимает' : 'перестал принимать'} заказы.`,
    },
  }),

  new_orders_available: (p) => ({
    user: null,
    staff: {
      title: `🆕 Новые заказы в очереди: ${p.count}`,
      message: `В очереди появилось ${p.count} новых заказов, ожидающих назначения.`,
    },
  }),

  order_assign_error: (p) => ({
    user: null,
    staff: {
      title: `⚠️ Ошибка при назначении заказа ${p.orderId}`,
      message: `Не удалось завершить назначение заказа ${p.orderId}${p.userName ? ` (${p.userName})` : ''}: ${p.error || 'неизвестная ошибка'}.`,
    },
  }),

  order_assign_failed: (p) => ({
    user: null,
    staff: {
      title: `🚨 Заказ ${p.orderId} не удалось назначить`,
      message: `После ${p.attempts || 3} попыток заказ ${p.orderId} не назначен: ${p.error || 'неизвестная ошибка'}.`,
    },
  }),

  label_sent: (p) => ({
    user: {
      title: `🏷️ Этикетка заказа ${p.orderId}`,
      message: `${p.adminName || 'Администратор'} отправил вам этикетку заказа ${p.orderId}.\nНажмите «Скачать этикетку», чтобы сохранить PDF.`,
    },
    staff: {
      title: `🏷️ ${p.adminName || 'Администратор'}: отправил этикетку ${p.orderId}`,
      message: `${p.adminName || 'Администратор'} отправил этикетку заказа ${p.orderId} сотруднику ${p.userName || '—'}.`,
    },
  }),

  deliver_reminder: (p) => {
    const products = Array.isArray(p.details?.products) ? p.details.products : [];
    const shown = products.slice(0, 3);
    const more = products.length - shown.length;
    const productsLine = products.length
      ? `\nТовары: ${shown
        .map((pr) => `${pr.name || '—'}${pr.offer_id ? ` (${pr.offer_id})` : ''} — ${pr.quantity || 1} шт.`)
        .join('; ')}${more > 0 ? ` … и ещё ${more}` : ''}.`
      : '';
    const earningsLine =
      p.amount != null ? `\n💰 Заработок по заказу: ${p.amount} руб.` : '';
    const repeatedLine =
      p.reminderCount > 0 ? `\n🔔 Ранее вам уже напоминали: ${p.reminderCount} раз(а).` : '';
    const isFinalWarning = !!p.isFinalWarning;
    const userWarningLine = isFinalWarning
      ? `\n🚨 ПРЕДУПРЕЖДЕНИЕ: завтра заказ будет снят автоматически, а заработок за заказ обнулён сторнирующей корректировкой. Срочно отправьте заказ!`
      : `\n⚠️ Пожалуйста, отправьте заказ как можно скорее, иначе заработок может быть отменён.`;
    const staffWarningLine = isFinalWarning
      ? `\n🚨 Последнее напоминание: следующий суточный прогон обнулит заработок сотрудника.`
      : '';

    return {
      user: {
        title: isFinalWarning
          ? `🚨 Заказ ${p.orderId}: завтра заработок будет обнулён`
          : `⏰ Заказ ${p.orderId} не отправлен`,
        message:
          `Заказ ${p.orderId} был завершён ${p.daysPassed} дн. назад, но всё ещё находится в статусе «ожидает отправки».` +
          repeatedLine +
          earningsLine +
          productsLine +
          userWarningLine,
      },
      staff: {
        title: `${isFinalWarning ? '🚨' : '⏰'} ${p.userName || 'Сотрудник'}: заказ ${p.orderId} не отправлен`,
        message:
          `Сотрудник ${p.userName || 'Неизвестно'} завершил заказ ${p.orderId} ${p.daysPassed} дн. назад, но заказ всё ещё в статусе «ожидает отправки».` +
          `\n🔔 Напоминаний отправлено: ${(p.reminderCount || 0) + 1}.` +
          earningsLine +
          productsLine +
          staffWarningLine,
      },
    };
  },

  deliver_reminder_summary: (p) => ({
    user: null,
    staff: {
      title: `📋 Проверка «ожидает отправки» завершена`,
      message:
        `Найдено проблемных заказов: ${p.found ?? 0}.\n` +
        `Напоминаний отправлено сотрудникам: ${p.sent ?? 0}.\n` +
        `Заработок обнулён по заказам: ${p.revoked ?? 0}.`,
    },
  }),

  order_cancelled_earnings_revoked: (p) => {
    const products = Array.isArray(p.details?.products) ? p.details.products : [];
    const shown = products.slice(0, 3);
    const more = products.length - shown.length;
    const productsLine = products.length
      ? `\nТовары: ${shown
        .map((pr) => `${pr.name || '—'}${pr.offer_id ? ` (${pr.offer_id})` : ''} — ${pr.quantity || 1} шт.`)
        .join('; ')}${more > 0 ? ` … и ещё ${more}` : ''}.`
      : '';
    const amountLine = p.amount != null ? `${p.amount} руб.` : '—';
    return {
      user: {
        title: `💸 Заказ ${p.orderId} отменён: заработок списан`,
        message:
          `Заказ ${p.orderId} был завершён вами, но так и не был отправлен.\n` +
          `Ozon перевёл заказ в статус «Отменён», поэтому заработок за заказ ${amountLine} был отменён ` +
          `(сторнирующая корректировка учтётся при следующем расчёте).` +
          productsLine,
      },
      staff: {
        title: `💸 ${p.userName || 'Сотрудник'}: заказ ${p.orderId} отменён, заработок списан`,
        message:
          `Заказ ${p.orderId} сотрудника ${p.userName || '—'} был завершён, но не отправлен. ` +
          `Ozon перевёл заказ в статус «Отменён» — заработок ${amountLine} отменён сторнирующей корректировкой.` +
          productsLine,
      },
    };
  },

  deliver_earnings_revoked: (p) => {
    const daysLine = p.daysPassed != null ? ` ${p.daysPassed} дн.` : '';
    const amountLine = p.amount != null ? `${p.amount} руб.` : '—';
    return {
      user: {
        title: `💸 Заработок за заказ ${p.orderId} обнулён`,
        message:
          `Заказ ${p.orderId} был завершён${daysLine} назад, но так и не был отправлен.\n` +
          `Поэтому заработок за заказ ${amountLine} был обнулён сторнирующей корректировкой ` +
          `(учтётся при следующем расчёте).`,
      },
      staff: {
        title: `💸 ${p.userName || 'Сотрудник'}: заработок за ${p.orderId} обнулён`,
        message:
          `Сотрудник ${p.userName || 'Неизвестно'} не отправил заказ ${p.orderId}${daysLine} — ` +
          `заработок ${amountLine} обнулён сторнирующей корректировкой автоматически.`,
      },
    };
  },

  cancelled_orders_summary: (p) => ({
    user: null,
    staff: {
      title: `📋 Проверка отменённых заказов завершена`,
      message:
        `Проверка отменённых Ozon заказов за ${p.windowHours ?? '—'} ч завершена.\n` +
        `Найдено завершённых заказов с отменой: ${p.found ?? 0}.\n` +
        `Сторнировано заработка: ${p.revoked ?? 0}.`,
    },
  }),

  monthly_export_done: (p) => ({
    user: null,
    staff: {
      title: `📊 Экспорт заработка за ${p.month} выполнен`,
      message: `Автоматический экспорт заработка за ${p.month} выполнен.\nФайл: ${p.file || '—'}.`,
    },
  }),

  // === 3D-модели (zip в S3) ===

  models_available: (p) => {
    const offers = Array.isArray(p.offerIds) ? p.offerIds.join(', ') : '';
    const missing = Array.isArray(p.missingOffers) && p.missingOffers.length
      ? `\n⚠️ Без моделей остались: ${p.missingOffers.join(', ')} — обратитесь к модератору.`
      : '';
    const hasParents = Array.isArray(p.parentOffers) && p.parentOffers.length;
    const parentNote = hasParents
      ? `\nℹ️ Часть моделей выдана по родительскому артикулу: ${p.parentOffers
        .map((x) => `${x.offerId} ← ${x.parentOfferId}`)
        .join(', ')}.`
      : '';
    return {
      user: {
        title: `📁 3D-модели для заказа ${p.orderId} доступны`,
        message: `Доступны 3D-модели для заказа ${p.orderId}:\n${offers}.${parentNote}${missing}\nСкачайте их в карточке заказа («Мои заказы»).`,
      },
      staff: {
        title: `📁 ${p.userName}: выданы 3D-модели (заказ ${p.orderId})`,
        message: `Сотруднику ${p.userName} выданы 3D-модели по заказу ${p.orderId}: ${offers}.${parentNote}`,
      },
    };
  },

  models_parent_used: (p) => {
    const pairs = Array.isArray(p.parentOffers)
      ? p.parentOffers
        .map((x) => `${x.offerId} ← ${x.parentOfferId} (${x.fileName || `${x.parentOfferId}.zip`})`)
        .join('\n')
      : '';
    const orderPart = p.orderId ? ` (заказ ${p.orderId}${p.userName ? `, ${p.userName}` : ''})` : '';
    return {
      user: null,
      staff: {
        title: `ℹ️ Модели выданы по родительскому артикулу${orderPart}`,
        message:
          `Для артикулов не нашлось моделей по прямому offer_id — выданы модели родителя:\n${pairs}\n` +
          `Если для этих артикулов нужны свои модели — загрузите их в разделе «Модели».`,
      },
    };
  },

  models_missing: (p) => {
    const offers = Array.isArray(p.offerIds) ? p.offerIds.join(', ') : '';
    return {
      user: {
        title: `ℹ️ Нет 3D-моделей для заказа ${p.orderId}`,
        message: `Для товаров заказа ${p.orderId} (${offers}) нет 3D-моделей.\nОбратитесь к модератору.`,
      },
      staff: {
        title: `⚠️ ${p.userName}: нет 3D-моделей (заказ ${p.orderId})`,
        message: `Для заказа ${p.orderId} (${p.userName}) отсутствуют 3D-модели: ${offers}.\nЗагрузите их в разделе «Модели» или передайте сотруднику вручную.`,
      },
    };
  },

  model_uploaded: (p) => {
    const models =
      Array.isArray(p.modelFiles) && p.modelFiles.length
        ? `\nФайлы-модели: ${p.modelFiles.join(', ')}.`
        : '\n⚠️ В архиве не найдено файлов-моделей (допустимо для фото/текстовых архивов).';
    return {
      user: null,
      staff: {
        title: `📤 Модель ${p.offerId} загружена`,
        message: `Модель ${p.fileName || p.offerId + '.zip'} для ${p.offerId} загружена (${p.filesCount || 0} файл(ов) в архиве).${models}${p.adminName ? `\nЗагрузил: ${p.adminName}.` : ''}`,
      },
    };
  },

  model_updated: (p) => ({
    user: {
      title: `🔄 Модель ${p.offerId} обновлена`,
      message:
        `3D-модель для ${p.offerId} обновлена (${p.fileName}).` +
        (p.source === 'storage'
          ? '\nФайл в хранилище (S3) заменён — уже скачанная вами копия может быть прежней версии.'
          : '') +
        '\nСкачайте актуальную версию в карточке заказа.',
    },
    staff: null,
  }),

  model_deleted: (p) => ({
    user: null,
    staff: {
      title: `🗑 Модель ${p.offerId} удалена`,
      message: `3D-модель для ${p.offerId} удалена из хранилища.${p.adminName ? `\nУдалил: ${p.adminName}.` : ''}`,
    },
  }),

  model_upload_rejected: (p) => ({
    user: {
      title: `⛔ Модель${p.offerId ? ` ${p.offerId}` : ''} не загружена`,
      message:
        `Загрузка отклонена: ${p.error || 'файл не является zip-архивом'}.\n` +
        `Модель на артикул — всегда ОДИН zip-архив: назовите файл «{offer_id}.zip» (например, ARD000001-N.zip).`,
    },
    staff: null,
  }),

  command_cooldown: (p) => ({
    user: {
      title: `⏳ ${p.command || 'Команда'} — кулдаун`,
      message: p.message || `Повторите через ${p.retryAfterSec} сек.`,
    },
    staff: null,
  }),

  sync_data_invalid: (p) => {
    const FIELD_LABELS = {
      email: 'E-mail',
      tg_user_id: 'Telegram ID',
      phone: 'телефон',
      capacity: 'число принтеров',
      earnings_factor: 'коэффициент заработка',
      identifiers: 'E-mail/Telegram ID',
    };
    const problems = Array.isArray(p.problems) ? p.problems : [];
    const shown = problems.slice(0, 10);
    const lines = shown
      .map((pr) => {
        const label = FIELD_LABELS[pr.field] || pr.field || 'поле';
        const raw =
          pr.raw != null && String(pr.raw).trim() !== '' ? ` «${String(pr.raw).trim()}»` : '';
        return `• ${pr.name || '(без имени)'}: ${label}${raw} — ${pr.note || 'не распознано'}`;
      })
      .join('\n');
    const hidden = problems.length - shown.length;
    const moreLine = hidden > 0 ? `\n… и ещё ${hidden} — подробнее в логе сервера.` : '';
    return {
      user: null,
      staff: {
        title: `⚠️ Синхронизация: проблемные данные в ${p.fileName || 'team-info.xlsx'}`,
        message:
          `При синхронизации из ${p.fileName || 'team-info.xlsx'} найдено проблемных значений: ${problems.length}.\n` +
          `Некорректные значения заменены на дефолты (телефон/Telegram ID — очищены, число принтеров — 1, ` +
          `коэффициент — 1.0), строки без корректных идентификаторов пропущены.\n` +
          `Исправьте файл и повторите синхронизацию:\n${lines}${moreLine}` +
          (p.adminName ? `\nСинхронизацию запустил: ${p.adminName}.` : ''),
      },
    };
  },

  password_reset_success: (p) => ({
    user: {
      title: `🔑 Пароль успешно изменён`,
      message: `Пароль вашей учетной записи был успешно обновлен. Если это были не вы, немедленно обратитесь к администратору.`,
    },
    staff: {
      title: `🔑 Сброс пароля: ${p.userName || p.email}`,
      message: `Пользователь ${p.userName || '—'} (${p.email || '—'}) успешно сбросил пароль через подтверждение по почте.`,
    },
  }),
};

/**
 * Поля для быстрого поиска (order_id/user_name/offer_ids) — без изменений.
 */
function extractSearchFields(payload) {
  let offerIds = [];
  if (Array.isArray(payload?.offerIds)) {
    offerIds = payload.offerIds;
  } else if (Array.isArray(payload?.details?.products)) {
    offerIds = payload.details.products.map((p) => p.offer_id).filter(Boolean);
  } else if (Array.isArray(payload?.earningsDetails)) {
    offerIds = payload.earningsDetails.map((item) => item.offerId).filter(Boolean);
  } else if (Array.isArray(payload?.parentOffers)) {
    offerIds = payload.parentOffers
      .flatMap((x) => [x.offerId, x.parentOfferId])
      .filter(Boolean);
  }
  const uniqueOfferIds = Array.from(new Set(offerIds.map(String)));

  return {
    orderId: payload && payload.orderId != null ? String(payload.orderId) : null,
    userName: payload && payload.userName != null ? String(payload.userName) : null,
    offerIds: uniqueOfferIds.length ? uniqueOfferIds.join(',') : null,
  };
}

// ============================================================================
// ДОСТАВКА: Socket.IO (онлайн) или Web Push (офлайн)
// ============================================================================

function buildPushPayload(data = {}) {
  const id = data.id != null ? data.id : null;
  const type = data.type || 'notification';
  return {
    id,
    type,
    audience: data.audience || 'user',
    storeId: data.storeId || null,
    title: data.title || 'Ozon Manager',
    body: data.body || data.message || '',
    url: data.url || '/notifications',
    tag: id != null ? `notification-${id}` : `notification-${type}`,
    vibrate: [200, 100, 200],
    createdAt: data.createdAt || Date.now(),
  };
}

/**
 * Доставить «живое» оповещение одному пользователю В КОНКРЕТНОМ магазине.
 * Без storeId live/push не выполняются (событие не адресуемо).
 */
async function deliverLive(storeId, userId, event, data, { push = true } = {}) {
  if (!storeId) return 'none';
  if (notifyUser(storeId, userId, event, data)) return 'socket';
  if (!push) return 'none';
  const res = await PushService.sendToUser(userId, buildPushPayload({ ...data, storeId }));
  return res.sent > 0 ? 'push' : 'none';
}

/**
 * Разовая рассылка «живого» события по списку id в рамках одного магазина.
 */
async function deliverLiveBatch(storeId, userIds, event, data, { push = true } = {}) {
  if (!storeId) return [];
  const delivered = notifyUsers(storeId, userIds, event, data);
  if (!push || delivered.length === (userIds || []).length) return delivered;
  const offline = (userIds || []).filter((id) => !delivered.includes(id));
  await Promise.allSettled(
    offline.map((id) => PushService.sendToUser(id, buildPushPayload({ ...data, storeId })))
  );
  return delivered;
}

/**
 * Определить storeId: сначала из opts, затем из payload.
 * Оба варианта используются в вызовах по коду (options.storeId — новый стиль,
 * payload.storeId — когда его «протаскивают» в объекте события).
 */
function pickStoreId(opts, payload) {
  if (opts && opts.storeId != null && opts.storeId !== '') return String(opts.storeId);
  if (payload && payload.storeId != null && payload.storeId !== '') return String(payload.storeId);
  return null;
}

class NotificationService {
  static get staffRoles() {
    return STAFF_ROLES;
  }

  /**
   * Персональное оповещение пользователю (в контексте магазина).
   *
   * @param {number} userId
   * @param {string} type
   * @param {object} payload
   * @param {object} opts
   *   storeId   — магазин (обязателен для адресной доставки; можно
   *               передать и через payload.storeId);
   *   persist   — писать ли запись в историю (default true);
   *   push      — слать ли Web Push, если пользователь офлайн (default = persist).
   */
  static async notifyUser(
    userId,
    type,
    payload = {},
    { storeId = null, persist = true, push } = {}
  ) {
    try {
      const sid = pickStoreId({ storeId }, payload);
      const tpl = TEMPLATES[type] ? TEMPLATES[type](payload) : null;
      const text = tpl && tpl.user;
      if (!text) return;

      const search = extractSearchFields(payload);
      let id = null;
      if (persist) {
        id = await Notification.create({
          recipientId: userId,
          storeId: sid,
          audience: 'user',
          type,
          title: text.title,
          message: text.message,
          payload,
          ...search,
        });
      }

      const effectivePush = push === undefined ? persist : push;
      await deliverLive(
        sid,
        userId,
        'notification_new',
        {
          id,
          storeId: sid,
          audience: 'user',
          type,
          title: text.title,
          message: text.message,
          payload,
          createdAt: Date.now(),
          transient: !persist,
        },
        { push: effectivePush }
      );
    } catch (err) {
      console.error(
        `[NotificationService] Не удалось сохранить оповещение для пользователя ${userId}:`,
        err.message
      );
    }
  }

  /**
   * Оповещение персоналу ЭТОГО МАГАЗИНА: получатели ищутся в user_stores.
   *
   * @param {string} type
   * @param {object} payload
   * @param {object} opts
   *   storeId         — магазин; если не задан, запись пишется с store_id = NULL,
   *                     живой доставки нет (системное событие);
   *   roles           — массив ролей-получателей (по умолчанию STAFF_ROLES);
   *   replaceUnreadType — дедупликация;
   *   liveRoles       — кому доставлять «живьём» (default ['moderator']);
   *   push            — Web Push офлайн-получателям из liveRoles.
   */
  static async notifyStaff(
    type,
    payload = {},
    {
      storeId = null,
      roles = null,
      replaceUnreadType = null,
      liveRoles = ['moderator'],
      push = true,
    } = {}
  ) {
    try {
      const sid = pickStoreId({ storeId }, payload);
      const tpl = TEMPLATES[type] ? TEMPLATES[type](payload) : null;
      const text = tpl && tpl.staff;
      if (!text) return;

      const notifyRoles = Array.isArray(roles) && roles.length ? roles : STAFF_ROLES;

      // Получатели — персонал КОНКРЕТНОГО магазина (user_stores).
      // Для глобального (sid = null) события — пустой список: запись в БД
      // уже сделана выше, но никому адресно не доставляется.
      let recipients = [];
      if (sid) {
        const db = getUsersDB();
        recipients = await db.all(
          `SELECT u.id AS id, us.role AS role
           FROM users u
           INNER JOIN user_stores us ON us.user_id = u.id
           WHERE us.store_id = ?
             AND us.role IN (${notifyRoles.map(() => '?').join(',')})
             AND us.is_fired = 0`,
          String(sid),
          ...notifyRoles
        );
      }
      if (!recipients.length) return;

      if (replaceUnreadType) {
        await Notification.deleteUnreadByType(replaceUnreadType, 'staff', sid);
      }

      const createdAt = Date.now();
      const search = extractSearchFields(payload);
      await Notification.createMany(
        recipients.map((r) => ({
          recipientId: r.id,
          storeId: sid,
          audience: 'staff',
          type,
          title: text.title,
          message: text.message,
          payload,
          ...search,
          createdAt,
        }))
      );

      const liveRoleList = Array.isArray(liveRoles) ? liveRoles : [];
      const liveRecipientIds = liveRoleList.length
        ? recipients.filter((r) => liveRoleList.includes(r.role)).map((r) => r.id)
        : [];
      if (liveRecipientIds.length) {
        await deliverLiveBatch(
          sid,
          liveRecipientIds,
          'notification_new',
          {
            storeId: sid,
            audience: 'staff',
            type,
            title: text.title,
            message: text.message,
            payload,
            createdAt,
          },
          { push }
        );
      }
    } catch (err) {
      console.error(
        '[NotificationService] Не удалось сохранить оповещение для персонала:',
        err.message
      );
    }
  }

  /**
   * Сохранить ошибку сервера в журнал (server_errors) и, если есть storeId,
   * доставить «живьём» модераторам ЭТОГО магазина.
   * Системные ошибки (storeId = null) — только запись в БД.
   */
  static async logServerError(source, err, context = null, level = 'error') {
    try {
      const message = err?.message || String(err);
      const storeId = context && context.storeId != null ? String(context.storeId) : null;

      const id = await Notification.addError({
        storeId,
        level,
        source,
        message,
        stack: err?.stack || null,
        context,
      });

      const data = {
        id,
        storeId,
        level,
        source,
        message,
        createdAt: Date.now(),
      };

      // Если магазин неизвестен — не рассылаем «живьём»: не знаем, куда.
      if (!storeId) return;

      // Live — модераторам магазина
      notifyModerators(storeId, 'server_error_new', data);

      // Офлайн-модераторам — ещё и Web Push (только для level='error').
      if (level === 'warn') return;

      const db = getUsersDB();
      const moderators = await db.all(
        `SELECT u.id AS id FROM users u
         INNER JOIN user_stores us ON us.user_id = u.id
         WHERE us.store_id = ? AND us.role = 'moderator' AND us.is_fired = 0`,
        storeId
      );
      const offlineModerators = moderators
        .filter((u) => !isUserOnline(storeId, u.id))
        .map((u) => u.id);
      if (offlineModerators.length) {
        await Promise.allSettled(
          offlineModerators.map((userId) =>
            PushService.sendToUser(
              userId,
              buildPushPayload({
                ...data,
                type: 'server_error_new',
                title: `🚨 Ошибка сервера (${source})`,
              })
            )
          )
        );
      }
    } catch (logErr) {
      console.error(
        '[NotificationService] Не удалось сохранить ошибку сервера:',
        logErr.message
      );
    }
  }
}

module.exports = NotificationService;