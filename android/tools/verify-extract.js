// 在电脑上模拟 RootfsInstaller 的**完整解压**（不只是解析），
// 把 rootfs 展开到一个临时目录，然后检查文件树是否成立。
//
// ★ 为什么要做：
//   真机上"解压 → 检查"要装 380MB APK + 等 2 分钟。这里几秒就能验完，
//   而且能精确指出是哪个条目把文件树搞坏的。
//
// 用法：node tools/verify-extract.js [目标目录] [assetPath]
//   目标目录默认 build/verify-rootfs（会先清空）
// 退出码 0 = 全部通过。

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const destArg = process.argv[2];
const asset = process.argv[3] ||
  path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'rootfs.gz.bin');

const dest = destArg
  ? path.resolve(destArg)
  : path.join(__dirname, '..', 'build', 'verify-rootfs');

const pad = (s) => (512 - (s % 512)) % 512;
function cstr(b, o, l) { let e = o; while (e < o + l && b[e] !== 0) e++; return b.toString('utf8', o, e).trim(); }
function octal(b, o, l) {
  if (b[o] & 0x80) return 0;
  const s = b.toString('ascii', o, o + l).replace(/\0/g, ' ').trim();
  if (!s) return 0;
  const v = parseInt(s, 8);
  return Number.isNaN(v) ? 0 : v;
}
function sanitize(n) {
  let s = n.replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  while (s.startsWith('/')) s = s.slice(1);
  if (s.includes('..')) s = s.replace(/\.\./g, '_');
  return s;
}

console.log('asset :', asset);
console.log('dest  :', dest);

if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

