import { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useNavigate } from "react-router-dom";
import { RootState, AppDispatch } from "../../store";
import { updateUser, fetchStores } from "../../store/authSlice";
import { userApi } from "../../api/user";
import { usePushSubscription } from "../../hooks/usePushSubscription";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { RoleBadge } from "@/components/RoleBadge";
import { toast } from "sonner";

/**
 * Глобальный профиль (корневой домен, без магазина).
 *
 *   • Личные данные: display_name (редактируется здесь), логин, email,
 *     телефон, число принтеров.
 *   • Сквозные настройки: приём заказов (users.taking_orders) и Web Push —
 *     действуют во всех магазинах сразу.
 *   • Кнопка «Мои магазины» — переход на страницу dashboard.
 *
 * Per-store данные (роль, заработок) — в StoreProfile на поддомене.
 */
export const GlobalProfile = () => {
  const user = useSelector((s: RootState) => s.auth.user);
  const stores = useSelector((s: RootState) => s.auth.stores);
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();

  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [savingDisplayName, setSavingDisplayName] = useState(false);

  const [takingOrders, setTakingOrders] = useState(
    Boolean(user?.taking_orders),
  );
  const [loadingToggle, setLoadingToggle] = useState(false);

  const {
    status: pushStatus,
    globallyDisabled,
    deviceCount,
    serverEnabled,
    enable: enablePush,
    disable: disablePush,
  } = usePushSubscription();

  // Подтягиваем список магазинов, чтобы показать счётчик «Мои магазины»
  useEffect(() => {
    dispatch(fetchStores());
  }, [dispatch]);

  useEffect(() => {
    setTakingOrders(Boolean(user?.taking_orders));
  }, [user?.taking_orders]);

  const handleSaveDisplayName = async () => {
    const value = displayNameInput.trim();
    if (!value) {
      toast.error("Укажите отображаемое имя");
      return;
    }
    setSavingDisplayName(true);
    try {
      const updated = await userApi.updateDisplayName(value);
      if (user) {
        dispatch(updateUser({ ...user, display_name: updated.display_name }));
      }
      setEditingDisplayName(false);
      toast.success("Отображаемое имя обновлено");
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error || err?.message || "Ошибка сохранения",
      );
    } finally {
      setSavingDisplayName(false);
    }
  };

  const handleToggleOrders = async () => {
    if (loadingToggle) return;
    setLoadingToggle(true);
    try {
      const result = await userApi.toggleTakingOrders();
      const next = Boolean(result.taking_orders);
      setTakingOrders(next);
      if (user) dispatch(updateUser({ ...user, taking_orders: next }));
      toast.success(`Приём заказов ${next ? "включён" : "выключен"}`);
    } catch (err: any) {
      if (err?.response?.data?.cooldown) return;
      toast.error(
        err?.response?.data?.error || err.message || "Ошибка переключения",
      );
    } finally {
      setLoadingToggle(false);
    }
  };

  const handleDisablePush = async () => {
    await disablePush();
    toast.success("Push-уведомления отключены на всех устройствах");
  };

  /** «1 устройство», «2 устройства», «5 устройств» — для подписи под статусом. */
  function pluralDevices(n: number): string {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return `${n} устройство`;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20))
      return `${n} устройства`;
    return `${n} устройств`;
  }

  const isGuest = user?.role === "guest";

  return (
    <div className="container mx-auto py-10 max-w-5xl space-y-6">
      {isGuest && (
        <Card className="border-yellow-300 bg-yellow-50 text-yellow-900">
          <CardContent className="py-4">
            <p className="font-medium">⚠️ Email не подтверждён</p>
            <p className="text-sm">
              Проверьте почту и введите код из письма, чтобы получить роль
              «Пользователь» и доступ к магазинам.
            </p>
          </CardContent>
        </Card>
      )}

      {/* === Личные данные === */}
      <Card>
        <CardHeader>
          <div className="flex flex-col items-center justify-center mb-2 w-full min-w-0">
            {editingDisplayName ? (
              <div className="flex items-center justify-center gap-2 mb-1 w-full max-w-full px-1 flex-wrap">
                <Input
                  className="max-w-xs text-center min-w-0 flex-1"
                  value={displayNameInput}
                  autoFocus
                  placeholder="Как вас показывать"
                  onChange={(e) => setDisplayNameInput(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" && handleSaveDisplayName()
                  }
                />
                <Button
                  size="sm"
                  onClick={handleSaveDisplayName}
                  disabled={savingDisplayName}
                >
                  {savingDisplayName ? "..." : "Сохранить"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditingDisplayName(false)}
                  disabled={savingDisplayName}
                >
                  Отмена
                </Button>
              </div>
            ) : (
              <div className="flex items-start justify-center gap-1 mb-1 w-full max-w-full min-w-0 px-1">
                <span className="w-7 shrink-0" aria-hidden="true" />
                <CardTitle className="flex-1 min-w-0 text-lg sm:text-xl md:text-2xl text-center break-all [overflow-wrap:anywhere] [word-break:break-word] leading-tight">
                  {user?.display_name || user?.name || user?.username}
                </CardTitle>
                <Button
                  className="h-7 w-7 p-0 shrink-0 mt-0.5"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDisplayNameInput(user?.display_name || user?.name || "");
                    setEditingDisplayName(true);
                  }}
                >
                  ✏️
                </Button>
              </div>
            )}
            <CardDescription className="flex flex-col items-center gap-2">
              {user?.role === "god" && <RoleBadge role="god" />}
              <span className="text-xs text-muted-foreground">
                Глобальный профиль
              </span>
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-2 gap-1 text-center break-words">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Логин</p>
              <p>{user?.username}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Email</p>
              <p>{user?.email}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Телефон
              </p>
              <p>{user?.phone || "—"}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Принтеров
              </p>
              <p>{user?.capacity}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* === Сквозные настройки: приём заказов + Web Push === */}
      {!isGuest && (
        <Card>
          <CardHeader className="flex flex-col items-center justify-center text-center">
            <CardTitle className="text-lg">⚙️ Общие настройки</CardTitle>
            <CardDescription>
              Действуют во всех магазинах, где вы работаете.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <Separator />
            <div className="flex flex-wrap items-center justify-center gap-x-4">
              <div className="flex flex-wrap justify-center items-center space-x-2 gap-y-3">
                <Switch
                  checked={takingOrders}
                  onCheckedChange={handleToggleOrders}
                  disabled={loadingToggle}
                  id="taking-orders"
                />
                <Label
                  htmlFor="taking-orders"
                  className={
                    loadingToggle ? "cursor-not-allowed" : "cursor-pointer"
                  }
                >
                  {takingOrders
                    ? "✅ Принимаю заказы"
                    : "❌ Не принимаю заказы"}
                </Label>
              </div>
              {loadingToggle && (
                <span className="text-sm text-muted-foreground">
                  Сохранение...
                </span>
              )}
            </div>

            <Separator />

            {/* === Push — ГЛОБАЛЬНАЯ настройка === */}
            <div className="flex flex-col items-center gap-3 text-center mb-2">
              <p className="font-medium text-balance">
                <span className="text-lg mr-2 inline-block" aria-hidden="true">
                  🔔
                </span>
                Push-уведомления
              </p>
              <p className="text-sm text-muted-foreground max-w-md">
                Настройка действует на всех устройствах, где вы вошли в аккаунт.
                Отключение уберёт push со всех устройств сразу.
              </p>

              {/* Браузер не поддерживает — тупик, ничего не сделать */}
              {pushStatus === "unsupported" && (
                <p className="text-sm text-muted-foreground">
                  Браузер не поддерживает push-уведомления.
                </p>
              )}

              {pushStatus === "not-root" && (
                <p className="text-sm text-muted-foreground">
                  Управление push-уведомлениями доступно в глобальном профиле на
                  главном домене.
                </p>
              )}

              {/* Permission запрещён в этом браузере — per-device, юзер должен
      разобраться в настройках сайта. Даже если глобально включено. */}
              {pushStatus === "denied" && (
                <div className="flex flex-col items-center gap-1 max-w-md">
                  <p className="text-sm text-destructive">
                    Уведомления запрещены в настройках этого браузера.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Разрешите их в настройках сайта — тогда push снова придут на
                    это устройство.
                  </p>
                </div>
              )}

              {/* Остальные случаи: либо глобально включено, либо отключено. */}
              {pushStatus !== "unsupported" && pushStatus !== "denied" && (
                <>
                  {/* Сервер без VAPID — тут ничего не сделать юзеру */}
                  {!serverEnabled && (
                    <p className="text-sm text-destructive">
                      Push-сервер не настроен. Обратитесь к администратору.
                    </p>
                  )}

                  {/* Глобально отключено */}
                  {serverEnabled && globallyDisabled && (
                    <>
                      <span className="text-sm text-muted-foreground text-center sm:text-left">
                        ❌ Push-уведомления отключены
                      </span>
                      <Button
                        size="sm"
                        onClick={() => void enablePush()}
                        disabled={pushStatus === "subscribing"}
                        className="min-w-0 w-full sm:w-auto"
                      >
                        <span className="truncate">
                          {pushStatus === "subscribing"
                            ? "Подключаем..."
                            : "🔔 Включить push"}
                        </span>
                      </Button>
                    </>
                  )}

                  {/* Глобально включено */}
                  {serverEnabled && !globallyDisabled && (
                    <>
                      <div className="flex flex-col items-center gap-1">
                        <span className="text-sm text-green-600">
                          ✅ Push-уведомления включены
                        </span>
                        {deviceCount > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {pluralDevices(deviceCount)}
                          </span>
                        )}
                      </div>

                      <div className="flex w-full flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center">
                        {/* Это устройство ещё не подключено — предложить разрешение */}
                        {pushStatus === "prompt" && (
                          <Button
                            size="sm"
                            onClick={() => void enablePush()}
                            className="min-w-0 w-full sm:w-auto"
                          >
                            <span className="truncate">
                              Подключить это устройство
                            </span>
                          </Button>
                        )}

                        {pushStatus === "subscribing" && (
                          <span className="text-xs text-muted-foreground text-center sm:text-left">
                            Подключаем это устройство...
                          </span>
                        )}

                        {pushStatus === "error" && (
                          <p className="text-sm text-destructive text-center sm:text-left">
                            Не удалось подписать это устройство — попробуйте ещё
                            раз.
                          </p>
                        )}

                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handleDisablePush()}
                          className="min-w-0 w-full sm:w-auto"
                        >
                          <span className="truncate">
                            Отключить на всех устройствах
                          </span>
                        </Button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* === Ссылка на «Мои магазины» === */}
      {!isGuest && (
        <Card>
          <CardHeader className="flex flex-col items-center justify-center text-center">
            <CardTitle className="text-lg">🏬 Мои магазины</CardTitle>
            <CardDescription>
              {stores.length > 0
                ? `У вас доступ к ${stores.length} магазин(ам)`
                : "Пока нет доступных магазинов"}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center text-center">
            <Button onClick={() => navigate("/stores")}>
              Перейти в «Магазины» →
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
