/**
 * dsh-mobile-adaption —— 服务端半（2026-09-20 新增）
 * ============================================================
 * 目的：把**网页里探测到的健康/契约报告**落盘，供 Termux 侧的
 *       `dsh-mobile-doctor` 命令读取，也供应用内 /dsh-mobile-doctor 页面渲染。
 *
 * 为什么需要它（用户核心关切「官方一升级就得重新适配」）：
 *   探测必须在**真实浏览器 DOM** 里做（Node 侧看不到 CSS 哈希有没有变），
 *   但结论又要能被命令行读到。于是最干净的通道是：
 *       浏览器探测 → POST 到本路由 → 落盘 → 两边都读同一个文件。
 *   ★ 判据只有一处写入、一处读取，避免"两边各写一遍校验规则"（本项目踩过的坑）。
 *
 * 2026-10-06 新增第二个用途：**POST /dsh-mobile/kernel-restart**
 *   （⋮ 菜单「重启内核（杀死并重拉）」的后端）。见下方「重启内核」大段注释。
 *
 * 安全：路径固定、不接收客户端传来的路径；只在 DSH 自己的服务上注册；
 *       请求体限长；JSON 解析失败返回 400；任何异常都不冒泡（不拖垮服务）。
 */

const ROUTE = "/dsh-mobile";

/** 落盘位置：DSH 家目录下的 run/，与其它运行期日志同处 */
function reportPath() {
  const home = process.env.DSH_HOME || (process.env.HOME ? process.env.HOME + "/.dsh" : "");
  return home ? home + "/run/mobile-doctor.json" : "";
}

/* ==========================================================================
   重启内核（杀死并重拉）—— ★ 2026-10-06 架构重做
   ==========================================================================
   为什么必须由「容器内投递 + 内核自杀」这套分工来做：

   ★ 能力分水岭（本项目逐一实测过，别再试别的路）：
     要「杀死内核」（= 容器 dshim 里的 node 进程），必须在 SELinux 域
     u:r:runas_app 里发信号。Termux 侧一切进程——包括 App 经 am 投递的
     RUN_COMMAND、甚至由 Termux 自己 `proot-distro login` 起的容器会话——
     都在 u:r:untrusted_app_27 域；**同 uid（10398）、不同域** ⇒ 对内核
     pid 的 kill 一律 Permission denied（实测：EACCES / rc=1）。
     ⇒ 所以「杀死内核」这件事**只能由内核自己**做。本模块恰好就跑在内核
       进程里（域 runas_app），`process.kill(process.pid, "SIGTERM")`
       还是官方 createProcessShutdown 的优雅退出路径
       （profile-boot: process.on("SIGTERM", () => interrupt(0))）。

   ★ 反过来「重新拉起」只能由 Termux 侧做：proot-distro 拒绝嵌套启动
     （检测到 TracerPid 指向 proot 就报错），且 dsh-new / 看门狗都只在
     Termux 侧；容器内进程就算被拉起来，也会随内核退出被 proot 的
     --kill-on-exit 一并回收。

   ★ 于是正解 = 分工：
       ① 容器内（本路由）经 `am startservice` 把「等端口释放 → dsh-new
          start → 装回看门狗」投递给 Termux —— 这一步实测**独立于内核生死**，
          内核随后死掉，Termux 侧照样把余下步骤跑完；
       ② 本路由回完 200 再给自己发 SIGTERM，内核优雅退出，proot 跟着退。
       ③ 页面必然断连（内核就是页面来源），App 侧的等待页会自动重连。

   ★ 为什么不再用 App 的 repair("kernel-restart") 桥：那条链路的目标进程在
     **Termux 侧**，而 Termux 侧永远杀不掉内核 —— 用户实机点「重启内核」
     报"失败"的根因就在这里。repair 桥保留为「内核已死、只需重拉」的
     恢复入口（对应 dsh-app-repair kernel-restart → dsh-kernel-relaunch）。

   ★ 本模块在启动时只加载一次（DSH 没有文件监听、没有热重载路由），所以
     改动本文件**必须重启内核才生效** —— 这正是本功能存在的理由。
   ========================================================================== */

