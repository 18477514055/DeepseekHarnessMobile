/**
 * dsh-mobile-model-search —— 宿主半边（Host half）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件是干什么的
 * ══════════════════════════════════════════════════════════════════
 * 浏览器半边（`lib/client.js`）给官方「选择模型」弹层加两件事：
 *   ① **提供方筛选标签**（纯 DOM，不需要宿主）；
 *   ② **模型收藏** —— 这一件必须落盘，因为：
 *        · 浏览器半边拿不到 `fs`；
 *        · `localStorage` 是**按 origin 分的**（端口一变就看不见了，手机上
 *          dsh020 本来就是多实例多端口并存）⇒ 收藏会在换端口时凭空消失。
 *
 * 所以这里挂三条路由（只有它们，没有别的）：
 *   · `GET  /dsh-mobile-model-search/favorites.json`       —— 读收藏清单
 *   · `POST /dsh-mobile-model-search/favorites/save.json`  —— 覆盖写收藏清单
 *   · `GET  /dsh-mobile-model-search/health.json`          —— 只读诊断
 *
 * ⚠️ **一条路径只能注册一次**：内核的 `webServer.register` 按 `(kind, path)`
 *    去重，重复注册**直接抛错**（`dsh-host-webserver` 类型定义原文：*"Duplicate
 *    (kind, path) throws — route patterns are a composition-level contract"*）。
 *    所以 GET 与 POST **不能共用同一个 path** —— 电脑端 dsh-int-model-search
 *    第一版就是这么写的，被自检当场抓住（注册进去的 handler 只剩最后一个）。
 *    现在读写各占一条路径。
 *
 * 文件落在 `<DSH_HOME>/plugin-data/dsh-mobile-model-search/favorites.json`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须存在这个文件（哪怕它只做挂路由）
 * ══════════════════════════════════════════════════════════════════
 * loader 条目加载的是这个包的 **node 半边**；只有它存在，包才会出现在 profile 的
 * bundle 树里，宿主侧 `dsh-client-modules` 才会去读 `dsh.client` 声明、把
 * `lib/client.js` 组合进 combo URL。没有它 → 包加载失败 → 浏览器半边根本没有机会被公告。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条硬约束（都是本项目踩过的，别再改回去）
 * ══════════════════════════════════════════════════════════════════
 *   ① **apply 阶段绝不抛错**。本插件在 `dsh.profile.bundles` 里 ⇒ apply 抛错 =
 *      整个内核起不来、客户端打不开。所以：webServer 用**可选注入**，拿不到就降级成
 *      "只登记、不挂路由"；每个 handler 内部再各自 try/catch，坏一次请求不该拖垮插件。
 *   ② **不 import 任何内核包**。家目录用 `process.env.DSH_HOME` + `~/.dsh` 兜底解析，
 *      不 require / import 内核模块。
 *   ③ **写盘原子**：临时文件 + rename。写一半的 JSON 会让下次读取整份作废。
 *
 * ══════════════════════════════════════════════════════════════════
 * 安全边界（说清楚，别让人以为它比实际更安全）
 * ══════════════════════════════════════════════════════════════════
 *   · 只读 / 只写**我们自己的那一个文件**，路径由本文件拼死，**不接受调用方给路径**；
 *   · 请求体只收 `{ items: [{p, m}] }`，逐条做类型与长度校验，条数上限 500；
 *   · 路由挂在**本机内核的 web 服务器**上，和内核其它接口同源、同一套鉴权。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const name = "dsh-mobile-model-search";

/**
 * ★ 路由前缀**刻意与电脑端不同**（电脑端是 `/dsh-model-search`）。
 *   两台设备可能同时开着同一个浏览器、连到不同主机的 DSH；前缀分开能让
 *   "这条收藏到底存在哪台机器上"在抓包/日志里一眼可辨，也避免将来某天
 *   把两套插件装进同一个 profile 时路由冲突（那会直接抛错，见文件头 ⚠️）。
 */
const PREFIX = "/dsh-mobile-model-search";
const PATH_FAVORITES = PREFIX + "/favorites.json";
const PATH_FAVORITES_SAVE = PREFIX + "/favorites/save.json";
const PATH_HEALTH = PREFIX + "/health.json";

/** 只声明 webServer；仍走可选注入，绝不因为"没声明就访问"而抛错。 */
const inject = ["webServer"];

/** 收藏条数上限（防御性：正常用户收藏几十个就到头了）。 */
const MAX_ITEMS = 500;
/** 单个字段（提供方名 / 模型名）长度上限。 */
const MAX_FIELD = 200;
/** 请求体上限 256 KiB —— 500 条 × 两个字段远远用不到这么多。 */
const MAX_BODY = 256 * 1024;

