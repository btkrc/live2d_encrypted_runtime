import { CubismFramework } from '../vendor/cubism-framework/src/live2dcubismframework';
import { CubismModel } from '../vendor/cubism-framework/src/model/cubismmodel';
import { CubismRenderer_WebGL } from '../vendor/cubism-framework/src/rendering/cubismrenderer_webgl';
import { CubismShaderManager_WebGL } from '../vendor/cubism-framework/src/rendering/cubismshader_webgl';
import { CubismModelMatrix } from '../vendor/cubism-framework/src/math/cubismmodelmatrix';
import { CubismMatrix44 } from '../vendor/cubism-framework/src/math/cubismmatrix44';
import { CubismMotion } from '../vendor/cubism-framework/src/motion/cubismmotion';
import { CubismMotionManager } from '../vendor/cubism-framework/src/motion/cubismmotionmanager';
import { CubismExpressionMotion } from '../vendor/cubism-framework/src/motion/cubismexpressionmotion';
import { CubismExpressionMotionManager } from '../vendor/cubism-framework/src/motion/cubismexpressionmotionmanager';
import { CubismMotionQueueManager } from '../vendor/cubism-framework/src/motion/cubismmotionqueuemanager';
import { CubismPhysics } from '../vendor/cubism-framework/src/physics/cubismphysics';
import { CubismPose } from '../vendor/cubism-framework/src/effect/cubismpose';
import { normalizeMotion } from './motion-data.js';

