import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { encryptModel, readKey } from '../tools/encrypt-model.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startServer } from '../tools/serve.mjs';
import { localInputs, modelResource } from '../tools/project-inputs.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const inputs = await localInputs();
const motionList = Object.entries(inputs.setting.FileReferences.Motions || {}).flatMap(([group, entries]) => entries.map((entry, index) => ({ group, index })));
const report = { 时间: new Date().toISOString(), 检查: [] };
const server = await startServer(0);
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  report.浏览器 = browser.version();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const address = `http://127.0.0.1:${server.address().port}/.test/index.html`;
  await page.goto(address);
  await page.waitForFunction(() => globalThis.L2Dwidget?.getStatus().frames > 10);
  const status = await page.evaluate(() => L2Dwidget.getStatus());
  assert.equal(status.motions, motionList.length);
  assert.equal(status.physics, !!inputs.setting.FileReferences.Physics);
  assert.ok(status.mocVersion > 0);
  assert.ok(status.drawables > 0);
  report.检查.push({ 项目: '用户提供模型的明文渲染、动作数量与物理配置', 结果: status });
  const pixelCount = () => new Promise(resolve => requestAnimationFrame(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let visible = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 20) visible++;
    resolve(visible);
  }));
  const visible = await page.evaluate(pixelCount);
  assert.ok(visible > 1000, '模型必须实际产生可见像素');
  report.检查.push({ 项目: '实际 WebGL 像素', 可见像素: visible });
  await mkdir(path.join(root, 'reports'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'reports/plain-edge.png') });
  for (const { group, index } of motionList) {
    assert.equal(await page.evaluate(({ group, index }) => L2Dwidget.playMotion(group, index), { group, index }), true);
    await page.waitForTimeout(100);
    assert.equal((await page.evaluate(() => L2Dwidget.getStatus())).motion, `${group}:${index}`);
  }
  report.检查.push({ 项目: '逐个播放用户配置的动作', 通过: true });
  await page.locator('canvas').tap({ force: true }).catch(async () => page.locator('canvas').click());
  assert.equal((await page.evaluate(() => L2Dwidget.getStatus())).destroyed, false);
  const api = await page.evaluate(() => ({ em: typeof globalThis._em, memory: Object.getOwnPropertyNames(Live2DCubismCore.Memory) }));
  assert.equal(api.em, 'undefined');
  report.检查.push({ 项目: '低层接口不可访问', 结果: api });
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => L2Dwidget.destroy());
    assert.equal(await page.locator('canvas').count(), 0);
    await page.evaluate(() => L2Dwidget.init(options));
    await page.waitForFunction(() => L2Dwidget.getStatus().frames > 2);
  }
  report.检查.push({ 项目: '连续初始化和销毁 5 次', 通过: true });
  const mobile = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(address);
  await mobilePage.waitForFunction(() => L2Dwidget.getStatus().frames > 5);
  await mobilePage.locator('canvas').tap({ position: { x: 200, y: 300 } });
  await mobilePage.screenshot({ path: path.join(root, 'reports/plain-mobile-emulation.png') });
  assert.ok(await mobilePage.evaluate(pixelCount) > 1000);
  report.检查.push({ 项目: '移动视口与触摸模拟', 通过: true, 限制: 'Windows Edge 模拟，非 Android 真机' });
  await mobile.close();
  await page.evaluate(() => L2Dwidget.destroy());
  await page.evaluate(() => {
    const counts = { moc创建: 0, moc释放: 0, 模型创建: 0, 模型释放: 0 };
    const mocCreate = Live2DCubismCore.Moc.fromArrayBuffer;
    const mocRelease = Live2DCubismCore.Moc.prototype._release;
    const modelCreate = Live2DCubismCore.Model.fromMoc;
    const modelRelease = Live2DCubismCore.Model.prototype.release;
    Live2DCubismCore.Moc.fromArrayBuffer = function (buffer) { const moc = mocCreate.call(this, buffer); if (moc) counts.moc创建++; return moc; };
    Live2DCubismCore.Moc.prototype._release = function () { if (this._ptr) counts.moc释放++; return mocRelease.call(this); };
    Live2DCubismCore.Model.fromMoc = function (moc) { const model = modelCreate.call(this, moc); if (model) counts.模型创建++; return model; };
    Live2DCubismCore.Model.prototype.release = function () { if (this._ptr) counts.模型释放++; return modelRelease.call(this); };
    globalThis.testCounts = () => ({ ...counts });
  });
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => L2Dwidget.init(options));
    await page.waitForFunction(() => L2Dwidget.getStatus().frames > 1);
    await page.evaluate(() => L2Dwidget.destroy());
  }
  const failurePath = inputs.setting.FileReferences.Physics || inputs.setting.FileReferences.Textures[0];
  const failureUrl = new URL('model/' + failurePath, address).href;
  await page.route(failureUrl, route => route.fulfill({ status: 500, body: '测试加载失败' }));
  const failure = await page.evaluate(async () => { try { await L2Dwidget.init(options); return ''; } catch (error) { return error.message; } });
  assert.match(failure, /500/);
  assert.equal(await page.locator('canvas').count(), 0);
  await page.unroute(failureUrl);
  const cancelled = await page.evaluate(async () => {
    const load = L2Dwidget.init(options).catch(error => error.name);
    await L2Dwidget.destroy();
    return await load;
  });
  assert.equal(cancelled, 'AbortError');
  const counts = await page.evaluate(() => testCounts());
  assert.equal(counts.moc创建, counts.moc释放);
  assert.equal(counts.模型创建, counts.模型释放);
  report.检查.push({ 项目: '正常、加载异常与取消路径 Core 创建释放计数', 结果: counts, 限制: '计数平衡不能证明 Core 内部没有内存泄漏' });
  // 预期的 500 已单独断言；其他错误仍视为失败。
  const unexpected = errors.filter(message => !message.includes('500 (Internal Server Error)'));
  assert.deepEqual(unexpected, []);
  report.检查.push({ 项目: '意外控制台与页面错误', 结果: unexpected });
  const protectedPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const protectedErrors = [];
  protectedPage.on('pageerror', error => protectedErrors.push(error.message));
  protectedPage.on('console', message => { if (message.type() === 'error') protectedErrors.push(message.text()); });
  const protectedUrl = address.replace('/.test/index.html', '/dist/index.html');
  await protectedPage.goto(protectedUrl);
  await protectedPage.waitForFunction(() => L2Dwidget.getStatus().frames > 5);
  assert.ok(await protectedPage.evaluate(pixelCount) > 1000);
  await protectedPage.screenshot({ path: path.join(root, 'reports/encrypted-edge.png') });
  await protectedPage.evaluate(() => L2Dwidget.destroy());
  await protectedPage.evaluate(() => {
    const original = Live2DCubismCore.Moc.fromArrayBuffer;
    const createModel = Live2DCubismCore.Model.fromMoc;
    let calls = 0, plaintext = null, zeroBeforeModel = false;
    Live2DCubismCore.Moc.fromArrayBuffer = function (buffer) { calls++; plaintext = new Uint8Array(buffer); return original.call(this, buffer); };
    Live2DCubismCore.Model.fromMoc = function (moc) {
      zeroBeforeModel = plaintext?.every(value => value === 0) ?? false;
      plaintext = null;
      return createModel.call(this, moc);
    };
    globalThis.protectedCounters = () => ({ calls, zeroBeforeModel });
  });
  const strict = await protectedPage.evaluate(async () => {
    try { await L2Dwidget.init({ ...options, model: { ...options.model, allowHighLevel: false } }); return ''; }
    catch (error) { return error.message; }
  });
  assert.match(strict, /严格加载不可用/);
  assert.equal(await protectedPage.locator('canvas').count(), 0);
  assert.equal((await protectedPage.evaluate(() => protectedCounters())).calls, 0);
  await protectedPage.evaluate(() => L2Dwidget.init(options));
  await protectedPage.waitForFunction(() => L2Dwidget.getStatus().frames > 2);
  const counters = await protectedPage.evaluate(() => protectedCounters());
  assert.equal(counters.calls, 1);
  assert.equal(counters.zeroBeforeModel, true);
  report.检查.push({ 项目: '加密兼容路径与严格模式', 结果: counters, 结论: '兼容模式确实调用高层入口一次；JS 明文在 Model.fromMoc 前已清零；严格模式拒绝调用' });
  await protectedPage.evaluate(() => L2Dwidget.destroy());
  const cipher = await readFile(path.join(root, 'dist/model/model.moc3.enc'));
  const key = await readKey(path.join(root, '.local/model.key'));
  const badMoc = await readFile(await modelResource(inputs.modelDir, inputs.setting.FileReferences.Moc));
  badMoc[4] = 0;
  const badCipher = encryptModel(badMoc, key);
  badMoc.fill(0); key.fill(0);
  const tampered = Buffer.from(cipher); tampered[60] ^= 1;
  const wrongKey = randomBytes(32);
  const sourceMoc = await readFile(await modelResource(inputs.modelDir, inputs.setting.FileReferences.Moc));
  const wrongCipher = encryptModel(sourceMoc, wrongKey);
  sourceMoc.fill(0); wrongKey.fill(0);
  for (const [name, bytes] of [['密文篡改', tampered], ['错误密钥', wrongCipher], ['文件截断', cipher.subarray(0, 100)], ['已认证但损坏的 MOC3', badCipher]]) {
    await protectedPage.route('**/model.moc3.enc', route => route.fulfill({ body: bytes, contentType: 'application/octet-stream' }));
    const message = await protectedPage.evaluate(async () => { try { await L2Dwidget.init(options); return ''; } catch (error) { return error.message; } });
    assert.ok(message, name);
    assert.equal(await protectedPage.locator('canvas').count(), 0);
    assert.equal((await protectedPage.evaluate(() => protectedCounters())).calls, 1);
    await protectedPage.unroute('**/model.moc3.enc');
    report.检查.push({ 项目: name, 结果: message, 初始化前拒绝: true });
  }
  // 原模型没有独立表情；通过本地测试夹具验证官方表情播放与释放路径。
  const setting = JSON.parse(await readFile(path.join(root, 'dist/model/model.model3.json'), 'utf8'));
  setting.FileReferences.Expressions = [{ Name: '测试微笑', File: 'fixture.exp3.json' }];
  await protectedPage.route('**/model.model3.json', route => route.fulfill({ json: setting }));
  await protectedPage.route('**/fixture.exp3.json', route => route.fulfill({ json: {
    Type: 'Live2D Expression', FadeInTime: 0.2, FadeOutTime: 0.2,
    Parameters: [{ Id: 'ParamMouthForm', Value: 0.8, Blend: 'Overwrite' }]
  } }));
  await protectedPage.evaluate(() => L2Dwidget.init(options));
  assert.equal(await protectedPage.evaluate(() => L2Dwidget.setExpression('测试微笑')), true);
  await protectedPage.waitForTimeout(500);
  assert.equal((await protectedPage.evaluate(() => L2Dwidget.getStatus())).expressions, 1);
  await protectedPage.evaluate(() => L2Dwidget.destroy());
  await protectedPage.unroute('**/model.model3.json');
  await protectedPage.unroute('**/fixture.exp3.json');
  report.检查.push({ 项目: '表情测试夹具', 通过: true, 限制: '原始资源不包含表情文件，测试夹具不进入部署目录' });
  const cdn = protectedUrl.slice(0, protectedUrl.lastIndexOf('/') + 1);
  const externalHtml = (await readFile(path.join(root, 'dist/index.html'), 'utf8')).replace('src="live2dcubismcore.js"', `crossorigin="anonymous" src="${cdn}live2dcubismcore.js"`).replace('src="live2d-runtime.js"', `crossorigin="anonymous" src="${cdn}live2d-runtime.js"`);
  const crossOriginUrl = protectedUrl.replace('127.0.0.1', 'localhost');
  await protectedPage.route(crossOriginUrl, route => route.fulfill({ body: externalHtml, contentType: 'text/html' }));
  await protectedPage.goto(crossOriginUrl);
  await protectedPage.waitForFunction(() => L2Dwidget.getStatus().frames > 5);
  assert.ok(await protectedPage.evaluate(pixelCount) > 1000);
  report.检查.push({ 项目: '不同域名下运行库、模型、贴图及着色器跨域加载', 通过: true, 限制: '本机双域名测试，未发布至真实 HTTPS CDN' });
  await protectedPage.evaluate(() => L2Dwidget.destroy());
  const pwaUrl = address.replace('/.test/index.html', '/.test/pwa.html');
  await writeFile(path.join(root, '.test/pwa.html'), externalHtml.replace('<title>', '<link rel="manifest" href="./test.webmanifest"><title>').replace('</html>', `<script>navigator.serviceWorker.register('./sw.js');</script></html>`));
  await writeFile(path.join(root, '.test/test.webmanifest'), JSON.stringify({ name: 'Live2D 离线测试', short_name: '模型测试', start_url: './pwa.html', display: 'standalone', lang: 'zh-CN' }));
  await writeFile(path.join(root, '.test/sw.js'), `
// 仅用于测试 Service Worker 环境，不属于部署运行库。
const cacheName='moc3-runtime-test-v1';
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  event.respondWith(caches.open(cacheName).then(async cache=>{
    const stored=await cache.match(event.request);
    if(stored)return stored;
    const response=await fetch(event.request);
    if(response.ok)await cache.put(event.request,response.clone());
    return response;
  }));
});
`);
  const pwa = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const pwaPage = await pwa.newPage();
  await pwaPage.goto(pwaUrl);
  await pwaPage.waitForFunction(() => !!navigator.serviceWorker.controller && L2Dwidget.getStatus().frames > 3);
  await pwaPage.reload();
  await pwaPage.waitForFunction(() => L2Dwidget.getStatus().frames > 5);
  await pwa.setOffline(true);
  await pwaPage.reload();
  await pwaPage.waitForFunction(() => L2Dwidget.getStatus().frames > 5);
  assert.ok(await pwaPage.evaluate(pixelCount) > 1000);
  report.检查.push({ 项目: 'Service Worker 缓存后的离线页面、解密与渲染', 通过: true, 限制: '桌面浏览器测试；未验证 Android 安装与系统 PWA 生命周期' });
  await pwaPage.evaluate(async () => { await L2Dwidget.destroy(); for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister(); for (const name of await caches.keys()) await caches.delete(name); });
  await pwa.close();
  assert.deepEqual(protectedErrors, []);
  const files = await readdir(path.join(root, 'dist/model'));
  assert.ok(!files.some(name => name.endsWith('.moc3')));
  report.检查.push({ 项目: '部署目录不含原始 MOC3', 通过: true });
  report.通过 = true;
} catch (error) {
  report.通过 = false;
  report.错误 = error.name + '：本地验证失败；避免将原始路径及资源信息写入可分享日志';
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await mkdir(path.join(root, 'reports'), { recursive: true });
  await writeFile(path.join(root, 'reports/browser-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
