import api from ".";
import type { StoreInfo } from "../types";

export interface GlobalEarningsResponse {
  month: string;
  active: { baseEarnings: number; adjustments: number; total: number };
  monthly: { total: number; count: number };
  perStore: Array<{
    storeId: string;
    storeName: string;
    active: number;
    monthly: number;
    count: number;
  }>;
}

export interface MyMaterialsResponse {
  reference: { materials: string[]; colors: string[] };
  mine: Record<string, string[]>;
}

export const userApi = {
  /**
   * Список магазинов пользователя (для глобального профиля).
   * Работает без магазина — можно вызвать на корневом домене.
   */
  getStores: () => api.get<StoreInfo[]>("/user/stores").then((res) => res.data),

  // Получить список моих материалов и цветов данного материала в наличии
  getMyMaterials: () =>
    api.get<MyMaterialsResponse>("/user/my-materials").then((r) => r.data),

  // Обновить список моих материалов и цветов данного материала в наличии
  updateMyMaterial: (material: string, colors: string[]) =>
    api
      .put<{
        ok: boolean;
        material: string;
        colors: string[];
      }>(`/user/my-materials/${encodeURIComponent(material)}`, { colors })
      .then((r) => r.data),

  // Материалы и цвета текущего магазина — для формы «Заполнить статистику».
  // Тонкий payload: только названия (без цен за грамм — они для персонала).
  getMaterialsForForm: () =>
    api
      .get<{ materialNames: string[]; colors: string[] }>("/user/materials")
      .then((res) => res.data),

  // Заполнить статистику товара в текущем магазине (материал, цвет, вес)
  fillStats: (data: {
    offerId: string;
    material: string;
    color: string;
    weight: number;
  }) => api.post("/user/fill-stats", data).then((res) => res.data),

  // Получить активный заработок
  getActiveEarnings: () =>
    api.get("/user/earnings/active").then((res) => res.data),

  // Получить заработок за месяц
  getMonthlyEarnings: (month?: string) =>
    api
      .get("/user/earnings/monthly", { params: { month } })
      .then((res) => res.data),

  // Переключить приём заказов
  toggleTakingOrders: () =>
    api.post("/user/toggle-orders").then((res) => res.data),

  // Получить заработки по всем магазинам
  getGlobalEarnings: (month?: string) =>
    api
      .get<GlobalEarningsResponse>("/user/global-earnings", {
        params: month ? { month } : undefined,
      })
      .then((res) => res.data),

  // Обновить отображаемое имя (display_name) — глобальное поле users.
  // Доступно с глобального домена (магазин не нужен).
  updateDisplayName: (displayName: string) =>
    api.put("/user/display-name", { displayName }).then((res) => res.data),
};

// ============================================================================
// Web Push: подписки на оповещения.
// Канал доставки (Socket.IO или Web Push) выбирает сервер: онлайн-пользователю
// событие уходит сокетом, офлайн — Web Push на все подписанные устройства.
// ============================================================================

/** PushSubscription.toJSON() из браузера. */
export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushStatusResponse {
  /** Настроен ли Web Push на сервере (VAPID-ключи валидны). */
  enabled: boolean;
  /** Сколько УСТРОЙСТВ подписано (уникальных user_agent). */
  count: number;
  /** Пользователь отключил push глобально (users.push_disabled=1). */
  globallyDisabled: boolean;
}

export const pushApi = {
  /** Публичный VAPID-ключ сервера (applicationServerKey для pushManager.subscribe) */
  publicKey: () =>
    api
      .get<{ publicKey: string }>("/user/push-public-key")
      .then((res) => res.data),

  /** Сохранить/обновить подписку устройства (endpoint уникален на сервере) */
  subscribe: (subscription: PushSubscriptionJSON) =>
    api
      .post<{ ok: boolean }>("/user/push-subscribe", { subscription })
      .then((res) => res.data),

  /** Удалить подписку: одного устройства (endpoint) или всех (all: true) */
  unsubscribe: (body: { endpoint?: string; all?: boolean; device?: boolean }) =>
    api
      .post<{ ok: true; removed: number }>("/user/push-unsubscribe", body)
      .then((res) => res.data),

  // Статус push:
  //   enabled           — VAPID-ключи валидны на сервере (push вообще работает);
  //   count             — сколько УСТРОЙСТВ пользователя подписано
  //                       (уникальных user_agent, а не подписок);
  //   globallyDisabled  — пользователь отключил push глобально
  //                       (users.push_disabled=1): subscribe() не сохраняет
  //                       новые подписки, пока флаг не снят.
  status: () =>
    api
      .get<{
        enabled: boolean;
        count: number;
        globallyDisabled: boolean;
      }>("/user/push-status")
      .then((res) => res.data),

  // Разрешить push обратно (снять серверный флаг push_disabled).
  enable: () =>
    api.post<{ ok: true }>("/user/push-enable").then((res) => res.data),
};
