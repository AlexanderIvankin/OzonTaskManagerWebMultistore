import api from ".";
import type { AxiosResponse } from "axios";

// ============================================================================
// Двухфазное скачивание 3D-моделей (zip в S3).
//
//   prepareModel(offerId)        → 200 { ready:true,  token, ... }
//                                → 202 { ready:false, taskId, ... }
//   getModelTask(taskId)         → preparing | ready (с token) | failed
//   downloadModelByToken(token)  → Blob (Range-докачка при обрыве)
//
// Прямых ссылок на S3 нет. Token TTL ~15 мин, reusable в пределах TTL,
// привязан к user_id + offer_id. Range работает (обрыв → повторный GET).
// ============================================================================

export interface ModelPrepareReady {
  ready: true;
  token: string;
  expiresAt: number;
  offerId: string;
  requestedOfferId?: string;
  sourceOfferId?: string;
  fileName: string;
  fileSize: number | null;
  version?: string | null;
}

export interface ModelPreparePending {
  ready: false;
  taskId: string;
  offerId: string;
  requestedOfferId?: string;
  sourceOfferId?: string;
  fileName: string;
  fileSize: number | null;
}

export type ModelPrepareResponse = ModelPrepareReady | ModelPreparePending;

export interface ModelTaskPreparing {
  status: "preparing";
  taskId: string;
  offerId: string;
  fileName: string;
  fileSize: number | null;
}

export interface ModelTaskReady {
  status: "ready";
  taskId: string;
  offerId: string;
  fileName: string;
  fileSize: number | null;
  token: string;
  expiresAt: number;
  version?: string | null;
}

export interface ModelTaskFailed {
  status: "failed";
  taskId: string;
  offerId: string;
  error: string;
}

export type ModelTaskResponse =
  | ModelTaskPreparing
  | ModelTaskReady
  | ModelTaskFailed;

/**
 * Извлекает текст ошибки из Blob-ответа (responseType: "blob").
 * При ошибке axios кладёт серверный { error } в Blob.
 */
async function extractBlobError(
  err: unknown,
  fallback: string,
): Promise<string> {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data instanceof Blob) {
    try {
      const text = await data.text();
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === "string") return parsed.error;
    } catch {
      // не JSON — fallback
    }
  }
  const asAny = err as { response?: { data?: { error?: unknown } } };
  if (asAny?.response?.data && typeof asAny.response.data.error === "string") {
    return asAny.response.data.error;
  }
  const msg = (err as { message?: string })?.message;
  return msg || fallback;
}

export const modelsApi = {
  /**
   * Фаза 1: подготовка модели.
   *  200 → кэш свежий (ready:true + token).
   *  202 → запущена задача S3→кэш (ready:false + taskId).
   */
  prepareModel: (offerId: string) =>
    api
      .post<ModelPrepareResponse>(
        `/models/prepare/${encodeURIComponent(offerId)}`,
        {},
        { timeout: 30000 },
      )
      .then((res) => res.data),

  /**
   * Фаза 1b: статус задачи. 404 → задача потеряна (рестарт процесса),
   * хук делает re-prepare один раз.
   */
  getModelTask: (taskId: string) =>
    api
      .get<ModelTaskResponse>(`/models/tasks/${encodeURIComponent(taskId)}`)
      .then((res) => res.data),

  /**
   * Фаза 2: скачать zip по токену.
   * timeout:0 — 500 МБ на медленном интернете.
   * responseType:'blob' — нужен onDownloadProgress (см. хуке).
   * При ошибке сервер отдаёт JSON → извлекаем текст.
   */
  downloadModelByToken: async (
    token: string,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<Blob> => {
    try {
      const res: AxiosResponse<Blob> = await api.get(
        `/models/download/${encodeURIComponent(token)}`,
        {
          responseType: "blob",
          timeout: 0,
          signal,
          onDownloadProgress: (e) => {
            if (onProgress) onProgress(e.loaded, e.total || 0);
          },
        },
      );
      return res.data;
    } catch (err) {
      throw new Error(await extractBlobError(err, "Не удалось скачать модель"));
    }
  },
};

/**
 * Имя файла из заголовка Content-Disposition.
 * Поддерживает filename*=UTF-8''... (RFC 5987) и обычный filename="...".
 */
export function getModelFileName(
  headers: Record<string, unknown> | undefined,
  fallback: string,
): string {
  const cd = String(headers?.["content-disposition"] || "");
  const utf8 = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].replace(/"/g, "").trim());
    } catch {
      // fallthrough
    }
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  if (plain?.[1]) return plain[1].trim();
  return fallback;
}
