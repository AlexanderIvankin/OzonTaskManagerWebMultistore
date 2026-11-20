// frontend/src/pages/MyStorage/MyStorage.tsx
//
// Страница «Мой склад»: сотрудник видит свои возвраты, кладёт новые (по
// lozon_id) или заливает пачкой через Excel. Резолв — синхронный: если
// lozon_id не опознан — показываем понятную ошибку и НЕ создаём запись.

import { useCallback, useEffect, useRef, useState } from "react";
import { Package, Plus, Trash2, Upload, AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { returnsStorageApi } from "@/api/returns";
import type { StoredReturn, ImportStoredReturnsResult } from "@/types/returns";
import { toast } from "sonner";

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

function displayLozon(it: StoredReturn): string {
  // Скрываем технические placeholder'ы (MANUAL_OFFER:..., MANUAL_BARCODE:...)
  // — они нужны только как NOT NULL в БД, пользователю не показываем.
  if (!it.lozon_id) return "—";
  if (it.lozon_id.startsWith("MANUAL_")) return "—";
  return it.lozon_id;
}

function downloadSkippedFile(base64: string, fileName: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function MyStorage() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [items, setItems] = useState<StoredReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const [clearing, setClearing] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const [{ enabled }, list] = await Promise.all([
        returnsStorageApi.getSettings(),
        returnsStorageApi.list(),
      ]);
      setEnabled(enabled);
      setItems(list.items || []);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || "Ошибка загрузки");
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRemove = async (id: number) => {
    if (!window.confirm("Удалить запись из хранилища?")) return;
    try {
      await returnsStorageApi.remove(id);
      setItems((prev) => prev.filter((x) => x.id !== id));
    } catch (err: any) {
      setError(err?.response?.data?.error || "Не удалось удалить");
    }
  };

  const handleClearAll = async () => {
    if (items.length === 0) return;

    setClearing(true);
    try {
      const res = await returnsStorageApi.clearAll();
      setItems([]);
      toast.success(`Склад обнулён: удалено ${res.cleared} записей`);
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error ||
          err.message ||
          "Не удалось обнулить склад",
      );
    } finally {
      setClearing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Package className="h-6 w-6 animate-pulse text-muted-foreground" />
      </div>
    );
  }

  if (enabled === false) {
    return (
      <Card className="p-6">
        <div className="flex flex-col items-center gap-4 py-8 text-center">
          <Package className="h-12 w-12 text-muted-foreground" />
          <div>
            <h3 className="text-lg font-semibold">
              Хранилище возвратов отключено
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Включите «Хранилище возвратов» в глобальном профиле — тогда
              сможете складывать возвращённые товары в коробки и получать
              подсказки при назначении заказов.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-col items-center justify-center text-center lg:justify-between lg:text-start gap-3 lg:flex-row">
        <div>
          <h1 className="text-2xl font-semibold">🏠 Мой склад</h1>
          <p className="text-sm text-muted-foreground">
            Возвраты, которые вы храните в коробках. При поступлении заказа с
            таким товаром модератор увидит, что товар уже готов у вас.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <Button variant="outline" onClick={() => setShowImport(true)}>
            <Upload className="mr-2 h-4 w-4" />
            Загрузить Excel
          </Button>
          <Button onClick={() => setShowAdd(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Добавить возврат
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        {items.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            У вас пока нет сохранённых возвратов. Добавьте первый через
            «Добавить возврат» или загрузите Excel.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-center">Коробка</TableHead>
                <TableHead className="text-center">Штрихкод</TableHead>
                <TableHead className="text-center">Артикул</TableHead>
                <TableHead className="text-center">SKU</TableHead>
                <TableHead className="text-center">Кол-во</TableHead>
                <TableHead className="text-center">Добавлено</TableHead>
                <TableHead className="text-center">Действие</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((it) => (
                <TableRow key={it.id}>
                  <TableCell className="text-center font-medium">
                    {it.box_number}
                  </TableCell>
                  <TableCell className="text-center font-mono text-xs">
                    <div className="flex justify-center items-center gap-1">
                      {displayLozon(it)}
                      {/* {it.source === "offer_id" && (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1 py-0"
                          title="Добавлено вручную по offer_id"
                        >
                          🎯
                        </Badge>
                      )} */}
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    {it.offer_id ? (
                      <span className="font-mono text-sm">{it.offer_id}</span>
                    ) : (
                      <Badge variant="outline" className="text-xs">
                        не опознан
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-center font-mono text-xs">
                    {it.sku || "—"}
                  </TableCell>
                  <TableCell className="text-center">{it.quantity}</TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">
                    {formatDate(it.created_at)}
                  </TableCell>
                  <TableCell className="text-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleRemove(it.id)}
                      title="Удалить из хранилища"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {items.length > 0 && (
        <div className="flex flex-col items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowClearConfirm(true)}
            disabled={clearing}
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            {clearing
              ? "⏳ Обнуление…"
              : `🗑 Обнулить мой склад (${items.length})`}
          </Button>

          <Dialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="text-center">Обнулить склад?</DialogTitle>
                <DialogDescription>
                  Будет удалено <b>{items.length}</b> записей из вашего
                  хранилища. Ранее списанные товары по завершённым заказам
                  останутся в истории.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="sm:justify-center">
                <Button
                  variant="outline"
                  onClick={() => setShowClearConfirm(false)}
                >
                  Отмена
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setShowClearConfirm(false);
                    handleClearAll();
                  }}
                >
                  Обнулить всё
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}

      <AddDialog
        open={showAdd}
        onOpenChange={setShowAdd}
        onSuccess={(created) => {
          setItems((prev) => [created, ...prev]);
          load({ silent: true });
        }}
      />
      <ImportDialog
        open={showImport}
        onOpenChange={setShowImport}
        onSuccess={() => load({ silent: true })}
      />
    </div>
  );
}

// ── Диалог добавления ──────────────────────────────────────────────────────

function AddDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: (item: StoredReturn) => void;
}) {
  const [boxNumber, setBoxNumber] = useState("");
  const [offerId, setOfferId] = useState("");
  const [lozonId, setLozonId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => {
    setBoxNumber("");
    setLozonId("");
    setOfferId("");
    setQuantity("1");
    setErr(null);
  };

  const handleSubmit = async () => {
    if (!boxNumber.trim()) return setErr("Укажите номер коробки");
    if (!offerId.trim() && !lozonId.trim()) {
      return setErr("Укажите Артикул или Штрихкод Возврата");
    }
    const qty = parseInt(quantity, 10);
    if (!Number.isFinite(qty) || qty < 1) {
      setErr("Количество должно быть целым и не меньше 1");
      return;
    }

    setBusy(true);
    setErr(null);
    try {
      const result = await returnsStorageApi.addManual({
        boxNumber: boxNumber.trim(),
        offerId: offerId.trim() || undefined,
        input: lozonId.trim() || undefined,
        quantity: qty,
      });
      toast.success(
        result.created
          ? `Добавлено: ${result.offer_id} → ящик «${boxNumber.trim()}»`
          : `Обновлено: ${result.offer_id} → ящик «${boxNumber.trim()}» (${result.quantity} шт.)`,
      );
      // Оптимистично собираем запись из ответа — точное состояние подтянется
      // при следующем list(), но для UX хватит этого.
      const newItem: StoredReturn = {
        id: result.id,
        user_id: 0,
        box_number: boxNumber.trim(),
        lozon_id: lozonId.trim(),
        offer_id: result.offer_id,
        sku: result.sku,
        product_name: null,
        quantity: result.quantity,
        resolution_status: "resolved",
        source_store_id: null,
        source_order_id: null,
        status: "stored",
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      onSuccess(newItem);
      reset();
      onOpenChange(false);
    } catch (e: any) {
      setErr(e?.response?.data?.error || e?.message || "Не удалось добавить");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) {
          onOpenChange(v);
          if (!v) reset();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-center">
            Добавить возврат на хранение
          </DialogTitle>
          <DialogDescription className="text-center">
            Напишите штрихкод с возвратной этикетки. Артикул и SKU определятся
            автоматически.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="mb-2" htmlFor="boxNumber">
              Коробка
            </Label>
            <Input
              id="boxNumber"
              placeholder="Например, «Ящик 3»"
              value={boxNumber}
              onChange={(e) => setBoxNumber(e.target.value)}
              disabled={busy}
            />
          </div>

          <div className="rounded-lg border p-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              Заполните одно из двух полей:
            </p>

            <div>
              <Label className="text-sm mb-2" htmlFor="offerId">
                🎯 Артикул offer_id (прямое указание)
              </Label>
              <Input
                id="offerId"
                placeholder="ARD000001-N"
                value={offerId}
                onChange={(e) => setOfferId(e.target.value)}
                disabled={busy}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Если точно знаете артикул — используйте этот путь
              </p>
            </div>

            <div className="text-center text-xs text-muted-foreground">
              — или —
            </div>

            <div>
              <Label className="text-sm mb-2" htmlFor="lozonId">
                📦 Штрихкод возврата (lozon_id / barcode)
              </Label>
              <Input
                id="lozonId"
                placeholder="ii... или %301%... или 25000..."
                value={lozonId}
                onChange={(e) => setLozonId(e.target.value)}
                disabled={busy}
                className="font-mono"
              />
              {lozonId.trim() &&
                !/^(%|ii|\d{6,})/i.test(lozonId.trim()) &&
                !offerId.trim() && (
                  <p className="text-xs text-amber-600 mt-2">
                    Не похоже на штрихкод возврата. Если у вас offer_id —
                    используйте поле выше.
                  </p>
                )}
              <p className="text-xs text-muted-foreground mt-1">
                Артикул определится автоматически, если возврат уже в базе
              </p>
            </div>
          </div>

          <div>
            <Label className="mb-2" htmlFor="quantity">
              Количество
            </Label>
            <Input
              id="quantity"
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              disabled={busy}
            />
          </div>

          {err && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{err}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="text-center sm:justify-center">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Отмена
          </Button>
          <Button onClick={handleSubmit} disabled={busy}>
            {busy ? "Добавляем..." : "Добавить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Диалог импорта Excel ──────────────────────────────────────────────────

function ImportDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportStoredReturnsResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setResult(null);
    setErr(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleFile = (f: File | null) => {
    setFile(f);
    setResult(null);
    setErr(null);
  };

  const handleImport = async () => {
    if (!file) {
      setErr("Выберите файл");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await returnsStorageApi.importExcel(file);
      setResult(res);
      onSuccess();
    } catch (e: any) {
      setErr(e?.response?.data?.error || e?.message || "Ошибка импорта");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) {
          onOpenChange(v);
          if (!v) reset();
        }
      }}
    >
      <DialogContent className="max-w-2xl md:max-w-3xl">
        <DialogHeader className="text-center">
          <DialogTitle>Импорт из Excel</DialogTitle>
        </DialogHeader>

        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            <b className="text-foreground">
              Заголовки в 1-й строке обязательны.
            </b>{" "}
            Порядок колонок не важен — парсер читает по именам.
          </p>
          <p>
            Обязательные: <code>box_number</code>, <code>quantity</code>, и одна
            из <code>barcode</code> / <code>offer_id</code>.
          </p>
          <div className="text-xs space-y-1.5 rounded border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 p-2">
            <p>
              <b>В колонке штрихкода — только barcode:</b> <code>ii...</code>{" "}
              или <code>%...</code> (например, <code>ii17701861005</code>,{" "}
              <code>%301%25815721288</code>).
            </p>
            <p>
              <b>❌ lozon_id не принимается</b> — номера вида{" "}
              <code>25000000000</code> (длинные цифры с этикетки) отклоняются.
              Добавляйте их по одному через форму «Добавить возврат».
            </p>
          </div>
          <p className="text-xs">
            Алиасы колонок (регистр не важен): коробка·box, штрихкод·barcode,
            артикул·offer_id, количество·qty. Если указаны оба — приоритет у{" "}
            <code>offer_id</code> (без резолва).
          </p>
          <p className="text-xs">
            Ячейки с несколькими значениями через запятую/пробел — строка
            пропускается.
          </p>

          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Пример таблицы
            </summary>
            <div className="mt-1 w-full max-w-full overflow-x-auto rounded bg-muted">
              <pre className="m-0 p-2 text-left whitespace-pre">
                {`box_number | barcode        | offer_id   | quantity
Ящик 1     | ii17701861005  |            | 1
Ящик 2     |                | ARD000001  | 1
Красная 3  | %301%25815721  |            | 2`}
              </pre>
            </div>
          </details>
        </div>
        <div className="space-y-3 justify-center items-center">
          <Input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => handleFile(e.target.files?.[0] || null)}
            disabled={busy}
          />

          {err && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{err}</AlertDescription>
            </Alert>
          )}
        </div>

        {result && (
          <div className="space-y-2">
            <Alert>
              <AlertDescription>
                Всего: {result.total}, добавлено: {result.inserted}, обновлено:{" "}
                {result.updated}, отклонено: {result.rejected}
              </AlertDescription>
            </Alert>

            {result.skippedFileBase64 && result.skippedFileName && (
              <div className="flex flex-col gap-2 rounded border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 p-3">
                <p className="text-sm">
                  <b>⚠️ Есть отклонённые строки ({result.rejected}).</b>{" "}
                  Скачайте файл, исправьте и загрузите повторно.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    downloadSkippedFile(
                      result.skippedFileBase64!,
                      result.skippedFileName!,
                    )
                  }
                >
                  ⬇️ Скачать {result.skippedFileName}
                </Button>
              </div>
            )}

            {result.errors.length > 0 && (
              <div className="max-h-48 overflow-auto rounded border p-2 text-xs">
                {result.errors.slice(0, 50).map((e, i) => (
                  <div key={i}>
                    строка {e.row}:{e.offer_id ? ` ${e.offer_id}` : ""}
                    {e.lozon_id ? ` ${e.lozon_id}` : ""}
                    {" — "}
                    {e.error}
                  </div>
                ))}
                {result.errors.length > 50 && (
                  <div className="mt-1 text-muted-foreground">
                    … и ещё {result.errors.length - 50} (все в файле выше)
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <DialogFooter className="text-center sm:justify-center">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Закрыть
          </Button>
          <Button onClick={handleImport} disabled={busy || !file}>
            {busy ? "Импортируем..." : "Импортировать"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
