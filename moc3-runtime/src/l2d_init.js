(function () {
  // init 只负责配置和实例初始化，密钥与解密逻辑均在运行库内部。
  if (typeof L2Dwidget === 'undefined' || document.getElementById('live2dcanvas')) return;
  L2Dwidget.init({
    model: {
      jsonPath: 'model/model.model3.json',
      scale: 1,
      // 默认严格模式。仅在理解接口暴露限制后手动启用兼容模式。
      allowHighLevel: false
    },
    display: { position: 'right', width: 300, height: 450, hOffset: 0, vOffset: 0 },
    mobile: { show: true },
    react: { opacity: 0.7 },
    log: false,
    onError(error) { console.error('Live2D 运行失败：', error); }
  }).catch(error => console.error('Live2D 初始化失败：', error));
})();
