const { getDB } = require('../config/database');
const Notification = require('../models/Notification');
const PushService = require('./PushService');
const {
  notifyUser,
  notifyUsers,
  notifyModerators,
  isUserOnline,
} = require('../socket');
// Единый источник истины по ролям персонала (модуль без зависимостей —
// цикл require через socket.js / middlewares/auth исключён).
const { STAFF_ROLES } = require('../config/staffRoles');

// ============================================================================
// Роли персонала: кому создаётся запись в архиве журнала действий сотрудников.
// Каждому пользователю с этой ролью создаётся СВОЯ копия оповещения
// (массив админов/модераторов/создателя поддерживается автоматически).
// Чтобы добавить/убрать роль — достаточно править src/config/staffRoles.js (не здесь).
//
// Куда доставлять оповещение (Socket.IO или Web Push) — решает notifyUser:
//   • пользователь ОНЛАЙН — есть хотя бы один активный сокет в комнате
//     `user_<id>` (socket.isUserOnline) -> мгновенно через Socket.IO;
//   • пользователь ОФЛАЙН — Web Push (PushService) на ВСЕ его подписанные
//     устройства (TTL 24 ч: FCM/APNs подержит и доставит, когда он вернётся).
// Смысл связки: сокет даёт мгновенность онлайн-пользователям, push —
// гарантированную доставку тем, кто офлайн.
//
// Live-доставка событий о действиях сотрудников (notifyStaff) адресуется
// только ролям из opts.liveRoles (по умолчанию ['moderator'] — как и раньше,
// комната 'moderators'). Остальные роли персонала (admin, god) читают эти
// события в архиве журнала (страница «Оповещения» -> вкладка «Персонал»).
// Ошибки сервера (logServerError) уходят live модераторам, а офлайн-
// модераторам — ещё и Web Push (ошибка сервера — высокий сигнал).
// ============================================================================

