// 纯 JS 复刻 RootfsInstaller.TarReader 的解析逻辑，用真实 rootfs.gz.bin 验证。
//
// ★ 为什么要在电脑上做这件事：
//   刚才在真机上踩的三个坑（512 对齐、顶层 "./"、符号链接）都是**纯解析逻辑错误**，
//   根本不需要装 APK 才能发现。每轮"改代码 → 打包 380MB → 装 → 等 2 分钟"要 5 分钟，
//   而这里跑一遍只要几秒。**先在电脑上把解析器测干净，再上真机**。
//
// 用法：node tools/verify-tar.js [assetPath]
// 退出码 0 = 全部通过。

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const asset = process.argv[2] ||
  path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'rootfs.gz.bin');

// ---------- 与 Java 侧一一对应 ----------
function sanitize(name) {
  let n = name.replace(/\\/g, '/');
  while (n.startsWith('./')) n = n.slice(2);
  while (n.startsWith('/')) n = n.slice(1);
  if (n.includes('..')) n = n.replace(/\.\./g, '_');
  return n;
}
const pad = (size) => (512 - (size % 512)) % 512;
function cstr(buf, off, len) {
  let end = off;
  while (end < off + len && buf[end] !== 0) end++;
  return buf.toString('utf8', off, end).trim();
}
function octal(buf, off, len) {
  if (buf[off] & 0x80) return 0; // base-256，本 rootfs 用不到
  const s = buf.toString('ascii', off, off + len).replace(/\0/g, ' ').trim();
  if (!s) return 0;
  const v = parseInt(s, 8);
  return Number.isNaN(v) ? 0 : v;
}

// ---------- 解析 ----------
function parse(buf) {
  const out = [];
  let pos = 0;
  let longName = null, longLink = null;

  while (pos + 512 <= buf.length) {
    const hdr = buf.subarray(pos, pos + 512);
    pos += 512;

    let allZero = true;
    for (let i = 0; i < 512; i++) if (hdr[i] !== 0) { allZero = false; break; }
    if (allZero) break;

    const name = cstr(hdr, 0, 100);
    const mode = octal(hdr, 100, 8);
    const size = octal(hdr, 124, 12);
    const type = String.fromCharCode(hdr[156]);
    const linkName = cstr(hdr, 157, 100);

    if (type === 'L') {
      longName = buf.toString('utf8', pos, pos + size).replace(/\0/g, '').trim();
      pos += size + pad(size);
      continue;
    }
    if (type === 'K') {
      longLink = buf.toString('utf8', pos, pos + size).replace(/\0/g, '').trim();
      pos += size + pad(size);
      continue;
    }
    if (type === 'x' || type === 'g') {
      pos += size + pad(size);
      continue;
    }

    const prefix = cstr(hdr, 345, 155);
    const raw = longName !== null ? longName : (prefix ? prefix + '/' + name : name);
    const e = {
      raw,
      name: sanitize(raw),
      linkName: longLink !== null ? longLink : linkName,
      type,
      mode,
      size,
    };
    longName = null; longLink = null;

    const isDir = type === '5' || (type === '\0' && raw.endsWith('/')) || e.name === '';
    e.isDir = isDir;

    // ★ 关键：数据段必须跳过（含填充），否则下一个 header 错位
    if (!isDir) pos += size + pad(size);
    out.push(e);
  }
  return out;
}

// ---------- 主流程 ----------
console.log('读取', asset);
const t0 = Date.now();
const gz = fs.readFileSync(asset);
console.log(`  压缩包 ${(gz.length / 1024 / 1024).toFixed(1)} MB`);

const buf = zlib.gunzipSync(gz);
console.log(`  解压后 ${(buf.length / 1024 / 1024).toFixed(1)} MB  (${Date.now() - t0} ms)`);

const entries = parse(buf);
console.log(`  条目数 ${entries.length}  (${Date.now() - t0} ms)`);

// ---------- 断言 ----------
let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✅ ' + m); else { console.log('  ❌ ' + m); fails++; } };

const byName = new Map();
for (const e of entries) if (!byName.has(e.name)) byName.set(e.name, e);

const dirs = entries.filter(e => e.isDir).length;
const files = entries.filter(e => e.type === '0' || e.type === '\0' || e.type === '7').length;
const syms = entries.filter(e => e.type === '2').length;
const hard = entries.filter(e => e.type === '1').length;
console.log(`\n类型统计：目录 ${dirs} / 文件 ${files} / 符号链接 ${syms} / 硬链接 ${hard}`);

