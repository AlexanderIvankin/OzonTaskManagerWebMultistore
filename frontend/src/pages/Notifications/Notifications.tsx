import { useCallback, useEffect, useState } from "react";
import { useSelector } from "react-redux";
import { RootState } from "../../store";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  notificationsApi,
  NotificationBox,
  NotificationItem,
  ServerErrorItem,
} from "../../api/notifications";
import { onNotificationNew, onServerErrorNew } from "../../lib/socket";
import { ordersApi } from "../../api/orders";
import { getBlobErrorMessage } from "../../api/admin";

const PAGE_SIZE = 30;

// Иконки и подписи по типу оповещения (легко расширять)
const TYPE_META: Record<string, { icon: string; label: string }> = {
  // Сработал кулдаун команды (только live-тост, в истории не сохраняется)
  command_cooldown: { icon: "⏳", label: "Кулдаун команды" },
  order_assigned: { icon: "📦", label: "Назначение заказа" },
  order_finished: { icon: "✅", label: "Завершение заказа" },
  order_cancelled: { icon: "❌", label: "Отмена заказа" },
  order_unassigned: { icon: "↩️", label: "Снятие заказа" },
  earnings_adjusted: { icon: "💰", label: "Корректировка заработка" },
  earnings_settled: { icon: "🏦", label: "Расчёт заработка" },
  earnings_settled_zero: { icon: "🏦", label: "Расчёт заработка" },
  stats_filled: { icon: "📝", label: "Статистика заполнена" },
  taking_orders_changed: { icon: "🔄", label: "Приём заказов" },
  new_orders_available: { icon: "🆕", label: "Новые заказы в очереди" },
  order_assign_error: { icon: "⚠️", label: "Ошибка назначения" },
  order_assign_failed: { icon: "🚨", label: "Ошибка назначения" },
  // Этикетка, отправленная администратором (аналог /admin_send_label)
  label_sent: { icon: "🏷️", label: "Этикетка отправлена" },
  // 3D-модели (zip в S3)
  models_available: { icon: "📁", label: "3D-модели выданы" },
  models_missing: { icon: "ℹ️", label: "Нет 3D-моделей" },
  model_uploaded: { icon: "📤", label: "Модель загружена" },
  model_updated: { icon: "🔄", label: "Модель обновлена" },
  model_deleted: { icon: "🗑", label: "Модель удалена" },
  // Модель выдана по РОДИТЕЛЬСКОМУ артикулу (-NR/-NL -> -N) — журнал персонала
  models_parent_used: { icon: "🧩", label: "Модель по родительскому артикулу" },
  // Отказ загрузки: файл не .zip (только live-тост, в истории не сохраняется)
  model_upload_rejected: { icon: "⛔", label: "Модель не загружена" },
  // Напоминания о неотправленных заказах (планировщик, раз в сутки)
  deliver_reminder: { icon: "⏰", label: "Заказ не отправлен" },
  deliver_reminder_summary: { icon: "📋", label: "Проверка «ожидает отправки»" },
  // Отмена заработка за завершённый, но не отправленный заказ
  order_cancelled_earnings_revoked: { icon: "💸", label: "Заказ отменён: заработок списан" },
  deliver_earnings_revoked: { icon: "💸", label: "Заработок обнулён" },
  // Итог ежедневной сверки отменённых Ozon заказов (журнал персонала)
  cancelled_orders_summary: { icon: "📋", label: "Проверка отменённых заказов" },
  // Автоматический ежемесячный экспорт заработка (планировщик)
  monthly_export_done: { icon: "📊", label: "Экспорт заработка" },
  // Синхронизация сотрудников из Excel: проблемные данные (некорректные
  // телефон/e-mail/Telegram ID/числа, строки без идентификаторов пропущены) —
  // журнал персонала
  sync_data_invalid: { icon: "⚠️", label: "Проблемные данные в Excel" },
};

const formatDateTime = (ts: number) =>
  new Date(ts).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const isRead = (n: NotificationItem) => Boolean(n.is_read);

// Прочитанность ошибки сервера (колонка is_read, добавлена миграцией)
const isErrorRead = (e: ServerErrorItem) => Boolean(e.is_read);