// ============================================================================
// Шаблоны текстов оповещений.
// Каждая функция получает payload и возвращает тексты для двух аудиторий:
//   user  — личное оповещение сотрудника/админа
//   staff — запись в журнале действий (для админов/модераторов)
// Если для аудитории текста нет — оповещение этой аудитории не создаётся.
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
    // В журнал действий для персонала не дублируем (сотрудник получит своё)
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
    // В журнал действий для персонала не дублируем
    staff: {
      title: `🏦 Произведён расчёт заработка`,
      message: `Активный заработок сотрудника ${p.userName} обнулён.\nВыплачено: ${Number(p.amount || 0).toFixed(2)} руб.${p.adminName ? `\nРасчёт произвёл: ${p.adminName}.` : ''}`,
    },
  }),

  // Заработок уже 0: отправляется только через WebSocket (persist: false),
  // в историю «Оповещений» не попадает
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

  // Этикетка, отправленная сотруднику администратором (аналог /admin_send_label).
  // PDF сохраняется на сервере (outputs/labels/<orderId>.pdf) и скачивается
  // сотрудником по кнопке в оповещении (GET /user/labels/:orderId/sent).
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

  // ==========================================================================
  // Напоминания о неотправленных заказах (статус awaiting_deliver).
  // Создаются планировщиком awaiting_deliver (scheduler.js) раз в сутки:
  //   user  — лично сотруднику, чей заказ «висит» без отправки;
  //   staff — копия в журнал действий персоналу (модераторы получают её
  //           ещё и live через WebSocket, как обычные действия сотрудников).
  // ==========================================================================
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
    // 2-е напоминание (за день до авто-обнуления) — усиленный текст.
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

  // Итог ежедневной проверки «ожидает отправки» — только персоналу.
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

  // ==========================================================================
  // Отмена заработка за заказ, который был завершён, но не отправлен.
  //   order_cancelled_earnings_revoked — Ozon перевёл заказ в статус «Отменён»
  //     (планировщик cancelledOrders);
  //   deliver_earnings_revoked        — заказ слишком долго «ожидает отправки»
  //     (планировщик awaitingDeliver, 3-е напоминание).
  // Деньги снимаются сторнирующей корректировкой (см.
  // EarningsService.revokeOrderEarnings — идемпотентно, без двойных списаний).
  // ==========================================================================
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

  // Итог ежедневной сверки отменённых Ozon заказов — только персоналу.
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

  // Автоматический ежемесячный экспорт заработка (планировщик) — только персоналу.
  monthly_export_done: (p) => ({
    user: null,
    staff: {
      title: `📊 Экспорт заработка за ${p.month} выполнен`,
      message: `Автоматический экспорт заработка за ${p.month} выполнен.\nФайл: ${p.file || '—'}.`,
    },
  }),

  // === 3D-модели (zip в S3) ===

  // Сотруднику: модели по заказу доступны для скачивания (кнопка в карточке заказа
  // и в самом оповещении). offerIds участвуют в поиске по артикулу.
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

  // Модель найдена НЕ по прямому артикулу, а по родительскому (-NR/-NL -> -N):
  // персоналу нужно знать, что для прямого offer_id модели нет (при случае —
  // завести отдельную модель или переименовать архив в родительский артикул).
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

  // Ни одной модели по заказу не найдено — сотруднику info, персоналу задача.
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

  // Журнал персонала: модель загружена/обновлена
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

  // Сотруднику с выданной моделью: архив обновился — скачайте заново.
  // source='storage' — обновление обнаружено сверкой с S3 (файл заменили
  // напрямую в бакете, оповещения из uploadModel не было).
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

  // Журнал персонала: модель удалена
  model_deleted: (p) => ({
    user: null,
    staff: {
      title: `🗑 Модель ${p.offerId} удалена`,
      message: `3D-модель для ${p.offerId} удалена из хранилища.${p.adminName ? `\nУдалил: ${p.adminName}.` : ''}`,
    },
  }),

  // ЖЁСТКАЯ валидация загрузки модели (принимаем ТОЛЬКО .zip) не пройдена:
  // уходит ЛИЧНО загрузившему МГНОВЕННО через WebSocket (persist: false — в
  // историю «Оповещений» запись НЕ создаётся), в журнал персонала не пишется.
  model_upload_rejected: (p) => ({
    user: {
      title: `⛔ Модель${p.offerId ? ` ${p.offerId}` : ''} не загружена`,
      message:
        `Загрузка отклонена: ${p.error || 'файл не является zip-архивом'}.\n` +
        `Модель на артикул — всегда ОДИН zip-архив: назовите файл «{offer_id}.zip» (например, ARD000003-N.zip).`,
    },
    staff: null,
  }),

  // Сработал кулдаун команды (middleware cooldown): уходит ЛИЧНО запросившему
  // МГНОВЕННО через WebSocket (persist: false — в историю «Оповещений» запись
  // НЕ создаётся), в журнал персонала не пишется.
  command_cooldown: (p) => ({
    user: {
      title: `⏳ ${p.command || 'Команда'} — кулдаун`,
      message: p.message || `Повторите через ${p.retryAfterSec} сек.`,
    },
    staff: null,
  }),

  // ==========================================================================
  // Синхронизация сотрудников из Excel: некорректные данные в строках
  // (телефон, e-mail, Telegram ID, число принтеров, коэффициент заработка).
  // Проблемные значения заменяются на дефолты (телефон/Telegram ID — очищены,
  // число принтеров — 1, коэффициент — 1.0) либо строка пропускается;
  // персоналу нужно исправить Excel и повторить синхронизацию.
  // ==========================================================================
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
 * Извлекает поля для быстрого поиска из payload:
 *   orderId   — номер заказа;
 *   userName  — имя сотрудника;
 *   offerIds  — артикулы товаров (строка через запятую). Берутся из
 *               payload.offerIds (явно), payload.details.products[].offer_id
 *               (OrderDetails при назначении) или payload.earningsDetails[].offerId
 *               (детализация заработка при завершении).
 * Сохраняются в колонки order_id / user_name / offer_ids notifications.db.
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
    // models_parent_used: ищем и по прямому артикулу, и по родительскому
    offerIds = payload.parentOffers
      .flatMap((x) => [x.offerId, x.parentOfferId])
      .filter(Boolean);
  }
  const uniqueOfferIds = Array.from(new Set(offerIds.map(String)));

  return {
    orderId:
      payload && payload.orderId != null ? String(payload.orderId) : null,
    userName:
      payload && payload.userName != null ? String(payload.userName) : null,
    offerIds: uniqueOfferIds.length ? uniqueOfferIds.join(',') : null,
  };
}

// ============================================================================
// ДОСТАВКА: Socket.IO (онлайн) или Web Push (офлайн)
// ============================================================================