/* Termux 侧路径：容器内 ${PREFIX} 未定义、${HOME}=/root（与 Termux 家目录是
   不同 inode），所以这里写死并留出环境变量覆盖口，方便测试。 */
const TERMUX = process.env.DSH_TERMUX_PREFIX || "/data/data/com.termux/files/usr";
const TERMUX_HOME = process.env.DSH_TERMUX_HOME || "/data/data/com.termux/files/home";
/** 只负责「重拉」的 Termux 侧脚本（杀由本进程自己做，脚本里没有 kill） */
const RELAUNCH = TERMUX + "/bin/dsh-kernel-relaunch";
/** 重拉脚本把自己的全过程写在这里，页面/命令行都可回读 */
const RELAUNCH_LOG = TERMUX_HOME + "/dsh-020/run/kernel-relaunch.log";
/** ★ 握手文件：重拉脚本一开跑就写下自己的 pid（原子 rename）。见 waitForClaim() */
const RELAUNCH_CLAIM = TERMUX_HOME + "/dsh-020/run/kernel-relaunch.claim";
/** ★ 「本轮已拉起」印记，重拉脚本用它拒绝重复投递（见脚本里的 MARK 注释） */
const RELAUNCH_MARK = TERMUX_HOME + "/dsh-020/run/kernel-relaunch.started";

/** 同一时刻只允许一次重启（连点两下不能投递两次、也不能两次自杀） */
let restarting = false;

/**
 * 经 am 把 Termux 侧脚本投递到 com.termux 的 RunCommandService。
 * ★ 必须等 am 退出（拿到退出码）再自杀：am 只是把请求交给 ActivityManager，
 *   返回 0 就代表 Termux App 已经接单，此后内核死活与它无关。
 * @returns {Promise<{ok: boolean, code?: number, error?: string}>}
 */
function dispatchRelaunch() {
  return new Promise((resolve) => {
    import("node:child_process").then(({ spawn }) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      let child;
      try {
        child = spawn(TERMUX + "/bin/am", [
          "startservice", "--user", "0",
          "-n", "com.termux/.app.RunCommandService",
          "-a", "com.termux.RUN_COMMAND",
          "--es", "com.termux.RUN_COMMAND_PATH", TERMUX + "/bin/bash",
          "--esa", "com.termux.RUN_COMMAND_ARGUMENTS", RELAUNCH,
          "--ez", "com.termux.RUN_COMMAND_BACKGROUND", "true",
          "--es", "com.termux.RUN_COMMAND_WORKDIR", TERMUX_HOME,
        ], { stdio: "ignore" });
      } catch (e) {
        return finish({ ok: false, error: String((e && e.message) || e) });
      }
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch (e) {}
        finish({ ok: false, error: "投递 am 超时（15s）" });
      }, 15000);
      child.on("error", (e) => {
        clearTimeout(timer);
        finish({ ok: false, error: String((e && e.message) || e) });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        finish({ ok: code === 0, code: code == null ? -1 : code });
      });
    }).catch((e) => resolve({ ok: false, error: String((e && e.message) || e) }));
  });
}

/**
 * 等 Termux 侧脚本用握手文件报到。
 * ★ 为什么必须等：`am` 的退出码只代表 ActivityManager 接下了这个 intent，
 *   不代表目标脚本已经在跑。若此时立刻自杀，极端情况下会「内核已死、但重拉
 *   脚本还没起来」⇒ 彻底没人拉回来。实测投递通常 1~2 秒内就落盘，所以这里
 *   等一小会儿是便宜的保险；等不到也不自杀（宁可重启失败也不能把自己弄死）。
 * @returns {Promise<{ok:boolean, pid?:string, waited:number, error?:string}>}
 */
