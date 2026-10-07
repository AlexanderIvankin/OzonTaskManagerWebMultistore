const axios = require('axios');
const config = require('../config');
const stores = require('../config/stores');
const debugMode = require('../debugMode');

const API_URL = 'https://api-seller.ozon.ru';

// Глобальные значения — из config (единый .env)
const SHIP_IDENTIFIER = config.shipIdentifier;
const MOCK_MODE = config.ozonMockMode;

// ============================================================================
//  Клиенты Ozon — per-store (у каждого магазина свой аккаунт продавца).
//  Кэшируются по storeId. Ключи читаются из stores[storeId].ozon, который
//  собран envLoader'ом из .env + .env.storeN.
// ============================================================================
const clients = new Map(); // storeId -> axios instance

function getClient(storeId) {
  const key = String(storeId);
  if (!key || key === 'undefined' || key === 'null') {
    throw new Error('OzonService: storeId обязателен (не передан в вызов)');
  }
  if (!clients.has(key)) {
    const store = stores.getStore(key); // бросает, если магазина нет
    if (!store.ozon || !store.ozon.clientId || !store.ozon.apiKey) {
      throw new Error(
        `OzonService: магазин ${key} — не заданы OZON_CLIENT_ID / OZON_API_KEY ` +
        `(проверьте .env.store${key})`
      );
    }
    clients.set(key, axios.create({
      baseURL: API_URL,
      headers: {
        'Client-Id': store.ozon.clientId,
        'Api-Key': store.ozon.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }));
  }
  return clients.get(key);
}

/** Сбросить кэш клиента (если ключи магазина изменились в рантайме). */
function invalidateClient(storeId) {
  clients.delete(String(storeId));
}

/**
 * Универсальная функция повторных попыток.
 */
async function requestWithRetry(requestFn, options = {}) {
  const { retries = 3, delay = 1000, context = 'Ozon API' } = options;
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await requestFn();
    } catch (error) {
      attempt++;
      const isRetryable = error.response
        ? [429, 500, 502, 503, 504].includes(error.response.status)
        : true;
      if (isRetryable && attempt < retries) {
        const backoff = delay * Math.pow(2, attempt - 1);
        console.warn(`[${context}] Ошибка (попытка ${attempt}/${retries}):`, error.message);
        console.log(`[${context}] Повтор через ${backoff} мс...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }
      throw error;
    }
  }
}

class OzonService {
  // ==========================================================================
  //  Тестовые хуки: позволяют подменить клиент конкретного магазина.
  //  Основной код пользуется внутренним getClient(storeId).
  // ==========================================================================
  static _setTestClient(storeId, client) {
    clients.set(String(storeId), client);
  }
  static _resetClients() {
    clients.clear();
  }
  static getClient = getClient;

  // --- Склады (с пагинацией) ---
  static async fetchWarehouses(storeId) {
    if (MOCK_MODE) {
      console.log(`[Ozon MOCK][store ${storeId}] Запрос списка складов...`);
      return [
        { warehouse_id: "1234567890", name: "Склад Северный (FBS)", address: "г. Москва, ул. Северная, д.1", is_rfbs: false },
        { warehouse_id: "9876543210", name: "Склад Южный (realFBS)", address: "г. Подольск, ул. Южная, д.10", is_rfbs: true }
      ];
    }
    const client = getClient(storeId);
    try {
      console.log(`[Ozon][store ${storeId}] Запрос списка складов с пагинацией...`);
      let allWarehouses = [];
      let offset = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore) {
        const response = await requestWithRetry(
          () => client.post('/v2/warehouse/list', { limit, offset }),
          { context: `fetchWarehouses[${storeId}]` }
        );
        const warehousesRaw = response.data.warehouses || [];
        const total = response.data.total || 0;

        const mapped = warehousesRaw.map(wh => ({
          warehouse_id: String(wh.warehouse_id),
          name: wh.name,
          address: wh.address_info?.address || null,
          is_rfbs: wh.is_rfbs || false,
        }));
        allWarehouses = allWarehouses.concat(mapped);

        offset += limit;
        hasMore = offset < total;
        if (debugMode.isDebugMode()) {
          console.log(`[Ozon][store ${storeId}] Получено ${mapped.length} складов, всего ${total}, offset=${offset}`);
        }
      }

      console.log(`[Ozon][store ${storeId}] Успешно получено ${allWarehouses.length} складов.`);
      return allWarehouses;
    } catch (error) {
      console.error(`[Ozon][store ${storeId}] Ошибка получения складов:`, error.message);
      return [];
    }
  }

  // --- Заказы в awaiting_packaging (с фильтром по складу и суффиксу) ---
  static async fetchAwaitingOrders(storeId, warehouseId = null, limit = 100) {
    if (MOCK_MODE) {
      const mockOrders = [
        {
          posting_number: `12345-1-s${storeId}`,
          products: [{ name: "Тестовый товар А", quantity: 2, offer_id: "123", sku: "456" }],
          warehouse_id: "1234567890"
        },
        {
          posting_number: `67890-2-s${storeId}`,
          products: [{ name: "Тестовый товар Б", quantity: 1, offer_id: "789", sku: "012" }],
          warehouse_id: "9876543210"
        }
      ];
      if (warehouseId) {
        return mockOrders.filter(o => o.warehouse_id === String(warehouseId));
      }
      return mockOrders;
    }

    const client = getClient(storeId);
    try {
      const since = new Date();
      since.setDate(since.getDate() - 90);
      const to = new Date();

      let allOrders = [];
      let lastId = null;
      let hasMore = true;

      while (hasMore) {
        const filter = {
          statuses: ['awaiting_packaging'],
          since: since.toISOString(),
          to: to.toISOString()
        };
        if (warehouseId) {
          filter.warehouse_ids = [Number(warehouseId)];
        }
        const requestBody = {
          filter,
          limit,
          with: { analytics_data: true }
        };
        if (lastId) requestBody.last_id = lastId;

        const response = await requestWithRetry(
          () => client.post('/v4/posting/fbs/list', requestBody),
          { context: `fetchAwaitingOrders[${storeId}]` }
        );
        const orders = response.data.postings || [];
        allOrders = allOrders.concat(orders);
        lastId = response.data.last_id;
        hasMore = !!lastId && orders.length === limit;
      }

      // Фильтрация по суффиксу offer_id — PER-STORE (см. stores.js).
      // Пусто/null у магазина -> фильтра нет.
      const filterSuffix = stores.getStore(storeId).filterOrderSuffix;
      if (filterSuffix) {
        allOrders = allOrders.filter(order => {
          if (!order.products || !order.products.length) return false;
          return order.products.every(product => {
            const offerId = product.offer_id || '';
            return offerId.endsWith(filterSuffix);
          });
        });
        console.log(`[Ozon][store ${storeId}] После фильтрации по суффиксу "${filterSuffix}" осталось ${allOrders.length} заказов`);
      }

      return allOrders;
    } catch (error) {
      console.error(`[Ozon][store ${storeId}] Ошибка получения заказов:`, error.message);
      throw new Error(`Ошибка Ozon API: ${error.message}`);
    }
  }

  static async fetchAwaitingOrdersById(storeId, orderId) {
    try {
      const allOrders = await this.fetchAwaitingOrders(storeId);
      return allOrders.find(order => order.posting_number === orderId);
    } catch (error) {
      console.error(`[Ozon][store ${storeId}] Ошибка получения заказа ${orderId}:`, error.message);
      return null;
    }
  }

  // --- Заказы в awaiting_deliver ---
  static async fetchAwaitingDeliverOrders(storeId, limit = 100) {
    if (MOCK_MODE) {
      return [
        {
          posting_number: `12345-1-s${storeId}`,
          products: [{ name: "Тестовый товар А", quantity: 2 }],
          status: 'awaiting_deliver'
        }
      ];
    }
    const client = getClient(storeId);
    try {
      const since = new Date();
      since.setDate(since.getDate() - 90);
      const to = new Date();

      let allOrders = [];
      let cursor = null;
      let hasNext = true;

      while (hasNext) {
        const filter = {
          statuses: ['awaiting_deliver'],
          since: since.toISOString(),
          to: to.toISOString()
        };
        const requestBody = {
          filter,
          limit,
          with: { analytics_data: true }
        };
        if (cursor) requestBody.cursor = cursor;

        const response = await requestWithRetry(
          () => client.post('/v4/posting/fbs/list', requestBody),
          { context: `fetchAwaitingDeliverOrders[${storeId}]` }
        );
        const orders = response.data.postings || [];
        allOrders = allOrders.concat(orders);
        cursor = response.data.cursor || null;
        hasNext = response.data.has_next || false;
      }
      return allOrders;
    } catch (error) {
      console.error(`[Ozon][store ${storeId}] Ошибка получения заказов awaiting_deliver:`, error.message);
      throw new Error(`Ошибка Ozon API: ${error.message}`);
    }
  }

  // --- Заказы в статусе cancelled (для сторнирования заработка) ---
  static async fetchCancelledOrders(storeId, limit = 100, windowHours = 48) {
    if (MOCK_MODE) return [];
    const client = getClient(storeId);
    try {
      const to = new Date();
      const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

      let allOrders = [];
      let lastId = null;
      let hasMore = true;

      while (hasMore) {
        const requestBody = {
          filter: {
            statuses: ['cancelled'],
            since: since.toISOString(),
            to: to.toISOString(),
          },
          limit,
          with: { analytics_data: true },
        };
        if (lastId) requestBody.last_id = lastId;

        const response = await requestWithRetry(
          () => client.post('/v4/posting/fbs/list', requestBody),
          { context: `fetchCancelledOrders[${storeId}]` }
        );
        const orders = response.data.postings || [];
        allOrders = allOrders.concat(orders);
        lastId = response.data.last_id;
        hasMore = !!lastId && orders.length === limit;
      }

      return allOrders;
    } catch (error) {
      console.error(`[Ozon][store ${storeId}] Ошибка получения отменённых заказов:`, error.message);
      throw new Error(`Ошибка Ozon API: ${error.message}`);
    }
  }

  // --- Детали заказа ---
  static async getOrderDetails(storeId, orderId) {
    if (MOCK_MODE) {
      return {
        posting_number: orderId,
        status: 'awaiting_packaging',
        products: [
          { name: "Тестовый товар", quantity: 1, offer_id: "123", sku: "456" }
        ],
        financial_data: { products: [{ price: "100.00", quantity: 1 }] },
        delivery_method: { warehouse_id: "1234567890" }
      };
    }
    const client = getClient(storeId);
    try {
      const response = await requestWithRetry(
        () => client.post('/v3/posting/fbs/get', {
          posting_number: orderId,
          with: { financial_data: true, analytics_data: true }
        }),
        { context: `getOrderDetails[${storeId}]_${orderId}` }
      );
      return response.data.result;
    } catch (error) {
      console.error(`[Ozon][store ${storeId}] Ошибка получения деталей заказа ${orderId}:`, error.message);
      return null;
    }
  }

  // --- Получение фотографий по SKU ---
  static async fetchProductsImages(storeId, skuList) {
    if (!skuList.length || MOCK_MODE) return {};
    const client = getClient(storeId);
    try {
      const response = await requestWithRetry(
        () => client.post('/v3/product/info/list', {
          sku: skuList.map(s => String(s))
        }),
        { context: `fetchProductsImages[${storeId}]` }
      );
      const items = response.data.items || [];
      const imageMap = {};
      const MAX_IMAGES_PER_PRODUCT = 6;
      for (const item of items) {
        const collected = [];
        if (Array.isArray(item.primary_image)) collected.push(...item.primary_image);
        if (Array.isArray(item.images)) collected.push(...item.images);
        const uniqueUrls = [];
        for (const u of collected) {
          if (!u || typeof u !== 'string') continue;
          if (uniqueUrls.includes(u)) continue;
          uniqueUrls.push(u);
          if (uniqueUrls.length >= MAX_IMAGES_PER_PRODUCT) break;
        }
        if (uniqueUrls.length) imageMap[item.sku] = uniqueUrls;
      }
      return imageMap;
    } catch (error) {
      console.error(`[Ozon][store ${storeId}] Ошибка получения фото:`, error.message);
      return {};
    }
  }

  // --- Скачивание изображения (публичный URL, магазин не нужен) ---
  static async downloadImage(url) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000
      });
      return Buffer.from(response.data, 'binary');
    } catch (err) {
      console.error('Ошибка загрузки изображения:', err.message);
      return null;
    }
  }

  // --- Получение информации о товарах по offer_id ---
  static async getProductsFullInfo(storeId, offerIds) {
    if (!offerIds.length || MOCK_MODE) return {};
    const client = getClient(storeId);
    const uniqueOffers = [...new Set(offerIds)];
    try {
      const response = await requestWithRetry(
        () => client.post('/v3/product/info/list', { offer_id: uniqueOffers }),
        { context: `getProductsFullInfo[${storeId}]` }
      );
      const items = response.data.items || [];
      const productInfo = {};
      for (const item of items) {
        productInfo[item.offer_id] = {
          product_id: Number(item.id),
          offer_id: item.offer_id,
          sku: item.sku,
          name: item.name,
          weight_gram: item.weight ? parseFloat(item.weight) : 0,
          dimensions: {
            length: item.dimensions?.length || 0,
            width: item.dimensions?.width || 0,
            height: item.dimensions?.height || 0
          }
        };
      }
      return productInfo;
    } catch (error) {
      console.error(`[Ozon][store ${storeId}] Ошибка получения информации о товарах:`, error.message);
      return {};
    }
  }

  // --- Подтверждение сборки (ship) ---
  static async confirmPostingShip(storeId, postingNumber) {
    if (MOCK_MODE) {
      console.log(`[MOCK][store ${storeId}] Подтверждение сборки заказа ${postingNumber}`);
      return { result: [postingNumber] };
    }
    const client = getClient(storeId);

    const details = await this.getOrderDetails(storeId, postingNumber);
    if (!details) throw new Error('Нет деталей заказа');
    if (details.status !== 'awaiting_packaging') {
      throw new Error(`Заказ не в статусе awaiting_packaging (текущий: ${details.status})`);
    }
    if (!details.products || !details.products.length) throw new Error('Нет состава заказа');

    const offerIds = details.products.map(p => p.offer_id).filter(Boolean);
    const productsInfo = await this.getProductsFullInfo(storeId, offerIds);

    const products = details.products.map(p => {
      let info = productsInfo[p.offer_id];
      if (!info && p.sku) {
        info = { product_id: null, offer_id: null, sku: p.sku };
      }
      let identifier;
      switch (SHIP_IDENTIFIER) {
        case 'product_id': identifier = info?.product_id; break;
        case 'offer_id': identifier = info?.offer_id; break;
        case 'sku': identifier = info?.sku || p.sku; break;
        default: identifier = info?.product_id;
      }
      if (!identifier) {
        throw new Error(`Не удалось получить идентификатор для товара ${p.name || p.offer_id}`);
      }
      return { product_id: identifier, quantity: p.quantity };
    });

    const packages = [{ products }];

    try {
      const response = await requestWithRetry(
        () => client.post('/v4/posting/fbs/ship', {
          packages,
          posting_number: postingNumber,
          with: { additional_data: true }
        }),
        { context: `confirmPostingShip[${storeId}]` }
      );
      console.log(`[SHIP][store ${storeId}] Ответ:`, JSON.stringify(response.data, null, 2));
      return response.data;
    } catch (error) {
      console.error(`[SHIP][store ${storeId}] Ошибка подтверждения сборки:`, error.message);
      throw error;
    }
  }

  // --- Получение PDF этикетки (асинхронная пара методов) ---
  static async getPackageLabel(storeId, postingNumberOrNumbers, options = {}) {
    const {
      pollDelays = [45000, 15000, 15000, 15000, 15000],
      downloadTimeout = 30000,
      downloader = null,
    } = options;
    if (MOCK_MODE) {
      return Buffer.from('%PDF-1.4\n%EOF', 'binary');
    }
    const postings = (Array.isArray(postingNumberOrNumbers)
      ? postingNumberOrNumbers
      : [postingNumberOrNumbers]
    )
      .map((n) => String(n))
      .filter(Boolean);
    if (!postings.length) {
      console.error(`[LABEL][store ${storeId}] Пустой список posting_numbers — задача не создаётся`);
      return null;
    }
    const client = getClient(storeId);
    try {
      const createResponse = await requestWithRetry(
        () => client.post('/v3/posting/fbs/package-label/create', {
          posting_numbers: postings,
        }),
        { context: `createPackageLabelTask[${storeId}]` }
      );
      const tasks = createResponse.data?.result?.tasks
        || createResponse.data?.tasks
        || [];
      const task = tasks.find((t) => t && t.task_id) || tasks[0];
      const taskId = task ? task.task_id : null;
      if (!taskId) {
        console.error(`[LABEL][store ${storeId}] Ozon не вернул task_id:`, JSON.stringify(createResponse.data));
        return null;
      }

      for (let attempt = 0; attempt <= pollDelays.length; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, pollDelays[attempt - 1]));
        }
        let statusResponse;
        try {
          statusResponse = await requestWithRetry(
            () => client.post('/v2/posting/fbs/package-label/get', {
              task_id: taskId,
            }),
            { context: `getPackageLabelTask[${storeId}]` }
          );
        } catch (statusError) {
          const httpStatus = statusError?.response?.status;
          if (httpStatus === 400 && attempt < pollDelays.length) {
            console.warn(`[LABEL][store ${storeId}] Задача ${taskId} ещё не готова (400, попытка ${attempt + 1})`);
            continue;
          }
          throw statusError;
        }

        const payload = statusResponse.data?.result || statusResponse.data || {};
        if (payload.error && (payload.error.code || payload.error.message)) {
          console.error(
            `[LABEL][store ${storeId}] Ozon вернул ошибку задачи ${taskId}:`,
            payload.error.code || '',
            payload.error.message || ''
          );
          return null;
        }
        const status = payload.status || {};
        const unprinted = Array.isArray(status.unprinted_postings)
          ? status.unprinted_postings
          : [];
        const unprintedSet = new Set(unprinted.map((u) => u && u.posting_number));
        if (unprinted.length && postings.every((p) => unprintedSet.has(p))) {
          const detail = unprinted
            .map((u) => u && u.message)
            .filter(Boolean)
            .join('; ');
          console.error(
            `[LABEL][store ${storeId}] Ozon не сформировал этикетки для ${postings.join(', ')}` +
            `${detail ? `: ${detail}` : ''}`
          );
          return null;
        }
        if (unprinted.length) {
          console.warn(
            `[LABEL][store ${storeId}] Задача ${taskId}: ${unprintedSet.size} из ${postings.length} ` +
            `отправлений исключено (${[...unprintedSet].join(', ')}), ждём остальные`
          );
        }

        if (payload.file_url) {
          const fetchPdf = downloader
            || ((url) => axios.get(url, {
              responseType: 'arraybuffer',
              timeout: downloadTimeout,
              headers: { 'User-Agent': 'Mozilla/5.0' },
            }));
          const pdfResponse = await requestWithRetry(
            () => fetchPdf(payload.file_url),
            { context: `downloadPackageLabel[${storeId}]` }
          );
          const pdfBuffer = Buffer.from(pdfResponse.data);
          if (pdfBuffer.slice(0, 4).compare(Buffer.from('%PDF')) === 0) {
            return pdfBuffer;
          }
          console.warn(`[LABEL][store ${storeId}] Скачанный файл не является PDF`);
          return null;
        }

        const printed = Number(status.printed_postings_count || 0);
        const total = Number(status.postings_count || 0);
        console.log(
          `[LABEL][store ${storeId}] Задача ${taskId} ещё готовится (попытка ${attempt + 1}/${pollDelays.length + 1}` +
          `${total ? `, напечатано ${printed}/${total}` : ''})`
        );
      }

      console.error(`[LABEL][store ${storeId}] Задача ${taskId} не готова: file_url не появился за все опросы`);
      return null;
    } catch (error) {
      console.error(`[LABEL][store ${storeId}] Ошибка:`, error.message);
      return null;
    }
  }

  // --- Получение общей суммы заказа ---
  static async getOrderTotalAmount(storeId, orderId) {
    const details = await this.getOrderDetails(storeId, orderId);
    if (!details || !details.financial_data || !details.financial_data.products) return 0;
    let total = 0;
    for (const p of details.financial_data.products) {
      const price = parseFloat(p.price) || 0;
      total += price * p.quantity;
    }
    return total;
  }

  // --- РАБОТА С АКЦИЯМИ ---
  static async getActions(storeId) {
    if (MOCK_MODE) {
      return [
        { id: 71342, title: 'test voucher #2', is_participating: true, participating_products_count: 5 },
        { id: 71343, title: 'test voucher #3', is_participating: false, participating_products_count: 0 }
      ];
    }
    const client = getClient(storeId);
    try {
      const response = await requestWithRetry(
        () => client.get('/v1/actions'),
        { context: `getActions[${storeId}]` }
      );
      return response.data.result || [];
    } catch (error) {
      console.error(`[Ozon][store ${storeId}] Ошибка получения акций:`, error.message);
      throw new Error(`Ошибка получения акций: ${error.message}`);
    }
  }

  static async getActionProducts(storeId, actionId, limit = 100, lastId = null) {
    if (MOCK_MODE) {
      const mockProducts = [];
      for (let i = 0; i < 5; i++) {
        mockProducts.push({ id: 1000 + i, price: 100 + i, action_price: 50 + i, stock: 20, min_stock: 3 });
      }
      return { products: mockProducts, total: mockProducts.length, lastId: null };
    }
    const client = getClient(storeId);
    try {
      const requestBody = {
        action_id: actionId,
        limit: Math.min(limit, 100)
      };
      if (lastId) requestBody.last_id = lastId;

      const response = await requestWithRetry(
        () => client.post('/v1/actions/products', requestBody),
        { context: `getActionProducts[${storeId}]_${actionId}` }
      );
      const result = response.data.result || {};
      return {
        products: result.products || [],
        total: result.total || 0,
        lastId: result.last_id || null
      };
    } catch (error) {
      console.error(`[Ozon][store ${storeId}] Ошибка получения товаров акции ${actionId}:`, error.message);
      throw new Error(`Ошибка получения товаров: ${error.message}`);
    }
  }

  static async deactivateActionProducts(storeId, actionId, productIds) {
    if (MOCK_MODE) {
      return { product_ids: productIds, rejected: [] };
    }
    const client = getClient(storeId);
    try {
      const batches = [];
      for (let i = 0; i < productIds.length; i += 100) {
        batches.push(productIds.slice(i, i + 100));
      }
      const allResults = [];
      for (const batch of batches) {
        const response = await requestWithRetry(
          () => client.post('/v1/actions/products/deactivate', {
            action_id: actionId,
            product_ids: batch
          }),
          { context: `deactivateActionProducts[${storeId}]_${actionId}` }
        );
        allResults.push(response.data.result);
        if (batches.length > 1) await new Promise(resolve => setTimeout(resolve, 300));
      }
      const combined = { product_ids: [], rejected: [] };
      for (const res of allResults) {
        if (res) {
          combined.product_ids = combined.product_ids.concat(res.product_ids || []);
          combined.rejected = combined.rejected.concat(res.rejected || []);
        }
      }
      return combined;
    } catch (error) {
      console.error(`[Ozon][store ${storeId}] Ошибка удаления товаров из акции ${actionId}:`, error.message);
      throw new Error(`Ошибка удаления товаров: ${error.message}`);
    }
  }

  static async removeAllPromotions(storeId, progressCallback) {
    const actions = await this.getActions(storeId);
    const activeActions = actions.filter(a => a.participating_products_count && a.participating_products_count > 0);
    if (!activeActions.length) {
      await progressCallback(`📭 Нет акций с активным участием.`);
      return { actionsProcessed: 0, totalProductsRemoved: 0 };
    }
    let totalProductsRemoved = 0;
    let actionsProcessed = 0;
    for (const action of activeActions) {
      const actionId = action.id;
      const actionTitle = action.title || `ID: ${actionId}`;
      await progressCallback(`🔄 Обработка акции: "${actionTitle}"`);
      let allProductIds = [];
      let lastId = null;
      let hasMore = true;
      while (hasMore) {
        const { products, lastId: newLastId } = await this.getActionProducts(storeId, actionId, 100, lastId);
        const ids = products.map(p => p.id);
        allProductIds = allProductIds.concat(ids);
        lastId = newLastId;
        hasMore = !!lastId && products.length === 100;
      }
      if (!allProductIds.length) {
        await progressCallback(`ℹ️ В акции "${actionTitle}" нет товаров.`);
        continue;
      }
      await progressCallback(`📦 Найдено ${allProductIds.length} товаров. Удаление...`);
      const result = await this.deactivateActionProducts(storeId, actionId, allProductIds);
      totalProductsRemoved += result.product_ids.length;
      actionsProcessed++;
      await progressCallback(`✅ Удалено ${result.product_ids.length} товаров.`);
    }
    return { actionsProcessed, totalProductsRemoved };
  }
}

module.exports = OzonService;
module.exports.invalidateClient = invalidateClient;