import { useEffect, useMemo, useState } from "react";
import { useSelector } from "react-redux";
import { adminApi, StaffStatsRow } from "../../api/admin";
import { RootState } from "../../store";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
// import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RoleBadge } from "@/components/RoleBadge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

type SortKey =
  | "id"
  | "name"
  | "username"
  | "total_orders"
  | "canceled_orders"
  | "earnings_total"
  | "total_amount";

const fmtMoney = (v: number) => `${v.toFixed(2)} ₽`;
const godFormat = (v: number) => `${v.toFixed(2)} $USD`;

const emptyGodForm = {
  total_orders: "",
  canceled_orders: "",
  earnings_total: "",
  total_amount: "",
};

export const StaffStats = () => {
  // Текущий пользователь: только Создатель может редактировать свою 🎃 статистику
  const viewer = useSelector((state: RootState) => state.auth.user);
  const isGod = viewer?.role === "god";

  const [rows, setRows] = useState<StaffStatsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeFired, setIncludeFired] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("id");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // === 🎃 Пасхалка: редактирование фейков Создателя ===
  const [showGodEdit, setShowGodEdit] = useState(false);
  const [godForm, setGodForm] = useState(emptyGodForm);
  const [godErrors, setGodErrors] = useState<Record<string, string>>({});
  const [savingGod, setSavingGod] = useState(false);

  const loadStats = async () => {
    setLoading(true);
    try {
      const data = await adminApi.getStaffStats(includeFired);
      setRows(data);
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить статистику");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeFired]);

  // Сортировка на клиенте (клик по заголовку колонки)
  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      const cmp =
        typeof va === "string" && typeof vb === "string"
          ? va.localeCompare(vb, "ru")
          : Number(va) - Number(vb);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [rows, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };
  const sortIcon = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  const openGodEdit = () => {
    const god = rows.find((r) => r.fake);
    setGodForm(
      god
        ? {
            total_orders: String(god.total_orders),
            canceled_orders: String(god.canceled_orders),
            earnings_total: String(god.earnings_total),
            total_amount: String(god.total_amount),
          }
        : emptyGodForm,
    );
    setGodErrors({});
    setShowGodEdit(true);
  };

  const handleSaveGod = async () => {
    // Валидация: счётчики — целые ≥ 0, деньги — числа ≥ 0
    const errors: Record<string, string> = {};
    const n = (v: string) => Number(v.trim());
    if (
      godForm.total_orders.trim() === "" ||
      !Number.isInteger(n(godForm.total_orders)) ||
      n(godForm.total_orders) < 0
    )
      errors.total_orders = "Целое число ≥ 0";
    if (
      godForm.canceled_orders.trim() === "" ||
      !Number.isInteger(n(godForm.canceled_orders)) ||
      n(godForm.canceled_orders) < 0
    )
      errors.canceled_orders = "Целое число ≥ 0";
    if (
      godForm.earnings_total.trim() === "" ||
      !Number.isFinite(n(godForm.earnings_total)) ||
      n(godForm.earnings_total) < 0
    )
      errors.earnings_total = "Число ≥ 0";
    if (
      godForm.total_amount.trim() === "" ||
      !Number.isFinite(n(godForm.total_amount)) ||
      n(godForm.total_amount) < 0
    )
      errors.total_amount = "Число ≥ 0";
    setGodErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSavingGod(true);
    try {
      const result = await adminApi.updateGodFakeStats({
        total_orders: n(godForm.total_orders),
        canceled_orders: n(godForm.canceled_orders),
        earnings_total: n(godForm.earnings_total),
        total_amount: n(godForm.total_amount),
      });
      toast.success(result.message);
      setShowGodEdit(false);
      loadStats();
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error || err?.message || "Ошибка сохранения",
      );
    } finally {
      setSavingGod(false);
    }
  };

  const godRow = rows.find((r) => r.fake);

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center justify-center gap-3 text-center lg:flex-row lg:justify-between">
        <h1 className="text-2xl font-bold">📊 Статистика команды</h1>
        <div className="flex flex-col items-center gap-2 sm:flex-row sm:items-center">
          {isGod && godRow && (
            <Button
              className="bg-purple-900 text-halloween-text border-purple-900 hover:bg-purple-700"
              size="sm"
              onClick={openGodEdit}
            >
              🎃 Моя пасхалка
            </Button>
          )}
          <label className="flex items-center gap-2 text-sm cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={includeFired}
              onChange={(e) => setIncludeFired(e.target.checked)}
            />
            <span>Показывать уволенных</span>
          </label>
          <Button onClick={loadStats} disabled={loading}>
            {loading ? "Загрузка..." : "🔄 Обновить"}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead
                  className="text-center cursor-pointer select-none hidden md:table-cell"
                  onClick={() => toggleSort("id")}
                >
                  ID{sortIcon("id")}
                </TableHead>
                <TableHead
                  className="text-center cursor-pointer select-none"
                  onClick={() => toggleSort("name")}
                >
                  Имя{sortIcon("name")}
                </TableHead>
                <TableHead
                  className="text-center cursor-pointer select-none hidden md:table-cell"
                  onClick={() => toggleSort("username")}
                >
                  Логин{sortIcon("username")}
                </TableHead>
                <TableHead className="text-center">Роль</TableHead>
                <TableHead
                  className="text-center cursor-pointer select-none"
                  onClick={() => toggleSort("total_orders")}
                >
                  Завершено заказов{sortIcon("total_orders")}
                </TableHead>
                <TableHead
                  className="text-center cursor-pointer select-none"
                  onClick={() => toggleSort("canceled_orders")}
                >
                  Отменено заказов{sortIcon("canceled_orders")}
                </TableHead>
                <TableHead
                  className="text-center cursor-pointer select-none"
                  onClick={() => toggleSort("earnings_total")}
                >
                  Суммарный заработок{sortIcon("earnings_total")}
                </TableHead>
                <TableHead
                  className="text-center cursor-pointer select-none"
                  onClick={() => toggleSort("total_amount")}
                >
                  Сумма заказов{sortIcon("total_amount")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center">
                    Загрузка...
                  </TableCell>
                </TableRow>
              ) : sorted.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center">
                    Нет данных
                  </TableCell>
                </TableRow>
              ) : (
                sorted.map((row) => (
                  <TableRow
                    key={row.id}
                    className={row.is_fired ? "opacity-50" : ""}
                  >
                    <TableCell className="text-center hidden md:table-cell">
                      <code>{row.id}</code>
                    </TableCell>
                    <TableCell className="text-center">
                      <b>{row.name}</b>
                      {/* {row.fake && (
                        <Badge
                          variant="secondary"
                          className="ml-1 select-none"
                          title="Пасхалка Создателя: значения фейковые 🎃"
                        >
                          🎃
                        </Badge>
                      )} */}
                    </TableCell>
                    <TableCell className="text-center hidden md:table-cell">
                      {row.username}
                    </TableCell>
                    <TableCell className="text-center">
                      <RoleBadge role={row.role} />
                    </TableCell>
                    {/* Числовые ячейки: у фейковой строки — курсивом */}
                    <TableCell className="text-center">
                      <span
                        className={
                          row.fake ? "italic text-muted-foreground" : ""
                        }
                      >
                        {row.total_orders}
                      </span>
                    </TableCell>
                    <TableCell className="text-center">
                      <span
                        className={
                          row.fake ? "italic text-muted-foreground" : ""
                        }
                      >
                        {row.canceled_orders}
                      </span>
                    </TableCell>
                    <TableCell className="text-center">
                      <span
                        className={
                          row.fake ? "italic text-muted-foreground" : ""
                        }
                      >
                        {row.fake
                          ? godFormat(row.earnings_total)
                          : fmtMoney(row.earnings_total)}
                      </span>
                    </TableCell>
                    <TableCell className="text-center">
                      <span
                        className={
                          row.fake ? "italic text-muted-foreground" : ""
                        }
                      >
                        {row.fake
                          ? godFormat(row.total_amount)
                          : fmtMoney(row.total_amount)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {/* 🎃 Пасхалка: редактирование фейковой статистики Создателя */}
      <Dialog
        open={showGodEdit}
        onOpenChange={(open) => {
          if (!open) setShowGodEdit(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>🎃 Пасхалка Создателя</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-xs text-muted-foreground">
              Эти значения нигде не хранятся — только в памяти сервера до
              перезапуска. Никто не проверит 😉
            </p>
            <div className="space-y-1">
              <Label htmlFor="god-total-orders">Завершено заказов</Label>
              <Input
                id="god-total-orders"
                type="number"
                value={godForm.total_orders}
                onChange={(e) =>
                  setGodForm({ ...godForm, total_orders: e.target.value })
                }
              />
              {godErrors.total_orders && (
                <p className="text-sm text-red-500">{godErrors.total_orders}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="god-canceled-orders">Отменено заказов</Label>
              <Input
                id="god-canceled-orders"
                type="number"
                value={godForm.canceled_orders}
                onChange={(e) =>
                  setGodForm({ ...godForm, canceled_orders: e.target.value })
                }
              />
              {godErrors.canceled_orders && (
                <p className="text-sm text-red-500">
                  {godErrors.canceled_orders}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="god-earnings-total">
                Суммарный заработок ($USD)
              </Label>
              <Input
                id="god-earnings-total"
                type="number"
                step="0.01"
                value={godForm.earnings_total}
                onChange={(e) =>
                  setGodForm({ ...godForm, earnings_total: e.target.value })
                }
              />
              {godErrors.earnings_total && (
                <p className="text-sm text-red-500">
                  {godErrors.earnings_total}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="god-total-amount">Сумма заказов ($USD)</Label>
              <Input
                id="god-total-amount"
                type="number"
                step="0.01"
                value={godForm.total_amount}
                onChange={(e) =>
                  setGodForm({ ...godForm, total_amount: e.target.value })
                }
              />
              {godErrors.total_amount && (
                <p className="text-sm text-red-500">{godErrors.total_amount}</p>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => setShowGodEdit(false)}
                disabled={savingGod}
              >
                Отмена
              </Button>
              <Button onClick={handleSaveGod} disabled={savingGod}>
                {savingGod ? "Сохранение..." : "Сохранить"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
