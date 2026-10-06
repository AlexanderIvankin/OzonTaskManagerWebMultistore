// Реэкспорт схемы backend — чтобы правила DDL были в одном месте.
// При изменении backend/src/config/schema.js автоматически подхватится и здесь.
module.exports = require('../../backend/src/config/schema');