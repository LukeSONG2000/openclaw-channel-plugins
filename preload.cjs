/**
 * 插件预加载入口（CJS 格式）。
 *
 * openclaw 框架通过 require() 加载插件，因此需要 .cjs 后缀
 * 确保在 "type": "module" 的 package 中也能被正确 require()。
 *
 * 在 require 真正的插件代码（依赖 openclaw/plugin-sdk）之前，
 * 先同步确保 node_modules/openclaw symlink 存在。
 */
"use strict";

const { ensurePluginSdkSymlink } = require("./scripts/link-sdk-core.cjs");

// 1) 同步创建 symlink
ensurePluginSdkSymlink(__dirname, "[preload]");

// 2) 现在 symlink 就绪，加载真正的插件入口
//    Node 22 中 CJS require() 加载 ESM 模块时，ESM resolver 的 package 查找
//    不走 node_modules symlink（realpath 行为差异），导致找不到 openclaw/plugin-sdk。
//    使用动态 import() 可以正确解析 symlink。
let _pluginModule = null;
const _pluginReady = import("./dist/index.js").then((m) => {
  _pluginModule = m;
}).catch((err) => {
  console.error(`[preload] failed to load plugin entry: ${err.message}`);
  throw err;
});

// 3) 透传：openclaw 框架通过 require() 拿到的对象
//    使用 Proxy 延迟访问，等 import() 完成后再转发属性
module.exports = new Proxy({}, {
  get(_target, prop) {
    if (_pluginModule) return _pluginModule[prop];
    // 如果框架同步访问导出（不应该发生，但以防万一）
    // 尝试同步 require 作为 fallback
    try {
      if (!_pluginModule) _pluginModule = require("./dist/index.js");
      return _pluginModule[prop];
    } catch {
      return undefined;
    }
  },
  ownKeys() {
    if (_pluginModule) return Reflect.ownKeys(_pluginModule);
    return [];
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (_pluginModule && prop in _pluginModule) {
      return { configurable: true, enumerable: true, value: _pluginModule[prop] };
    }
    return undefined;
  },
  has(_target, prop) {
    if (_pluginModule) return prop in _pluginModule;
    return false;
  },
});

// 暴露 ready promise 供框架等待（如果框架支持）
module.exports.__pluginReady = _pluginReady;
