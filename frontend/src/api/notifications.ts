import api from ".";

// ============================================================================
// Типы (соответствуют строкам таблиц notifications / server_errors в
// notifications.db)
// ============================================================================

export type NotificationAudience = "user" | "staff";
export type NotificationBox = "mine" | "staff";

export interface NotificationItem {
  id: number;
  recipient_id: number;
  audience: NotificationAudience;
  type: string;
  title: string;
  message: string | null;
  payload: Record<string, unknown> | null;
  is_read: number | boolean;
  created_at: number;
}

export interface ServerErrorItem {
  id: number;
  level: "error" | "warn";
  source: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown> | null;
  is_read?: number | boolean;
  created_at: number;
}

export interface NotificationListResponse {
  items: NotificationItem[];
  total: number;
  hasMore: boolean;
}

export interface ServerErrorListResponse {
  items: ServerErrorItem[];
  total: number;
  hasMore: boolean;
}

/**
 * API страницы «Оповещения».
 * Личные оповещения доступны всем ролям (box='mine'),
 * журнал действий сотрудников и ошибки сервера — admin/moderator.
 */
export const notificationsApi = {
  // === Список ===
  list: (params: {
    box: NotificationBox;
    unread?: boolean;
    limit?: number;
    offset?: number;
    orderId?: string;
    userName?: string;
    offerId?: string;
  }) =>
    api
      .get<NotificationListResponse>("/notifications", { params })
      .then((res) => res.data),

  // === Непрочитанные (для бейджа) ===
  unreadCount: (box: NotificationBox) =>
    api
      .get<{ count: number }>("/notifications/unread-count", {
        params: { box },
      })
      .then((res) => res.data),

  // === Отметить прочитанными (выбранные или все) ===
  markRead: (box: NotificationBox, ids: number[]) =>
    api
      .post<{ changed: number }>("/notifications/read", { box, ids })
      .then((res) => res.data),

  markAllRead: (box: NotificationBox) =>
    api
      .post<{ changed: number }>("/notifications/read", { box, all: true })
      .then((res) => res.data),

  // === Удалить выбранные ===
  delete: (box: NotificationBox, ids: number[]) =>
    api
      .post<{ changed: number }>("/notifications/delete", { box, ids })
      .then((res) => res.data),

  // === Очистить прочитанные ===
  clearRead: (box: NotificationBox) =>
    api
      .post<{ changed: number }>("/notifications/clear-read", { box })
      .then((res) => res.data),

  // === Ошибки сервера (admin/moderator) ===
  errors: (params?: {
    level?: "error" | "warn";
    unread?: boolean;
    limit?: number;
    offset?: number;
  }) =>
    api
      .get<ServerErrorListResponse>("/notifications/errors", { params })
      .then((res) => res.data),

  errorsCount: (level?: "error" | "warn") =>
    api
      .get<{ count: number }>("/notifications/errors/count", {
        params: level ? { level } : undefined,
      })
      .then((res) => res.data),

  // Непрочитанные ошибки (для кнопки «Прочитать всё» на вкладке ошибок)
  errorsUnreadCount: (level?: "error" | "warn") =>
    api
      .get<{ count: number }>("/notifications/errors/unread-count", {
        params: level ? { level } : undefined,
      })
      .then((res) => res.data),

  // Отметить прочитанными выбранные ошибки (или все через all: true)
  markErrorsRead: (ids: number[]) =>
    api
      .post<{ changed: number }>("/notifications/errors/read", { ids })
      .then((res) => res.data),

  markAllErrorsRead: () =>
    api
      .post<{ changed: number }>("/notifications/errors/read", { all: true })
      .then((res) => res.data),

  deleteErrors: (ids: number[]) =>
    api
      .post<{ changed: number }>("/notifications/errors/delete", { ids })
      .then((res) => res.data),

  clearErrors: () =>
    api
      .post<{ changed: number }>("/notifications/errors/clear")
      .then((res) => res.data),
};
