import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import api from "../api";
import { User } from "../types";

interface AuthState {
  user: User | null;
  accessToken: string | null;
  isLoading: boolean;
  error: string | null;
}

const initialState: AuthState = {
  user: null,
  accessToken: localStorage.getItem("accessToken"),
  isLoading: false,
  error: null,
};

export const login = createAsyncThunk<
  { user: User; accessToken: string; refreshToken: string },
  { usernameOrEmail: string; password: string }
>("auth/login", async (credentials) => {
  const response = await api.post("/auth/login", credentials);
  return response.data;
});

// Регистрация: сервер возвращает { user, message, resent }, где resent —
// была ли заменена «зависшая» неподтверждённая регистрация тем же
// логином/email (код отправлен повторно)
export const register = createAsyncThunk<
  { user: User; message: string; resent?: boolean },
  any
>("auth/register", async (userData) => {
  const response = await api.post("/auth/register", userData);
  return response.data;
});

// Подтверждение email по коду из письма — после него сервер присваивает роль user
export const verifyEmail = createAsyncThunk<
  { message: string; user: User },
  { code: string }
>("auth/verifyEmail", async ({ code }) => {
  const response = await api.post("/auth/verify-email", { code });
  return response.data;
});

// Повторная отправка кода подтверждения (если письмо не дошло).
// Сервер диктует кулдаун: retryAfterSec — сколько секунд кнопка будет
// заблокирована, sent = false — письмо не отправлено (кулдаун ещё идёт,
// аккаунта нет или email уже подтверждён)
export const resendCode = createAsyncThunk<
  { message: string; sent?: boolean; retryAfterSec?: number },
  { email: string }
>("auth/resendCode", async ({ email }) => {
  const response = await api.post("/auth/resend-code", { email });
  return response.data;
});

// Запрос на сброс пароля по email
export const forgotPassword = createAsyncThunk<
  { message: string; sent?: boolean; retryAfterSec?: number },
  { email: string }
>("auth/forgotPassword", async ({ email }) => {
  const response = await api.post("/auth/forgot-password", { email });
  return response.data;
});

// Установка нового пароля по коду из письма
export const resetPassword = createAsyncThunk<
  { success: boolean; message: string },
  { code: string; newPassword: string }
>("auth/resetPassword", async (payload) => {
  const response = await api.post("/auth/reset-password", payload);
  return response.data;
});


export const logout = createAsyncThunk("auth/logout", async () => {
  const refreshToken = localStorage.getItem("refreshToken");
  if (refreshToken) {
    await api.post("/auth/logout", { refreshToken });
  }
});

// Кэш промиса восстановления сессии: защита от повторных /auth/me
// (например из-за двойного монтирования в React.StrictMode в dev)
let restoreSessionPromise: Promise<any> | null = null;

export const restoreSession = createAsyncThunk(
  "auth/restoreSession",
  async () => {
    const token = localStorage.getItem("accessToken");
    if (!token) throw new Error("No token");

    if (!restoreSessionPromise) {
      restoreSessionPromise = api
        .get("/auth/me")
        .then((response) => response.data)
        .finally(() => {
          restoreSessionPromise = null;
        });
    }
    // Запрашиваем профиль пользователя
    return restoreSessionPromise;
  },
);

const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {
    updateUser(state, action) {
      state.user = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(login.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(login.fulfilled, (state, action) => {
        state.isLoading = false;
        state.user = action.payload.user;
        state.accessToken = action.payload.accessToken;
        localStorage.setItem("accessToken", action.payload.accessToken);
        localStorage.setItem("refreshToken", action.payload.refreshToken);
      })
      .addCase(login.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || "Login failed";
      })
      .addCase(register.fulfilled, () => {})
      .addCase(logout.fulfilled, (state) => {
        state.user = null;
        state.accessToken = null;
        localStorage.removeItem("accessToken");
        localStorage.removeItem("refreshToken");
      })
      .addCase(restoreSession.fulfilled, (state, action) => {
        state.user = action.payload;
        state.isLoading = false;
      })
      .addCase(restoreSession.rejected, (state) => {
        state.user = null;
        state.accessToken = null;
        localStorage.removeItem("accessToken");
        localStorage.removeItem("refreshToken");
        state.isLoading = false;
      });
  },
});

export const { updateUser } = authSlice.actions;
export default authSlice.reducer;
