// Проверка кулдаунов команд (паритет с ботом, BOTFILES/commands.js):
// перед обработчиком смотрим, не срабатывал ли кулдаун для этого пользователя.
// При срабатывании уходят ДВА сообщения:
//   1) live-тост через WebSocket (NotificationService.notifyUser c persist: false —
//      в историю «Оповещений» запись НЕ создаётся, как у model_upload_rejected);
//   2) ответ 429 { error, retryAfterSec, cooldown: true } — фронт не дублирует
//      локальный тост при признаке cooldown.
// Сам кулдаун ставится в контроллерах ПОСЛЕ успешного выполнения (CooldownService.touch).
const CooldownService = require('../services/CooldownService');
const NotificationService = require('../services/NotificationService');

/**
 * @param {string} kind - 'label' | 'allLabels' | 'toggleOrders' | 'refreshOrders'
 * @param {string} commandLabel - человекочитаемое имя команды для live-тоста
 */
function cooldown(kind, commandLabel) {
  return (req, res, next) => {
    try {
      const result = CooldownService.check(kind, req.user?.id);
      if (!result.blocked) return next();

      // Live-оповещение: WebSocket -> тост в Layout (не блокируем ответ)
      NotificationService.notifyUser(
        req.user.id,
        'command_cooldown',
        {
          command: commandLabel,
          retryAfterSec: result.retryAfterSec,
          message: result.message,
        },
        { persist: false }
      ).catch(() => {});

      return res.status(429).json({
        error: result.message,
        retryAfterSec: result.retryAfterSec,
        cooldown: true,
      });
    } catch (err) {
      // Сбой проверки кулдауна не должен ронять запрос — пропускаем дальше
      console.error('[COOLDOWN] Ошибка проверки кулдауна:', err);
      return next();
    }
  };
}

module.exports = { cooldown };
