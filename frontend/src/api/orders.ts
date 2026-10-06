import api from ".";

// Ошибка при responseType: "blob" тело ошибки приходит Blob-ом, а не JSON-ом —
// достаём из него { error, cooldown } (см. Orders.tsx для исторического контекста).
export interface ApiErrorPayload {
  error?: string;
  /** true — сервер ответил 429: сработал кулдаун команды (live-тост уже ушёл) */
  cooldown?: boolean;
  retryAfterSec?: number;
}

/**
 * Разбирает тело ошибки API (JSON или Blob) в { error, cooldown }.
 * Возвращает null, если тело не JSON (обрыв соединения и т.п.).
 */
export async function readApiErrorPayload(
  err: unknown,
): Promise<ApiErrorPayload | null> {
  try {
    const data = (err as { response?: { data?: unknown } })?.response?.data;
    if (data instanceof Blob) {
      const parsed = JSON.parse(await data.text());
      if (parsed && typeof parsed === "object") {
        return parsed as ApiErrorPayload;
      }
    } else if (
      typeof data === "object" &&
      data !== null &&
      typeof (data as { error?: unknown }).error === "string"
    ) {
      return data as ApiErrorPayload;
    }
  } catch {
    // Не-JSON ответ (обрыв соединения и т.п.) — переходим к общему сообщению
  }
  return null;
}

/** Человекочитаемый текст ошибки или null. */
export async function readApiErrorMessage(err: unknown): Promise<string | null> {
  const payload = await readApiErrorPayload(err);
  return typeof payload?.error === "string" ? payload.error : null;
}

export interface ProductModel {
  /** Артикул, по которому лежит zip (может отличаться: родитель -NR/-NL) */
  offerId: string;
  fileName: string;
  fileSize: number | null;
}

export interface Order {
  orderId: string;
  assignedAt: number;
  statsStatus: "filled" | "missing";
  missingStats: string[];
  products: OrderProduct[];
  // images убраны с верхнего уровня — фото теперь привязаны к каждому товару (products[].images)
}

/**
 * Завершённый заказ, который ещё ожидает отправки (awaiting_deliver) —
 * вкладка «🗳️ Завершённые заказы»: тот же состав с фотографиями, но
 * единственное действие — скачать этикетку (getPackageLabel).
 */
export interface CompletedOrder {
  orderId: string;
  completedAt: number;
  products: OrderProduct[];
}

/** Ответ POST /user/orders/refresh: оба списка после синхронизации с Ozon */
export interface OrdersSnapshot {
  active: Order[];
  completed: CompletedOrder[];
  syncedAt: number;
  /** Сколько заказов убрано из кэша (вышли из awaiting_packaging/awaiting_deliver) */
  removed: number;
}

/** Статистика товара из product_stats (материал, цвет, вес) */
export interface ProductStats {
  material: string;
  color: string;
  weight_grams: number;
}

/** Цена товара в данных Ozon: строка/число или объект { amount, currency } */
export type ProductPrice =
  | string
  | number
  | { amount?: string | number; currency?: string };

export interface OrderProduct {
  name: string;
  quantity: number;
  offer_id?: string;
  sku?: string;
  price?: ProductPrice;
  currency_code?: string;
  images?: Array<{ url: string; name: string }>;
  // 3D-модель (zip в S3) — если есть, клиент показывает кнопку «Скачать модель»
  model?: ProductModel | null;
  // Статистика товара (материал, цвет, вес); null — статистика не заполнена
  stats?: ProductStats | null;
}

export interface FinishOrderResponse {
  message: string;
  earnings: number;
  label: "available" | "not available";
}

export interface ModelDownloadGrant {
  token: string;
  expiresAt: number;
  /** Артикул, по которому реально лежит zip (для товара -NR/-NL это родитель) */
  offerId: string;
  /** Артикул, запрошенный клиентом (может отличаться от offerId) */
  requestedOfferId?: string;
  sourceOfferId?: string;
  fileName: string;
  fileSize: number | null;
  /**
   * Версия модели — ETag объекта в S3. При скачивании бэкенд сверяет её с
   * хранилищем: если архив обновили напрямую в S3, сотруднику уходит
   * оповещение «Модель обновлена», а скачивается уже актуальная версия.
   */
  version?: string | null;
}

export const ordersApi = {
  // Получить активные заказы текущего пользователя
  getActiveOrders: () =>
    api.get<Order[]>("/user/orders/active").then((res) => res.data),

  // Получить завершённые заказы, ещё ожидающие отправки (вкладка «Завершённые»)
  getCompletedOrders: () =>
    api.get<CompletedOrder[]>("/user/orders/completed").then((res) => res.data),

  // Обновить статусы всех заказов (активные + завершённые) и получить оба списка.
  // Кулдаун 1 минута: сервер отвечает 429 { cooldown: true, retryAfterSec }
  refreshOrders: () =>
    api.post<OrdersSnapshot>("/user/orders/refresh").then((res) => res.data),

  // Завершить заказ
  finishOrder: (orderId: string) =>
    api
      .post<FinishOrderResponse>(`/user/orders/${orderId}/finish`)
      .then((res) => res.data),

  // Отменить заказ
  cancelOrder: (orderId: string) =>
    api.post(`/user/orders/${orderId}/cancel`).then((res) => res.data),

  // Скачать этикетку (возвращает Blob)
  getLabel: (orderId: string) =>
    api
      .get(`/user/orders/${orderId}/label`, { responseType: "blob" })
      .then((res) => res.data),

  // Скачать все этикетки
  getAllLabels: () =>
    api
      .get("/user/orders/labels/all", { responseType: "blob" })
      .then((res) => res.data),

  // Скачать этикетку, отправленную администратором (оповещение label_sent)
  getSentLabel: (orderId: string) =>
    api
      .get(`/user/labels/${encodeURIComponent(orderId)}/sent`, {
        responseType: "blob",
      })
      .then((res) => res.data),

  // === 3D-модели (zip, без прямых ссылок на S3) ===
  // Шаг 1: запросить одноразовый токен скачивания (TTL ~15 минут)
  requestModelToken: (offerId: string) =>
    api
      .post<ModelDownloadGrant>(
        `/models/request/${encodeURIComponent(offerId)}`,
      )
      .then((res) => res.data),

  // Шаг 2: скачать zip по токену (токен гасится при первом обращении)
  downloadModelByToken: (token: string) =>
    api
      .get(`/models/download/${token}`, { responseType: "blob" })
      .then((res) => res.data),
};

