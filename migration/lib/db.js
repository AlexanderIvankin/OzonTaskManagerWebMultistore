const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');

async function openDb(dbPath, { readonly = false, create = false } = {}) {
  // Для readonly файл обязан существовать.
  // Для write-режима — если create=true, файл будет создан драйвером.
  if (readonly && !fs.existsSync(dbPath)) {
    throw new Error(`Файл БД не найден: ${dbPath}`);
  }
  if (!readonly && !create && !fs.existsSync(dbPath)) {
    throw new Error(
      `Файл БД не найден: ${dbPath}. ` +
      `Передайте { create: true }, если его нужно создать.`
    );
  }

  // Гарантируем, что папка существует (для новых файлов)
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // OPEN_CREATE — ключевой флаг для создания нового файла.
  // Без него sqlite падает с "unable to open database file".
  const mode = readonly
    ? sqlite3.OPEN_READONLY
    : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;

  return open({
    filename: dbPath,
    driver: sqlite3.Database,
    mode,
  });
}

async function backupDb(dbPath, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = path.basename(dbPath, path.extname(dbPath));
  const ext = path.extname(dbPath);
  const backupPath = path.join(backupDir, `${base}.backup-${ts}${ext}`);
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

async function transaction(db, fn) {
  await db.run('BEGIN TRANSACTION');
  try {
    const result = await fn();
    await db.run('COMMIT');
    return result;
  } catch (err) {
    try { await db.run('ROLLBACK'); } catch (_) { }
    throw err;
  }
}

/**
 * Проверка, что в открытой БД есть ожидаемые таблицы.
 * Помогает поймать случайную подмену файла.
 */
async function assertTables(db, tables, dbLabel) {
  const rows = await db.all(
    `SELECT name FROM sqlite_master WHERE type='table'`
  );
  const have = new Set(rows.map(r => r.name));
  const missing = tables.filter(t => !have.has(t));
  if (missing.length) {
    throw new Error(
      `В ${dbLabel} отсутствуют таблицы: ${missing.join(', ')}. ` +
      `Проверьте, что указан правильный файл БД.`
    );
  }
}

module.exports = { openDb, backupDb, transaction, assertTables };