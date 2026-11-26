Live2D MOC3 Runtime：使用说明

一、内容与依赖准备

公开目录包含 src、tools、tests、vendor/cubism-framework、licenses、通用 HTML 页面模板及配置示例。没有附带任何模型、贴图、动作、物理文件、密文、实际密钥、Core 或完整 SDK。
官方 Framework 来自已验证的 SDK 5-r.5，保持原始源码、着色器、Copyright 和 LICENSE。第三方许可边界见 THIRD_PARTY_NOTICES.txt；本次未给自研部分擅自选择开源许可证。
Node.js 22 或更新版本。开发依赖为 esbuild 与 playwright-core；生产运行不依赖大型第三方封装库。

从官方 https://www.live2d.com/en/sdk/download/web/ 自行下载并接受 SDK 许可。本项目不会自动代替使用者接受协议、下载私有组件或安装混淆工具。
从所获 SDK 复制以下文件到本地 .private/sdk/Core/：
  live2dcubismcore.js
  LICENSE.md
  RedistributableFiles.txt

二、构建与测试

在本目录执行 npm ci。
执行 npm run build:plain，生成仅供本地明文基线使用的 .test/。
执行 npm run build，生成加密兼容验证用的 dist/。首次生成 .local/model.key，之后复用该密钥；每次加密使用新的随机 nonce。
生成目录必须为空，以防旧模型资源残留；再次构建前须自行检查并清空相应的 .test 或 dist。构建器不自动递归删除目录。
执行 npm run serve，本地地址为 http://127.0.0.1:4173/.test/index.html 或 http://127.0.0.1:4173/dist/index.html。
服务仅监听本机，只开放两个生成目录，不开放源码、配置、密钥或原始私有输入。完成后用 Ctrl+C 关闭。

npm run test:crypto 使用随机合成字节测试加密，不需要 SDK 或模型；合成字节不是真实 Live2D 模型，也不能据此验收渲染。
npm test 使用自行提供的模型与本机 Microsoft Edge 验证真实渲染、已配置动作、物理存在状态、测试表情、释放、认证失败、严格模式、跨域与 Service Worker 离线场景。须先构建明文和兼容产物。
浏览器测试自行启动随机端口服务并在 finally 关闭。测试结果与截图仅保存在被忽略的 reports/；截图含使用者模型，不能随源码公开。
Android 真机、实际 HTTPS CDN、Android PWA 安装及系统生命周期仍需独立验收，桌面触摸模拟不能代替这些结果。

三、独立加密工具

工具只使用 Node 内置密码学库，可不安装开发依赖而直接运行：
  node tools/encrypt-model.mjs --generate-key .local/example.key
  node tools/encrypt-model.mjs --input .private/model/model.moc3 --output .local/model.moc3.enc --key-file .local/example.key
实际输入文件名以使用者模型为准。工具拒绝覆盖既有密钥和输出。
构建器使用 .local/model.key；独立加密与运行库必须使用同一密钥。轮换密钥时需要同时重新加密和重新编译。

格式采用 AES-256-GCM，32 字节随机密钥、12 字节随机 nonce、16 字节认证标签。文件由 32 字节认证头、等长密文和标签组成。
认证头包含魔数、LE32 版本 1、LE32 明文长度、nonce 和零保留字段，整份认证头作为 additionalData 认证。长度限制为 64 字节至 64 MiB；失败时不调用模型初始化入口。
旧版循环异或方案无可靠完整性保护，已不在公开工具中使用；技术比较结论保留，不保留其实际密钥与私人文件名。

四、调用链与内存直写研究结论

目标原为：密文网络加载 -> 自定义解密 -> 直接写入目标内存 -> 低层原地初始化 -> 官方计算与渲染。
检查当前 Core 包装层后确认，csmMallocMoc、HEAPU8、csmHasMocConsistency、csmReviveMocInPlace 等位于 _em / _csm 闭包内部，外部不可访问。
所检查副本的 Core 版本查询为 6.0.1（编码 100663297），文件内嵌 JavaScript 实现，不需要外置 WASM。本结论限定于该副本，后续下载或升级的 SDK 必须重新核查。
公开 Memory.initializeAmountOfMemory 只预设容量，不提供可写内存与分配、释放或原地初始化接口。不能把内部函数存在误认为外部可合法调用。
公开 Moc 构造器在类型声明中为 private；通过构造器或改名绕过静态入口仍会传递完整明文，不能解决目标。
没有逆向、修改 Core 或 WASM，没有强行提取闭包，没有重新实现 WebGL 引擎。当前内存直写方案未实现，严格模式会拒绝隐式降级。
若要实施原目标，需要官方提供允许使用的堆视图、分配与释放、对齐及原地初始化绑定，和受支持的 Moc 接入方式。

