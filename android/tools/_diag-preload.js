/*
 * _diag-preload.js —— DSH 启动期诊断 v6（由 NODE_OPTIONS=--require 注入）
 *
 * ★ 已查清（v3~v5，2026-10-20 21:49~21:55 实测）：
 *   · 「前 10.6 秒没有 require」= 假象，v1 的 150ms 门槛遮住了小 require；
 *     实际 T+87ms 即有第一个 require，T+2.5s 已 137 个。
 *   · 黑洞 = T+2.5s → T+12s：只 +13 个 require（累计 +10ms），
 *     却 rchar +33MB、utime +2640ms、stime +1460ms；读盘 read_bytes 全程 0、硬缺页 0。
 *     ⇒ 不是磁盘慢、不是模块加载，是**同步读了 50MB 并解析**。
 *   · v5 分组：@deepseek-ai 其余 35.6MB / client-ui bundle 7.8MB / profile 4.4MB。
 *   · v5 的缺陷：fd→路径用了粘性缓存（fd 会被复用），归属不可信。
 *
 * ★ v6 只做一件事：**给每次 ≥512KB 的同步读抓调用栈**，按「站点」聚合字节数。
 *   这一次要回答的是「谁在读」—— 是 DSH 自己的哪一段代码。
 *
 * 输出前缀 T+ ，由 Java 侧 startsWith("T+") 捕获进 proot.log。
 */
'use strict';

var T0 = Date.now();
function ms() { return Date.now() - T0; }
function say(tag, msg) { try { console.log('T+' + ms() + 'ms ' + tag + ' ' + msg); } catch (e) {} }

say('[DIAG]', 'v6 已执行，pid=' + process.pid);

var fs = null;
try { fs = require('fs'); } catch (e) {}

function readProc(file) {
  if (!fs) return null;
  try { return fs.readFileSync(file, 'latin1'); } catch (e) { return null; }
}
function readStat() {
  var s = readProc('/proc/self/stat');
  if (!s) return null;
  try {
    var i = s.lastIndexOf(')');
    if (i < 0) return null;
    var f = s.slice(i + 2).split(' ');
    return { minflt: +f[7], majflt: +f[9], utime: +f[11], stime: +f[12] };
  } catch (e) { return null; }
}
function readIO() {
  var t = readProc('/proc/self/io');
  if (!t) return null;
  var o = {}, m, re = /(\w+):\s*(\d+)/g;
  while ((m = re.exec(t))) o[m[1]] = +m[2];
  return o;
}
var snap0 = { stat: readStat(), io: readIO() };
function snapshot() { return { stat: readStat(), io: readIO() }; }
function delta(cur) {
  if (!cur || !cur.stat || !cur.io || !snap0.stat || !snap0.io) return '(无 /proc)';
  var HZ = 100, MB = 1048576;
  return 'utime+' + ((cur.stat.utime - snap0.stat.utime) / HZ * 1000).toFixed(0) + 'ms' +
         ' stime+' + ((cur.stat.stime - snap0.stat.stime) / HZ * 1000).toFixed(0) + 'ms' +
         ' 读调用+' + ((cur.io.syscr || 0) - (snap0.io.syscr || 0)) +
         ' rchar+' + (((cur.io.rchar || 0) - (snap0.io.rchar || 0)) / MB).toFixed(1) + 'MB' +
         ' 读盘+' + (((cur.io.read_bytes || 0) - (snap0.io.read_bytes || 0)) / MB).toFixed(1) + 'MB';
}

/* ---------- fd → 路径（★ 不缓存：fd 会被复用） ---------- */
function resolveFd(fd) {
  try { return fs.readlinkSync('/proc/self/fd/' + fd); } catch (e) { return 'fd:' + fd; }
}

/* ---------- ★★★ 站点聚合：按调用栈的「第一帧非 fs 帧」聚合 ---------- */
var bySite = new Map();   // site -> {bytes, n, sample}
var byPath = new Map();
var totalRead = 0;

