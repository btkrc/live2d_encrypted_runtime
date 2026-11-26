import { readdir, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 只输出相对路径和问题类别，不输出匹配内容、凭据值或本机账户路径。
const workspace = fileURLToPath(new URL('../..', import.meta.url));
const issues = [];
let checked = 0;
const blockedDirectories = new Set(['.private', '.local', '.test', 'dist', 'reports', 'Core', 'encripy', 'init']);
const allowedHosts = ['live2d.com', 'live2d.jp', 'github.com', 'raw.githubusercontent.com', 'registry.npmjs.org', 'apache.org', 'localhost', '127.0.0.1', 'example.invalid', 'example.com', 'khronos.org', 'emscripten.org', 'w3.org', 'developer.mozilla.org'];
const add = (file, category) => issues.push({ 文件: file, 类别: category });
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const relative = path.relative(workspace, filename).split(path.sep).join('/');
    if (entry.name === '.git') continue;
    // npm 安装的第三方目录由锁文件及各包许可管理，不属于提交源文件。
    if (entry.name === 'node_modules') continue;
    if ((await lstat(filename)).isSymbolicLink()) { add(relative, '符号链接需要人工确认，未跟随'); continue; }
    if (entry.isDirectory()) {
      if (blockedDirectories.has(entry.name) || /^CubismSdkForWeb/i.test(entry.name) || /^(?:model|models)$/.test(relative)) {
        add(relative + '/', '仍存在私有输入、旧版组件或生成目录');
        continue;
      }
      await scan(filename);
      continue;
    }
    checked++;
    if (/\.(?:moc3?|enc|cache|key|pem|pfx|p12|png|jpe?g|webp|wasm|zip|7z|gz|tar|map|log|bak)$/i.test(entry.name) || /\.(?:model3|motion3|exp3|physics3|pose3|userdata3)\.json$/i.test(entry.name) || /^live2dcubismcore/i.test(entry.name) || /^(?:\.env(?:\..*)?|\.npmrc|config\.local\.json)$/.test(entry.name)) {
      add(relative, '模型、密钥、Core、敏感配置或打包产物');
      continue;
    }
    const data = await readFile(filename);
    if (data.subarray(0, 4).toString() === 'MOC3' || data.subarray(0, 7).toString() === 'L2DMOC3') add(relative, '检测到模型字节头');
    if (data.includes(0)) { add(relative, '未预期的二进制文件，需要人工检查'); continue; }
    const text = data.toString('utf8');
    if (/\b[A-Za-z]:[\\/]|\/(?:Users|home)\/[^\s/]+\//.test(text)) add(relative, '疑似本地绝对路径或账户目录');
    if (/["'][0-9a-f]{64}["']/i.test(text)) add(relative, '疑似内嵌 256 位密钥');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) || /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-proj-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/.test(text)) add(relative, '疑似私钥或访问令牌');
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`）)]+/g)) {
      // 测试服务端口使用模板表达式，只放行已知的本机模板前缀。
      if (/^https?:\/\/(?:127\.0\.0\.1|localhost):\$\{/.test(match[0])) continue;
      try {
        const url = new URL(match[0]);
        if (url.username || url.password) { add(relative, 'URL 中含访问凭据'); break; }
        if (!allowedHosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) { add(relative, '未列入公开引用清单的域名，需要人工确认'); break; }
      } catch { add(relative, '无法解析的 URL，需要人工确认'); break; }
    }
  }
}
await scan(workspace);
console.log(JSON.stringify({ 结果: issues.length ? '未通过' : '通过', 已检查文件: checked, 问题: issues, 边界: '跳过 Git 历史与 npm 安装目录；启发式扫描不能证明没有未知格式秘密' }, null, 2));
if (issues.length) process.exitCode = 1;
