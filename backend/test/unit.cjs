const {test}=require('node:test');const assert=require('node:assert/strict');const {parseConfig}=require('../dist/config');const {encrypt,decrypt,csvCell,money}=require('../dist/security');const {DisabledAdapter}=require('../dist/payments/adapters');
const base={APP_ENV:'local',PAYMENT_MODE:'mock',DATABASE_URL:'postgresql://a:b@localhost/test',PUBLIC_ORIGIN:'http://localhost:3000',SESSION_SECRET:'a'.repeat(32),MOCK_SIGNING_KEY:'b'.repeat(32),ADMIN_ENCRYPTION_KEY:'c'.repeat(64),TEST_ACCESS_PASSWORD:'d'.repeat(20),STORAGE_ROOT:'./storage',MAIL_TRANSPORT:'outbox',MAIL_FROM:'test@example.test'};
const chineseProduct = () => ({ titleZh: '中文模板', descriptionZh: '中文说明', metadata: { slides: 5, ratio: '16:9', software: 'PowerPoint', editable: '文字可编辑', fonts: '思源黑体', images: '图片可替换', license: '个人使用' } });
test('RMB reporting converts foreign minor units with exact rounding and rejects missing rates', () => {
    const { cnyMinor } = require('../../packages/contracts/cny.cjs');
    assert.equal(cnyMinor(12345, 'CNY', undefined, 2), 12345);
    assert.equal(cnyMinor(1400, 'USD', '0.14', 2), 10000);
    assert.equal(cnyMinor(2100, 'JPY', '21', 0), 10000);
    assert.equal(cnyMinor(500, 'KWD', '0.05', 3), 1000);
    assert.equal(cnyMinor(1, 'USD', '0.16', 2), 6);
    assert.equal(cnyMinor(0, 'USD', '0.14', 2), 0);
    assert.equal(cnyMinor(100, 'USD', undefined, 2), null);
    assert.equal(cnyMinor(100, 'USD', '0', 2), null);
});
test('Missing English title retains the configured Chinese filename instead of template.pptx', () => {
    const { purchaseFilename } = require('../dist/storage/local');
    const item = { snapshot: { titleZh: '节能减排', titleEn: '', translations: { en: {} } } };
    assert.equal(purchaseFilename({ language: 'en', item }), '节能减排.pptx');
    item.snapshot.translations.en.title = 'Energy Conservation and Emission Reduction';
    assert.equal(purchaseFilename({ language: 'en', item }), 'Energy Conservation and Emission Reduction.pptx');
    assert.equal(purchaseFilename({ language: 'zh', item }), '节能减排.pptx');
});
test('A missing purchase title is translated when a provider is available, with a Chinese fallback otherwise', async () => {
    const { service, calls } = contentTranslator();
    assert.equal(await service.purchaseTitle(chineseProduct(), 'en'), 'en: 中文模板');
    assert.equal(calls.length, 1);
    assert.equal(await service.purchaseTitle({ ...chineseProduct(), titleEn: 'Existing title' }, 'en'), undefined);
    service.translator.configured = async () => false;
    assert.equal(await service.purchaseTitle(chineseProduct(), 'en'), undefined);
});
function contentTranslator(available = true) {
    const { ContentTranslation } = require('../dist/commerce/content');
    const service = new ContentTranslation({}), calls = [];
    service.translator.configured = async () => available;
    service.translator.translate = async (text, language) => { calls.push({ text, language }); return { status: 'ready', text: `${language}: ${text}` }; };
    return { service, calls };
}
test('Chinese-only product and category generate all 13 languages without copying Chinese into English', async () => {
    const { service, calls } = contentTranslator(), { LANGUAGES } = require('../dist/commerce/constants');
    const product = await service.product(chineseProduct()), category = await service.category({ nameZh: '商业模板' });
    assert.equal(product.warning, undefined); assert.equal(calls.length, 84);
    for (const language of LANGUAGES) {
        assert.ok(product.data.translations[language].title);
        assert.ok(product.data.translations[language].description);
        for (const key of ['editable', 'fonts', 'images', 'license']) assert.ok(product.data.translations[language].metadata[key]);
        assert.ok(category.data.translations[language]);
    }
    assert.equal(product.data.titleEn, 'en: 中文模板'); assert.equal(category.data.nameEn, 'en: 商业模板');
    require('../dist/commerce/content').requireTranslations(product.data, category.data);
});
test('Chinese edits refresh only changed translated fields; unchanged saves make no requests', async () => {
    const { service, calls } = contentTranslator(), first = (await service.product(chineseProduct())).data;
    calls.length = 0;
    const unchanged = await service.product(chineseProduct(), first); assert.equal(calls.length, 0);
    const changed = await service.product({ ...chineseProduct(), titleZh: '新标题', metadata: { ...first.metadata, license: '商业使用' } }, unchanged.data);
    assert.equal(calls.length, 24); assert.equal(changed.data.titleEn, 'en: 新标题');
    assert.equal(changed.data.translations.ja.metadata.license, 'ja: 商业使用');
    assert.equal(changed.data.translations.fr.description, first.translations.fr.description);
    const category = (await service.category({ nameZh: '旧分类' })).data;
    calls.length = 0; const renamed = await service.category({ nameZh: '新分类' }, category);
    assert.equal(calls.length, 12); assert.equal(renamed.data.nameEn, 'en: 新分类');
});
test('Unavailable service keeps Chinese drafts, clears stale translations, allows Chinese publication and can retry', async () => {
    const { service } = contentTranslator(), original = (await service.product(chineseProduct())).data;
    service.translator.configured = async () => false;
    const draft = await service.product({ ...chineseProduct(), titleZh: '新名称' }, original);
    assert.equal(draft.warning, 'TRANSLATION_NOT_CONFIGURED'); assert.equal(draft.data.titleZh, '新名称'); assert.equal(draft.data.titleEn, '');
    assert.equal(draft.data.translations.en.title, undefined);
    const { requireTranslations } = require('../dist/commerce/content');
    assert.doesNotThrow(() => requireTranslations(draft.data, { nameZh: '中文分类' }));
    service.translator.configured = async () => true;
    service.translator.translate = async (text, language) => language === 'ja' ? { status: 'unavailable' } : { status: 'ready', text: `${language}: ${text}` };
    const failed = await service.product(draft.data, draft.data); assert.equal(failed.warning, 'TRANSLATION_UNAVAILABLE');
    assert.equal(failed.data.translations.ja.title, undefined);
    service.translator.translate = async (text, language) => ({ status: 'ready', text: `${language}: ${text}` });
    const retried = await service.product(failed.data, failed.data); assert.equal(retried.warning, undefined); assert.equal(retried.data.translations.ja.title, 'ja: 新名称');
});
test('T30 production cannot run mock payments',()=>assert.throws(()=>parseConfig({...base,APP_ENV:'production'}),/forbids/));
test('T31 real channels cannot be enabled; placeholders never succeed',async()=>{assert.throws(()=>parseConfig({...base,LIVE_PROVIDERS:'paypal'}),/not implemented/);for(const name of ['alipay','wechat','paypal']){const adapter=new DisabledAdapter(name);assert.equal(adapter.getCapabilities().enabled,false);for(const method of ['createCheckout','confirmPayment','queryPayment','refund','queryRefund'])await assert.rejects(()=>adapter[method]({}),/not implemented/);}});
test('configuration rejects missing secrets without revealing values',()=>{assert.throws(()=>parseConfig({...base,SESSION_SECRET:'bad'}),/SESSION_SECRET/);assert.throws(()=>parseConfig({...base,STORE_ACCESS_MODE:'password',TEST_ACCESS_PASSWORD:undefined}),/access password/);assert.equal(parseConfig({...base,TEST_ACCESS_PASSWORD:undefined}).STORE_ACCESS_MODE,'account');});
test('development bypass is opt-in and cannot start outside local mock loopback mode',()=>{assert.equal(parseConfig(base).DEV_AUTH_BYPASS,false);assert.equal(parseConfig({...base,DEV_AUTH_BYPASS:'true'}).DEV_AUTH_BYPASS,true);for(const extra of [{APP_ENV:'staging'},{APP_ENV:'production'},{PAYMENT_MODE:'live'},{PUBLIC_ORIGIN:'https://store.example.com'}])assert.throws(()=>parseConfig({...base,...extra,DEV_AUTH_BYPASS:'true'}),/Development login bypass/);});
test('development session cookies lose access when bypass is disabled',async()=>{const {Auth}=require('../dist/modules/auth');const config=parseConfig(base),db={session:{findUnique:async()=>({kind:'DEV_ADMIN',expiresAt:new Date(Date.now()+10000),admin:{role:'ADMIN'}})}},auth=new Auth(db,config),req={cookies:{admin:'development-cookie'}};await auth.load(req);assert.equal(req.admin,null);config.DEV_AUTH_BYPASS=true;await auth.load(req);assert.equal(req.admin.kind,'DEV_ADMIN');config.DEV_AUTH_BYPASS=false;await auth.load(req);assert.equal(req.admin,null);});
test('admin TOTP encryption is authenticated',()=>{const cipher=encrypt('ABCDEF',base.ADMIN_ENCRYPTION_KEY);assert.equal(decrypt(cipher,base.ADMIN_ENCRYPTION_KEY),'ABCDEF');assert.throws(()=>decrypt(cipher,'d'.repeat(64)));});
test('T28 spreadsheet formula injection and escaping',()=>{for(const value of ['=1+1','+cmd','@SUM(1)','-1','  =SUM(2)'])assert.match(csvCell(value),/^"'/);assert.equal(csvCell('a"b'),'"a""b"');});
test('T29 currency precision uses explicit rules',()=>{assert.equal(money(2900,'CNY'),'29.00');assert.equal(money(900,'USD'),'9.00');assert.equal(money(900,'JPY'),'900');assert.throws(()=>money(1.1,'USD'));});
test('U07 decimal reference rates round with integer arithmetic',()=>{const {convertMinor}=require('../dist/commerce/fx');assert.equal(convertMinor(3500,'0.14925','USD'),522);assert.equal(convertMinor(3500,'23.575','JPY'),825);assert.equal(convertMinor(2900,'200.99','KRW'),5829);assert.equal(convertMinor(1,'1.5','USD'),2);assert.throws(()=>convertMinor(1,'0','USD'));assert.throws(()=>convertMinor(1.1,'1','USD'));assert.throws(()=>convertMinor(1,'1','UNKNOWN'));});
test('U08 title file names and private storage reject traversal',()=>{const {titleFilename,LocalStorage}=require('../dist/storage/local');assert.equal(titleFilename('品牌/提案:*?'),'品牌_提案___.pptx');assert.equal(titleFilename('CON'),'template_CON.pptx');const storage=new LocalStorage(require('node:path').resolve('test-private'));for(const key of ['../../secret.pptx','purchased/00000000-0000-4000-8000-000000000000/../secret.pptx','purchased/00000000-0000-4000-8000-000000000000/1.0/../../secret.pptx'])assert.throws(()=>storage.resolve(key));});
test('U09 all interface dictionaries have the same complete 13-language keys',()=>{const {dictionaries}=require('../dist/commerce/dictionaries'),{LANGUAGES}=require('../dist/commerce/constants');assert.equal(LANGUAGES.length,13);const keys=Object.keys(dictionaries.en);assert.ok(keys.length>200);for(const l of LANGUAGES){assert.deepEqual(Object.keys(dictionaries[l]),keys);for(const k of keys)assert.ok(dictionaries[l][k]?.length);}});
test('N06 authenticated SMTP requires a credential pair and TLS',()=>{assert.throws(()=>parseConfig({...base,SMTP_USER:'sender@example.test'}),/configured together/);assert.throws(()=>parseConfig({...base,SMTP_USER:'sender@example.test',SMTP_PASSWORD:'example-auth-code'}),/requires TLS/);const c=parseConfig({...base,SMTP_USER:'sender@example.test',SMTP_PASSWORD:'example-auth-code',SMTP_SECURE:'true'});assert.equal(c.SMTP_SECURE,true);assert.equal(c.OWNER_REFUND_EMAIL,'2797687455@qq.com');assert.equal(c.OWNER_PURCHASE_EMAIL,'Gowdybunde@gmail.com');assert.equal(c.FX_AUTOMATIC_REFRESH,true);});
test('real registration blocks capture mode before creating an account or queueing mail',async()=>{const {AccountController}=require('../dist/commerce/accounts');let touched=false;const controller=new AccountController({config:parseConfig({...base,ACCOUNT_REQUIRE_SMTP:'true'}),db:{$transaction:()=>{touched=true;}}},{rate:()=>{touched=true;}});await assert.rejects(()=>controller.register({}, {}, {}),e=>e.getResponse().code==='MAIL_NOT_CONFIGURED');await assert.rejects(()=>controller.resend({}),e=>e.getResponse().code==='MAIL_NOT_CONFIGURED');await assert.rejects(()=>controller.request({},{}),e=>e.getResponse().code==='MAIL_NOT_CONFIGURED');assert.equal(touched,false);controller.shop.config=parseConfig({...base,MAIL_TRANSPORT:'smtp',SMTP_HOST:'smtp.example.com',SMTP_PORT:'465',SMTP_SECURE:'true',SMTP_USER:'sender@example.com',SMTP_PASSWORD:'test-authorization',MAIL_FROM:'sender@example.com',ACCOUNT_REQUIRE_SMTP:'true'});assert.doesNotThrow(()=>controller.requireMail());});
test('N07 filename comes from frozen purchase language, with safe path characters',()=>{const {purchaseFilename,LocalStorage}=require('../dist/storage/local');const o={language:'en',item:{snapshot:{titleZh:'中文标题',translations:{en:{title:'My / purchase'},ja:{title:'購入タイトル'}}}}};assert.equal(purchaseFilename(o),'My _ purchase.pptx');o.language='ja';assert.equal(purchaseFilename(o),'購入タイトル.pptx');const storage=new LocalStorage(require('node:path').resolve('test-private'));assert.match(storage.resolve('catalog/商业提案/商品标题.pptx'),/商业提案/);for(const key of ['catalog/../file.pptx','catalog/CON/file.pptx','catalog/分类/../../outside.pptx','history/../file.pptx'])assert.throws(()=>storage.resolve(key));});
test('U12 reference date freshness rejects recently fetched obsolete rates',async()=>{const {FxService}=require('../dist/commerce/fx'),{CURRENCIES}=require('../dist/commerce/constants');const old={base:'CNY',fetchedAt:new Date(Date.now()-3600000),rates:Object.fromEntries(CURRENCIES.map(c=>[c,{rate:'1',date:new Date(Date.now()-8*86400000).toISOString().slice(0,10)}]))},service=new FxService({fxSnapshot:{findFirst:async()=>old}}),original=global.fetch;try{global.fetch=async()=>({ok:false});await assert.rejects(()=>service.latest(),e=>e.getResponse().code==='FX_UNAVAILABLE');for(const value of Object.values(old.rates))value.date=new Date().toISOString().slice(0,10);assert.equal(await service.latest(),old);await assert.rejects(()=>service.latest(true),e=>e.getResponse().code==='FX_UNAVAILABLE');}finally{global.fetch=original;}});

test('constant-time comparison handles Unicode byte lengths safely',()=>{const {same}=require('../dist/security');assert.equal(same('?','ab'),false);assert.equal(same('?','?'),true);assert.equal(same('ab','ac'),false);});
test('unknown, disabled and wrong-password identities produce the same denial',async()=>{const {Auth}=require('../dist/modules/auth'),argon2=require('argon2');const auth=new Auth({},parseConfig(base)),account={email:'valid@example.test',passwordHash:await argon2.hash('valid-local-password')};assert.equal(await auth.validPassword(null,'valid-local-password'),false);assert.equal(await auth.validPassword({...account,disabled:true},'valid-local-password'),false);assert.equal(await auth.validPassword(account,'wrong-password'),false);assert.equal(await auth.validPassword(account,'valid-local-password'),true);for(const identity of [null,{...account,disabled:true},account])await assert.rejects(()=>auth.verifyAdmin(identity,'wrong-password','123456'),e=>e.getStatus()===401&&e.getResponse().code==='INVALID_CREDENTIALS');});
test('rate limiter returns HTTP 429 rather than a permission failure',async()=>{const {Auth}=require('../dist/modules/auth');const auth=new Auth({$queryRaw:async()=>[{count:9}]},parseConfig(base));await assert.rejects(()=>auth.rate({ip:'127.0.0.1'},'login',8),e=>e.getStatus()===429&&e.getResponse().code==='RATE_LIMITED');});

test('oversized product uploads are refused before decompressing untrusted bytes',async()=>{const {validateUpload}=require('../dist/storage/local');await assert.rejects(()=>validateUpload({buffer:Buffer.from('invalid'),originalname:'oversized.pptx',mimetype:'application/vnd.openxmlformats-officedocument.presentationml.presentation',size:1024*1024*1024+1},'original'),e=>e.getResponse().code==='FILE_TOO_LARGE');});

test('all upload types share the 1 GiB ceiling, including exact-boundary acceptance',async()=>{const {MAX_UPLOAD_BYTES,MAX_MULTIPART_BYTES}=require('../dist/storage/upload-limits');const {MAX_ATTACHMENT_BYTES}=require('../dist/commerce/messaging');const {validateUpload}=require('../dist/storage/local');assert.equal(MAX_UPLOAD_BYTES,1073741824);assert.equal(MAX_ATTACHMENT_BYTES,MAX_UPLOAD_BYTES);assert.equal(MAX_MULTIPART_BYTES,MAX_UPLOAD_BYTES+1048576);for(const kind of ['original','preview']){await assert.rejects(()=>validateUpload({buffer:Buffer.from('invalid'),originalname:kind==='original'?'deck.pptx':'image.png',mimetype:kind==='original'?'application/vnd.openxmlformats-officedocument.presentationml.presentation':'image/png',size:MAX_UPLOAD_BYTES+1},kind),e=>e.getResponse().code==='FILE_TOO_LARGE');await assert.rejects(()=>validateUpload({buffer:Buffer.from('invalid'),originalname:kind==='original'?'deck.pptx':'image.png',mimetype:kind==='original'?'application/vnd.openxmlformats-officedocument.presentationml.presentation':'image/png',size:MAX_UPLOAD_BYTES},kind),e=>e.getResponse().code!=='FILE_TOO_LARGE');}});
