export interface User {
  id: number;
  username: string;
  email: string;
  name: string;
  /** Отображаемое имя для самого пользователя (меняется в Профиле) */
  display_name?: string;
  phone?: string;
  capacity: number;
  earnings_factor: number;
  role: 'guest' | 'user' | 'employee' | 'moderator' | 'admin' | 'god';
  is_fired: boolean;
  taking_orders: boolean;
  /** 0/1 из SQLite; подтверждение email после регистрации по коду */
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