import assert from 'node:assert/strict';
import { modelResource, localInputs, companionResources } from '../tools/project-inputs.mjs';
import { startServer } from '../tools/serve.mjs';

// 此检查只测试用户自行准备的输入及本地服务边界，不内置任何模型或凭据。
const inputs = await localInputs();
assert.ok(companionResources(inputs.setting).length >= 1);
for (const name of ['../outside.moc3', '/absolute.moc3', 'https://example.invalid/model.moc3', '.hidden/model.moc3']) {
  await assert.rejects(modelResource(inputs.modelDir, name));
}
const server = await startServer(0);
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['/.private/sdk/Core/live2dcubismcore.js', '/.local/model.key', '/config.local.json', '/src/widget.js', '/vendor/cubism-framework/LICENSE.md', '/.test/%2e%2e/.local/model.key']) {
    assert.equal((await fetch(base + name)).status, 404);
  }
  assert.equal((await fetch(base + '/dist/')).status, 200);
  assert.equal((await fetch(base + '/.test/')).status, 200);
} finally { await new Promise(resolve => server.close(resolve)); }
console.log('本地输入路径及测试服务访问边界检查通过。');