/* 从栈里摘掉 preload 自身与 node:fs 内部的帧，取第一个业务帧 */
function siteOf(err) {
  var st = String(err && err.stack || '');
  var lines = st.split('\n');
  for (var i = 1; i < lines.length; i++) {
    var L = lines[i].trim();
    if (!L) continue;
    if (L.indexOf('_diag') >= 0 || L.indexOf('__diag') >= 0) continue;
    if (L.indexOf('node:fs') >= 0 || L.indexOf('node:internal/fs') >= 0) continue;
    if (L.indexOf('/fs.js') >= 0 || L.indexOf('/fs/promises') >= 0) continue;
    /* 去掉前面的 "at "，压掉绝对路径中段，留最后两段便于阅读 */
    L = L.replace(/^at\s+/, '');
    return L.replace(/\(file:\/\//, '(').slice(0, 150);
  }
  return '(栈不可得)';
}

function note(rawPath, bytes, cost) {
  if (bytes < 65536) return;
  var k;
  if (typeof rawPath === 'number') k = resolveFd(rawPath);
  else { try { k = String(rawPath); } catch (e) { k = '?'; } }
  k = k.replace(/^file:\/\//, '');
  totalRead += bytes;

  var e = byPath.get(k);
  if (e) { e.n++; e.bytes += bytes; } else byPath.set(k, { n: 1, bytes: bytes });

  /* ★ 只给大块抓栈，避免拖慢启动 */
  if (bytes >= 524288) {
    var site = siteOf(new Error());
    var s = bySite.get(site);
    if (s) { s.n++; s.bytes += bytes; }
    else bySite.set(site, { n: 1, bytes: bytes, sample: k.slice(-70) });
  }
}

function topSites(n) {
  var arr = [];
  bySite.forEach(function (v, k) { arr.push([v.bytes, v.n, k, v.sample]); });
  arr.sort(function (a, b) { return b[0] - a[0]; });
  var out = [];
  for (var i = 0; i < Math.min(n, arr.length); i++) {
    out.push('#' + (i + 1) + ' ' + (arr[i][0] / 1048576).toFixed(1) + 'MB×' + arr[i][1] +
             ' ← ' + arr[i][2] + ' ［例:' + arr[i][3] + '］');
  }
  return out.join('\n    ');
}

function topPaths(n) {
  var arr = [];
  byPath.forEach(function (v, k) { arr.push([v.bytes, v.n, k]); });
  arr.sort(function (a, b) { return b[0] - a[0]; });
  var out = [];
  for (var i = 0; i < Math.min(n, arr.length); i++) {
    var p = arr[i][2];
    if (p.length > 76) p = '…' + p.slice(-72);
    out.push((i + 1) + '.' + (arr[i][0] / 1048576).toFixed(1) + 'MB×' + arr[i][1] + ' ' + p);
  }
  return out.join(' ｜ ');
}

function wrapRead(obj, name, kind) {
  try {
    var orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = function (a) {
      var s = Date.now();
      var r = orig.apply(this, arguments);
      try {
        var cost = Date.now() - s, bytes = 0;
        if (kind === 'file') bytes = (r && r.length) || 0;
        else if (kind === 'sync') bytes = (typeof r === 'number' && r > 0) ? r : 0;
        if (bytes > 0) note(a, bytes, cost);
      } catch (e) {}
      return r;
    };
  } catch (e) {}
}
if (fs) {
  wrapRead(fs, 'readFileSync', 'file');
  wrapRead(fs, 'readSync', 'sync');
  try { if (fs.promises) wrapRead(fs.promises, 'readFile', 'file'); } catch (e) {}
}

/* ---------- require 计数 ---------- */
var Module = require('module');
var origLoad = Module._load;
var slow = [], loadTotal = 0, loadCount = 0, lastProgressAt = 0;

Module._load = function (request, parent, isMain) {
  var s = Date.now();
  var r = origLoad.apply(this, arguments);
  var d = Date.now() - s;
  loadTotal += d; loadCount++;
  var name = String(request);
  if (d >= 80) { slow.push([d, name]); say('[慢模块]', d + 'ms  ' + name); }
  if (loadCount % 100 === 0) {
    var now = ms();
    say('[进度]', '第 ' + loadCount + ' 个｜累计 ' + loadTotal + 'ms｜距上次 ' +
        (now - lastProgressAt) + 'ms｜' + delta(snapshot()));
    lastProgressAt = now;
  }
  return r;
};

/* ---------- 心跳 ---------- */
var beats = 0, lastBeat = 0, PERIOD = 2000;
var beat = setInterval(function () {
  var now = ms();
  var gap = lastBeat ? (now - lastBeat) : 0;
  beats++;
  say('[心跳]', '第 ' + beats + ' 次 ' + now + 'ms｜require ' + loadCount +
      '／' + loadTotal + 'ms｜同步读 ' + (totalRead / 1048576).toFixed(1) + 'MB' +
      (gap > PERIOD + 250 ? '  ★上段阻塞 ' + (gap - PERIOD) + 'ms' : ''));
  lastBeat = now;
}, PERIOD);
if (beat.unref) beat.unref();

/* ---------- 固定时点：站点报表 ---------- */
[11000, 17000, 24000, 34000].forEach(function (at) {
  var t = setTimeout(function () {
    say('[采样@' + (at / 1000) + 's]', 'require ' + loadCount + '／' + loadTotal + 'ms｜' +
        delta(snapshot()) + '｜同步读 ' + (totalRead / 1048576).toFixed(1) + 'MB');
    say('[★ 读写站点]', '\n    ' + (topSites(6) || '(尚无 ≥512KB 的读)'));
    say('[按文件]', topPaths(6));
  }, at);
  if (t.unref) t.unref();
});

/* ---------- 退出总账 ---------- */
process.on('exit', function () {
  try {
    if (beat) clearInterval(beat);
    slow.sort(function (a, b) { return b[0] - a[0]; });
    say('[总账]', '存活 ' + ms() + 'ms；require ' + loadCount + ' 次共 ' + loadTotal + 'ms');
    say('[总账]', '全程 ' + delta(snapshot()));
    say('[站点·终]', '\n    ' + (topSites(10) || '(无)'));
    say('[大文件榜]', topPaths(15));
  } catch (e) {}
});

process.on('unhandledRejection', function (e) {
  say('[未处理拒绝]', (e && e.message) || String(e));
});