// ----------------------------------------------------------------------------
// Детали из payload: состав заказа (OrderDetails при назначении),
// missingStats и детализация заработка (при завершении).
// ----------------------------------------------------------------------------
interface ProductDetail {
  name?: string;
  sku?: string;
  offer_id?: string;
  quantity?: number;
}
interface EarningsDetail {
  offerId: string;
  productName?: string;
  material?: string;
  weight?: number;
  quantity?: number;
  earningsPerUnit?: number;
  totalForProduct?: number;
  isSpecial?: boolean;
}
const PayloadDetails = ({
  payload,
}: {
  payload: Record<string, unknown> | null;
}) => {
  if (!payload) return null;
  const details = payload.details as { products?: ProductDetail[] } | undefined;
  const missingStats = payload.missingStats as string[] | undefined;
  const earningsDetails = payload.earningsDetails as
    | EarningsDetail[]
    | undefined;

  const products = details?.products ?? [];
  const hasProducts = products.length > 0;
  const hasMissing = !!missingStats?.length;
  const hasEarnings = !!earningsDetails?.length;
  if (!hasProducts && !hasMissing && !hasEarnings) return null;

  return (
    <div className="mt-1.5 space-y-1 rounded bg-muted/50 p-2 text-xs text-muted-foreground">
      {hasProducts && (
        <div>
          <p className="font-medium text-foreground">Состав заказа:</p>
          {products.map((p, i) => (
            <p key={i}>
              • {p.name ?? "—"} — {p.quantity ?? 1} шт.
              {p.offer_id ? (
                <>
                  {" "}
                  (offer_id: <code>{p.offer_id}</code>)
                </>
              ) : null}
            </p>
          ))}
        </div>
      )}
      {hasMissing && (
        <p className="text-amber-600 dark:text-amber-400">
          ⚠️ Требуется заполнить статистику:{" "}
          {missingStats!.map((o) => (
            <code key={o} className="mr-1">
              {o}
            </code>
          ))}
        </p>
      )}
      {hasEarnings && (
        <div>
          <p className="font-medium text-foreground">Заработок по товарам:</p>
          {earningsDetails!.map((item, i) => (
            <p key={i}>
              • {item.productName ?? item.offerId} (<code>{item.offerId}</code>)
              —{" "}
              {item.isSpecial
                ? "спецпредложение"
                : `${item.material ?? "—"}, ${item.weight ?? 0} г`}{" "}
              × {item.quantity ?? 1} = {(item.totalForProduct ?? 0).toFixed(2)}{" "}
              руб.
            </p>
          ))}
        </div>
      )}
    </div>
  );
};

type Tab = "mine" | "staff" | "errors";