// 单实例串行管理，避免官方渲染器的静态 WebGL 状态跨上下文冲突。
export function createWidget(loadCoreModel, moduleUrl) {
  let current = null;
  let pending = null;
  let queue = Promise.resolve();
  let frameworkReady = false;

  async function coreReady() {
    if (typeof Live2DCubismCore === 'undefined') {
      throw new Error('请先加载同目录的官方 live2dcubismcore.js');
    }
    // 当前官方文件内嵌 JavaScript Core；用公开版本查询等待内部初始化完成。
    const deadline = performance.now() + 15000;
    for (;;) {
      try { if (Live2DCubismCore.Version.csmGetVersion() > 0) break; } catch {}
      if (performance.now() > deadline) throw new Error('Cubism Core 初始化超时');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!frameworkReady) {
      CubismFramework.startUp();
      // 提前预留内存，避免多个模型视图在后续分配时因内存增长而失效。
      CubismFramework.initialize(64 * 1024 * 1024);
      frameworkReady = true;
    }
  }

  function schedule(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }

  async function mount(options, abort) {
    await coreReady();
    const signal = abort.signal;
    signal.throwIfAborted();
    const base = new URL('.', moduleUrl);
    const settingUrl = new URL(options.model?.jsonPath || 'model/model.model3.json', base);
    const fetchBuffer = async url => {
      const response = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
      if (!response.ok) throw new Error(`资源加载失败：${response.status} ${url}`);
      return response.arrayBuffer();
    };
    const setting = JSON.parse(new TextDecoder().decode(await fetchBuffer(settingUrl)));
    const refs = setting.FileReferences;
    if (!refs?.Moc || !refs.Textures?.length) throw new Error('模型配置缺少 Moc 或贴图');
    const resolve = path => new URL(path, settingUrl);
    const canvas = document.createElement('canvas');
    canvas.id = 'live2dcanvas';
    canvas.className = 'live2d-widget';
    canvas.setAttribute('aria-label', 'Live2D 交互模型');
    const display = { position: 'right', width: 300, height: 450, hOffset: 0, vOffset: 0, ...options.display };
    Object.assign(canvas.style, {
      position: 'fixed', width: `${display.width}px`, height: `${display.height}px`,
      bottom: `${display.vOffset}px`, [display.position === 'left' ? 'left' : 'right']: `${display.hOffset}px`,
      touchAction: 'none', opacity: String(options.react?.opacity ?? 1), zIndex: '99'
    });
    (options.container || document.body).append(canvas);
    let gl, handle, model, renderer, physics, pose, raf = 0;
    let destroyed = false, frames = 0, elapsed = 0, previous = 0, motionName = '';
    const textures = [], motions = new Map(), expressions = new Map();
    const motionManager = new CubismMotionManager();
    motionManager.setEventCallback(() => {});
    const expressionManager = new CubismExpressionMotionManager();
    const listeners = [];
    const pointer = { x: 0, y: 0, down: null };
    const listen = (target, name, fn) => {
      target.addEventListener(name, fn);
      listeners.push(() => target.removeEventListener(name, fn));
    };
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      cancelAnimationFrame(raf);
      for (const remove of listeners) remove();
      // 即使某个 SDK 资源释放失败，也必须继续释放 Core 模型、贴图和 DOM。
      const release = operation => { try { operation(); } catch (error) { console.warn('Live2D 资源释放异常：', error); } };
      release(() => motionManager.release());
      // 新版表情管理器的 release 不调用基类；显式释放全部队列项。
      release(() => CubismMotionQueueManager.prototype.release.call(expressionManager));
      release(() => expressionManager.release());
      for (const motion of motions.values()) release(() => motion.release());
      for (const expression of expressions.values()) release(() => expression.release());
      if (physics) release(() => CubismPhysics.delete(physics));
      if (pose) release(() => CubismPose.delete(pose));
      release(() => renderer?.release());
      if (gl) {
        for (const texture of textures) gl.deleteTexture(texture);
        // SDK 编译着色器失败时可能留下数值错误码，过滤后才能安全调用官方释放。
        const shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
        for (const set of shader?._shaderSets || []) {
          if (set && typeof set.shaderProgram !== 'object') set.shaderProgram = null;
        }
        release(() => CubismRenderer_WebGL.doStaticRelease());
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
      release(() => handle?.release());
      handle = model = renderer = physics = pose = null;
      motions.clear();
      expressions.clear();
      textures.length = 0;
      canvas.remove();
    };
    try {
      gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
      if (!gl) throw new Error('浏览器无法创建 WebGL 上下文');
      handle = await loadCoreModel(resolve(refs.Moc), fetchBuffer, signal, options.model || {});
      signal.throwIfAborted();
      model = new CubismModel(handle.model);
      model.initialize();
      model.saveParameters();
      renderer = new CubismRenderer_WebGL(canvas.width, canvas.height);
      renderer.initialize(model);
      renderer.startUp(gl);
      renderer.setIsPremultipliedAlpha(true);
      const shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
      shader.setShaderPath(new URL('shaders/', base).href);
      // Framework 当前的加载器不检查 HTTP 状态，也不能取消；适配同一资源请求策略。
      shader.loadShader = async url => new TextDecoder().decode(await fetchBuffer(url));
      shader.generateShaders();
      // Framework 当前没有异步就绪接口；固定版本下等待官方加载任务结束后再渲染与释放。
      while (shader._isShaderLoading) await new Promise(resolve => setTimeout(resolve, 20));
      if (!shader._isShaderLoaded) throw new Error('官方着色器加载失败');
      signal.throwIfAborted();
      // 顺序上传便于在取消或异常时释放已创建的 GPU 资源。
      for (let i = 0; i < refs.Textures.length; i++) {
        const data = await fetchBuffer(resolve(refs.Textures[i]));
        const bitmap = await createImageBitmap(new Blob([data]), { premultiplyAlpha: 'premultiply' });
        try {
          signal.throwIfAborted();
          const texture = gl.createTexture();
          if (!texture) throw new Error('无法创建模型贴图');
          textures.push(texture);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          renderer.bindTexture(i, texture);
        } finally { bitmap.close(); }
      }
      if (refs.Physics) {
        const data = await fetchBuffer(resolve(refs.Physics));
        physics = CubismPhysics.create(data, data.byteLength);
        if (!physics) throw new Error('物理配置无法解析');
      }
      if (refs.Pose) {
        const data = await fetchBuffer(resolve(refs.Pose));
        pose = CubismPose.create(data, data.byteLength);
      }
      for (const [group, entries] of Object.entries(refs.Motions || {})) {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const data = normalizeMotion(await fetchBuffer(resolve(entry.File)));
          const motion = CubismMotion.create(data, data.byteLength);
          if (!motion) throw new Error(`动作无法解析：${entry.File}`);
          const effectIds = name => {
            const result = [];
            for (const value of setting.Groups?.find(group => group.Name === name)?.Ids || []) {
              result.push(CubismFramework.getIdManager().getId(value));
            }
            return result;
          };
          motion.setEffectIds(effectIds('EyeBlink'), effectIds('LipSync'));
          if (entry.FadeInTime != null) motion.setFadeInTime(entry.FadeInTime);
          if (entry.FadeOutTime != null) motion.setFadeOutTime(entry.FadeOutTime);
          motion.setLoop(group === 'Idle' || /idle/i.test(entry.File));
          motions.set(`${group}:${i}`, motion);
        }
      }
      for (const entry of refs.Expressions || []) {
        const data = await fetchBuffer(resolve(entry.File));
        const expression = CubismExpressionMotion.create(data, data.byteLength);
        if (!expression) throw new Error(`表情无法解析：${entry.File}`);
        expressions.set(entry.Name, expression);
      }
      const playMotion = (group = '', index = 0) => {
        if (destroyed) return false;
        const name = `${group}:${index}`, motion = motions.get(name);
        if (!motion) return false;
        motionManager.stopAllMotions();
        motionManager.startMotionPriority(motion, false, 3);
        motionName = name;
        return true;
      };
      const setExpression = name => {
        if (destroyed) return false;
        const expression = expressions.get(name);
        if (!expression) return false;
        expressionManager.startMotion(expression, false);
        return true;
      };
      const updatePointer = e => {
        const rect = canvas.getBoundingClientRect();
        pointer.x = Math.max(-1, Math.min(1, 2 * (e.clientX - rect.left) / rect.width - 1));
        pointer.y = Math.max(-1, Math.min(1, 1 - 2 * (e.clientY - rect.top) / rect.height));
      };
      listen(canvas, 'pointermove', updatePointer);
      listen(canvas, 'pointerdown', e => { updatePointer(e); pointer.down = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
      listen(canvas, 'pointerup', e => {
        if (pointer.down && Math.hypot(e.clientX - pointer.down[0], e.clientY - pointer.down[1]) < 12) {
          const entries = refs.Motions?.['TapBody'] || refs.Motions?.[''] || [];
          const group = refs.Motions?.['TapBody'] ? 'TapBody' : '';
          const candidates = entries.map((entry, i) => /touch/.test(entry.File) ? i : -1).filter(i => i >= 0);
          if (candidates.length) playMotion(group, candidates[Math.floor(Math.random() * candidates.length)]);
          else if (entries.length) playMotion(group, Math.floor(Math.random() * entries.length));
        }
        pointer.down = null;
      });
      listen(canvas, 'pointercancel', () => { pointer.down = null; pointer.x = pointer.y = 0; });
      listen(canvas, 'pointerleave', () => { if (!pointer.down) pointer.x = pointer.y = 0; });
      listen(canvas, 'webglcontextlost', e => { e.preventDefault(); destroy(); options.onError?.(new Error('WebGL 上下文丢失，请重新初始化')); });
      const matrix = new CubismModelMatrix(model.getCanvasWidth(), model.getCanvasHeight());
      matrix.setHeight(2);
      // Core 已将顶点转换到以画布原点为基准的模型空间。
      const id = name => CubismFramework.getIdManager().getId(name);
      const ids = Object.fromEntries(['ParamAngleX', 'ParamAngleY', 'ParamBodyAngleX', 'ParamEyeBallX', 'ParamEyeBallY'].map(name => [name, id(name)]));
      function frame(now) {
        if (destroyed) return;
        try {
          const delta = previous ? Math.min((now - previous) / 1000, 0.05) : 0;
          previous = now;
          if (!document.hidden) {
            elapsed += delta;
            const dpr = Math.min(devicePixelRatio || 1, 2);
            const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
            const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
            if (canvas.width !== width || canvas.height !== height) {
              canvas.width = width; canvas.height = height;
              renderer.setRenderTargetSize(width, height);
            }
            model.loadParameters();
            if (motionManager.isFinished() && motions.size) {
              const group = refs.Motions.Idle ? 'Idle' : Object.keys(refs.Motions)[0];
              playMotion(group, 0);
            }
            motionManager.updateMotion(model, delta);
            model.saveParameters();
            expressionManager.updateMotion(model, delta);
            for (const [name, amount] of [['ParamAngleX', pointer.x * 15], ['ParamAngleY', pointer.y * 12], ['ParamBodyAngleX', pointer.x * 5], ['ParamEyeBallX', pointer.x], ['ParamEyeBallY', pointer.y]]) {
              model.addParameterValueById(ids[name], amount);
            }
            physics?.evaluate(model, delta);
            pose?.updateParameters(model, delta);
            model.update();
            const projection = new CubismMatrix44();
            // 将整个模型画布按比例放入视口，避免窄屏裁切。
            const aspect = width / height;
            const modelAspect = model.getCanvasWidth() / model.getCanvasHeight();
            const scale = (options.model?.scale ?? 1) * Math.min(1, aspect / modelAspect) * 0.95;
            projection.scale(scale / aspect, scale);
            projection.multiplyByMatrix(matrix);
            gl.viewport(0, 0, width, height);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            renderer.setMvpMatrix(projection);
            renderer.setRenderState(null, [0, 0, width, height]);
            renderer.drawModel();
            frames++;
          }
          raf = requestAnimationFrame(frame);
        } catch (error) { destroy(); options.onError?.(error); }
      }
      signal.throwIfAborted();
      raf = requestAnimationFrame(frame);
      return Object.freeze({
        destroy, playMotion, setExpression,
        getStatus: () => ({ destroyed, frames, elapsed, motion: motionName, motions: motions.size, expressions: expressions.size, physics: !!physics, mocVersion: handle?.version, drawables: model?.getDrawableCount() ?? 0 })
      });
    } catch (error) { destroy(); throw error; }
  }

  return Object.freeze({
    init(options = {}) {
      pending?.abort();
      const abort = new AbortController();
      pending = abort;
      return schedule(async () => {
        current?.destroy(); current = null;
        if (options.mobile?.show === false && matchMedia('(pointer: coarse)').matches) return null;
        try { current = await mount(options, abort); return current; }
        finally { if (pending === abort) pending = null; }
      });
    },
    destroy() {
      pending?.abort();
      current?.destroy(); current = null;
      return schedule(() => {});
    },
    playMotion(group, index) { return current?.playMotion(group, index) ?? false; },
    setExpression(name) { return current?.setExpression(name) ?? false; },
    getStatus() { return current?.getStatus() ?? { destroyed: true }; }
  });
}
