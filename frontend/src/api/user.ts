import api from ".";
import type { StoreInfo } from "../types";

export const userApi = {
  /**
   * Список магазинов пользователя (для глобального профиля).
   * Работает без магазина — можно вызвать на корневом домене.
   */
  getStores: () =>
    api.get<StoreInfo[]>("/user/stores").then((res) => res.data),

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

  // Обновить отображаемое имя (display_name) — только свой профиль
  updateDisplayName: (displayName: string) =>
    api
      .put("/user/profile", { displayName })
      .then((res) => res.data),
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
  unsubscribe: (payload: { endpoint?: string; all?: boolean }) =>
    api
      .post<{ ok: boolean; removed: number }>("/user/push-unsubscribe", payload)
      .then((res) => res.data),

  /** Сколько устройств подписано (для UI профиля) */
  status: () =>
    api
      .get<{ enabled: boolean; count: number }>("/user/push-status")
      .then((res) => res.data),
};
