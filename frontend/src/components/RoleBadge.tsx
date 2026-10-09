import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

// === Роли аккаунта и их отображение ===
// MULTISTORE: роль в этом словаре — ЭФФЕКТИВНАЯ (в текущем магазине).
// Backend отдаёт её в user.role (см. src/types/index.ts → effectiveRole).
//
//   • guest     — зарегистрировался, но не подтвердил email;
//   • user      — подтверждён, но не сотрудник этого магазина;
//   • employee  — сотрудник магазина;
//   • moderator — модератор магазина (полный доступ, live-тосты);
//   • admin     — админ магазина (полный доступ);
//   • god       — Создатель (глобально, единственный).
export const ROLE_LABELS: Record<string, string> = {
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
  /** Эффективная роль (см. src/types/index.ts → EffectiveRole). */
  role: string;
  /** Дополнительные классы поверх стиля роли (например, font-bold) */
  className?: string;
}

/**
 * Значок роли — единая точка отображения ролей в интерфейсе
 * (профиль, список пользователей, заработки и т.д.).
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
