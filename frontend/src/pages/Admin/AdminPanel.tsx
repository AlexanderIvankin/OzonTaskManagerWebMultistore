import { useEffect, useState } from "react";
import {
  adminApi,
  User,
  ClientBlacklistItem,
  getBlobErrorMessage,
} from "../../api/admin";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { FillStatsDialog } from "../../components/FillStatsDialog";

// ======================================================================
// Админская панель — инструменты (аналоги команд бота):
//   /order_details, /admin_send_label (по имени),
//   /admin_fill_stats, /clear_product_stats, /clear_assignments,
//   /pause и /resume.
// Завершённые заказы вынесены на отдельную страницу «Завершённые заказы»
// (frontend/src/pages/Admin/CompletedOrders.tsx). Навигация по вкладкам
// админки выполняется через Layout (сайдбар), поэтому здесь собраны
// только инструменты, без дублирующих вкладок.
// ======================================================================

interface OzonOrderProduct {
  name?: string;
  sku?: number | string;
  offer_id?: string;
  quantity?: number;
  price?: { amount?: string; currency?: string };
}

interface OzonOrderDetails {
  posting_number?: string;
  order_number?: string;
  status?: string;
  substatus?: string;
  delivery_method?: {
    name?: string;
    warehouse_id?: string | number | null;
  };
  products?: OzonOrderProduct[];
  customer?: {
    name?: string;
    phone?: string;
    address?: {
      address_tail?: string;
      city?: string;
      region?: string;
      zip_code?: string;
    };
  };
  tracking_number?: string;
  in_process_at?: string;
}

const formatDateTime = (ts: number | string) =>
  new Date(ts).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

// Скачивание Blob (PDF-этикетка) в браузер
const downloadBlob = (blob: Blob, fileName: string) => {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  window.URL.revokeObjectURL(url);
};

// Сотрудник по ID (для подписей)
const employeeName = (employees: User[], id: string) =>
  employees.find((e) => String(e.id) === id)?.name || `ID ${id}`;

