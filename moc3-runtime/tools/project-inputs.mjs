import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const framework = path.join(root, 'vendor/cubism-framework');

export async function localInputs() {
  let config;
  try { config = JSON.parse(await readFile(path.join(root, 'config.local.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('本地配置无法解析');
    config = JSON.parse(await readFile(path.join(root, 'config.example.json'), 'utf8'));
  }
  if (typeof config.sdkDir !== 'string' || typeof config.modelDir !== 'string' || typeof config.modelSetting !== 'string') throw new Error('配置缺少 SDK 或模型路径');
  const sdk = path.resolve(root, config.sdkDir);
  const modelDir = path.resolve(root, config.modelDir);
  const source = await modelResource(modelDir, config.modelSetting);
  let setting;
  try { setting = JSON.parse(await readFile(source, 'utf8')); }
  catch { throw new Error('无法读取模型配置，请按 README 自行准备已授权模型'); }
  if (setting.Version !== 3 || !setting.FileReferences?.Moc || !Array.isArray(setting.FileReferences.Textures)) throw new Error('需要有效的 model3.json 配置');
  return { sdk, modelDir: path.dirname(source), setting };
}

// 保留相对路径，禁止路径穿越、远程 URL 以及指向输入目录之外的链接。
export async function modelResource(directory, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.includes('?') || name.includes('#') || path.isAbsolute(name) || name.split('/').some(part => part === '..' || part.startsWith('.'))) {
    throw new Error('模型资源路径必须是目录内部的相对路径');
  }
  try {
    const base = await realpath(directory);
    const target = await realpath(path.resolve(base, name));
    const relative = path.relative(base, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error();
    return target;
  } catch { throw new Error('模型资源不存在或超出输入目录，请检查本地配置'); }
}

export function companionResources(setting) {
  const refs = setting.FileReferences;
  return [...new Set([
    ...refs.Textures, refs.Physics, refs.Pose, refs.UserData,
    ...(refs.Expressions || []).map(entry => entry.File),
    ...Object.values(refs.Motions || {}).flatMap(entries => entries.flatMap(entry => [entry.File, entry.Sound]))
  ].filter(Boolean))];
}
