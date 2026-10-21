#!/usr/bin/env node
/* ★★★ 2026-10-21 容器内 PTY 桥 —— 独立终端的核心。
 *
 * 谁在用它：Android 侧的 PtyBridge.java 通过 **stdin/stdout 管道** 与本进程通信。
 *   Java → 本进程（stdin，每行一个 JSON）：{"op":"write","data":"..."} / {"op":"resize","cols":N,"rows":M}
 *   本进程 → Java（stdout，帧格式见下）：PTY 原始输出 / 事件
 *
 * ★★ 为什么输出要自己定帧，不能直接写 stdout：
 *   PTY 输出是**任意字节**（含 \r \n \x00 \xff），若直接原样写 stdout，
 *   Java 侧按行读会把它切碎，终端就花了。所以用定长头分帧：
 *       'D' + <4 字节大端长度> + <原始字节>     ← PTY 数据
 *       'M' + <一行 UTF-8 JSON> + '\n'          ← 事件（exit / error / ready）
 *   头 1 字节定类型，长度字段只对 D 帧有意义。
 *
 * ★ 为什么不复用 DSH 的 node：
 *   DSH 可能根本没起来（这正是这个终端存在的理由）。
 *   本进程用 rootfs 自带的 /opt/node/bin/node 直接跑，**不经过 DSH 的任何代码**。
 *
 * ★ 为什么用 node-pty 而不是 `script -c`：
 *   node-pty 能真正设置窗口尺寸（TIOCSWINSZ），`script` 不能，
 *   那样 vim/tmux 会按 80x24 画、在手机上完全错位。
 *   （`script` 确实能分配 PTY —— 实测 stdio 是 tty、stty size 可用 —— 但调不了尺寸。）
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/* 输出分帧                                                            */
/* ------------------------------------------------------------------ */

let outBroken = false;

/** 写一个数据帧。data 是 Buffer 或 string。 */
function writeData(data) {
  if (outBroken) return;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const head = Buffer.allocUnsafe(5);
  head[0] = 0x44;                                  // 'D'
  head.writeUInt32BE(buf.length >>> 0, 1);
  try {
    fs.writeSync(1, head);
    if (buf.length) fs.writeSync(1, buf);
  } catch (e) {
    /* EPIPE：Java 侧已经关了。自己退出，别刷日志。 */
    outBroken = true;
    shutdown(0, 'java-gone');
  }
}

/** 写一个事件帧（一行 JSON）。 */
function writeEvent(obj) {
  if (outBroken) return;
  let s;
  try { s = JSON.stringify(obj); } catch (e) { s = '{"op":"error","msg":"serialize"}'; }
  const buf = Buffer.from('M' + s + '\n', 'utf8');
  try {
    fs.writeSync(1, buf);
  } catch (e) {
    outBroken = true;
    shutdown(0, 'java-gone');
  }
}

/* ------------------------------------------------------------------ */
/* 找 node-pty                                                         */
/* ------------------------------------------------------------------ */

/** node-pty 在 rootfs 里的位置（随 DSH 一起装的）。找不到就报清楚。 */
function loadPty() {
  const tried = [];

  // ① 直接从 DSH 的 node_modules 里 require —— 它一定在（本 APK 自带）
  const cands = [
    '/opt/node/lib/node_modules/@deepseek-ai/dsh/node_modules/node-pty',
    '/opt/node/lib/node_modules/node-pty',
  ];
  for (const c of cands) {
    tried.push(c);
    try {
      if (fs.existsSync(path.join(c, 'package.json'))) return require(c);
    } catch (e) {
      tried.push(c + ' → ' + e.message);
    }
  }

  // ② 兜底：让 node 自己按常规解析（万一以后布局变了）
  try {
    return require('node-pty');
  } catch (e) {
    tried.push('require("node-pty") → ' + e.message);
  }

  throw new Error('找不到 node-pty。试过：\n  ' + tried.join('\n  '));
}

