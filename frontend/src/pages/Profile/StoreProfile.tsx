import { useSelector } from "react-redux";
import { useState, useEffect } from "react";
import { RootState } from "../../store";
import { userApi } from "../../api/user";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RoleBadge } from "@/components/RoleBadge";
import { toast } from "sonner";
import { Separator } from "@/components/ui/separator";

/**
 * Профиль пользователя В КОНТЕКСТЕ МАГАЗИНА (поддомен).
 *
 *   • Роль в магазине, заработок.
 *   • display_name — показывается read-only (редактируется только в
 *     GlobalProfile на корневом домене: это глобальное поле users).
 *   • Сквозные настройки (приём заказов, Web Push) — в GlobalProfile.
 *
 * Предупреждения:
 *   • `user.store == null` → нет роли в этом магазине (прямая ссылка);
 *   • `user.role === 'user' && user.store` → уволен или ещё не принят.
 */
export const StoreProfile = () => {
  const user = useSelector((state: RootState) => state.auth.user);

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

  useEffect(() => {
    if (user && user.role !== "user") {
      refreshEarnings();
    }
  }, [user?.role, user?.id]);

  // Нет записи в user_stores ЭТОГО магазина (пользователь по прямой ссылке)
  const noStoreAccess = user && !user.store;
  // Есть запись, но роль в магазине — 'user' (уволен или не подтверждён)
  const awaitingConfirmation = user && user.store && user.role === "user";

  return (
    <div className="container mx-auto py-10 max-w-5xl">
      <Card>
        <CardHeader>
          <div className="flex flex-col items-center justify-center mb-[15px] w-full min-w-0">
            <div className="flex items-start justify-center gap-1 mb-[5px] w-full max-w-full min-w-0 px-1">
              <CardTitle className="flex-1 min-w-0 text-lg sm:text-xl md:text-2xl text-center break-all [overflow-wrap:anywhere] [word-break:break-word] leading-tight">
                {user?.display_name || user?.name || user?.username}
              </CardTitle>
            </div>
            <CardDescription>
              <RoleBadge role={user?.role ?? ""} />
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
                Количество принтеров
              </p>
              <p>{user?.capacity}</p>
            </div>
          </div>

          {/* Нет роли в ЭТОМ магазине */}
          {noStoreAccess && (
            <>
              <Separator />
              <div className="bg-blue-50 border border-blue-200 rounded-md p-4 text-blue-800">
                <p className="font-medium">🏬 Нет роли в этом магазине</p>
                <p className="text-sm">
                  Вернитесь в глобальный профиль, чтобы выбрать другой магазин.
                </p>
              </div>
            </>
          )}

          {/* Роль в магазине есть, но 'user' (уволен или не подтверждён) */}
          {awaitingConfirmation && (
            <>
              <Separator />
              <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4 text-yellow-800">
                <p className="font-medium">
                  ⚠️ Статус работника этого магазина не подтверждён
                </p>
                <p className="text-sm">
                  Обратитесь к Персоналу магазина для подтверждения статуса
                  работника или уточнения роли.
                </p>
              </div>
            </>
          )}

          {/* Заработок (для подтверждённых сотрудников и выше) */}
          {!noStoreAccess && !awaitingConfirmation && (
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