const t0 = Date.now();
const buf = zlib.gunzipSync(fs.readFileSync(asset));
console.log(`解压 gzip: ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

let pos = 0, ln = null, ll = null;
let nDir = 0, nFile = 0, nLink = 0, nHard = 0, nSkip = 0;
const errors = [];
// 保留 tar 里的原始条目信息，供后面区分「平台限制」与「真缺失」
const byTarName = new Map();

while (pos + 512 <= buf.length) {
  const h = buf.subarray(pos, pos + 512); pos += 512;
  let zero = true;
  for (let i = 0; i < 512; i++) if (h[i] !== 0) { zero = false; break; }
  if (zero) break;

  const name = cstr(h, 0, 100);
  const mode = octal(h, 100, 8);
  const size = octal(h, 124, 12);
  const type = String.fromCharCode(h[156]);
  const link = cstr(h, 157, 100);

  if (type === 'L') { ln = buf.toString('utf8', pos, pos + size).replace(/\0/g, '').trim(); pos += size + pad(size); continue; }
  if (type === 'K') { ll = buf.toString('utf8', pos, pos + size).replace(/\0/g, '').trim(); pos += size + pad(size); continue; }
  if (type === 'x' || type === 'g') { pos += size + pad(size); continue; }

  const pre = cstr(h, 345, 155);
  const raw = ln !== null ? ln : (pre ? pre + '/' + name : name);
  const nm = sanitize(raw);
  const lk = ll !== null ? ll : link;
  ln = null; ll = null;

  const isDir = type === '5' || (type === '\0' && raw.endsWith('/')) || nm === '';
  byTarName.set(nm, { type: type === '\0' ? '0' : type, link: lk, size });

  try {
    if (nm === '') {
      // 顶层 "./"，忽略
    } else {
      const out = path.join(dest, nm);
      // 防越界
      if (!out.startsWith(dest + path.sep) && out !== dest) {
        throw new Error('路径越界');
      }
      if (type === '5') {
        fs.mkdirSync(out, { recursive: true });
        nDir++;
      } else if (type === '2') {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        try { fs.unlinkSync(out); } catch { }
        fs.symlinkSync(lk, out);
        nLink++;
      } else if (type === '1') {
        const target = path.join(dest, sanitize(lk));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        if (fs.existsSync(target)) { try { fs.unlinkSync(out); } catch { } fs.linkSync(target, out); nHard++; }
        else nSkip++;
      } else {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, buf.subarray(pos, pos + size));
        if (mode & 0o111) fs.chmodSync(out, 0o755);
        nFile++;
      }
    }
  } catch (e) {
    if (errors.length < 10) errors.push(`${nm}: ${e.message}`);
    nSkip++;
  }

  if (!isDir) pos += size + pad(size);
}

console.log(`\n展开完成 ${Date.now() - t0} ms`);
console.log(`  目录 ${nDir} / 文件 ${nFile} / 符号链接 ${nLink} / 硬链接 ${nHard} / 跳过 ${nSkip}`);

// ---------------- 检查 ----------------
let fails = 0;
let skippedByPlatform = 0;
const ok = (c, m) => { if (c) console.log('  ✅ ' + m); else { console.log('  ❌ ' + m); fails++; } };
const skip = (m) => { console.log('  ⏭️  ' + m + '（Windows 不支持，跳过）'); skippedByPlatform++; };

// ★★ Windows 限制（不是逻辑错误，必须显式区分开，否则会误判成解析 bug）：
//   ① 建符号链接需要管理员权限或开发者模式 ⇒ EPERM
//   ② chmod 基本无效 ⇒ 可执行位读不出来
//   ③ 相对链接目标会被 Windows 当成相对当前盘根来解析
//   在 Linux / WSL / macOS 上跑这个脚本时这些检查才真正有意义。
const IS_WIN = process.platform === 'win32';
if (IS_WIN) {
  console.log('\n⚠️  当前是 Windows：符号链接与可执行位两项**测不了**（平台限制，非逻辑问题）');
}

console.log('\n关键路径（跟随符号链接）：');
const stat = (p) => { try { return fs.statSync(path.join(dest, p)); } catch { return null; } };
const lstat = (p) => { try { return fs.lstatSync(path.join(dest, p)); } catch { return null; } };

for (const p of ['opt/node/bin/node', 'usr/bin/python3', 'usr/bin/bash', 'etc/os-release']) {
  // ★ 实测结论（2026-10-19）：
  //   - `usr/bin/python3` -> `python3.13`（符号链接，真实文件 6,673,712 B）
  //   - `etc/os-release`  -> `../usr/lib/os-release`（符号链接）
  //   Windows 上建不了符号链接（EPERM），所以这两个必然"看起来缺失"，
  //   **这是平台限制，不是解析错误** —— 必须在 WSL/Linux 上跑才能真验。
  const ls = lstat(p);
  const isLinkInTar = !!byTarName.get(p) && byTarName.get(p).type === '2';

  if (!ls) {
    if (IS_WIN && isLinkInTar) skip(`${p}（tar 里是符号链接，Windows 未展开）`);
    else ok(false, `${p} 缺失`);
    continue;
  }
  if (ls.isSymbolicLink()) {
    const s = stat(p);
    if (s && s.isFile()) ok(true, `${p}（${s.size} B，经符号链接）`);
    else if (IS_WIN) skip(`${p} 是符号链接，Windows 上未展开`);
    else ok(false, `${p} 符号链接无法解析`);
  } else {
    ok(ls.isFile(), `${p}（${ls.size} B）`);
  }
}

console.log('\n符号链接链（必须能穿透）：');
if (IS_WIN) {
  skip('bin 是符号链接');
  skip('bin/sh 能解析到真实文件');
} else {
  ok(!!lstat('bin') && lstat('bin').isSymbolicLink(), 'bin 是符号链接');
  const binSh = stat('bin/sh');   // bin -> usr/bin, sh -> dash
  ok(!!binSh && binSh.isFile(), 'bin/sh 能解析到真实文件（bin -> usr/bin -> dash）');
}

console.log('\n可执行位：');
if (IS_WIN) {
  skip('node / bash 可执行位');
} else {
  for (const p of ['opt/node/bin/node', 'usr/bin/bash']) {
    const s = stat(p);
    ok(!!s && (s.mode & 0o111) !== 0, `${p} 可执行 (mode=${s ? (s.mode & 0o777).toString(8) : '?'})`);
  }
}

console.log('\n体积：');
const du = (d) => {
  let total = 0;
  const walk = (p) => {
    let ents;
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(p, e.name);
      if (e.isSymbolicLink()) continue;      // 不跟随
      if (e.isDirectory()) walk(fp);
      else { try { total += fs.lstatSync(fp).size; } catch { } }
    }
  };
  walk(d);
  return total;
};
const bytes = du(dest);
ok(bytes > 1.0e9, `占用 ${(bytes / 1e9).toFixed(2)} GB > 1.0 GB`);

console.log('\n错误样本：');
if (errors.length === 0) console.log('  （无）');
else errors.forEach(e => console.log('  ' + e));

if (fails === 0) { console.log('\n✅ 全部通过'); process.exit(0); }
console.log(`\n❌ ${fails} 项失败`); process.exit(1);
