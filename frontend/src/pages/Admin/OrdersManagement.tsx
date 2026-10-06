import { useEffect, useState } from "react";
import { useSelector } from "react-redux";
import { RootState } from "../../store";
import { adminApi, Warehouse } from "../../api/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import type { ProductPrice, ProductStats } from "../../api/orders";

interface AwaitingOrder {
  posting_number: string;
  products: Array<{
    name: string;
    quantity: number;
    offer_id?: string;
    sku?: string;
    price?: ProductPrice;
    currency_code?: string;
    images?: Array<{ url: string; name: string }>;
    // Статистика товара (материал, цвет, вес); null — статистика не заполнена
    stats?: ProductStats | null;
  }>;
  warehouse_id?: string | number;
  analytics_data?: { warehouse?: string };
  // Полные детали заказа приходят из /admin/orders/awaiting (поле details)
  details?: {
    delivery_method?: { warehouse_id?: string | number | null };
  };
}

interface EmployeeOption {
  id: number;
  name: string;
  capacity?: number;
  active_count?: number;
  // ID складов, на которых у сотрудника стоит приоритет (user_warehouses)
  warehouses: string[];
  // Выданные 3D-модели (offer_id из issued_models)
  issuedOfferIds: string[];
  // Роль «Создатель» (god): виден в списке только самому Создателю
  isGod?: boolean;
}

type ListMode = "priority" | "all";

// === Индикатор наличия 3D-моделей у сотрудника по заказу ===
// Как в боте: 🟢 — все модели заказа уже выданы сотруднику, 🟡 — частично,
// 🔴 — ничего не выдано. Данные — issued_models (issued_offer_ids в getUsers).
// Родительские артикулы учитываются: выдача ARD000003-N покрывает -NR/-NL.
const modelCoverage = (emp: EmployeeOption, order: AwaitingOrder) => {
  const offers = (order.products || [])
    .map((p) => p.offer_id)
    .filter(Boolean) as string[];
  if (!offers.length) return { icon: "🔴", label: "нет моделей" };
  const issued = new Set(emp.issuedOfferIds || []);
  const hasIssued = (offerId: string) =>
    issued.has(offerId) ||
    (/-(NR|NL)$/.test(offerId) && issued.has(offerId.slice(0, -1)));
  const covered = offers.filter(hasIssued).length;
  if (covered === 0) return { icon: "🔴", label: "нет моделей" };
  if (covered === offers.length)
    return { icon: "🟢", label: "все модели выданы" };
  return { icon: "🟡", label: "часть моделей" };
};

// ID склада заказа: сначала верхнеуровневый warehouse_id,
// затем из полных деталей (delivery_method.warehouse_id)
const getOrderWarehouseId = (order: AwaitingOrder): string | null => {
  if (order.warehouse_id) return String(order.warehouse_id);
  const dmWarehouseId = order.details?.delivery_method?.warehouse_id;
  return dmWarehouseId ? String(dmWarehouseId) : null;
};

// Сотрудники с приоритетом на складе заказа (аналог кнопки «priority_» в боте)
const filterPriorityEmployees = (
  employees: EmployeeOption[],
  order: AwaitingOrder,
): EmployeeOption[] => {
  const warehouseId = getOrderWarehouseId(order);
  if (!warehouseId) return [];
  return employees.filter((e) => e.warehouses.includes(warehouseId));
};

// Подпись сотрудника в стиле бота:
// 🔴 Имя (ID: 123) | 📦: активные заказы | 🖨️: принтеры | 🗃️: модели
// На узких экранах (max-md) статистика переносится на вторую строку,
// чтобы не вылезать за пределы Select.
const renderEmployeeLabel = (emp: EmployeeOption, order?: AwaitingOrder) => {
  const coverage = order
    ? modelCoverage(emp, order)
    : { icon: "🔴", label: "нет моделей" };
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-center gap-x-1 text-center lg:text-left">
      <div>
        {" "}
        <span aria-hidden>{coverage.icon}</span> <b>{emp.name}</b>{" "}
        <span>
          (ID: <code>{emp.id}</code>)
        </span>
      </div>
      <span className="text-muted-foreground max-lg:w-full max-lg:whitespace-normal">
        <span className="hidden lg:inline">| </span>
        📦: {emp.active_count ?? 0} | 🖨️: {emp.capacity ?? "—"} | 🗃️:{" "}
        {coverage.label}
      </span>
    </div>
  );
};