function waitForClaim(timeoutMs = 12000, sinceMs = 0) {
  return new Promise(async (resolve) => {
    const fs = await import("node:fs/promises");
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const st = await fs.stat(RELAUNCH_CLAIM);
        /* ★ 只认「本次发起之后」写的文件：万一旧的没删干净，也不会拿上一次的
           报到冒充成功（那会导致内核白死一次）。 */
        if (st.mtimeMs >= sinceMs - 1000) {
          const txt = await fs.readFile(RELAUNCH_CLAIM, "utf-8");
          const pid = (txt || "").trim().split(/\s+/)[0];
          if (pid) return resolve({ ok: true, pid, waited: Date.now() - started });
        }
      } catch (e) { /* 还没出现，继续等 */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    return resolve({ ok: false, waited: Date.now() - started, error: "重拉脚本 " + timeoutMs + "ms 内没有报到" });
  });
}

function sendJson(res, code, obj) {
  try {
    const body = JSON.stringify(obj);
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  } catch (e) {
    try { res.statusCode = 500; res.end("{}"); } catch (e2) {}
  }
}

/** 读请求体（限 512KB，够放报告；超了直接放弃并在解析时报错） */
function readBody(req, limit) {
  return new Promise((resolve) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { try { req.destroy(); } catch (e) {} resolve(""); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => resolve(""));
  });
}

/** 回读 Termux 侧重拉脚本的日志（页面刷新回来后可看「上次重启到底做了什么」） */
async function readRelaunchLog(res) {
  try {
    const fs = await import("node:fs/promises");
    const txt = await fs.readFile(RELAUNCH_LOG, "utf-8");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(txt);
  } catch (e) {
    return sendJson(res, 404, { ok: false, error: "还没有重拉日志（还没重启过内核）" });
  }
}

