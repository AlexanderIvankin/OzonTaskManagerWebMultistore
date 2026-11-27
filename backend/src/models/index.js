const User = require('./User');
const UserStore = require('./UserStore');
const EmailVerification = require('./EmailVerification');
const PasswordReset = require('./PasswordReset');
const Notification = require('./Notification');

const UserStats = require('./UserStats');
const Assignment = require('./Assignment');
const Earnings = require('./Earnings');
const Warehouse = require('./Warehouse');
const UserMaterial = require('./UserMaterial');

const StoredReturn = require('./StoredReturn');

const ProductStat = require('./ProductStat');
const OfferModel = require('./OfferModel');

const ClientBlacklist = require('./ClientBlacklist');

// Чат поддержки (chat.db)
const ChatThread = require('./ChatThread');
const ChatMessage = require('./ChatMessage');
const ChatAttachment = require('./ChatAttachment');



module.exports = {
  User,
  UserStore,
  EmailVerification,
  PasswordReset,
  Notification,

  UserStats,
  Assignment,
  Earnings,
  Warehouse,
  UserMaterial,

  StoredReturn,

  ProductStat,
  OfferModel,

  ClientBlacklist,

  ChatThread,
  ChatMessage,
  ChatAttachment,
};