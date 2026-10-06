import axios from "axios";
import { store } from "../store";
import { updateUser, logout } from "../store/authSlice";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:5000/api",
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

// Добавляем токен в заголовки
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("accessToken");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Единый процесс обновления токена для всех одновременных 401.
// Без него каждый неудавшийся запрос делал бы свой /auth/refresh -> лавина запросов.
let refreshPromise: Promise<string> | null = null;

async function performRefresh(): Promise<string> {
  const refreshToken = localStorage.getItem("refreshToken");
  if (!refreshToken) throw new Error("No refresh token");

  const { data } = await axios.post(
    `${import.meta.env.VITE_API_URL || "http://localhost:5000/api"}/auth/refresh`,
    { refreshToken },
  );

  localStorage.setItem("accessToken", data.accessToken);
  // Поддерживаем ротацию refresh-токена, если сервер его возвращает
  if (data.refreshToken) {
    localStorage.setItem("refreshToken", data.refreshToken);
  }

  // Обновляем пользователя в store свежими данными
  const userResponse = await axios.get(
    `${import.meta.env.VITE_API_URL || "http://localhost:5000/api"}/auth/me`,
    {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    },
  );
  store.dispatch(updateUser(userResponse.data));

  return data.accessToken;
}

function refreshAccessToken(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = performRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

function handleUnauthorized(): void {
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  store.dispatch(logout());
  // Не обрушаем страницу, если мы уже на /login (защита от циклической переадресации)
  if (!window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
}

// Обработка 401 – единый рефреш токена
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Не пытаемся обновить токен при ошибке самого /auth/refresh и /auth/login
    const isAuthEndpoint =
      originalRequest?.url?.includes("/auth/refresh") ||
      originalRequest?.url?.includes("/auth/login");

    if (
      error.response?.status === 401 &&
      originalRequest &&
      !originalRequest._retry &&
      !isAuthEndpoint
    ) {
      originalRequest._retry = true;
      try {
        const newToken = await refreshAccessToken();
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        // 429 — сработал rate-limit, а не «мёртвая» сессия: токены ещё валидны.
        // Разлогинивать нельзя, иначе временное выгорание лимита превращается в
        // logout-шторм (все вылетают и заходят заново, долбя лимиты ещё сильнее).
        const status = (refreshError as { response?: { status?: number } })?.response
          ?.status;
        if (status !== 429) {
          handleUnauthorized();
        }
        return Promise.reject(refreshError);
      }
    }
    return Promise.reject(error);
  },
);

export default api;
