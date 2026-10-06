import { io, Socket } from "socket.io-client";
import api from "../api";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";
// Сокет подключается к корню сервера (без /api)
const SERVER_URL = API_URL.replace(/\/api\/?$/, "");

let socket: Socket | null = null;
let refreshAttempts = 0;

/**
 * Единственный экземпляр Socket.IO-соединения.
 * Токен передаётся в handshake.auth.token (см. middleware в backend/src/socket.js).
 */
export function getSocket(): Socket {
  if (socket) return socket;

  socket = io(SERVER_URL, {
    auth: { token: localStorage.getItem("accessToken") },
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
export function onNotificationsChanged(cb: (data: unknown) => void): () => void {
  const s = getSocket();
  s.on("notifications_changed", cb);
  return () => {
    s.off("notifications_changed", cb);
  };
}
