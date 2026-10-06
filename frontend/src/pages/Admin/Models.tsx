import { useEffect, useState } from "react";
import {
  adminApi,
  getBlobErrorMessage,
  getDownloadFileName,
  OfferModelRow,
} from "../../api/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

// Размер zip в человекочитаемом виде
const formatSize = (bytes: number | null | undefined) => {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} МБ` : `${(bytes / 1024).toFixed(0)} КБ`;
};

const formatDateTime = (ts: number | null) =>
  ts ? new Date(ts).toLocaleString("ru-RU") : "—";

// Короткая версия модели для таблицы: первые 12 символов ETag из S3.
// ETag — версия объекта: пока он не меняется, архив в хранилище тот же.
// Как только он изменился (в т.ч. при замене файла напрямую в S3), бэкенд
// сбрасывает локальный кэш и оповещает сотрудников (model_updated).
const shortEtag = (etag: string | null) => (etag ? etag.slice(0, 12) : "—");

// Фильтр «что сейчас в работе»: модели, выданные сотрудникам и/или лежащие
// в локальном кэше сервера (значит, их активно раздают).
type ModelFilter = "all" | "issued" | "cached";
//type ModelFilter = "all" | "in_work" | "issued" | "cached";

const MODEL_FILTERS: Array<{ value: ModelFilter; label: string }> = [
  { value: "all", label: "Все модели" },
//  { value: "in_work", label: "🧰 В работе (выданы / в кэше)" },
  { value: "issued", label: "👷 Выданы сотрудникам" },
  { value: "cached", label: "📦 В кэше сервера" },
];

export const Models = () => {
  const [models, setModels] = useState<OfferModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [downloadingOffer, setDownloadingOffer] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [offerId, setOfferId] = useState("");

  // Поиск по артикулу (offer_id): фильтрация клиентская — список моделей
  // загружается целиком, поэтому результат виден сразу при вводе
  const [search, setSearch] = useState("");

  // Фильтр по статусу «в работе» (выданы сотрудникам / в кэше сервера)
  const [filter, setFilter] = useState<ModelFilter>("all");

  const loadModels = async () => {
    setLoading(true);
    try {
      const data = await adminApi.getModels();
      setModels(data);
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить список моделей");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModels();
  }, []);

  // Фильтр по артикулу: подстрока в offer_id или в имени файла архива.
  // «ARD000003-N.zip» в поиске тоже найдёт модель ARD000003-N.
  // Плюс фильтр по статусу «в работе» (фильтрация клиентская — список грузится целиком).
  const query = search.trim().toLowerCase();
  const offerQuery = query.replace(/\.zip$/, "") || query;
  const visibleModels = models.filter((m) => {
//    if (filter === "in_work" && !m.in_work) return false;
    if (filter === "issued" && !(m.issued_count && m.issued_count > 0))
      return false;
    if (filter === "cached" && !m.in_cache) return false;
    if (!query) return true;
    return (
      m.offer_id.toLowerCase().includes(offerQuery) ||
      (m.file_name || "").toLowerCase().includes(query)
    );
  });
  const hasSearch = !!query;
  const hasFilter = filter !== "all";
//  const inWorkCount = models.filter((m) => m.in_work).length;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
      // Артикул по умолчанию — из имени файла ({offer_id}.zip)
      const fromName = e.target.files[0].name.replace(/\.zip$/i, "");
      setOfferId((prev) => prev || fromName);
    }
  };

  const handleUpload = async () => {
    if (!file) {
      toast.error("Выберите zip-архив");
      return;
    }
    if (!/\.zip$/i.test(file.name)) {
      toast.error("Модели загружаются одним zip-архивом (.zip)");
      return;
    }
    const target = offerId.trim().replace(/\.zip$/i, "");
    if (!target) {
      toast.error(
        "Укажите артикул (offer_id) или назовите файл {offer_id}.zip",
      );
      return;
    }
    setUploading(true);
    try {
      const result = await adminApi.uploadModel(file, target);
      toast.success(result.message || `Модель ${target} загружена`);
      // Мягкая проверка содержимого: архив сохранён, но файлов-моделей внутри нет
      if (result.model?.hasModelFiles === false) {
        toast.warning(
          "В архиве не найдено файлов-моделей (.stl/.3mf/.step/.obj/.txt) — архив сохранён, но проверьте содержимое",
        );
      }
      setFile(null);
      setOfferId("");
      const input = document.getElementById(
        "model-file-upload",
      ) as HTMLInputElement;
      if (input) input.value = "";
      loadModels();
    } catch (err: any) {
      toast.error(
        err.response?.data?.error || err.message || "Ошибка загрузки модели",
      );
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (offerId: string) => {
    setDownloadingOffer(offerId);
    try {
      const res = await adminApi.downloadModel(offerId);
      const fileName = getDownloadFileName(res, `${offerId}.zip`);
      const url = window.URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      toast.error(await getBlobErrorMessage(err, "Не удалось скачать модель"));
    } finally {
      setDownloadingOffer(null);
    }
  };

  const handleDelete = async (offerId: string) => {
    if (
      !confirm(
        `Удалить модель ${offerId}? Zip-архив будет удалён из S3, а сотрудники потеряют кнопку скачивания.`,
      )
    )
      return;
    setDeleting(offerId);
    try {
      await adminApi.deleteModel(offerId);
      toast.success(`Модель ${offerId} удалена`);
      loadModels();
    } catch (err: any) {
      toast.error(err.message || "Не удалось удалить модель");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="container mx-auto space-y-6 py-6">
      <div className="flex flex-col items-center justify-center gap-3 text-center lg:flex-row lg:justify-between">
        <h1 className="text-2xl font-bold">🧊 3D-модели (zip в S3)</h1>
      </div>

      {/* Загрузка новой/обновлённой модели */}
      <Card className="text-center lg:justify-center lg:text-start">
        <CardHeader>
          <CardTitle className="text-lg">📤 Загрузить модель (zip)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground text-start">
            Модель на артикул — всегда <strong>ОДИН zip-архив</strong> в корне
            S3-бакета:{" "}
            <code>
              s3://{"{bucket}"}/{"{offer_id}"}.zip
            </code>{" "}
            (например, <code>ARD000003-N.zip</code>). При обновлении файлов
            просто залейте новый архив — старый перезапишется, локальный кэш
            сбросится, а сотрудники с выданной моделью получат оповещение.
            Принимается только <strong>.zip</strong> (до 1 ГБ); содержимое
            архива проверяется мягко: файлы моделей (.stl, .3mf, .step, .obj,
            .txt) фиксируются в оповещении, но архив с посторонними файлами тоже
            загрузится. Артикул можно не указывать, если файл назван{" "}
            <code>{"{offer_id}.zip"}</code>.
          </p>
          <div className="grid gap-3 lg:grid-cols-2 lg:text-center">
            <div className="space-y-1.5">
              <Label
                className="justify-center lg:justify-start"
                htmlFor="model-offer-id"
              >
                Артикул (offer_id)
              </Label>
              <Input
                id="model-offer-id"
                placeholder="ARD000003-N"
                value={offerId}
                onChange={(e) => setOfferId(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label
                className="justify-center lg:justify-start cursor-pointer"
                htmlFor="model-file-upload"
              >
                Zip-архив
              </Label>
              <Input
                id="model-file-upload"
                type="file"
                accept=".zip,application/zip"
                onChange={handleFileChange}
                className="m-0 p-0 items-center file:h-full file:mr-4 file:px-3 file:rounded-lg file:border-0 file:bg-primary file:text-primary-foreground file:font-semibold file:cursor-pointer file:hover:bg-primary/90 hover:border-primary/60 cursor-pointer transition-all hover:bg-input/50 active:scale-[0.98]"
              />

              {file ? (
                <p className="text-sm text-muted-foreground mt-2 flex items-center gap-2">
                  <span className="text-foreground font-medium">Выбран:</span>{" "}
                  <div>
                    {" "}
                    <span className="font-mono text-xs break-all">
                      {file.name}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}
                      ({formatSize(file.size)})
                    </span>
                  </div>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground mt-2">
                  Архив не выбран
                </p>
              )}
            </div>
          </div>
          <Button onClick={handleUpload} disabled={uploading || !file}>
            {uploading ? "⏳ Загрузка…" : "📤 Загрузить в S3"}
          </Button>
        </CardContent>
      </Card>

      {/* Список моделей */}
      <Card className="text-center lg:justify-center">
        <CardHeader>
          <CardTitle className="flex flex-wrap justify-center text-center items-center gap-2 text-lg">
            🗃️ Загруженные модели{" "}
            <div className="flex justify-center items-center align-middle">
              {" "}
              {models.length > 0 && (
                <Badge variant="outline">
                  {hasSearch || hasFilter
                    ? `${visibleModels.length} из ${models.length}`
                    : models.length}
                </Badge>
              )}
              {/* {inWorkCount > 0 && (
                <Badge variant="secondary" className="ml-2">
                  🧰 в работе: {inWorkCount}
                </Badge>
              )} */}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Фильтр по артикулу (offer_id) + по статусу «в работе» */}
          {models.length > 0 && (
            <div className="flex flex-col gap-3 text-start lg:flex-row lg:items-stretch">
              <div className="flex w-full flex-col justify-end gap-1.5">
                <Label
                  className="text-center lg:text-start"
                  htmlFor="models-search"
                >
                  Поиск по артикулу (offer_id)
                </Label>
                <Input
                  id="models-search"
                  placeholder="🔖 Артикул (offer_id)..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>

              <div className="flex w-full min-w-0 flex-col justify-end gap-1.5 lg:max-w-xs">
                <Label
                  className="text-center lg:text-start"
                  htmlFor="models-filter"
                >
                  Статус модели
                </Label>
                <Select
                  value={filter}
                  onValueChange={(v) => setFilter((v ?? "all") as ModelFilter)}
                >
                  <SelectTrigger id="models-filter" className="w-full min-w-0">
                    <SelectValue className="truncate" placeholder="Все модели">
                      {(val) =>
                        MODEL_FILTERS.find((f) => f.value === val)?.label ||
                        "Все модели"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {MODEL_FILTERS.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {(hasSearch || hasFilter) && (
                <Button
                  variant="ghost"
                  className="self-center lg:self-end"
                  onClick={() => {
                    setSearch("");
                    setFilter("all");
                  }}
                >
                  ✕ Сбросить
                </Button>
              )}
            </div>
          )}

          {loading ? (
            <div className="py-6 text-center text-muted-foreground">
              Загрузка…
            </div>
          ) : models.length === 0 ? (
            <div className="py-6 text-center text-muted-foreground">
              Моделей пока нет — загрузите первый zip-архив
            </div>
          ) : visibleModels.length === 0 ? (
            <div className="py-6 text-center text-muted-foreground">
              {hasSearch
                ? `Ничего не найдено по артикулу «${search.trim()}»`
                : "Нет моделей с выбранным статусом"}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-center">Артикул</TableHead>
                  <TableHead className="text-center">Размер</TableHead>
                  <TableHead className="text-center hidden md:table-cell">
                    Версия (ETag)
                  </TableHead>
                  <TableHead className="text-center">Статус</TableHead>
                  <TableHead className="text-center hidden lg:table-cell">
                    Загружена
                  </TableHead>
                  <TableHead className="text-center hidden lg:table-cell">
                    Кем
                  </TableHead>
                  <TableHead className="text-center">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleModels.map((m) => (
                  <TableRow key={m.offer_id}>
                    <TableCell className="text-center">
                      <code className="font-bold">{m.offer_id}</code>
                      <div className="text-xs text-muted-foreground">
                        {m.file_name || `${m.offer_id}.zip`}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      {formatSize(m.file_size)}
                    </TableCell>
                    <TableCell className="text-center hidden md:table-cell">
                      <code className="text-xs text-muted-foreground">
                        {shortEtag(m.s3_etag)}
                      </code>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex flex-wrap items-center justify-center gap-1">
                        {m.issued_count ? (
                          <Badge variant="secondary" title="Выдана сотрудникам">
                            👷 {m.issued_count}
                          </Badge>
                        ) : null}
                        {m.in_cache ? (
                          <Badge
                            variant="outline"
                            title={
                              m.cache_fresh
                                ? "Файл в кэше сервера (актуальный)"
                                : "Файл в кэше сервера (скоро будет перечитан из S3)"
                            }
                          >
                            📦{m.cache_fresh ? "" : " ⏳"}
                          </Badge>
                        ) : null}
                        {!m.issued_count && !m.in_cache ? (
                          <span className="text-xs text-muted-foreground">
                            —
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-center hidden lg:table-cell text-xs text-muted-foreground">
                      {formatDateTime(m.uploaded_at)}
                    </TableCell>
                    <TableCell className="text-center hidden lg:table-cell text-xs text-muted-foreground">
                      {m.uploaded_by_name || m.uploaded_by || "—"}
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex justify-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={downloadingOffer === m.offer_id}
                          onClick={() => handleDownload(m.offer_id)}
                          title="Скачать zip себе"
                        >
                          {downloadingOffer === m.offer_id ? "⏳" : "⬇️"}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={deleting === m.offer_id}
                          onClick={() => handleDelete(m.offer_id)}
                          title="Удалить модель"
                        >
                          {deleting === m.offer_id ? "⏳" : "🗑"}
                        </Button>
                      </div>
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
