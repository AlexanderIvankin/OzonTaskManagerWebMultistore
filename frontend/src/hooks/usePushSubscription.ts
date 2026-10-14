// src/hooks/usePushSubscription.ts
import { useCallback, useEffect, useRef, useState } from "react";
import { pushApi, PushSubscriptionJSON } from "../api/user";

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

export function usePushSubscription() {
  const [status, setStatus] = useState<PushStatus>("prompt");
  // Защита от повторного запуска: React.StrictMode монтирует эффект дважды
  const started = useRef(false);

  const register = useCallback(
    async (requestPermission: boolean): Promise<PushStatus> => {
      if (!isPushSupported()) return "unsupported";
      if (Notification.permission === "denied") return "denied";
      // Пользователь сам отключил уведомления на этом устройстве: молчаливая
      // автоподписка (requestPermission: false) не должна возвращать их обратно —
      // иначе кнопка «Отключить» отменяется сама собой после перезагрузки страницы.
      // Повторное включение — только явной кнопкой «Включить».
      if (!requestPermission && isPushOptedOut()) return "prompt";

      try {
        // 1. Service Worker (public/sw.js → /sw.js, scope '/')
        const registration = await navigator.serviceWorker.register("/sw.js");
        await navigator.serviceWorker.ready;

        // 2. Публичный VAPID-ключ сервера (applicationServerKey)
        const { publicKey } = await pushApi.publicKey();

        // 3. Существующая подписка устройства
        let subscription = await registration.pushManager.getSubscription();

        // Ключи сервера сменились — подписка недействительна, оформляем заново
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

        // 4. Подписки нет — создаём (разрешение спрашиваем только по кнопке)
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

        // 5. Отправляем подписку на сервер (upsert по endpoint)
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

  // Автоподписка при входе: попап разрешения НЕ показываем (текущее разрешение
  // уже выдано — просто молча обновляем подписку на сервере).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    register(false).then(setStatus);
  }, [register]);

  /** Включить уведомления кнопкой — здесь браузер спросит разрешение. */
  const enable = useCallback(async () => {
    setPushOptedOut(false);
    setStatus("subscribing");
    try {
      // Снять серверный флаг — иначе subscribe() отвергнет новую подписку.
      await pushApi.enable();
    } catch (err) {
      console.warn(
        "[Push] enable: не удалось снять push_disabled на сервере:",
        err,
      );
    }
    setStatus(await register(true));
  }, [register]);

  /** Отключить уведомления на этом устройстве. */
  const disable = useCallback(async () => {
    setPushOptedOut(true);
    try {
      // 1. Сервер: глобальный opt-out (users.push_disabled=1 + удаление всех
      //    подписок всех origin'ов всех устройств).
      await pushApi.unsubscribe({ all: true });
      // 2. Локально: погасить SW текущего origin (остальные origin'ы погасить
      //    нельзя — у каждого свой SW; но они и не получат push, потому что
      //    на сервере подписок уже нет).
      await disablePush();
    } catch (err) {
      console.warn("[Push] disable: сервер не ответил, чищу локально:", err);
      await disablePush();
    }
    setStatus(Notification.permission === "denied" ? "denied" : "prompt");
  }, []);

  return { status, enable, disable };
}
