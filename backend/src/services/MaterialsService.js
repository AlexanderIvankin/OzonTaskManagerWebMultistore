const fs = require('fs');
const path = require('path');
const { getVersionedFileName } = require('../utils');

class MaterialsService {
  static #materials = null;
  static #specialOffers = null;
  static #minEarnings = 250;
  static #colors = [];
  // Легаси-файл (до введения BOT_VERSION): materials-prices.json
  static #legacyFilePath = path.join(__dirname, '../../materials-prices.json');
  // Активный файл с суффиксом версии, если задан BOT_VERSION:
  // materials-prices-1.json | materials-prices.json
  static #filePath = path.join(__dirname, '../../', getVersionedFileName('materials-prices', 'json'));

  /**
   * Файл для чтения настроек: версионированный, если существует,
   * иначе легаси materials-prices.json (обратная совместимость).
   */
  static #resolveReadPath() {
    if (fs.existsSync(this.#filePath)) return this.#filePath;
    if (fs.existsSync(this.#legacyFilePath)) return this.#legacyFilePath;
    return this.#filePath;
  }

  /**
   * Загружает настройки из файла materials-prices[-версия].json
   */
  static loadMaterials() {
    try {
      const readPath = this.#resolveReadPath();
      if (readPath === this.#legacyFilePath && this.#legacyFilePath !== this.#filePath) {
        console.log('[MaterialsService] Версионированный файл не найден, читаю легаси materials-prices.json');
      }
      if (!fs.existsSync(readPath)) {
        console.warn('[MaterialsService] Файл настроек материалов не найден, используются значения по умолчанию');
        this.#setDefaults();
        return;
      }
      const raw = fs.readFileSync(readPath, 'utf8');
      const data = JSON.parse(raw);
      this.#materials = data.materials || {};
      this.#specialOffers = data.specialOffers || {};
      this.#minEarnings = data.minEarnings || 250;
      this.#colors = data.colors || [];
      console.log('[MaterialsService] Настройки материалов загружены');
    } catch (err) {
      console.error('[MaterialsService] Ошибка загрузки материалов:', err);
      this.#setDefaults();
    }
  }

  static #setDefaults() {
    this.#materials = {
      'Pet-G': 2.5,
      'ABS': 2.5,
      'Нейлон Pa-6': 2.5,
      'Нейлон Pa-12': 2.5,
      'НейлонАрмир': 2.5,
      'ASA': 2.5
    };
    this.#specialOffers = {};
    this.#minEarnings = 250;
    this.#colors = ['Черный', 'Белый', 'Серый', 'Прозрачный', 'Красный', 'Желтый', 'Зеленый'];
  }

  static getMaterials() {
    if (!this.#materials) this.loadMaterials();
    return this.#materials;
  }

  static getSpecialOffers() {
    if (!this.#specialOffers) this.loadMaterials();
    return this.#specialOffers;
  }

  static getMinEarnings() {
    if (this.#minEarnings === null) this.loadMaterials();
    return this.#minEarnings;
  }

  static getColors() {
    if (!this.#colors.length) this.loadMaterials();
    return this.#colors;
  }

  /**
   * Путь к актуальному файлу настроек (для скачивания):
   * версионированный, если существует, иначе легаси-файл.
   */
  static getFilePath() {
    return this.#resolveReadPath();
  }

  /**
   * Каноничное имя файла настроек с учётом версии
   * (materials-prices-1.json | materials-prices.json) —
   * для строгой проверки имени файла при загрузке.
   */
  static getFileName() {
    return path.basename(this.#filePath);
  }

  /**
   * Обновляет настройки материалов и сохраняет в файл (всегда в постоянный путь)
   */
  static updateMaterials(data, customFilePath = null) {
    if (!data.materials || typeof data.materials !== 'object') {
      throw new Error('Invalid materials format');
    }
    this.#materials = data.materials;
    this.#specialOffers = data.specialOffers || {};
    this.#minEarnings = data.minEarnings || 250;
    this.#colors = data.colors || [];

    // Сохраняем в версионированный файл, если не передан кастомный (используется для тестов)
    const targetPath = customFilePath || this.#filePath;
    fs.writeFileSync(targetPath, JSON.stringify(data, null, 2));
    console.log('[MaterialsService] Настройки материалов сохранены в', targetPath);
  }

  /**
   * Получает цену материала за грамм
   */
  static getMaterialPrice(materialName) {
    const materials = this.getMaterials();
    return materials[materialName] || 0;
  }

  /**
   * Проверяет, есть ли специальное предложение для offer_id
   */
  static getSpecialOffer(offerId) {
    const offers = this.getSpecialOffers();
    return offers[offerId] !== undefined ? offers[offerId] : null;
  }
}

// Автозагрузка при импорте
MaterialsService.loadMaterials();

module.exports = MaterialsService;