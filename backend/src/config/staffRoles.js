// ============================================================================
// РОЛИ ПЕРСОНАЛА — единый источник истины (без зависимостей!).
//
// Роли персонала с полным доступом к админке:
//   • Модератор = Администратор по правам;
//   • 'god' — Создатель: те же права, но его профиль защищён от
//     редактирования/увольнения (см. adminController).
//
// ВАЖНО: модуль сознательно НЕ требует НИЧЕГО (кроме себя самого), потому что
// его импортируют:
//   • src/socket.js               (комната 'staff' / 'moderators');
//   • src/middlewares/auth.js      (authorize(...STAFF_ROLES));
//   • src/services/NotificationService.js (получатели журнала действий);
//   • src/services/ModelService.js (доступ персонала к моделям).
// Раньше socket.js брал STAFF_ROLES из middlewares/auth.js, а тот тянет весь
// AuthService — получалась циклическая зависимость
// (NotificationService -> socket -> middlewares/auth -> AuthService ->
// NotificationService), из-за которой AuthService получал пустой exports
// NotificationService и падал с "logServerError is not a function".
// Чтобы добавить/убрать роль персонала — править ТОЛЬКО этот файл.
// ============================================================================
const STAFF_ROLES = ['admin', 'moderator', 'god'];

module.exports = { STAFF_ROLES };
