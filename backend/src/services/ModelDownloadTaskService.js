const crypto = require('crypto');
const fs = require('fs');
const config = require('../config');
const StorageService = require('./StorageService');

/**
 * In-memory реестр задач подготовки 3D-моделей (S3 -> локальный кэш).
 *
 * ПОЧЕМУ IN-MEMORY (без БД):
 *   • Процесс один (pm2 fork, SQLite) — кросс-процессного состояния нет.
 *   • Потеря при рестарте безопасна: фронт получит 404 на /tasks/:id и
 *     сделает re-prepare, который при уже готовом кэше мгновенно вернёт token.
 *
 * ДЕДУПЛИКАЦИЯ:
 *   • Один offerId = одна активная задача. Новые пользователи подцепляются
 *     к ней через t.users.
 *   • Лимит одновременных активных задач per-user — config.models.taskMaxPerUser.
 */
class ModelDownloadTaskService {
  static tasks = new Map();     // taskId -> task
  static byOffer = new Map();   // offerId -> taskId

  static TASK_TTL_MS = (config.models.taskTtlMin || 30) * 60 * 1000;
  static MAX_PER_USER = config.models.taskMaxPerUser || 3;
  // Один S3-fetch 1 GB на очень медленном канале ~30 мин — за это время
  // реально успеть; если «висит» дольше — это timeout, помечаем failed.
  static PREPARING_TIMEOUT_MS = 30 * 60 * 1000;

  /**
   * Запустить (или подцепиться к) подготовку.
   * @param {string} offerId — артикул, по которому лежит zip (source)
   * @param {string} fileName
   * @param {number|null} fileSize
   * @param {{id:number, name?:string}} user
   * @param {{storeId?:string|null}} [opts]
   * @returns {Promise<string>} taskId
   */
  static async start(offerId, fileName, fileSize, user, { storeId = null } = {}) {
    const key = String(offerId);

    const existingId = this.byOffer.get(key);
    if (existingId) {
      const t = this.tasks.get(existingId);
      if (t) {
        if (t.status === 'preparing') {
          t.users.set(user.id, { storeId });
          return t.id;
        }
        if (t.status === 'ready') {
          // Странный кейс (кэш только что появился, но getCachedInfo его не
          // увидел) — подцепляемся, чтобы не дублировать работу.
          t.users.set(user.id, { storeId });
          return t.id;
        }
      }
      // failed / stale — забываем, создадим новую
      this.byOffer.delete(key);
    }

    // Лимит активных задач per-user
    const activeForUser = Array.from(this.tasks.values()).filter(
      (t) => t.status === 'preparing' && t.users.has(user.id)
    );
    if (activeForUser.length >= this.MAX_PER_USER) {
      const err = new Error(
        `Слишком много одновременных подготовок моделей (лимит ${this.MAX_PER_USER}). ` +
        `Дождитесь завершения текущих и повторите.`
      );
      err.status = 429;
      throw err;
    }

    const id = crypto.randomUUID();
    const task = {
      id,
      offerId: key,
      fileName,
      fileSize: fileSize || null,
      status: 'preparing',
      error: null,
      createdAt: Date.now(),
      users: new Map([[user.id, { storeId }]]),
    };
    this.tasks.set(id, task);
    this.byOffer.set(key, id);

    // Fire-and-forget: prepare-запрос отвечает сразу, фон докачивает.
    StorageService.fetchZipToCacheSafe(key)
      .then(() => {
        try {
          const st = fs.statSync(StorageService.cachePath(key));
          task.fileSize = st.size;
        } catch { }
        task.status = 'ready';
        console.log(
          `[MODELS][task ${id}] ${key} готов (${task.fileSize} байт)`
        );
      })
      .catch((err) => {
        task.status = 'failed';
        task.error = err.message || 'Ошибка загрузки из хранилища';
        console.error(`[MODELS][task ${id}] ${key} упал:`, err.message);
      })
      .finally(() => {
        // Удаляем дедуп-ссылку только если она всё ещё указывает на эту задачу
        if (this.byOffer.get(key) === id) this.byOffer.delete(key);
      });

    return id;
  }

  /**
   * Задача, если она «своя» для пользователя. Иначе null.
   * @returns {object|null}
   */
  static getForUser(taskId, userId) {
    const t = this.tasks.get(String(taskId));
    if (!t) return null;
    if (!t.users.has(userId)) return null;
    return t;
  }

  /**
   * Периодическая чистка (вызывается из scheduler раз в час).
   *  • preparing > PREPARING_TIMEOUT_MS -> failed (зависла)
   *  • ready/failed старше TASK_TTL_MS -> удалить из памяти
   * @returns {{ removed: number, failed: number }}
   */
  static cleanup() {
    const now = Date.now();
    let removed = 0;
    let failed = 0;
    for (const [id, t] of this.tasks) {
      if (t.status === 'preparing' && now - t.createdAt > this.PREPARING_TIMEOUT_MS) {
        t.status = 'failed';
        t.error = 'Timeout: подготовка заняла слишком долго';
        failed++;
      }
      if (t.status !== 'preparing' && now - t.createdAt > this.TASK_TTL_MS) {
        this.tasks.delete(id);
        if (this.byOffer.get(t.offerId) === id) {
          this.byOffer.delete(t.offerId);
        }
        removed++;
      }
    }
    if (removed || failed) {
      console.log(
        `[MODELS][tasks] cleanup: удалено ${removed}, timeout ${failed}`
      );
    }
    return { removed, failed };
  }
}

module.exports = ModelDownloadTaskService;