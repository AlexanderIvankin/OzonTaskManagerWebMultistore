import { useSelector } from "react-redux";
import { RootState } from "../../store";
import { GlobalProfile } from "./GlobalProfile";
import { StoreProfile } from "./StoreProfile";

/**
 * Диспетчер страницы /profile:
 *   • нет магазина в контексте (user.store_id == null) → глобальный профиль;
 *   • есть магазин → per-store профиль (StoreProfile).
 *
 * Контекст определяется бэкендом: на корневом домене (myapp.com) middleware
 * authenticate ставит store_id = null, на поддомене — конкретный ID магазина.
 */
export const Profile = () => {
  const user = useSelector((s: RootState) => s.auth.user);

  // Пока сессия восстанавливается — ничего не рендерим
  if (!user) return null;

  if (user.store_id == null) {
    return <GlobalProfile />;
  }
  return <StoreProfile />;
};
