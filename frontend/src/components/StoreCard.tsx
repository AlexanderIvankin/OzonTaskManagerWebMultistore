import { StoreInfo, storeUrl } from "../types";
import { buildCrossOriginUrl } from "../lib/urls";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RoleBadge } from "./RoleBadge";

interface StoreCardProps {
  store: StoreInfo;
}

/**
 * Карточка магазина на глобальном профиле.
 * • С ролью и без увольнения — кнопка «Открыть» (hard redirect на поддомен).
 * • Без роли — «Нет доступа».
 * • Уволен — «Уволен».
 */
export const StoreCard = ({ store }: StoreCardProps) => {
  const handleOpen = () => {
    // Hard redirect + перенос токенов в URL-хэше (общий хелпер).
    window.location.href = buildCrossOriginUrl(storeUrl(store, "/profile"));
  };

  return (
    <Card className="flex flex-col">
      <CardHeader className="text-center items-center justify-center pb-2">
        <CardTitle className="text-base">{store.name}</CardTitle>
        <CardDescription className="flex items-center gap-2">
          {store.role ? (
            <RoleBadge role={store.role} />
          ) : (
            <span className="text-xs text-muted-foreground">Нет роли</span>
          )}
          {store.is_fired && (
            <span className="text-xs text-destructive">Уволен</span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col justify-end pt-2">
        {store.has_access ? (
          <Button className="w-full" onClick={handleOpen}>
            Открыть магазин →
          </Button>
        ) : (
          <Button className="w-full" variant="outline" disabled>
            {store.is_fired ? "Уволен" : "Нет доступа"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
};
