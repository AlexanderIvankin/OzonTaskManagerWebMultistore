/**
 * Smoke-тест: получение этикетки через асинхронную пару Ozon API
 * (запуск: node tests/smoke-package-label.js из папки backend/).
 * Реальных запросов к Ozon нет: HTTP-клиент и скачивание PDF подменяются
 * стабами. Проверяет пару create/get, включая пакетный вызов по массиву
 * номеров отправлений (см. проверки 7-9 в конце файла).
 */

process.env.OZON_MOCK_MODE = 'false';

const assert = require('assert');
const OzonService = require('../src/services/OzonService');

const POSTING = '12345-0001-1';
const TASK_ID = 987654;
const FILE_URL = 'https://cdn.ozon.test/labels/task-987654.pdf';
const PDF_BYTES = Buffer.from('%PDF-1.4 fake-label\n%EOF');

function makeApiStub({ createPayload, getPayloads }) {
  const calls = [];
  let getIndex = 0;
  return {
    calls,
    client: {
      post: async (url, body) => {
        calls.push({ url, body });
        if (url === '/v3/posting/fbs/package-label/create') return { data: createPayload };
        if (url === '/v2/posting/fbs/package-label/get') {
          const payload = getPayloads[Math.min(getIndex, getPayloads.length - 1)];
          getIndex += 1;
          return { data: payload };
        }
        throw new Error(`Неожиданный URL: ${url}`);
      },
    },
  };
}

async function withStub(apiStub, fn) {
  const real = OzonService.apiClient;
  OzonService.apiClient = apiStub;
  try {
    return await fn();
  } finally {
    OzonService.apiClient = real;
  }
}

