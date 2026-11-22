const finishingOrders = new Map();      // orderId -> { startedAt, userId }
const pendingFinishConfirmations = new Map(); // orderId -> { originalChatId?, originalMessageId?, startedAt }
const pendingForms = new Map();         // key: userId_orderId -> { orderId, offers, allCompleted }
const processingOrders = new Set();     // orderId -> заказ сейчас обрабатывается

// Кэш фотографий товаров (in-memory): offer_id -> { sku, images: string[], updatedAt }
// Чтобы для каждого offer_id фото грузились с Ozon только один раз. Фото живут,
// пока заказ «жив» (awaiting_packaging / awaiting_deliver) и удаляются, когда
// статус заказа становится любым другим (см. OrderService.syncOrderStatuses).
const productImagesCache = new Map();

// Кэш состояния заказов (in-memory): orderId -> { userId, status, details,
// assignedAt, completedAt, updatedAt }.
// Заполняется при назначении заказа (детали уже загружены), при завершении
// (синхронизация статуса с Ozon после подтверждения сборки) и лениво при
// запросе списков. Живёт до момента, когда статус заказа перестаёт быть
// awaiting_packaging / awaiting_deliver — тогда снимок удаляется вместе с
// фотографиями (OrderService.syncOrderStatuses).
const orderStateCache = new Map();

// Какие этикетки сотрудник уже скачал.
// Ключ: `${storeId}:${userId}:${orderId}` -> timestamp первого скачивания.
// Нужно, чтобы карточки «Активные» (OrderCard) и «Завершённые»
// (CompletedOrderCard) показывали одинаковый статус «скачано» независимо
// от того, какая страница открыта. Живёт в памяти; при рестарте процесса
// теряется — для полной устойчивости продублировать в
// assignments.label_downloaded_at (см. комментарий в OrderService.markLabelDownloaded).
const downloadedLabels = new Map();

module.exports = {
  finishingOrders,
  pendingFinishConfirmations,
  pendingForms,
  processingOrders,
  productImagesCache,
  orderStateCache,
  downloadedLabels,
};