export const OrdersManagement = () => {
  // Текущий пользователь: Создатель виден в списке сотрудников только самому себе
  // (нужен для самоназначения заказов на тестах)
  const viewer = useSelector((state: RootState) => state.auth.user);
  const [orders, setOrders] = useState<AwaitingOrder[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState<{ [key: string]: boolean }>({});
  // === Фильтр по складу (аналог /orders [warehouse_id]) ===
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  // "all" — без фильтра, иначе ID склада из warehouses
  const [warehouseFilter, setWarehouseFilter] = useState("all");

  const loadOrders = async (warehouseId?: string) => {
    setLoading(true);
    try {
      // Явно переданный ID имеет приоритет (при смене фильтра state ещё
      // не обновился); иначе берём текущий фильтр из state
      const effectiveId =
        warehouseId !== undefined
          ? warehouseId
          : warehouseFilter !== "all"
            ? warehouseFilter
            : undefined;
      const data = await adminApi.getAwaitingOrders(effectiveId);
      setOrders(data);
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить заказы");
    } finally {
      setLoading(false);
    }
  };

  // Список складов для фильтра
  const loadWarehouses = async () => {
    try {
      const data = await adminApi.getWarehouses();
      setWarehouses(data);
    } catch {
      // Некритично: фильтр просто останется пустым
    }
  };

  // Смена фильтра по складу — перезагружаем очередь с новым складом
  const handleWarehouseFilterChange = (value: string | null) => {
    const next = value ?? "all";
    setWarehouseFilter(next);
    loadOrders(next === "all" ? undefined : next);
  };
  const [selectedEmployee, setSelectedEmployee] = useState<{
    [key: string]: string | null;
  }>({});
  // Какой список сотрудников показывать: приоритетные по складу или все
  const [listMode, setListMode] = useState<{ [key: string]: ListMode }>({});

  const loadEmployees = async () => {
    try {
      const users = await adminApi.getUsers({
        includeAll: true,
        includeFired: false,
        // Запрашиваем склады (приоритеты) и число активных заказов
        withWarehouses: true,
      });
      const emp: EmployeeOption[] = users
        .filter((u) => u.role !== "user" && u.taking_orders)
        .map((u) => ({
          id: u.id,
          name: u.name,
          capacity: u.capacity,
          active_count: u.active_count ?? 0,
          warehouses: (u.warehouses || []).map((w) => String(w.warehouse_id)),
          issuedOfferIds: u.issued_offer_ids || [],
          isGod: u.role === "god",
        }));
      setEmployees(emp);
    } catch (err: any) {
      toast.error("Не удалось загрузить сотрудников");
    }
  };

  // Список сотрудников, доступный текущему зрителю: Создатель (роль 'god')
  // показывается в списке только самому себе — для остальных он скрыт,
  // чтобы не мешал при обычной выдаче заказов (у Создателя есть свои тестовые
  // заказы, которые он сам себе и назначает)
  const visibleEmployees = employees.filter(
    (e) => viewer?.role === "god" || !e.isGod,
  );

  // Переключение списка сотрудников для заказа. Если выбранный сотрудник
  // не входит в новый список — сбрасываем выбор (как «🔙 Назад» в боте)
  const changeListMode = (order: AwaitingOrder, mode: ListMode) => {
    setListMode((prev) => ({ ...prev, [order.posting_number]: mode }));
    const current = selectedEmployee[order.posting_number];
    if (!current) return;
    const targetList =
      mode === "priority"
        ? filterPriorityEmployees(visibleEmployees, order)
        : visibleEmployees;
    if (!targetList.some((e) => String(e.id) === String(current))) {
      setSelectedEmployee((prev) => ({
        ...prev,
        [order.posting_number]: null,
      }));
    }
  };

  useEffect(() => {
    loadOrders();
    loadEmployees();
    loadWarehouses();
  }, []);

  const handleAssign = async (orderId: string, employeeId: string) => {
    if (!employeeId) {
      toast.error("Выберите сотрудника");
      return;
    }
    setAssigning((prev) => ({ ...prev, [orderId]: true }));
    try {
      await adminApi.assignOrder(orderId, parseInt(employeeId));
      toast.success(`Заказ ${orderId} назначен`);
      loadOrders();
    } catch (err: any) {
      toast.error(err.message || "Ошибка назначения");
    } finally {
      setAssigning((prev) => ({ ...prev, [orderId]: false }));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center justify-center gap-3 text-center lg:flex-row lg:justify-between">
        <h1 className="text-2xl font-bold text-center">
          ⏳ Очередь заказов (awaiting_packaging)
          <span className="block text-muted-foreground mt-1">
            Число заказов в очереди:{" "}
            <span className="text-blue-600">{orders.length}</span>
          </span>
        </h1>
        <div className="flex flex-col items-center gap-2 md:flex-row md:items-end">
          {/* Фильтр по складу (аналог /orders [warehouse_id]) */}
          <div className="flex flex-col items-center md:items-start">
            <Label className="mb-[8px]">Склад</Label>
            <Select
              value={warehouseFilter}
              onValueChange={handleWarehouseFilterChange}
            >
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue placeholder="Все склады">
                  {(val) =>
                    !val || val === "all"
                      ? "🌐 Все склады"
                      : warehouses.find(
                          (w) => String(w.warehouse_id) === String(val),
                        )?.name || String(val)
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">🌐 Все склады</SelectItem>
                {warehouses.map((wh) => (
                  <SelectItem
                    key={wh.warehouse_id}
                    value={String(wh.warehouse_id)}
                  >
                    {wh.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={() => loadOrders()} disabled={loading}>
            🔄 Обновить
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-10 text-muted-foreground">
          Загрузка заказов...
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          Нет заказов в очереди
        </div>
      ) : (
        <div className="grid gap-4">
          {orders.map((order) => {
            const warehouseId = getOrderWarehouseId(order);
            const priorityEmployees = filterPriorityEmployees(
              visibleEmployees,
              order,
            );
            // По умолчанию показываем приоритетных по складу (как в боте),
            // если склад заказа известен
            const mode: ListMode =
              listMode[order.posting_number] ??
              (warehouseId ? "priority" : "all");
            const list =
              mode === "priority" ? priorityEmployees : visibleEmployees;
            return (
              <Card key={order.posting_number}>
                <CardHeader>
                  <CardTitle className="flex text-center justify-center lg:text-start lg:justify-start">
                    Заказ{" "}
                    <span className="font-bold">
                      <code>{order.posting_number}</code>
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <div className="font-semibold mb-1 text-center lg:text-start">Склад:</div>
                    <div className="text-center lg:text-start">
                      {order.analytics_data?.warehouse || "не указан"}
                      {warehouseId && (
                        <span className="text-sm text-muted-foreground">
                          {" "}
                          (ID:{" "}
                          <span className="font-bold">
                            <code>{warehouseId}</code>
                          </span>
                          )
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="font-semibold text-l text-center lg:text-start">Состав:</div>
                    <ul className="text-sm space-y-5">
                      {order.products?.map((p, idx) => (
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
                    <OrderTotalAmount products={order.products || []} />
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex-1 space-y-2">
                      {/* Выбор списка: приоритетные по складу / все (как в боте) */}
                      <div className="flex flex-wrap items-center gap-2 justify-center lg:justify-start">
                        <span className="text-sm font-medium text-muted-foreground">
                          Список:
                        </span>
                        <div className="flex flex-wrap justify-center items-center gap-2 lg:justify-start">
                          {" "}
                          <Button
                            size="sm"
                            variant={
                              mode === "priority" ? "default" : "outline"
                            }
                            onClick={() => changeListMode(order, "priority")}
                            disabled={!warehouseId}
                            title={
                              warehouseId
                                ? "Сотрудники с приоритетом по складу заказа"
                                : "Склад заказа не указан"
                            }
                          >
                            <span className="inline-block align-middle -translate-y-[2px]">
                              👑
                            </span>{" "}
                            По складу ({priorityEmployees.length})
                          </Button>
                          <Button
                            size="sm"
                            variant={mode === "all" ? "default" : "outline"}
                            onClick={() => changeListMode(order, "all")}
                          >
                            <span className="inline-block align-middle -translate-y-[2px]">
                              👥
                            </span>{" "}
                            Все ({visibleEmployees.length})
                          </Button>
                          <span className="text-xs text-muted-foreground">
                            🗃️ — выданные сотруднику 3D-модели (🟢 все модели
                            заказа · 🟡 часть · 🔴 нет)
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-5">
                        <Select
                          value={selectedEmployee[order.posting_number] || ""}
                          onValueChange={(val) =>
                            setSelectedEmployee((prev) => ({
                              ...prev,
                              [order.posting_number]: val,
                            }))
                          }
                        >
                          <SelectTrigger className="w-full h-10 text-base max-lg:h-auto! max-lg:min-h-10 max-lg:py-1.5 max-lg:text-sm">
                            <SelectValue
                              className="text-base font-medium"
                              placeholder="Выберите сотрудника"
                            >
                              {(val) => {
                                if (!val) return "Выберите сотрудника";
                                // Ищем по видимым сотрудникам, чтобы выбранное
                                // значение отображалось и после смены списка
                                const emp = visibleEmployees.find(
                                  (e) => String(e.id) === String(val),
                                );
                                return emp
                                  ? renderEmployeeLabel(emp, order)
                                  : String(val);
                              }}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent className="max-lg:w-auto max-lg:max-w-[calc(100vw-2rem)]">
                            {list.length === 0 ? (
                              <div className="px-2 py-3 text-sm text-muted-foreground">
                                {mode === "priority"
                                  ? warehouseId
                                    ? "Нет сотрудников с приоритетом на этом складе — переключитесь на «Все»"
                                    : "Склад заказа не указан — выберите список «Все»"
                                  : "Нет доступных сотрудников"}
                              </div>
                            ) : (
                              list.map((emp) => (
                                <SelectItem key={emp.id} value={String(emp.id)}>
                                  {renderEmployeeLabel(emp, order)}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                        <Button
                          size="lg"
                          className="h-10 px-5 text-base w-full sm:w-auto"
                          onClick={() =>
                            handleAssign(
                              order.posting_number,
                              selectedEmployee[order.posting_number] || "",
                            )
                          }
                          disabled={
                            assigning[order.posting_number] ||
                            !selectedEmployee[order.posting_number]
                          }
                        >
                          {assigning[order.posting_number]
                            ? "Назначение..."
                            : "Назначить"}
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};