// ── 家目录解析 ────────────────────────────────────────────────────────
//
// 优先级：$DSH_HOME → ~/.dsh → 插件目录下 `.data`（一定可写）。
// ★ 不用内核的 home-paths 包：见文件头约束 ②。
//   手机上（proot 容器内）DSH_HOME / HOME 都是设好的 —— 容器里跑的是
//   `node .../bin.js web`，家目录就是 `/root/.dsh`。
//
// ★★ 解析结果与来源**要能被问出来**：凡是"找不到"，都要把搜索范围报出来。

/** 一个目录"像个 DSH 家"吗。 */
function looksLikeHome(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false;
    return ["profiles", "storages", "sessions", "settings.yaml", "skills", "safety"]
      .some((n) => fs.existsSync(path.join(dir, n)));
  } catch {
    return false;
  }
}

/** 插件自己的安装目录（package 根）。 */
function pluginDir() {
  try {
    // ★ 用 fileURLToPath 而不是自己切 URL.pathname：百分号编码会搞坏路径。
    return path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  } catch {
    return process.cwd();
  }
}

/** 解析数据目录。**绝不抛**：任何异常都退到插件目录下的 `.data`。 */
function resolveDataDir() {
  const out = { dir: "", source: "", home: "" };
  try {
    const envHome = process.env.DSH_HOME && process.env.DSH_HOME.trim();
    if (envHome) {
      out.home = path.resolve(envHome);
      if (looksLikeHome(out.home)) {
        out.dir = path.join(out.home, "plugin-data", name);
        out.source = "env:DSH_HOME";
        return out;
      }
    }
  } catch { /* 继续往下试 */ }
  try {
    const def = path.join(os.homedir(), ".dsh");
    if (looksLikeHome(def)) {
      out.home = def;
      out.dir = path.join(def, "plugin-data", name);
      out.source = "default:~/.dsh";
      return out;
    }
  } catch { /* 继续 */ }
  // 兜底：插件目录下（一定可写；安装形态变化时数据会丢，但至少能用）
  try {
    out.dir = path.join(pluginDir(), ".data");
    out.source = "plugin-fallback";
  } catch {
    out.dir = "";
    out.source = "none";
  }
  return out;
}

/** 收藏文件路径（数据目录解析不出来时返回 ""）。 */
function favoritesFile(dir) {
  return dir ? path.join(dir, "favorites.json") : "";
}

// ── 读写 ──────────────────────────────────────────────────────────────

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch { /* 客户端已断开：忽略 */ }
}

function readBodyText(req, limit = MAX_BODY) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { finish(""); try { req.destroy(); } catch { /* 忽略 */ } return; }
      chunks.push(c);
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => finish(""));
  });
}

/**
 * 归一化一条收藏项。**只认 `{p, m}` 两个字符串字段**（提供方名 + 模型名），
 * 其余一律丢弃。
 *
 * ★ 为什么身份是"提供方显示名 + 模型显示名"而不是 id：官方这张弹层的 DOM 上
 *   **只有显示名**（行是 `title: model.name`，分组标题是 `aria-labelledby`
 *   指向的文本 —— 手机端 2026-10-06 已逐项核实，40 行全有 title）。
 *   要拿 id 就得调官方服务，而本插件刻意不依赖任何官方服务。
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const p = typeof raw.p === "string" ? raw.p.trim().slice(0, MAX_FIELD) : "";
  const m = typeof raw.m === "string" ? raw.m.trim().slice(0, MAX_FIELD) : "";
  if (!p || !m) return null;
  return { p, m };
}

/** 归一化整份清单：去重（同提供方+同模型只留一条）、限量。 */
function normalizeItems(list) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    const it = normalizeItem(raw);
    if (!it) continue;
    const key = it.p + "\u0000" + it.m;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** 读收藏清单。文件不在 / 坏了都返回空清单（**不抛**）。 */
function readFavorites(file) {
  const out = { items: [], existed: false, error: "" };
  if (!file) { out.error = "数据目录解析不出来"; return out; }
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
    out.existed = true;
  } catch (e) {
    if (e && e.code !== "ENOENT") out.error = String((e && e.message) || e);
    return out;
  }
  try {
    const doc = JSON.parse(text);
    // 兼容两种形状：`{items:[...]}`（我们写的）与裸数组（手改过的）
    out.items = normalizeItems(Array.isArray(doc) ? doc : doc && doc.items);
  } catch (e) {
    // 坏文件**不删、不覆盖**（用户可能手改坏了想救回来），只如实报告
    out.error = "文件不是合法 JSON：" + String((e && e.message) || e);
  }
  return out;
}