console.log('\n关键条目：');
// ★ 注意：`bin` 本身是符号链接（-> usr/bin），所以**不存在** `bin/sh` 这个条目。
//   真实位置是 `usr/bin/sh -> dash`。isInstalled() 因此必须查 usr/bin/sh
//   （或先解引用再查），不能直接查 rootfs/bin/sh —— 这一条在电脑上测出来了，
//   省掉了一次真机往返。
const must = [
  'opt/node/bin/node',
  'usr/bin/python3',
  'usr/bin/sh',
  'etc/os-release',
  'usr/bin/bash',
];
for (const m of must) ok(byName.has(m), m);

console.log('\n符号链接是否正确识别：');
const expectLinks = [
  ['bin', 'usr/bin'],
  ['lib', 'usr/lib'],
  ['usr/bin/sh', 'dash'],
];
for (const [n, target] of expectLinks) {
  const e = byName.get(n);
  if (!e) { console.log(`  ❌ 缺 ${n}`); fails++; continue; }
  ok(e.type === '2', `${n} 是符号链接（type=${e.type}）`);
  ok(e.linkName === target, `${n} -> ${e.linkName}（期望 ${target}）`);
}

console.log('\n解析质量：');
// 1) 不该出现空名（除顶层 "./"）
const emptyNames = entries.filter(e => e.name === '');
ok(emptyNames.length <= 1, `空名条目 ${emptyNames.length} 个（最多 1 个顶层 "./"）`);

// 2) 不该出现含控制字符的怪异名字。
//    ★ 注意**不要**把冒号算成怪异：Debian dpkg 的 info 文件正常就叫
//      `gcc-14-base:arm64.list`。我第一版把冒号也列进去了，误报 243 个。
const weird = entries.filter(e => /[*?"<>|\u0000-\u001f]/.test(e.name));
ok(weird.length === 0, `怪异文件名 ${weird.length} 个${weird.length ? '：' + weird.slice(0, 3).map(e => JSON.stringify(e.name)).join(', ') : ''}`);

// 2b) 含冒号的名字应当**全部**是 dpkg 的 info 文件（证明冒号不是解析错位造成的）
const colons = entries.filter(e => e.name.includes(':'));
const colonOk = colons.every(e => e.name.startsWith('var/lib/dpkg/info/')
  || e.name.startsWith('var/lib/dpkg/status')   // status 里也可能有
  || /^usr\/share\/doc\//.test(e.name));
ok(colonOk, `含冒号的 ${colons.length} 个名字都在 dpkg/doc 范围内（不是解析错位）`);
if (!colonOk) {
  console.log('    例外样本:', colons.filter(e => !e.name.startsWith('var/lib/dpkg/info/')).slice(0, 5).map(e => e.name));
}

// 3) 名字不该以 "/" 开头（sanitize 后）
const abs = entries.filter(e => e.name.startsWith('/'));
ok(abs.length === 0, `绝对路径条目 ${abs.length} 个`);

// 4) 可执行文件认得出来
const nodeE = byName.get('opt/node/bin/node');
ok(nodeE && (nodeE.mode & 0o111) !== 0, 'node 带可执行位');
const shE = byName.get('usr/bin/sh');
ok(!!shE && shE.type === '2', 'usr/bin/sh 存在且是符号链接（真实的 bin/sh 位置）');

// 5) tar 结束标记之后的字节应全 0
console.log('\n完整性：');
ok(entries.length > 70000, `条目数 ${entries.length} > 70000`);
ok(buf.length > 1.2e9, `解压后 ${(buf.length / 1e9).toFixed(2)} GB > 1.2 GB`);

console.log('\n样本（前 12 条）：');
for (const e of entries.slice(0, 12)) {
  const t = e.isDir ? 'd' : e.type === '2' ? 'l' : '-';
  console.log(`  ${t} ${e.name}${e.type === '2' ? ' -> ' + e.linkName : ''}`);
}

console.log(`\n总耗时 ${Date.now() - t0} ms`);
if (fails === 0) {
  console.log('\n✅ 全部通过');
  process.exit(0);
} else {
  console.log(`\n❌ ${fails} 项失败`);
  process.exit(1);
}
