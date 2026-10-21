/* 在最小 DOM 沙箱里真实执行插件，抓它加载时抛的错。
 * ★ 为什么不用 node --check：那只查语法。这次 `node --check` 通过，
 *   但页面报 "1 entry did not activate" ⇒ 是运行期错误。
 */
const fs = require('fs');
const vm = require('vm');

const SRC = process.argv[2] || '_plugin-src/lib/client.js';
const src = fs.readFileSync(SRC, 'utf8');

const noop = function () {};
function mkEl() {
  const el = {
    style: {}, dataset: {}, children: [], classList: { add: noop, remove: noop, contains: () => false },
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    appendChild: noop, removeChild: noop, addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    closest: () => null, contains: () => false, focus: noop, blur: noop, click: noop,
    insertBefore: noop, cloneNode: () => mkEl(),
    offsetHeight: 0, clientWidth: 0, clientHeight: 0,
    textContent: '', innerHTML: '', innerText: '', value: '',
  };
  return el;
}

const sandbox = {
  console: { log: noop, warn: noop, error: noop },
  setTimeout: function () { return 0; },
  setInterval: function () { return 0; },
  clearTimeout: noop,
  clearInterval: noop,
  Promise: Promise,
  Date: Date,
  Math: Math,
  JSON: JSON,
  Error: Error,
  RegExp: RegExp,
  Array: Array,
  Object: Object,
  String: String,
  Number: Number,
  Boolean: Boolean,
  Map: Map,
  Set: Set,
  URL: URL,
  TextEncoder: TextEncoder,
  document: {
    readyState: 'complete',
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => mkEl(),
    getElementById: () => null,
    head: { appendChild: noop },
    body: { appendChild: noop, addEventListener: noop, contains: () => false },
    documentElement: mkEl(),
  },
  localStorage: {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: noop,
    removeItem: noop,
  },
  navigator: { userAgent: 'sandbox', language: 'zh-CN' },
  location: { href: 'http://127.0.0.1:3080/', reload: noop },
  fetch: function () { return Promise.reject(new Error('sandbox')); },
  XMLHttpRequest: function () { return { open: noop, send: noop, setRequestHeader: noop, addEventListener: noop }; },
  MutationObserver: function () { return { observe: noop, disconnect: noop }; },
  ResizeObserver: function () { return { observe: noop, disconnect: noop }; },
  Event: function () {},
  KeyboardEvent: function () {},
  CustomEvent: function () {},
  requestAnimationFrame: function () { return 0; },
  cancelAnimationFrame: noop,
  performance: { now: () => 0 },
  screen: { width: 375, height: 776 },
  innerWidth: 375,
  innerHeight: 776,
  devicePixelRatio: 3,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

let loadSeen = false;
let factoryError = null;
let exportKeys = null;
let applyError = null;
let applied = false;
let moduleExports = null;

sandbox.window.__ModuleLoader__ = {
  load: function (opt) {
    loadSeen = true;
    const id = opt && opt.id;
    const module = { exports: {} };
    try {
      const ret = opt.factory(function (name) {
        // 最小 require：返回空对象，够 factory 走完顶层
        return {};
      });
      if (ret) module.exports = ret;
      exportKeys = Object.keys(module.exports || {});
      moduleExports = module.exports;
    } catch (e) {
      factoryError = e;
    }
  },
};

try {
  vm.runInNewContext(src, sandbox, { filename: SRC });
} catch (e) {
  console.log('TOP-LEVEL THREW:');
  console.log(e && e.stack ? e.stack.split('\n').slice(0, 12).join('\n') : e);
  process.exit(1);
}

console.log('load() called:', loadSeen);
if (factoryError) {
  console.log('FACTORY THREW:');
  console.log(factoryError.stack ? factoryError.stack.split('\n').slice(0, 15).join('\n') : factoryError);
  process.exit(1);
}
console.log('factory OK. exports =', JSON.stringify(exportKeys));

/* ★★★ 2026-10-21：**真的调一次 apply(ctx)**。
 *
 * 为什么必须加这一步：原来的沙箱只跑到 "factory OK" 就结束了，
 * 而 §87 那次事故的错**恰恰在 apply() 内部** ——
 *   ReferenceError: installTerminalBindingFix is not defined
 * apply() 抛错 ⇒ 官方判定 "1 entry did not activate" ⇒ 整页白。
 * 也就是说：**这个尺子当时量不到它本该量的东西**。
 *
 * ctx 只要够 apply 走完顶层就行：它做的事是注册 feature / 监听 DOM。
 * 我们的 sandbox.window 已经把 document / setTimeout 等都给成 noop 了，
 * 所以这里抛出的错误**基本都是真实的代码缺陷**（未定义标识符、类型错），
 * 不是环境缺失造成的假阳性。
 */
if (moduleExports && typeof moduleExports.apply === 'function') {
  try {
    moduleExports.apply({
      on: function () { return function () {}; },
      effect: function (fn) { if (typeof fn === 'function') fn(); },
      plugin: function () {},
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      config: {},
      root: {},
      app: {},
    });
    applied = true;
  } catch (e) {
    applyError = e;
  }

  if (applyError) {
    console.log('APPLY THREW:');
    console.log(applyError.stack ? applyError.stack.split('\n').slice(0, 18).join('\n') : applyError);
    process.exit(1);
  }
  console.log('apply() OK — 没有 ReferenceError / 类型错（这一条才是 §87 的尺子）');
} else {
  console.log('（该插件没有导出 apply，跳过）');
}
