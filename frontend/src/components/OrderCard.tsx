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
import {
  ordersApi,
  Order,
  OrderProduct,
  readApiErrorPayload,
} from "../api/orders";
import { toast } from "sonner";
import { isSocketConnected } from "../lib/socket";
import { FillStatsDialog } from "./FillStatsDialog";
import { OrderProductsList } from "./OrderProductsList";

// Размер файла в человекочитаемом виде (МБ)
const formatSize = (bytes: number | null | undefined) => {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return ` · ${mb >= 1 ? `${mb.toFixed(1)} МБ` : `${(bytes / 1024).toFixed(0)} КБ`}`;
};

interface OrderCardProps {
  order: Order;
  onOrderUpdated: () => void;
}

export const OrderCard = ({ order, onOrderUpdated }: OrderCardProps) => {
  const [loading, setLoading] = useState(false);
  // Скачивание моделей: индикаторы по offer_id (одноразовый токен + скачивание)
  const [modelLoading, setModelLoading] = useState<Record<string, boolean>>({});

  const handleFinish = async () => {
    if (!confirm(`Завершить заказ ${order.orderId}?`)) return;
    setLoading(true);
    try {
      const result = await ordersApi.finishOrder(order.orderId);
      toast.success(
        `Заказ ${order.orderId} завершён! Заработок: ${result.earnings} руб.`,
      );
      onOrderUpdated();
    } catch (err: any) {
      toast.error(err.message || "Ошибка завершения заказа");
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!confirm(`Отменить заказ ${order.orderId}?`)) return;
    setLoading(true);
    try {
      await ordersApi.cancelOrder(order.orderId);
      toast.success(`Заказ ${order.orderId} отменён`);
      onOrderUpdated();
    } catch (err: any) {
      toast.error(err.message || "Ошибка отмены заказа");
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadLabel = async () => {
    try {
      const blob = await ordersApi.getLabel(order.orderId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `label_${order.orderId}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      // Кулдаун: при подключённом сокете live-тост уже ушёл по WebSocket —
      // локальный не дублируем; сокет отключён -> показываем локально (fallback);
      // иначе показываем текст из тела ошибки (Blob при responseType: "blob")
      const payload = await readApiErrorPayload(err);
      if (payload?.cooldown && isSocketConnected()) return;
      toast.error(
        payload?.error || err.message || "Не удалось скачать этикетку",
      );
    }
  };

  // Скачивание 3D-модели товара: токен -> zip (прямых ссылок на S3 нет)
  const handleDownloadModel = async (offerId: string, fileName: string) => {
    setModelLoading((prev) => ({ ...prev, [offerId]: true }));
    try {
      const grant = await ordersApi.requestModelToken(offerId);
      const blob = await ordersApi.downloadModelByToken(grant.token);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = grant.fileName || fileName;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success(`Модель ${grant.fileName} скачана`);
    } catch (err: any) {
      const message =
        err.response?.data?.error || err.message || "Не удалось скачать модель";
      toast.error(message);
    } finally {
      setModelLoading((prev) => ({ ...prev, [offerId]: false }));
    }
  };

  // Дополнительный блок под товаром в общем списке состава: кнопка «Скачать
  // 3D-модель» (если для артикула есть zip). Разметка состава и фото — в
  // OrderProductsList, она общая с карточками «Завершённых заказов».
  const renderProductExtra = (p: OrderProduct) => {
    const offerId = p.offer_id;
    const model = p.model;
    if (!offerId || !model) return null;
    return (
      <div className="flex flex-col items-center mt-5 w-full min-w-0 px-2 gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={!!modelLoading[offerId]}
          onClick={() => handleDownloadModel(offerId, model.fileName)}
          title={`Скачать 3D-модель: ${model.fileName}${formatSize(model.fileSize)}`}
          className="
        h-auto min-w-0 max-w-full
        whitespace-normal
        flex flex-wrap items-center justify-center gap-x-1 gap-y-0.5
        text-center leading-tight
        py-1.5 px-3
      "
        >
          <span className="shrink-0">
            {modelLoading[offerId] ? "⏳ Скачивание…" : "⬇️ Скачать модель"}
          </span>
          <span className="text-muted-foreground break-all [overflow-wrap:anywhere] min-w-0">
            ({model.fileName}
            {formatSize(model.fileSize)})
          </span>
        </Button>

        {/* Модель взята у родительского артикула */}
        {model.offerId !== offerId && (
          <p className="text-xs text-muted-foreground text-center break-all [overflow-wrap:anywhere] min-w-0 max-w-full">
            🧩 Модель родительского артикула{" "}
            <code className="break-all">{model.offerId}</code>
          </p>
        )}
      </div>
    );
  };

  const missingOfferIds = order.missingStats || [];

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
          <Badge
            variant={order.statsStatus === "filled" ? "default" : "destructive"}
          >
            {order.statsStatus === "filled"
              ? "✅ Статистика заполнена"
              : "⚠️ Нужна статистика"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-center sm:text-start md:text-center xl:text-start">
        <div className="text-sm text-muted-foreground">
          Назначен: {new Date(order.assignedAt).toLocaleString()}
        </div>
        {missingOfferIds.length > 0 && (
          <div className="text-sm text-red-500 space-y-1">
            <div>Отсутствует статистика для:</div>
            <div className="flex flex-wrap gap-1 justify-center sm:justify-start md:justify-center xl:justify-start">
              {missingOfferIds.map((id) => (
                <Badge key={id} variant="outline" className="cursor-pointer">
                  <code>{id}</code>
                </Badge>
              ))}
            </div>
          </div>
        )}
        <OrderProductsList
          products={order.products}
          renderProductExtra={renderProductExtra}
          alignClassName="text-center sm:text-start md:text-center xl:text-start justify-center sm:justify-start md:justify-center xl:justify-start"
        />
      </CardContent>
      {/* mt-auto прижимает футер к низу карточки: в грид-раскладке
          (md:grid-cols-2) карточки растягиваются до высоты самой высокой в
          ряду, и без авто-отступа кнопки «повисают» посреди карточки. */}
      <CardFooter className="mt-auto flex flex-col gap-2 items-stretch sm:flex-row md:flex-col xl:flex-row xl:items-center">
        <Button
          onClick={handleFinish}
          disabled={loading || order.statsStatus === "missing"}
        >
          ✅ Завершить
        </Button>

        <Button variant="outline" onClick={handleCancel} disabled={loading}>
          ❌ Отменить
        </Button>

        <Button
          variant="secondary"
          className="ml-0 sm:ml-auto md:ml-0 xl:ml-auto"
          onClick={handleDownloadLabel}
          disabled={loading}
        >
          📄 Скачать этикетку
        </Button>
      </CardFooter>
      {missingOfferIds.length > 0 && (
        <div
          className="flex flex-col items-center justify-center gap-2 text-center px-6 pb-4
                  sm:flex-row sm:items-center sm:justify-between sm:text-start
                  md:flex-col md:items-center md:justify-center md:text-center
                  xl:flex-row xl:items-center xl:justify-between xl:text-start"
        >
          <FillStatsDialog
            offerId={missingOfferIds[0]}
            onSuccess={onOrderUpdated}
          >
            <Button variant="outline" size="sm">
              📝 Заполнить статистику
            </Button>
          </FillStatsDialog>
          {missingOfferIds.length > 1 && (
            <span className="text-xs text-muted-foreground">
              + ещё {missingOfferIds.length - 1} товаров без статистики
            </span>
          )}
        </div>
      )}
    </Card>
  );
};