async function handler(req, res) {
  try {
    const url = new URL(req.url || "/", "http://x");
    const sub = url.pathname.slice(ROUTE.length).replace(/^\/+|\/+$/g, "");
    const file = reportPath();
    if (!file) return sendJson(res, 500, { ok: false, error: "拿不到 DSH 家目录" });

    /* ---------- 重启内核 ---------- */
    if (sub === "kernel-restart") {
      if (req.method === "GET") return readRelaunchLog(res);
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "不支持的方法" });

      /* ?dry=1：只报告"会做什么"，不投递、不自杀 —— 专门留给自检/排障，
         免得为了验证一条路径把内核真杀了。 */
      if (url.searchParams.get("dry") === "1") {
        return sendJson(res, 200, {
          ok: true, dry: true,
          data: {
            pid: process.pid,
            dispatch: RELAUNCH,
            log: RELAUNCH_LOG,
            then: 'process.kill(process.pid, "SIGTERM")',
            delayMs: Number(process.env.DSH_KERNEL_RESTART_DELAY_MS) || 600,
          },
        });
      }
      if (restarting) return sendJson(res, 409, { ok: false, error: "已经在重启中，请稍候" });
      restarting = true;

      /* 先清掉上次留下的握手/印记文件：
         - 握手文件：避免把「上一次重启」的报到误当成本次的（waitForClaim 另
           外还按 mtime 复核一道）。
         - 印记文件：「同一轮只拉起一次」的那道闸门必须为本次重启重置，否则
           用户在前一次重启后 120 秒内再点一次会被脚本当作重复投递而跳过。
         删不掉也无所谓（可能本来就不存在）。 */
      const sinceMs = Date.now();
      try {
        const fs = await import("node:fs/promises");
        await fs.unlink(RELAUNCH_CLAIM);
        await fs.unlink(RELAUNCH_MARK);
      } catch (e) {}

      const d = await dispatchRelaunch();
      if (!d.ok) {
        restarting = false;
        return sendJson(res, 500, { ok: false, error: "投递重拉失败：" + (d.error || ("am rc=" + d.code)) });
      }

      /* ★ 等脚本报到再自杀（见 waitForClaim 注释）。等不到就中止本次重启：
         内核还活着、脚本没起来，这比"死了没人拉"好得多。 */
      const claim = await waitForClaim(Number(process.env.DSH_KERNEL_RESTART_CLAIM_MS) || 12000, sinceMs);
      if (!claim.ok) {
        restarting = false;
        return sendJson(res, 500, {
          ok: false,
          error: "已投递但重拉脚本没起来（" + claim.error + "），为避免内核死后无人重拉，已取消本次重启",
        });
      }

      sendJson(res, 200, {
        ok: true,
        data: {
          pid: process.pid,
          relauncher: claim.pid,
          log: RELAUNCH_LOG,
          note: "重拉脚本已就位（pid " + claim.pid + "），内核即将退出，页面会自动重连（约 20~40 秒）",
        },
      });
      /* 脚本确实活着了，现在可以安全自杀。
         走 SIGTERM 而不是 process.exit：官方 createProcessShutdown 会先 dispose
         插件（含注销本路由），比硬退干净。 */
      const delay = Number(process.env.DSH_KERNEL_RESTART_DELAY_MS) || 600;
      setTimeout(() => {
        try { process.kill(process.pid, "SIGTERM"); }
        catch (e) { try { process.exit(0); } catch (e2) {} }
      }, delay);
      return;
    }

    /* 探测报告上报：网页层 POST 过来，落盘一份 */
    if (req.method === "POST" && (sub === "report" || sub === "")) {
      const raw = await readBody(req, 512 * 1024);
      let data;
      try { data = JSON.parse(raw || "{}"); }
      catch (e) { return sendJson(res, 400, { ok: false, error: "请求体不是 JSON" }); }
      try {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        await fs.mkdir(path.dirname(file), { recursive: true });
        /* 原子替换：先写临时文件再 rename，避免读到半个文件 */
        const tmp = file + ".tmp";
        await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
        await fs.rename(tmp, file);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: "写盘失败：" + String((e && e.message) || e) });
      }
      return sendJson(res, 200, { ok: true, data: { saved: file } });
    }

    /* 读取（Termux 侧也可直接读文件，这里只是给页面用） */
    if (req.method === "GET") {
      try {
        const fs = await import("node:fs/promises");
        const txt = await fs.readFile(file, "utf-8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        return res.end(txt);
      } catch (e) {
        return sendJson(res, 404, { ok: false, error: "还没有报告（先刷新一次应用页面）" });
      }
    }
    return sendJson(res, 405, { ok: false, error: "不支持的方法" });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

export const name = "dsh-mobile-adaption";
export const inject = ["webServer"];

/* ==========================================================================
 * ★★★ 2026-10-20：Android 能力桥的**服务端转发路由**
 *
 * 浏览器端（WebView 里的 API 设置页）不能直接跑 shell，
 * 所以走：页面 fetch → 这里 → spawn `dsh-android <cmd>` → 抽象 socket → APK。
 *
 * 路由：`/dsh-mobile/api/<cmd>?args=<urlencoded>`
 * 返回：`{ ok: true, data: "<原始输出>" }` 或 `{ ok: false, error: "..." }`
 *
 * ★ 安全考量：
 *   · **只允许白名单 cmd**（见 ALLOW_CMDS），不接受任意命令
 *   · args 只做原样传参（会被 execFile 的数组形式保护，不经 shell）
 *   · 不提供文件读写类命令
 * ========================================================================== */
const API_ROUTE = "/dsh-mobile/api";

/** 允许从页面转发的命令（与 dsh-android 的子命令一一对应）。 */
const ALLOW_CMDS = new Set([
  "perms", "openperms",
  "adb",                       // 内部再按 AdbBridge 的模式/白名单把关
  "clipboard-get", "clipboard-set",
  "toast", "notify", "vibrate",
  "battery", "device",
  "tts", "tts-stop",
  "sensors", "apps", "location",
  "openurl", "share",
  "ping"
]);

/* ★★★ 2026-10-20 修：本文件是 **ESM**（package.json 里 "type":"module"），
 *   里面**不能用 `require`**。我一开始写了 require("node:child_process")，
 *   运行时报 `ReferenceError: require is not defined` —— 路由整个不工作。
 *   ⇒ 改成顶部 import。 */
import { execFile } from "node:child_process";

/* ★★★ 2026-10-20（用户报「每次 API 桥都要加载这么久，要等 1 分多钟」）：
 *
 * 根因：每次页面来一个请求，都会 `execFile("dsh-android", ...)` ——
 *   那是一个 **Node 进程**，启动 + 连抽象 socket 本身要几十上百毫秒；
 *   而在冷启动/容器刚起来时，第一次 spawn 还要等动态链接、等 /dtmp 就绪，
 *   实测波动极大（热态 0.2~1.7s，冷态可能几十秒）。
 *
 * ⇒ 两层优化：
 *   ① **结果缓存**（perms / adb status 这类状态查询，缓存 3 秒）——
 *      页面每 1.5 秒轮询一次，缓存能挡掉一半以上的 spawn。
 *   ② **失败短缓存**（10 秒）—— 桥没起来时不要每 1.5 秒重试轰炸。
 *
 * ★ 不做更激进的常驻连接：那需要父子进程长连协议，改动面大；
 *   当前这两个优化已能把「打开就等一分钟」压到「打开即有」。
 */
const CACHE_TTL_MS = 3000;
const FAIL_TTL_MS = 10000;
const cache = new Map();   // key -> { at, value }

/* ★ 长任务闸门（install-client 等）：跑着的时候拒绝为只读轮询再 spawn。
 *   见 apiHandler 里的注释。 */
let longTask = false;
let longTaskHint = "";

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  const ttl = e.value && e.value.ok ? CACHE_TTL_MS : FAIL_TTL_MS;
  if (Date.now() - e.at > ttl) { cache.delete(key); return null; }
  return e.value;
}
function cachePut(key, value) {
  cache.set(key, { at: Date.now(), value: value });
}

