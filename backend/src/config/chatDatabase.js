// src/config/chatDatabase.js
//
// Единая БД чата поддержки. Одна на всё приложение — тред на каждого
// пользователя, видят все модераторы всех магазинов (сквозная поддержка).
//
// ATTACH users.db: нужен для JOIN usersdb.users в выборках тредов у
// модераторов (имя пользователя в списке, роль в момент отправки).
// Без users.db чат не имеет смысла — поэтому ATTACH обязателен, как
// в store-N.db и models.db.
//
// Зачем отдельная БД (а не в users.db):
//   • чат растёт независимо (много текста и файлов);
//   • не раздувает users.db (которую бэкапим часто);
//   • DELETE thread (приватность) не трогает users.db.

const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const config = require('./index');

let dbInstance = null;

async function initChatDB() {
  if (dbInstance) return dbInstance;

  const dbPath = config.chatDbPath;
  const absolutePath = path.isAbsolute(dbPath)
    ? dbPath
    : path.resolve(__dirname, '../..', dbPath);

  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  dbInstance = await open({
    filename: absolutePath,
    driver: sqlite3.Database,
  });

  await dbInstance.exec('PRAGMA foreign_keys = ON');
  await dbInstance.exec('PRAGMA busy_timeout = 5000');
  await dbInstance.exec('PRAGMA journal_mode = WAL');

  // ATTACH users.db как схема 'usersdb' — JOIN usersdb.users ...
  const usersPath = path.isAbsolute(config.usersDbPath)
    ? config.usersDbPath
    : path.resolve(__dirname, '../..', config.usersDbPath);

  if (!fs.existsSync(usersPath)) {
    throw new Error(
      `ATTACH users.db: файл не найден (${usersPath}). ` +
      `Сначала должна быть инициализирована users.db.`
    );
  }
  const attached = await dbInstance.all('PRAGMA database_list');
  if (!attached.some((d) => d.name === 'usersdb')) {
    await dbInstance.run('ATTACH DATABASE ? AS usersdb', usersPath);
  }

  await createChatTables(dbInstance);

  console.log(`✅ Чат-БД инициализирована: ${absolutePath}  [ATTACH usersdb]`);
  return dbInstance;
}

async function createChatTables(db) {
  // --- Треды: один на пользователя ---
  // status: 'open' сейчас; 'closed' оставлено на будущее (модерация/авто-close).
  // last_message_preview / last_message_author: денормализация для списка
  // у модератора (сортировка по updated_at, показ последнего сообщения без
  // джойна с messages — дешевле для пагинации).
  // unread_for_user / unread_for_staff: счётчики для бейджа. Обновляются
  // атомарно при insert сообщения и сбрасываются при read.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message_preview TEXT,
      last_message_author TEXT,
      unread_for_user INTEGER NOT NULL DEFAULT 0,
      unread_for_staff INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open'
    )
  `);
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_chat_threads_updated ON chat_threads(updated_at DESC)'
  );
  await db.exec(
    "CREATE INDEX IF NOT EXISTS idx_chat_threads_staff_unread ON chat_threads(unread_for_staff) WHERE unread_for_staff > 0"
  );

  // Read receipts (v2): id последнего сообщения, прочитанного каждой стороной.
  // NULL = ещё ничего не читал. Используется фронтом для ✓/✓✓.
  const threadCols = await db.all('PRAGMA table_info(chat_threads)');
  if (!threadCols.some((c) => c.name === 'user_last_read_message_id')) {
    await db.exec('ALTER TABLE chat_threads ADD COLUMN user_last_read_message_id INTEGER');
    console.log('✅ chat_threads: + user_last_read_message_id');
  }
  if (!threadCols.some((c) => c.name === 'staff_last_read_message_id')) {
    await db.exec('ALTER TABLE chat_threads ADD COLUMN staff_last_read_message_id INTEGER');
    console.log('✅ chat_threads: + staff_last_read_message_id');
  }

  // Reply на ФРАГМЕНТ сообщения: если колонка заполнена, в цитате показываем
  // именно этот текст, а не полное тело цитируемого.
  const msgCols = await db.all('PRAGMA table_info(chat_messages)');
  if (!msgCols.some((c) => c.name === 'reply_quote_text')) {
    await db.exec('ALTER TABLE chat_messages ADD COLUMN reply_quote_text TEXT');
    console.log('✅ chat_messages: + reply_quote_text');
  }

  // --- Сообщения ---
  // author_role фиксируется на момент отправки ('user' | 'moderator' |
  // 'admin' | 'god'). Позволяет истории показывать роль «тогда», даже если
  // её потом изменили — правильно для аудита.
  // store_id: контекст (1, 2, 3 или NULL — глобальный домен).
  // reply_to_id: цитата (nullable).
  // deleted_at: soft-delete сообщения (пока не используется; задел на
  // будущее, если захотим «удалить своё сообщение» без удаления всей
  // переписки).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL,
      author_role TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      store_id TEXT,
      reply_to_id INTEGER,
      created_at INTEGER NOT NULL,
      edited_at INTEGER,
      deleted_at INTEGER,
      FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
    )
  `);
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at)'
  );

  // --- Вложения (v2: message_id NULLABLE + uploader_id + thread_id) ---
  // Сначала проверим, существует ли таблица и nullable ли message_id.
  // Если она старая (message_id NOT NULL) — пересоздаём через temp-таблицу.
  const attCols = await db.all('PRAGMA table_info(chat_attachments)');
  const attExists = attCols.length > 0;
  const msgIdCol = attCols.find((c) => c.name === 'message_id');
  const needsMigration = attExists && msgIdCol && msgIdCol.notnull === 1;

  if (needsMigration) {
    console.log('🔄 chat_attachments: миграция message_id → NULLABLE + новые колонки');
    await db.exec(`
      CREATE TABLE chat_attachments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER,
        thread_id INTEGER,
        uploader_id INTEGER,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        preview_path TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
      )
    `);
    await db.exec(`
      INSERT INTO chat_attachments_new
        (id, message_id, thread_id, uploader_id, file_name, mime_type, file_size,
         storage_path, preview_path, created_at)
      SELECT id, message_id, NULL, NULL, file_name, mime_type, file_size,
             storage_path, preview_path, created_at
      FROM chat_attachments
    `);
    await db.exec('DROP TABLE chat_attachments');
    await db.exec('ALTER TABLE chat_attachments_new RENAME TO chat_attachments');
    console.log('✅ chat_attachments: миграция завершена');
  } else if (!attExists) {
    await db.exec(`
      CREATE TABLE chat_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER,
        thread_id INTEGER,
        uploader_id INTEGER,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        preview_path TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
      )
    `);
  }

  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_chat_attachments_message ON chat_attachments(message_id)'
  );
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_chat_attachments_orphan ON chat_attachments(created_at) WHERE message_id IS NULL'
  );

  console.log('✅ Таблицы чата созданы/проверены');
}

function getChatDB() {
  if (!dbInstance) {
    throw new Error(
      'Чат-БД не инициализирована. Сначала вызовите initChatDB().'
    );
  }
  return dbInstance;
}

function getChatDBPath() {
  return config.chatDbPath;
}

async function closeChatDB() {
  if (!dbInstance) return;
  try {
    await dbInstance.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.warn('[ChatDB] wal_checkpoint:', err.message);
  }
  await dbInstance.close();
  dbInstance = null;
  console.log('[ChatDB] Соединение закрыто');
}

module.exports = {
  initChatDB,
  getChatDB,
  getChatDBPath,
  closeChatDB,
};