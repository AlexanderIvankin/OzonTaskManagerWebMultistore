/**
 * Smoke-тест 3D-моделей (запуск: node tests/smoke-models.js из папки backend/).
 * Проверяет полный конвейер ModelService без реального S3 (s3.send подменяется):
 *   • валидация zip (расширения, traversal, не-zip);
 *   • загрузка модели -> offer_models + S3-заглушка;
 *   • resolveModel с родительским артикулом (-NR -> -N);
 *   • issueForAssignment (выдача при назначении) + оповещения;
 *   • одноразовые токены (создание, погашение, повтор, истечение);
 *   • скачивание через локальный кэш.
 * Тестовые данные удаляются за собой.
 */
process.env.OZON_MOCK_MODE = 'true';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const { initDB, getDB } = require('../src/config/database');
const { initNotificationsDB, getNotificationsDB } = require('../src/config/notificationsDatabase');
const { User } = require('../src/models');
const { s3 } = require('../src/config/s3');
const StorageService = require('../src/services/StorageService');
const ModelService = require('../src/services/ModelService');

const TEST_MARK = 'smokeModels';
const TEST_OFFER = `${TEST_MARK}-N`;
const stamp = Date.now();

// ----------------------------------------------------------------------------
// Заглушка S3: хранит объекты в памяти, GetObject отдаёт Readable (как sdk).
// ETag объекта выводится из его содержимого (md5) — как в S3 он меняется при
// перезаписи, что позволяет тестировать детект «файл обновили напрямую».
// ----------------------------------------------------------------------------
const fakeS3Objects = new Map();
const etagOf = (buf) => `"${crypto.createHash('md5').update(buf).digest('hex')}"`;
s3.send = async (cmd) => {
  const kind = cmd.constructor.name;
  const key = cmd.input?.Key;
  if (kind === 'PutObjectCommand') {
    fakeS3Objects.set(key, Buffer.from(cmd.input.Body));
    return {};
  }
  if (kind === 'GetObjectCommand') {
    const buf = fakeS3Objects.get(key);
    if (!buf) {
      const err = new Error('The specified key does not exist.');
      err.name = 'NoSuchKey';
      throw err;
    }
    return { Body: Readable.from(buf) };
  }
  if (kind === 'HeadObjectCommand') {
    const buf = fakeS3Objects.get(key);
    if (!buf) {
      const err = new Error('NotFound');
      err.name = 'NotFound';
      throw err;
    }
    return { ContentLength: buf.length, LastModified: new Date(), ETag: etagOf(buf) };
  }
  if (kind === 'ListObjectsV2Command') {
    const prefix = cmd.input?.Prefix || '';
    const contents = Array.from(fakeS3Objects.entries())
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, buf]) => ({ Key: k, Size: buf.length, LastModified: new Date(), ETag: etagOf(buf) }));
    return { Contents: contents, IsTruncated: false };
  }
  if (kind === 'DeleteObjectCommand') {
    fakeS3Objects.delete(key);
    return {};
  }
  return {};
};

// ----------------------------------------------------------------------------
// Мини-конструктор zip (метод stored, CRC не проверяется валидатором)
// ----------------------------------------------------------------------------
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const contentBuf = Buffer.from(content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);  // signature
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(0, 8);           // method: stored
    local.writeUInt32LE(contentBuf.length, 18);  // compressed size
    local.writeUInt32LE(contentBuf.length, 22);  // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, contentBuf);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);    // signature
    cdh.writeUInt16LE(20, 6);            // version needed
    cdh.writeUInt32LE(contentBuf.length, 20);  // compressed size
    cdh.writeUInt32LE(contentBuf.length, 24);  // uncompressed size
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);       // local header offset
    centralParts.push(cdh, nameBuf);

    offset += 30 + nameBuf.length + contentBuf.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, eocd]);
}

let assertCount = 0;
function assert(cond, label) {
  assertCount++;
  if (!cond) throw new Error(`Проверка провалена: ${label}`);
  console.log(`  ✔ ${label}`);
}

