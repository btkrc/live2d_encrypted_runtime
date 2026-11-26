import keyHex from 'model-key';

// 密钥导入、解密、明文检查、官方入口调用均留在此函数作用域。
// 当前 SDK 未公开分配/原地复活接口；严格模式禁止隐式降级。
export async function loadProtectedModel(url, fetchBuffer, signal, options) {
  if (options.allowHighLevel !== true) {
    throw new Error('当前 Core 未公开底层内存接口，严格加载不可用。兼容模式需显式设置 model.allowHighLevel=true；该模式会传递完整明文至 Moc.fromArrayBuffer。');
  }
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) throw new Error('模型解密需要 HTTPS 或 localhost 安全上下文');
  let plain, keyBytes, moc, model;
  try {
    const bytes = new Uint8Array(await fetchBuffer(url));
    signal.throwIfAborted();
    if (bytes.length < 48) throw new Error('加密模型文件被截断');
    const view = new DataView(bytes.buffer, bytes.byteOffset, 32);
    const magic = [76, 50, 68, 77, 79, 67, 51, 0];
    if (!magic.every((value, i) => bytes[i] === value) || view.getUint32(8, true) !== 1 || view.getUint32(28, true) !== 0) {
      throw new Error('加密模型格式或版本无效');
    }
    const length = view.getUint32(12, true);
    if (length < 64 || length > 64 * 1024 * 1024 || bytes.length !== length + 48) throw new Error('加密模型长度无效');
    keyBytes = Uint8Array.from(keyHex.match(/../g), value => Number.parseInt(value, 16));
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    keyBytes.fill(0);
    plain = new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: bytes.subarray(16, 28), additionalData: bytes.subarray(0, 32), tagLength: 128
    }, key, bytes.subarray(32)));
    signal.throwIfAborted();
    if (plain.length !== length || ![77, 79, 67, 51].every((value, i) => plain[i] === value)) throw new Error('解密结果不是 MOC3 模型');
    if (Live2DCubismCore.Moc.prototype.hasMocConsistency(plain.buffer) !== 1) throw new Error('MOC3 数据损坏或版本不受支持');
    // 兼容路径的明文暴露点。不得将这一调用描述为底层加载或已绕过高层接口。
    moc = Live2DCubismCore.Moc.fromArrayBuffer(plain.buffer);
    if (!moc) throw new Error('MOC3 初始化失败');
    // 使用现有 Moc 查询版本，避免版本查询额外复制整份文件。
    const version = Live2DCubismCore.Version.csmGetMocVersion(moc, plain.buffer);
    plain.fill(0);
    model = Live2DCubismCore.Model.fromMoc(moc);
    if (!model) throw new Error('模型实例初始化失败');
    let released = false;
    return {
      model, version,
      release() {
        if (released) return;
        released = true;
        model.release();
        moc._release();
        model = moc = null;
      }
    };
  } catch (error) {
    model?.release();
    moc?._release();
    if (error.name === 'OperationError') throw new Error('模型认证失败：密钥错误或文件被篡改');
    throw error;
  } finally {
    plain?.fill(0);
    keyBytes?.fill(0);
  }
}