/**
 * Payload для Service Worker (frontend/public/sw.js).
 *   title/body — как в live-тосте;
 *   url        — куда вести по клику на уведомление;
 *   tag        — «схлопывание» дублей одного и того же оповещения;
 *   vibrate    — паттерн вибрации (Android; iOS игнорирует).
 */
function buildPushPayload(data = {}) {
  const id = data.id != null ? data.id : null;
  const type = data.type || 'notification';
  return {
    id,
    type,
    audience: data.audience || 'user',
    title: data.title || 'Ozon Manager',
    body: data.body || data.message || '',
    url: data.url || '/notifications',
    tag: id != null ? `notification-${id}` : `notification-${type}`,
    vibrate: [200, 100, 200],
    createdAt: data.createdAt || Date.now(),
  };
}

/**
 * Доставить «живое» оповещение одному пользователю:
 *   онлайн -> Socket.IO ('socket');
 *   офлайн -> Web Push ('push'), если push !== false;
 *   нет подписок и нет сокета -> 'none'.
 * Никогда не бросает исключений (сбой доставки не ломает бизнес-логику).
 */
async function deliverLive(userId, event, data, { push = true } = {}) {
  if (notifyUser(userId, event, data)) return 'socket';
  if (!push) return 'none';
  const res = await PushService.sendToUser(userId, buildPushPayload(data));
  return res.sent > 0 ? 'push' : 'none';
}

/**
 * Разовая рассылка «живого» события по списку id: онлайн — сокет,
 * офлайн — Web Push (параллельно, чтобы сеть не задерживала вызывающего).
 * @returns {Promise<number[]>} id тех, кому событие ушло в сокет
 */
async function deliverLiveBatch(userIds, event, data, { push = true } = {}) {
  const delivered = notifyUsers(userIds, event, data);
  if (!push || delivered.length === (userIds || []).length) return delivered;
  const offline = (userIds || []).filter((id) => !delivered.includes(id));
  await Promise.allSettled(
    offline.map((id) => PushService.sendToUser(id, buildPushPayload(data)))
  );
  return delivered;
}

class NotificationService {
  /**
   * Роли персонала (журнал действий + ошибки сервера).
   */
  static get staffRoles() {
    return STAFF_ROLES;
  }

  /**
   * Персональное оповещение пользователю: запись в notifications.db +
   * доставка «куда нужно» — Socket.IO (онлайн) или Web Push (офлайн).
   * Никогда не бросает исключений — сбой оповещений не должен ломать бизнес-логику.
   *
   * @param {number} userId
   * @param {string} type
   * @param {object} payload
   * @param {object} opts
   *   persist = true  — писать ли запись в историю «Оповещений»
   *                     (persist: false — только мгновенный тост, БЕЗ записи:
   *                     «заработок уже 0», кулдаун команды, отклонённая загрузка);
   *   push = persist  — слать ли Web Push, если пользователь ОФЛАЙН. По умолчанию
   *                     транзиентные (persist: false) не пушатся: это немедленный
   *                     отклик на действие в открытом UI.
   */
  static async notifyUser(
    userId,
    type,
    payload = {},
    { persist = true, push = persist } = {}
  ) {
    try {
      const tpl = TEMPLATES[type] ? TEMPLATES[type](payload) : null;
      const text = tpl && tpl.user;
      if (!text) return;

      const search = extractSearchFields(payload);
      let id = null;
      if (persist) {
        id = await Notification.create({
          recipientId: userId,
          audience: 'user',
          type,
          title: text.title,
          message: text.message,
          payload,
          ...search,
        });
      }

      // Доставка: онлайн — Socket.IO (мгновенно, во все вкладки/устройства),
      // офлайн — Web Push (на все подписанные устройства пользователя).
      await deliverLive(
        userId,
        'notification_new',
        {
          id,
          audience: 'user',
          type,
          title: text.title,
          message: text.message,
          payload,
          createdAt: Date.now(),
          transient: !persist,
        },
        { push }
      );
    } catch (err) {
      console.error(
        `[NotificationService] Не удалось сохранить оповещение для пользователя ${userId}:`,
        err.message
      );
    }
  }

