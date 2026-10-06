const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { s3, BUCKET, MODELS_PREFIX } = require('../config/s3');
const {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

const CACHE_DIR = path.join(__dirname, '../../models-cache');
// TTL локального кэша zip (по умолчанию 1 час) — настраивается в .env
const CACHE_TTL = (parseInt(process.env.MODELS_CACHE_TTL_MIN, 10) || 60) * 60 * 1000;

/**
 * ETag объекта S3 приходит в кавычках ('"abc123"'). Для сравнения версий
 * кавычки срезаем, чтобы значение из HeadObject и ListObjectsV2 совпадало.
 */
function normalizeEtag(etag) {
  if (!etag) return null;
  return String(etag).replace(/"/g, '').trim() || null;
}

class StorageService {
  static ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  static keyFor(offerId) {
    // s3://bucket/[S3_MODELS_PREFIX]{offer_id}.zip — по умолчанию файлы в корне бакета
    return `${MODELS_PREFIX}${offerId}.zip`;
  }

  static cachePath(offerId) {
    return path.join(CACHE_DIR, `${offerId}.zip`);
  }

  /**
   * Имя файла, отдаваемое клиенту: ARD000003-N.zip
   */
  static fileNameFor(offerId) {
    return `${offerId}.zip`;
  }

  // Залить zip в S3
  static async uploadZip(offerId, buffer, contentType = 'application/zip') {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: this.keyFor(offerId),
      Body: buffer,
      ContentType: contentType,
    }));
    // сбросить локальный кэш (файл обновлён — старый кэш недействителен)
    this.invalidateCache(offerId);
  }

  /**
   * Сбросить локальный кэш zip для артикула (файл в S3 изменился/удалён).
   * Идемпотентно: нет файла — не ошибка.
   * @returns {boolean} true — файл кэша был и удалён
   */
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

  /**
   * Состояние локального кэша zip (для админки: «модель сейчас в кэше сервера»).
   * @returns {{ cached: boolean, fresh: boolean, size: number|null, mtime: number|null }}
   *   cached — файл присутствует; fresh — присутствует и не просрочен по TTL.
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

  // Скачать zip: сначала кэш, потом S3, с прогревом кэша.
  // Возвращает путь к файлу в локальном кэше.
  static async fetchZipToCache(offerId) {
    this.ensureCacheDir();
    const cp = this.cachePath(offerId);

    if (fs.existsSync(cp)) {
      const st = fs.statSync(cp);
      if (st.mtimeMs + CACHE_TTL > Date.now()) return cp;
      fs.unlinkSync(cp); // просрочен
    }

    const resp = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: this.keyFor(offerId),
    }));

    await pipeline(resp.Body, fs.createWriteStream(cp));
    return cp;
  }

  /**
   * Гарантирует наличие zip в кэше и возвращает { path, size }.
   * Используется перед отдачей файла клиенту (Content-Length + streaming).
   */
  static async getZipInfo(offerId) {
    const cp = await this.fetchZipToCache(offerId);
    const st = fs.statSync(cp);
    return { path: cp, size: st.size };
  }

  static async exists(offerId) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: this.keyFor(offerId) }));
      return true;
    } catch { return false; }
  }

  /**
   * HeadObject: existence + метаданные без скачивания.
   * @returns {Promise<{size: number|null, lastModified: number|null, etag: string|null}|null>}
   *   null — объекта нет (404/NoSuchKey); прочие ошибки пробрасываются.
   *   etag — версия объекта (для сверки «файл изменился?» без скачивания тела).
   */
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

  /**
   * ListObjectsV2: все zip-архивы в бакете (с пагинацией по ContinuationToken).
   * Возвращает и ключ, и offer_id (без MODELS_PREFIX и '.zip') — для
   * периодической синхронизации S3 -> offer_models (ModelService.syncFromStorage).
   * @returns {Promise<Array<{key: string, offerId: string, size: number|null, lastModified: number|null, etag: string|null}>>}
   */
  static async listZipKeys() {
    const out = [];
    let token;
    do {
      try {
        resp = await s3.send(new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: MODELS_PREFIX,
          ContinuationToken: token,
        }));
      } catch (err) {
        // Диагностика: что именно ответил S3
        console.error('[STORAGE] ListObjectsV2 failed', {
          name: err.name,
          message: err.message,
          code: err.Code || err.code,
          status: err.$metadata?.httpStatusCode,
          requestId: err.$metadata?.requestId,
          extendedRequestId: err.$metadata?.extendedRequestId,
          cfId: err.$metadata?.cfId,
          attempts: err.$metadata?.attempts,
          totalRetryDelay: err.$metadata?.totalRetryDelay,
          // body обычно уже съеден, но иногда успевает остаться:
          body: err.$response?.body,
        });
        throw err;
      }
      for (const obj of resp.Contents || []) {
        const key = obj.Key;
        if (!key || !key.toLowerCase().endsWith('.zip')) continue;
        const offerId = key.slice(MODELS_PREFIX.length, -4); // strip prefix + '.zip'
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
  // Очистка просроченного кэша (для scheduler)
  static cleanCache() {
    if (!fs.existsSync(CACHE_DIR)) return 0;
    let removed = 0;
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const fp = path.join(CACHE_DIR, f);
      const st = fs.statSync(fp);
      if (st.mtimeMs + CACHE_TTL <= Date.now()) {
        fs.unlinkSync(fp);
        removed++;
      }
    }
    return removed;
  }
}

module.exports = StorageService;