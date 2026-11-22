import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ordersApi, CompletedOrder, readApiErrorPayload } from "../api/orders";
import { toast } from "sonner";
import { isSocketConnected, onNotificationNew } from "../lib/socket";
import { OrderProductsList } from "./OrderProductsList";

const RETRY_DELAY_MS = 30000;
const MAX_RETRIES = 3;

interface CompletedOrderCardProps {
  order: CompletedOrder;
}

/**
 * Карточка завершённого заказа, ожидающего отправки (awaiting_deliver) —
 * вкладка «🗳️ Завершённые заказы». Состав и фотографии такие же, как у
 * активного заказа, но действие одно: скачать этикетку (Ozon getPackageLabel).
 *
 * Улучшения:
 *  • Кнопка никогда не «залипает» — `finally` разблокирует её после любой
 *    ошибки (в т.ч. «этикетка ещё не готова»).
 *  • Автоповтор через 30 сек, если этикетка ещё формируется (до 3 попыток).
 *  • Зелёная кнопка «✅ Этикетка скачана», если этикетка уже скачана
 *    (состояние хранится в localStorage, сохраняется между перезагрузками).
 *  • Автоскачивание по сокет-событию `label_ready` (бэкенд шлёт его через
 *    ~60 сек после завершения заказа) — не нужно перезагружать страницу.
 */
export const CompletedOrderCard = ({ order }: CompletedOrderCardProps) => {
  const [downloading, setDownloading] = useState(false);
  // этикетка ещё не готова, идёт автоожидание/повтор
  const [labelPending, setLabelPending] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  // Оптимистичный флаг: показываем «скачано» сразу после клика,
  // не дожидаясь рефетча с сервера. Серверный labelDownloadedAt —
  // источник истины при перезагрузке страницы / переходе между вкладками.
  const [justDownloaded, setJustDownloaded] = useState(false);

  const isDownloaded = justDownloaded || !!order.labelDownloadedAt;

  const handleDownloadLabel = useCallback(async () => {
    if (downloading || labelPending) return;
    setDownloading(true);
    setLabelPending(false);
    try {
      const blob = await ordersApi.getLabel(order.orderId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `label_${order.orderId}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
      setJustDownloaded(true); // больше localStorage
      toast.success(`Этикетка заказа ${order.orderId} скачана`);
    } catch (err: unknown) {
      const payload = await readApiErrorPayload(err);
      if (payload?.cooldown && isSocketConnected()) return;

      const msg =
        payload?.error ||
        (err as Error)?.message ||
        "Не удалось скачать этикетку";

      // Этикетка формируется в Ozon асинхронно.
      // Это НЕ ошибка — просто ещё рано.
      const isPending =
        typeof msg === "string" &&
        (msg.includes("Этикетка ещё не доступна") ||
          msg.includes("формируется") ||
          msg.includes("не удалось сформировать") ||
          msg.includes("не готова"));

      if (isPending && retryCount < MAX_RETRIES) {
        setLabelPending(true);
        setRetryCount((r) => r + 1);
        setTimeout(() => setLabelPending(false), RETRY_DELAY_MS);
        toast.info(msg, {
          description: `Повтор через ${RETRY_DELAY_MS / 1000} сек…`,
        });
      } else if (isPending) {
        toast.info(msg, { description: "Повторите через минуту" });
      } else {
        toast.error(msg);
      }
    } finally {
      setDownloading(false);
    }
  }, [order.orderId, downloading, labelPending, retryCount]);

  // Реагируем на сокет-уведомление label_ready — автоскачиваем этикетку
  // без перезагрузки страницы.
  useEffect(() => {
    const off = onNotificationNew((n) => {
      if (n.type !== "label_ready") return;
      const notifiedOrderId = String(
        (n as { payload?: { orderId?: string }; orderId?: string })?.payload
          ?.orderId ||
          (n as { orderId?: string }).orderId ||
          "",
      );
      if (notifiedOrderId !== order.orderId) return;
      if (isDownloaded || downloading || labelPending) return;
      handleDownloadLabel();
    });
    return () => off();
  }, [
    order.orderId,
    isDownloaded,
    downloading,
    labelPending,
    handleDownloadLabel,
  ]);

  return (
    <Card>
      <CardHeader>
        <CardTitle
          className="
    flex flex-wrap flex-col items-center justify-center gap-2 text-center

    sm:flex-row sm:items-start sm:justify-between sm:text-start

    md:flex-col md:items-center md:justify-center md:text-center

    xl:flex-row xl:items-start xl:justify-between xl:text-start
  "
        >
          <span>
            Заказ{" "}
            <span className="font-bold">
              <code>{order.orderId}</code>
            </span>
          </span>
          <Badge variant="secondary">🗳️ Ожидает отправки</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-center sm:text-start md:text-center xl:text-start">
        <div className="text-sm text-muted-foreground">
          Завершён: {new Date(order.completedAt).toLocaleString()}
        </div>
        <OrderProductsList
          products={order.products}
          alignClassName="text-center sm:text-start md:text-center xl:text-start justify-center sm:justify-start md:justify-center xl:justify-start"
        />
        {order.consumedStoredReturns &&
          order.consumedStoredReturns.length > 0 && (
            <div className="my-2 rounded-md border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-900 p-2 text-center sm:text-start">
              <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-300 mb-1">
                📦 Списано из вашего хранилища:
              </div>
              <div className="flex flex-wrap justify-center sm:justify-start gap-1">
                {order.consumedStoredReturns.map((c, i) => (
                  <Badge
                    key={i}
                    variant="secondary"
                    className="h-auto max-w-full whitespace-normal break-words [overflow-wrap:anywhere] py-1 px-2 text-center text-xs"
                  >
                    ящик «{c.box_number}» × {c.quantity}
                  </Badge>
                ))}
              </div>
            </div>
          )}
      </CardContent>
      {/* mt-auto прижимает футер к низу карточки: в грид-раскладке
          (md:grid-cols-2) карточки растягиваются до высоты самой высокой в
          ряду, и без авто-отступа кнопка «повисает» посреди карточки. */}
      <CardFooter className="mt-auto flex justify-center items-stretch">
        <Button
          variant={isDownloaded ? "default" : "secondary"}
          className={cn(
            "w-full sm:w-auto md:w-full xl:w-auto",
            isDownloaded && "bg-green-600 text-white hover:bg-green-700",
          )}
          onClick={handleDownloadLabel}
          disabled={downloading || labelPending}
        >
          {isDownloaded
            ? "✅ Этикетка скачана"
            : downloading
              ? "⏳ Формируем этикетку…"
              : labelPending
                ? "⏳ Этикетка формируется…"
                : "📄 Скачать этикетку"}
        </Button>
      </CardFooter>
    </Card>
  );
};
