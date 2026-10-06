const AuthService = require('../services/AuthService');
const User = require('../models/User');
// Роли персонала живут в отдельном модуле без зависимостей — иначе socket.js
// (который берёт отсюда STAFF_ROLES) тянул бы AuthService и замыкал цикл
// require: NotificationService -> socket -> middlewares/auth -> AuthService ->
// NotificationService (AuthService получал пустой exports NotificationService).
const { STAFF_ROLES } = require('../config/staffRoles');

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.slice(7);
  const decoded = AuthService.verifyAccessToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  const user = await User.getById(decoded.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }
  req.user = user;
  next();
}

// Роли персонала (STAFF_ROLES) импортированы выше из src/config/staffRoles.js —
// единый источник истины; здесь только реэкспорт для роутов
// (routes/admin.js, routes/notifications.js) без изменения их импортов.

function requireEmployee(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.role === 'user') {
    return res.status(403).json({ error: 'Access denied. Employee role required.' });
  }
  next();
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

module.exports = { authenticate, requireEmployee, authorize, STAFF_ROLES };