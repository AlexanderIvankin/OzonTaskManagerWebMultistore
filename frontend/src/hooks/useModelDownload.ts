import { useCallback, useEffect, useRef, useState } from "react";
import { modelsApi, getModelFileName } from "../api/models";
import { toast } from "sonner";

/**
 * Состояние скачивания одной модели (по offerId).
 *
 *   idle         → кнопка «Скачать модель»
 *   preparing    → POST /prepare → 202, ждём task готовности (S3→сервер)
 *   downloading  → GET /download/:token, стрим локальный кэш→клиент
 *   done         → blob сохранён (или нативный download инициирован)
 *   error        → показать текст, кнопка снова «Скачать»
 */
export type ModelDownloadState =
  | { phase: "idle" }
  | { phase: "preparing"; taskId?: string }
  | {
      phase: "downloading";
      progress: number; // 0..1
      loadedBytes: number;
      totalBytes: number;
    }
  | { phase: "done" }
  | { phase: "error"; message: string };

export interface UseModelDownloadResult {
  /** Состояния по offerId (ключ = артикул, по которому лежит zip). */
  states: Record<string, ModelDownloadState>;
  /** Запустить полный цикл скачивания. Резолвится по завершении (успех/ошибка). */
  download: (offerId: string, fallbackFileName?: string) => Promise<void>;
  /** Сбросить состояние (например, при повторной попытке после ошибки). */
  reset: (offerId: string) => void;
  /** Хелпер для UI: идёт ли сейчас какая-то фаза (кнопка disabled). */
  isBusy: (offerId: string) => boolean;
}

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 300; // 10 минут — реально больше не нужно для 500 МБ

