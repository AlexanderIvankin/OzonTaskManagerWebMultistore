import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

// === Роли аккаунта и их отображение ===
// Единый источник подписей ролей (используется также в Select и т.п.)
export const ROLE_LABELS: Record<string, string> = {
  // Гость — зарегистрировался, но не подтвердил email (удаляется
  // планировщиком через GUEST_TTL_HOURS). Показывается только во вкладке
  // «Пользователи», чтобы админ видел попытки регистрации.
  guest: "⏳ Гость",
  user: "👤 Пользователь",
  employee: "👷 Сотрудник",
  moderator: "🕵️ Модератор",
  admin: "🧑‍💻 Администратор",
  god: "👻 Создатель",
};

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

// Настройки значка для каждой роли:
// variant + дополнительные классы (у Создателя — фирменный «хэллоуинский»
// стиль: фиолетовый фон и оранжевый текст из --halloween-text)
const ROLE_BADGE_STYLES: Record<
  string,
  { variant: BadgeVariant; className?: string }
> = {
  admin: { variant: "default" },
  moderator: { variant: "secondary" },
  employee: { variant: "outline" },
  user: { variant: "destructive" },
  guest: { variant: "destructive" },
  god: {
    variant: "default",
    className:
      "bg-purple-900 text-halloween-text border-purple-900 hover:bg-purple-700",
  },
};

interface RoleBadgeProps {
  /** Роль аккаунта (см. backend: guest/user/employee/moderator/admin/god) */
  role: string;
  /** Дополнительные классы поверх стиля роли (например, font-bold) */
  className?: string;
}

/**
 * Значок роли аккаунта — единая точка отображения ролей в интерфейсе
 * (профиль, список пользователей, заработки и т.д.).
 * Подписи берутся из ROLE_LABELS, стиль — из ROLE_BADGE_STYLES.
 */
export function RoleBadge({ role, className }: RoleBadgeProps) {
  const style = ROLE_BADGE_STYLES[role] ?? {
    variant: "outline" as BadgeVariant,
  };
  return (
    <Badge variant={style.variant} className={cn(style.className, className)}>
      {ROLE_LABELS[role] ?? role}
    </Badge>
  );
}
