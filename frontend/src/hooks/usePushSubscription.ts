// src/hooks/usePushSubscription.ts
import { useCallback, useEffect, useRef, useState } from "react";
import { pushApi, PushSubscriptionJSON } from "../api/user";
import { getRootOrigin } from "../lib/urls";

// ============================================================================
// Подписка браузера на Web Push (вторая половина пары к Socket.IO).
//
// Пока у пользователя есть хотя бы один активный сокет, событие уходит
// мгновенно по WebSocket. Как только сокетов нет — NotificationService
// отправляет Web Push на ВСЕ подписанные устройства (TTL 24 ч).
//
// Правила подписки:
//   1) Разрешение уже выдано — подписываемся МОЛЧА при каждом входе (сервер
//      делает upsert по endpoint: обновляет user_id и last_used_at).
//   2) Разрешение ещё не спрашивали — попап сами НЕ показываем (люди его
//      отклоняют, и вернуть разрешение уже нельзя): уведомления включаются
//      кнопкой в профиле -> enable().
//   3) Ключи VAPID на сервере перегенерировали — старая подписка привязана к
//      прежнему applicationServerKey: сверяем и переподписываемся.
//   4) Выход из системы (disablePush) отписывает устройство, чтобы чужие
//      оповещения на этом браузере больше не приходили.
// ============================================================================

// ============================================================================
// «Пользователь сам отключил уведомления на этом устройстве».
//
// ВАЖНО: отписка (pushManager.unsubscribe) НЕ отзывает разрешение браузера —
// Notification.permission остаётся 'granted'. Без этого флага молчаливая
// автоподписка при следующей загрузке страницы оформляла подписку заново, и
// кнопка «Отключить» не работала. Флаг живёт в localStorage, т.е. это
// устройство/браузер (как и сама подписка), и НЕ сбрасывается при выходе из
// системы: логаут — не отказ от уведомлений.
// ============================================================================
const PUSH_OPT_OUT_KEY = "pushNotificationsDisabled";

/**
 * Мы на корневом домене? Push-подписки живут ТОЛЬКО здесь.
 *
 * На поддоменах (store1.na3d.ru) мы ничего не подписываем: одна подписка
 * на устройство, живёт на root-domain. Клик по баннеру открывает нужный
 * магазин через absolute URL в payload.
 */
function isRootDomain(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const root = new URL(getRootOrigin()).origin; // "https://na3d.ru"
    const current = window.location.origin; // "https://store1.na3d.ru"
    if (current === root) return true;
    // www.root — тоже корневой
    const www = root.replace("://", "://www.");
    if (current === www) return true;
    return false;
  } catch {
    return false;
  }
}

