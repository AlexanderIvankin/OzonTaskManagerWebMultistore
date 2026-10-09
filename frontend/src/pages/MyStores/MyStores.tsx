import { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { RootState, AppDispatch } from "../../store";
import { fetchStores } from "../../store/authSlice";
import { buildCrossOriginUrl, getMyStoresUrl } from "../../lib/urls";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StoreCard } from "../../components/StoreCard";

/**
 * Страница «Мои магазины» (только на корневом домене).
 *
 * Показывает карточки магазинов, к которым у пользователя есть роль.
 * Клик «Открыть магазин» → hard-redirect на поддомен (с токеном в URL-хэше).
 *
 * Если страницу открыть на магазинном поддомене (по прямой ссылке) —
 * делаем hard-redirect на глобальный домен: страница «магазинов» живёт
 * только на корне.
 */
export const MyStores = () => {
  const user = useSelector((s: RootState) => s.auth.user);
  const stores = useSelector((s: RootState) => s.auth.stores);
  const storesLoading = useSelector((s: RootState) => s.auth.storesLoading);
  const dispatch = useDispatch<AppDispatch>();

  const isGlobalContext = !user?.store_id;

  useEffect(() => {
    if (user && !isGlobalContext) {
      // На магазинном поддомене — редирект на корень (сохраняем токен в хэше)
      window.location.href = buildCrossOriginUrl(getMyStoresUrl());
    }
  }, [user, isGlobalContext]);

  useEffect(() => {
    if (isGlobalContext) dispatch(fetchStores());
  }, [dispatch, isGlobalContext]);

  if (!isGlobalContext) return null;

  return (
    <div className="container mx-auto max-w-5xl py-10 space-y-6">
      <h1 className="text-2xl font-bold text-center">🏬 Магазины</h1>
      <Card>
        <CardHeader className="flex flex-col items-center justify-center text-center">
          <CardTitle className="text-lg">Мои магазины</CardTitle>
          <CardDescription>
            Магазины, в которых у вас есть роль. Нажмите «Открыть», чтобы
            перейти в магазин.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {storesLoading && stores.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">
              Загрузка...
            </p>
          )}
          {!storesLoading && stores.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">
              Пока нет доступных магазинов.
            </p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {stores.map((store) => (
              <StoreCard key={store.store_id} store={store} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
