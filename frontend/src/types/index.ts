// Эффективная роль в текущем магазине. Формируется бэкендом:
//   • god    — если users.role='god' (глобально);
//   • guest  — если email не подтверждён;
//   • employee/moderator/admin — если есть запись в user_stores и !is_fired;
//   • user   — во всех остальных случаях (нет записи в user_stores или уволен).
export type EffectiveRole =
  | "guest"
  | "user"
  | "employee"
  | "moderator"
  | "admin"
  | "god";

// Per-store блок. Возвращается только /api/user/profile (в /auth/me
// эти поля «разложены» на верхнем уровне — см. User.earnings_factor).
export interface UserStore {
  role: Exclude<EffectiveRole, "guest" | "user">;
  is_fired: boolean;
  earnings_factor: number;
  was_employee: boolean;
}

export interface User {
  id: number;
  username: string;
  email: string;
  name: string;
  display_name?: string;
  phone?: string;

  /** Сквозное (глобальное) число принтеров — из users.capacity */
  capacity: number;

  /** Эффективная роль в текущем магазине (см. EffectiveRole). */
  role: EffectiveRole;

  /** Уволен ли в ТЕКУЩЕМ магазине (user_stores.is_fired).
   *  SQLite отдаёт 0/1 — используйте Boolean(user.is_fired). */
  is_fired: boolean | number;

  /** Коэффициент заработка в ТЕКУЩЕМ магазине (user_stores.earnings_factor). */
  earnings_factor: number;

  /** Был ли когда-либо сотрудником текущего магазина. */
  was_employee?: boolean | number;

  /** Человеческое имя корневого домена (ROOT_NAME из .env).
   *  Заполняется только на глобальном домене (без магазина). */
  root_name?: string | null;

  /** Человеческое имя магазина (STORE_NAME из .env.storeN).
   *  Заполняется только когда запрос в контексте магазина (поддомен). */
  store_name?: string | null;

  /** ID магазина, определённый бэкендом по Host (для отладки). */
  store_id?: string | null;

  /** Вложенный per-store блок — возвращается только /api/user/profile.
   *  Для /auth/me используйте плоские поля выше. */
  store?: UserStore | null;

  /** Сквозное: принимает ли заказы вообще (users.taking_orders). */
  taking_orders: boolean;

  email_verified?: number;
  tg_user_id?: string;
  created_at: number;
  updated_at: number;

  stats?: {
    total_orders: number;
    total_amount: number;
    canceled_orders: number;
  };
  activeOrders?: Array<{ order_id: string; assigned_at: number }>;
}

/**
 * Запись в списке магазинов пользователя.
 * Возвращается GET /api/user/stores — строится из реестра магазинов
 * (.env.storeN) + user_stores пользователя.
 *
 * role = null   — пользователь к этому магазину не привязан (не сотрудник).
 * is_fired=true — уволен в этом магазине.
 */
export interface StoreInfo {
  store_id: string;
  name: string;
  subdomain: string;
  client_origin: string;
  role: "employee" | "moderator" | "admin" | "god" | null;
  is_fired: boolean | null;
  earnings_factor: number | null;
  was_employee: boolean | null;
  /** Есть ли доступ к сотрудническим фичам: role != null && !is_fired */
  has_access: boolean;
}

/**
 * URL магазина для перехода из глобального профиля.
 *
 * • prod: отдаём client_origin как есть (https://shop1.example.com/profile);
 * • dev:  client_origin может быть localhost — тогда перестраиваем на
 *   <subdomain>.<корневой_домен>:<текущий_порт>. Это делает переходы
 *   рабочими при dev через lvh.me.
 */
export const storeUrl = (store: StoreInfo, path = "/profile"): string => {
  const suffix = path.startsWith("/") ? path : `/${path}`;

  // ВАЖНО: dev определяем по ТЕКУЩЕМУ окну, а НЕ по client_origin магазина.
  // client_origin в .env.storeN указывает на прод-домен (shop1.your-domain.ru),
  // и если бы мы смотрели на него, то из dev редирект улетал бы на прод.
  const { protocol, hostname, port } = window.location;
  const portPart = port ? `:${port}` : "";

  // --- dev: lvh.me / nip.io (любые поддомены) ---
  if (hostname === "lvh.me" || hostname.endsWith(".lvh.me")) {
    return `${protocol}//${store.subdomain}.lvh.me${portPart}${suffix}`;
  }
  if (hostname.endsWith(".nip.io") || hostname === "nip.io") {
    return `${protocol}//${store.subdomain}.nip.io${portPart}${suffix}`;
  }
  // --- dev: localhost / 127.0.0.1 (без поддоменов) ---
  // На localhost магазины не различаются по Host — используется fallback
  // «единственный магазин» (или первый в реестре). Для нескольких магазинов
  // в dev нужен lvh.me / nip.io.
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `${protocol}//${hostname}${portPart}${suffix}`;
  }

  // --- prod: берём client_origin магазина как есть ---
  try {
    const url = new URL(store.client_origin);
    return `${url.protocol}//${url.host}${suffix}`;
  } catch {
    return store.client_origin + suffix;
  }
};

// === Роли персонала — единый источник истины ===
// Совпадает с backend/src/config/staffRoles.js
export const STAFF_ROLES = ["admin", "moderator", "god"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const isStaffRole = (role?: string | null): role is StaffRole =>
  !!role && (STAFF_ROLES as readonly string[]).includes(role);

export const isGodRole = (role?: string | null): boolean => role === "god";

/**
 * Эффективная роль пользователя: сначала пробуем вложенный store?.role
 * (из /api/user/profile), иначе плоский user.role (из /auth/me и /auth/login).
 * Иначе — 'user'.
 */
export const effectiveRole = (user?: User | null): EffectiveRole => {
  if (!user) return "user";
  return (user.store?.role ?? user.role ?? "user") as EffectiveRole;
};

/**
 * Уволен ли пользователь в текущем магазине. Нормализует 0/1 → boolean.
 */
export const isFired = (user?: User | null): boolean =>
  !!(user && (user.store?.is_fired ?? user.is_fired));
