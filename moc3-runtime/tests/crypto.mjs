import { createDecipheriv, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { encryptModel } from '../tools/encrypt-model.mjs';

// 合成字节仅验证加密格式，不包含真实模型，也不能用于 Core 渲染。
const plain = Buffer.concat([Buffer.from('MOC3'), randomBytes(252)]);
const key = randomBytes(32);
const encrypted = encryptModel(plain, key);
function decrypt(bytes, secret) {
  const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(16, 28));
  decipher.setAAD(bytes.subarray(0, 32));
  decipher.setAuthTag(bytes.subarray(-16));
  const pending = decipher.update(bytes.subarray(32, -16));
  try { decipher.final(); return pending; }
  catch (error) { pending.fill(0); throw error; }
}
const result = decrypt(encrypted, key);
assert.deepEqual(result, plain);
result.fill(0);
assert.notDeepEqual(encryptModel(plain, key), encrypted);
for (const offset of [0, 8, 12, 16, 28, 32, encrypted.length - 1]) {
  const damaged = Buffer.from(encrypted);
  damaged[offset] ^= 1;
  assert.throws(() => decrypt(damaged, key));
}
assert.throws(() => decrypt(encrypted, randomBytes(32)));
assert.throws(() => decrypt(encrypted.subarray(0, encrypted.length - 1), key));
plain.fill(0);
key.fill(0);
console.log('离线加密测试通过：往返一致、随机 nonce、认证头/密文/标签篡改、错误密钥和截断拒绝。');
