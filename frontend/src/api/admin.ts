import api from ".";
import type { AxiosResponse } from "axios";
import type { ProductPrice, ProductStats } from "./orders";

export interface User {
  id: number;
  username: string;
  email: string;
  name: string;
  /** Отображаемое имя для самого пользователя (меняется в Профиле) */
  display_name?: string | null;
  phone: string;
  capacity: number;
  earnings_factor: number;
  role: "guest" | "user" | "employee" | "moderator" | "admin" | "god";
  is_fired: boolean;
  taking_orders: boolean;
  /** 0/1 из SQLite — подтверждён ли email (код из письма / создание админом) */
  email_verified?: number;
  /**
   * «Когда-либо был сотрудником/staff» (0/1 из SQLite). Выставляется
   * сервером автоматически: при создании со staff-ролью или при выдаче
   * staff-роли через updateUser. Клиентом НЕ меняется.
   * Уволенный ex-сотрудник (роль понижена до 'user') имеет was_employee = 1,
   * а зарегистрировавшийся, но ещё не принятый в команду — 0.
   */
  was_employee?: number;
  tg_user_id: string | null;
  created_at: number;
  updated_at: number;
  stats?: {
    total_orders: number;
    total_amount: number;
    canceled_orders: number;
  };
  activeOrders?: Array<{ order_id: string; assigned_at: number }>;
  warehouses?: Array<{
    warehouse_id: string;
    name: string;
    address: string;
    is_rfbs: boolean;
  }>;
  // Заполняется только при withWarehouses=true в getUsers
  active_count?: number;
  // Выданные 3D-модели (offer_id из issued_models) — при withWarehouses=true
  issued_offer_ids?: string[];
}

export interface OfferModelRow {
  offer_id: string;
  s3_key: string;
  file_name: string | null;
  /**
   * Версия модели — ETag объекта в S3. Заполняется при загрузке через админку,
   * при синхронизации с S3 (модель залили мимо приложения) и при сверке перед
   * скачиванием. По изменению ETag бэкенд понимает, что файл обновлён:
   * сбрасывает локальный кэш и оповещает сотрудников.
   */
  s3_etag: string | null;
  file_size: number | null;
  uploaded_at: number | null;
  uploaded_by: number | null;
  uploaded_by_name: string | null;
  /** Сколько активных сотрудников получили артикул (плюс дочерние -NR/-NL) */
  issued_count?: number;
  /** Файл лежит в локальном кэше сервера (модель активно раздают) */
  in_cache?: boolean;
  /** Файл в кэше и не просрочен по TTL */
  cache_fresh?: boolean;
  /** Когда файл попал в локальный кэш (мс) */
  cached_at?: number | null;
  /** «Модель в работе»: выдана сотрудникам или лежит в кэше сервера */
  in_work?: boolean;
  // Заполняются в ответе на загрузку zip (ModelService.uploadModel):
  // список файлов в архиве и файлов-моделей (мягкая проверка содержимого)
  entries?: string[];
  modelFiles?: string[];
  hasModelFiles?: boolean;
  totalUncompressed?: number;
}

export interface StaffStatsRow {
  id: number;
  name: string;
  username: string;
  role: User["role"];
  is_fired: boolean;
  /** Всего заказов (user_stats.total_orders) */
  total_orders: number;
  /** Отменённые заказы (user_stats.canceled_orders) */
  canceled_orders: number;
  /** Суммарная сумма всех заказов (user_stats.total_amount) */
  total_amount: number;
  /** Заработок за всё время (SUM(earnings_history.amount)) */
  earnings_total: number;
  /** true — строка Создателя с 🎃 фейковыми данными (не из БД) */
  fake: boolean;
}

export interface Warehouse {
  warehouse_id: string;
  name: string;
  address: string | null;
  is_rfbs: boolean;
}

export interface AdminActiveOrder {
  orderId: string;
  userId: number;
  userName: string;
  assignedAt: number;
  warehouseName?: string | null;
  warehouseId?: string | null;
  statsStatus: "filled" | "missing";
  missingStats: string[];
  products: Array<{
    name: string;
    quantity: number;
    offer_id?: string;
    sku?: string;
    price?: ProductPrice;
    currency_code?: string;
    images?: Array<{ url: string; name: string }>;
    // 3D-модель (zip в S3): наличие = кнопка скачивания у сотрудника
    model?: { offerId: string; fileName: string; fileSize: number | null } | null;
    // Статистика товара (материал, цвет, вес); null — статистика не заполнена
    stats?: ProductStats | null;
  }>;
}