/** Пользователь осознанно отключил push на этом устройстве? */
function isPushOptedOut(): boolean {
  try {
    return localStorage.getItem(PUSH_OPT_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

/** Запомнить выбор пользователя (true — отключено, false — включено). */
function setPushOptedOut(disabled: boolean): void {
  try {
    if (disabled) localStorage.setItem(PUSH_OPT_OUT_KEY, "1");
    else localStorage.removeItem(PUSH_OPT_OUT_KEY);
  } catch {
    /* localStorage недоступен — работаем как раньше */
  }
}

// new Uint8Array(length) даёт Uint8Array<ArrayBuffer> — это и есть BufferSource,
// который ожидает pushManager.subscribe({ applicationServerKey }).
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

/** applicationServerKey (ArrayBuffer) -> base64url для сверки с ключом сервера. */
function keyToBase64Url(key?: ArrayBuffer | null): string | null {
  if (!key) return null;
  try {
    let binary = "";
    new Uint8Array(key).forEach(
      (byte) => (binary += String.fromCharCode(byte)),
    );
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  } catch {
    return null;
  }
}

export type PushStatus =
  | "unsupported" // браузер не поддерживает Web Push
  | "not-root" // мы на поддомене магазина — push тут не подписываем
  | "denied" // пользователь запретил уведомления в настройках браузера
  | "prompt" // нужно разрешение — показываем кнопку «Включить»
  | "subscribing"
  | "subscribed"
  | "error";

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Отписка от push на ТЕКУЩЕМ устройстве при выходе из системы.
 *
 * Один browser + OS = один user_agent, но у устройства МОЖЕТ быть несколько
 * подписок — по одной на каждый origin (na3d.ru + все поддомены магазинов),
 * потому что SW регистрируется per-origin. С фронта дотянуться до SW других
 * origin'ов нельзя, поэтому чистим на сервере по (user_id, user_agent) —
 * удаляются все подписки этого устройства, не только текущего origin.
 *
 * НЕ ставит push_disabled=1 — юзер вышел с устройства, а не «отключил push
 * навсегда». При следующем входе подписки создадутся заново.
 */
export async function disablePush(): Promise<void> {
  if (!isPushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();

    // 1. Сервер: удаляем ВСЕ подписки этого устройства (по user_agent).
    // Передаём device:true — сервер берёт UA из заголовка запроса.
    await pushApi.unsubscribe({ device: true }).catch(() => undefined);

    // 2. Локально: гасим текущий SW. Подписки на других origin'ах
    //    останутся зарегистрированы, но push не придёт — их записей на
    //    сервере больше нет. При следующем входе endpoint перепривяжется.
    if (subscription) {
      await subscription.unsubscribe().catch(() => undefined);
    }
  } catch (err) {
    console.warn("[Push] Не удалось отписаться:", err);
  }
}

export interface UsePushSubscriptionResult {
  /** Локальный статус этого устройства (SW + permission). */
  status: PushStatus;
  /** true — пользователь отключил push глобально (users.push_disabled=1). */
  globallyDisabled: boolean;
  /** Сколько УСТРОЙСТВ пользователя подписано (по уникальным user_agent). */
  deviceCount: number;
  /** false — сервер без VAPID-ключей, push не работает вообще. */
  serverEnabled: boolean;
  /** Явно включить push (глобально) — запросит разрешение браузера. */
  enable: () => Promise<void>;
  /** Явно отключить push (глобально, на всех устройствах). */
  disable: () => Promise<void>;
}

export function usePushSubscription(): UsePushSubscriptionResult {
  const [status, setStatus] = useState<PushStatus>("prompt");
  const [globallyDisabled, setGloballyDisabled] = useState(false);
  const [deviceCount, setDeviceCount] = useState(0);
  const [serverEnabled, setServerEnabled] = useState(true);
  const started = useRef(false);

  // Серверное состояние: глобальный флаг + число устройств + сам факт,
  // что VAPID настроен на бэкенде.
  const loadServerState = useCallback(async () => {
    try {
      const data = await pushApi.status();
      setGloballyDisabled(Boolean(data.globallyDisabled));
      setDeviceCount(data.count || 0);
      setServerEnabled(data.enabled !== false);
    } catch {
      // Счётчики некритичны — не показываем ошибку из-за них.
    }
  }, []);

  const register = useCallback(
    async (requestPermission: boolean): Promise<PushStatus> => {
      if (!isPushSupported()) return "unsupported";

      // На поддомене магазина push НЕ подписываем. Единственная подписка
      // живёт на корневом домене (na3d.ru) — see isRootDomain above.
      if (!isRootDomain()) return "not-root";

      if (Notification.permission === "denied") return "denied";
      if (!requestPermission && isPushOptedOut()) return "prompt";

      try {
        // Service Worker
        const registration = await navigator.serviceWorker.register("/sw.js");
        await navigator.serviceWorker.ready;

        const { publicKey } = await pushApi.publicKey();
        let subscription = await registration.pushManager.getSubscription();

        const currentKey = keyToBase64Url(
          subscription?.options?.applicationServerKey as
            | ArrayBuffer
            | null
            | undefined,
        );
        if (subscription && currentKey !== publicKey) {
          await subscription.unsubscribe().catch(() => undefined);
          subscription = null;
        }

        if (!subscription) {
          if (Notification.permission !== "granted") {
            if (!requestPermission) return "prompt";
            const permission = await Notification.requestPermission();
            if (permission !== "granted") {
              return permission === "denied" ? "denied" : "prompt";
            }
          }
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
        }

        await pushApi.subscribe(
          subscription.toJSON() as unknown as PushSubscriptionJSON,
        );
        return "subscribed";
      } catch (err) {
        console.warn("[Push] Не удалось подписаться:", err);
        return "error";
      }
    },
    [],
  );

  // Первый прогон: параллельно автоподписка на этом устройстве и загрузка
  // серверного состояния.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    register(false).then(setStatus);
    loadServerState();
  }, [register, loadServerState]);

  /** Включить push глобально. Тут же браузер спросит разрешение. */
  const enable = useCallback(async () => {
    setPushOptedOut(false);
    setStatus("subscribing");

    // 1. Снять серверный флаг — иначе subscribe() отклонит новую подписку.
    try {
      await pushApi.enable();
    } catch (err) {
      console.warn("[Push] enable: не удалось снять push_disabled:", err);
    }

    // 2. Локально подписать текущее устройство.
    const next = await register(true);
    setStatus(next);

    // 3. Обновить счётчики (deviceCount изменится, globallyDisabled → false).
    await loadServerState();
  }, [register, loadServerState]);

  /**
   * Отключить push глобально: сервер удалит все подписки всех устройств
   * и поставит users.push_disabled=1. Локально гасим SW текущего origin.
   */
  const disable = useCallback(async () => {
    setPushOptedOut(true);
    try {
      await pushApi.unsubscribe({ all: true });
      await disablePush();
    } catch (err) {
      console.warn("[Push] disable: сервер не ответил, чищу локально:", err);
      await disablePush();
    }
    setStatus(Notification.permission === "denied" ? "denied" : "prompt");
    await loadServerState();
  }, [loadServerState]);

  return {
    status,
    globallyDisabled,
    deviceCount,
    serverEnabled,
    enable,
    disable,
  };
}
