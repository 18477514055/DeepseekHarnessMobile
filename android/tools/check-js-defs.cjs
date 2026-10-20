#!/usr/bin/env node
/**
 * check-js-defs.cjs —— 「定义 vs 调用」静态对照
 *
 * 为什么需要它：`node --check` 只查语法，**查不出"某个标识符有没有定义"**。
 * 本项目真的栽过：用 edit 加注释时把 `function htmlEl() {...}` 整行换成了注释块，
 * 而它被调用 7 次 ⇒ 运行到那里抛 ReferenceError ⇒ 整个状态机无声失效，
 * 而语法检查一直是绿的。（见 lessons/L7.md）
 *
 * 用法：
 *   node android/tools/check-js-defs.cjs                  # 默认查插件那四个文件
 *   node android/tools/check-js-defs.cjs path/to/file.js  # 查指定文件（可多个）
 *
 * 退出码：0 = 全部通过；1 = 发现未定义的调用。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULTS = [
  '_plugin-src/lib/client.js',
  '_plugin-src/lib/index.js',
  '_plugin-src/lib/api-settings.js',
  '_plugin-src/android-bridge/dsh-android.js',
];

const argv = process.argv.slice(2);
const targets = argv.length ? argv : DEFAULTS.map((p) => path.join(ROOT, p));

// 宿主 / 浏览器 / Node 自带的名字，不该被误判为"未定义"
const EXTERNALS = new Set(
  ('require module exports process console global globalThis ' +
   'setTimeout clearTimeout setInterval clearInterval requestAnimationFrame ' +
   'fetch XMLHttpRequest Headers Request Response AbortController ' +
   'Buffer URL URLSearchParams TextEncoder TextDecoder structuredClone queueMicrotask ' +
   'window document navigator location localStorage sessionStorage performance ' +
   'getComputedStyle alert confirm prompt ' +
   'Math JSON Date Promise Object Array String Number Boolean RegExp Map Set ' +
   'WeakMap WeakSet Symbol Error TypeError RangeError ' +
   'MutationObserver ResizeObserver IntersectionObserver ' +
   'KeyboardEvent Event CustomEvent Node Element EventTarget ' +
   'parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent ' +
   'eval escape unescape ' +
   'if for while switch catch return typeof new delete function class await async ' +
   'yield case do else try finally throw in of instanceof void this super').split(/\s+/)
);

let failed = 0;
let checked = 0;

/**
 * 把注释与字符串内容替换成等长空白（保留换行与偏移）。
 * 不做这一步，CSS 里的 `var(--x)` / `rgba(...)` / `calc(...)` 会全部被当成 JS 调用，
 * 造成几十条假警报 —— 假警报比不报还糟，因为人会开始忽略它。
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // 行注释
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // 块注释
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    // 字符串 / 模板字符串
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += ' '; i++;
      while (i < n) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === q) { out += ' '; i++; break; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

for (const abs of targets) {
  if (!fs.existsSync(abs)) {
    console.log(`跳过（不存在）: ${abs}`);
    continue;
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const src = stripCommentsAndStrings(raw);          // ★ 只在"代码本体的骨架"上做分析
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');

  // ① 具名函数定义：function 声明 + const/let/var 赋值（含箭头函数）
  const defs = new Set();
  for (const m of raw.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defs.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\()/g)) defs.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/g)) defs.add(m[1]);
  // 对象字面量里的方法 / 属性函数： name(args) { ... }  ·  name: function  ·  get name()
  for (const m of src.matchAll(/[,{]\s*(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) defs.add(m[1]);
  for (const m of src.matchAll(/[,{]\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/g)) defs.add(m[1]);
  for (const m of src.matchAll(/[,{]\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/g)) defs.add(m[1]);
  // 解构赋值 / 解构参数： const { a, b: c } = x   ·   function f({ a, b })   ·   const [x, y] = arr
  // ★ 这条不能少：本项目大量使用 `const { host, port } = parsed` 这类写法，
  //   漏了它会把解构出来的变量全部报成"未定义"。
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim().split(/[\s=]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) defs.add(name);
    }
  }
  for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/[\s=]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) defs.add(name);
    }
  }
  for (const m of src.matchAll(/function\s*[A-Za-z_$\w]*\s*\(\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim().split(/[\s=]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) defs.add(name);
    }
  }
  // 参数里的回调名（形如 (cb) => 或 function (d)）：只当作"局部形参"直接加进定义集
  for (const m of src.matchAll(/[,(]\s*(?:async\s*)?([A-Za-z_$][\w$]*)\s*[,)]\s*(?:=>|\{)/g)) defs.add(m[1]);
  // 数组下标赋值：var bump = React.useState(0)[1]  ·  const build = CMDS[cmd]
  // ★ 这类"从表达式里取出来"的名字解析器认不出，报出来全是假警报。
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?\[[^\]]*\]\s*;/g)) defs.add(m[1]);
  // 解构回调参数：({ spawn }) =>  ·  ({ a, b }) =>
  for (const m of src.matchAll(/\(\s*\{([^}]*)\}\s*\)\s*=>/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim().split(/[\s=]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) defs.add(name);
    }
  }
  // 动态 import 是语法关键字，不是函数调用
  defs.add('import');
  // ESM 导入： import { execFile } from "..."   ·   import x from "..."   ·   import * as ns from "..."
  for (const m of raw.matchAll(/^\s*import\s*\{([^}]*)\}\s*from/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.split(/\s+as\s+/).pop().trim().split(/\s/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) defs.add(name);
    }
  }
  for (const m of raw.matchAll(/^\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/gm)) defs.add(m[1]);
  for (const m of raw.matchAll(/^\s*import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/gm)) defs.add(m[1]);

  // ② 函数调用：前导不能是 . 或标识符字符（排除 a.b() 与 foo 里的子串）
  const calls = new Map();
  for (const m of src.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (EXTERNALS.has(name) || defs.has(name)) continue;
    calls.set(name, (calls.get(name) || 0) + 1);
  }

  const missing = [...calls.keys()];

  checked++;
  if (missing.length === 0) {
    console.log(`✓ ${rel}  （定义 ${defs.size} 个，调用点全部有出处）`);
  } else {
    failed++;
    console.log(`✗ ${rel}  —— ${missing.length} 个未定义的调用：`);
    for (const n of missing) console.log(`     ${n}()  ×${calls.get(n)}`);
  }
}

console.log('');
if (failed) {
  console.log(`✗ ${failed}/${checked} 个文件有问题 —— 装机前必须修掉。`);
  process.exit(1);
}
console.log(`✓ ${checked} 个文件全部通过。`);
