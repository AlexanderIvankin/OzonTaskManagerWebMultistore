import { useEffect, useMemo, useState } from "react";
import { adminApi, AdminActiveOrder } from "../../api/admin";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ProductImages } from "../../components/ProductImages";
import { ProductStatsBlock } from "../../components/ProductStatsBlock";
import { OrderTotalAmount } from "../../components/OrderTotalAmount";

export const ActiveOrders = () => {
  const [orders, setOrders] = useState<AdminActiveOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [unassigning, setUnassigning] = useState<{ [key: string]: boolean }>(
    {},
  );
  const [search, setSearch] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState("all");
  const [warehouseFilter, setWarehouseFilter] = useState("all");

  const loadOrders = async () => {
    setLoading(true);
    try {
      const data = await adminApi.getActiveOrders();
      setOrders(data);
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить активные заказы");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOrders();
  }, []);

  // Уникальные сотрудники из активных заказов
  const employees = useMemo(() => {
    const map = new Map<number, string>();
    orders.forEach((o) => map.set(o.userId, o.userName));
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [orders]);

  // Уникальные склады из активных заказов (ключ = ID, если есть, иначе имя)
  const warehouses = useMemo(() => {
    const map = new Map<string, string>();
    orders.forEach((o) => {
      const key = o.warehouseId || o.warehouseName || "";
      if (!key) return;
      map.set(key, o.warehouseName || `Склад ${o.warehouseId}`);
    });
    return Array.from(map, ([key, name]) => ({ key, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [orders]);

  const warehouseKeyOf = (o: AdminActiveOrder) =>
    o.warehouseId || o.warehouseName || "";

  const filtered = orders.filter((o) => {
    const q = search.trim().toLowerCase();
    if (q && !o.orderId.toLowerCase().includes(q)) return false;
    if (employeeFilter !== "all" && String(o.userId) !== employeeFilter)
      return false;
    if (warehouseFilter !== "all" && warehouseKeyOf(o) !== warehouseFilter)
      return false;
    return true;
  });

  const handleUnassign = async (order: AdminActiveOrder) => {
    if (
      !confirm(
        `Снять заказ ${order.orderId} с сотрудника ${order.userName}? Заказ вернётся в очередь.`,
      )
    )
      return;
    setUnassigning((prev) => ({ ...prev, [order.orderId]: true }));
    try {
      await adminApi.unassignOrder(order.orderId);
      toast.success(`Заказ ${order.orderId} снят и возвращён в очередь`);
      loadOrders();
    } catch (err: any) {
      toast.error(err.message || "Ошибка снятия заказа");
    } finally {
      setUnassigning((prev) => ({ ...prev, [order.orderId]: false }));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center justify-center gap-3 text-center md:flex-row md:justify-between">
        <h1 className="text-2xl font-bold text-center">
          📋 Активные заказы
          <span className="block text-muted-foreground mt-1 font-bold">
            Показано: <span className="text-blue-600">{filtered.length}</span>
            {!loading && filtered.length !== orders.length && (
              <> из {orders.length}</>
            )}
          </span>
        </h1>
        <Button onClick={loadOrders} disabled={loading}>
          🔄 Обновить
        </Button>
      </div>

      {/* Фильтры */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-2">
          <Label>Поиск по номеру заказа</Label>
          <Input
            placeholder="Например: 12345678-0001"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Сотрудник</Label>
          <Select
            value={employeeFilter}
            onValueChange={(v) => setEmployeeFilter(v ?? "all")}
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                {(val) =>
                  val === "all"
                    ? "Все сотрудники"
                    : employees.find((e) => String(e.id) === String(val))
                        ?.name || String(val)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все сотрудники</SelectItem>
              {employees.map((emp) => (
                <SelectItem key={emp.id} value={String(emp.id)}>
                  {emp.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Склад</Label>
          <Select
            value={warehouseFilter}
            onValueChange={(v) => setWarehouseFilter(v ?? "all")}
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                {(val) =>
                  val === "all"
                    ? "Все склады"
                    : warehouses.find((w) => w.key === val)?.name || String(val)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все склады</SelectItem>
              {warehouses.map((wh) => (
                <SelectItem key={wh.key} value={wh.key}>
                  {wh.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Список заказов */}
      {loading ? (
        <div className="text-center py-10 text-muted-foreground">
          Загрузка заказов...
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          {orders.length === 0
            ? "Нет активных заказов"
            : "Ничего не найдено по заданным фильтрам"}
        </div>
      ) : (
        <div className="grid gap-4">
          {filtered.map((order) => (
            <Card key={order.orderId}>
              <CardHeader>
                <CardTitle className="flex flex-col lg:flex-row flex-wrap items-center justify-center lg:justify-between gap-2">
                  <span>
                    Заказ{" "}
                    <span className="font-bold">
                      <code>{order.orderId}</code>
                    </span>
                  </span>
                  <Badge
                    variant={
                      order.statsStatus === "filled" ? "default" : "destructive"
                    }
                  >
                    {order.statsStatus === "filled"
                      ? "✅ Статистика заполнена"
                      : "⚠️ Нужна статистика"}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="grid gap-1 text-sm text-center justify-center lg:text-start lg:justify-start">
                  <div>
                    <span className="font-semibold">Сотрудник:</span>{" "}
                    <b>{order.userName}</b>{" "}
                    <span className="text-muted-foreground">
                      (ID: <code>{order.userId}</code>)
                    </span>
                  </div>
                  <div>
                    <span className="font-semibold">Назначен:</span>{" "}
                    {order.assignedAt
                      ? new Date(order.assignedAt).toLocaleString()
                      : "—"}
                  </div>
                  <div>
                    <span className="font-semibold">Склад:</span>{" "}
                    {order.warehouseName ||
                      (order.warehouseId ? (
                        <code>{order.warehouseId}</code>
                      ) : (
                        "не указан"
                      ))}
                  </div>
                </div>
                {order.missingStats.length > 0 && (
                  <div className="text-sm text-red-500 space-y-1 text-center lg:text-start">
                    <div>Отсутствует статистика для:</div>
                    <div className="flex flex-wrap justify-center gap-1 lg:justify-start">
                      {order.missingStats.map((id) => (
                        <Badge key={id} variant="outline">
                          <code>{id}</code>
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {order.products.length > 0 && (
                  <div className="mt-2">
                    <div className="font-semibold text-l text-center lg:text-start">
                      Состав:
                    </div>
                    <ul className="text-sm space-y-3">
                      {order.products.map((p, idx) => (
                        <li key={idx}>
                          <div className="mb-1 text-center lg:text-start">
                            <span className="font-bold">
                              {idx + 1}
                              {". "}
                            </span>
                            {p.name} — {p.quantity} шт.
                            {p.offer_id && (
                              <span className="text-l text-muted-foreground">
                                {" "}
                                <br></br>(offer_id:{" "}
                                <span className="font-bold">
                                  <code>{p.offer_id}</code>
                                </span>
                                )
                              </span>
                            )}
                          </div>
                          <ProductStatsBlock stats={p.stats} />
                          {p.images && p.images.length > 0 && (
                            <ProductImages
                              productName={p.name}
                              images={p.images}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                    <OrderTotalAmount products={order.products} />
                  </div>
                )}
              </CardContent>
              <CardFooter className="justify-center">
                <Button
                  variant="destructive"
                  onClick={() => handleUnassign(order)}
                  disabled={!!unassigning[order.orderId]}
                >
                  {unassigning[order.orderId] ? "Снятие..." : "❌ Снять заказ"}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};
