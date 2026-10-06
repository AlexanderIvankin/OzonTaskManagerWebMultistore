const axios = require('axios');
const config = require('../config');
const debugMode = require('../debugMode');

const API_URL = 'https://api-seller.ozon.ru';
const CLIENT_ID = process.env.OZON_CLIENT_ID;
const API_KEY = process.env.OZON_API_KEY;

const SHIP_IDENTIFIER = process.env.SHIP_IDENTIFIER || 'sku';
const MOCK_MODE = process.env.OZON_MOCK_MODE === 'true';
const FILTER_ORDER_SUFFIX = process.env.FILTER_ORDER_SUFFIX || null;

const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Client-Id': CLIENT_ID,
    'Api-Key': API_KEY,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

/**
 * Универсальная функция повторных попыток
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
  // HTTP-клиент как статическое поле — чтобы тесты могли подменить его
  // стабом (проверка пары create/get без реальных запросов к Ozon).
  static apiClient = apiClient;

  // --- Склады (с пагинацией) ---
  static async fetchWarehouses() {
    if (MOCK_MODE) {
      console.log('[Ozon MOCK] Запрос списка складов...');
      return [
        { warehouse_id: "1234567890", name: "Склад Северный (FBS)", address: "г. Москва, ул. Северная, д.1", is_rfbs: false },
        { warehouse_id: "9876543210", name: "Склад Южный (realFBS)", address: "г. Подольск, ул. Южная, д.10", is_rfbs: true }
      ];
    }

    try {
      console.log('[Ozon] Запрос списка складов с пагинацией...');
      let allWarehouses = [];
      let offset = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore) {
        const response = await requestWithRetry(
          () => apiClient.post('/v2/warehouse/list', { limit, offset }),
          { context: 'fetchWarehouses' }
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
          console.log(`[Ozon] Получено ${mapped.length} складов, всего ${total}, offset=${offset}`);
        }
      }

      console.log(`[Ozon] Успешно получено ${allWarehouses.length} складов.`);
      return allWarehouses;
    } catch (error) {
      console.error('[Ozon] Ошибка получения складов:', error.message);
      return [];
    }
  }

  // --- Заказы в awaiting_packaging (с фильтром по складу и суффиксу) ---
  static async fetchAwaitingOrders(warehouseId = null, limit = 100) {
    if (MOCK_MODE) {
      const mockOrders = [
        {
          posting_number: "12345-1",
          products: [{ name: "Тестовый товар А", quantity: 2, offer_id: "123", sku: "456" }],
          warehouse_id: "1234567890"
        },
        {
          posting_number: "67890-2",
          products: [{ name: "Тестовый товар Б", quantity: 1, offer_id: "789", sku: "012" }],
          warehouse_id: "9876543210"
        }
      ];
      if (warehouseId) {
        return mockOrders.filter(o => o.warehouse_id === String(warehouseId));
      }
      return mockOrders;
    }

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
          filter.warehouse_ids = [Number(warehouseId)]; // массив для нового API
        }
        const requestBody = {
          filter,
          limit,
          with: { analytics_data: true }
        };
        if (lastId) requestBody.last_id = lastId;

        const response = await requestWithRetry(
          () => apiClient.post('/v4/posting/fbs/list', requestBody),
          { context: 'fetchAwaitingOrders' }
        );
        const orders = response.data.postings || [];
        allOrders = allOrders.concat(orders);
        lastId = response.data.last_id;
        hasMore = !!lastId && orders.length === limit;
      }

      // Фильтрация по суффиксу offer_id (если задан)
      if (FILTER_ORDER_SUFFIX) {
        allOrders = allOrders.filter(order => {
          if (!order.products || !order.products.length) return false;
          return order.products.every(product => {
            const offerId = product.offer_id || '';
            return offerId.endsWith(FILTER_ORDER_SUFFIX);
          });
        });
        console.log(`[Ozon] После фильтрации по суффиксу "${FILTER_ORDER_SUFFIX}" осталось ${allOrders.length} заказов`);
      }

      return allOrders;
    } catch (error) {
      console.error('[Ozon] Ошибка получения заказов:', error.message);
      throw new Error(`Ошибка Ozon API: ${error.message}`);
    }
  }

  static async fetchAwaitingOrdersById(orderId) {
    try {
      const allOrders = await this.fetchAwaitingOrders();
      return allOrders.find(order => order.posting_number === orderId);
    } catch (error) {
      console.error(`[Ozon] Ошибка получения заказа ${orderId}:`, error.message);
      return null;
    }
  }

  // --- Заказы в awaiting_deliver ---
  static async fetchAwaitingDeliverOrders(limit = 100) {
    if (MOCK_MODE) {
      return [
        {
          posting_number: "12345-1",
          products: [{ name: "Тестовый товар А", quantity: 2 }],
          status: 'awaiting_deliver'
        }
      ];
    }
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
          () => apiClient.post('/v4/posting/fbs/list', requestBody),
          { context: 'fetchAwaitingDeliverOrders' }
        );
        const orders = response.data.postings || [];
        allOrders = allOrders.concat(orders);
        cursor = response.data.cursor || null;
        hasNext = response.data.has_next || false;
      }
      return allOrders;
    } catch (error) {
      console.error('[Ozon] Ошибка получения заказов awaiting_deliver:', error.message);
      throw new Error(`Ошибка Ozon API: ${error.message}`);
    }
  }

  // --- Заказы в статусе cancelled (для сторнирования заработка) ---
  // Аналог fetchAwaitingOrders: POST /v4/posting/fbs/list со statuses:
  // ['cancelled'] и пагинацией по last_id. Окно по времени — последние
  // windowHours (по умолчанию 48 ч): суточный запуск с запасом не пропускает
  // отмену даже при пропуске дня; повторная обработка безопасна —
  // сторнирование заработка идемпотентно (замок assignments.earnings_revoked_at).
  //
  // Фильтр по суффиксу offer_id здесь НЕ применяется: выборку и так
  // ограничивает поиск по нашим assignment'ам, а у отменённого заказа состав
  // товаров может прийти пустым — фильтрация по суффиксу могла бы его скрыть.
  static async fetchCancelledOrders(limit = 100, windowHours = 48) {
    if (MOCK_MODE) {
      return [];
    }
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
          () => apiClient.post('/v4/posting/fbs/list', requestBody),
          { context: 'fetchCancelledOrders' }
        );
        const orders = response.data.postings || [];
        allOrders = allOrders.concat(orders);
        lastId = response.data.last_id;
        hasMore = !!lastId && orders.length === limit;
      }

      return allOrders;
    } catch (error) {
      console.error('[Ozon] Ошибка получения отменённых заказов:', error.message);
      throw new Error(`Ошибка Ozon API: ${error.message}`);
    }
  }

  // --- Детали заказа ---
  static async getOrderDetails(orderId) {
    if (MOCK_MODE) {
      const mock = {
        posting_number: orderId,
        status: 'awaiting_packaging',
        products: [
          { name: "Тестовый товар", quantity: 1, offer_id: "123", sku: "456" }
        ],
        financial_data: { products: [{ price: "100.00", quantity: 1 }] },
        delivery_method: { warehouse_id: "1234567890" }
      };
      return mock;
    }
    try {
      const response = await requestWithRetry(
        () => apiClient.post('/v3/posting/fbs/get', {
          posting_number: orderId,
          with: { financial_data: true, analytics_data: true }
        }),
        { context: `getOrderDetails_${orderId}` }
      );
      return response.data.result;
    } catch (error) {
      console.error(`[Ozon] Ошибка получения деталей заказа ${orderId}:`, error.message);
      return null;
    }
  }

  // --- Получение фотографий по SKU ---
  static async fetchProductsImages(skuList) {
    if (!skuList.length || MOCK_MODE) return {};
    try {
      const response = await requestWithRetry(
        () => apiClient.post('/v3/product/info/list', {
          sku: skuList.map(s => String(s))
        }),
        { context: 'fetchProductsImages' }
      );
      const items = response.data.items || [];
      const imageMap = {};
      const MAX_IMAGES_PER_PRODUCT = 6; // максимум фото на 1 товар (сетка 3x2)
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
      console.error('[Ozon] Ошибка получения фото:', error.message);
      return {};
    }
  }

  // --- Скачивание изображения ---
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
  static async getProductsFullInfo(offerIds) {
    if (!offerIds.length || MOCK_MODE) return {};
    const uniqueOffers = [...new Set(offerIds)];
    try {
      const response = await requestWithRetry(
        () => apiClient.post('/v3/product/info/list', { offer_id: uniqueOffers }),
        { context: 'getProductsFullInfo' }
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
      console.error('[Ozon] Ошибка получения информации о товарах:', error.message);
      return {};
    }
  }

  // --- Подтверждение сборки (ship) ---
  static async confirmPostingShip(postingNumber) {
    if (MOCK_MODE) {
      console.log(`[MOCK] Подтверждение сборки заказа ${postingNumber}`);
      return { result: [postingNumber] };
    }

    const details = await this.getOrderDetails(postingNumber);
    if (!details) throw new Error('Нет деталей заказа');
    if (details.status !== 'awaiting_packaging') {
      throw new Error(`Заказ не в статусе awaiting_packaging (текущий: ${details.status})`);
    }
    if (!details.products || !details.products.length) throw new Error('Нет состава заказа');

    const offerIds = details.products.map(p => p.offer_id).filter(Boolean);
    const productsInfo = await this.getProductsFullInfo(offerIds);

    // Формируем packages
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
        () => apiClient.post('/v4/posting/fbs/ship', {
          packages,
          posting_number: postingNumber,
          with: { additional_data: true }
        }),
        { context: 'confirmPostingShip' }
      );
      console.log(`[SHIP] Ответ:`, JSON.stringify(response.data, null, 2));
      return response.data;
    } catch (error) {
      console.error(`[SHIP] Ошибка подтверждения сборки:`, error.message);
      throw error;
    }
  }

  // --- Получение PDF этикетки (асинхронная пара методов) ---
  // Ozon v2 /package-label (синхронный PDF) выключен: сначала создаём задачу
  // POST /v3/posting/fbs/package-label/create { posting_numbers: [...] },
  // затем опрашиваем POST /v2/posting/fbs/package-label/get { task_id },
  // пока не появится file_url, и скачиваем готовый PDF по ссылке.
  // Принимает один номер отправления или массив (по докам API — до 1000):
  // массив уходит одним заданием, Ozon возвращает один PDF-файл сразу
  // со всеми этикетками (без локальной склейки).
  // Возвращает Buffer PDF или null (этикетка ещё не готова / ошибка API).
  static async getPackageLabel(postingNumberOrNumbers, options = {}) {
    const {
      // Паузы между опросами задачи (мс). По рекомендации Ozon первая пауза
      // 45-60 секунд после сборки заказа, дальше короткий опрос готовности.
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
      console.error('[LABEL] Пустой список posting_numbers — задача не создаётся');
      return null;
    }
    try {
      const api = OzonService.apiClient;
      const createResponse = await requestWithRetry(
        () => api.post('/v3/posting/fbs/package-label/create', {
          posting_numbers: postings,
        }),
        { context: 'createPackageLabelTask' }
      );
      const tasks = createResponse.data?.result?.tasks
        || createResponse.data?.tasks
        || [];
      const task = tasks.find((t) => t && t.task_id) || tasks[0];
      const taskId = task ? task.task_id : null;
      if (!taskId) {
        console.error('[LABEL] Ozon не вернул task_id:', JSON.stringify(createResponse.data));
        return null;
      }

      for (let attempt = 0; attempt <= pollDelays.length; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, pollDelays[attempt - 1]));
        }
        let statusResponse;
        try {
          statusResponse = await requestWithRetry(
            () => api.post('/v2/posting/fbs/package-label/get', {
              task_id: taskId,
            }),
            { context: 'getPackageLabelTask' }
          );
        } catch (statusError) {
          // 400 на опросе означает, что задача ещё формируется/не найдена —
          // ждём следующую итерацию, а не падаем сразу.
          const httpStatus = statusError?.response?.status;
          if (httpStatus === 400 && attempt < pollDelays.length) {
            console.warn(`[LABEL] Задача ${taskId} ещё не готова (400, попытка ${attempt + 1})`);
            continue;
          }
          throw statusError;
        }

        const payload = statusResponse.data?.result || statusResponse.data || {};
        if (payload.error && (payload.error.code || payload.error.message)) {
          console.error(
            `[LABEL] Ozon вернул ошибку задачи ${taskId}:`,
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
        // null — только если Ozon отклонил ВСЕ запрошенные отправления.
        // Частичный отказ (в пакетном задании) не обнуляет PDF: напечатанные
        // этикетки попадут в file_url ниже.
        if (unprinted.length && postings.every((p) => unprintedSet.has(p))) {
          const detail = unprinted
            .map((u) => u && u.message)
            .filter(Boolean)
            .join('; ');
          console.error(
            `[LABEL] Ozon не сформировал этикетки для ${postings.join(', ')}` +
            `${detail ? `: ${detail}` : ''}`
          );
          return null;
        }
        if (unprinted.length) {
          console.warn(
            `[LABEL] Задача ${taskId}: ${unprintedSet.size} из ${postings.length} ` +
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
            { context: 'downloadPackageLabel' }
          );
          const pdfBuffer = Buffer.from(pdfResponse.data);
          if (pdfBuffer.slice(0, 4).compare(Buffer.from('%PDF')) === 0) {
            return pdfBuffer;
          }
          console.warn('[LABEL] Скачанный файл не является PDF');
          return null;
        }

        const printed = Number(status.printed_postings_count || 0);
        const total = Number(status.postings_count || 0);
        console.log(
          `[LABEL] Задача ${taskId} ещё готовится (попытка ${attempt + 1}/${pollDelays.length + 1}` +
          `${total ? `, напечатано ${printed}/${total}` : ''})`
        );
      }

      console.error(`[LABEL] Задача ${taskId} не готова: file_url не появился за все опросы`);
      return null;
    } catch (error) {
      console.error('[LABEL] Ошибка:', error.message);
      return null;
    }
  }

  // --- Получение общей суммы заказа ---
  static async getOrderTotalAmount(orderId) {
    const details = await this.getOrderDetails(orderId);
    if (!details || !details.financial_data || !details.financial_data.products) return 0;
    let total = 0;
    for (const p of details.financial_data.products) {
      const price = parseFloat(p.price) || 0;
      total += price * p.quantity;
    }
    return total;
  }

  // --- РАБОТА С АКЦИЯМИ ---
  static async getActions() {
    if (MOCK_MODE) {
      return [
        { id: 71342, title: 'test voucher #2', is_participating: true, participating_products_count: 5 },
        { id: 71343, title: 'test voucher #3', is_participating: false, participating_products_count: 0 }
      ];
    }
    try {
      const response = await requestWithRetry(
        () => apiClient.get('/v1/actions'),
        { context: 'getActions' }
      );
      return response.data.result || [];
    } catch (error) {
      console.error('[Ozon] Ошибка получения акций:', error.message);
      throw new Error(`Ошибка получения акций: ${error.message}`);
    }
  }

  static async getActionProducts(actionId, limit = 100, lastId = null) {
    if (MOCK_MODE) {
      const mockProducts = [];
      for (let i = 0; i < 5; i++) {
        mockProducts.push({ id: 1000 + i, price: 100 + i, action_price: 50 + i, stock: 20, min_stock: 3 });
      }
      return { products: mockProducts, total: mockProducts.length, lastId: null };
    }
    try {
      const requestBody = {
        action_id: actionId,
        limit: Math.min(limit, 100)
      };
      if (lastId) requestBody.last_id = lastId;

      const response = await requestWithRetry(
        () => apiClient.post('/v1/actions/products', requestBody),
        { context: `getActionProducts_${actionId}` }
      );
      const result = response.data.result || {};
      return {
        products: result.products || [],
        total: result.total || 0,
        lastId: result.last_id || null
      };
    } catch (error) {
      console.error(`[Ozon] Ошибка получения товаров акции ${actionId}:`, error.message);
      throw new Error(`Ошибка получения товаров: ${error.message}`);
    }
  }

  static async deactivateActionProducts(actionId, productIds) {
    if (MOCK_MODE) {
      return { product_ids: productIds, rejected: [] };
    }
    try {
      const batches = [];
      for (let i = 0; i < productIds.length; i += 100) {
        batches.push(productIds.slice(i, i + 100));
      }
      const allResults = [];
      for (const batch of batches) {
        const response = await requestWithRetry(
          () => apiClient.post('/v1/actions/products/deactivate', {
            action_id: actionId,
            product_ids: batch
          }),
          { context: `deactivateActionProducts_${actionId}` }
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
      console.error(`[Ozon] Ошибка удаления товаров из акции ${actionId}:`, error.message);
      throw new Error(`Ошибка удаления товаров: ${error.message}`);
    }
  }

  static async removeAllPromotions(progressCallback) {
    const actions = await this.getActions();
    const activeActions = actions.filter(a => a.participating_products_count && a.participating_products_count > 0);
    if (!activeActions.length) {
      await progressCallback('📭 Нет акций с активным участием.');
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
        const { products, lastId: newLastId } = await this.getActionProducts(actionId, 100, lastId);
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
      const result = await this.deactivateActionProducts(actionId, allProductIds);
      totalProductsRemoved += result.product_ids.length;
      actionsProcessed++;
      await progressCallback(`✅ Удалено ${result.product_ids.length} товаров.`);
    }
    return { actionsProcessed, totalProductsRemoved };
  }
}

module.exports = OzonService;