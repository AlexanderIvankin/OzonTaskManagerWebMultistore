const AuthService = require('../services/AuthService');
const User = require('../models/User');
const UserStore = require('../models/UserStore');
const config = require('../config');
// Роли персонала живут в отдельном модуле без зависимостей — иначе socket.js
// (который берёт отсюда STAFF_ROLES) тянул бы AuthService и замыкал цикл
// require: NotificationService -> socket -> middlewares/auth -> AuthService ->
// NotificationService (AuthService получал пустой exports NotificationService).
const { STAFF_ROLES } = require('../config/staffRoles');

async function authenticate(req, res, next) {
  let token = null;
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  // Fallback: токен в query — ТОЛЬКО для GET.
  // Нужен для <img src>, <a download>, <video src>: эти запросы инициирует
  // браузер, и Authorization-заголовок он не прикладывает.
  // Для записи (POST/PUT/DELETE) query-токен не принимаем — безопасность.
  if (!token && req.method === 'GET' && req.query.token) {
    token = String(req.query.token);
  }

  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const decoded = AuthService.verifyAccessToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid token' });

  const user = await User.getById(decoded.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  // Роль в ТЕКУЩЕМ магазине — из user_stores (глобальная users.role тут
  // только 'god' | 'user' | 'guest'). Именно per-store роль определяет
  // права: сотрудник магазина 1 может быть обычным пользователем магазина 2.
  //
  // storeRecord объявлен СНАРУЖИ if — он нужен ниже для формирования
  // вложенного блока req.user.store (в т.ч. когда записи нет → null).

  // Per-store поля. storeRecord объявлен снаружи — нужен для req.user.store.
  let storeRecord = null;
  let storeRole = null;
  let isFired = 0;
  let earningsFactor = 1.0;
  let wasEmployee = 0;

  if (req.storeId) {
    storeRecord = await UserStore.get(user.id, req.storeId);
    if (storeRecord) {
      storeRole = storeRecord.role;
      isFired = storeRecord.is_fired ? 1 : 0;
      earningsFactor = storeRecord.earnings_factor ?? 1.0;
      wasEmployee = storeRecord.was_employee ? 1 : 0;
    }
  }

  // Эффективная роль для authorize/requireEmployee:
  //   • 'god'   — глобальная (Создатель один на всю систему, его профиль
  //               защищён и в любом магазине он остаётся god);
  //   • 'guest' — глобальная (email не подтверждён, до ввода кода из письма);
  //   • иначе   — из user_stores; нет записи или уволен → 'user'.
  let effectiveRole;
  if (user.role === 'god') {
    effectiveRole = 'god';
  } else if (user.role === 'guest') {
    effectiveRole = 'guest';
  } else if (storeRole && !isFired) {
    effectiveRole = storeRole;
  } else {
    effectiveRole = 'user';
  }

  // Отдаём контроллерам «плоский» объект: глобальные поля users + per-store
  // (role/is_fired/earnings_factor/was_employee) + store_id.
  req.user = {
    ...user,
    role: effectiveRole,
    is_fired: isFired,
    earnings_factor: earningsFactor,
    was_employee: wasEmployee,
    store_id: req.storeId || null,
    // Имя текущего контекста для сайдбара:
    //   • на поддомене магазина — STORE_NAME из .env.storeN
    //     (fallback «Магазин N»), поле store_name;
    //   • на корневом домене — ROOT_NAME из .env (fallback 'Global'),
    //     поле root_name.
    // Оба взаимоисключающие: в одном контексте заполнено только одно.
    store_name: req.store?.name || null,
    root_name: req.storeId ? null : config.rootName,
    store: req.store
      ? {
        // role/is_fired/earnings_factor/was_employee — «моя роль в магазине».
        // Для god без membership → role='god', is_fired=false и т.п.
        role: storeRecord?.role ?? effectiveRole,
        is_fired: !!storeRecord?.is_fired,
        earnings_factor: storeRecord?.earnings_factor ?? 1.0,
        was_employee: !!storeRecord?.was_employee,
        // Фичи магазина — НЕ зависят от membership. Берём из конфига
        // (req.store.features), а не из user_stores.
        features: {
          disableModels: !!req.store.features?.disableModels,
          cleanPromotions: !!req.store.features?.cleanPromotions,
        },
      }
      : null,
  };
  next();
}

// Роли персонала (STAFF_ROLES) импортированы выше из src/config/staffRoles.js —
// единый источник истины; здесь только реэкспорт для роутов
// (routes/admin.js, routes/notifications.js) без изменения их импортов.

function requireEmployee(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  // 'user' и 'guest' не имеют доступа к сотрудническим эндпоинтам.
  // 'guest' — email не подтверждён (обычно и до сюда не доходит, но
  // проверка защищает от гонок после удаления user_stores).
  if (req.user.role === 'user' || req.user.role === 'guest') {
    return res.status(403).json({ error: 'Access denied. Employee role required.' });
  }
  next();
}

/**
 * «Есть доступ к сотрудническим фичам хотя бы в одном магазине».
 *
 * Отличие от requireEmployee: не смотрит на per-store роль в ТЕКУЩЕМ
 * контексте (на root-домене у сотрудника req.user.role = 'user' — эффективная
 * роль без магазина). Проверяет наличие АКТИВНОЙ записи в user_stores
 * в ЛЮБОМ магазине.
 *
 * Используется для ГЛОБАЛЬНЫХ сотруднических фич («Мои материалы»),
 * которые доступны и с root-домена.
 */
async function requireStoreAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  // god — всегда (даже без записи в user_stores).
  if (req.user.role === 'god') return next();

  // guest (email не подтверждён) — никогда.
  if (req.user.role === 'guest') {
    return res.status(403).json({ error: 'Access denied. Employee role required.' });
  }

  // employee/moderator/admin — глобальная роль 'user', но доступ есть,
  // если есть активная запись в user_stores ХОТЯ БЫ в одном магазине.
  // Один лёгкий индексированный запрос (idx_user_stores_user).
  try {
    const { getUsersDB } = require('../config/database');
    const row = await getUsersDB().get(
      'SELECT 1 AS x FROM user_stores WHERE user_id = ? AND is_fired = 0 LIMIT 1',
      req.user.id
    );
    if (!row) {
      return res.status(403).json({ error: 'Access denied. Employee role required.' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

module.exports = { authenticate, requireEmployee, requireStoreAccess, authorize, STAFF_ROLES };