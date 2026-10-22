import { io, Socket } from "socket.io-client";
import api from "../api";

// MULTISTORE: socket.io подключается к тому же origin, где открыт фронт
// (store1.lvh.me:5173 → store1.lvh.me:5173). Vite proxy перекидывает и HTTP,
// и WebSocket на backend, сохраняя Host — тогда storeResolver на бэке видит
// нужный магазин (см. vite.config.ts → server.proxy).
const SERVER_URL = window.location.origin;

let socket: Socket | null = null;
let refreshAttempts = 0;

/**
 * Единственный экземпляр Socket.IO-соединения.
 * Токен передаётся в handshake.auth.token (см. middleware в backend/src/socket.js).
 */
export function getSocket(): Socket {
  const currentToken = localStorage.getItem("accessToken");

  // ⚠️ MULTI-ACCOUNT: localStorage общий между вкладками одного origin.
  // Если токен изменился (другой аккаунт вошёл, logout), сокет с прежним
  // auth.token уже «не тот» — пересоздаём.
  if (socket) {
    // auth может быть объектом ИЛИ функцией-колбэком (socket.io-client),
    // поэтому достаём токен через type-guard.
    const socketToken =
      typeof socket.auth === "object" && socket.auth !== null
        ? (socket.auth as { token?: string }).token
        : undefined;

    if (socketToken !== currentToken) {
      socket.disconnect();
      socket = null;
      refreshAttempts = 0;
    }
  }

  if (socket) return socket;

  socket = io(SERVER_URL, {
    auth: { token: currentToken },
    transports: ["websocket", "polling"],
  });

  socket.on("connect", () => {
    refreshAttempts = 0;
  });

  socket.on("connect_error", async (err: Error) => {
    // Истёк access-токен: запрос /auth/me через axios-интерцептор вернёт 401,
    // интерцептор обновит accessToken, после чего переподключаемся с новым токеном.
    const isAuthError =
      err.message === "Invalid token" || err.message === "Authentication error";
    if (!isAuthError || refreshAttempts >= 3) return;
    refreshAttempts += 1;

    try {
      await api.get("/auth/me");
      if (socket) {
        socket.auth = { token: localStorage.getItem("accessToken") };
        socket.connect();
      }
    } catch {
      // Пользователь не авторизован — сокет подключится после повторного входа
    }
  });

  return socket;
}

/**
 * Разорвать соединение (при выходе из системы).
 */
export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}

/**
 * Подключён ли сокет прямо сейчас.
 * Нужен фронту как fallback: если live-тосты не приходят (сокет не
 * подключён), локальный тост вместо пропуска показывается — пользователь
 * всё равно увидит сообщение о кулдауне.
 */
export function isSocketConnected(): boolean {
  return Boolean(socket?.connected);
}

/**
 * Новое оповещение: личное (audience='user') или запись журнала действий
 * (audience='staff', только для админов/модераторов).
 * Возвращает функцию отписки.
 */
export function onNotificationNew(
  cb: (data: {
    id?: number;
    audience?: "user" | "staff";
    type: string;
    title: string;
    message?: string;
    createdAt?: number;
  }) => void,
): () => void {
  const s = getSocket();
  s.on("notification_new", cb);
  return () => {
    s.off("notification_new", cb);
  };
}

/**
 * Новая ошибка сервера (только для админов/модераторов).
 */
export function onServerErrorNew(
  cb: (data: {
    id?: number;
    level: "error" | "warn";
    source: string;
    message: string;
    createdAt?: number;
  }) => void,
): () => void {
  const s = getSocket();
  s.on("server_error_new", cb);
  return () => {
    s.off("server_error_new", cb);
  };
}

/**
 * Сокет подключился — в том числе ПЕРЕподключился после обрыва.
 * Нужен фронту как сигнал «я снова онлайн, подтяни состояние»: пока
 * пользователь был офлайн, оповещения могли прийти Web Push'ом, и счётчик
 * непрочитанных в сайдбаре нужно обновить (сценарий 2).
 * Возвращает функцию отписки.
 */
export function onSocketConnect(cb: () => void): () => void {
  const s = getSocket();
  s.on("connect", cb);
  return () => {
    s.off("connect", cb);
  };
}

/**
 * Список оповещений изменился (прочитано/удалено) — для синхронизации бейджа.
 */
export function onNotificationsChanged(
  cb: (data: unknown) => void,
): () => void {
  const s = getSocket();
  s.on("notifications_changed", cb);
  return () => {
    s.off("notifications_changed", cb);
  };
}

// --- CHAT ---

export interface ChatAttachmentPayload {
  id: number;
  fileName: string;
  mimeType: string;
  fileSize: number;
  url: string;
  previewUrl: string | null;
}

export interface ChatMessageNewPayload {
  threadId: number;
  userId: number;
  authorId: number;
  authorRole: string;
  authorName: string;
  body: string;
  preview: string;
  messageId: number;
  createdAt: number;
  storeId?: string | null;
  storeName?: string | null;
  replyTo?: {
    id: number;
    authorId: number;
    authorRole: string;
    authorName: string;
    body: string;
    quotedText: string | null;
    deleted: boolean;
  } | null;
  attachments?: ChatAttachmentPayload[];
}

export interface ChatThreadDeletedPayload {
  threadId: number;
  ownerId?: number;
}

export interface ChatMessageDeletedPayload {
  threadId: number;
  messageId: number;
  authorId: number;
  alreadyDeleted: boolean;
}

export function onChatMessageNew(
  cb: (data: ChatMessageNewPayload) => void,
): () => void {
  const s = getSocket();
  s.on("chat_message_new", cb);
  return () => {
    s.off("chat_message_new", cb);
  };
}

export function onChatThreadDeleted(
  cb: (data: ChatThreadDeletedPayload) => void,
): () => void {
  const s = getSocket();
  s.on("chat_thread_deleted", cb);
  return () => {
    s.off("chat_thread_deleted", cb);
  };
}

export function onChatMessageDeleted(
  cb: (data: ChatMessageDeletedPayload) => void,
): () => void {
  const s = getSocket();
  s.on("chat_message_deleted", cb);
  return () => {
    s.off("chat_message_deleted", cb);
  };
}

// --- CHAT: read receipts + typing ---

export interface ChatReadPayload {
  threadId?: number;
  by: "user" | "staff";
  scope?: string;
  lastReadMessageId?: number;
}

export interface ChatTypingPayload {
  threadId: number;
  authorId: number;
  authorName: string;
  isStaff: boolean;
}

export function onChatRead(cb: (data: ChatReadPayload) => void): () => void {
  const s = getSocket();
  s.on("chat_read", cb);
  return () => {
    s.off("chat_read", cb);
  };
}

export function onChatTyping(
  cb: (data: ChatTypingPayload) => void,
): () => void {
  const s = getSocket();
  s.on("chat_typing", cb);
  return () => {
    s.off("chat_typing", cb);
  };
}

/** Отправить «печатаю» на сервер (throttle — на вызывающей стороне). */
export function emitChatTyping(threadId: number): void {
  const s = getSocket();
  if (!s.connected) return;
  s.emit("chat_typing", { threadId });
}
