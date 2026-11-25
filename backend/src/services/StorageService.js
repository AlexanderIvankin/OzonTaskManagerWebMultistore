const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { s3, BUCKET, MODELS_PREFIX } = require('../config/s3');
const config = require('../config');
const {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

const CACHE_DIR = path.join(__dirname, '../../models-cache');
// TTL локального кэша zip (по умолчанию 1 час)
const CACHE_TTL = (parseInt(process.env.MODELS_CACHE_TTL_MIN, 10) || 60) * 60 * 1000;
// Лимит дискового кэша (LRU при превышении); 0 — без лимита
const CACHE_MAX_BYTES = (config.models.cacheMaxGb || 0) * 1024 * 1024 * 1024;
// Сироты .tmp-* старше 5 минут — от упавших upload'ов, чистим
const TMP_ORPHAN_TTL_MS = 5 * 60 * 1000;

/**
 * ETag объекта S3 приходит в кавычках ('"abc123"'). Для сравнения версий
 * кавычки срезаем, чтобы значение из HeadObject и ListObjectsV2 совпадало.
 */
function normalizeEtag(etag) {
  if (!etag) return null;
  return String(etag).replace(/"/g, '').trim() || null;
}

class StorageService {
  // offerId -> Promise<string> (путь к кэшу). Mutex: параллельные prepare
  // на один артикул используют ОДИН S3-GetObject, а не N.
  static _inflight = new Map();

  static ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  static keyFor(offerId) {
    return `${MODELS_PREFIX}${offerId}.zip`;
  }

  static cachePath(offerId) {
    return path.join(CACHE_DIR, `${offerId}.zip`);
  }

  /** Абсолютный путь к файлу кэша (для диагностики / X-Accel-Redirect). */
  static absolutePath(offerId) {
    return this.cachePath(offerId);
  }

  static fileNameFor(offerId) {
    return `${offerId}.zip`;
  }

  // ------------------------------------------------------------------
  // ЗАГРУЗКА / ИНВАЛИДАЦИЯ
  // ------------------------------------------------------------------

  static async uploadZip(offerId, buffer, contentType = 'application/zip') {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: this.keyFor(offerId),
      Body: buffer,
      ContentType: contentType,
    }));
    this.invalidateCache(offerId);
  }

  static invalidateCache(offerId) {
    const cp = this.cachePath(offerId);
    if (fs.existsSync(cp)) {
      try {
        fs.unlinkSync(cp);
        return true;
      } catch (err) {
        console.error(`[STORAGE] Не удалось удалить кэш ${offerId}:`, err.message);
      }
    }
    return false;
  }

  // ------------------------------------------------------------------
  // ИНФОРМАЦИЯ О КЭШЕ
  // ------------------------------------------------------------------

  /**
   * Для админки: «есть ли файл и не просрочен ли он».
   * @returns {{ cached: boolean, fresh: boolean, size: number|null, mtime: number|null }}
   */
  static cacheInfo(offerId) {
    const cp = this.cachePath(offerId);
    if (!fs.existsSync(cp)) {
      return { cached: false, fresh: false, size: null, mtime: null };
    }
    try {
      const st = fs.statSync(cp);
      return {
        cached: true,
        fresh: st.mtimeMs + CACHE_TTL > Date.now(),
        size: st.size,
        mtime: st.mtimeMs,
      };
    } catch {
      return { cached: false, fresh: false, size: null, mtime: null };
    }
  }

  /**
   * ФАЗА 1 (prepare): файл есть И не просрочен.
   * null — можно запускать фоновую задачу.
   * @returns {{ path: string, size: number, mtime: number } | null}
   */
  static getCachedInfo(offerId) {
    const cp = this.cachePath(offerId);
    if (!fs.existsSync(cp)) return null;
    try {
      const st = fs.statSync(cp);
      if (st.mtimeMs + CACHE_TTL <= Date.now()) return null; // TTL истёк
      return { path: cp, size: st.size, mtime: st.mtimeMs };
    } catch {
      return null;
    }
  }

  /**
   * ФАЗА 2 (download): файл есть, БЕЗ проверки TTL.
   * prepare уже валидировал свежесть; здесь важно только, что файл физически
   * на месте (token TTL 15 мин << cache TTL 60 мин, поэтому расхождение
   * невозможно в нормальном flow).
   * @returns {{ path: string, size: number, mtime: number } | null}
   */
  static getRawCachedInfo(offerId) {
    const cp = this.cachePath(offerId);
    if (!fs.existsSync(cp)) return null;
    try {
      const st = fs.statSync(cp);
      return { path: cp, size: st.size, mtime: st.mtimeMs };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // ЗАГРУЗКА S3 -> КЭШ
  // ------------------------------------------------------------------

  /**
   * Гарантирует наличие актуального файла в кэше (mutex).
   * @returns {Promise<string>} путь к файлу
   */
  static async ensureCached(offerId) {
    return this.fetchZipToCacheSafe(offerId);
  }

  /**
   * Атомарная загрузка S3 -> кэш.
   * Пишет в `.tmp-<pid>-<ts>-<rand>` и делает rename — обрыв процесса
   * оставит сироту `.tmp-*`, но НЕ битый `{offerId}.zip`, который
   * cacheInfo посчитал бы `fresh: true`.
   */
  static async fetchZipToCache(offerId) {
    this.ensureCacheDir();
    const cp = this.cachePath(offerId);

    if (fs.existsSync(cp)) {
      const st = fs.statSync(cp);
      if (st.mtimeMs + CACHE_TTL > Date.now()) return cp;
      try { fs.unlinkSync(cp); } catch { }
    }

    const tmp = `${cp}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const resp = await s3.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key: this.keyFor(offerId),
      }));
      await pipeline(resp.Body, fs.createWriteStream(tmp));
      fs.renameSync(tmp, cp);
      return cp;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { }
      throw err;
    }
  }

  /**
   * Mutex-обёртка над fetchZipToCache.
   * Параллельные prepare на один offerId получат ОДИН S3-GetObject.
   */
  static async fetchZipToCacheSafe(offerId) {
    const key = String(offerId);
    const existing = this._inflight.get(key);
    if (existing) return existing;
    const p = this.fetchZipToCache(offerId).finally(() => {
      this._inflight.delete(key);
    });
    this._inflight.set(key, p);
    return p;
  }

  /** @deprecated Используйте ensureCached + getCachedInfo. */
  static async getZipInfo(offerId) {
    const cp = await this.fetchZipToCacheSafe(offerId);
    const st = fs.statSync(cp);
    return { path: cp, size: st.size };
  }

  // ------------------------------------------------------------------
  // S3-ОПЕРАЦИИ
  // ------------------------------------------------------------------

  static async exists(offerId) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: this.keyFor(offerId) }));
      return true;
    } catch { return false; }
  }

  static async statZip(offerId) {
    try {
      const st = await s3.send(new HeadObjectCommand({
        Bucket: BUCKET,
        Key: this.keyFor(offerId),
      }));
      return {
        size: typeof st.ContentLength === 'number' ? st.ContentLength : null,
        lastModified: st.LastModified ? new Date(st.LastModified).getTime() : null,
        etag: normalizeEtag(st.ETag),
      };
    } catch (err) {
      const status = err && err.$metadata && err.$metadata.httpStatusCode;
      if (err.name === 'NotFound' || err.name === 'NoSuchKey' || status === 404) return null;
      throw err;
    }
  }

  static async listZipKeys() {
    const out = [];
    let token;
    let resp;
    do {
      try {
        resp = await s3.send(new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: MODELS_PREFIX,
          ContinuationToken: token,
        }));
      } catch (err) {
        console.error('[STORAGE] ListObjectsV2 failed', {
          name: err.name,
          message: err.message,
          code: err.Code || err.code,
          status: err.$metadata?.httpStatusCode,
        });
        throw err;
      }
      for (const obj of resp.Contents || []) {
        const key = obj.Key;
        if (!key || !key.toLowerCase().endsWith('.zip')) continue;
        const offerId = key.slice(MODELS_PREFIX.length, -4);
        out.push({
          key,
          offerId,
          size: typeof obj.Size === 'number' ? obj.Size : null,
          lastModified: obj.LastModified ? new Date(obj.LastModified).getTime() : null,
          etag: normalizeEtag(obj.ETag),
        });
      }
      token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  static async deleteZip(offerId) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: this.keyFor(offerId) }));
    this.invalidateCache(offerId);
  }

  // ------------------------------------------------------------------
  // ОЧИСТКА
  // ------------------------------------------------------------------

  /**
   * Очистка кэша:
   *  1) сироты `.tmp-*` старше 5 мин (упавшие upload'ы)
   *  2) `.zip` старше CACHE_TTL
   *  3) LRU-эвикция, если суммарный размер > MODELS_CACHE_MAX_GB
   * @returns {number} сколько файлов удалено
   */
  static cleanCache() {
    if (!fs.existsSync(CACHE_DIR)) return 0;
    const now = Date.now();
    let removed = 0;
    const zips = [];

    for (const f of fs.readdirSync(CACHE_DIR)) {
      const fp = path.join(CACHE_DIR, f);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }

      if (f.includes('.tmp-')) {
        if (st.mtimeMs + TMP_ORPHAN_TTL_MS <= now) {
          try { fs.unlinkSync(fp); removed++; } catch { }
        }
        continue;
      }
      if (!f.endsWith('.zip')) continue;

      if (st.mtimeMs + CACHE_TTL <= now) {
        try { fs.unlinkSync(fp); removed++; } catch { }
        continue;
      }
      zips.push({ path: fp, size: st.size, mtime: st.mtimeMs });
    }

    if (CACHE_MAX_BYTES > 0) {
      let totalSize = zips.reduce((s, z) => s + z.size, 0);
      if (totalSize > CACHE_MAX_BYTES) {
        zips.sort((a, b) => a.mtime - b.mtime); // oldest first
        for (const z of zips) {
          if (totalSize <= CACHE_MAX_BYTES) break;
          try {
            fs.unlinkSync(z.path);
            totalSize -= z.size;
            removed++;
          } catch { }
        }
      }
    }

    return removed;
  }
}

module.exports = StorageService;