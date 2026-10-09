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
    toast.success("Уведомления отключены на этом устройстве");
  };

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
            <CardDescription className="flex items-center gap-2">
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

            <div className="flex flex-col items-center gap-2 text-center mb-2">
              <p className="font-medium text-balance">
                <span className="text-lg mr-2 inline-block" aria-hidden="true">
                  🔔
                </span>
                Уведомления на устройстве
              </p>
              <p className="text-sm text-muted-foreground max-w-md">
                Пока сайт открыт, оповещения приходят мгновенно. Включите
                уведомления, чтобы получать их со звуком и вибрацией, когда
                приложение закрыто.
              </p>

              {pushStatus === "unsupported" && (
                <p className="text-sm text-muted-foreground">
                  Браузер не поддерживает push-уведомления.
                </p>
              )}
              {pushStatus === "denied" && (
                <p className="text-sm text-destructive">
                  Уведомления запрещены в настройках браузера.
                </p>
              )}
              {pushStatus === "subscribed" && (
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <span className="text-sm text-green-600">
                    ✅ Уведомления включены на этом устройстве
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleDisablePush()}
                  >
                    Отключить
                  </Button>
                </div>
              )}
              {(pushStatus === "prompt" ||
                pushStatus === "error" ||
                pushStatus === "subscribing") && (
                <>
                  <Button
                    size="sm"
                    onClick={() => void enablePush()}
                    disabled={pushStatus === "subscribing"}
                  >
                    {pushStatus === "subscribing"
                      ? "Подключаем..."
                      : "🔔 Включить уведомления"}
                  </Button>
                  {pushStatus === "error" && (
                    <p className="text-sm text-destructive">
                      Не удалось подписаться — попробуйте ещё раз.
                    </p>
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
