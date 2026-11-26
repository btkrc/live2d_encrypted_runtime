import { createWidget } from './widget.js';

// 仅供第一阶段的本地明文基线测试，不进入 CDN 部署目录。
async function loadPlain(url, fetchBuffer) {
  const data = new Uint8Array(await fetchBuffer(url));
  let moc, model;
  try {
    if (!Live2DCubismCore.Moc.prototype.hasMocConsistency(data.buffer)) throw new Error('MOC3 完整性检查失败');
    const version = Live2DCubismCore.Version.csmGetMocVersion(data.buffer);
    moc = Live2DCubismCore.Moc.fromArrayBuffer(data.buffer);
    if (!moc) throw new Error('明文 MOC3 初始化失败');
    model = Live2DCubismCore.Model.fromMoc(moc);
    if (!model) throw new Error('明文模型初始化失败');
    return { model, version, release() { model.release(); moc._release(); } };
  } catch (error) { model?.release(); moc?._release(); throw error; }
  finally { data.fill(0); }
}

globalThis.L2Dwidget = createWidget(loadPlain, document.currentScript.src);
