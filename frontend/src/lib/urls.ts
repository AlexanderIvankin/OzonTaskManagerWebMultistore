/**
 * Утилиты для построения URL между корневым доменом и магазинными
 * сабдоменами. Frontend и backend используют соглашение:
 *   • корневой домен (lvh.me / myapp.com) — глобальный профиль;
 *   • поддомен (shop1.lvh.me / shop1.myapp.com) — конкретный магазин.
 *
 * getRootOrigin() возвращает origin БЕЗ поддомена, с сохранением протокола
 * и порта (для dev-порта 5173).
 *
 * ВАЖНО про localStorage: он привязан к origin (protocol+host+port), между
 * поддоменами не шарится. При hard-redirect на другой поддомен передаём
 * токены в URL-хэше — их подхватывает inline-скрипт в index.html и
 * складывает в localStorage нового origin.
 */

export function getRootOrigin(): string {
  const { protocol, hostname, port, origin } = window.location;
  const portPart = port ? `:${port}` : "";

  // localhost и 127.0.0.1 — корень = он же (нет поддоменов)
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return origin;
  }

  const parts = hostname.split(".");
  // myapp.com — уже корень
  if (parts.length <= 2) return origin;

  // shop1.myapp.com → myapp.com; shop1.lvh.me → lvh.me
  const rootHost = parts.slice(-2).join(".");
  return `${protocol}//${rootHost}${portPart}`;
}

/** Ссылка на глобальный профиль (страница выбора магазинов). */
export function getGlobalProfileUrl(): string {
  return `${getRootOrigin()}/profile`;
}

/**
 * Хэш с токенами для передачи через cross-origin редирект.
 * Возвращает строку без ведущего '#' (её подставит вызывающий код).
 * Пустая строка — если токенов нет.
 */
export function buildAuthHash(): string {
  try {
    const accessToken = localStorage.getItem("accessToken");
    const refreshToken = localStorage.getItem("refreshToken");
    if (!accessToken) return "";
    const params = new URLSearchParams();
    params.set("auth", accessToken);
    if (refreshToken) params.set("refresh", refreshToken);
    return params.toString();
  } catch {
    return "";
  }
}

/**
 * Обёртка над URL: добавляет #auth=...&refresh=... если токены есть.
 * Используется для hard-redirect между поддоменами (StoreCard, «Мои магазины»).
 */
export function buildCrossOriginUrl(baseUrl: string): string {
  const hash = buildAuthHash();
  return hash ? `${baseUrl}#${hash}` : baseUrl;
}

/** Ссылка на страницу «Мои магазины» (на корневом домене). */
export function getMyStoresUrl(): string {
  return `${getRootOrigin()}/stores`;
}
