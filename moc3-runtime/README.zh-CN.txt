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


三、独立加密工具

工具只使用 Node 内置密码学库，可不安装开发依赖而直接运行：
  node tools/encrypt-model.mjs --generate-key .local/example.key
  node tools/encrypt-model.mjs --input .private/model/model.moc3 --output .local/model.moc3.enc --key-file .local/example.key
