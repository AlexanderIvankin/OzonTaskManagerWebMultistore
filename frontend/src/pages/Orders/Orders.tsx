import { useCallback, useEffect, useState } from "react";
import {
  ordersApi,
  Order,
  CompletedOrder,
  readApiErrorPayload,
} from "../../api/orders";
import { OrderCard } from "../../components/OrderCard";
import { CompletedOrderCard } from "../../components/CompletedOrderCard";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { isSocketConnected } from "../../lib/socket";

// Кулдаун кнопки «Обновить» (сек) — паритет с CooldownService.refreshOrders.
// Серверный кулдаун — источник истины (429 + live-тост), здесь он дублируется
// локальным отсчётом, чтобы кнопка не «долбила» API впустую.
const REFRESH_COOLDOWN_SEC = 60;

export const Orders = () => {
  // Вид страницы (как на «Пользователях»): «📮 Активные заказы» — в работе,
  // с кнопками «Завершить»/«Отменить»; «🗳️ Завершённые заказы» — завершены
  // сотрудником, но ещё ожидают отправки (этикетка доступна для скачивания).
  const [view, setView] = useState<"active" | "completed">("active");

  const [activeOrders, setActiveOrders] = useState<Order[]>([]);
  const [completedOrders, setCompletedOrders] = useState<CompletedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Склейка всех этикеток — одно задание Ozon с опросом готовности:
  // запрос может идти до ~2 минут, кнопку блокируем на всё это время.
  const [downloadingLabels, setDownloadingLabels] = useState(false);

  // Кнопка «Обновить»: синхронизация статусов всех заказов сотрудника с Ozon
  const [refreshing, setRefreshing] = useState(false);
  // Момент, до которого кнопка заблокирована (локальный отсчёт кулдауна)
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownLeft, setCooldownLeft] = useState(0);

  // Отсчёт секунд до конца кулдауна (интервал пересоздаётся при смене дедлайна)
  useEffect(() => {
    if (!cooldownUntil) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setCooldownLeft(left);
      if (left === 0) setCooldownUntil(0);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [cooldownUntil]);

  const startCooldown = (seconds: number = REFRESH_COOLDOWN_SEC) => {
    setCooldownUntil(Date.now() + seconds * 1000);
  };

  // Оба списка грузятся вместе: на странице два вида (переключатель в шапке)
  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [active, completed] = await Promise.all([
        ordersApi.getActiveOrders(),
        ordersApi.getCompletedOrders(),
      ]);
      setActiveOrders(active);
      setCompletedOrders(completed);
    } catch (err: any) {
      setError(err.message || "Не удалось загрузить заказы");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Синхронизация статусов ВСЕХ заказов сотрудника (активные + завершённые):
  // сервер делает 2 запроса к Ozon и возвращает оба обновлённых списка
  const handleRefresh = async () => {
    if (refreshing || cooldownLeft > 0) return;
    setRefreshing(true);
    try {
      const data = await ordersApi.refreshOrders();
      setActiveOrders(data.active);
      setCompletedOrders(data.completed);
      setError(null);
      startCooldown();
      toast.success(
        data.removed > 0
          ? `Статусы обновлены, убрано из «Завершённых»: ${data.removed}`
          : "Статусы заказов обновлены",
      );
    } catch (err: unknown) {
      // Кулдаун: при подключённом сокете live-тост уже ушёл по WebSocket —
      // локальный не дублируем; сокет отключён -> показываем локально (fallback)
      const payload = await readApiErrorPayload(err);
      if (payload?.retryAfterSec) startCooldown(payload.retryAfterSec);
      if (payload?.cooldown && isSocketConnected()) return;
      toast.error(
        payload?.error ||
          (err as Error)?.message ||
          "Не удалось обновить заказы",
      );
    } finally {
      setRefreshing(false);
    }
  };

  const handleDownloadAllLabels = async () => {
    if (downloadingLabels) return;
    setDownloadingLabels(true);
    try {
      const blob = await ordersApi.getAllLabels();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "all_labels.pdf";
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success("Все этикетки скачаны");
    } catch (err: unknown) {
      // Кулдаун: при подключённом сокете live-тост уже ушёл по WebSocket —
      // локальный не дублируем; сокет отключён -> показываем локально (fallback)
      const payload = await readApiErrorPayload(err);
      if (payload?.cooldown && isSocketConnected()) return;
      const message =
        payload?.error ||
        (err as Error)?.message ||
        "Не удалось скачать этикетки";
      toast.error(message);
    } finally {
      setDownloadingLabels(false);
    }
  };


  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex flex-col items-center justify-center gap-3 text-center md:flex-row md:justify-between">
        <h1 className="text-2xl font-bold">📦 Мои заказы</h1>
        <div className="flex flex-col items-center gap-2 sm:flex-row sm:items-center">
          <Button
            variant="outline"
            onClick={handleDownloadAllLabels}
            disabled={downloadingLabels}
          >
            {downloadingLabels
              ? "⏳ Формируем этикетки..."
              : "📄 Скачать все этикетки"}
          </Button>
          <Button
            onClick={handleRefresh}
            disabled={loading || refreshing || cooldownLeft > 0}
          >
            {refreshing
              ? "⏳ Обновление..."
              : cooldownLeft > 0
                ? `⏳ Обновить (${cooldownLeft} с)`
                : "🔄 Обновить"}
          </Button>
        </div>
      </div>

      {/* Переключатель вида — отдельным блоком ниже, по центру (как на странице
          «Пользователи»): на маленьких экранах остаются только эмодзи */}
      <div className="flex justify-center mt-3 px-2">
        <div
          className="
      flex flex-col sm:flex-row
      items-stretch sm:items-center
      gap-1
      rounded-lg border p-1
      w-full max-w-[14rem] sm:w-auto sm:max-w-none
    "
        >
          <Button
            size="sm"
            variant={view === "active" ? "default" : "ghost"}
            onClick={() => setView("active")}
            className="justify-center"
            title="Активные заказы"
          >
            <span aria-hidden="true">📮</span>
            <span className="hidden sm:inline ml-1">
              Активные
              {activeOrders.length > 0 ? ` (${activeOrders.length})` : ""}
            </span>
          </Button>
          <Button
            size="sm"
            variant={view === "completed" ? "default" : "ghost"}
            onClick={() => setView("completed")}
            className="justify-center"
            title="Завершённые заказы (ожидают отправки)"
          >
            <span
              className="inline-block align-middle -translate-y-[1px]"
              aria-hidden="true"
            >
              🗳️
            </span>
            <span className="hidden sm:inline ml-1">
              Завершённые
              {completedOrders.length > 0 ? ` (${completedOrders.length})` : ""}
            </span>
          </Button>
        </div>
      </div>


      {loading ? (
        <div className="text-center py-10 text-muted-foreground">
          Загрузка заказов...
        </div>
      ) : error ? (
        <div className="text-center py-10 text-red-500">{error}</div>
      ) : view === "active" ? (
        activeOrders.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            У вас нет активных заказов
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {activeOrders.map((order) => (
              <OrderCard
                key={order.orderId}
                order={order}
                onOrderUpdated={loadAll}
              />
            ))}
          </div>
        )
      ) : completedOrders.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          У вас нет завершённых заказов, ожидающих отправки
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {completedOrders.map((order) => (
              <CompletedOrderCard key={order.orderId} order={order} />
            ))}
          </div>
          <p className="text-xs text-muted-foreground text-center">
            Этикетки доступны, пока заказ находится в статусе «ожидает
            отправки». После отправки заказ исчезнет из этого списка.
          </p>
        </div>
      )}
    </div>
  );
};