/* ★★★ 2026-10-20 修（用户报「点了安装就网络超时，然后整页读不了」）：
 *
 * 根因：这里 timeout 写死 **15 秒**，但 `adb install-client` 要在容器里跑
 *   `apt-get update && apt-get install -y android-tools-adb` —— **几十秒到几分钟**。
 *   15 秒一到 execFile 就把进程杀掉 ⇒ 前端收到失败 ⇒ 弹「网络超时」。
 *   更糟的是 apt 占满容器 CPU/IO，同一时刻的 perms / adb status 轮询也一起超时
 *   ⇒ 用户看到的表象是「权限和 ADB 都读不到状态」。
 *
 *   Java 侧（AdbBridge.installClient）本来就有 180 秒 waitFor，
 *   是**服务端这一层**先把它掐死的。
 *
 * ⇒ 按命令区分超时（只放宽确实会长时间跑的那几条，其余保持 15 秒以免拖死页面）：
 *   · install-client —— apt 装包，给 180 秒
 *   · adb pair / adb connect —— 要等 TLS 握手 + 网络往返，给 60 秒
 *   · 其余 —— 15 秒
 */
const TIMEOUT_DEFAULT_MS = 15000;
const TIMEOUT_LONG_MS = 180000;   // install-client（apt）
const TIMEOUT_ADB_NET_MS = 60000; // adb pair / adb connect

function timeoutFor(cmd, args) {
  if (cmd === "adb") {
    const sub = String(args || "").trim().split(/\s+/)[0] || "";
    if (sub === "install-client") return TIMEOUT_LONG_MS;
    if (sub === "pair" || sub === "connect") return TIMEOUT_ADB_NET_MS;
    return TIMEOUT_DEFAULT_MS;
  }
  return TIMEOUT_DEFAULT_MS;
}

function runCli(cmd, args) {
  const tmo = timeoutFor(cmd, args);
  return new Promise((resolve) => {
    // ★ 一律 execFile + 数组参数：不经 shell，args 里的特殊字符不会被解释
    execFile("dsh-android", [cmd].concat(args ? [args] : []),
      { timeout: tmo, maxBuffer: 4 << 20, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        if (err) {
          const died = err.killed || err.signal;
          const msg = String(stderr || err.message || err).slice(0, 4000);
          resolve({
            ok: false,
            timeout: tmo,
            error: died
              ? ("命令超时（" + Math.round(tmo / 1000) + " 秒）：" + cmd +
                 (args ? " " + args : "") + "\n" + msg)
              : msg
          });
        } else {
          resolve({ ok: true, data: String(stdout || "").slice(0, 200000) });
        }
      });
  });
}

