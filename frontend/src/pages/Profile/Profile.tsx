import { useSelector, useDispatch } from "react-redux";
import { useState, useEffect } from "react";
import { RootState, AppDispatch } from "../../store";
import { updateUser } from "../../store/authSlice";
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
import { RoleBadge } from "@/components/RoleBadge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";

export const Profile = () => {
  const user = useSelector((state: RootState) => state.auth.user);
  const dispatch = useDispatch<AppDispatch>();
  const [takingOrders, setTakingOrders] = useState(
    user?.taking_orders || false,
  );
  const [activeEarnings, setActiveEarnings] = useState<{
    baseEarnings: number;
    adjustments: number;
    total: number;
  } | null>(null);
  const [monthlyEarnings, setMonthlyEarnings] = useState<{
    total: number;
    count: number;
  } | null>(null);
  const [loadingEarnings, setLoadingEarnings] = useState(false);
  const [loadingToggle, setLoadingToggle] = useState(false);
  // Редактирование отображаемого имени (display_name) — видит и меняет сам пользователь
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  // Web Push: включение/отключение уведомлений на этом устройстве.
  // Разрешение браузера запрашивается ТОЛЬКО по кнопке (не при загрузке) —
  // отклонённый автопопап вернуть уже нельзя.
  const {
    status: pushStatus,
    enable: enablePush,
    disable: disablePush,
  } = usePushSubscription();

  const handleDisablePush = async () => {
    await disablePush();
    toast.success("Уведомления отключены на этом устройстве");
  };

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

  const loadActiveEarnings = async () => {
    try {
      const data = await userApi.getActiveEarnings();
      setActiveEarnings(data);
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить активный заработок");
    }
  };

  const loadMonthlyEarnings = async () => {
    try {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const data = await userApi.getMonthlyEarnings(month);
      setMonthlyEarnings({ total: data.total, count: data.count });
    } catch (err: any) {
      toast.error(err.message || "Не удалось загрузить заработок за месяц");
    }
  };

  const refreshEarnings = async () => {
    setLoadingEarnings(true);
    await Promise.allSettled([loadActiveEarnings(), loadMonthlyEarnings()]);
    setLoadingEarnings(false);
  };

  const handleToggleOrders = async () => {
    if (loadingToggle) return;

    setLoadingToggle(true);
    try {
      const result = await userApi.toggleTakingOrders();
      const nextTakingOrders = Boolean(result.taking_orders);
      setTakingOrders(nextTakingOrders);
      // Синхронизируем состояние в Redux, чтобы оно не терялось после перезагрузки
      if (user) {
        dispatch(updateUser({ ...user, taking_orders: nextTakingOrders }));
      }
      toast.success(
        `Приём заказов ${nextTakingOrders ? "включён" : "выключен"}`,
      );
    } catch (err: any) {
      // Кулдаун (429): live-тост о нём уже пришёл по WebSocket — не дублируем
      if (err?.response?.data?.cooldown) return;
      toast.error(
        err?.response?.data?.error || err.message || "Ошибка переключения",
      );
    } finally {
      setLoadingToggle(false);
    }
  };

  // Загружаем заработок только при загрузке пользователя или смене роли.
  // Ключевая деталь: НЕ зависим от user как объекта (ссылки на него меняются при
  // updateUser/refresh), иначе каждый такой апдейт вызывал бы лишние запросы.
  useEffect(() => {
    if (user && user.role !== "user") {
      refreshEarnings();
    }
  }, [user?.role, user?.id]);

  // Синхронизируем переключатель с серверным значением taking_orders
  // (на первом рендере user ещё null, поэтому useState не может взять его значение)
  useEffect(() => {
    if (user) {
      setTakingOrders(Boolean(user.taking_orders));
    }
  }, [user?.taking_orders]);

  return (
    <div className="container mx-auto py-10 max-w-5xl">
      <Card>
        <CardHeader>
          <div className="flex flex-col items-center justify-center mb-[15px] w-full min-w-0">
            {/* Заголовок = display_name, редактируется самим пользователем прямо здесь */}
            {editingDisplayName ? (
              <div className="flex items-center justify-center gap-2 mb-[5px] w-full max-w-full px-1 flex-wrap">
                <Input
                  className="max-w-xs text-center min-w-0 flex-1"
                  value={displayNameInput}
                  autoFocus
                  placeholder="Как вас показывать"
                  onChange={(e) => setDisplayNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveDisplayName();
                  }}
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
              <div className="flex items-start justify-center gap-1 mb-[5px] w-full max-w-full min-w-0 px-1">
                {/* Спейсер той же ширины, что и кнопка справа */}
                <span className="w-7 shrink-0" aria-hidden="true" />
                <CardTitle
                  className="
          flex-1 min-w-0
          text-lg sm:text-xl md:text-2xl
          text-center
          break-all [overflow-wrap:anywhere] [word-break:break-word]
          leading-tight
        "
                >
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
            <CardDescription>
              <RoleBadge role={user?.role ?? ""} />
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Основная информация */}
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
                Количество принтеров
              </p>
              <p>{user?.capacity}</p>
            </div>
          </div>

          <Separator />

          {/* Для роли user – сообщение о необходимости подтверждения */}
          {user?.role === "user" && (
            <>
              <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4 text-yellow-800">
                <p className="font-medium">
                  ⚠️ Ваш аккаунт ожидает подтверждения
                </p>
                <p className="text-sm">
                  Обратитесь к администратору или модератору для получения прав
                  сотрудника.
                </p>
              </div>

              <Separator />
            </>
          )}

          {/* Для сотрудников, модераторов и админов – переключатель приёма заказов */}
          {user?.role !== "user" && (
            <div className="flex items-center justify-center gap-4 py-2">
              <div className="flex items-center space-x-2">
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
          )}

          <Separator />

          {/* Web Push: оповещения на этом устройстве.
              Пока сайт открыт, события приходят мгновенно по WebSocket;
              когда приложение закрыто — Web Push (звук и вибрацию даёт система). */}
          <div className="flex flex-col items-center gap-2 text-center">
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
                Уведомления запрещены в настройках браузера — разрешите их для
                этого сайта.
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

          {/* Заработок (для сотрудников и выше) */}
          {user?.role !== "user" && (
            <>
              <Separator />
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-center mb-[24px]">
                  💰 Заработок
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-center">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">
                        Активный заработок
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {loadingEarnings ? (
                        <p className="text-sm">Загрузка...</p>
                      ) : activeEarnings ? (
                        <div className="space-y-1">
                          <p className="text-2xl font-bold mb-[20px]">
                            {activeEarnings.total.toFixed(2)} ₽
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Базовый: {activeEarnings.baseEarnings.toFixed(2)} ₽
                            <br />
                            Корректировки:{" "}
                            {activeEarnings.adjustments > 0 ? "+" : ""}
                            {activeEarnings.adjustments.toFixed(2)} ₽
                          </p>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          Нет данных
                        </p>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">
                        Заработок за этот месяц
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {loadingEarnings ? (
                        <p className="text-sm">Загрузка...</p>
                      ) : monthlyEarnings ? (
                        <div className="space-y-1">
                          <p className="text-2xl font-bold mb-[20px]">
                            {monthlyEarnings.total.toFixed(2)} ₽
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Количество заказов: {monthlyEarnings.count}
                          </p>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          Нет данных
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </div>
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={refreshEarnings}
                    disabled={loadingEarnings}
                  >
                    {loadingEarnings
                      ? "Обновление..."
                      : "🔄 Обновить заработок"}
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
