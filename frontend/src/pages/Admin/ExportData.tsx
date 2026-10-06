import { useState } from "react";
import { useSelector } from "react-redux";
import { RootState } from "../../store";
import {
  adminApi,
  getBlobErrorMessage,
  getDownloadFileName,
} from "../../api/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

const downloadBlob = (blob: Blob, fileName: string) => {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  window.URL.revokeObjectURL(url);
};

export const ExportData = () => {
  const user = useSelector((state: RootState) => state.auth.user);
  // Модератор = Администратор: экспорт/бэкап БД доступен и модератору, и Создателю
  const isAdmin = ["admin", "moderator", "god"].includes(user?.role || "");

  const [loadingStats, setLoadingStats] = useState(false);
  const [loadingDb, setLoadingDb] = useState(false);
  const [loadingTeam, setLoadingTeam] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);

  const handleExportProductStats = async () => {
    setLoadingStats(true);
    try {
      const res = await adminApi.exportProductStats();
      downloadBlob(res.data, getDownloadFileName(res, "product-stats.xlsx"));
      toast.success("Файл скачан");
    } catch (err: any) {
      toast.error(
        await getBlobErrorMessage(err, "Ошибка экспорта статистики товаров"),
      );
    } finally {
      setLoadingStats(false);
    }
  };

  const handleDownloadDatabase = async () => {
    if (
      !confirm(
        "Скачать копию файла базы данных? Рекомендуется делать это перед изменениями.",
      )
    )
      return;
    setLoadingDb(true);
    try {
      const res = await adminApi.downloadDatabase();
      // Имя файла берём из Content-Disposition (bot_web-1.db).
      // Клиентскую дату не подставляем, чтобы не расходиться с сервером.
      downloadBlob(res.data, getDownloadFileName(res, "bot_web.db"));
      toast.success("Файл базы данных скачан");
    } catch (err: any) {
      toast.error(
        await getBlobErrorMessage(err, "Ошибка скачивания базы данных"),
      );
    } finally {
      setLoadingDb(false);
    }
  };

  const handleCreateBackup = async () => {
    if (
      !confirm("Создать бэкап базы данных на сервере (папка backend/backups)?")
    )
      return;
    setCreatingBackup(true);
    try {
      const result = await adminApi.createDbBackup();
      toast.success(`Бэкап создан: ${result.file}`);
    } catch (err: any) {
      toast.error(err.message || "Ошибка создания бэкапа");
    } finally {
      setCreatingBackup(false);
    }
  };

  const handleExportTeamInfo = async (includeFired: boolean) => {
    setLoadingTeam(true);
    try {
      const res = await adminApi.exportTeamInfo(includeFired);
      downloadBlob(
        res.data,
        getDownloadFileName(
          res,
          includeFired ? "employees-db.xlsx" : "team-info.xlsx",
        ),
      );
      toast.success("Файл скачан");
    } catch (err: any) {
      toast.error(await getBlobErrorMessage(err, "Ошибка экспорта"));
    } finally {
      setLoadingTeam(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-center sm:text-start">
        📤 Экспорт данных
      </h1>

      {/* Статистика товаров */}
      <Card>
        <CardHeader>
          <CardTitle className="text-center sm:text-start">
            📊 Статистика товаров
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Выгрузка всей заполненной статистики товаров (артикул, материал,
            цвет, вес, кто заполнил, дата) в Excel.
          </p>
          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <Button
              onClick={handleExportProductStats}
              disabled={loadingStats}
              className="min-w-0"
            >
              <span className="truncate min-w-0">
                {loadingStats ? "Готовим файл..." : "📥 Скачать статистику"}
              </span>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Сотрудники (team-info) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-center sm:text-start">
            {" "}
            <span className="inline-block align-middle -translate-y-[3px]">
              👥
            </span>{" "}
            Сотрудники и склады
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Файл Excel со списком сотрудников, их складами и настройками
            (используется для синхронизации).
          </p>
          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <Button
              onClick={() => handleExportTeamInfo(false)}
              disabled={loadingTeam}
              className="min-w-0"
            >
              <span className="truncate min-w-0">📥 Скачать (активные)</span>
            </Button>
            <Button
              onClick={() => handleExportTeamInfo(true)}
              disabled={loadingTeam}
              variant="outline"
              className="min-w-0"
            >
              <span className="truncate min-w-0">
                📥 Скачать (включая уволенных)
              </span>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* База данных — для персонала (admin/moderator/god) */}
      {isAdmin && (
        <Card>
          <CardHeader className="flex flex-col items-center text-center justify-center gap-2 sm:text-start sm:flex-row sm:justify-start">
            <CardTitle className="flex items-center gap-2">
              🗄️ Файл базы данных
            </CardTitle>
            <div>
              <Badge variant="destructive">Backup</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Скачивается консистентный снимок базы данных (VACUUM INTO) на
              момент запроса: снимок пересобирается, поэтому его размер может
              быть меньше файла БД на сервере — лишние страницы и «дырки» после
              удалений в него не попадают. Кнопка «Бэкап на сервере» создаёт
              такой же проверенный снимок в папке backend/backups (ежедневный
              автобэкап также запускается планировщиком в 00:00).
            </p>
            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
              <Button
                onClick={handleDownloadDatabase}
                disabled={loadingDb}
                variant="outline"
                className="min-w-0"
              >
                <span className="truncate min-w-0">
                  {loadingDb
                    ? "Готовим снимок..."
                    : "💾 Скачать базу данных (.db)"}
                </span>
              </Button>
              <Button
                onClick={handleCreateBackup}
                disabled={creatingBackup}
                variant="outline"
                className="min-w-0"
              >
                <span className="truncate min-w-0">
                  {creatingBackup ? "Создаём бэкап..." : "🗄️ Бэкап на сервере"}
                </span>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
