const fs = require('fs');
const path = require('path');

/**
 * Настройки материалов (materials-prices-<storeId>.json) — per-store.
 *
 * У каждого магазина свой файл: ассортимент, цены за грамм, спецпредложения,
 * минимальный заработок, список цветов могут отличаться.
 *
 * Путь: backend/materials-prices-<storeId>.json
 * Легаси-файл backend/materials-prices.json (общий, до мультистора) читается
 * как fallback на первом запуске магазина — потом пишем всегда в свой файл.
 *
 * Кэш — Map<storeId, { materials, specialOffers, minEarnings, colors }>.
 */
class MaterialsService {
  static #caches = new Map();

  static #filePathFor(storeId) {
    if (storeId == null || storeId === '') {
      throw new Error('MaterialsService: storeId обязателен');
    }
    return path.join(__dirname, '../../', `materials-prices-${storeId}.json`);
  }

  static #legacyPath() {
    return path.join(__dirname, '../../', 'materials-prices.json');
  }

  static #getCache(storeId) {
    const key = String(storeId);
    if (!this.#caches.has(key)) {
      this.#caches.set(key, {
        materials: null,
        specialOffers: null,
        minEarnings: 250,
        colors: [],
      });
    }
    return this.#caches.get(key);
  }

  static #setDefaults(cache) {
    cache.materials = {
      'Pet-G': 2.5,
      'ABS': 2.5,
      'Нейлон Pa-6': 2.5,
      'Нейлон Pa-12': 2.5,
      'НейлонАрмир': 2.5,
      'ASA': 2.5,
    };
    cache.specialOffers = {};
    cache.minEarnings = 250;
    cache.colors = ['Черный', 'Белый', 'Серый', 'Прозрачный', 'Красный', 'Желтый', 'Зеленый'];
  }

  /**
   * Файл для чтения: свой файл магазина, если есть; иначе легаси общий
   * (одноразовая миграция — читаем, но при следующем updateMaterials уже
   * пишем в свой).
   */
  static #resolveReadPath(storeId) {
    const own = this.#filePathFor(storeId);
    if (fs.existsSync(own)) return own;
    const legacy = this.#legacyPath();
    if (fs.existsSync(legacy)) {
      console.log(
        `[MaterialsService][store ${storeId}] Свой файл не найден, читаю легаси materials-prices.json`
      );
      return legacy;
    }
    return own;
  }

  static loadMaterials(storeId) {
    const cache = this.#getCache(storeId);
    try {
      const readPath = this.#resolveReadPath(storeId);
      if (!fs.existsSync(readPath)) {
        console.warn(
          `[MaterialsService][store ${storeId}] Файл настроек не найден, используются значения по умолчанию`
        );
        this.#setDefaults(cache);
        return;
      }
      const raw = fs.readFileSync(readPath, 'utf8');
      const data = JSON.parse(raw);
      cache.materials = data.materials || {};
      cache.specialOffers = data.specialOffers || {};
      cache.minEarnings = data.minEarnings || 250;
      cache.colors = data.colors || [];
      console.log(`[MaterialsService][store ${storeId}] Настройки загружены`);
    } catch (err) {
      console.error(`[MaterialsService][store ${storeId}] Ошибка загрузки:`, err);
      this.#setDefaults(cache);
    }
  }

  static getMaterials(storeId) {
    const cache = this.#getCache(storeId);
    if (!cache.materials) this.loadMaterials(storeId);
    return cache.materials;
  }

  static getSpecialOffers(storeId) {
    const cache = this.#getCache(storeId);
    if (!cache.specialOffers) this.loadMaterials(storeId);
    return cache.specialOffers;
  }

  static getMinEarnings(storeId) {
    const cache = this.#getCache(storeId);
    if (cache.minEarnings === null) this.loadMaterials(storeId);
    return cache.minEarnings;
  }

  static getColors(storeId) {
    const cache = this.#getCache(storeId);
    if (!cache.colors.length) this.loadMaterials(storeId);
    return cache.colors;
  }

  /** Путь к актуальному файлу настроек магазина (для скачивания). */
  static getFilePath(storeId) {
    return this.#resolveReadPath(storeId);
  }

  /** Каноничное имя файла для строгой проверки при загрузке. */
  static getFileName(storeId) {
    return path.basename(this.#filePathFor(storeId));
  }

  /**
   * Обновить настройки магазина и записать в ЕГО файл.
   * @param {string|number} storeId
   * @param {object} data — { materials, specialOffers, minEarnings, colors }
   * @param {string|null} [customFilePath] — для тестов
   */
  static updateMaterials(storeId, data, customFilePath = null) {
    if (!data.materials || typeof data.materials !== 'object') {
      throw new Error('Invalid materials format');
    }
    const cache = this.#getCache(storeId);
    cache.materials = data.materials;
    cache.specialOffers = data.specialOffers || {};
    cache.minEarnings = data.minEarnings || 250;
    cache.colors = data.colors || [];

    const targetPath = customFilePath || this.#filePathFor(storeId);
    fs.writeFileSync(targetPath, JSON.stringify(data, null, 2));
    console.log(`[MaterialsService][store ${storeId}] Настройки сохранены в ${targetPath}`);
  }

  static getMaterialPrice(storeId, materialName) {
    const materials = this.getMaterials(storeId);
    return materials[materialName] || 0;
  }

  static getSpecialOffer(storeId, offerId) {
    const offers = this.getSpecialOffers(storeId);
    return offers[offerId] !== undefined ? offers[offerId] : null;
  }
}

module.exports = MaterialsService;