#!/usr/bin/env node
/**
 * dsh-android —— 容器内的 Android 能力客户端
 *
 * ══════════════════════════════════════════════════════════════════
 * 它连什么
 * ══════════════════════════════════════════════════════════════════
 * 连 APK 主进程监听的 **Linux 抽象命名空间 Unix socket**
 * （名字 `\0dsh.mobile.api`，去掉首字节后显示为 `@dsh.mobile.api`）。
 *
 * ★ 抽象 socket 没有文件、没有路径，**proot 不拦它** ——
 *   所以容器内能直接 connect 出来，不需要任何 bind mount。
 *   这是本方案能成立的全部原因（详见 ApiBridge.java 的注释）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 协议
 * ══════════════════════════════════════════════════════════════════
 *   请求: `<cmd>\u0001<arg1>\u0001<arg2>\n`
 *   响应: `OK\n<payload>\n` 或 `ERR\n<msg>\n`
 *
 * ══════════════════════════════════════════════════════════════════
 * 用法
 * ══════════════════════════════════════════════════════════════════
 *   dsh-android ping
 *   dsh-android clipboard-get
 *   dsh-android clipboard-set "要复制的内容"
 *   dsh-android toast "提示"
 *   dsh-android notify "标题" "正文"
 *   dsh-android vibrate 300
 *   dsh-android battery            # 输出 JSON
 *   dsh-android device             # 输出 JSON
 *   dsh-android openurl https://example.com
 *   dsh-android share "要分享的文本"
 *
 * 退出码：0 成功、1 失败（ERR）、2 连不上（桥没起）
 */

'use strict';

const net = require('net');

const SOCKET_NAME = '\0dsh.mobile.api';   // 首字节 \0 = 抽象命名空间
const SEP = '\u0001';

const CMDS = {
  // ---- 基础 ----
  'ping':           () => ['ping'],
  'battery':        () => ['battery'],
  'device':         () => ['device'],

  // ---- 剪贴板 / 提示 ----
  'clipboard-get':  () => ['clipboard.get'],
  'clipboard-set':  (a) => ['clipboard.set', a.join(' ')],
  'toast':          (a) => ['toast', a.join(' ')],
  'notify':         (a) => ['notify', a[0] || '', a.slice(1).join(' ')],
  'vibrate':        (a) => ['vibrate', a[0] || '200'],

  // ---- 打开 / 分享 ----
  'openurl':        (a) => ['openurl', a[0] || ''],
  'share':          (a) => ['share', a.join(' ')],

  // ---- 权限引导（用户明确要求：直接跳到对应页面，不让人自己找）----
  'perms':          () => ['perms'],
  'openperms':      (a) => ['openperms', a[0] || 'app'],

  // ---- 语音 / 定位 / 传感器 / 应用 ----
  'tts':            (a) => ['tts', a.join(' ')],
  'tts-stop':       () => ['tts.stop'],
  'location':       () => ['location'],
  'sensors':        () => ['sensors'],
  'apps':           (a) => ['apps', a.join(' ')],

  // ---- ADB 扩展（默认关闭，需显式开启）----
  /* ★★★ 2026-10-20 修（用户报「切换 adb 模式失败」）：
   *
   * 原来写的是 `(a) => ['adb', a[0] || 'status', a.slice(1).join(' ')]`，
   * 而页面侧调用是 `call('adb', 'mode safe')` —— 整串 "mode safe" 被当成**一个**
   * argv 元素传进来 ⇒ a[0] = "mode safe" ⇒ 服务端把它整个塞进 sub ⇒
   * 报「未知子命令: mode safe」。
   *
   * ⇒ 这里先按空格把 args 拆开：第一个词是子命令，其余是子参数。
   *   （ADB 的 connect 端口、mode 的 off/safe/full 都不含空格，拆开安全）
   *
   * ★ 2026-10-20 补充：新增 pair / install-client 两个子命令，
   *   `pair <端口> <6位码>` 会拆成 sub="pair"、a2="<端口> <6位码>"，
   *   Java 侧再按空格取两个值 —— 格式一致。 */
  'adb':            (a) => {
    var words = (a.join(' ') || '').trim().split(/\s+/).filter(Boolean);
    var sub = words.shift() || 'status';
    return ['adb', sub, words.join(' ')];
  },
};

function usage() {
  console.error('用法: dsh-android <命令> [参数...]');
  console.error('命令: ' + Object.keys(CMDS).join(' | '));
  process.exit(64);
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) usage();
  const cmd = argv[0];
  const build = CMDS[cmd];
  if (!build) { console.error('未知命令: ' + cmd); usage(); }

  const parts = build(argv.slice(1));
  const req = parts.map(p => String(p).replace(/\n/g, ' ')).join(SEP) + '\n';

  const sock = net.connect({ path: SOCKET_NAME }, () => {
    sock.write(req);
  });

  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => { buf += d; });
  sock.on('end', () => {
    // 响应形如 "OK\n<payload>\n"
    const nl = buf.indexOf('\n');
    const status = nl >= 0 ? buf.slice(0, nl) : buf.trim();
    let payload = nl >= 0 ? buf.slice(nl + 1) : '';
    if (payload.endsWith('\n')) payload = payload.slice(0, -1);

    if (status === 'OK') {
      if (payload) process.stdout.write(payload + '\n');
      process.exit(0);
    } else {
      console.error(payload || status || '未知错误');
      process.exit(1);
    }
  });
  sock.on('error', (e) => {
    console.error('连不上 Android 桥（' + e.code + '）。可能 App 没在运行？');
    process.exit(2);
  });
  /* ★★★ 2026-10-20 修（用户报「点安装就超时」的**第三层**根因）：
   *
   * 这里原来是写死的 **10 秒**。而 `adb install-client` 要在容器里跑 apt
   * （几十秒到几分钟），`adb pair` 要等 TLS 握手 —— 10 秒必然先被它掐断，
   * 表现为只打印一个「超时」然后 exit 3。
   *
   * 前面两层（服务端 execFile 15s、Java waitFor）都已放宽，
   * 但**这一层才是最先触发的那个** —— 10.5 秒返回就是这么来的。
   *
   * ⇒ 按命令区分：install-client 给 190s（比 Java 的 180s 多留余量），
   *   pair/connect 给 70s，其余仍 10s（普通查询本来就快，短超时能早发现桥挂了）。
   */
  const words = (build === CMDS['adb'] && argv[1])
    ? String(argv[1]).trim().split(/\s+/) : [];
  const sub = words[0] || '';
  let sockTimeout = 10000;
  if (cmd === 'adb') {
    if (sub === 'install-client') sockTimeout = 190000;
    else if (sub === 'pair' || sub === 'connect') sockTimeout = 70000;
  }
  // 防止服务端不关连接时卡死
  sock.setTimeout(sockTimeout, () => {
    console.error('超时（' + Math.round(sockTimeout / 1000) + ' 秒）');
    try { sock.destroy(); } catch (_) {}
    process.exit(3);
  });
}

main();