let pty = null;
let ptyProc = null;
let exitSent = false;

function shutdown(code, reason) {
  if (exitSent) return;
  exitSent = true;
  try { writeEvent({ op: 'exit', code: code | 0, reason: reason || '' }); } catch (e) { }
  try { if (ptyProc) ptyProc.kill(); } catch (e) { }
  setTimeout(() => process.exit(0), 60);
}

/* ------------------------------------------------------------------ */
/* 起 PTY                                                              */
/* ------------------------------------------------------------------ */

function start(cols, rows) {
  let ptyMod;
  try {
    ptyMod = loadPty();
  } catch (e) {
    writeEvent({ op: 'error', msg: String(e.message || e) });
    setTimeout(() => process.exit(2), 60);
    return;
  }

  /* ★ 环境：必须自己给全，不能指望从 Java 继承（Java 那边只有 app 的环境）。
   *   与 ProotLauncher.applyEnv 保持同一套口径 —— 尤其 LANG，
   *   没有它 bash/readline 会把中文提示符 meta 转义成 M-x 乱码（§82 踩过）。 */
  const env = {
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: '/root',
    USER: 'root',
    SHELL: '/bin/bash',
    PATH: '/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    COLORTERM: 'truecolor',
  };

  try {
    /* ★ cwd 用 /root（用户明确要求）：私有目录是 f2fs，git / venv / 可执行位都正常；
     *   而 /sdcard 是 FUSE，那三样全坏（§91 实测）。 */
    ptyProc = ptyMod.spawn('/bin/bash', ['-i'], {
      name: 'xterm-256color',
      cols: cols > 0 ? cols : 80,
      rows: rows > 0 ? rows : 24,
      cwd: '/root',
      env: env,
    });
  } catch (e) {
    writeEvent({ op: 'error', msg: 'spawn 失败: ' + String(e.message || e) });
    setTimeout(() => process.exit(3), 60);
    return;
  }

  ptyProc.onData((d) => writeData(d));

  ptyProc.onExit((e) => {
    shutdown(e && typeof e.exitCode === 'number' ? e.exitCode : 0, 'pty-exit');
  });

  writeEvent({ op: 'ready', pid: ptyProc.pid, cols: ptyProc.cols, rows: ptyProc.rows });
}

/* ------------------------------------------------------------------ */
/* 读 Java 发来的命令（stdin，一行一个 JSON）                            */
/* ------------------------------------------------------------------ */

let inBuf = '';
let started = false;

process.stdin.on('data', (chunk) => {
  inBuf += chunk.toString('utf8');
  let idx;
  while ((idx = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, idx);
    inBuf = inBuf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }

    if (msg.op === 'start') {
      if (started) continue;
      started = true;
      start(msg.cols | 0, msg.rows | 0);
    } else if (msg.op === 'write') {
      if (ptyProc && typeof msg.data === 'string') {
        try { ptyProc.write(msg.data); } catch (e) { }
      }
    } else if (msg.op === 'resize') {
      if (ptyProc) {
        const c = msg.cols | 0, r = msg.rows | 0;
        if (c > 0 && r > 0) {
          try { ptyProc.resize(c, r); } catch (e) { }
        }
      }
    } else if (msg.op === 'stop') {
      shutdown(0, 'requested');
    }
  }
});

process.stdin.on('end', () => shutdown(0, 'stdin-closed'));
process.stdin.on('error', () => shutdown(0, 'stdin-error'));

/* Java 侧被杀时 stdin 会断，但保险起见再挂一层 */
process.on('SIGTERM', () => shutdown(0, 'sigterm'));
process.on('SIGINT', () => { /* 交互式 bash 自己会收到 ^C，别在这里退 */ });

process.on('uncaughtException', (e) => {
  writeEvent({ op: 'error', msg: String((e && e.stack) || e) });
  setTimeout(() => process.exit(4), 60);
});
