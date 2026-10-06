import { useCallback, useEffect, useMemo, useState } from "react";
import { adminApi, CompletedOrderRow, User } from "../../api/admin";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
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

// Размеры страницы: 10/25/50/100 или «Все» (полная выгрузка)
const PAGE_OPTIONS = [10, 25, 50, 100];

const formatDateTime = (ts: number | string) =>
  new Date(ts).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const money = (v: number) => `${v.toFixed(2)} ₽`;

// Подсказка для строк без «слепка» (заказ завершён до сохранения суммы/состава)
const NO_SNAPSHOT_TITLE =
  "Нет данных: заказ завершён до сохранения суммы и состава заказа";

export const CompletedOrders = () => {
  // === Данные (серверная пагинация) ===
  const [rows, setRows] = useState<CompletedOrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // Сотрудники для фильтра (не уволенные и не роль «user»)
  const [employees, setEmployees] = useState<User[]>([]);

  // === Фильтры ===
  // "all" — все сотрудники, иначе ID сотрудника
  const [employeeFilter, setEmployeeFilter] = useState("all");
  // Период: week | month | all
  const [period, setPeriod] = useState("month");
  // pageSize — выбор в Select (10/25/50/100/'all'),
  // limit — сколько реально запрошено с сервера (растёт по «Загрузить ещё»)
  const [pageSize, setPageSize] = useState<number | "all">(25);
  const [limit, setLimit] = useState<number | "all">(25);

  // Поиск по номеру заказа / артикулу: *Input — поля ввода,
  // applied*Query — применённый поиск (Enter/кнопка «Найти»)
  const [orderInput, setOrderInput] = useState("");
  const [offerInput, setOfferInput] = useState("");
  const [appliedOrderQuery, setAppliedOrderQuery] = useState("");
  const [appliedOfferQuery, setAppliedOfferQuery] = useState("");

  // Сотрудники для фильтра
  useEffect(() => {
    adminApi
      .getUsers({ includeAll: true, includeFired: false })
      .then((users) => setEmployees(users.filter((u) => u.role !== "user")))
      .catch((err: any) =>
        toast.error(err.message || "Не удалось загрузить сотрудников"),
      );
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminApi.getCompletedOrders({
        userId: employeeFilter === "all" ? null : parseInt(employeeFilter, 10),
        days: period === "week" ? 7 : period === "month" ? 30 : null,
        limit,
        orderId: appliedOrderQuery || undefined,
        offerId: appliedOfferQuery || undefined,
      });
      setRows(data.items);
      setTotal(data.total);
    } catch (err: any) {
      toast.error(
        err.response?.data?.error ||
          err.message ||
          "Не удалось загрузить заказы",
      );
    } finally {
      setLoading(false);
    }
  }, [employeeFilter, period, limit, appliedOrderQuery, appliedOfferQuery]);

  useEffect(() => {
    load();
  }, [load]);

  // Смена размера страницы: сбрасываем пагинацию на выбранный размер
  const handlePageSizeChange = (v: string | null) => {
    const next: number | "all" = !v || v === "all" ? "all" : parseInt(v, 10);
    setPageSize(next);
    setLimit(next);
  };

  // Загрузить ещё: увеличиваем лимит на размер страницы
  const handleLoadMore = () => {
    setLimit((prev) =>
      typeof prev === "number" && typeof pageSize === "number"
        ? prev + pageSize
        : prev,
    );
  };

  // Применить текстовые фильтры (сброс пагинации на первую страницу)
  const applySearch = () => {
    setAppliedOrderQuery(orderInput.trim());
    setAppliedOfferQuery(offerInput.trim());
    setLimit(pageSize);
  };

  const resetSearch = () => {
    setOrderInput("");
    setOfferInput("");
    setAppliedOrderQuery("");
    setAppliedOfferQuery("");
    setLimit(pageSize);
  };

  // Итоги по загруженным строкам (для полной выгрузки — по всем отфильтрованным)
  const loadedOrderSum = useMemo(
    () =>
      rows.reduce(
        (sum, r) => (r.order_amount != null ? sum + r.order_amount : sum),
        0,
      ),
    [rows],
  );
  const loadedEarnings = useMemo(
    () => rows.reduce((sum, r) => sum + (r.amount || 0), 0),
    [rows],
  );

  const hasTextFilters = !!(appliedOrderQuery || appliedOfferQuery);

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center justify-center gap-3 text-center md:flex-row md:justify-between">
        <h1 className="text-2xl font-bold text-center">
          📜 Завершённые заказы
          <span className="block text-muted-foreground mt-1 font-bold">
            Показано: <span className="text-blue-600">{rows.length}</span>
            {!loading && rows.length !== total && <> из {total}</>}
          </span>
        </h1>
        <Button onClick={load} disabled={loading}>
          🔄 Обновить
        </Button>
      </div>

      {/* Фильтры */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <Label>Поиск по номеру заказа</Label>
          <Input
            placeholder="Например: 12345678-0001"
            value={orderInput}
            onChange={(e) => setOrderInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applySearch()}
          />
        </div>
        <div className="space-y-2">
          <Label>Поиск по артикулу (offer_id)</Label>
          <Input
            placeholder="🔖 Артикул (offer_id)..."
            value={offerInput}
            onChange={(e) => setOfferInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applySearch()}
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
                  !val || val === "all"
                    ? "Все сотрудники"
                    : employees.find((e) => String(e.id) === String(val))
                        ?.name || `ID ${val}`
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все сотрудники</SelectItem>
              {employees.map((emp) => (
                <SelectItem key={emp.id} value={String(emp.id)}>
                  {emp.name} (ID: {emp.id})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Период</Label>
          <Select value={period} onValueChange={(v) => setPeriod(v ?? "month")}>
            <SelectTrigger className="w-full">
              <SelectValue>
                {(val) =>
                  val === "week"
                    ? "За неделю"
                    : val === "month"
                      ? "За месяц"
                      : "Всё время"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="week">За неделю</SelectItem>
              <SelectItem value="month">За месяц</SelectItem>
              <SelectItem value="all">Всё время</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Кол-во</Label>
          <Select
            value={pageSize === "all" ? "all" : String(pageSize)}
            onValueChange={handlePageSizeChange}
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                {(val) => (val === "all" ? "Все" : `Последние ${val}`)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PAGE_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  Последние {n}
                </SelectItem>
              ))}
              <SelectItem value="all">Все</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          {/* Пустой невидимый лейбл для компенсации высоты */}
          <Label className="invisible select-none">Компенсация</Label>

          <div className="flex items-center flex-wrap justify-center gap-10">
            {hasTextFilters && (
              <Button variant="ghost" onClick={resetSearch}>
                ✕ Сбросить
              </Button>
            )}
            <Button variant="outline" onClick={applySearch}>
              🔎 Найти
            </Button>
          </div>
        </div>
      </div>
      {/* Таблица заказов */}
      {loading ? (
        <div className="text-center py-10 text-muted-foreground">
          Загрузка заказов...
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          {hasTextFilters
            ? "Ничего не найдено по заданным фильтрам"
            : "Нет завершённых заказов за выбранный период"}
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-center">Номер заказа</TableHead>
                  <TableHead className="text-center">
                    Артикулы (состав)
                  </TableHead>
                  <TableHead className="text-center">Сотрудник</TableHead>
                  <TableHead className="text-center">Завершён</TableHead>
                  <TableHead className="text-center">Сумма заказа</TableHead>
                  <TableHead className="text-center">Заработок</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((o) => (
                  <TableRow key={o.order_id}>
                    <TableCell className="font-medium text-center">
                      <code>{o.order_id}</code>
                    </TableCell>
                    <TableCell className="text-sm text-center">
                      {o.products && o.products.length > 0 ? (
                        <div className="space-y-1">
                          {o.products.map((p, idx) => (
                            <div key={idx}>
                              {p.offer_id ? (
                                <code>{p.offer_id}</code>
                              ) : (
                                <span className="text-muted-foreground">
                                  {p.name || "—"}
                                </span>
                              )}
                              {p.quantity && p.quantity > 1 && (
                                <span className="text-muted-foreground">
                                  {" "}
                                  × {p.quantity}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span
                          className="text-muted-foreground"
                          title={NO_SNAPSHOT_TITLE}
                        >
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-center">
                      {o.user_name}
                      <span className="block text-xs text-muted-foreground">
                        ID: {o.user_id}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-center whitespace-nowrap">
                      {formatDateTime(o.completed_at)}
                    </TableCell>
                    <TableCell className="text-sm text-center whitespace-nowrap">
                      {o.order_amount != null ? (
                        money(o.order_amount)
                      ) : (
                        <span
                          className="text-muted-foreground"
                          title={NO_SNAPSHOT_TITLE}
                        >
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-center whitespace-nowrap">
                      {o.amount > 0 ? (
                        money(o.amount)
                      ) : (
                        <span
                          className="text-muted-foreground"
                          title="Заработок за заказ не рассчитан"
                        >
                          —
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={4}>
                    Итого по загруженным заказам ({rows.length})
                  </TableCell>
                  <TableCell
                    className="text-center whitespace-nowrap"
                    title="Сумма по заказам, завершённым после сохранения «слепка»"
                  >
                    {money(loadedOrderSum)}
                  </TableCell>
                  <TableCell className="text-center whitespace-nowrap">
                    {money(loadedEarnings)}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Пагинация: «Загрузить ещё» (в режиме «Все» не требуется) */}
      {limit !== "all" && rows.length < total && (
        <div className="flex justify-center">
          <Button variant="outline" disabled={loading} onClick={handleLoadMore}>
            Загрузить ещё ({total - rows.length})
          </Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Сумма и состав заказа сохраняются в момент завершения. Для заказов,
        завершённых раньше — «—» (нет данных). Заработок берётся из истории
        расчётов (earnings_history).
      </p>
    </div>
  );
};
