// frontend/src/pages/Admin/ReturnsManagement.tsx
//
// Админская страница «Возвраты» (шаги 1 и 2 пайплайна):
//   • кнопка «Обновить» — синхронизация returns-N.db из Ozon (/v1/report/postings/create)
//   • таблица returns-N.db с матчингом «кто уже положил в ящик»
//   • под таблицей — заливка PDF-актов (до 10 файлов) с обновлением cargo_box_id
//   • фильтры: только с cargo_box_id, только с полной цепочкой (есть сотрудник)

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, RefreshCw, Upload } from "lucide-react";
import { toast } from "sonner";

import { adminApi } from "@/api/admin";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import type {
  ReturnsCacheItem,
  ReturnsPdfUploadResult,
  ReturnOwner,
} from "@/types/returns";

interface ReturnRowWithOwners extends ReturnsCacheItem {
  stored_owners: ReturnOwner[];
}

type CacheFilter = "all" | "cargo" | "full" | "multi";

export const ReturnsManagement = () => {
  // ── Таблица: кэш возвратов из Ozon ──────────────────────────────
  const [items, setItems] = useState<ReturnRowWithOwners[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [filter, setFilter] = useState<CacheFilter>("all");
  const [error, setError] = useState<string | null>(null);

  // ── Заливка PDF ────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const [pdfResult, setPdfResult] = useState<ReturnsPdfUploadResult | null>(
    null,
  );

  const loadList = useCallback(async (filterMode: CacheFilter) => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.listReturns({
        limit: 1000,
        filter: filterMode !== "all" ? filterMode : undefined,
      });
      setItems((res.items || []) as ReturnRowWithOwners[]);
      setTotal(res.total || 0);
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }, []);

    useEffect(() => {
    loadList(filter);
  }, [filter, loadList]);

  const handleSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await adminApi.syncReturnsReport();
      const parts = [
        `${res.uniqueRows} строк`,
        `ready ${res.ready}`,
        `skip ${res.skip}`,
      ];
      if (res.multiProductBarcodes > 0)
        parts.push(`multi ${res.multiProductBarcodes}`);
      if (res.inserted > 0) parts.push(`+${res.inserted}`);
      if (res.updated > 0) parts.push(`~${res.updated}`);
      toast.success(`Sync: ${parts.join(", ")}`);
      await loadList(filter);
    } catch (err: any) {
      const msg =
        err?.response?.data?.error || err.message || "Ошибка синхронизации";
      toast.error(msg);
      setError(msg);
    } finally {
      setSyncing(false);
    }
  };

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || []);
    if (list.length > 10) {
      toast.error("Максимум 10 PDF-файлов за раз");
      return;
    }
    const nonPdf = list.find((f) => !/\.pdf$/i.test(f.name));
    if (nonPdf) {
      toast.error(`Файл ${nonPdf.name} — не PDF`);
      return;
    }
    setPdfFiles(list);
    setPdfResult(null);
  };

  const handleUploadPdf = async () => {
    if (!pdfFiles.length) {
      toast.error("Выберите хотя бы один PDF");
      return;
    }
    setUploadingPdf(true);
    setPdfResult(null);
    try {
      const res = await adminApi.uploadReturnsPdf(pdfFiles);
      setPdfResult(res);
      toast.success(res.message || "PDF обработаны");
      if (res.totalUpdated > 0)
        await loadList(filter);
      setPdfFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error || err.message || "Ошибка загрузки PDF",
      );
    } finally {
      setUploadingPdf(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center justify-center gap-3 text-center lg:flex-row lg:justify-between">
        <h1 className="text-2xl font-bold">
          <span className="inline-block align-middle -translate-y-[2px] mr-1">
            🗳️
          </span>
          Кэш возвратов
          <span className="block text-muted-foreground mt-1 text-base font-normal">
            Синхронизирован с Ozon ·{" "}
            <span className="text-blue-600">{total}</span> записей
          </span>
        </h1>
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-col items-center sm:items-start">
            <Label className="mb-2">Фильтр кэша</Label>
            <Select
              value={filter}
              onValueChange={(v) => setFilter(v as CacheFilter)}
            >
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue>
                  {(val) => {
                    if (val === "cargo") return "📍 Только с номером предмета";
                    if (val === "full") return "✅ Только с полной цепочкой";
                    if (val === "multi")
                      return "⚠️ Только multi (несколько товаров)";
                    return "🌐 Все";
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">🌐 Все</SelectItem>
                <SelectItem value="cargo">
                  📍 Только с номером предмета
                </SelectItem>
                <SelectItem value="full">
                  ✅ Только с полной цепочкой
                </SelectItem>
                <SelectItem value="multi">⚠️ Только multi</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleSync} disabled={syncing || loading}>
            <RefreshCw
              className={`mr-2 h-4 w-4 ${syncing ? "animate-spin" : ""}`}
            />
            {syncing ? "Синхронизация..." : "Обновить из Ozon"}
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* === Таблица: Кэш возвратов === */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg text-center">
            Кэш возвратов (returns-N.db)
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="text-center py-10 text-muted-foreground">
              Загрузка...
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              Нет записей. Нажмите «Обновить из Ozon».
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-center">Номер предмета</TableHead>
                  <TableHead className="text-center">Код этикетки</TableHead>
                  <TableHead className="text-center">Артикул</TableHead>
                  <TableHead className="text-center hidden md:table-cell">
                    SKU
                  </TableHead>
                  <TableHead className="text-center hidden lg:table-cell">
                    Кол-во
                  </TableHead>
                  <TableHead className="text-center">Сотрудник</TableHead>
                  <TableHead className="text-center">Ящик</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((r) => {
                  const isMulti = r.resolution_reason === "multiple_products";
                  return (
                    <TableRow
                      key={r.id}
                      className={
                        isMulti ? "bg-amber-50/50 dark:bg-amber-950/20" : ""
                      }
                    >
                      <TableCell className="text-center font-mono text-xs">
                        {r.cargo_box_id || (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center font-mono text-xs">
                        {r.barcode || "—"}
                      </TableCell>
                      <TableCell className="text-center font-mono text-xs">
                        {isMulti ? (
                          <div className="flex flex-col items-center gap-1">
                            <Badge
                              variant="destructive"
                              className="text-xs"
                              title="В одной упаковке несколько товаров — авторезолв невозможен"
                            >
                              ⚠️ multi
                            </Badge>
                            {r.offer_id && <span>{r.offer_id}</span>}
                          </div>
                        ) : r.offer_id ? (
                          r.offer_id
                        ) : (
                          <Badge variant="outline" className="text-xs">
                            {r.resolution_reason === "no_offer_id"
                              ? "нет артикула"
                              : "нет"}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-center font-mono text-xs hidden md:table-cell">
                        {r.sku || "—"}
                      </TableCell>
                      <TableCell className="text-center text-xs hidden lg:table-cell">
                        {r.quantity || 1}
                      </TableCell>
                      <TableCell className="text-center">
                        {r.stored_owners.length === 0 ? (
                          <span className="text-muted-foreground text-xs">
                            —
                          </span>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {r.stored_owners.map((o) => (
                              <Badge
                                key={o.stored_return_id}
                                variant="secondary"
                              >
                                {o.user_name}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {r.stored_owners.length === 0 ? (
                          <span className="text-muted-foreground text-xs">
                            —
                          </span>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {r.stored_owners.map((o) => (
                              <span
                                key={o.stored_return_id}
                                className="text-xs font-mono"
                              >
                                {o.box_number} × {o.quantity}
                              </span>
                            ))}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* === Заливка PDF === */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg text-center">
            📄 Загрузить PDF-акты приёма-передачи
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="mx-auto w-full max-w-2xl">
            <Label
              className="mb-[10px] block cursor-pointer text-center"
              htmlFor="pdf-upload"
            >
              До 10 PDF-файлов за раз
            </Label>
            <Input
              ref={fileInputRef}
              id="pdf-upload"
              type="file"
              accept=".pdf"
              multiple
              onChange={handleFilesSelected}
              disabled={uploadingPdf}
              className="m-0 p-0 items-center file:h-full file:mr-4 file:px-3 file:rounded-lg file:border-0 file:bg-primary file:text-primary-foreground file:font-semibold file:cursor-pointer file:hover:bg-primary/90 hover:border-primary/60 cursor-pointer transition-all hover:bg-input/50 active:scale-[0.98]"
            />
            {pdfFiles.length > 0 && (
              <p className="text-sm text-muted-foreground mt-2 text-center">
                Выбрано файлов: <b>{pdfFiles.length}</b>
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-2 text-center">
              Парсер извлекает пары «Номер предмета» → «Штрих-код» и обновляет{" "}
              <code>cargo_box_id</code> в кэше.
            </p>
          </div>
          <div className="flex justify-center">
            <Button
              onClick={handleUploadPdf}
              disabled={!pdfFiles.length || uploadingPdf}
              className="md:w-auto w-full max-w-[340px] md:max-w-none"
            >
              <Upload className="mr-2 h-4 w-4" />
              {uploadingPdf ? "Загрузка..." : "Загрузить PDF"}
            </Button>
          </div>

          {pdfResult && (
            <div className="space-y-2 pt-4 border-t">
              <Alert>
                <AlertDescription>{pdfResult.message}</AlertDescription>
              </Alert>
              <div className="space-y-2">
                {pdfResult.items.map((it) => (
                  <div
                    key={it.fileName}
                    className="rounded border p-2 text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono break-all">{it.fileName}</span>
                      <Badge variant={it.ok ? "default" : "destructive"}>
                        {it.ok ? "OK" : "Ошибка"}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground">
                      пар: {it.pairs}, обновлено: {it.updated}, не найдено:{" "}
                      {it.notFound}
                      {it.alreadySet > 0 ? `, уже было: ${it.alreadySet}` : ""}
                      {it.conflicts > 0 ? `, конфликтов: ${it.conflicts}` : ""}
                    </div>
                    {it.error && (
                      <div className="text-destructive">{it.error}</div>
                    )}
                    {it.warnings.length > 0 && (
                      <div className="text-muted-foreground">
                        {it.warnings.length} предупреждений
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
