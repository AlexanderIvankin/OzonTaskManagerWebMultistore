// ============================================================================
// Звук, вибрация и системные уведомления для оповещений.
//
// Используется ОБОИМИ каналами доставки:
//   • Socket.IO (пользователь онлайн) — Layout.tsx вызывает
//     playNotificationSound() и vibrate() на каждое notification_new; если
//     вкладка в фоне (document.hidden) — дополнительно системное уведомление
//     (сценарий 1);
//   • Web Push (пользователь офлайн) — звук/вибрацию даёт ОС по системному
//     уведомлению из sw.js; открытым вкладкам SW шлёт postMessage, и они
//     проигрывают звук отсюда.
//
// Звук синтезируется через Web Audio API: отдельный аудиофайл не нужен,
// работает офлайн, без лишних запросов.
// ============================================================================

let audioCtx: AudioContext | null = null;
let unlockInitialized = false;

/** Ленивое создание AudioContext (в старых Safari он webkit-prefixed). */
function getAudioContext(): AudioContext | null {
  try {
    if (!audioCtx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

/** Сигнал оповещения на УЖЕ запущенном AudioContext. */
function playTone(ctx: AudioContext): void {
  try {
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    gain.connect(ctx.destination);

    [880, 1174.66].forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(now + index * 0.15);
      oscillator.stop(now + 0.32 + index * 0.15);
    });
  } catch {
    /* звук — не критичная функция */
  }
}

/**
 * «Разбудить» звук. Браузеры разрешают воспроизведение только после первого
 * взаимодействия пользователя со страницей, поэтому контекст создаётся и
 * возобновляется из обработчика жеста (клик/тап/клавиша).
 */
export function unlockNotificationSound(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") void ctx.resume();
}

/**
 * Подписка на первое взаимодействие со страницей — ОДИН РАЗ при старте
 * приложения (main.tsx). Так разблокировка срабатывает и на странице логина,
 * до монтирования Layout, и не теряется при переходах между страницами.
 */
export function initNotificationSoundUnlock(): void {
  if (unlockInitialized || typeof window === "undefined") return;
  unlockInitialized = true;

  const unlock = () => unlockNotificationSound();
  const events: Array<keyof WindowEventMap> = [
    "pointerdown",
    "keydown",
    "touchstart",
    "click",
  ];
  for (const event of events) {
    window.addEventListener(event, unlock, { once: true, passive: true });
  }
}

/**
 * Проиграть сигнал оповещения.
 * Если контекст ещё "suspended" (после перезагрузки страницы браузер
 * «замораживает» его, даже если пользователь уже взаимодействовал с сайтом) —
 * пробуем resume() и играем сразу после него.
 */
export function playNotificationSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  if (ctx.state === "running") {
    playTone(ctx);
    return;
  }

  ctx
    .resume()
    .then(() => {
      if (ctx.state === "running") playTone(ctx);
    })
    .catch(() => {
      /* звук запрещён до первого жеста — прозвучит после него */
    });
}

/** Вибрация (Android). iOS vibrate не поддерживает — вызов просто игнорируется. */
export function vibrate(pattern: number | number[] = [200, 100, 200]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* вибрация — не критичная функция */
  }
}

/**
 * Системное уведомление из страницы (вкладка в фоне, но приложение живо).
 * Показываем через Service Worker — ровно так же, как это делает Web Push,
 * поэтому получаются те же системный звук и вибрация.
 */
export async function showSystemNotification(
  title: string,
  body: string,
  data: { url?: string; tag?: string; type?: string } = {},
): Promise<void> {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    // vibrate не описан в типе NotificationOptions, хотя поддерживается браузерами
    const options = {
      body,
      icon: "/favicon.png",
      badge: "/favicon.png",
      tag: data.tag,
      silent: false,
      vibrate: [200, 100, 200],
      data: { url: data.url || "/notifications", type: data.type },
    } as NotificationOptions & { vibrate: number[] };

    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(title, options);
      return;
    }

    new Notification(title, options);
  } catch {
    /* уведомление — не критичная функция */
  }
}
