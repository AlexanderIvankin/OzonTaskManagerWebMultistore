import { useEffect } from "react";

/**
 * Детектит смену accessToken в ДРУГОЙ вкладке того же origin.
 * localStorage общий — если кто-то зашёл другим аккаунтом, мы должны
 * не продолжать работать «как будто ничего не случилось» (сокет и HTTP
 * будут расходиться).
 */
export function useCrossTabAuthGuard(): void {
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "accessToken") return;
      // Тот же токен — ничего не делаем (мог быть просто touch)
      if (e.newValue === e.oldValue) return;

      // Токен сменился (другой аккаунт / logout в другой вкладке).
      // Принудительный reload — restoreSession подхватит новый токен,
      // все компоненты перемонтируются, socket пересоздастся.
      if (e.newValue === null) {
        // logout в другой вкладке
        if (!window.location.pathname.startsWith("/login")) {
          window.location.href = "/login";
        }
      } else {
        // Вход другим аккаунтом — просто перезагружаемся,
        // restoreSession в App.tsx сделает всё остальное
        window.location.reload();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
}
