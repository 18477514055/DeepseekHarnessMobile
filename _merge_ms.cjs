// 把 _ms-src（dsh-mobile-model-search）的**注入体**并进 _plugin-src（dsh-mobile-adaption）。
// ★ 目标：只留一个插件，模型筛选 + 收藏成为适配插件的一个 feature。
// ★ 做法：取 ms 的 runBody() 函数体（不含它自己的 __ModuleLoader__ 外壳），
//   包成一个 installModelPicker()，再注册进 feature()。
const fs = require('fs');
const path = require('path');

const root = __dirname;
const msPath = path.join(root, '_ms-src', 'lib', 'client.js');
const adPath = path.join(root, '_plugin-src', 'lib', 'client.js');

const ms = fs.readFileSync(msPath, 'utf8');
const ad = fs.readFileSync(adPath, 'utf8');

// ---- 1. 从 ms 里抠出 runBody 的函数体 ----
const bodyStart = ms.indexOf('    function runBody() {');
if (bodyStart < 0) throw new Error('runBody not found in ms');
const wrapStart = ms.indexOf('{', bodyStart);
// runBody 的结尾：往后找 "    }\n\n    return { name, inject, apply };"
const endMark = ms.indexOf('    return { name, inject, apply };', bodyStart);
if (endMark < 0) throw new Error('ms module tail not found');
// 往回找到 runBody 的闭合大括号
let bodyEnd = ms.lastIndexOf('\n    }', endMark);
if (bodyEnd < 0) throw new Error('runBody close brace not found');

let body = ms.slice(wrapStart + 1, bodyEnd);
console.log('ms runBody 提取长度:', body.length);

// 去掉外层多余缩进（4 空格 → 保持原样即可，我们包在自己的函数里）
// 注入体自带 "use strict" 与 IIFE 幂等守卫，直接搬即可。

// ---- 2. 组装成 adaption 里的 installModelPicker ----
const wrapper = `

    /* ==================================================================
       ★★★ 2026-10-20：模型筛选 + 收藏（并入适配插件）
       用户要求：「模型筛选和收藏功能整合进适配插件吧」
       原先是独立的 dsh-mobile-model-search 插件（_ms-src/），
       现在把它的注入体原样搬进来，作为本插件的一个 feature。
       ★ 幂等守卫（__dshMobileModelSearchInstalled）仍在，重复调用安全。
       ================================================================== */
    function installModelPicker() {
      if (typeof document === "undefined") return;
      if (document.body) { runBody(); }
      else { document.addEventListener("DOMContentLoaded", runBody, { once: true }); }

      function runBody() {${body}
      }
    }
`;

// ---- 3. 插到 adaption 的 exports 之前 ----
const anchor = '    exports.name = "dsh-mobile-adaption";';
const at = ad.indexOf(anchor);
if (at < 0) throw new Error('adaption exports anchor not found');
const out = ad.slice(0, at) + wrapper.trimStart() + '\n' + ad.slice(at);
fs.writeFileSync(adPath, out, 'utf8');
console.log('已写入:', adPath, fs.statSync(adPath).size, 'bytes');
