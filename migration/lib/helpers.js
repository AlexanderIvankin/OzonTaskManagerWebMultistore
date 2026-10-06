function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeTgId(id) {
  return String(id || '').trim();
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

module.exports = { normalizeEmail, normalizeTgId, normalizePhone, timestamp };