export const AdminPanel = () => {
  // === Общие данные: сотрудники и названия складов ===
  const [employees, setEmployees] = useState<User[]>([]);
  const [warehouseNames, setWarehouseNames] = useState<Map<string, string>>(
    new Map(),
  );

  // === Детали заказа (/order_details) ===
  const [detailsOrderId, setDetailsOrderId] = useState("");
  const [details, setDetails] = useState<OzonOrderDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  // === Этикетка заказа (/admin_send_label) ===
  const [labelOrderId, setLabelOrderId] = useState("");
  // "self" — скачать себе, иначе — ID сотрудника (отправить ему)
  const [labelTarget, setLabelTarget] = useState("self");
  const [labelBusy, setLabelBusy] = useState(false);

  // === Статистика товара (/admin_fill_stats, /clear_product_stats) ===
  const [statsOfferId, setStatsOfferId] = useState("");
  const [deleteStatsOpen, setDeleteStatsOpen] = useState(false);
  const [deletingStats, setDeletingStats] = useState(false);

  // === Чёрный список клиентов (глобальный) ===
  const [clientBlacklist, setClientBlacklist] = useState<ClientBlacklistItem[]>(
    [],
  );
  const [blLoading, setBlLoading] = useState(false);
  const [blNewId, setBlNewId] = useState("");
  const [blNewReason, setBlNewReason] = useState("");
  const [blAdding, setBlAdding] = useState(false);
  const [blRemovingId, setBlRemovingId] = useState<string | null>(null);

  // === Сброс всех назначений (/clear_assignments) ===
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  // === Авто-проверка очереди (/pause, /resume) ===
  const [schedulerPaused, setSchedulerPaused] = useState<boolean | null>(null);
  const [schedulerBusy, setSchedulerBusy] = useState(false);

  // Сотрудники для выбора по имени: только не уволенные и не роль «user»
  const loadEmployees = async () => {
    try {
      const users = await adminApi.getUsers({
        includeAll: true,
        includeFired: false,
      });
      setEmployees(users.filter((u) => u.role !== "user"));
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить сотрудников");
    }
  };

  // Названия складов — для отображения склада в деталях заказа
  const loadWarehouseNames = async () => {
    try {
      const warehouses = await adminApi.getWarehouses();
      setWarehouseNames(
        new Map(warehouses.map((w) => [String(w.warehouse_id), w.name])),
      );
    } catch {
      // Некритично: покажем ID склада без названия
    }
  };

  const loadSchedulerStatus = async () => {
    try {
      const data = await adminApi.getSchedulerStatus();
      setSchedulerPaused(data.paused);
    } catch {
      setSchedulerPaused(null);
    }
  };

  const loadClientBlacklist = async () => {
    setBlLoading(true);
    try {
      const data = await adminApi.getClientBlacklist();
      setClientBlacklist(data.items || []);
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить чёрный список");
    } finally {
      setBlLoading(false);
    }
  };

  useEffect(() => {
    loadEmployees();
    loadWarehouseNames();
    loadSchedulerStatus();
    loadClientBlacklist();
  }, []);

  // === /order_details <номер_заказа> ===
  const handleLoadDetails = async () => {
    const orderId = detailsOrderId.trim();
    if (!orderId) return;
    setDetailsLoading(true);
    try {
      const data = await adminApi.getOrderDetails(orderId);
      setDetails(data);
    } catch (err: any) {
      setDetails(null);
      toast.error(
        err.response?.data?.error ||
          err.message ||
          "Не удалось получить детали заказа",
      );
    } finally {
      setDetailsLoading(false);
    }
  };

  // === /blacklist <client_id> ===

  const handleAddBlacklist = async () => {
    const clientId = blNewId.trim();
    if (!clientId) {
      toast.error("Укажите client_id");
      return;
    }
    setBlAdding(true);
    try {
      await adminApi.addToClientBlacklist(
        clientId,
        blNewReason.trim() || undefined,
      );
      toast.success(`Клиент ${clientId} добавлен в чёрный список`);
      setBlNewId("");
      setBlNewReason("");
      await loadClientBlacklist();
    } catch (err: any) {
      toast.error(
        err.response?.data?.error ||
          err.message ||
          "Не удалось добавить в чёрный список",
      );
    } finally {
      setBlAdding(false);
    }
  };

  const handleRemoveBlacklist = async (clientId: string) => {
    if (!confirm(`Удалить клиента ${clientId} из чёрного списка?`)) return;
    setBlRemovingId(clientId);
    try {
      await adminApi.removeFromClientBlacklist(clientId);
      toast.success(`Клиент ${clientId} удалён из чёрного списка`);
      await loadClientBlacklist();
    } catch (err: any) {
      toast.error(
        err.response?.data?.error ||
          err.message ||
          "Не удалось удалить из чёрного списка",
      );
    } finally {
      setBlRemovingId(null);
    }
  };

  // === /admin_send_label <номер_заказа> (себе) ===
  const handleDownloadLabel = async () => {
    const orderId = labelOrderId.trim();
    if (!orderId) return;
    setLabelBusy(true);
    try {
      const res = await adminApi.downloadOrderLabel(orderId);
      downloadBlob(res.data, `label_${orderId}.pdf`);
      toast.success(`Этикетка заказа ${orderId} скачана`);
    } catch (err: any) {
      const msg = await getBlobErrorMessage(err, "Не удалось скачать этикетку");
      const isPending =
        typeof msg === "string" &&
        (msg.includes("Этикетка ещё не доступна") ||
          msg.includes("формируется") ||
          msg.includes("не готова"));

      if (isPending) {
        toast.info(msg, {
          description:
            "Заказ ещё не в awaiting_deliver. Повторите через минуту.",
        });
      } else {
        toast.error(msg);
      }
    } finally {
      setLabelBusy(false);
    }
  };

  // === /admin_send_label <номер_заказа> <имя_сотрудника> ===
  const handleSendLabel = async () => {
    const orderId = labelOrderId.trim();
    if (!orderId || labelTarget === "self") return;
    setLabelBusy(true);
    try {
      const result = await adminApi.sendOrderLabelToEmployee(
        orderId,
        parseInt(labelTarget, 10),
      );
      toast.success(result.message || "Этикетка отправлена сотруднику");
    } catch (err: any) {
      toast.error(
        err.response?.data?.error ||
          err.message ||
          "Не удалось отправить этикетку",
      );
    } finally {
      setLabelBusy(false);
    }
  };

  // === /clear_product_stats <offer_id> ===
  const handleDeleteStats = async () => {
    const offerId = statsOfferId.trim();
    if (!offerId) return;
    setDeletingStats(true);
    try {
      const result = await adminApi.deleteProductStats(offerId);
      toast.success(result.message || "Статистика удалена");
      setDeleteStatsOpen(false);
    } catch (err: any) {
      toast.error(
        err.response?.data?.error ||
          err.message ||
          "Не удалось удалить статистику",
      );
    } finally {
      setDeletingStats(false);
    }
  };

  // === /clear_assignments ===
  const handleClearAssignments = async () => {
    setClearing(true);
    try {
      const result = await adminApi.clearAssignments();
      toast.success(result.message || "Все назначения сброшены");
      setClearOpen(false);
    } catch (err: any) {
      toast.error(
        err.response?.data?.error ||
          err.message ||
          "Не удалось сбросить назначения",
      );
    } finally {
      setClearing(false);
    }
  };

  // === /pause ===
  const handlePause = async () => {
    setSchedulerBusy(true);
    try {
      const result = await adminApi.pauseScheduler();
      setSchedulerPaused(true);
      toast.success(result.message || "Авто-проверка приостановлена");
    } catch (err: any) {
      toast.error(err.message || "Не удалось приостановить авто-проверку");
    } finally {
      setSchedulerBusy(false);
    }
  };

  // === /resume ===
  const handleResume = async () => {
    setSchedulerBusy(true);
    try {
      const result = await adminApi.resumeScheduler();
      setSchedulerPaused(false);
      toast.success(result.message || "Авто-проверка возобновлена");
    } catch (err: any) {
      toast.error(err.message || "Не удалось возобновить авто-проверку");
    } finally {
      setSchedulerBusy(false);
    }
  };

  return (
    <div className="space-y-6 text-center md:text-start">
      <div>
        <h1 className="text-2xl font-bold">⚙️ Админская панель</h1>
        <p className="text-sm text-muted-foreground">
          Инструменты-аналоги команд бота. Навигация по разделам — в меню слева.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* === /order_details <номер_заказа> === */}
        <Card>
          <CardHeader className="text-center">
            <CardTitle>📄 Детали заказа</CardTitle>
            <CardDescription>
              Аналог /order_details: статус, склад, состав, получатель
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col flex-wrap space-y-4 justify-center lg:justify-start">
            <div className="flex flex-col space-y-3 items-center">
              <div className="flex flex-col items-center justify-center gap-4 sm:flex-row sm:flex-wrap lg:flex-col lg:items-center xl:flex-row xl:flex-nowrap xl:items-end">
                <div className="flex flex-col items-center gap-2">
                  <Label htmlFor="details-order">Номер заказа</Label>
                  <Input
                    id="details-order"
                    placeholder="12345678-0001-1"
                    className="w-full sm:w-64"
                    value={detailsOrderId}
                    onChange={(e) => setDetailsOrderId(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleLoadDetails()}
                  />
                </div>
              </div>
              <Button
                onClick={handleLoadDetails}
                disabled={detailsLoading || !detailsOrderId.trim()}
              >
                {detailsLoading ? "Загрузка..." : "Показать"}
              </Button>
            </div>

            {details && (
              <div className="space-y-2 rounded-md bg-muted/50 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{details.status || "—"}</Badge>
                  {details.substatus && (
                    <Badge variant="outline">{details.substatus}</Badge>
                  )}
                </div>
                <p>
                  <b>Номер заказа:</b>{" "}
                  <code>
                    {details.order_number || details.posting_number || "—"}
                  </code>
                </p>
                <p>
                  <b>Метод доставки:</b> {details.delivery_method?.name || "—"}
                </p>
                {details.delivery_method?.warehouse_id && (
                  <p>
                    <b>Склад:</b>{" "}
                    {warehouseNames.get(
                      String(details.delivery_method.warehouse_id),
                    ) || "неизвестный"}{" "}
                    (ID: <code>{details.delivery_method.warehouse_id}</code>)
                  </p>
                )}
                {details.products && details.products.length > 0 && (
                  <div>
                    <p className="font-semibold">Товары:</p>
                    <ul className="list-inside list-decimal space-y-1">
                      {details.products.map((p, idx) => (
                        <li key={idx}>
                          {p.name || "—"} — {p.quantity ?? 1} шт.
                          {p.offer_id && (
                            <>
                              {" "}
                              (offer_id: <code>{p.offer_id}</code>)
                            </>
                          )}
                          {p.price?.amount && (
                            <span className="text-muted-foreground">
                              {" "}
                              — {p.price.amount} {p.price.currency || "RUB"}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {details.customer && (
                  <p>
                    <b>Получатель:</b> {details.customer.name || "—"}
                    {details.customer.phone
                      ? `, тел: ${details.customer.phone}`
                      : ""}
                  </p>
                )}
                {details.customer?.address && (
                  <p className="text-muted-foreground">
                    Адрес:{" "}
                    {[
                      details.customer.address.address_tail,
                      details.customer.address.city,
                      details.customer.address.region,
                      details.customer.address.zip_code,
                    ]
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </p>
                )}
                {details.tracking_number && (
                  <p>
                    <b>Трек-номер:</b> <code>{details.tracking_number}</code>
                  </p>
                )}
                {details.in_process_at && (
                  <p className="text-muted-foreground">
                    Дата создания: {formatDateTime(details.in_process_at)}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* === 🚫 Чёрный список клиентов (глобальный, users.db) === */}
        <Card className="border-destructive/40">
          <CardHeader className="text-center">
            <CardTitle>🚫 Чёрный список клиентов</CardTitle>
            <CardDescription>
              Клиенты, которые постоянно отменяют заказы. Список{" "}
              <b>глобальный</b> — вредитель один, магазинов много. Заказы таких
              клиентов подсвечиваются в очереди и могут скрываться фильтром.
              <br />
              <span className="text-xs">
                <code>client_id</code> — первая часть номера заказа Ozon:{" "}
                <code>91703548-0052-1</code> → <code>91703548</code>.
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Форма добавления */}
            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1.5">
                <Label className="justify-center" htmlFor="bl-client-id">client_id</Label>
                <Input
                  id="bl-client-id"
                  placeholder="91703548"
                  value={blNewId}
                  onChange={(e) => setBlNewId(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddBlacklist()}
                  className="font-mono"
                />
              </div>
              <div className="flex-[2] space-y-1.5">
                <Label className="justify-center" htmlFor="bl-reason">Причина (опционально)</Label>
                <Input
                  id="bl-reason"
                  placeholder="Постоянные отмены (5 из 7 за неделю)"
                  value={blNewReason}
                  onChange={(e) => setBlNewReason(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddBlacklist()}
                />
              </div>
              <Button
                onClick={handleAddBlacklist}
                disabled={blAdding || !blNewId.trim()}
                className="sm:w-auto w-full"
              >
                {blAdding ? "Добавление..." : "➕ Добавить"}
              </Button>
            </div>

            {/* Таблица */}
            {blLoading ? (
              <div className="text-center py-4 text-sm text-muted-foreground">
                Загрузка...
              </div>
            ) : clientBlacklist.length === 0 ? (
              <div className="text-center py-4 text-sm text-muted-foreground">
                Чёрный список пуст
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-center justifu-center">client_id</TableHead>
                    <TableHead className="text-center">Причина</TableHead>
                    <TableHead className="text-center hidden md:table-cell">
                      Добавил
                    </TableHead>
                    <TableHead className="text-center hidden lg:table-cell">
                      Дата
                    </TableHead>
                    <TableHead className="text-center">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clientBlacklist.map((item) => (
                    <TableRow key={item.client_id}>
                      <TableCell className="text-center">
                        <code className="font-bold">{item.client_id}</code>
                      </TableCell>
                      <TableCell className="text-center text-sm">
                        {item.reason || (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center hidden md:table-cell text-sm text-muted-foreground">
                        {item.added_by_name ||
                          (item.added_by ? `ID ${item.added_by}` : "—")}
                      </TableCell>
                      <TableCell className="text-center hidden lg:table-cell text-xs text-muted-foreground">
                        {new Date(item.added_at).toLocaleString("ru-RU")}
                      </TableCell>
                      <TableCell className="text-center">
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleRemoveBlacklist(item.client_id)}
                          disabled={blRemovingId === item.client_id}
                          title="Удалить из чёрного списка"
                        >
                          {blRemovingId === item.client_id ? "⏳" : "🗑"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* === /admin_send_label <номер_заказа> [имя_сотрудника] === */}
        <Card>
          <CardHeader className="text-center">
            <CardTitle>🏷️ Этикетка заказа</CardTitle>
            <CardDescription>
              Аналог /admin_send_label: скачать PDF себе или отправить
              сотруднику (выбирается по имени)
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col flex-wrap space-y-4 justify-center lg:justify-start">
            <div className="flex flex-col space-y-3 items-center">
              <div className="flex flex-col items-center justify-center gap-4 sm:flex-row sm:flex-wrap lg:flex-col lg:items-center xl:flex-row xl:flex-nowrap xl:items-end">
                <div className="flex flex-col items-center gap-2">
                  <Label htmlFor="label-order">Номер заказа</Label>
                  <Input
                    id="label-order"
                    placeholder="12345678-0001-1"
                    className="w-full sm:w-64"
                    value={labelOrderId}
                    onChange={(e) => setLabelOrderId(e.target.value)}
                  />
                </div>
                <div className="flex flex-col items-center gap-2">
                  <Label>Получатель</Label>
                  <Select
                    value={labelTarget}
                    onValueChange={(v) => setLabelTarget(v ?? "self")}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Себе (скачать PDF)">
                        {(val) =>
                          !val || val === "self"
                            ? "📥 Себе (скачать PDF)"
                            : employeeName(employees, String(val))
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="self">
                        📥 Себе (скачать PDF)
                      </SelectItem>
                      {employees.map((e) => (
                        <SelectItem key={e.id} value={String(e.id)}>
                          👤 {e.name} (ID: {e.id})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-col items-center justify-center gap-2 sm:flex-row sm:flex-wrap">
                <Button
                  variant="outline"
                  onClick={handleDownloadLabel}
                  disabled={labelBusy || !labelOrderId.trim()}
                >
                  {labelBusy ? "Обработка..." : "⬇️ Скачать себе"}
                </Button>
                <Button
                  onClick={handleSendLabel}
                  disabled={
                    labelBusy || !labelOrderId.trim() || labelTarget === "self"
                  }
                >
                  {labelBusy ? "Отправка..." : "📤 Отправить сотруднику"}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Этикетка доступна только для заказов в статусе «awaiting_deliver».
              Сотруднику придёт оповещение с кнопкой скачивания PDF.
            </p>
          </CardContent>
        </Card>

        {/* === /admin_fill_stats + /clear_product_stats === */}
        <Card>
          <CardHeader className="text-center">
            <CardTitle>📝 Статистика товара</CardTitle>
            <CardDescription>
              Аналог /admin_fill_stats и /clear_product_stats: заполнить/
              обновить (материал, цвет, вес) или удалить статистику по артикулу
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col flex-wrap space-y-4 justify-center lg:justify-start">
            <div className="flex flex-col space-y-3 items-center">
              <div className="flex flex-col flex-wrap items-center justify-center gap-4 sm:flex-row sm:flex-wrap sm:items-end">
                <div className="flex flex-col items-center gap-2">
                  <Label htmlFor="stats-offer">Артикул (offer_id)</Label>
                  <Input
                    id="stats-offer"
                    placeholder="2001867564-N"
                    className="w-full sm:w-64"
                    value={statsOfferId}
                    onChange={(e) => setStatsOfferId(e.target.value)}
                  />
                </div>

                {/* Заполнение/обновление статистики */}
                {/* Убрали лишние обертки, кнопки теперь выстроятся ровно рядом с инпутом */}
                <div className="flex flex-wrap justify-center gap-2">
                  <FillStatsDialog
                    offerId={statsOfferId.trim()}
                    onSuccess={() =>
                      toast.success(
                        `Статистика ${statsOfferId.trim()} сохранена`,
                      )
                    }
                  >
                    <Button disabled={!statsOfferId.trim()}>
                      📝 Заполнить / обновить
                    </Button>
                  </FillStatsDialog>
                  <Button
                    variant="destructive"
                    disabled={!statsOfferId.trim()}
                    onClick={() => setDeleteStatsOpen(true)}
                  >
                    🗑 Удалить статистику
                  </Button>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Заполнение доступно и для существующей статистики — данные будут
              перезаписаны (upsert). Удаление требует подтверждения.
            </p>
          </CardContent>
        </Card>

        {/* === /clear_assignments — КРАСНАЯ, с подтверждением === */}
        <Card className="border-destructive/50">
          <CardHeader className="text-center">
            <CardTitle className="text-destructive">
              ⚠️ Сброс всех назначений
            </CardTitle>
            <CardDescription>
              Аналог /clear_assignments: снять ВСЕХ сотрудников со ВСЕХ активных
              заказов и очистить состояния. Действие необратимо!
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex justify-center md:justify-start">
              <Button
                variant="destructive"
                className="w-full max-w-[340px] md:max-w-none bg-destructive text-white hover:bg-destructive/90"
                onClick={() => setClearOpen(true)}
              >
                <span className="truncate block w-full text-center">
                  ⚠️ Сбросить ВСЕ назначения
                </span>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* === /pause + /resume === */}
        <Card>
          <CardHeader className="text-center">
            <CardTitle>⏯️ Авто-проверка очереди заказов</CardTitle>
            <CardDescription>
              Аналог /pause и /resume: приостановить или возобновить
              автоматическую проверку новых заказов
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col flex-wrap space-y-4 justify-center">
            <p className="flex flex-wrap items-center justify-center gap-2 text-sm">
              Статус:{" "}
              {schedulerPaused === null ? (
                <Badge variant="outline">неизвестен</Badge>
              ) : schedulerPaused ? (
                <Badge variant="destructive">⏸ Приостановлена</Badge>
              ) : (
                <Badge>▶️ Работает</Badge>
              )}
            </p>
            <div className="flex flex-col items-center gap-2 sm:flex-row sm:flex-wrap sm:items-center justify-center">
              <Button
                variant="outline"
                onClick={handlePause}
                disabled={schedulerBusy || schedulerPaused === true}
              >
                ⏸ Пауза
              </Button>
              <Button
                onClick={handleResume}
                disabled={schedulerBusy || schedulerPaused === false}
              >
                ▶️ Возобновить
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Подтверждение удаления статистики товара (/clear_product_stats) */}
      <Dialog open={deleteStatsOpen} onOpenChange={setDeleteStatsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Удалить статистику товара?</DialogTitle>
            <DialogDescription>
              Статистика для артикула{" "}
              <code className="font-bold">{statsOfferId.trim()}</code> будет
              удалена безвозвратно. Сотрудники не смогут завершить заказы с этим
              товаром, пока статистика не будет заполнена заново.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteStatsOpen(false)}
              disabled={deletingStats}
            >
              Отмена
            </Button>
            <Button
              variant="destructive"
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleDeleteStats}
              disabled={deletingStats}
            >
              {deletingStats ? "Удаление..." : "🗑 Да, удалить"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Подтверждение сброса ВСЕХ назначений (/clear_assignments) */}
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">
              ⚠️ Сбросить ВСЕ назначения?
            </DialogTitle>
            <DialogDescription>
              Все активные назначения заказов будут удалены, сотрудники
              освободятся, а in-memory состояния заказов будут очищены.
              <br />
              <b className="text-destructive">Это действие необратимо!</b>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setClearOpen(false)}
              disabled={clearing}
            >
              ❌ Отмена
            </Button>
            <Button
              variant="destructive"
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleClearAssignments}
              disabled={clearing}
            >
              {clearing ? "Сброс..." : "⚠️ Да, сбросить ВСЕ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
