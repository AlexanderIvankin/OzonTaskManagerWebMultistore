/**
 * Smoke-тест 3D-моделей (запуск: node tests/smoke-models.js из папки backend/).
 *
 * MULTISTORE: модели глобальные (models.db), но оповещения адресуются в
 * контексте магазина (opts.storeId). Тестовые сотрудники должны иметь
 * записи в user_stores для получения notifyStaff.
 *
 * Проверяет полный конвейер ModelService без реального S3 (s3.send подменён):
 *   • валидация zip;
 *   • загрузка модели -> offer_models + S3;
 *   • resolveModel с родительским артикулом (-NR -> -N);
 *   • issueForAssignment + оповещения;
 *   • одноразовые токены;
 *   • скачивание через локальный кэш;
 *   • fallback S3 при отсутствии в offer_models;
 *   • периодическая синхронизация;
 *   • out-of-band замена zip (reconcile по ETag).
 */
const { setup, cleanup } = require('./helpers/setupTestEnv');
const STORE_ID = setup('1').storeId;

const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');

const { initDB, closeAll, getUsersDB, getModelsDB, getStoreDB } = require('../src/config/database');
const { initNotificationsDB, getNotificationsDB, closeNotificationsDB } = require('../src/config/notificationsDatabase');
const { User } = require('../src/models');
const UserStore = require('../src/models/UserStore');
const { s3 } = require('../src/config/s3');
const StorageService = require('../src/services/StorageService');
const ModelService = require('../src/services/ModelService');

const TEST_MARK = 'smokeModels';
const TEST_OFFER = `${TEST_MARK}-N`;
const stamp = Date.now();