/** 同一个 key 的并发请求合并成一次 spawn（避免轮询叠加）。 */
const inflight = new Map();
async function runCliCached(cmd, args) {
  const key = cmd + "\u0001" + (args || "");
  const hit = cacheGet(key);
  if (hit) return hit;
  if (inflight.has(key)) return inflight.get(key);

  const p = runCli(cmd, args).then((v) => {
    cachePut(key, v);
    inflight.delete(key);
    return v;
  }).catch((e) => {
    inflight.delete(key);
    return { ok: false, error: String(e) };
  });
  inflight.set(key, p);
  return p;
}

async function apiHandler(req, res) {
  try {
    const u = new URL(req.url, "http://127.0.0.1");
    // path 形如 /dsh-mobile/api/<cmd>
    const seg = u.pathname.slice(API_ROUTE.length + 1);
    const cmd = decodeURIComponent(seg || "");
    const args = u.searchParams.get("args") || "";

    if (!cmd || !ALLOW_CMDS.has(cmd)) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "命令不被允许: " + cmd }));
      return;
    }

    /* ★★★ 2026-10-20（用户报「点安装后整页读不了」的第二层原因）：
     *
     * install-client 跑 apt 期间会**长时间占满容器**，此时前端每 1.5 秒
     * 还在轮询 perms / adb status —— 每个轮询都会再 spawn 一个 node 去连桥，
     * 排在 apt 后面一起超时，页面于是显示"全部读不到"。
     *
     * ⇒ 服务端记一个**长任务闸门**：正在跑 install-client 时，
     *   只读状态查询**直接返回上次缓存（或 busy 标记）**，绝不再 spawn 抢资源。
     *   前端拿到 busy 后显示"正在安装，请稍候"并暂停轮询。 */
    const sub = cmd === "adb" ? (String(args).trim().split(/\s+/)[0] || "") : "";
    const isLongTask = (sub === "install-client");
    const isReadOnly = (cmd === "perms" || (cmd === "adb" && sub === "status"));

    if (longTask && isReadOnly) {
      const cached = cacheGet(cmd === "adb" ? "adb:status" : cmd);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        busy: true,
        busyHint: longTaskHint,
        data: cached && cached.ok ? cached.data : ""
      }));
      return;
    }

    if (isLongTask) {
      longTask = true;
      longTaskHint = "正在安装 adb 客户端（apt），可能需要几十秒到几分钟，请勿离开";
    }

    /* ★ 只对**只读状态查询**走缓存；有副作用的命令（openperms / toast / notify /
     *   vibrate / clipboard-set / adb mode 等）必须每次都真跑，不能缓存。 */
    const CACHEABLE = new Set(["perms", "adb:status", "battery", "device", "sensors", "ping"]);
    const cacheKey = cmd === "adb" ? ("adb:" + sub) : cmd;

    let out;
    try {
      out = CACHEABLE.has(cacheKey)
        ? await runCliCached(cmd, args)
        : await runCli(cmd, args);
    } finally {
      if (isLongTask) { longTask = false; longTaskHint = ""; }
    }

    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(out));
  } catch (e) {
    longTask = false; longTaskHint = "";
    try {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(e).slice(0, 2000) }));
    } catch (e2) {}
  }
}

export function apply(ctx) {
  /* ★ 注册失败也不能让插件整体失效（与 client 半的"兜底降级"同一原则） */
  try {
    ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: ROUTE, handler }));
  } catch (e) {
    try { console.warn("[dsh-mobile-adaption] 报告路由注册失败：", e); } catch (e2) {}
  }
  /* ★ 2026-10-20：Android 能力桥的转发路由 */
  try {
    ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: API_ROUTE, handler: apiHandler }));
  } catch (e) {
    try { console.warn("[dsh-mobile-adaption] API 路由注册失败：", e); } catch (e2) {}
  }
}
