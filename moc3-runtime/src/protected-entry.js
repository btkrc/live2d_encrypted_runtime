import { createWidget } from './widget.js';
import { loadProtectedModel } from './protected-loader.js';

globalThis.L2Dwidget = createWidget(loadProtectedModel, document.currentScript.src);
