import { useEffect, useState } from "react";
import {
  adminApi,
  getBlobErrorMessage,
  getDownloadFileName,
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
import { toast } from "sonner";

interface MaterialsData {
  materials: Record<string, number>;
  specialOffers: Record<string, number>;
  minEarnings: number;
  colors: string[];
  // Каноничное имя файла настроек с учётом BOT_VERSION (materials-prices-1.json)
  fileName?: string;
}

export const Materials = () => {
  const [data, setData] = useState<MaterialsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  // Актуальное имя файла настроек (приходит с сервера, зависит от BOT_VERSION)
  const [expectedFileName, setExpectedFileName] = useState("");

  const loadMaterials = async () => {
    setLoading(true);
    try {
      const result = await adminApi.getMaterials();
      setData(result);
      setExpectedFileName(result.fileName || "");
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить настройки материалов");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMaterials();
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
    }
  };

  // Строгое совпадение имени с актуальным версионированным файлом
  const fileNameMismatch =
    file !== null && expectedFileName !== "" && file.name !== expectedFileName;

  const handleUpload = async () => {
    if (!file) {
      toast.error("Выберите файл");
      return;
    }
    // Настройки всегда сохраняются в актуальный версионированный файл,
    // поэтому чужое имя файла = вероятная ошибка конфигурации — отклоняем
    if (fileNameMismatch) {
      toast.error(
        `Неверное имя файла: "${file.name}". Ожидается "${expectedFileName}"`,
      );
      return;
    }
    // Запасная проверка, если сервер не сообщил имя (старый бэкенд)
    if (
      !expectedFileName &&
      !/^materials-prices(-\d+)?\.json$/.test(file.name)
    ) {
      toast.error(
        "Неверное имя файла: ожидается materials-prices.json или materials-prices-<версия>.json",
      );
      return;
    }
    setUploading(true);
    try {
      await adminApi.uploadMaterials(file);
      toast.success("Файл материалов загружен");
      setFile(null);
      // Сбросить input
      const input = document.getElementById("file-upload") as HTMLInputElement;
      if (input) input.value = "";
      loadMaterials(); // перезагрузить данные
    } catch (err: any) {
      // Показываем текст ошибки с сервера (например, про несовпадение имени)
      toast.error(
        err.response?.data?.error || err.message || "Ошибка загрузки",
      );
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await adminApi.downloadMaterials();
      const url = window.URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = getDownloadFileName(
        res,
        expectedFileName || "materials-prices.json",
      );
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success("Файл скачан");
    } catch (err: any) {
      toast.error(
        await getBlobErrorMessage(err, "Ошибка скачивания файла настроек"),
      );
    } finally {
      setDownloading(false);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-10 text-muted-foreground">Загрузка...</div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-10 text-red-500">
        Не удалось загрузить данные
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center justify-center gap-3 text-center md:flex-row md:justify-between">
        <h1 className="text-2xl font-bold">📁 Управление материалами</h1>
        <Button onClick={loadMaterials} disabled={loading}>
          🔄 Обновить
        </Button>
      </div>

      {/* Карточка с загрузкой файла */}
      <Card className="text-center justify-center md:text-start md:justify-start">
        <CardHeader>
          <CardTitle>Загрузить новый файл материалов</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="mb-[10px] cursor-pointer" htmlFor="file-upload">
              Файл настроек (ожидается{" "}
              {expectedFileName || "materials-prices.json"})
            </Label>
            <Input
              id="file-upload"
              type="file"
              accept=".json"
              onChange={handleFileChange}
              className="m-0 p-0 items-center file:h-full file:mr-4 file:px-3 file:rounded-lg file:border-0 file:bg-primary file:text-primary-foreground file:font-semibold file:cursor-pointer file:hover:bg-primary/90 hover:border-primary/60 cursor-pointer transition-all hover:bg-input/50 active:scale-[0.98]"
            />
            {file ? (
              <p className="text-sm text-muted-foreground mt-2 flex items-center gap-2">
                <span className="text-foreground font-medium">Выбран:</span>{" "}
                <div>
                  <span className="font-mono text-xs break-all">
                    {file.name}
                  </span>
                </div>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground mt-2">
                Файл не выбран
              </p>
            )}
            {fileNameMismatch && (
              <p className="text-xs text-red-500 mt-1">
                ⚠️ Имя файла не совпадает с актуальным: {expectedFileName}
              </p>
            )}
          </div>
          <div className="flex justify-center md:justify-start">
            <Button
              onClick={handleUpload}
              disabled={!file || uploading || fileNameMismatch}
              /* max-w-full не дает кнопке вылезать за пределы экрана, а w-full растягивает в пределах контейнера */
              className="md:w-auto w-full max-w-[340px] md:max-w-none"
            >
              {uploading ? (
                "Загрузка..."
              ) : (
                /* Оборачиваем текст в span с классом truncate */
                <span className="truncate block w-full text-center">
                  📤 Загрузить {expectedFileName || "materials-prices.json"}
                </span>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Карточка со скачиванием текущих настроек */}
      <Card className="text-center justify-center md:text-start md:justify-start">
        <CardHeader>
          <CardTitle>Текущий файл настроек</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Скачайте актуальный {expectedFileName || "materials-prices.json"},
            чтобы сохранить копию текущих настроек или отредактировать его для
            повторной загрузки.
          </p>
          <div className="flex justify-center md:justify-start">
            <Button
              onClick={handleDownload}
              disabled={downloading}
              variant="outline"
              /* max-w-full не дает кнопке вылезать за пределы экрана, а w-full растягивает в пределах контейнера */
              className="md:w-auto w-full max-w-[340px] md:max-w-none"
            >
              {downloading ? (
                "Скачивание..."
              ) : (
                /* Оборачиваем текст в span с классом truncate */
                <span className="truncate block w-full text-center">
                  📥 Скачать {expectedFileName || "materials-prices.json"}
                </span>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Текущие настройки */}
      <Card className="text-center justify-center md:text-start md:justify-start">
        <CardHeader>
          <CardTitle>Текущие настройки</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold">
              Минимальный заработок за единицу:{" "}
              <Badge variant="destructive">{data.minEarnings} руб.</Badge>
            </h3>
          </div>
          <div>
            <h3 className="font-semibold mb-2">Цвета пластика:</h3>
            <div className="flex text-center justify-center md:text-start md:justify-start flex-wrap gap-2">
              {data.colors.map((color) => (
                <Badge key={color} variant="secondary">
                  {color}
                </Badge>
              ))}
            </div>
          </div>
          <div>
            <h3 className="font-semibold mb-2">Цены материалов (руб/грамм):</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-center md:text-start">Материал</TableHead>
                  <TableHead className="text-center md:text-right">Цена за грамм</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(data.materials).map(([name, price]) => (
                  <TableRow key={name}>
                    <TableCell>{name}</TableCell>
                    <TableCell className="text-center md:text-right">
                      {price.toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {Object.keys(data.specialOffers).length > 0 && (
            <div>
              <h3 className="font-semibold mb-2">Специальные предложения:</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-center md:text-start">Offer ID</TableHead>
                    <TableHead className="text-center md:text-right">
                      Стоимость (руб/шт)
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(data.specialOffers).map(
                    ([offerId, price]) => (
                      <TableRow key={offerId}>
                        <TableCell>
                          <code>{offerId}</code>
                        </TableCell>
                        <TableCell className="text-center md:text-right">
                          {price.toFixed(2)}
                        </TableCell>
                      </TableRow>
                    ),
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
