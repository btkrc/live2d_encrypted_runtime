import http from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('..', import.meta.url));
const types = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
export function startServer(port = 4173) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const parts = pathname.split('/').filter(Boolean);
      if (!['dist', '.test'].includes(parts[0]) || parts.slice(1).some(part => part.startsWith('.') || part.includes('\\'))) throw new Error('路径不可访问');
      let target = await realpath(path.resolve(workspace, '.' + pathname));
      if ((await stat(target)).isDirectory()) target = await realpath(path.join(target, 'index.html'));
      const relative = path.relative(workspace, target);
      if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep)[0] !== parts[0]) throw new Error('路径不可访问');
      const data = await readFile(target);
      response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
      response.end(data);
    } catch { response.writeHead(404); response.end('资源不存在'); }
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server)); });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startServer(Number(process.env.PORT || 4173));
  console.log(`本地测试：http://127.0.0.1:${server.address().port}/.test/index.html`);
}
