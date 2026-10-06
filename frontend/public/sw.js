/* eslint-disable no-restricted-globals */
// ============================================================================
// Service Worker приложения Ozon Manager.
//
// Лежит в frontend/public/sw.js → при сборке Vite копируется в КОРЕНЬ сайта
// (/sw.js), поэтому его scope — '/', то есть всё приложение.
//
// Что делает:
//   1) Web Push (сценарий «пользователь офлайн»): показывает системное
//      уведомление. Звук даёт ОС/браузер (silent: false), вибрацию — опция
//      vibrate (Android; iOS её игнорирует). САМ SW звук проигрывать не может
//      (нет DOM) — для этого он шлёт postMessage открытым вкладкам, а те
//      проигрывают звук через lib/notify.ts.
//   2) Клик по уведомлению: открывает/фокусирует страницу «Оповещения».
//   3) Сверка с фокусом окна: если приложение СЕЙЧАС на экране, дублирующее
//      системное уведомление не показывается — страница уже показала тост и
//      проиграла звук (сценарий «несколько устройств»: push уходит на все
//      подписки, но не всплывает там, где на него смотрят).
//
// Переподписка при pushsubscriptionchange здесь НЕ выполняется: в Service
// Worker нет доступа к applicationServerKey. Это делает приложение при
// следующем запуске (см. hooks/usePushSubscription.ts: сверка ключа и
// повторный pushManager.subscribe).
// ============================================================================

self.addEventListener('install', () => {
  // Новая версия SW активируется сразу, не дожидаясь закрытия вкладок
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/** Разбор полезной нагрузки push: ожидаем JSON от PushService, иначе — текст. */
function parsePushData(event) {
  const fallback = {
    title: 'Ozon Manager',
    body: 'Новое оповещение',
    url: '/notifications',
    tag: 'notification',
    vibrate: [200, 100, 200],
  };
  try {
    if (!event.data) return fallback;
    const raw = event.data.json();
    return {
      ...fallback,
      ...raw,
      title: raw.title || fallback.title,
      body: raw.body || raw.message || fallback.body,
      vibrate: Array.isArray(raw.vibrate) ? raw.vibrate : fallback.vibrate,
    };
  } catch {
    try {
      return { ...fallback, body: event.data.text() || fallback.body };
    } catch {
      return fallback;
    }
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const data = parsePushData(event);

      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      const appFocused = windowClients.some((client) => client.focused);

      // Системное уведомление показываем только если пользователь НЕ смотрит
      // в приложение (вкладка в фоне или приложение закрыто).
      if (!appFocused) {
        await self.registration.showNotification(data.title, {
          body: data.body,
          icon: '/favicon.png',
          badge: '/favicon.png',
          tag: data.tag,
          // renotify требует tag: повторное уведомление перезапишет прежнее
          renotify: true,
          silent: false,
          vibrate: data.vibrate,
          data: { url: data.url, type: data.type, id: data.id },
        });
      }

      // Открытым вкладкам — свой звук/вибрация и обновление бейджа
      for (const client of windowClients) {
        client.postMessage({ type: 'push-received', ...data });
      }
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target =
    (event.notification.data && event.notification.data.url) || '/notifications';

  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Фокусируем уже открытое приложение (не плодим вкладки)
      for (const client of windowClients) {
        if ('focus' in client) {
          if ('navigate' in client) {
            try {
              const nextUrl = new URL(target, client.url).href;
              if (client.url !== nextUrl) await client.navigate(nextUrl);
            } catch {
              /* навигация не критична — просто фокусируемся */
            }
          }
          return client.focus();
        }
      }

      return self.clients.openWindow(target);
    })()
  );
});