  /**
   * Оповещение персоналу: каждому получателю своя строка в БД.
   * Никогда не бросает исключений.
   *
   * @param {string} type
   * @param {object} payload
   * @param {object} opts
   *   roles            — массив ролей-получателей (по умолчанию все STAFF_ROLES);
   *                      например ['moderator'] для информационных оповещений,
   *                      интересных только модераторам.
   *   replaceUnreadType— если задан тип, перед вставкой нового оповещения
   *                      удаляются все НЕПРОЧИТАННЫЕ оповещения этого типа
   *                      (дедупликация: подобное оповещение всегда ОДНО).
   *   liveRoles        — кому доставлять событие «живьём» (сокет или push).
   *                      По умолчанию ['moderator'] — паритет с прежней
   *                      рассылкой в комнату 'moderators'. Пустой массив или
   *                      null — запись только в архив журнала (без live/push).
   *   push = true      — слать ли Web Push тем получателям из liveRoles, кто ОФЛАЙН.
   */
  static async notifyStaff(
    type,
    payload = {},
    { roles = null, replaceUnreadType = null, liveRoles = ['moderator'], push = true } = {}
  ) {
    try {
      const tpl = TEMPLATES[type] ? TEMPLATES[type](payload) : null;
      const text = tpl && tpl.staff;
      if (!text) return;

      const notifyRoles = Array.isArray(roles) && roles.length ? roles : STAFF_ROLES;
      const db = getDB();
      const recipients = await db.all(
        `SELECT id, role FROM users WHERE role IN (${notifyRoles.map(() => '?').join(',')}) AND is_fired = 0`,
        ...notifyRoles
      );
      if (!recipients.length) return;

      // Дедупликация: старое непрочитанное оповещение того же типа удаляем
      if (replaceUnreadType) {
        await Notification.deleteUnreadByType(replaceUnreadType, 'staff');
      }

      const createdAt = Date.now();
      const search = extractSearchFields(payload);
      await Notification.createMany(
        recipients.map((r) => ({
          recipientId: r.id,
          audience: 'staff',
          type,
          title: text.title,
          message: text.message,
          payload,
          ...search,
          createdAt,
        }))
      );

      // «Живая» доставка — только ролям из opts.liveRoles (по умолчанию
      // модераторы — паритет с прежней рассылкой в комнату 'moderators').
      // Онлайн -> адресный сокет в комнату `user_<id>`: широковещательная
      // рассылка в 'moderators' дала бы пользователю с несколькими вкладками
      // ДУБЛЬ тоста, а адресная — ровно один на все его вкладки.
      // Офлайн -> Web Push на все подписанные устройства.
      const liveRoleList = Array.isArray(liveRoles) ? liveRoles : [];
      const liveRecipientIds = liveRoleList.length
        ? recipients
            .filter((r) => liveRoleList.includes(r.role))
            .map((r) => r.id)
        : [];
      if (liveRecipientIds.length) {
        await deliverLiveBatch(
          liveRecipientIds,
          'notification_new',
          {
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
   * Сохранить ошибку сервера в отдельный журнал (notifications.db -> server_errors)
   * и мгновенно сообщить персоналу через WebSocket. Никогда не бросает исключений.
   *
   * @param {string} source - источник ошибки ('express', 'OrderService', 'scheduler.backup', ...)
   * @param {Error|any} err
   * @param {object|null} context - произвольный контекст (orderId, userId и т.п.)
   * @param {'error'|'warn'} level
   */
  static async logServerError(source, err, context = null, level = 'error') {
    try {
      const message = err?.message || String(err);
      const id = await Notification.addError({
        level,
        source,
        message,
        stack: err?.stack || null,
        context,
      });

      const data = {
        id,
        level,
        source,
        message,
        createdAt: Date.now(),
      };

      // Live — модераторам (как раньше, комната 'moderators').
      notifyModerators('server_error_new', data);

      // Офлайн-модераторам — ещё и Web Push: ошибка сервера важна, а «живьём»
      // (сокетом) они её не увидят, пока не откроют приложение.
      // Только для level='error': warn-логи могут повторяться часто, и телефон
      // модератора не должен звенеть на каждый из них (live-тост остаётся).
      const db = getDB();
      const moderators = await db.all(
        "SELECT id FROM users WHERE role = 'moderator' AND is_fired = 0"
      );
      const offlineModerators = moderators
        .filter((u) => !isUserOnline(u.id))
        .map((u) => u.id);
      if (level !== 'warn' && offlineModerators.length) {
        await Promise.allSettled(
          offlineModerators.map((userId) =>
            PushService.sendToUser(
              userId,
              buildPushPayload({
                ...data,
                type: 'server_error_new',
                title:
                  level === 'warn'
                    ? `⚠️ Предупреждение сервера (${source})`
                    : `🚨 Ошибка сервера (${source})`,
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
