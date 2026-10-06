import { useState } from "react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ordersApi, CompletedOrder, readApiErrorPayload } from "../api/orders";
import { toast } from "sonner";
import { isSocketConnected } from "../lib/socket";
import { OrderProductsList } from "./OrderProductsList";

interface CompletedOrderCardProps {
  order: CompletedOrder;
}

/**
 * Карточка завершённого заказа, ожидающего отправки (awaiting_deliver) —
 * вкладка «🗳️ Завершённые заказы». Состав и фотографии такие же, как у
 * активного заказа, но действие одно: скачать этикетку (Ozon getPackageLabel).
 */
export const CompletedOrderCard = ({ order }: CompletedOrderCardProps) => {
  // Формирование этикетки в Ozon — задача с опросом готовности (до ~2 минут),
  // поэтому кнопку блокируем до ответа сервера.
  const [downloading, setDownloading] = useState(false);

  const handleDownloadLabel = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const blob = await ordersApi.getLabel(order.orderId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `label_${order.orderId}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success(`Этикетка заказа ${order.orderId} скачана`);
    } catch (err: unknown) {
      // Кулдаун: при подключённом сокете live-тост уже ушёл по WebSocket —
      // локальный не дублируем; сокет отключён -> показываем локально (fallback)
      const payload = await readApiErrorPayload(err);
      if (payload?.cooldown && isSocketConnected()) return;
      toast.error(
        payload?.error ||
          (err as Error)?.message ||
          "Не удалось скачать этикетку",
      );
    } finally {
      setDownloading(false);
    }
  };

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
      </CardContent>
      {/* mt-auto прижимает футер к низу карточки: в грид-раскладке
          (md:grid-cols-2) карточки растягиваются до высоты самой высокой в
          ряду, и без авто-отступа кнопка «повисает» посреди карточки. */}
      <CardFooter className="mt-auto flex justify-center items-stretch">
        <Button
          variant="secondary"
          className="w-full sm:w-auto md:w-full xl:w-auto"
          onClick={handleDownloadLabel}
          disabled={downloading}
        >
          {downloading ? "⏳ Формируем этикетку..." : "📄 Скачать этикетку"}
        </Button>
      </CardFooter>
    </Card>
  );
};