export const Notifications = () => {
  const user = useSelector((state: RootState) => state.auth.user);
  // Персонал (журнал действий + ошибки сервера): админ, модератор и Создатель.
  // Легко расширить при добавлении новых ролей: достаточно дополнить условие.
  const isStaff = ["admin", "moderator", "god"].includes(user?.role || "");

  const [tab, setTab] = useState<Tab>("mine");

  // Списки (пагинация через limit — «Загрузить ещё»)
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [itemsTotal, setItemsTotal] = useState(0);
  const [itemsLimit, setItemsLimit] = useState(PAGE_SIZE);
  const [errors, setErrors] = useState<ServerErrorItem[]>([]);
  const [errorsTotal, setErrorsTotal] = useState(0);
  const [errorsLimit, setErrorsLimit] = useState(PAGE_SIZE);
  const [errorsUnread, setErrorsUnread] = useState(0);
  const [errorsUnreadOnly, setErrorsUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(false);

  // Выбранные элементы (отдельные наборы: id таблиц пересекаются)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectedErrorIds, setSelectedErrorIds] = useState<Set<number>>(
    new Set(),
  );

  const [unreadOnly, setUnreadOnly] = useState(false);

  // Поиск по номеру заказа / имени сотрудника / артикулу offer_id:
  // *Input — значения полей ввода, *Query — применённый поиск (кнопка «Найти»/Enter)
  const [orderInput, setOrderInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [offerInput, setOfferInput] = useState("");
  const [appliedOrderQuery, setAppliedOrderQuery] = useState("");
  const [appliedNameQuery, setAppliedNameQuery] = useState("");
  const [appliedOfferQuery, setAppliedOfferQuery] = useState("");

  // Счётчики для бейджей вкладок (бейдж «Ошибки сервера» = непрочитанные)
  const [mineUnread, setMineUnread] = useState(0);
  const [staffUnread, setStaffUnread] = useState(0);

  const activeBox: NotificationBox = tab === "staff" ? "staff" : "mine";
  const activeUnread = tab === "staff" ? staffUnread : mineUnread;

  // --- Загрузка списка оповещений ---
  const loadItems = useCallback(
    async (limit: number) => {
      setLoading(true);
      try {
        const data = await notificationsApi.list({
          box: tab === "staff" ? "staff" : "mine",
          unread: unreadOnly || undefined,
          limit,
          orderId: appliedOrderQuery || undefined,
          userName: appliedNameQuery || undefined,
          offerId: appliedOfferQuery || undefined,
        });
        setItems(data.items);
        setItemsTotal(data.total);
        setSelectedIds(new Set());
      } catch (err: any) {
        toast.error(
          err.response?.data?.error || "Не удалось загрузить оповещения",
        );
      } finally {
        setLoading(false);
      }
    },
    [tab, unreadOnly, appliedOrderQuery, appliedNameQuery, appliedOfferQuery],
  );

  // --- Загрузка списка ошибок сервера ---
  const loadErrors = useCallback(
    async (limit: number) => {
      setLoading(true);
      try {
        const data = await notificationsApi.errors({
          unread: errorsUnreadOnly || undefined,
          limit,
        });
        setErrors(data.items);
        setErrorsTotal(data.total);
        setSelectedErrorIds(new Set());
      } catch (err: any) {
        toast.error(
          err.response?.data?.error || "Не удалось загрузить журнал ошибок",
        );
      } finally {
        setLoading(false);
      }
    },
    [errorsUnreadOnly],
  );

  // --- Счётчики вкладок ---
  const loadCounters = useCallback(async () => {
    try {
      const mine = await notificationsApi.unreadCount("mine");
      setMineUnread(mine.count);
      if (isStaff) {
        const staff = await notificationsApi.unreadCount("staff");
        setStaffUnread(staff.count);
        const errsUnread = await notificationsApi.errorsUnreadCount();
        setErrorsUnread(errsUnread.count);
      }
    } catch {
      // счётчики некритичны
    }
  }, [isStaff]);

  useEffect(() => {
    loadCounters();
  }, [loadCounters]);

  useEffect(() => {
    if (tab === "errors") loadErrors(errorsLimit);
    else loadItems(itemsLimit);
  }, [tab, itemsLimit, errorsLimit, unreadOnly, loadItems, loadErrors]);

  // --- Поиск ---
  const applySearch = () => {
    setAppliedOrderQuery(orderInput.trim());
    setAppliedNameQuery(nameInput.trim());
    setAppliedOfferQuery(offerInput.trim());
    setItemsLimit(PAGE_SIZE);
  };

  const resetSearch = () => {
    setOrderInput("");
    setNameInput("");
    setOfferInput("");
    setAppliedOrderQuery("");
    setAppliedNameQuery("");
    setAppliedOfferQuery("");
    setItemsLimit(PAGE_SIZE);
  };

  // При смене вкладки поиск сбрасывается (у каждой вкладки свой контекст,
  // а личные оповещения не содержат имени сотрудника)
  useEffect(() => {
    setOrderInput("");
    setNameInput("");
    setOfferInput("");
    setAppliedOrderQuery("");
    setAppliedNameQuery("");
    setAppliedOfferQuery("");
    setItemsLimit(PAGE_SIZE);
  }, [tab]);

  // --- Живые обновления через WebSocket ---
  // NOTE: Live-тост показывается глобально в Layout.tsx (на любой странице),
  // здесь — только обновление открытого списка и счётчиков (без дубля тоста).
  useEffect(() => {
    const offNew = onNotificationNew((n) => {
      if (n.audience === "staff" && !isStaff) return;

      // Обновляем открытую вкладку, если событие для неё
      const forCurrentTab = (n.audience === "staff") === (tab === "staff");
      if (forCurrentTab) {
        if (tab === "errors") loadErrors(errorsLimit);
        else loadItems(itemsLimit);
      }
      loadCounters();
    });

    const offErr = onServerErrorNew((e) => {
      if (!isStaff) return;
      if (e.level === "error") toast.error(`🐞 ${e.source}: ${e.message}`);
      else toast.warning(`🐞 ${e.source}: ${e.message}`);
      setErrorsUnread((c) => c + 1);
      if (tab === "errors") loadErrors(errorsLimit);
    });

    return () => {
      offNew();
      offErr();
    };
  }, [
    tab,
    isStaff,
    itemsLimit,
    errorsLimit,
    loadItems,
    loadErrors,
    loadCounters,
  ]);

  // =========================================================================
  // Действия с оповещениями (личные / журнал действий)
  // =========================================================================

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allVisibleSelected =
    items.length > 0 && items.every((n) => selectedIds.has(n.id));

  const toggleSelectAll = () => {
    setSelectedIds(
      allVisibleSelected ? new Set() : new Set(items.map((n) => n.id)),
    );
  };

  const unreadSelectedCount = items.filter(
    (n) => selectedIds.has(n.id) && !isRead(n),
  ).length;

  const handleMarkSelectedRead = async () => {
    const ids = items
      .filter((n) => selectedIds.has(n.id) && !isRead(n))
      .map((n) => n.id);
    if (!ids.length) return;
    try {
      await notificationsApi.markRead(activeBox, ids);
      toast.success(`Отмечено прочитанным: ${ids.length}`);
      await loadItems(itemsLimit);
      loadCounters();
    } catch (err: any) {
      toast.error(
        err.response?.data?.error || "Не удалось отметить прочитанным",
      );
    }
  };

  const handleMarkAllRead = async () => {
    try {
      const { changed } = await notificationsApi.markAllRead(activeBox);
      toast.success(
        changed ? `Отмечено прочитанным: ${changed}` : "Нет непрочитанных",
      );
      await loadItems(itemsLimit);
      loadCounters();
    } catch (err: any) {
      toast.error(
        err.response?.data?.error || "Не удалось отметить прочитанным",
      );
    }
  };

  const handleDeleteSelected = async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    try {
      const { changed } = await notificationsApi.delete(activeBox, ids);
      toast.success(`Удалено: ${changed}`);
      await loadItems(itemsLimit);
      loadCounters();
    } catch (err: any) {
      toast.error(err.response?.data?.error || "Не удалось удалить");
    }
  };

  const handleDeleteOne = async (id: number) => {
    try {
      await notificationsApi.delete(activeBox, [id]);
      setItems((prev) => prev.filter((n) => n.id !== id));
      loadCounters();
    } catch (err: any) {
      toast.error(err.response?.data?.error || "Не удалось удалить");
    }
  };

  // Скачать PDF-этикетку, отправленную администратором (label_sent).
  // Файл лежит на сервере и доступен только получателю оповещения.
  const handleDownloadSentLabel = async (orderId: string) => {
    try {
      const blob = await ordersApi.getSentLabel(orderId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `label_${orderId}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success(`Этикетка заказа ${orderId} скачана`);
    } catch (err: any) {
      toast.error(
        await getBlobErrorMessage(err, "Не удалось скачать этикетку"),
      );
    }
  };

  // Клик по оповещению — отметить прочитанным (если ещё не прочитано).
  // Для уже прочитанных клик ничего не делает.
  const handleNotificationClick = async (n: NotificationItem) => {
    if (isRead(n)) return;
    try {
      await notificationsApi.markRead(activeBox, [n.id]);
      if (unreadOnly) {
        // при фильтре «только непрочитанные» строка исчезает сразу
        setItems((prev) => prev.filter((item) => item.id !== n.id));
        setItemsTotal((t) => Math.max(0, t - 1));
      } else {
        // локально гасим строку без перезагрузки списка
        setItems((prev) =>
          prev.map((item) =>
            item.id === n.id ? { ...item, is_read: 1 } : item,
          ),
        );
      }
      loadCounters();
    } catch (err: any) {
      toast.error(
        err.response?.data?.error || "Не удалось отметить прочитанным",
      );
    }
  };

  const handleClearRead = async () => {
    try {
      const { changed } = await notificationsApi.clearRead(activeBox);
      toast.success(
        changed ? `Удалено прочитанных: ${changed}` : "Нет прочитанных",
      );
      await loadItems(itemsLimit);
      loadCounters();
    } catch (err: any) {
      toast.error(err.response?.data?.error || "Не удалось очистить");
    }
  };

  // =========================================================================
  // Действия с ошибками сервера
  // =========================================================================

  const toggleSelectError = (id: number) => {
    setSelectedErrorIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allErrorsSelected =
    errors.length > 0 && errors.every((e) => selectedErrorIds.has(e.id));

  const toggleSelectAllErrors = () => {
    setSelectedErrorIds(
      allErrorsSelected ? new Set() : new Set(errors.map((e) => e.id)),
    );
  };

  const unreadErrorsSelectedCount = errors.filter(
    (e) => selectedErrorIds.has(e.id) && !isErrorRead(e),
  ).length;

  const handleMarkSelectedErrorsRead = async () => {
    const ids = errors
      .filter((e) => selectedErrorIds.has(e.id) && !isErrorRead(e))
      .map((e) => e.id);
    if (!ids.length) return;
    try {
      await notificationsApi.markErrorsRead(ids);
      toast.success(`Отмечено прочитанным: ${ids.length}`);
      await loadErrors(errorsLimit);
      loadCounters();
    } catch (err: any) {
      toast.error(
        err.response?.data?.error || "Не удалось отметить прочитанным",
      );
    }
  };

  const handleMarkAllErrorsRead = async () => {
    try {
      const { changed } = await notificationsApi.markAllErrorsRead();
      toast.success(
        changed ? `Отмечено прочитанным: ${changed}` : "Нет непрочитанных",
      );
      await loadErrors(errorsLimit);
      loadCounters();
    } catch (err: any) {
      toast.error(
        err.response?.data?.error || "Не удалось отметить прочитанным",
      );
    }
  };

  // Клик по ошибке — отметить прочитанной (если ещё не прочитана).
  // Для уже прочитанных клик ничего не делает.
  // Журнал общий для персонала: «прочитано» — общий флаг «разобрано».
  const handleErrorClick = async (err: ServerErrorItem) => {
    if (isErrorRead(err)) return;
    try {
      await notificationsApi.markErrorsRead([err.id]);
      if (errorsUnreadOnly) {
        // при фильтре «только непрочитанные» строка исчезает сразу
        setErrors((prev) => prev.filter((item) => item.id !== err.id));
        setErrorsTotal((t) => Math.max(0, t - 1));
      } else {
        // локально гасим строку без перезагрузки списка
        setErrors((prev) =>
          prev.map((item) =>
            item.id === err.id ? { ...item, is_read: 1 } : item,
          ),
        );
      }
      loadCounters();
    } catch (e: any) {
      toast.error(e.response?.data?.error || "Не удалось отметить прочитанным");
    }
  };

  const handleDeleteSelectedErrors = async () => {
    const ids = [...selectedErrorIds];
    if (!ids.length) return;
    try {
      const { changed } = await notificationsApi.deleteErrors(ids);
      toast.success(`Удалено ошибок: ${changed}`);
      await loadErrors(errorsLimit);
      loadCounters();
    } catch (err: any) {
      toast.error(err.response?.data?.error || "Не удалось удалить");
    }
  };

  const handleDeleteOneError = async (id: number) => {
    try {
      await notificationsApi.deleteErrors([id]);
      setErrors((prev) => prev.filter((e) => e.id !== id));
      loadCounters();
    } catch (err: any) {
      toast.error(err.response?.data?.error || "Не удалось удалить");
    }
  };

  const handleClearErrors = async () => {
    try {
      const { changed } = await notificationsApi.clearErrors();
      toast.success(
        changed ? `Журнал очищен (удалено ${changed})` : "Журнал уже пуст",
      );
      await loadErrors(errorsLimit);
      loadCounters();
    } catch (err: any) {
      toast.error(err.response?.data?.error || "Не удалось очистить журнал");
    }
  };

  const tabButton = (key: Tab, label: string, badge: number) => (
    <Button
      variant={tab === key ? "default" : "outline"}
      size="sm"
      onClick={() => setTab(key)}
    >
      {label}
      {badge > 0 && (
        <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-xs font-semibold text-destructive-foreground">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Button>
  );

  return (
    <div className="mx-auto max-w-4xl items-center text-center md:text-start">
      <h1 className="mb-4 text-2xl font-bold">🔔 Оповещения</h1>

      {/* Вкладки: личные — всем, журнал действий и ошибки — персоналу */}
      <div className="mb-4 flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {tabButton("mine", "Личные", mineUnread)}
        {isStaff && tabButton("staff", "Действия сотрудников", staffUnread)}
        {isStaff && tabButton("errors", "Ошибки сервера", errorsUnread)}
      </div>

      {tab === "errors" ? (
        <>
          {/* Панель действий журнала ошибок */}
          <div className="mb-3 flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <label className="mr-2 flex shrink-0 items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={allErrorsSelected}
                onChange={toggleSelectAllErrors}
                disabled={!errors.length}
              />
              Выбрать все
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={!unreadErrorsSelectedCount}
              onClick={handleMarkSelectedErrorsRead}
            >
              ✓ Прочитать выбранные
              {unreadErrorsSelectedCount
                ? ` (${unreadErrorsSelectedCount})`
                : ""}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={errorsUnread === 0}
              onClick={handleMarkAllErrorsRead}
            >
              ✓ Прочитать всё
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={!selectedErrorIds.size}
              onClick={handleDeleteSelectedErrors}
            >
              🗑 Удалить выбранные
              {selectedErrorIds.size ? ` (${selectedErrorIds.size})` : ""}
            </Button>
            <Button size="sm" variant="destructive" onClick={handleClearErrors}>
              ⚠️ Очистить весь журнал
            </Button>
            <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm text-muted-foreground sm:ml-auto">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={errorsUnreadOnly}
                onChange={(e) => setErrorsUnreadOnly(e.target.checked)}
              />
              Только непрочитанные
            </label>
          </div>

          {/* Список ошибок */}
          <div className="space-y-2">
            {loading && errors.length === 0 && (
              <p className="text-sm text-muted-foreground">Загрузка...</p>
            )}
            {!loading && !errors.length && (
              <Card>
                <CardContent className="py-10 text-center text-muted-foreground">
                  {errorsUnreadOnly
                    ? "Нет непрочитанных ошибок"
                    : "Журнал ошибок пуст 🎉"}
                </CardContent>
              </Card>
            )}
            {errors.map((e) => (
              <div
                key={e.id}
                onClick={() => handleErrorClick(e)}
                title={
                  isErrorRead(e)
                    ? undefined
                    : "Нажмите, чтобы отметить прочитанным"
                }
                className={`flex items-center gap-3 rounded-md border p-3 transition-colors ${
                  isErrorRead(e)
                    ? "opacity-70"
                    : "cursor-pointer bg-accent/40 hover:bg-accent/70"
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-primary"
                  checked={selectedErrorIds.has(e.id)}
                  onChange={() => toggleSelectError(e.id)}
                  onClick={(ev) => ev.stopPropagation()}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {!isErrorRead(e) && (
                      <span
                        className="h-2 w-2 shrink-0 rounded-full bg-blue-500"
                        title="Непрочитано"
                      />
                    )}
                    <Badge
                      variant={
                        e.level === "error" ? "destructive" : "secondary"
                      }
                    >
                      {e.level === "error" ? "ERROR" : "WARN"}
                    </Badge>
                    <Badge variant="outline">{e.source || "server"}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(e.created_at)}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-sm">{e.message}</p>
                  {(e.stack || e.context) && (
                    <details
                      className="mt-1"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        Подробности
                      </summary>
                      {e.context && (
                        <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">
                          {JSON.stringify(e.context, null, 2)}
                        </pre>
                      )}
                      {e.stack && (
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                          {e.stack}
                        </pre>
                      )}
                    </details>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  title="Удалить"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    handleDeleteOneError(e.id);
                  }}
                >
                  ✕
                </Button>
              </div>
            ))}
            {errors.length < errorsTotal && (
              <div className="flex justify-center pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={() => setErrorsLimit((l) => l + PAGE_SIZE)}
                >
                  Загрузить ещё ({errorsTotal - errors.length})
                </Button>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          {/* Поиск: номер заказа и артикул (обе вкладки) + имя сотрудника (журнал действий) */}
          <div className="mb-3 flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Input
              placeholder="🔎 Номер заказа..."
              value={orderInput}
              onChange={(e) => setOrderInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applySearch()}
              className="w-full sm:w-52"
            />
            <Input
              placeholder="🔖 Артикул (offer_id)..."
              value={offerInput}
              onChange={(e) => setOfferInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applySearch()}
              className="w-full sm:w-52"
            />
            {tab === "staff" && (
              <Input
                placeholder="👤 Имя сотрудника..."
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applySearch()}
                className="w-full sm:w-52"
              />
            )}
            <Button size="sm" variant="outline" onClick={applySearch}>
              Найти
            </Button>
            {(appliedOrderQuery || appliedNameQuery || appliedOfferQuery) && (
              <Button size="sm" variant="ghost" onClick={resetSearch}>
                ✕ Сбросить
              </Button>
            )}
          </div>

          {/* Панель действий оповещений */}
          <div className="mb-3 flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <label className="mr-2 flex shrink-0 items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={allVisibleSelected}
                onChange={toggleSelectAll}
                disabled={!items.length}
              />
              Выбрать все
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={!unreadSelectedCount}
              onClick={handleMarkSelectedRead}
            >
              ✓ Прочитать выбранные
              {unreadSelectedCount ? ` (${unreadSelectedCount})` : ""}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={activeUnread === 0}
              onClick={handleMarkAllRead}
            >
              ✓ Прочитать всё
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={!selectedIds.size}
              onClick={handleDeleteSelected}
            >
              🗑 Удалить выбранные
              {selectedIds.size ? ` (${selectedIds.size})` : ""}
            </Button>
            <Button size="sm" variant="destructive" onClick={handleClearRead}>
              ⚠️ Удалить все прочитанные
            </Button>
            <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm text-muted-foreground sm:ml-auto">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={unreadOnly}
                onChange={(e) => setUnreadOnly(e.target.checked)}
              />
              Только непрочитанные
            </label>
          </div>

          {/* Список оповещений */}
          <div className="space-y-2">
            {loading && items.length === 0 && (
              <p className="text-sm text-muted-foreground">Загрузка...</p>
            )}
            {!loading && !items.length && (
              <Card>
                <CardContent className="py-10 text-center text-muted-foreground">
                  {appliedOrderQuery || appliedNameQuery || appliedOfferQuery
                    ? "Ничего не найдено по заданным условиям"
                    : unreadOnly
                      ? "Нет непрочитанных оповещений"
                      : "Пока нет оповещений"}
                </CardContent>
              </Card>
            )}
            {items.map((n) => (
              <div
                key={n.id}
                onClick={() => handleNotificationClick(n)}
                title={
                  isRead(n) ? undefined : "Нажмите, чтобы отметить прочитанным"
                }
                className={`flex items-center gap-3 rounded-md border p-3 transition-colors ${
                  isRead(n)
                    ? "opacity-70"
                    : "cursor-pointer bg-accent/40 hover:bg-accent/70"
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-primary"
                  checked={selectedIds.has(n.id)}
                  onChange={() => toggleSelect(n.id)}
                  onClick={(e) => e.stopPropagation()}
                />
                <span className="text-xl leading-none">
                  {TYPE_META[n.type]?.icon ?? "🔔"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {!isRead(n) && (
                      <span
                        className="h-2 w-2 shrink-0 rounded-full bg-blue-500"
                        title="Непрочитано"
                      />
                    )}
                    <span
                      className={`text-sm ${isRead(n) ? "" : "font-semibold"}`}
                    >
                      {n.title}
                    </span>
                  </div>
                  {n.message && (
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                      {n.message}
                    </p>
                  )}
                  <PayloadDetails payload={n.payload} />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatDateTime(n.created_at)} ·{" "}
                    {TYPE_META[n.type]?.label ?? n.type}
                  </p>
                </div>
                {/* Этикетка, отправленная администратором: кнопка скачивания PDF */}
                {n.type === "label_sent" &&
                  typeof n.payload?.orderId === "string" && (
                    <Button
                      size="sm"
                      variant="outline"
                      title="Скачать этикетку (PDF)"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownloadSentLabel(n.payload!.orderId as string);
                      }}
                    >
                      ⬇️ PDF
                    </Button>
                  )}
                <Button
                  size="sm"
                  variant="ghost"
                  title="Удалить"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteOne(n.id);
                  }}
                >
                  ✕
                </Button>
              </div>
            ))}
            {items.length < itemsTotal && (
              <div className="flex justify-center pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={() => setItemsLimit((l) => l + PAGE_SIZE)}
                >
                  Загрузить ещё ({itemsTotal - items.length})
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
