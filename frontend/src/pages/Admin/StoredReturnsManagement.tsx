// frontend/src/pages/Admin/StoredReturnsManagement.tsx
//
// Страница «Хранилище сотрудников»: кто что положил в ящик.

import { useCallback, useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { adminApi } from "@/api/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { StoredReturn } from "@/types/returns";

type SourceFilter = "all" | "lozon_id" | "barcode" | "offer_id";

const SOURCE_LABEL: Record<string, string> = {
  lozon_id: "📦 lozon_id",
  barcode: "🔖 barcode",
  offer_id: "🎯 offer_id",
};

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export const StoredReturnsManagement = () => {
  const [items, setItems] = useState<StoredReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (source: SourceFilter) => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.listStoredReturns({
        source: source !== "all" ? source : undefined,
      });
      setItems(res.items || []);
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(sourceFilter);
  }, [sourceFilter, load]);

  // Клиентский поиск: по имени сотрудника, ящику, offer_id/sku/barcode
  const filteredItems = search.trim()
    ? items.filter((it) => {
        const q = search.trim().toLowerCase();
        return (
          (it.user_name || "").toLowerCase().includes(q) ||
          (it.box_number || "").toLowerCase().includes(q) ||
          (it.offer_id || "").toLowerCase().includes(q) ||
          (it.sku || "").toLowerCase().includes(q) ||
          (it.barcode || "").toLowerCase().includes(q) ||
          (it.lozon_id || "").toLowerCase().includes(q)
        );
      })
    : items;

  // Счётчики по источникам (для header)
  // const counts = items.reduce(
  //   (acc, it) => {
  //     const k = it.source || "lozon_id";
  //     acc[k] = (acc[k] || 0) + 1;
  //     return acc;
  //   },
  //   {} as Record<string, number>,
  // );

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center justify-center gap-3 text-center lg:flex-row lg:justify-between">
        <h1 className="text-2xl font-bold">
          {/* <Package className="inline-block align-middle -translate-y-[2px] mr-1 h-6 w-6" /> */}
          🎁 Хранилище
          <span className="block text-muted-foreground mt-1 text-base font-normal">
            Записей: <span className="text-blue-600">{items.length}</span>
            {/* {counts.lozon_id ? ` · 📦 ${counts.lozon_id}` : ""}
            {counts.barcode ? ` · 🔖 ${counts.barcode}` : ""}
            {counts.offer_id ? ` · 🎯 ${counts.offer_id}` : ""} */}
          </span>
        </h1>
        <div className="flex flex-col items-center gap-2 sm:flex-row">
          <div className="flex flex-col items-center sm:items-start">
            <Label className="mb-[8px]">Источник</Label>
            <Select
              value={sourceFilter}
              onValueChange={(v) => setSourceFilter(v as SourceFilter)}
            >
              <SelectTrigger className="w-full sm:w-56">
                <SelectValue>
                  {(val) => {
                    if (val === "lozon_id") return "📦 По штрихкоду (lozon)";
                    if (val === "barcode") return "🔖 По barcode";
                    if (val === "offer_id") return "🎯 По offer_id (прямое)";
                    return "🌐 Все источники";
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">🌐 Все источники</SelectItem>
                <SelectItem value="lozon_id">
                  📦 По штрихкоду (lozon)
                </SelectItem>
                <SelectItem value="barcode">🔖 По barcode</SelectItem>
                <SelectItem value="offer_id">🎯 Прямые по offer_id</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col items-center sm:items-start">
            <Label className="mb-[8px]">Поиск</Label>
            <Input
              className="w-full sm:w-64"
              placeholder="Имя, ящик, offer_id, barcode"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-center text-lg">Записи в хранилище</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="text-center py-10 text-muted-foreground">
              Загрузка...
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              {items.length === 0
                ? "Пока никто ничего не положил на хранение"
                : "Ничего не найдено по фильтру/поиску"}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-center">Сотрудник</TableHead>
                  <TableHead className="text-center">Ящик</TableHead>
                  <TableHead className="text-center">Артикул</TableHead>
                  <TableHead className="text-center hidden md:table-cell">
                    SKU
                  </TableHead>
                  <TableHead className="text-center hidden lg:table-cell">
                    Barcode
                  </TableHead>
                  <TableHead className="text-center">Кол-во</TableHead>
                  <TableHead className="text-center hidden md:table-cell">
                    Источник
                  </TableHead>
                  <TableHead className="text-center hidden lg:table-cell">
                    Добавлено
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="text-center">
                      {s.user_name || "—"}
                    </TableCell>
                    <TableCell className="text-center font-medium">
                      {s.box_number}
                    </TableCell>
                    <TableCell className="text-center font-mono text-xs">
                      {s.offer_id || (
                        <Badge variant="outline" className="text-xs">
                          нет
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-center font-mono text-xs hidden md:table-cell">
                      {s.sku || "—"}
                    </TableCell>
                    <TableCell className="text-center font-mono text-xs hidden lg:table-cell">
                      {s.barcode || "—"}
                    </TableCell>
                    <TableCell className="text-center">{s.quantity}</TableCell>
                    <TableCell className="text-center hidden md:table-cell">
                      <Badge variant="outline" className="text-xs">
                        {SOURCE_LABEL[s.source || "lozon_id"] || "—"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center text-xs text-muted-foreground hidden lg:table-cell">
                      {formatDate(s.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