// S3-заглушка
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
    if (!buf) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
    return { Body: Readable.from(buf) };
  }
  if (kind === 'HeadObjectCommand') {
    const buf = fakeS3Objects.get(key);
    if (!buf) { const e = new Error('NotFound'); e.name = 'NotFound'; throw e; }
    return { ContentLength: buf.length, LastModified: new Date(), ETag: etagOf(buf) };
  }
  if (kind === 'ListObjectsV2Command') {
    const prefix = cmd.input?.Prefix || '';
    const contents = Array.from(fakeS3Objects.entries())
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, buf]) => ({ Key: k, Size: buf.length, LastModified: new Date(), ETag: etagOf(buf) }));
    return { Contents: contents, IsTruncated: false };
  }
  if (kind === 'DeleteObjectCommand') { fakeS3Objects.delete(key); return {}; }
  return {};
};

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const contentBuf = Buffer.from(content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(contentBuf.length, 18); local.writeUInt32LE(contentBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, contentBuf);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 6);
    cdh.writeUInt32LE(contentBuf.length, 20); cdh.writeUInt32LE(contentBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28); cdh.writeUInt32LE(offset, 42);
    centralParts.push(cdh, nameBuf);
    offset += 30 + nameBuf.length + contentBuf.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(offset, 16);
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
  const stranger = { id: null };
  let usersDb;
  let modelsDb;
  let ndb;

  try {
    console.log('=== Smoke-тест 3D-моделей (ModelService) ===');
    await initDB();
    await initNotificationsDB();
    usersDb = getUsersDB();
    modelsDb = getModelsDB();
    ndb = getNotificationsDB();

    // 1. Тестовые пользователи + записи в user_stores
    const emp = await User.create({
      username: `${TEST_MARK}_emp_${stamp}`,
      email: `${TEST_MARK}_emp_${stamp}@smoke.local`,
      passwordHash: 'x', name: 'SmokeModelsСотрудник', role: 'user',
    });
    const mod = await User.create({
      username: `${TEST_MARK}_mod_${stamp}`,
      email: `${TEST_MARK}_mod_${stamp}@smoke.local`,
      passwordHash: 'x', name: 'SmokeModelsМодератор', role: 'user',
    });
    const str = await User.create({
      username: `${TEST_MARK}_str_${stamp}`,
      email: `${TEST_MARK}_str_${stamp}@smoke.local`,
      passwordHash: 'x', name: 'SmokeModelsПосторонний', role: 'user',
    });

    const empEff = { id: emp.id, role: 'employee', name: emp.name };
    const modEff = { id: mod.id, role: 'moderator', name: mod.name };
    const strEff = { id: str.id, role: 'employee', name: str.name };

    employee.id = emp.id;
    moderator.id = mod.id;
    stranger.id = str.id;
    await UserStore.upsert(emp.id, STORE_ID, { role: 'employee', was_employee: 1 });
    await UserStore.upsert(mod.id, STORE_ID, { role: 'moderator', was_employee: 1 });
    await UserStore.upsert(str.id, STORE_ID, { role: 'employee', was_employee: 1 });
    console.log(`Созданы: emp #${emp.id}, mod #${mod.id}, str #${str.id} (магазин ${STORE_ID})`);

    // 2. Утилиты
    assert(ModelService.getParentOfferId('ARD000001-NR') === 'ARD000001-N', 'getParentOfferId: -NR -> -N');
    assert(ModelService.getParentOfferId('ARD000001-NL') === 'ARD000001-N', 'getParentOfferId: -NL -> -N');
    assert(ModelService.getParentOfferId('ARD000001-N') === null, 'getParentOfferId: без суффикса -> null');
    assert(ModelService.normalizeOfferId(' ARD000001-N.zip ') === 'ARD000001-N', 'normalizeOfferId: обрезает .zip');
    assert(ModelService.normalizeOfferId('../evil') === null, 'normalizeOfferId: traversal отклонён');

    // 3. Валидация zip
    const goodZip = buildZip([
      { name: 'ARD000001-N.stl', content: 'fake stl data' },
      { name: 'readme.txt', content: 'инструкция' },
    ]);
    const okV = ModelService.validateZipBuffer(goodZip);
    assert(okV.entries.includes('ARD000001-N.stl'), 'validateZipBuffer: .stl + .txt проходят');
    assert(okV.hasModelFiles && okV.modelFiles.includes('ARD000001-N.stl'), 'validateZipBuffer: modelFiles');

    const mustFail = (zip, label) => {
      try { ModelService.validateZipBuffer(zip); throw new Error(`Ожидалась ошибка: ${label}`); }
      catch (err) {
        if (String(err.message).startsWith('Ожидалась ошибка')) throw err;
        console.log(`  ✔ ${label}: «${err.message.slice(0, 60)}»`);
      }
    };
    mustFail(buildZip([{ name: 'virus.exe', content: 'x' }]), 'zip с .exe отклоняется');
    mustFail(buildZip([{ name: '../escape.stl', content: 'x' }]), 'zip с traversal отклоняется');
    const softV = ModelService.validateZipBuffer(buildZip([{ name: 'only.docx', content: 'x' }]));
    assert(softV.hasModelFiles === false, 'validateZipBuffer: zip без моделей проходит (мягко)');
    mustFail(Buffer.from('не zip вообще'), 'не-zip отклоняется');

    const mustRejUp = (fileName, zip, label) => {
      try { ModelService.validateUploadFile(fileName, zip); throw new Error(`Ожидалась ошибка: ${label}`); }
      catch (err) {
        if (String(err.message).startsWith('Ожидалась ошибка')) throw err;
        assert(err.validation === true, `${label}: помечена validation`);
      }
    };
    mustRejUp('ARD000001-N.rar', goodZip, 'validateUploadFile: не-zip имя отклонено');
    mustRejUp('ARD000001-N.zip', Buffer.from('не zip'), 'validateUploadFile: не-zip содержимое');
    assert(ModelService.validateUploadFile('ARD000001-N.zip', goodZip).hasModelFiles, 'validateUploadFile: правильный .zip проходит');

    // 4. Загрузка модели
    const uploaded = await ModelService.uploadModel(
      TEST_OFFER, goodZip, mod.id, `${TEST_OFFER}.zip`,
      { storeId: STORE_ID, uploaderName: mod.name }
    );
    assert(uploaded.offer_id === TEST_OFFER, 'uploadModel: запись создана');
    assert(uploaded.s3_key === `${TEST_OFFER}.zip`, 'uploadModel: s3_key в корне бакета');
    assert(fakeS3Objects.has(`${TEST_OFFER}.zip`), 'uploadModel: zip в S3');
    assert(uploaded.hasModelFiles === true, 'uploadModel: hasModelFiles');
    assert(!!uploaded.s3_etag && uploaded.s3_etag.length === 32, 'uploadModel: ETag (32 hex)');
    assert(uploaded.file_size === goodZip.length, 'uploadModel: размер zip');

    // 5. resolveModel с родителем
    assert(await ModelService.resolveModel('SMOKEUNKNOWN-NR') === null, 'resolveModel: неизвестный -> null');
    const resolved = await ModelService.resolveModel(`${TEST_OFFER}R`);
    assert(!!resolved && resolved.matchedOfferId === TEST_OFFER, `resolveModel: ${TEST_OFFER}R -> ${TEST_OFFER}`);

    // 6. issueForAssignment
    const summary = await ModelService.issueForAssignment(
      `SMOKE-ORDER-${stamp}`, emp.id, emp,
      { products: [{ name: 'Тестовый товар', offer_id: `${TEST_OFFER}R`, quantity: 1 }] },
      { storeId: STORE_ID }
    );
    assert(summary.available.length === 1 && summary.missing.length === 0, 'issueForAssignment: выдано через родителя');
    assert(summary.available[0].sourceOfferId === TEST_OFFER, 'issueForAssignment: sourceOfferId');
    assert(summary.parentMatched.length === 1, 'issueForAssignment: parentMatched');
    const issuedRow = await modelsDb.get(
      'SELECT * FROM issued_models WHERE user_id = ? AND offer_id = ?',
      emp.id, `${TEST_OFFER}R`
    );
    assert(!!issuedRow, 'issueForAssignment: запись в issued_models по исходному артикулу');
    const empNotifs = await ndb.all(
      `SELECT type FROM notifications WHERE recipient_id = ? AND type LIKE 'model%'`, emp.id
    );
    assert(empNotifs.some((n) => n.type === 'models_available'), 'issueForAssignment: models_available');
    await new Promise((r) => setTimeout(r, 500));
    const staffNotifs = await ndb.all(
      `SELECT type FROM notifications WHERE audience = 'staff' AND type LIKE 'model%' AND store_id = ?`,
      STORE_ID
    );
    assert(staffNotifs.some((n) => n.type === 'models_available'), 'issueForAssignment: журнал models_available (staff магазина)');
    assert(staffNotifs.some((n) => n.type === 'models_parent_used'), 'issueForAssignment: журнал models_parent_used');

    // 7. Токены
    const grant = await ModelService.requestToken(`${TEST_OFFER}R`, empEff, { storeId: STORE_ID });
    assert(!!grant.token && grant.token.length === 64, 'requestToken: 64 hex');
    assert(grant.offerId === TEST_OFFER, 'requestToken: нормализован');
    assert(grant.fileName === `${TEST_OFFER}.zip`, 'requestToken: fileName');
    const consumed = await ModelService.consumeToken(grant.token);
    assert(consumed.offerId === TEST_OFFER && consumed.userId === emp.id, 'consumeToken: успех');
    let reused = false;
    try { await ModelService.consumeToken(grant.token); reused = true; } catch { }
    assert(!reused, 'consumeToken: повтор отклонён');
    let badRej = false;
    try { await ModelService.consumeToken('a'.repeat(64)); } catch { badRej = true; }
    assert(badRej, 'consumeToken: несуществующий токен отклонён');
    const lastT = await modelsDb.get(
      'SELECT token FROM model_download_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1', emp.id
    );
    await modelsDb.run('UPDATE model_download_tokens SET expires_at = ? WHERE token = ?', Date.now() - 1000, lastT.token);
    let expRej = false;
    try { await ModelService.consumeToken(lastT.token); } catch { expRej = true; }
    assert(expRej, 'consumeToken: истёкший токен отклонён');

    // 8. Доступ.
    // ВАЖНО: requestToken смотрит на user.role. В проде его формирует
    // middlewares/auth: users + user_stores → эффективная роль магазина.
    // Эмулируем ту же форму — плоский объект { id, role, name }.

    let denied = false;
    try { await ModelService.requestToken(TEST_OFFER, strEff, { storeId: STORE_ID }); }
    catch (err) { denied = err.status === 403; }
    assert(denied, 'requestToken: постороннему — 403');

    const staffGrant = await ModelService.requestToken(TEST_OFFER, modEff, { storeId: STORE_ID });
    assert(!!staffGrant.token, 'requestToken: персонал может скачать');

    // 9. Локальный кэш
    const cacheFile = StorageService.cachePath(TEST_OFFER);
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
    const info = await ModelService.getDownloadInfo(TEST_OFFER, { storeId: STORE_ID });
    assert(fs.existsSync(info.path), 'getDownloadInfo: файл в локальном кэше');
    assert(fs.readFileSync(info.path).equals(fakeS3Objects.get(`${TEST_OFFER}.zip`)), 'getDownloadInfo: содержимое совпадает');
    assert(info.fileName === `${TEST_OFFER}.zip`, 'getDownloadInfo: имя файла');

    // 10. attachToProducts
    const products = await ModelService.attachToProducts([
      { name: 'Тестовый товар', offer_id: `${TEST_OFFER}R` },
      { name: 'Без модели', offer_id: 'SMOKE-NO-MODEL' },
    ]);
    assert(products[0].model && products[0].model.offerId === TEST_OFFER, 'attachToProducts: p.model (через родителя)');
    assert(products[1].model === null, 'attachToProducts: p.model=null');

    // 11. Fallback S3
    const orphOffer = `${TEST_MARK}-ORPH`;
    const orphZip = buildZip([{ name: `${orphOffer}.stl`, content: 'orphan model' }]);
    fakeS3Objects.set(`${orphOffer}.zip`, orphZip);
    assert(!(await modelsDb.get('SELECT 1 AS x FROM offer_models WHERE offer_id = ?', orphOffer)), 'fallback: в БД нет');
    const orphResolved = await ModelService.resolveModel(orphOffer);
    assert(!!orphResolved && orphResolved.matchedOfferId === orphOffer, 'resolveModel: orphan найден в S3');
    assert(orphResolved.model.from_storage === true, 'fallback: from_storage=true');
    const orphRow = await modelsDb.get('SELECT * FROM offer_models WHERE offer_id = ?', orphOffer);
    assert(!!orphRow && !!orphRow.s3_etag && orphRow.uploaded_by === null, 'fallback: ленивая регистрация');

    // 12. syncFromStorage
    const syncOffer = `${TEST_MARK}-SYNC`;
    fakeS3Objects.set(`${syncOffer}.zip`, buildZip([{ name: 'sync.stl', content: 'x' }]));
    await modelsDb.run('DELETE FROM offer_models WHERE offer_id = ?', syncOffer);
    const syncRes = await ModelService.syncFromStorage();
    assert(syncRes.found >= 3, `syncFromStorage: найдено ${syncRes.found}`);
    const syncRow = await modelsDb.get('SELECT * FROM offer_models WHERE offer_id = ?', syncOffer);
    assert(!!syncRow && !!syncRow.s3_etag && syncRow.s3_key === `${syncOffer}.zip`, 'syncFromStorage: зарегистрирована');
    const syncUploadRow = await modelsDb.get('SELECT * FROM offer_models WHERE offer_id = ?', TEST_OFFER);
    assert(syncUploadRow.uploaded_by === mod.id, 'syncFromStorage: uploaded_by сохранён');
    await ModelService.syncFromStorage();
    const syncCnt = await modelsDb.get('SELECT COUNT(*) AS c FROM offer_models WHERE offer_id = ?', syncOffer);
    assert(syncCnt.c === 1, 'syncFromStorage: идемпотентно');

    // 13. Out-of-band замена в S3
    await ModelService.issueForAssignment(
      `SMOKE-OOB-${stamp}`, emp.id, emp,
      { products: [{ name: 'Товар для out-of-band', offer_id: TEST_OFFER, quantity: 1 }] },
      { storeId: STORE_ID }
    );
    await new Promise((r) => setTimeout(r, 300));
    await ndb.run(`DELETE FROM notifications WHERE recipient_id = ? AND type = 'model_updated'`, emp.id);
    const oobBefore = await ModelService.getDownloadInfo(TEST_OFFER, { storeId: STORE_ID });
    const etagBefore = (await modelsDb.get('SELECT s3_etag FROM offer_models WHERE offer_id = ?', TEST_OFFER)).s3_etag;
    assert(!!etagBefore && fs.existsSync(oobBefore.path), 'OOB: версия известна, кэш прогрет');

    const newZip = buildZip([{ name: 'ARD000001-N.stl', content: 'updated stl data' }]);
    fakeS3Objects.set(`${TEST_OFFER}.zip`, newZip);

    const syncRes2 = await ModelService.syncFromStorage();
    assert(syncRes2.updated >= 1, `syncFromStorage: изменение обнаружено (updated=${syncRes2.updated})`);
    const etagAfter = (await modelsDb.get('SELECT s3_etag FROM offer_models WHERE offer_id = ?', TEST_OFFER)).s3_etag;
    assert(etagAfter !== etagBefore, 'OOB: версия обновилась');
    assert(!fs.existsSync(oobBefore.path), 'OOB: старый кэш сброшен');
    const oobNotifs = await ndb.all(
      `SELECT COUNT(*) AS c FROM notifications WHERE recipient_id = ? AND type = 'model_updated'`, emp.id
    );
    assert(oobNotifs[0].c > 0, 'OOB: сотруднику отправлено model_updated');
    const oobAfter = await ModelService.getDownloadInfo(TEST_OFFER, { storeId: STORE_ID });
    assert(fs.readFileSync(oobAfter.path).equals(newZip), 'OOB: скачивается актуальная версия');

    // 14. Список моделей
    const list = await ModelService.listModels();
    const listRow = list.find((m) => m.offer_id === TEST_OFFER);
    assert(!!listRow, 'listModels: модель есть');
    assert(!!listRow.s3_etag, 'listModels: ETag есть');
    assert(listRow.issued_count >= 1, `listModels: issued_count (${listRow.issued_count})`);
    assert(listRow.in_cache === true, 'listModels: in_cache=true');

    console.log(`\n=== Smoke-тест пройден ✅ (проверок: ${assertCount}) ===`);
  } catch (err) {
    console.error('=== Smoke-тест провален ❌ ===');
    console.error(err);
    process.exitCode = 1;
  } finally {
    try {
      await ndb.run(
        `DELETE FROM notifications WHERE recipient_id IN (?, ?, ?) OR payload LIKE '%${TEST_MARK}%'`,
        employee.id, moderator.id, stranger.id
      );
      await modelsDb.run(`DELETE FROM model_download_tokens WHERE offer_id LIKE '%${TEST_MARK}%'`);
      await modelsDb.run(`DELETE FROM issued_models WHERE offer_id LIKE '%${TEST_MARK}%'`);
      await modelsDb.run(`DELETE FROM offer_models WHERE offer_id LIKE '%${TEST_MARK}%'`);
      for (const id of [employee.id, moderator.id, stranger.id]) {
        if (!id) continue;
        await usersDb.run('DELETE FROM user_stores WHERE user_id = ?', id);
        await usersDb.run('DELETE FROM users WHERE id = ?', id);
      }
      const cacheFile = StorageService.cachePath(TEST_OFFER);
      if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
      console.log('Тестовые данные удалены');
    } catch (cleanupErr) {
      console.error('Ошибка очистки:', cleanupErr.message);
    }
    try { await closeNotificationsDB(); } catch { }
    try { await closeAll(); } catch { }
    cleanup();
  }
})();