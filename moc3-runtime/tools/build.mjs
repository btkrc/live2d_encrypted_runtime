import { build } from 'esbuild';
import { mkdir, copyFile, cp, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { encryptModel, readKey } from './encrypt-model.mjs';
import { root, framework, localInputs, modelResource, companionResources } from './project-inputs.mjs';

try {
  const { sdk, modelDir, setting } = await localInputs();
  const core = path.join(sdk, 'Core/live2dcubismcore.js');
  try { await access(core); }
  catch { throw new Error('缺少官方 Core，请按 README 从官方 SDK 获取并放入私有输入目录'); }
  const resources = companionResources(setting);
  const sources = await Promise.all(resources.map(async name => [name, await modelResource(modelDir, name)]));
  const mocSource = await modelResource(modelDir, setting.FileReferences.Moc);
  const plainOnly = process.argv.includes('--plain');
  const output = path.join(root, plainOnly ? '.test' : 'dist');
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error('生成目录非空，请先手动删除本项目的 .test 或 dist，再重新构建');
  await mkdir(path.join(output, 'model'), { recursive: true });
  for (const [name, source] of sources) {
    const target = path.join(output, 'model', name);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  const generated = structuredClone(setting);
  await copyFile(core, path.join(output, 'live2dcubismcore.js'));
  await cp(path.join(framework, 'Shaders/WebGL'), path.join(output, 'shaders'), { recursive: true });
  await mkdir(path.join(output, 'licenses'), { recursive: true });
  await copyFile(path.join(framework, 'LICENSE.md'), path.join(output, 'licenses/Framework-LICENSE.md'));
  await copyFile(path.join(root, 'THIRD_PARTY_NOTICES.txt'), path.join(output, 'licenses/THIRD_PARTY_NOTICES.txt'));
  for (const name of ['LICENSE.md', 'RedistributableFiles.txt']) {
    try { await copyFile(path.join(sdk, 'Core', name), path.join(output, 'licenses', 'Core-' + name)); }
    catch { throw new Error('缺少 Core 原始许可或再分发清单，请从官方 SDK 补齐'); }
  }
  let key;
  try {
    if (plainOnly) {
      generated.FileReferences.Moc = 'model.moc3';
      await copyFile(mocSource, path.join(output, 'model/model.moc3'));
    } else {
      await mkdir(path.join(root, '.local'), { recursive: true });
      const keyFile = path.join(root, '.local/model.key');
      key = randomBytes(32);
      try { await writeFile(keyFile, key.toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      key.fill(0);
      key = await readKey(keyFile);
      const plain = await readFile(mocSource);
      try { await writeFile(path.join(output, 'model/model.moc3.enc'), encryptModel(plain, key)); }
      finally { plain.fill(0); }
      generated.FileReferences.Moc = 'model.moc3.enc';
    }
    await writeFile(path.join(output, 'model/model.model3.json'), JSON.stringify(generated, null, 2));
    await build({
      absWorkingDir: root,
      entryPoints: [path.join(root, plainOnly ? 'src/plain-entry.js' : 'src/protected-entry.js')],
      outfile: path.join(output, plainOnly ? 'plain-runtime.js' : 'live2d-runtime.js'),
      bundle: true, format: 'iife', target: ['edge100', 'chrome100'], legalComments: 'inline', sourcemap: false,
      plugins: plainOnly ? [] : [{ name: '本地密钥导入', setup(context) {
        context.onResolve({ filter: /^model-key$/ }, () => ({ path: 'model-key', namespace: 'local-key' }));
        context.onLoad({ filter: /.*/, namespace: 'local-key' }, () => ({ contents: `export default '${key.toString('hex')}'`, loader: 'js' }));
      } }]
    });
  } finally { key?.fill(0); }
  await copyFile(path.join(root, plainOnly ? 'plain.html' : 'compat.html'), path.join(output, 'index.html'));
  if (!plainOnly) await copyFile(path.join(root, 'src/l2d_init.js'), path.join(output, 'l2d_init.js'));
  const original = await readFile(core), copied = await readFile(path.join(output, 'live2dcubismcore.js'));
  if (!original.equals(copied)) throw new Error('Core 原样复制检查失败');
  await writeFile(path.join(output, 'build-info.json'), JSON.stringify({
    coreSha256: createHash('sha256').update(original).digest('hex'),
    模式: plainOnly ? '本地明文基线' : '高层兼容模式；未实现底层内存直写',
    公开发布: '此目录包含用户资源、官方 Core，且加密构建内嵌本地密钥，不得作为公开源码提交'
  }, null, 2));
  console.log(plainOnly ? '本地明文基线已生成：.test/index.html' : '本地加密兼容测试已生成：dist/index.html。严格模式不降级；生成目录不能公开提交。');
} catch (error) {
  console.error(error.errors ? '编译失败，请检查 Framework 版本与源码兼容性' : error.message);
  process.exitCode = 1;
}
