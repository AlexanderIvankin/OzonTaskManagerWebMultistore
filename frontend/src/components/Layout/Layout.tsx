import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useSelector, useDispatch } from "react-redux";
import { RootState } from "../../store";
import { logout } from "../../store/authSlice";
import {
  getMyStoresUrl,
  getRootOrigin,
  buildCrossOriginUrl,
} from "../../lib/urls";
import { AppDispatch } from "../../store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Toaster, toast } from "sonner";
import { notificationsApi } from "../../api/notifications";
import { getStoredTheme, toggleTheme, Theme } from "../../lib/theme";
import {
  disconnectSocket,
  onNotificationNew,
  onNotificationsChanged,
  onSocketConnect,
} from "../../lib/socket";
import {
  disablePush,
  usePushSubscription,
} from "../../hooks/usePushSubscription";
import {
  playNotificationSound,
  showSystemNotification,
  vibrate,
} from "../../lib/notify";

export const Layout = () => {
  const user = useSelector((state: RootState) => state.auth.user);
  const dispatch = useDispatch<AppDispatch>();

  // Глобальный контекст — корневой домен без магазина (store_id null или
  // undefined, если у пользователя старая сессия без поля).
  const isGlobalContext = !user?.store_id;

  // Непрочитанные личные оповещения для бейджа в сайдбаре
  const [unreadCount, setUnreadCount] = useState(0);

  // Тема: значение уже применено к <html> (inline-скрипт в index.html)
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme() ?? "light");

  const handleToggleTheme = () => {
    setTheme(toggleTheme(theme));
  };

  // Общие классы пунктов сайдбара: активная вкладка подсвечивается,
  // чтобы было видно, где находишься (end — точное совпадение пути,
  // нужно для /admin, иначе он «активен» на всех разделах админки).
  const navClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center justify-center md:justify-start px-2 md:px-3 py-2 rounded-md transition-colors ${
      isActive ? "bg-primary/10 font-medium text-primary" : "hover:bg-accent"
    }`;

  // Web Push: подписка этого устройства на оповещения (офлайн-доставка).
  // Попап разрешения здесь НЕ показывается — включение вынесено в «Профиль»,
  // иначе пользователи отклоняют запрос на старте и теряют возможность
  // включить уведомления навсегда.
  usePushSubscription();

  // Непрочитанные личные оповещения для бейджа в сайдбаре. Вынесено в
  // useCallback: перезагружается по сокету и при переподключении (офлайн -> онлайн).
  const loadUnread = useCallback(async () => {
    try {
      const data = await notificationsApi.unreadCount("mine");
      setUnreadCount(data.count);
    } catch {
      // счётчик некритичен
    }
  }, []);

  // Разблокировка звука и системных уведомлений вынесена в main.tsx
  // (initNotificationSoundUnlock) — она должна работать ещё на странице логина,
  // до монтирования Layout, иначе первый жест пользователя не засчитывается.

  useEffect(() => {
    loadUnread();

    // Живое обновление бейджа: новое оповещение или изменение (прочитано/удалено)
    const offNew = onNotificationNew((n) => {
      // Live-тост о новом оповещении ГЛОБАЛЬНО (на любой странице,
      // не только во вкладке «Оповещения»). События журнала персонала
      // сервер шлёт только модераторам, но дополнительно проверяем роль.
      const isStaff = ["moderator", "admin", "god"].includes(user?.role || "");
      if (n.audience === "staff" && !isStaff) return;
      toast(n.title, { description: n.message || undefined });

      // Звук и вибрация: событие дошло по сокету, но вкладка может быть в фоне
      // (сценарий 1) — пользователь всё равно должен «услышать» оповещение.
      // В фоне дополнительно показываем системное уведомление: его видно вне
      // браузера, и оно даёт системный звук (то же, что и Web Push).
      playNotificationSound();
      vibrate();
      if (document.hidden) {
        void showSystemNotification(n.title, n.message || "", {
          url: "/notifications",
          tag: n.id != null ? `notification-${n.id}` : `notification-${n.type}`,
          type: n.type,
        });
      }

      loadUnread();
    });
    const offChanged = onNotificationsChanged(loadUnread);
    // Сценарий 2: пользователь вернулся после офлайна — сокет переподключился
    // (или это первый коннект). Подтягиваем непрочитанные, накопившиеся, пока
    // приложение было закрыто: их мог доставить Web Push в системный центр.
    const offConnect = onSocketConnect(loadUnread);

    return () => {
      offNew();
      offChanged();
      offConnect();
    };
  }, [user?.role, loadUnread]);

  // Push, доставленный пока приложение открыто (вкладка в фоне): sw.js шлёт
  // postMessage — проигрываем свой звук/вибрацию и обновляем бейдж.
  // (Сам Service Worker звук воспроизводить не может: у него нет DOM.)
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | undefined;
      if (data?.type !== "push-received") return;
      playNotificationSound();
      vibrate();
      loadUnread();
    };

    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, [loadUnread]);

  const handleLogout = async () => {
    await disablePush();
    disconnectSocket();
    await dispatch(logout());
    // Hard-redirect на login КОРНЕВОГО домена. localStorage привязан к origin:
    // при выходе с магазинного поддомена токены на корне остаются, поэтому
    // флаг logout=1 — Login.tsx очистит их при монтировании.
    window.location.href = `${getRootOrigin()}/login?logout=1`;
  };

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Sidebar: на мобилке — узкая колонка со значками, с md — полный сайдбар */}
      <aside className="w-14 md:w-64 shrink-0 border-r bg-card p-2 md:p-4 flex flex-col">
        <div className="mb-6 md:mb-10 flex flex-col items-center md:items-stretch text-center">
          {/* На мобилке логотип = значок; подсказка показывает, где мы */}
          <span
            className="md:hidden size-9 grid place-items-center rounded-lg bg-primary/10 text-lg"
            title={
              isGlobalContext
                ? user?.root_name || "Global"
                : user?.store_name || "Магазин"
            }
          >
            {user?.role === "god"
              ? "👻"
              : user?.role === "moderator"
                ? "🕵️"
                : user?.role === "admin"
                  ? "🧑‍💻"
                  : user?.role === "employee"
                    ? "👷"
                    : "👤"}
          </span>

          {/* Бренд — мелким eyebrow */}
          <p className="hidden md:block text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            Ozon Manager
          </p>

          {/* Имя контекста: ROOT_NAME (глобальный домен) или STORE_NAME
              (поддомен магазина). Fallback — технический. */}
          <h1 className="hidden md:block text-xl font-bold leading-tight mb-2">
            {isGlobalContext
              ? user?.root_name || "Global"
              : user?.store_name || "Магазин"}
          </h1>

          <p className="hidden md:block text-sm text-muted-foreground mb-[5px]">
            {user?.display_name}
          </p>
          <p className="hidden md:block text-xs text-muted-foreground">
            Роль:{" "}
            <span
              className={`font-bold ${user?.role === "god" ? "text-halloween-text" : user?.role === "admin" || user?.role === "moderator" ? "text-blue-600" : ""}`}
            >
              {user?.role}
            </span>
          </p>
        </div>
        <nav className="flex-1 space-y-1">
          {/* «Мои магазины» — отдельная вкладка.
              • В глобальном контексте: NavLink на /stores (та же вкладка).
              • В магазинном: cross-origin ссылка на корень (/stores) с
                токеном в URL-хэше. */}
          {isGlobalContext ? (
            <NavLink to="/stores" className={navClass}>
              <span aria-hidden="true" className="inline-block align-middle">
                🏬
              </span>
              <span className="hidden md:inline md:ml-2">Магазины</span>
            </NavLink>
          ) : (
            <a
              href={buildCrossOriginUrl(getMyStoresUrl())}
              className="flex items-center justify-center md:justify-start px-2 md:px-3 py-2 rounded-md transition-colors hover:bg-accent"
            >
              <span aria-hidden="true" className="inline-block align-middle">
                🏬
              </span>
              <span className="hidden md:inline md:ml-2">Магазины</span>
            </a>
          )}

          {/* «Профиль» — всегда. В глобальном контексте: GlobalProfile
              (личные данные + настройки). В магазинном: StoreProfile. */}
          <NavLink to="/profile" className={navClass}>
            <span
              aria-hidden="true"
              className="inline-block align-middle -translate-y-[3px]"
            >
              🪪
            </span>
            <span className="hidden md:inline md:ml-2">Профиль</span>
          </NavLink>

          {/* «Заказы» — только в магазинном контексте */}
          {!isGlobalContext &&
            ["employee", "moderator", "admin", "god"].includes(
              user?.role || "",
            ) && (
              <NavLink to="/orders" className={navClass}>
                <span aria-hidden="true">📦</span>
                <span className="hidden md:inline md:ml-2">Заказы</span>
              </NavLink>
            )}

          {/* «Оповещения» — всегда */}
          <NavLink
            to="/notifications"
            className={({ isActive }) =>
              `relative flex items-center justify-center md:justify-between px-2 md:px-3 py-2 rounded-md transition-colors ${
                isActive
                  ? "bg-primary/10 font-medium text-primary"
                  : "hover:bg-accent"
              }`
            }
          >
            <span className="flex items-center">
              <span aria-hidden="true">🔔</span>
              <span className="hidden md:inline md:ml-2">Оповещения</span>
            </span>
            {unreadCount > 0 && (
              <Badge className="absolute top-0 right-0 h-4 min-w-4 px-1 text-[10px] leading-none md:static md:h-auto md:min-w-0 md:px-2 md:py-0.5 md:text-xs md:ml-2">
                {unreadCount > 99 ? "99+" : unreadCount}
              </Badge>
            )}
          </NavLink>

          {/* Админка — только в магазинном контексте */}
          {!isGlobalContext &&
            ["moderator", "admin", "god"].includes(user?.role || "") && (
              <NavLink to="/admin" end className={navClass}>
                <span aria-hidden="true">⚙️</span>
                <span className="hidden md:inline md:ml-2">Админка</span>
              </NavLink>
            )}
          {!isGlobalContext &&
            ["moderator", "admin", "god"].includes(user?.role || "") && (
              <>
                <NavLink to="/admin/users" className={navClass}>
                  <span
                    aria-hidden="true"
                    className="inline-block align-middle -translate-y-[2px]"
                  >
                    👥
                  </span>
                  <span className="hidden md:inline md:ml-2">Пользователи</span>
                </NavLink>
                <NavLink to="/admin/warehouses" className={navClass}>
                  <span aria-hidden="true">🏭</span>
                  <span className="hidden md:inline md:ml-2">Склады</span>
                </NavLink>
                <NavLink to="/admin/orders" className={navClass}>
                  <span aria-hidden="true">⏳</span>
                  <span className="hidden md:inline md:ml-2">
                    Очередь заказов
                  </span>
                </NavLink>
                <NavLink to="/admin/active-orders" className={navClass}>
                  <span aria-hidden="true">📋</span>
                  <span className="hidden md:inline md:ml-2">
                    Активные заказы
                  </span>
                </NavLink>
                <NavLink to="/admin/completed-orders" className={navClass}>
                  <span aria-hidden="true">📜</span>
                  <span className="hidden md:inline md:ml-2">
                    Завершённые заказы
                  </span>
                </NavLink>
                <NavLink to="/admin/materials" className={navClass}>
                  <span aria-hidden="true">📁</span>
                  <span className="hidden md:inline md:ml-2">Материалы</span>
                </NavLink>
                <NavLink to="/admin/models" className={navClass}>
                  <span aria-hidden="true">🧊</span>
                  <span className="hidden md:inline md:ml-2">Модели</span>
                </NavLink>
                <NavLink to="/admin/export" className={navClass}>
                  <span aria-hidden="true">📤</span>
                  <span className="hidden md:inline md:ml-2">
                    Экспорт данных
                  </span>
                </NavLink>
                <NavLink to="/admin/earnings" className={navClass}>
                  <span aria-hidden="true">🏦</span>
                  <span className="hidden md:inline md:ml-2">Заработок</span>
                </NavLink>
                <NavLink to="/admin/stats" className={navClass}>
                  <span aria-hidden="true">📊</span>
                  <span className="hidden md:inline md:ml-2">Статистика</span>
                </NavLink>
              </>
            )}
        </nav>
        <div className="border-t pt-2 md:pt-4 space-y-2">
          <Button
            variant="outline"
            className="w-full"
            onClick={handleToggleTheme}
            title="Переключить тему"
          >
            {theme === "dark" ? "☀️" : "🌙"}
            <span className="hidden md:inline">
              {theme === "dark" ? "Светлая тема" : "Тёмная тема"}
            </span>
          </Button>
          <Button
            variant="destructive"
            className="w-full"
            onClick={handleLogout}
            title="Выйти"
          >
            ➜]
            <span className="hidden md:inline">Выйти</span>
          </Button>
        </div>
      </aside>

      {/* Main content – здесь рендерятся вложенные маршруты */}
      <main className="flex-1 min-w-0 overflow-auto p-3 md:p-6">
        <Outlet />
      </main>

      {/* Toaster для уведомлений (стиль подстраивается под тему) */}
      <Toaster position="top-right" theme={theme} />
    </div>
  );
};
