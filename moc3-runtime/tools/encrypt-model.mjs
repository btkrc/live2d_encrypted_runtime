import { createCipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 文件布局：32 字节认证头、等长密文、16 字节 GCM 标签。
// 认证头：8 字节标识、LE32 版本、LE32 明文长度、12 字节随机 nonce、4 字节保留零。
export function encryptModel(plain, key) {
  if (key.length !== 32) throw new Error('密钥必须为 32 字节');
  if (plain.length < 64 || plain.length > 64 * 1024 * 1024 || plain.toString('ascii', 0, 4) !== 'MOC3') {
    throw new Error('输入必须是有效大小的原始 MOC3 文件');
  }
  const header = Buffer.alloc(32);
  Buffer.from('L2DMOC3\0', 'ascii').copy(header);
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(plain.length, 12);
  randomBytes(12).copy(header, 16);
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(16, 28));
  cipher.setAAD(header);
  return Buffer.concat([header, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export async function readKey(filename) {
  const text = (await readFile(filename, 'utf8')).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new Error('密钥文件必须包含 64 位十六进制文本');
  return Buffer.from(text, 'hex');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let plain, key;
  try {
    const { values } = parseArgs({ options: {
      input: { type: 'string' }, output: { type: 'string' },
      'key-file': { type: 'string' }, 'generate-key': { type: 'string' }
    } });
    if (values['generate-key']) {
      if (values.input || values.output || values['key-file']) throw new Error('生成密钥时请单独执行');
      const target = path.resolve(values['generate-key']);
      await mkdir(path.dirname(target), { recursive: true });
      key = randomBytes(32);
      await writeFile(target, key.toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
      console.log('密钥已生成，请勿上传密钥文件。');
    } else {
      if (!values.input || !values.output || !values['key-file']) throw new Error('需要 --input、--output 和 --key-file，或单独使用 --generate-key');
      plain = await readFile(values.input);
      key = await readKey(values['key-file']);
      const encrypted = encryptModel(plain, key);
      await writeFile(values.output, encrypted, { flag: 'wx' });
      console.log(`模型加密完成，密文大小：${encrypted.length} 字节。`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { plain?.fill(0); key?.fill(0); }
}
