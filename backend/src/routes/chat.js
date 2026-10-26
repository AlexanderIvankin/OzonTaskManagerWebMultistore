// src/routes/chat.js
//
// Чат поддержки — СКВОЗНОЙ (storeResolver.js: isGlobalPath '/chat/*').
// Доступен с любого домена (root и поддомены). Контекст магазина
// (req.storeId) прокидывается в сообщение, если запрос пришёл с поддомена.
//
// Все эндпоинты требуют authenticate. Проверка «staff чата» — внутри
// контроллера (ChatService.resolveChatIdentity), т.к. роль глобальная и
// требует JOIN по user_stores (req.user.role — это роль в ТЕКУЩЕМ магазине,
// её недостаточно).

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middlewares/auth');
const chatController = require('../controllers/chatController');
const ChatStorageService = require('../services/ChatStorageService');

router.use(authenticate);

// Свой тред (создаёт при первом обращении)
router.get('/thread', chatController.getMyThread);

// Инициировать чат с пользователем со стороны staff (создаёт тред + приветствие)
router.post('/threads/for-user/:userId', chatController.getOrCreateThreadForUser);

// История сообщений треда (user — свой, staff — любой)
router.get('/threads/:id/messages', chatController.getMessages);

// Список тредов для staff (пагинация, сортировка по updated_at)
router.get('/threads', chatController.listThreads);

// Отправить сообщение
router.post('/messages', chatController.sendMessage);

// Отметить прочитанным (для staff без threadId — все треды)
router.post('/read', chatController.markRead);

// Счётчики для бейджа
router.get('/unread-count', chatController.unreadCounts);

// Удалить свой тред (приватность)
router.delete('/thread', chatController.deleteThread);

// Удалить своё сообщение
router.delete('/messages/:id', chatController.deleteMessage);

// Вложения
router.post(
  '/attachments',
  (req, res, next) => {
    chatController.uploadMiddleware(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(ChatStorageService.maxBytes / (1024 * 1024));
        return res.status(413).json({
          error: `Файл больше ${mb} МБ`,
          code: 'FILE_TOO_LARGE',
        });
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: 'Некорректная загрузка файла', code: err.code });
      }
      return next(err);
    });
  },
  chatController.uploadAttachment
);
router.get('/attachments/:id', chatController.downloadAttachment);

module.exports = router;