export function useModelDownload(): UseModelDownloadResult {
  const [states, setStates] = useState<Record<string, ModelDownloadState>>({});
  // AbortController для каждого offerId — отмена при анмаунте / повторном клике
  const abortRef = useRef<Map<string, AbortController>>(new Map());

  const setState = useCallback((offerId: string, next: ModelDownloadState) => {
    setStates((prev) => ({ ...prev, [offerId]: next }));
  }, []);

  const reset = useCallback(
    (offerId: string) => {
      const ctrl = abortRef.current.get(offerId);
      if (ctrl) {
        ctrl.abort();
        abortRef.current.delete(offerId);
      }
      setState(offerId, { phase: "idle" });
    },
    [setState],
  );

  // Cleanup при размонтировании — отменяем всё, что в процессе
  useEffect(() => {
    return () => {
      for (const ctrl of abortRef.current.values()) ctrl.abort();
      abortRef.current.clear();
    };
  }, []);

  const isBusy = useCallback(
    (offerId: string) => {
      const st = states[offerId];
      return st?.phase === "preparing" || st?.phase === "downloading";
    },
    [states],
  );

  /**
   * Поллинг задачи подготовки до готовности.
   * 404 → special error для re-prepare.
   * failed → ошибка.
   */
  const pollTask = useCallback(async (taskId: string, signal: AbortSignal) => {
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      if (signal.aborted) throw new Error("Отменено");
      await new Promise<void>((resolve) =>
        setTimeout(resolve, POLL_INTERVAL_MS),
      );
      if (signal.aborted) throw new Error("Отменено");

      let task;
      try {
        task = await modelsApi.getModelTask(taskId);
      } catch (err: any) {
        // 404 → задача потеряна (рестарт процесса). Отдаём special-код.
        if (err?.response?.status === 404) {
          const e = new Error("Task lost");
          (e as any).code = "TASK_NOT_FOUND";
          throw e;
        }
        throw err;
      }

      if (task.status === "ready") return task;
      if (task.status === "failed") {
        throw new Error(task.error || "Не удалось подготовить модель");
      }
      // preparing — продолжаем
    }
    throw new Error("Подготовка заняла слишком много времени");
  }, []);

  /**
   * Фаза 2: скачать blob и инициировать сохранение в браузере.
   * Имя берём из Content-Disposition (fallback — переданный).
   */
  const saveToDisk = useCallback(
    async (
      offerId: string,
      token: string,
      fallbackFileName: string,
      signal: AbortSignal,
    ) => {
      setState(offerId, {
        phase: "downloading",
        progress: 0,
        loadedBytes: 0,
        totalBytes: 0,
      });

      // responseType:'blob', onDownloadProgress — внутри modelsApi
      let blob: Blob;
      let fileName = fallbackFileName;
      try {
        blob = await modelsApi.downloadModelByToken(
          token,
          (loaded, total) => {
            if (signal.aborted) return;
            setState(offerId, {
              phase: "downloading",
              progress: total > 0 ? Math.min(loaded / total, 1) : 0,
              loadedBytes: loaded,
              totalBytes: total,
            });
          },
          signal,
        );
      } catch (err: any) {
        if (signal.aborted) throw new Error("Отменено");
        // 409 MODEL_NOT_PREPARED — кэш пропал (маловероятно, TTL token << cache TTL)
        if (err?.response?.status === 409) {
          const e = new Error("MODEL_NOT_PREPARED");
          (e as any).code = "MODEL_NOT_PREPARED";
          throw e;
        }
        throw err;
      }

      // Имя файла — из ответа. modelsApi возвращает только Blob; имя
      // может прийти отдельно, но у нас оно уже есть в state (task/prepare).
      // Для простоты используем fallback (он же task.fileName || offerId.zip).
      void getModelFileName; // оставляем helper экспортированным для будущего

      if (signal.aborted) throw new Error("Отменено");

      // Инициируем браузерную загрузку (нативно, без больших объектов в памяти)
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Небольшая задержка перед revoke — некоторые браузеры начинают
      // читать blob асинхронно сразу после click()
      setTimeout(() => window.URL.revokeObjectURL(url), 1000);

      setState(offerId, { phase: "done" });
    },
    [setState],
  );

  const download = useCallback(
    async (offerId: string, fallbackFileName?: string) => {
      // Отменяем предыдущее скачивание того же offerId (повторный клик)
      const prev = abortRef.current.get(offerId);
      if (prev) prev.abort();
      const ctrl = new AbortController();
      abortRef.current.set(offerId, ctrl);
      const signal = ctrl.signal;

      const fallback = fallbackFileName || `${offerId}.zip`;

      try {
        setState(offerId, { phase: "preparing" });

        // === Фаза 1: prepare ===
        let prep = await modelsApi.prepareModel(offerId);

        if (prep.ready) {
          // Кэш уже свежий — сразу к скачиванию
          await saveToDisk(
            offerId,
            prep.token,
            prep.fileName || fallback,
            signal,
          );
          return;
        }

        // Кэша нет — задача запущена. Поллим.
        setState(offerId, { phase: "preparing", taskId: prep.taskId });

        let task;
        try {
          task = await pollTask(prep.taskId, signal);
        } catch (err: any) {
          if (err?.code === "TASK_NOT_FOUND") {
            // Рестарт процесса: делаем re-prepare один раз.
            // Кэш, скорее всего, уже на диске — prepare вернёт ready.
            const retry = await modelsApi.prepareModel(offerId);
            if (retry.ready) {
              await saveToDisk(
                offerId,
                retry.token,
                retry.fileName || fallback,
                signal,
              );
              return;
            }
            // Иначе поллим новый taskId
            const ready = await pollTask(retry.taskId, signal);
            await saveToDisk(
              offerId,
              ready.token,
              ready.fileName || fallback,
              signal,
            );
            return;
          }
          throw err;
        }

        await saveToDisk(
          offerId,
          task.token,
          task.fileName || fallback,
          signal,
        );
      } catch (err: any) {
        if (signal.aborted) {
          setState(offerId, { phase: "idle" });
          return;
        }
        const message = err?.message || "Не удалось скачать модель";
        setState(offerId, { phase: "error", message });
        toast.error(message);
      } finally {
        abortRef.current.delete(offerId);
      }
    },
    [pollTask, saveToDisk, setState],
  );

  return { states, download, reset, isBusy };
}