(async () => {
  console.log('=== Smoke-тест: package-label (create/get) ===');

  // --- 1-3. Задача готовится два опроса, затем отдаёт file_url ---
  const preparing = { result: { status: { code: 'processing', postings_count: 1, printed_postings_count: 0 } } };
  const ready = { result: { file_url: FILE_URL, status: { code: 'ready', postings_count: 1, printed_postings_count: 1 } } };
  const okStub = makeApiStub({
    createPayload: { result: { tasks: [{ task_id: TASK_ID, task_type: 'package_label' }] } },
    getPayloads: [preparing, preparing, ready],
  });
  let downloadedUrl = null;
  const downloader = async (url) => {
    downloadedUrl = url;
    return { data: PDF_BYTES };
  };
  const label = await withStub(okStub.client, () =>
    OzonService.getPackageLabel(POSTING, { pollDelays: [0, 0], downloader })
  );
  assert(Buffer.isBuffer(label), 'Этикетка должна вернуться Buffer');
  assert.strictEqual(label.slice(0, 4).toString(), '%PDF', 'Скачанный файл — не PDF');
  assert.strictEqual(downloadedUrl, FILE_URL, 'PDF скачан не по file_url из задачи');
  assert.strictEqual(okStub.calls[0].url, '/v3/posting/fbs/package-label/create');
  assert.deepStrictEqual(okStub.calls[0].body, { posting_numbers: [POSTING] });
  const getCalls = okStub.calls.filter((c) => c.url === '/v2/posting/fbs/package-label/get');
  assert.strictEqual(getCalls.length, 3, `Ожидалось 3 опроса, было ${getCalls.length}`);
  assert(getCalls.every((c) => c.body.task_id === TASK_ID), 'Опросы идут с task_id из create');
  console.log('1-3. create -> опросы с task_id -> скачивание PDF по file_url');

  // --- 4. Ошибка задачи -> null без скачивания ---
  const errorStub = makeApiStub({
    createPayload: { result: { tasks: [{ task_id: TASK_ID }] } },
    getPayloads: [{ result: { error: { code: 'ERROR', message: 'boom' } } }],
  });
  let downloadCalled = false;
  const noDownload = async () => { downloadCalled = true; return { data: PDF_BYTES }; };
  const errorLabel = await withStub(errorStub.client, () =>
    OzonService.getPackageLabel(POSTING, { pollDelays: [], downloader: noDownload })
  );
  assert.strictEqual(errorLabel, null, 'При payload.error должен вернуться null');
  assert.strictEqual(downloadCalled, false, 'При ошибке задачи скачивание не вызывается');
  console.log('4. payload.error -> null, скачивания нет');

  // --- 5. Отправление не напечатано -> null без скачивания ---
  const rejectedStub = makeApiStub({
    createPayload: { tasks: [{ task_id: TASK_ID }] },
    getPayloads: [{
      file_url: FILE_URL,
      status: { unprinted_postings: [{ posting_number: POSTING, message: 'Нет этикетки' }] },
    }],
  });
  downloadCalled = false;
  const rejectedLabel = await withStub(rejectedStub.client, () =>
    OzonService.getPackageLabel(POSTING, { pollDelays: [], downloader: noDownload })
  );
  assert.strictEqual(rejectedLabel, null, 'При unprinted_postings должен вернуться null');
  assert.strictEqual(downloadCalled, false, 'При отказе скачивание не вызывается');
  console.log('5. unprinted_postings -> null, скачивания нет');

  // --- 6. file_url не появился -> null после всех опросов ---
  const pendingStub = makeApiStub({
    createPayload: { result: { tasks: [{ task_id: TASK_ID }] } },
    getPayloads: [preparing],
  });
  const pendingLabel = await withStub(pendingStub.client, () =>
    OzonService.getPackageLabel(POSTING, {
      pollDelays: [0, 0],
      downloader: async () => { throw new Error('Скачивание не должно вызываться'); },
    })
  );
  assert.strictEqual(pendingLabel, null, 'Без file_url должен вернуться null');
  const pendingGets = pendingStub.calls.filter((c) => c.url === '/v2/posting/fbs/package-label/get');
  assert.strictEqual(pendingGets.length, 3, `Ожидалось 3 опроса, было ${pendingGets.length}`);
  console.log('6. Нет file_url -> null после всех опросов');

  // --- 7. Пакетный вызов: массив номеров уходит одним create-заданием ---
  const batchStub = makeApiStub({
    createPayload: { result: { tasks: [{ task_id: TASK_ID }] } },
    getPayloads: [ready],
  });
  let batchDownloaded = null;
  const batchDownloader = async (url) => {
    batchDownloaded = url;
    return { data: PDF_BYTES };
  };
  const batchLabel = await withStub(batchStub.client, () =>
    OzonService.getPackageLabel(['P-1', 'P-2'], { pollDelays: [], downloader: batchDownloader })
  );
  assert(Buffer.isBuffer(batchLabel), 'Пакетный вызов должен вернуть Buffer');
  const creates = batchStub.calls.filter((c) => c.url === '/v3/posting/fbs/package-label/create');
  assert.strictEqual(creates.length, 1, 'Массив должен уходить одним create-вызовом');
  assert.deepStrictEqual(creates[0].body, { posting_numbers: ['P-1', 'P-2'] });
  assert.strictEqual(batchDownloaded, FILE_URL, 'PDF скачан не по file_url');
  console.log('7. Массив posting_numbers -> одно задание create, один PDF');

  // --- 8. Часть отправлений отклонена -> PDF по напечатанным ---
  const partialStub = makeApiStub({
    createPayload: { result: { tasks: [{ task_id: TASK_ID }] } },
    getPayloads: [{
      file_url: FILE_URL,
      status: { unprinted_postings: [{ posting_number: 'P-2', message: 'Нет этикетки' }] },
    }],
  });
  downloadCalled = false;
  const partialLabel = await withStub(partialStub.client, () =>
    OzonService.getPackageLabel(['P-1', 'P-2'], { pollDelays: [], downloader: noDownload })
  );
  assert(Buffer.isBuffer(partialLabel), 'Частичный отказ не должен обнулять PDF');
  assert.strictEqual(downloadCalled, true, 'PDF по напечатанным должен скачиваться');
  console.log('8. Частичный unprinted_postings -> PDF по напечатанным');

  // --- 9. Все отправления в пакете отклонены -> null ---
  const allRejectedStub = makeApiStub({
    createPayload: { result: { tasks: [{ task_id: TASK_ID }] } },
    getPayloads: [{
      file_url: FILE_URL,
      status: {
        unprinted_postings: [
          { posting_number: 'P-1', message: 'Причина 1' },
          { posting_number: 'P-2', message: 'Причина 2' },
        ],
      },
    }],
  });
  downloadCalled = false;
  const allRejectedLabel = await withStub(allRejectedStub.client, () =>
    OzonService.getPackageLabel(['P-1', 'P-2'], { pollDelays: [], downloader: noDownload })
  );
  assert.strictEqual(allRejectedLabel, null, 'Полный отказ по всем -> null');
  assert.strictEqual(downloadCalled, false, 'При полном отказе скачивание не вызывается');
  console.log('9. Все номера в unprinted_postings -> null, скачивания нет');

  console.log('✅ Все проверки пройдены');
})().catch((err) => {
  console.error('❌ Smoke-тест провален:', err.message);
  process.exit(1);
});