/** Товар в «слепке» завершённого заказа (сохраняется при завершении) */
export interface CompletedOrderProduct {
  offer_id?: string | null;
  name?: string | null;
  quantity?: number;
}

/** Строка таблицы «Завершённые заказы» */
export interface CompletedOrderRow {
  order_id: string;
  completed_at: number;
  user_id: number;
  user_name: string;
  /** Сумма заказа на момент завершения; null — заказ завершён до сохранения слепка */
  order_amount: number | null;
  /** Заработок по заказу (из earnings_history); 0, если не рассчитан */
  amount: number;
  /** Артикулы через пробел (для серверного поиска); null — слепка нет */
  offer_ids: string | null;
  /** Состав заказа; null — заказ завершён до сохранения слепка */
  products: CompletedOrderProduct[] | null;
}

/** Страница завершённых заказов (серверная пагинация) */
export interface CompletedOrdersPage {
  items: CompletedOrderRow[];
  total: number;
  hasMore: boolean;
}

export const adminApi = {
  // === Пользователи ===
  getUsers: (params?: {
    includeFired?: boolean;
    includeAll?: boolean;
    role?: string;
    // Когорта списка:
    //   'staff' — сотрудники и ex-сотрудники (в т.ч. уволенные с пониженной
    //   до 'user' ролью, был сотрудником: was_employee = 1);
    //   'users' — зарегистрированные, ещё НИКОГДА не бывшие сотрудниками
    //   (was_employee = 0) + гости (неподтверждённые регистрации, чтобы
    //   админ видел попытки и мог помочь). Без параметра — прежнее
    //   поведение (все, кроме гостей)
    cohort?: "staff" | "users";
    // Добавить к каждому пользователю склады (приоритеты) и active_count
    withWarehouses?: boolean;
  }) => api.get<User[]>("/admin/users", { params }).then((res) => res.data),

  getUserById: (id: number) =>
    api.get<User>(`/admin/users/${id}`).then((res) => res.data),

  // Создание аккаунта администратором (в обход подтверждения email):
  // аккаунт создаётся сразу подтверждённым и активным
  createUser: (data: {
    username: string;
    email: string;
    password: string;
    name?: string;
    phone?: string;
    capacity?: number;
    role?: "user" | "employee" | "moderator" | "admin";
  }) =>
    api
      .post<{ user: User; message: string }>("/admin/users", data)
      .then((res) => res.data),

  updateUser: (id: number, data: Partial<User>) =>
    api.put<User>(`/admin/users/${id}`, data).then((res) => res.data),

  deleteUser: (id: number) =>
    api.delete(`/admin/users/${id}`).then((res) => res.data),

  // === Статистика команды (вкладка «Статистика», только персонал) ===
  getStaffStats: (includeFired = false) =>
    api
      .get<StaffStatsRow[]>("/admin/stats", { params: { includeFired } })
      .then((res) => res.data),

  // 🎃 Пасхалка: редактирование фейковой статистики Создателя (только god).
  // Значения живут в памяти бэкенда до перезапуска сервера.
  updateGodFakeStats: (data: {
    total_orders?: number;
    canceled_orders?: number;
    total_amount?: number;
    earnings_total?: number;
  }) =>
    api
      .put<{ message: string; stats: StaffStatsRow }>("/admin/stats/god", data)
      .then((res) => res.data),

  // === Склады ===
  getWarehouses: () =>
    api.get<Warehouse[]>("/admin/warehouses").then((res) => res.data),

  syncWarehouses: () =>
    api.post("/admin/warehouses/sync").then((res) => res.data),

  // Синхронизация из серверного файла team-info.xlsx (кнопка «Обновить»
  // на странице «Пользователи»): выдаёт роль 👻 Создателю по GOD_EMAIL/GOD_ID
  syncFromServerFile: () =>
    api
      .post<{
        message: string;
        updated: number;
        created: number;
        skipped: number;
        /** Сотрудники, отсутствовавшие в Excel, — помечены уволенными */
        fired: number;
      }>("/admin/sync/server-file")
      .then((res) => res.data),

  // Актуальное (версионированное) имя файла сотрудников team-info-<версия>.xlsx —
  // для строгой проверки имени при загрузке файла на странице «Пользователи»
  getExpectedTeamInfoFileName: () =>
    api
      .get<{ fileName: string }>("/admin/sync/expected-filename")
      .then((res) => res.data),

  // Синхронизация сотрудников из загруженного Excel (team-info-<версия>.xlsx):
  // тот же syncBy=email, что и у кнопки «Обновить», но файл присылает клиент
  syncEmployeesFile: (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return api
      .post<{
        message: string;
        updated: number;
        created: number;
        skipped: number;
        /** Сотрудники, отсутствовавшие в Excel, — помечены уволенными */
        fired: number;
      }>("/admin/sync/employees", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((res) => res.data);
  },

  // === Заказы (админ) ===
  getAwaitingOrders: (warehouseId?: string) =>
    api
      .get("/admin/orders/awaiting", { params: { warehouseId } })
      .then((res) => res.data),

  getActiveOrders: () =>
    api.get<AdminActiveOrder[]>("/admin/orders/active").then((res) => res.data),

  getOrderDetails: (orderId: string) =>
    api.get(`/admin/orders/${orderId}/details`).then((res) => res.data),

  assignOrder: (orderId: string, userId: number) =>
    api
      .post(`/admin/orders/${orderId}/assign`, { userId })
      .then((res) => res.data),

  unassignOrder: (orderId: string) =>
    api.post(`/admin/orders/${orderId}/unassign`).then((res) => res.data),

  // Активные заказы сотрудника (аналог /employee_orders)
  getUserOrders: (userId: number) =>
    api
      .get<Array<{ order_id: string; assigned_at: number }>>(
        `/admin/users/${userId}/orders`,
      )
      .then((res) => res.data),

  // Завершённые заказы (страница «Завершённые заказы»): серверная пагинация.
  // userId — опционально: null/undefined = все сотрудники.
  // limit — размер страницы (число) или 'all' (полная выгрузка).
  // Фильтры: days — период в днях, orderId — подстрока номера заказа,
  // offerId — подстрока артикула (offer_id).
  getCompletedOrders: (params?: {
    userId?: number | null;
    days?: number | null;
    limit?: number | "all";
    offset?: number;
    orderId?: string;
    offerId?: string;
  }) =>
    api
      .get<CompletedOrdersPage>("/admin/orders/completed", {
        params: {
          ...(params?.userId ? { userId: params.userId } : {}),
          ...(params?.days ? { days: params.days } : {}),
          limit: params?.limit ?? 25,
          ...(params?.offset ? { offset: params.offset } : {}),
          ...(params?.orderId ? { orderId: params.orderId } : {}),
          ...(params?.offerId ? { offerId: params.offerId } : {}),
        },
      })
      .then((res) => res.data),

  // Сброс ВСЕХ активных назначений (аналог /clear_assignments)
  clearAssignments: () =>
    api
      .post<{ message: string }>("/admin/assignments/clear")
      .then((res) => res.data),

  // === Заработок ===
  // Blob-методы возвращают полный ответ axios, чтобы страница могла
  // взять версионированное имя файла из Content-Disposition.
  exportMonthlyEarnings: (month: string): Promise<AxiosResponse<Blob>> =>
    api.get("/admin/earnings/monthly", {
      params: { month },
      responseType: "blob",
    }),

  getActiveEarningsAll: () =>
    api.get("/admin/earnings/active").then((res) => res.data),

  addEarningsAdjustment: (userId: number, amount: number, reason?: string) =>
    api
      .post("/admin/earnings/adjust", { userId, amount, reason })
      .then((res) => res.data),

  settleEarnings: (userId: number) =>
    api.post(`/admin/earnings/settle/${userId}`).then((res) => res.data),

  resetAllEarnings: () =>
    api.post("/admin/earnings/reset").then((res) => res.data),

  // === Материалы ===
  getMaterials: () => api.get("/admin/materials").then((res) => res.data),

  uploadMaterials: (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return api
      .post("/admin/materials/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((res) => res.data);
  },

  // === Экспорт team-info ===
  exportTeamInfo: (includeFired = false): Promise<AxiosResponse<Blob>> =>
    api.get("/admin/export/team-info", {
      params: { includeFired },
      responseType: "blob",
    }),

  // === Экспорт статистики товаров (Excel) ===
  exportProductStats: (): Promise<AxiosResponse<Blob>> =>
    api.get("/admin/export/product-stats", { responseType: "blob" }),

  // === Скачивание файла базы данных (только админ) ===
  downloadDatabase: (): Promise<AxiosResponse<Blob>> =>
    api.get("/admin/export/database", { responseType: "blob" }),

  // === Создание бэкапа БД на сервере (только админ) ===
  createDbBackup: () => api.post("/admin/backup").then((res) => res.data),

  // === Скачивание текущих настроек materials-prices.json ===
  downloadMaterials: (): Promise<AxiosResponse<Blob>> =>
    api.get("/admin/materials/download", { responseType: "blob" }),

  // === Планировщик: пауза/возобновление авто-проверки очереди (аналог /pause, /resume) ===
  getSchedulerStatus: () =>
    api
      .get<{ paused: boolean }>("/admin/scheduler/status")
      .then((res) => res.data),

  pauseScheduler: () =>
    api
      .post<{ paused: boolean; message: string }>("/admin/scheduler/pause")
      .then((res) => res.data),

  resumeScheduler: () =>
    api
      .post<{ paused: boolean; message: string }>("/admin/scheduler/resume")
      .then((res) => res.data),

  // === Статистика товара: удаление (аналог /clear_product_stats) ===
  deleteProductStats: (offerId: string) =>
    api
      .delete(`/admin/product-stats/${encodeURIComponent(offerId)}`)
      .then((res) => res.data),

  // === Этикетка заказа (аналог /admin_send_label) ===
  // Без сотрудника — скачать PDF себе (в браузер)
  downloadOrderLabel: (orderId: string): Promise<AxiosResponse<Blob>> =>
    api.get(`/admin/orders/${encodeURIComponent(orderId)}/label`, {
      responseType: "blob",
    }),

  // С сотрудником — отправить ему этикетку (оповещение + скачивание)
  sendOrderLabelToEmployee: (orderId: string, userId: number) =>
    api
      .post(`/admin/orders/${encodeURIComponent(orderId)}/label/send`, { userId })
      .then((res) => res.data),

  // === 3D-модели (zip-архивы в S3, раздел «Модели») ===
  // Список всех моделей
  getModels: () =>
    api.get<OfferModelRow[]>("/admin/models").then((res) => res.data),

  // Загрузить/обновить zip для offer_id (offer_id можно не указывать —
  // тогда сервер возьмёт его из имени файла {offer_id}.zip)
  uploadModel: (file: File, offerId?: string) => {
    const formData = new FormData();
    formData.append("file", file);
    if (offerId) formData.append("offerId", offerId);
    return api
      .post<{ message: string; model: OfferModelRow }>(
        "/admin/models/upload",
        formData,
        { headers: { "Content-Type": "multipart/form-data" } },
      )
      .then((res) => res.data);
  },

  // Удалить модель (zip из S3 + метаданные)
  deleteModel: (offerId: string) =>
    api
      .delete<{ message: string }>(`/admin/models/${encodeURIComponent(offerId)}`)
      .then((res) => res.data),

  // Скачать модель себе (персонал)
  downloadModel: (offerId: string): Promise<AxiosResponse<Blob>> =>
    api.get(`/admin/models/${encodeURIComponent(offerId)}/download`, {
      responseType: "blob",
    }),
};

/**
 * Извлекает имя файла из заголовка Content-Disposition.
 * Сервер отдаёт версионированные имена (materials-prices-1.json,
 * bot_web-1.db, team-info-1.xlsx и т.п.). Поддерживаются RFC 5987
 * (filename*=UTF-8'') и обычный filename="...".
 */
export const getDownloadFileName = (
  res: AxiosResponse,
  fallback: string,
): string => {
  const contentDisposition =
    (res.headers?.["content-disposition"] as string) || "";
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].replace(/"/g, "").trim());
    } catch {
      // некорректный URL-encoding — пробуем обычный filename
    }
  }
  const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  if (plainMatch?.[1]) return plainMatch[1].trim();
  return fallback;
};

/**
 * Извлекает текст ошибки из Blob-ответа (при responseType: "blob"
 * серверные ошибки приходят как Blob в err.response.data).
 */
export const getBlobErrorMessage = async (err: any, fallback: string) => {
  if (err.response?.data instanceof Blob) {
    try {
      const text = await err.response.data.text();
      const parsed = JSON.parse(text);
      if (parsed?.error) return parsed.error;
    } catch {
      // не JSON — используем fallback
    }
  }
  return err.message || fallback;
};
