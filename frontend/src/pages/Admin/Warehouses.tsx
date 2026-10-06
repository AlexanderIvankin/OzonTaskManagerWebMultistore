import { useEffect, useState } from "react";
import { adminApi, User, Warehouse } from "../../api/admin";
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
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

export const Warehouses = () => {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // === Фильтр по имени сотрудника (аналог /employee_warehouses) ===
  const [employees, setEmployees] = useState<User[]>([]);
  // "all" — все склады, иначе ID сотрудника (показываем его склады)
  const [employeeFilter, setEmployeeFilter] = useState("all");

  const loadWarehouses = async () => {
    setLoading(true);
    try {
      const data = await adminApi.getWarehouses();
      setWarehouses(data);
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить склады");
    } finally {
      setLoading(false);
    }
  };

  // Сотрудники с их складами (приоритетами) — для фильтра по имени
  const loadEmployees = async () => {
    try {
      const users = await adminApi.getUsers({
        includeAll: true,
        includeFired: false,
        withWarehouses: true,
      });
      setEmployees(users.filter((u) => u.role !== "user"));
    } catch {
      // Некритично: фильтр просто останется пустым
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await adminApi.syncWarehouses();
      toast.success(`Склады синхронизированы: ${result.count} складов`);
      loadWarehouses();
    } catch (err: any) {
      toast.error(err.message || "Ошибка синхронизации");
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    loadWarehouses();
    loadEmployees();
  }, []);

  // Склады для отображения: все или только склады выбранного сотрудника
  const selectedEmployee =
    employeeFilter === "all"
      ? null
      : employees.find((e) => String(e.id) === employeeFilter);
  const displayedWarehouses: Warehouse[] = selectedEmployee
    ? (selectedEmployee.warehouses || []).map((w) => ({
        warehouse_id: w.warehouse_id,
        name: w.name,
        address: w.address ?? null,
        is_rfbs: w.is_rfbs,
      }))
    : warehouses;

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center justify-center gap-3 text-center lg:flex-row lg:justify-between">
        <h1 className="text-2xl font-bold">
          🏭 Склады
          {selectedEmployee && (
            <span className="block text-base font-normal text-muted-foreground">
              Склады сотрудника <b>{selectedEmployee.name}</b> (ID:{" "}
              {selectedEmployee.id})
            </span>
          )}
        </h1>
        <div className="flex flex-col items-center gap-2 lg:flex-row lg:items-end">
          {/* Фильтр по имени сотрудника (аналог /employee_warehouses) */}
          <div className="flex flex-col items-center lg:items-start">
            <Label className="mb-[8px]">Сотрудник</Label>
            <Select
              value={employeeFilter}
              onValueChange={(v) => setEmployeeFilter(v ?? "all")}
            >
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue placeholder="Все склады">
                  {(val) =>
                    !val || val === "all"
                      ? "🌐 Все склады"
                      : employees.find((e) => String(e.id) === String(val))
                          ?.name || String(val)
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">🌐 Все склады</SelectItem>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.name} (ID: {e.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selectedEmployee && (
            <Button variant="ghost" onClick={() => setEmployeeFilter("all")}>
              ✕ Сбросить
            </Button>
          )}
          <Button onClick={handleSync} disabled={syncing || loading}>
            {syncing ? "Синхронизация..." : "🔄 Синхронизировать"}
          </Button>
          <Button onClick={loadWarehouses} disabled={loading}>
            Обновить
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-center">ID</TableHead>
                <TableHead className="text-center">Название</TableHead>
                <TableHead className="text-center">Адрес</TableHead>
                <TableHead className="text-center">Тип</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center">
                    Загрузка...
                  </TableCell>
                </TableRow>
              ) : displayedWarehouses.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center">
                    {selectedEmployee
                      ? `Сотрудник ${selectedEmployee.name} не числится ни на одном складе`
                      : "Нет складов"}
                  </TableCell>
                </TableRow>
              ) : (
                displayedWarehouses.map((wh) => (
                  <TableRow key={wh.warehouse_id}>
                    <TableCell className="text-center font-mono text-sm">
                      <span className="text-sm">
                        <code>{wh.warehouse_id}</code>
                      </span>
                    </TableCell>
                    <TableCell className="text-center font-semibold">
                      {wh.name}
                    </TableCell>
                    <TableCell className="text-center">
                      {wh.address || "—"}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant={wh.is_rfbs ? "default" : "secondary"}>
                        {wh.is_rfbs ? "realFBS" : "FBS"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
};