当前兼容调用链：
fetch 密文 -> 认证头校验 -> Web Crypto AES-GCM 解密 -> MOC3 魔数检查 -> 官方 hasMocConsistency -> Moc.fromArrayBuffer -> 从现有 Moc 查询版本 -> 清零自有 JS 明文 -> Model.fromMoc -> CubismModel -> 官方动作/物理及 WebGL。
完整明文确实经过 Moc.fromArrayBuffer，不能宣称已绕过高层入口。兼容模板显式设置 allowHighLevel=true；独立 init 默认 false，当前 SDK 下会明确报告限制。
Web Crypto 返回完整 JS 明文；hasMocConsistency 在 Core 中临时复制一份，Moc.fromArrayBuffer 再复制并原地复活。兼容实现无法控制 Core 的内部副本和释放后的残留。
自有 JS 明文在成功和异常路径均清零，不传给 init、不挂到 window、不提供独立的完整明文解密 API。版本查询使用已有 Moc，避免该步骤再复制整份模型。
静态浏览器脚本最终必须携带可用密钥。non-extractable CryptoKey 与 JSVMP 都不能防止预先 hook 公开入口或读取进程内存。

五、生命周期与源码职责

src/protected-loader.js 包含密钥导入、认证、解密、明文处理和官方入口调用，返回模型句柄而非明文。
src/widget.js 负责官方 Framework 的渲染、动作、表情、物理、鼠标与触摸输入以及生命周期。
src/plain-entry.js 仅用于明文基线；src/protected-entry.js 为兼容运行库入口；src/l2d_init.js 只负责初始化参数。
src/motion-data.js 根据曲线重新计算统计元数据，用于兼容历史导出数据中的统计偏差，不改写原始资源，也不删除曲线。

对外保留 L2Dwidget.init(options)，并提供 destroy、playMotion、setExpression、getStatus。模型和密钥不通过这些接口暴露。
实例单例且串行初始化，重新 init 会销毁旧实例。destroy 可重复调用，并取消加载、停止帧循环、释放动作/表情/物理、WebGL 及 Model，最后释放 Moc。
Framework 为复用保留一次初始化状态及预留 Core 堆。创建释放计数平衡不等于证明 Core 内部绝无泄漏，模型销毁也不意味着整块堆返还操作系统。
Framework 着色器异步加载适配使用固定版本内部状态；更换版本后必须验证。

六、CDN、PJAX 与 JSVMP

运行库与 Core 采用经典 script 顺序加载；模型路径以运行库自身 URL 为基准，配套路径以 model3.json 为基准。
使用者本地构建后可根据模型及 SDK 授权自行部署 dist，保持 Core、运行库、init 在同一层及 model、shaders 子目录的相对结构。
示例地址使用保留域名 https://cdn.example.invalid/live2d/v1/，需替换为自己的 HTTPS CDN。
资源须允许页面源的 CORS；公开无凭据资源可按实际策略设置 Access-Control-Allow-Origin。
生成的 dist 包含使用者资源、Core 和内嵌密钥，不能作为本仓库的公开源码提交。运行分发的许可与公开源码发布是不同范围，需分别检查。

示例：
  await L2Dwidget.init({model:{jsonPath:'model/model.model3.json',allowHighLevel:true},display:{position:'right',width:300,height:450,hOffset:0,vOffset:0}});
allowHighLevel=true 表示明确使用兼容路径，而不是已实现底层加载。
PJAX 页面离开时 await L2Dwidget.destroy()，页面就绪后再 init；不绑定某个个人博客的域名或事件名。
playMotion 的组名与索引、setExpression 的名称以使用者配置为准，不预设某个模型的动作。

JSVMP 由使用者自行操作。编译目标为 dist/live2d-runtime.js，其中包含 protected-loader 和必要 Framework 打包代码。官方 Core、init 与着色器不要混淆。
混淆后保留 IIFE 入口、L2Dwidget 名称和标准 Web API，再运行 npm test。重新 build 会覆盖混淆产物，构建前需要清空生成目录。
本项目没有安装或调用 JSVMP，不能声称混淆前后性能一致。