/** 原子写收藏清单（临时文件 + rename）。返回 {ok, error}。 */
function writeFavorites(file, items) {
  if (!file) return { ok: false, error: "数据目录解析不出来" };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    return { ok: false, error: "建目录失败：" + String((e && e.message) || e) };
  }
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  const doc = {
    version: 1,
    plugin: name,
    updatedAt: new Date().toISOString(),
    items,
  };
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
    fs.renameSync(tmp, file);            // 同目录 rename：要么旧内容、要么新内容，不会写一半
    return { ok: true, error: "" };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不重要 */ }
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 目录可写吗（真的写一个探针文件再删掉，不靠权限位猜）。 */
function probeWritable(dir) {
  if (!dir) return false;
  const probe = path.join(dir, ".write-probe-" + process.pid);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, "ok", "utf8");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    try { fs.rmSync(probe, { force: true }); } catch { /* 忽略 */ }
    return false;
  }
}

// ── 路由 ──────────────────────────────────────────────────────────────

function mountRoutes(ctx) {
  const disposers = [];
  const reg = (def) => {
    try { disposers.push(ctx.webServer.register(def)); return true; } catch { return false; }
  };

  // GET /health.json —— 只读诊断：数据目录在哪、文件在不在、可不可写
  reg({
    kind: "exact",
    path: PATH_HEALTH,
    handler: (_req, res) => {
      try {
        const { dir, source, home } = resolveDataDir();
        const file = favoritesFile(dir);
        const cur = readFavorites(file);
        sendJson(res, 200, {
          ok: true,
          plugin: name,
          dir, source, home, file,
          fileExists: cur.existed,
          fileError: cur.error,
          count: cur.items.length,
          writable: probeWritable(dir),
        });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
    },
  });

  // GET /favorites.json —— 读收藏清单
  reg({
    kind: "exact",
    path: PATH_FAVORITES,
    handler: (_req, res) => {
      try {
        const { dir, source } = resolveDataDir();
        const file = favoritesFile(dir);
        const cur = readFavorites(file);
        // ★ 把 `existed` 一并回出去：浏览器半边据此决定"要不要把本地那份迁移上来"。
        //   没有它就只能猜"宿主是空的"还是"宿主没这个文件"，猜错就会覆盖用户的收藏。
        sendJson(res, 200, {
          ok: true, items: cur.items, existed: cur.existed,
          error: cur.error, file, source,
        });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
    },
  });

  // POST /favorites/save.json —— 覆盖写收藏清单
  // （写入口刻意**与读分开一条路径**：内核按 (kind,path) 去重，同路径二次注册会抛）
  reg({
    kind: "exact",
    path: PATH_FAVORITES_SAVE,
    handler: async (req, res) => {
      try {
        const text = await readBodyText(req);
        if (!text) { sendJson(res, 400, { ok: false, error: "请求体为空或过大" }); return; }
        let doc = null;
        try { doc = JSON.parse(text); } catch (e) {
          sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
          return;
        }
        const items = normalizeItems(Array.isArray(doc) ? doc : doc && doc.items);
        const { dir, source } = resolveDataDir();
        const file = favoritesFile(dir);
        const w = writeFavorites(file, items);
        // ★ 落盘失败必须**如实报失败**（不能恒回 ok:true）—— 否则"收藏没保存"
        //   在界面上永远看不出来。
        sendJson(res, w.ok ? 200 : 500, {
          ok: w.ok, error: w.error, count: items.length, file, source,
        });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    },
  });

  return disposers;
}

function apply(ctx) {
  let disposers = [];
  let mounted = false;

  // ★ 可选注入：webServer 不在时**不该**让 apply 抛错（未声明就访问会抛，那是内核级事故）
  try {
    if (ctx && typeof ctx.inject === "function" && ctx.webServer) {
      disposers = mountRoutes(ctx);
      mounted = disposers.length > 0;
    }
  } catch {
    disposers = [];
    mounted = false;
  }

  try {
    if (typeof globalThis !== "undefined") {
      const { dir, source } = resolveDataDir();
      globalThis.__dshMobileModelSearchHost = { plugin: name, mounted, routes: disposers.length, dir, source };
    }
  } catch { /* 没有 globalThis 就算了 */ }

  return () => {
    for (const d of disposers.reverse()) {
      try { d(); } catch { /* 卸载时一个失败不该挡住其余的 */ }
    }
  };
}

export { name, inject, apply };
