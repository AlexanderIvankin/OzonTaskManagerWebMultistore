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
  // MULTISTORE: пять видов скачивания БД (одна + три общие + два ZIP)
  const [loadingUsersDb, setLoadingUsersDb] = useState(false);
  const [loadingModelsDb, setLoadingModelsDb] = useState(false);
  const [loadingNotificationsDb, setLoadingNotificationsDb] = useState(false);
  const [loadingStoreAll, setLoadingStoreAll] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);

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
      downloadBlob(res.data, getDownloadFileName(res, "store.db"));
      toast.success("Файл базы данных скачан");
    } catch (err: any) {
      toast.error(
        await getBlobErrorMessage(err, "Ошибка скачивания базы данных"),
      );
    } finally {
      setLoadingDb(false);
    }
  };

  /** Универсальный даунлоадер для снимков БД. */
  const downloadBlobWithName = async (
    fetcher: () => Promise<any>,
    fallbackName: string,
    setLoading: (v: boolean) => void,
    errorPrefix: string,
  ) => {
    setLoading(true);
    try {
      const res = await fetcher();
      downloadBlob(res.data, getDownloadFileName(res, fallbackName));
      toast.success("Файл скачан");
    } catch (err: any) {
      toast.error(await getBlobErrorMessage(err, errorPrefix));
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadUsersDb = () =>
    downloadBlobWithName(
      () => adminApi.downloadUsersDb(),
      "users.db",
      setLoadingUsersDb,
      "Ошибка скачивания users.db",
    );

  const handleDownloadModelsDb = () =>
    downloadBlobWithName(
      () => adminApi.downloadModelsDb(),
      "models.db",
      setLoadingModelsDb,
      "Ошибка скачивания models.db",
    );

  const handleDownloadNotificationsDb = () =>
    downloadBlobWithName(
      () => adminApi.downloadNotificationsDb(),
      "notifications.db",
      setLoadingNotificationsDb,
      "Ошибка скачивания notifications.db",
    );

  const handleDownloadStoreAll = () => {
    if (!confirm("Скачать ZIP с БД текущего магазина + 3 общие БД?")) return;
    return downloadBlobWithName(
      () => adminApi.downloadStoreAllDatabases(),
      "store_all.zip",
      setLoadingStoreAll,
      "Ошибка скачивания ZIP",
    );
  };

  const handleDownloadAll = () => {
    if (
      !confirm(
        "Скачать ZIP со ВСЕМИ БД приложения (все магазины + 3 общие)? " +
          "Это может быть долго и большой файл.",
      )
    )
      return;
    return downloadBlobWithName(
      () => adminApi.downloadAllDatabases(),
      "all_databases.zip",
      setLoadingAll,
      "Ошибка скачивания ZIP",
    );
  };

  const handleCreateBackup = async () => {
    if (
      !confirm(
        "Создать ПОЛНЫЙ бэкап всех БД на сервере?\n\n" +
          "Будут сохранены: users.db, models.db, notifications.db " +
          "и все store-N.db (все магазины).\n\n" +
          "Файлы попадут в backend/backups/<label>/ с датой и временем.",
      )
    )
      return;
    setCreatingBackup(true);
    try {
      const result = await adminApi.createDbBackup();
      // Если часть БД упала — наверх придёт 500 с деталями; при успехе
      // показываем сводку по созданным/пропущенным файлам.
      const created = Array.isArray(result?.created) ? result.created : [];
      const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
      if (created.length) {
        toast.success(
          `Бэкап создан: ${created.length} файл(ов)${skipped.length ? `, пропущено ${skipped.length}` : ""}`,
        );
      } else if (result?.file) {
        // Совместимость со старой сигнатурой
        toast.success(`Бэкап создан: ${result.file}`);
      } else {
        toast.success("Бэкап создан");
      }
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

      {/* === Бэкап на сервере (персонал) — ВЫНЕСЕНО НАВЕРХ === */}
      {isAdmin && (
        <Card className="border-destructive/40">
          <CardHeader className="flex flex-col items-center text-center justify-center gap-2 sm:text-start sm:flex-row sm:justify-start">
            <CardTitle className="flex items-center gap-2">
              🗄️ Бэкап на сервере
            </CardTitle>
            <div>
              <Badge variant="destructive">Backup</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Создаёт консистентные снимки (VACUUM INTO) <b>всех</b> баз данных
              приложения прямо на сервере: <code>users.db</code>,{" "}
              <code>models.db</code>, <code>notifications.db</code> и все{" "}
              <code>store-N.db</code> (каждый магазин). Файлы сохраняются в{" "}
              <code>backend/backups/&lt;label&gt;/</code> с датой и временем в
              имени. Ежедневный автобэкап запускается планировщиком в 00:00.
            </p>
            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
              <Button
                onClick={handleCreateBackup}
                disabled={creatingBackup}
                variant="default"
                className="min-w-0"
              >
                <span className="truncate min-w-0">
                  {creatingBackup
                    ? "Создаём бэкап..."
                    : "🗄️ Создать полный бэкап"}
                </span>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

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

      {/* Скачивание снимков БД — персонал */}
      {isAdmin && (
        <Card>
          <CardHeader className="flex flex-col items-center text-center justify-center gap-2 sm:text-start sm:flex-row sm:justify-start">
            <CardTitle className="flex items-center gap-2">
              💾 Скачать базы данных
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Скачиваются консистентные снимки (VACUUM INTO) на момент запроса:
              снимок пересобирается, поэтому размер может быть меньше файла БД
              на сервере — лишние страницы и «дырки» после удалений в него не
              попадают. Создание бэкапа <b>на сервере</b> — в самой верхней
              карточке страницы.
            </p>

            {/* store-N.db — БД текущего магазина */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-center sm:text-start">Этот магазин</p>
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <Button
                  onClick={handleDownloadDatabase}
                  disabled={loadingDb}
                  variant="outline"
                  className="min-w-0"
                >
                  <span className="truncate min-w-0">
                    {loadingDb ? "Готовим снимок..." : "💾 Скачать store-N.db"}
                  </span>
                </Button>
                <Button
                  onClick={handleDownloadStoreAll}
                  disabled={loadingStoreAll}
                  variant="outline"
                  className="min-w-0"
                >
                  <span className="truncate min-w-0">
                    {loadingStoreAll
                      ? "Готовим ZIP..."
                      : "📦 ZIP: магазин + общие БД"}
                  </span>
                </Button>
              </div>
            </div>

            {/* Общие БД */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-center sm:text-start">Общие БД (глобальные)</p>
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <Button
                  onClick={handleDownloadUsersDb}
                  disabled={loadingUsersDb}
                  variant="outline"
                  className="min-w-0"
                  size="sm"
                >
                  <span className="truncate min-w-0">
                    {loadingUsersDb ? "..." : "👥 users.db"}
                  </span>
                </Button>
                <Button
                  onClick={handleDownloadModelsDb}
                  disabled={loadingModelsDb}
                  variant="outline"
                  className="min-w-0"
                >
                  <span className="truncate min-w-0">
                    {loadingModelsDb ? "..." : "🧊 models.db"}
                  </span>
                </Button>
                <Button
                  onClick={handleDownloadNotificationsDb}
                  disabled={loadingNotificationsDb}
                  variant="outline"
                  className="min-w-0"
                >
                  <span className="truncate min-w-0">
                    {loadingNotificationsDb ? "..." : "🔔 notifications.db"}
                  </span>
                </Button>
              </div>
            </div>

            {/* Полный дамп всех БД в ZIP */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-center sm:text-start">Полный дамп всех БД</p>
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <Button
                  onClick={handleDownloadAll}
                  disabled={loadingAll}
                  variant="outline"
                  className="min-w-0"
                >
                  <span className="truncate min-w-0">
                    {loadingAll
                      ? "Готовим ZIP..."
                      : "📦 ZIP: все БД приложения"}
                  </span>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