(async () => {
  const employee = { id: null };
  const moderator = { id: null };
  let db;
  let ndb;

  try {
    console.log('=== Smoke-тест 3D-моделей (ModelService) ===');
    await initDB();
    await initNotificationsDB();
    db = getDB();
    ndb = getNotificationsDB();

    // 1. Тестовые пользователи: сотрудник + модератор (загрузчик модели)
    const emp = await User.create({
      username: `${TEST_MARK}_emp_${stamp}`,
      email: `${TEST_MARK}_emp_${stamp}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeModelsСотрудник',
      role: 'employee',
    });
    const mod = await User.create({
      username: `${TEST_MARK}_mod_${stamp}`,
      email: `${TEST_MARK}_mod_${stamp}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeModelsМодератор',
      role: 'moderator',
    });
    employee.id = emp.id;
    moderator.id = mod.id;
    console.log(`Созданы: сотрудник #${emp.id}, модератор #${mod.id}`);

    // 2. Вспомогательные функции
    assert(ModelService.getParentOfferId('ARD000003-NR') === 'ARD000003-N', 'getParentOfferId: -NR -> -N');
    assert(ModelService.getParentOfferId('ARD000003-NL') === 'ARD000003-N', 'getParentOfferId: -NL -> -N');
    assert(ModelService.getParentOfferId('ARD000003-N') === null, 'getParentOfferId: без суффикса -> null');
    assert(ModelService.normalizeOfferId(' ARD000003-N.zip ') === 'ARD000003-N', 'normalizeOfferId: обрезает .zip и пробелы');
    assert(ModelService.normalizeOfferId('../evil') === null, 'normalizeOfferId: отклоняет traversal');
    assert(ModelService.normalizeOfferId('a/b') === null, 'normalizeOfferId: отклоняет слэш');

    // 3. Валидация zip
    const goodZip = buildZip([
      { name: 'ARD000003-N.stl', content: 'fake stl data' },
      { name: 'readme.txt', content: 'инструкция' },
    ]);
    const okValidation = ModelService.validateZipBuffer(goodZip);
    assert(okValidation.entries.includes('ARD000003-N.stl'), 'validateZipBuffer: хороший zip проходит (.stl + .txt)');
    assert(okValidation.totalUncompressed > 0, 'validateZipBuffer: суммарный размер посчитан');
    assert(
      okValidation.hasModelFiles && okValidation.modelFiles.includes('ARD000003-N.stl'),
      'validateZipBuffer: файлы-модели перечислены (modelFiles)'
    );

    const mustFail = (zip, label) => {
      try {
        ModelService.validateZipBuffer(zip);
        throw new Error(`Ожидалась ошибка: ${label}`);
      } catch (err) {
        if (String(err.message).startsWith('Ожидалась ошибка')) throw err;
        console.log(`  ✔ ${label}: «${err.message.slice(0, 60)}»`);
      }
    };
    mustFail(buildZip([{ name: 'virus.exe', content: 'x' }]), 'zip с .exe отклоняется');
    mustFail(buildZip([{ name: '../escape.stl', content: 'x' }]), 'zip с path traversal отклоняется');
    // Внутри архива проверка файлов-моделей МЯГКАЯ: zip с посторонними файлами
    // (.docx и т.п.) загружается, но фиксируется как «без файлов-моделей».
    const softValidation = ModelService.validateZipBuffer(
      buildZip([{ name: 'only.docx', content: 'x' }])
    );
    assert(
      softValidation.hasModelFiles === false && softValidation.modelFiles.length === 0,
      'validateZipBuffer: zip без файлов-моделей проходит (мягкая проверка)'
    );
    mustFail(Buffer.from('не zip вообще'), 'не-zip отклоняется');

    // ЖЁСТКАЯ проверка загружаемого персоналом файла: имя обязано быть .zip
    const mustRejectUpload = (fileName, zip, label) => {
      try {
        ModelService.validateUploadFile(fileName, zip);
        throw new Error(`Ожидалась ошибка: ${label}`);
      } catch (err) {
        if (String(err.message).startsWith('Ожидалась ошибка')) throw err;
        assert(err.validation === true, `${label}: помечена как validation`);
        console.log(`  ✔ ${label}: «${err.message.slice(0, 60)}»`);
      }
    };
    mustRejectUpload('ARD000003-N.rar', goodZip, 'validateUploadFile: не-zip имя отклоняется');
    mustRejectUpload('ARD000003-N.zip', Buffer.from('не zip вообще'), 'validateUploadFile: не-zip содержимое отклоняется');
    const nameOk = ModelService.validateUploadFile('ARD000003-N.zip', goodZip);
    assert(nameOk.hasModelFiles, 'validateUploadFile: правильный .zip проходит');

    // 4. Загрузка модели модератором -> offer_models + S3-заглушка
    const uploaded = await ModelService.uploadModel(
      TEST_OFFER, goodZip, mod.id, `${TEST_OFFER}.zip`
    );
    assert(uploaded.offer_id === TEST_OFFER, 'uploadModel: запись в offer_models создана');
    assert(
      uploaded.s3_key === `${TEST_OFFER}.zip`,
      `uploadModel: ключ S3 = ${TEST_OFFER}.zip (корень бакета)`
    );
    assert(fakeS3Objects.has(`${TEST_OFFER}.zip`), 'uploadModel: zip залит в S3 (заглушку)');
    assert(uploaded.hasModelFiles === true, 'uploadModel: файлы-модели в ответе');
    // Отказ валидации: не-zip имя отклоняется ДО обращения к S3
    let uploadRejected = false;
    const s3KeysBefore = fakeS3Objects.size;
    try {
      await ModelService.uploadModel(TEST_OFFER, goodZip, mod.id, 'ARD000003-N.txt');
    } catch (err) {
      uploadRejected = err.validation === true;
    }
    assert(uploadRejected, 'uploadModel: не-zip имя файла отклоняется (validation)');
    assert(fakeS3Objects.size === s3KeysBefore, 'uploadModel: при отказе валидации S3 не тронут');
    assert(!!uploaded.s3_etag && uploaded.s3_etag.length === 32, 'uploadModel: версия (ETag S3) записана');
    assert(uploaded.file_size === goodZip.length, 'uploadModel: размер zip записан');

    // 5. Поиск с родительским артикулом: модель загружена для -N, ищем для -NR
    const resolvedChild = await ModelService.resolveModel('SMOKEUNKNOWN-NR');
    assert(resolvedChild === null, 'resolveModel: для неизвестного артикула — null');
    const resolved = await ModelService.resolveModel(`${TEST_OFFER}R`);
    assert(!!resolved && resolved.matchedOfferId === TEST_OFFER, `resolveModel: ${TEST_OFFER}R находит родителя ${TEST_OFFER}`);

    // 6. Выдача при назначении заказа: товар -NR получает модель родителя -N
    const summary = await ModelService.issueForAssignment(
      `SMOKE-ORDER-${stamp}`,
      emp.id,
      emp,
      { products: [{ name: 'Тестовый товар', offer_id: `${TEST_OFFER}R`, quantity: 1 }] }
    );
    assert(summary.available.length === 1 && summary.missing.length === 0, 'issueForAssignment: модель выдана через родителя');
    assert(summary.available[0].sourceOfferId === TEST_OFFER, `issueForAssignment: sourceOfferId = ${TEST_OFFER}`);
    assert(summary.parentMatched.length === 1, 'issueForAssignment: parentMatched заполнен (модель от родителя)');
    assert(
      summary.parentMatched[0].offerId === `${TEST_OFFER}R` &&
        summary.parentMatched[0].parentOfferId === TEST_OFFER &&
        summary.parentMatched[0].fileName === `${TEST_OFFER}.zip`,
      'issueForAssignment: parentMatched содержит оба артикула и имя файла'
    );
    const issuedRow = await db.get(
      'SELECT * FROM issued_models WHERE user_id = ? AND offer_id = ?',
      emp.id, `${TEST_OFFER}R`
    );
    assert(!!issuedRow, 'issueForAssignment: запись в issued_models по ИСХОДНОМУ артикулу (-NR)');
    const empNotifs = await ndb.all(
      `SELECT type FROM notifications WHERE recipient_id = ? AND type LIKE 'model%'`,
      emp.id
    );
    assert(empNotifs.some((n) => n.type === 'models_available'), 'issueForAssignment: оповещение models_available создано');
    // notifyStaff — fire-and-forget (как во всём коде): даём записи записаться
    await new Promise((resolve) => setTimeout(resolve, 500));
    const staffNotifs = await ndb.all(
      `SELECT type FROM notifications WHERE audience = 'staff' AND type LIKE 'model%'`
    );
    assert(staffNotifs.some((n) => n.type === 'models_available'), 'issueForAssignment: журнал models_available (staff) создан');
    assert(
      staffNotifs.some((n) => n.type === 'models_parent_used'),
      'issueForAssignment: журнал models_parent_used (staff) создан (модель взята у родителя)'
    );

    // Повторная выдача — идемпотентна (без дублей)
    await ModelService.issueForAssignment(`SMOKE-ORDER-2-${stamp}`, emp.id, emp, {
      products: [{ name: 'Тот же товар', offer_id: `${TEST_OFFER}R`, quantity: 1 }],
    });
    const issuedDup = await db.get(
      'SELECT COUNT(*) AS c FROM issued_models WHERE user_id = ? AND offer_id = ?',
      emp.id, `${TEST_OFFER}R`
    );
    assert(issuedDup.c === 1, 'issueForAssignment: повторная выдача не дублирует issued_models');

    // 7. Одноразовые токены
    const grant = await ModelService.requestToken(`${TEST_OFFER}R`, emp);
    assert(!!grant.token && grant.token.length === 64, 'requestToken: токен 64 hex-символа (32 байта)');
    assert(grant.offerId === TEST_OFFER, 'requestToken: отдаёт нормализованный артикул (родителя)');
    assert(grant.fileName === `${TEST_OFFER}.zip`, 'requestToken: fileName = {offer_id}.zip');

    const consumed = await ModelService.consumeToken(grant.token);
    assert(consumed.offerId === TEST_OFFER && consumed.userId === emp.id, 'consumeToken: токен погашен, владелец совпадает');
    let reused = false;
    try { await ModelService.consumeToken(grant.token); reused = true; } catch { /* ожидаемо */ }
    assert(!reused, 'consumeToken: повторное использование отклоняется');

    let badTokenRejected = false;
    try { await ModelService.consumeToken('a'.repeat(64)); } catch { badTokenRejected = true; }
    assert(badTokenRejected, 'consumeToken: несуществующий токен отклоняется');

    // Истёкший токен
    const lastToken = await db.get(
      'SELECT token FROM model_download_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      emp.id
    );
    await db.run('UPDATE model_download_tokens SET expires_at = ? WHERE token = ?', Date.now() - 1000, lastToken.token);
    let expiredRejected = false;
    try { await ModelService.consumeToken(lastToken.token); } catch { expiredRejected = true; }
    assert(expiredRejected, 'consumeToken: истёкший токен отклоняется');

    // Доступ: постороннему сотруднику — отказ, персоналу — разрешено
    const stranger = await User.create({
      username: `${TEST_MARK}_str_${stamp}`,
      email: `${TEST_MARK}_str_${stamp}@smoke.local`,
      passwordHash: 'x',
      name: 'SmokeModelsПосторонний',
      role: 'employee',
    });
    let denied = false;
    try { await ModelService.requestToken(TEST_OFFER, stranger); } catch (err) { denied = err.status === 403; }
    assert(denied, 'requestToken: постороннему сотруднику — 403');
    const staffGrant = await ModelService.requestToken(TEST_OFFER, mod);
    assert(!!staffGrant.token, 'requestToken: персонал может скачать любую модель');

    // 8. Скачивание через локальный кэш (прогрев из S3-заглушки)
    const cacheFile = StorageService.cachePath(TEST_OFFER);
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
    const info = await ModelService.getDownloadInfo(TEST_OFFER);
    assert(fs.existsSync(info.path), 'getDownloadInfo: файл прогрет в локальный кэш');
    assert(
      fs.readFileSync(info.path).equals(fakeS3Objects.get(`${TEST_OFFER}.zip`)),
      'getDownloadInfo: содержимое кэша совпадает с S3'
    );
    assert(info.fileName === `${TEST_OFFER}.zip`, 'getDownloadInfo: имя файла корректно');

    // 9. Обогащение товаров информацией о модели (для кнопки на клиенте)
    const products = await ModelService.attachToProducts([
      { name: 'Тестовый товар', offer_id: `${TEST_OFFER}R` },
      { name: 'Без модели', offer_id: 'SMOKE-NO-MODEL' },
    ]);
    assert(products[0].model && products[0].model.offerId === TEST_OFFER, 'attachToProducts: p.model проставлен (через родителя)');
    assert(products[1].model === null, 'attachToProducts: p.model = null, если модели нет');

    // 10. Fallback в S3: zip залит в бакет НАПРЯМУЮ (без uploadModel) —
    // артикула нет в offer_models, но модель должна находиться и выдаваться.
    const orphOffer = `${TEST_MARK}-ORPH`;
    const orphZip = buildZip([{ name: `${orphOffer}.stl`, content: 'orphan model' }]);
    fakeS3Objects.set(`${orphOffer}.zip`, orphZip);
    const orphBefore = await db.get('SELECT 1 AS x FROM offer_models WHERE offer_id = ?', orphOffer);
    assert(!orphBefore, 'fallback: в offer_models записи нет (zip залит мимо приложения)');
    const orphResolved = await ModelService.resolveModel(orphOffer);
    assert(
      !!orphResolved && orphResolved.matchedOfferId === orphOffer,
      'resolveModel: orphan-модель найдена через fallback в S3'
    );
    assert(orphResolved.model.file_size === orphZip.length, 'fallback: file_size взят из HeadObject');
    assert(orphResolved.model.from_storage === true, 'fallback: запись помечена as-from_storage');
    const orphRow = await db.get('SELECT * FROM offer_models WHERE offer_id = ?', orphOffer);
    assert(
      !!orphRow && !!orphRow.s3_etag && orphRow.uploaded_by === null,
      'fallback: ленивая регистрация (версия из S3, без uploaded_by)'
    );
    const orphSummary = await ModelService.issueForAssignment(
      `SMOKE-ORPH-${stamp}`, emp.id, emp,
      { products: [{ name: 'Товар с orphan-моделью', offer_id: orphOffer, quantity: 1 }] }
    );
    assert(
      orphSummary.available.length === 1 && orphSummary.missing.length === 0,
      'issueForAssignment: orphan-модель из S3 выдана по артикулу'
    );
    const orphGrant = await ModelService.requestToken(orphOffer, emp);
    assert(!!orphGrant.token, 'requestToken: токен выдан для orphan-модели (emp — уже выдана)');
    // Повторный resolve идемпотентен (запись уже в БД, HeadObject не нужен)
    const orphAgain = await ModelService.resolveModel(orphOffer);
    assert(!!orphAgain && !!orphAgain.model.s3_etag, 'fallback: повторный поиск стабилен');

    // 11. Периодическая синхронизация S3 -> offer_models (scheduler, ежечасно)
    const syncOffer = `${TEST_MARK}-SYNC`;
    fakeS3Objects.set(`${syncOffer}.zip`, buildZip([{ name: 'sync.stl', content: 'x' }]));
    await db.run('DELETE FROM offer_models WHERE offer_id = ?', syncOffer);
    const syncRes = await ModelService.syncFromStorage();
    assert(syncRes.found >= 3, `syncFromStorage: zip перечислены (найдено ${syncRes.found})`);
    const syncRow = await db.get('SELECT * FROM offer_models WHERE offer_id = ?', syncOffer);
    assert(
      !!syncRow && !!syncRow.s3_etag && syncRow.s3_key === `${syncOffer}.zip`,
      'syncFromStorage: недостающая модель зарегистрирована из S3 (с версией)'
    );
    const syncUploadRow = await db.get('SELECT * FROM offer_models WHERE offer_id = ?', TEST_OFFER);
    assert(
      !!syncUploadRow && !!syncUploadRow.s3_etag && syncUploadRow.uploaded_by === mod.id,
      'syncFromStorage: автор загрузки (uploaded_by) не затёрт'
    );
    await ModelService.syncFromStorage(); // повторный прогон
    const syncCnt = await db.get(
      'SELECT COUNT(*) AS c FROM offer_models WHERE offer_id = ?', syncOffer
    );
    assert(syncCnt.c === 1, 'syncFromStorage: повторный запуск идемпотентен');
    // Повторный прогон без изменений не должен рассылать model_updated
    const noopNotifs = await ndb.all(
      `SELECT COUNT(*) AS c FROM notifications WHERE recipient_id = ? AND type = 'model_updated'`,
      emp.id
    );
    assert(noopNotifs[0].c === 0, 'syncFromStorage: без изменений оповещений нет');

    // 12. Архив заменён в S3 НАПРЯМУЮ (мимо приложения): сверка по ETag
    //     обнаруживает новую версию, сбрасывает устаревший кэш и оповещает.
    await ModelService.issueForAssignment(`SMOKE-OOB-${stamp}`, emp.id, emp, {
      products: [{ name: 'Товар для out-of-band', offer_id: TEST_OFFER, quantity: 1 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ndb.run(
      `DELETE FROM notifications WHERE recipient_id = ? AND type = 'model_updated'`,
      emp.id
    );
    // прогреваем локальный кэш текущей версией
    const oobBefore = await ModelService.getDownloadInfo(TEST_OFFER);
    const etagBefore = (await db.get(
      'SELECT s3_etag FROM offer_models WHERE offer_id = ?', TEST_OFFER
    )).s3_etag;
    assert(!!etagBefore && fs.existsSync(oobBefore.path), 'OOB: версия известна, кэш прогрет');

    const newZip = buildZip([{ name: 'ARD000003-N.stl', content: 'updated stl data' }]);
    fakeS3Objects.set(`${TEST_OFFER}.zip`, newZip); // замена файла в S3 напрямую

    const syncRes2 = await ModelService.syncFromStorage();
    assert(syncRes2.updated >= 1, `syncFromStorage: изменение версии обнаружено (updated=${syncRes2.updated})`);
    const etagAfter = (await db.get(
      'SELECT s3_etag FROM offer_models WHERE offer_id = ?', TEST_OFFER
    )).s3_etag;
    assert(etagAfter !== etagBefore, 'OOB: версия в БД обновилась');
    assert(!fs.existsSync(oobBefore.path), 'OOB: устаревший локальный кэш сброшен');
    assert(
      (await db.get('SELECT uploaded_by FROM offer_models WHERE offer_id = ?', TEST_OFFER)).uploaded_by === mod.id,
      'OOB: автор загрузки сохранён'
    );
    const oobNotifs = await ndb.all(
      `SELECT COUNT(*) AS c FROM notifications WHERE recipient_id = ? AND type = 'model_updated'`,
      emp.id
    );
    assert(oobNotifs[0].c > 0, 'OOB: сотруднику отправлено model_updated');
    const oobAfter = await ModelService.getDownloadInfo(TEST_OFFER);
    assert(
      fs.readFileSync(oobAfter.path).equals(newZip),
      'OOB: скачивается актуальная версия (не устаревший кэш)'
    );

    // 12b. Та же логика через путь скачивания (reconcile перед выдачей) —
    //      срабатывает сразу, без ожидания ежечасного синка.
    await ndb.run(
      `DELETE FROM notifications WHERE recipient_id = ? AND type = 'model_updated'`,
      emp.id
    );
    const newerZip = buildZip([{ name: 'ARD000003-N.stl', content: 'ещё новее' }]);
    fakeS3Objects.set(`${TEST_OFFER}.zip`, newerZip);
    const viaDownload = await ModelService.getDownloadInfo(TEST_OFFER);
    assert(
      fs.readFileSync(viaDownload.path).equals(newerZip),
      'reconcile: getDownloadInfo отдаёт актуальную версию сразу после замены в S3'
    );
    const reconcileNotifs = await ndb.all(
      `SELECT COUNT(*) AS c FROM notifications WHERE recipient_id = ? AND type = 'model_updated'`,
      emp.id
    );
    assert(reconcileNotifs[0].c > 0, 'reconcile: сотруднику отправлено model_updated');

    // 13. Список моделей админки: issued_count / in_cache / с3_etag для фильтра
    const list = await ModelService.listModels();
    const listRow = list.find((m) => m.offer_id === TEST_OFFER);
    assert(!!listRow, 'listModels: модель присутствует');
    assert(!!listRow.s3_etag, 'listModels: версия (ETag) присутствует');
    assert(listRow.issued_count >= 1, `listModels: issued_count учитывает выдачи (${listRow.issued_count})`);
    assert(listRow.in_cache === true, 'listModels: модель отмечена как лежащая в кэше сервера');
    assert(listRow.in_work === true, 'listModels: in_work = выдана сотрудникам / в кэше');

    console.log(`\n=== Smoke-тест пройден ✅ (проверок: ${assertCount}) ===`);
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    // Чистим тестовые данные (S3-заглушка живёт в памяти)
    try {
      await ndb.run(
        `DELETE FROM notifications WHERE recipient_id IN (?, ?) OR payload LIKE '%${TEST_MARK}%'`,
        employee.id, moderator.id
      );
      await db.run(`DELETE FROM model_download_tokens WHERE offer_id LIKE '%${TEST_MARK}%'`);
      await db.run(`DELETE FROM issued_models WHERE offer_id LIKE '%${TEST_MARK}%'`);
      await db.run(`DELETE FROM offer_models WHERE offer_id LIKE '%${TEST_MARK}%'`);
      if (employee.id) await db.run('DELETE FROM users WHERE id = ?', employee.id);
      if (moderator.id) await db.run('DELETE FROM users WHERE id = ?', moderator.id);
      const cacheFile = StorageService.cachePath(TEST_OFFER);
      if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
      console.log('Тестовые данные удалены');
    } catch (cleanupErr) {
      console.error('Ошибка очистки:', cleanupErr.message);
    }
  }
})();

