import { Navigate, Outlet } from "react-router-dom";
import { useSelector } from "react-redux";
import { RootState } from "../store";
import { effectiveRole } from "../types";

interface ProtectedRouteProps {
  children?: React.ReactNode;
  /** Роли, которым разрешён доступ. См. EffectiveRole в src/types/index.ts. */
  allowedRoles?: string[];
}

export const ProtectedRoute = ({
  children,
  allowedRoles,
}: ProtectedRouteProps) => {
  const accessToken = useSelector((state: RootState) => state.auth.accessToken);
  const user = useSelector((state: RootState) => state.auth.user);

  if (!accessToken) {
    return <Navigate to="/login" replace />;
  }

  // MULTISTORE: эффективная роль может прийти двумя путями —
  //   • user.role (из /auth/me — middleware собрал её из user_stores);
  //   • user.store.role (из /api/user/profile).
  // effectiveRole() умеет читать оба варианта.
  //
  // Пока user ещё не загружен (restoreSession в процессе) — не блокируем.
  if (allowedRoles && user) {
    const role = effectiveRole(user);
    if (!allowedRoles.includes(role)) {
      return <Navigate to="/profile" replace />;
    }
  }

  return children ? children : <Outlet />;
};