/**
 * dsh-mobile-model-search —— 浏览器半边（客户端插件）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件是什么
 * ══════════════════════════════════════════════════════════════════
 * 给官方「选择模型」弹层加两件事：
 *   ① **提供方筛选标签**（点一下只看某个提供方 / 只看收藏）；
 *   ② **模型收藏** —— 每一行右边一颗**常驻**的 ☆/★，点一下收藏 / 取消。
 *
 * ★★ 与电脑端（`dsh-int-model-search`）唯一、也是最关键的区别：
 *    电脑端那颗星是**鼠标悬停在行上才浮出来**的（`mouseover` + 单颗浮动按钮）。
 *    手机上**没有鼠标** ⇒ 悬停这个动作根本不存在 ⇒ 那种实现等于"永远看不见"。
 *    本插件把星标改成**每一行右边常年可见**（见下面「常驻星标」那一节）——
 *    这是用户 m07805 的明确要求，也是这次移植的核心改动。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么另开一个插件，而不是塞进 dsh-mobile-adapt
 * ══════════════════════════════════════════════════════════════════
 * 用户 m07805 明确要求"另外写一个插件"。另外这也确实该分开：
 *   · `dsh-mobile-adapt` 是**移动端 UI 适配**（布局、侧栏、⋮ 菜单那一摊），
 *     它的注入体已经 12 万字节、改一次要真机回归十几项；
 *   · 本插件只动「选择模型」这一个弹层，坏了不影响别处；
 *   · 两者**生命周期完全不同** —— 适配插件跟着内核改版走，本插件是个功能件。
 * ★ 代价是两者**都往同一张菜单里插东西**，会撞车：`dsh-mobile-adapt` 里那份
 *   同名功能（`installModelSearch`）必须退役，否则一张菜单里会出现两套标签条。
 *   退役动作见 `docs` 里的施工记录（`feature("modelSearch", …)` 那一行摘掉）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 搜索框：**我们不建**（这是探测出来的，不是拍脑袋）
 * ══════════════════════════════════════════════════════════════════
 * 官方新内核已经自带搜索。真机实测（2026-10-06，Playwright 直连 3080，
 * viewport 921×993）：
 *   · 外层 `div[role="group"]`（fixed）里有 4 sections / 40 radios / **1 searchbox**；
 *   · 它**内含**的 `div[role="menu"]._7KE1Ra_groups.scrollable`（static）有
 *     4 sections / 40 radios / **0 searchbox** —— 分组容器自己就是 `role="menu"`。
 *   · 官方搜索框 = `INPUT[role="searchbox"]._input_14sgc_25`，placeholder 与
 *     aria-label 都是「搜索模型…」；用原生 setter 写 `value='GLM'` 再派发
 *     `new Event('input',{bubbles:true})` ⇒ 可见行 40 → **6** ⇒ 它是真能用的。
 * ⇒ 判据与电脑端 `officialHasSearch()` 完全一致（分组容器自己 `role="menu"`
 *   就是新内核）⇒ **一个输入框都不建**，避免一张菜单里两个搜索框。
 *
 * ══════════════════════════════════════════════════════════════════
 * 锚点：只用官方**语义属性**，一个 CSS module 哈希类名都不碰
 * ══════════════════════════════════════════════════════════════════
 * 真机菜单结构（已实测）：
 *   一级 `div[role="menu"]._7KE1Ra_menu`（fixed）
 *     └ 两个 `button[role="menuitem"]._7KE1Ra_cell`（「模型」/「推理等级」）—— 无 section
 *   点「模型」→ 二级：
 *     `div[role="group"]._surface_ri079_1._7KE1Ra_menu`（fixed，含官方搜索行）
 *       └ `div[role="menu"]._7KE1Ra_groups.scrollable`（static，**滚动容器**）
 *           └ 4 × `section[role="group"]._group_121p8_1[aria-labelledby]`
 *               └ `button[role="menuitemradio"]._7KE1Ra_modelOption[title]` ×40
 * ⇒ 锚点只用 `div[role="menu"]` + `section[role="group"][aria-labelledby]` +
 *   `button[role="menuitemradio"][title]`。
 * ★★ **提供方名字只能走 `aria-labelledby` → `getElementById`**：
 *   真机实测 `section.querySelector('[class*="_groupTitle"]')` = **null**，
 *   `section.firstElementChild` 是 `span._start_121p8_5`（1px、文本为空）——
 *   真标题是 `div._heading_121p8_19`。
 *   `dsh-mobile-adapt` 那份实现正是先查类名再退 `firstElementChild` ⇒ 两个都取不到
 *   ⇒ chips **恒空**（实测 `chipsChildren=0`）。本插件不重蹈覆辙。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★★ 常驻星标：为什么用浮层而不是往行里塞按钮
 * ══════════════════════════════════════════════════════════════════
 * 「常驻」= 每一行右边固定有一颗可见的 ☆/★。有两种实现：
 *
 *   A. 往每一行 `appendChild` 一个 `<button>`；
 *   B. 挂在 `document.documentElement` 下的**独立浮层**里，每行一颗，
 *      用 `getBoundingClientRect()` 跟着行跑。
 *
 * 选 **B**，与电脑端同源，两个理由：
 *   · **绝不往 React 的行里塞子节点** —— 那一行重渲染就会被抹掉（电脑端在
 *     真跑里证实过）；而我们的属性 / 样式 React 不管理，re-render 也不会删。
 *   · 顺带绕开菜单容器的 `overflow` 裁剪（浮层在 `documentElement` 下）。
 *
 * ★ B 的代价必须自己补上（电脑端是靠 `mouseover` 每次重新定位回避的，
 *   手机没有 `mouseover`，所以这里必须**主动重排**）：
 *   · 行滚动 / 窗口改尺寸 ⇒ rAF 节流的 `scheduleLayout()` 重新定位每一颗星；
 *   · 行滚出滚动容器 ⇒ 那一颗**藏起来**（否则固定定位的星会飘在菜单外面）；
 *   · 菜单关掉 ⇒ 全部回收（`teardownStars()`）。
 *
 * ★ 给行**留出空间**：星是浮在行右端上面的，不腾地方就会压住模型名。
 *   做法是给行打一个我们自己的属性 `data-dsh-mms-row="1"`，用**我们的样式表**
 *   `padding-right:34px !important` 把右侧让出来 —— 依然不碰 React 的 children。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么"隐藏行"而不是"重画列表"
 * ══════════════════════════════════════════════════════════════════
 * 列表是 React 渲染的。筛选只给不匹配的行加/去 `data-dsh-mms-hide` 属性，
 * 由**我们自己的样式表**把它们 `display:none` —— React 不管这个属性。
 *
 * ══════════════════════════════════════════════════════════════════
 * 必须有体面的失败方式
 * ══════════════════════════════════════════════════════════════════
 * 所有 DOM 查找都在 try 里，失败就**安静退出，官方界面照常用**。
 * 最坏结果是"没有标签、没有星标"，绝不会把菜单弄坏。
 */

window.__ModuleLoader__.load({
  id: "dsh-mobile-model-search",
  factory: (require) => {
    "use strict";

    const name = "dsh-mobile-model-search";
    /** cordis 服务依赖：无（纯 DOM，不调任何官方 API） */
    const inject = [];

    function apply(ctx) {
      if (typeof document === "undefined") return;
      // 插件版的 apply 可能在 document.body 出现之前跑，而注入体里
      // observe(document.body, …) 传 null 会抛 ⇒ body 不在就等 DOMContentLoaded。
      if (document.body) { run(); }
      else { document.addEventListener("DOMContentLoaded", run, { once: true }); }
      return () => { /* 不主动拆：注入体自带幂等守卫，页面活多久它活多久 */ };

      function run() {
        runBody();
        // 身份标记：验收脚本据此确认"跑的是插件版"，不是别的注入
        try { window.__dshMobileModelSearchStats.src = "plugin"; } catch (e) { /* 忽略 */ }
      }
    }

    /** 注入体 */
    function runBody() {
      "use strict";

      (() => {
        const FLAG = "__dshMobileModelSearchInstalled";
        if (window[FLAG]) return;          // 同一页面只装一次
        window[FLAG] = true;

        const STYLE_ID = "dsh-mms-style";
        const HIDE = "data-dsh-mms-hide";
        const GHIDE = "data-dsh-mms-group-hide";
        const ROWMARK = "data-dsh-mms-row";
        const BAR = "dsh-mms-bar";

        // 星标尺寸 / 行右侧让出的宽度。★ 这两个数**必须成对**：
        // 星星落在行右侧让出的那一条里（见 layout()），让出的宽度小于星星宽度
        // 就会压住勾选标记和模型名。STAR_SIZE 同时是触摸目标大小 —— 官方行高 34px，
        // 28 还能上下各留 3px；再大就开始压相邻行的间距。
        const STAR_SIZE = 28;
        const ROW_GUTTER = 34;

        // ── 自诊断计数（留在 window 上，出问题时**能被问出来**，不靠猜）──────
        // 例如"标签名字怎么没跟着变" ⇒ 看 sweeps / applies / pillBuilds 哪个没涨。
        // `src` 是身份标记，包装层会覆写成 "plugin"。
        const stats = window.__dshMobileModelSearchStats = window.__dshMobileModelSearchStats || {
          sweeps: 0, applies: 0, pillBuilds: 0, layouts: 0, starsShown: 0, favWrites: 0, src: "inject",
        };
        // true = 官方自带搜索、我们没建输入框（本次改动的判据，验收脚本据此断言）
        if (stats.officialSearch === undefined) stats.officialSearch = null;
        if (stats.fav === undefined) stats.fav = { count: 0, source: "none", error: "" };
        // ★ 防自动弹键盘那一条链路的计数（用户 m08483 第②条）——
        //   没有这几个数就只能靠"键盘弹没弹"肉眼判断，而那是**事后**的、看不清的。
        //   · guarded  = 影子 focus 已装上（说明真找到了官方搜索框）
        //   · taps     = 用户真去点了搜索框（此时才允许弹键盘）
        //   · bounced  = 官方程序化聚焦被我们拦回菜单（>0 = 修发生了作用）
        if (stats.guarded === undefined) stats.guarded = 0;
        if (stats.taps === undefined) stats.taps = 0;
        if (stats.bounced === undefined) stats.bounced = 0;

        // ── 收藏的存取 ────────────────────────────────────────────────────
        //
        // 宿主半边（lib/index.js）是**权威**；localStorage 只是"宿主拿不到时"的兜底。
        // 顺序刻意是"先本地、再问宿主"：本地同步、界面立刻可用；宿主回来了再覆盖。
        //
        // ⚠️ 读 / 写是**两条路径**：内核 webServer.register 按 (kind, path) 去重，
        //    同一路径注册两次会**直接抛错** ⇒ 宿主那边读写各占一条（见 lib/index.js）。
        const FAV_READ_URL = "/dsh-mobile-model-search/favorites.json";
        const FAV_SAVE_URL = "/dsh-mobile-model-search/favorites/save.json";
        const FAV_LS_KEY = "dsh-mobile-model-search/favorites/v1";
        const MAX_FAV = 500;
        const MAX_FIELD = 200;

        const fav = {
          keys: [],            // [{p, m}] 有序
          set: new Set(),
          source: "none",      // host | local | local->host | none
          error: "",
          loaded: false,
        };

        function favKeyOf(p, m) { return String(p) + "\u0000" + String(m); }
        function favHas(p, m) { return fav.set.has(favKeyOf(p, m)); }

        /** 归一化一条：只要两个非空字符串，其余丢弃（宿主那边还会再归一化一遍）。 */
        function favNorm(raw) {
          if (!raw || typeof raw !== "object") return null;
          const p = typeof raw.p === "string" ? raw.p.trim().slice(0, MAX_FIELD) : "";
          const m = typeof raw.m === "string" ? raw.m.trim().slice(0, MAX_FIELD) : "";
          if (!p || !m) return null;
          return { p, m };
        }

        /** 用一份原始数组**替换**收藏内容（去重、限量、保序）。 */
        function favReplace(list) {
          const items = [];
          const set = new Set();
          if (Array.isArray(list)) {
            for (const raw of list) {
              const it = favNorm(raw);
              if (!it) continue;
              const k = favKeyOf(it.p, it.m);
              if (set.has(k)) continue;
              set.add(k);
              items.push(it);
              if (items.length >= MAX_FAV) break;
            }
          }
          fav.keys = items;
          fav.set = set;
          stats.fav.count = items.length;
        }

        function favReadLocal() {
          try {
            const raw = window.localStorage.getItem(FAV_LS_KEY);
            if (!raw) return [];
            const doc = JSON.parse(raw);
            return Array.isArray(doc) ? doc : (doc && Array.isArray(doc.items) ? doc.items : []);
          } catch (e) { return []; }
        }

        function favWriteLocal() {
          try {
            window.localStorage.setItem(FAV_LS_KEY, JSON.stringify({ version: 1, items: fav.keys }));
          } catch (e) { /* 隐私模式 / 配额满：忽略，宿主那份才是权威 */ }
        }

        /** 把当前收藏推给宿主。失败只记状态，**不打断界面**。 */
        function favPush() {
          try {
            if (typeof fetch !== "function") { fav.error = "页面里没有 fetch"; return; }
            stats.favWrites++;
            fetch(FAV_SAVE_URL, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ items: fav.keys }),
              cache: "no-store",
            }).then((r) => (r.ok ? r.json() : null)).then((j) => {
              if (j && j.ok === true) { fav.source = "host"; fav.error = ""; }
              else { fav.source = "local"; fav.error = (j && j.error) || "宿主拒绝了这次写入"; }
              stats.fav.source = fav.source;
              stats.fav.error = fav.error;
            }).catch((e) => {
              fav.source = "local";
              fav.error = String((e && e.message) || e);
              stats.fav.source = fav.source;
              stats.fav.error = fav.error;
            });
          } catch (e) {
            fav.error = String((e && e.message) || e);
          }
        }

        /** 保存：本地立刻写（同步、永不失败），再异步推宿主。 */
        function favSave() {
          favWriteLocal();
          favPush();
        }

        /**
         * 载入收藏。**先本地、后宿主**：
         *   · 宿主说 `existed === false`（那边还没这个文件）而本地有 ⇒ 把本地那份**迁上去**
         *     （老用户从 localStorage 版本升上来时收藏不丢）；
         *   · 宿主有文件 ⇒ 以宿主为准，并回写本地做镜像。
         */
        function favLoad() {
          favReplace(favReadLocal());
          fav.source = fav.keys.length ? "local" : "none";
          stats.fav.source = fav.source;
          fav.loaded = true;
          try {
            if (typeof fetch !== "function") return;
            fetch(FAV_READ_URL, { cache: "no-store" })
              .then((r) => (r.ok ? r.json() : null))
              .then((j) => {
                if (!j || j.ok !== true) {
                  fav.source = "local";
                  fav.error = (j && j.error) || "宿主没有这条路由（宿主半边没挂上）";
                } else if (j.existed === false && fav.keys.length > 0) {
                  fav.source = "local->host";
                  favPush();                                   // 迁移：把本地这份写上去
                } else {
                  favReplace(j.items);
                  fav.source = "host";
                  fav.error = j.error || "";
                  favWriteLocal();
                }
                stats.fav.source = fav.source;
                stats.fav.error = fav.error;
              })
              .catch((e) => {
                fav.source = "local";
                fav.error = String((e && e.message) || e);
                stats.fav.source = fav.source;
                stats.fav.error = fav.error;
              });
          } catch (e) { /* 上面已经尽力，失败就用本地那份 */ }
        }

        // ── 样式 ──────────────────────────────────────────────────────────
        //
        // 用官方主题变量、每个都带兜底色（换主题跟得上、变量没了也不瞎）。
        // ★ 变量名逐个核对过主题包里的 395 个真变量：`--dsw-alias-state-warn-primary`
        //   是**收藏选中**那个橙色 —— "warning" 那个名字**不存在**，本项目为同类
        //   错误翻过车，别再改。
        const CSS = `
    [${HIDE}="1"]{display:none !important}
    [${GHIDE}="1"]{display:none !important}
    /* ★ 给常驻星标腾地方：星星浮在行右端（见 layout()），不把右侧让出来就会压住
       勾选标记和模型名。★ 用**我们自己的属性**，不碰 React 的 children ——
       行重渲染时 React 不认识这个属性、也就不会把它删掉。 */
    [${ROWMARK}="1"]{padding-right:${ROW_GUTTER}px !important}
    .${BAR}{display:flex;flex-direction:column;gap:8px;padding:8px 8px 7px;
      border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8eb);flex:none}
    .dsh-mms-pills{display:flex;flex-wrap:wrap;gap:6px;max-height:88px;overflow-y:auto;
      overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
    .dsh-mms-pill{font:inherit;font-size:12px;line-height:22px;padding:0 10px;border-radius:999px;
      border:1px solid var(--dsw-alias-border-l1,#e6e8eb);background:transparent;
      color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer;white-space:nowrap;
      flex:none;max-width:190px;overflow:hidden;text-overflow:ellipsis}
    .dsh-mms-pill[data-on="1"]{background:#4d6bfe;border-color:#4d6bfe;color:#fff;font-weight:500}
    .dsh-mms-pill[data-fav="1"][data-on="1"]{background:var(--dsw-alias-state-warn-primary,#f59e0b);
      border-color:var(--dsw-alias-state-warn-primary,#f59e0b);color:#fff}
    .dsh-mms-star{position:fixed;display:none;align-items:center;justify-content:center;
      padding:0;margin:0;box-sizing:border-box;background:transparent;border:1px solid transparent;
      border-radius:8px;cursor:pointer;
      font:16px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
      color:var(--dsw-alias-label-tertiary,#8c959f);-webkit-tap-highlight-color:transparent}
    .dsh-mms-star:active{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
    .dsh-mms-star[data-fav="1"]{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
    .dsh-mms-empty{display:flex;align-items:center;justify-content:space-between;gap:8px;
      padding:10px;font-size:13px;color:var(--dsw-alias-label-tertiary,#8c959f)}
    .dsh-mms-empty button{font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;
      border:1px solid var(--dsw-alias-border-l1,#e6e8eb);background:transparent;
      color:inherit;cursor:pointer}
    /* ★★ 压掉 adapt 遗留的那个搜索工具条（用户 m08483 报的"两个搜索框"、
       m08571 报的"上方一直在闪动"）。它的根节点属性是 data-dsh-ms="bar"。
       为什么用 CSS 而不是去删它的节点：那套是 **500ms 轮询**重建的 —— 我们删掉
       它下一秒又长出来，两边对着抢，用户看到的就是闪烁（正是要修的现象）。
       一条 display:none 让它**无论被重建多少次都不可见**，不跟它抢 DOM。
       adapt 侧那段注册已摘除，这条是"新旧页面/缓存未刷新"情况下的兜底，属纯防御。 */
    [data-dsh-ms="bar"]{display:none !important}
    [data-dsh-ms="none"]{display:none !important}
    `;

        function ensureStyle() {
          if (document.getElementById(STYLE_ID)) return;
          const s = document.createElement("style");
          s.id = STYLE_ID;
          s.textContent = CSS;
          (document.head || document.documentElement).appendChild(s);
        }

        // ── 小工具 ────────────────────────────────────────────────────────
        function mk(tag, styles, text) {
          const el = document.createElement(tag);
          if (styles) for (const k in styles) if (Object.prototype.hasOwnProperty.call(styles, k)) el.style[k] = styles[k];
          if (text != null) el.textContent = String(text);
          return el;
        }

        /**
         * 把我们自己的事件在**冒泡阶段**拦在浮层根节点上，不让宿主页面（React / 官方）看到。
         *
         * ★★ 这条对星标是**必需**的，不是保险：官方挂了
         *   `document.addEventListener("mousedown", closeOutside)`（`dsh-client-ui-model-selection`
         *   真机源码 client.js:582-590），判据是"target 既不在 rootRef 也不在 menuRef 里
         *   ⇒ setOpen(false)"。我们的星标挂在 `documentElement` 上 —— **两个 ref 都不包含它**
         *   ⇒ 不拦的话，点一下星标 = 整个菜单消失（收藏动作还会连带丢失）。
         *   ★ 触摸设备上这条更容易踩：一次点按会**合成**出 mousedown/mouseup/click，
         *     mousedown 一样会被 document 收到 ⇒ 拦的东西与鼠标完全一样。
         *   ★ 所以除了鼠标事件，还把 touchstart/touchend 一并拦掉（官方目前不听它们，
         *     但拦下来没有任何副作用，能挡住将来官方改用时踩雷）。
         *
         * ⚠️ 千万别改成"在星标自己身上用捕获阶段"：Chromium 会在捕获趟停掉
         *    同一元素冒泡阶段的监听器 ⇒ 元素在、监听器也在、`el.click()` 什么都不发生
         *    （电脑端 2026-09-20 实测事故）。
         */
        function swallowFromRoot(el) {
          ["mousedown", "mouseup", "click", "dblclick",
            "pointerdown", "pointerup", "touchstart", "touchend",
            "keydown", "keyup", "wheel", "contextmenu"].forEach((t) => {
              el.addEventListener(t, (e) => e.stopPropagation(), false);
            });
        }

        // ── 锚点查找 ──────────────────────────────────────────────────────
        /** 找到「选择模型」菜单（必须有 role=group 的分组，才认它）。 */
        function findModelMenu() {
          const menus = document.querySelectorAll('div[role="menu"]');
          for (const m of menus) {
            if (m.querySelector('section[role="group"][aria-labelledby]')) return m;
          }
          return null;
        }

        /**
         * ★★ 官方那一层「MenuSurface」（= 官方 `menuRef` 指向的元素）。
         *
         * 必须区分清楚，否则搜索框那套逻辑全是空转：
         *   真机结构（已实测）——
         *     外层 `div[role="group"]._surface_…`   ← MenuSurface，**搜索框在这里**
         *       └ 内层 `div[role="menu"]._groups.scrollable` ← findModelMenu() 返回这个，
         *                                                        分组与模型行在这里
         *   所以 `menu.querySelector('[role="searchbox"]')` **永远是 null**：
         *   搜索框是内层的**兄弟**，不是后代。
         *
         * 这个区分是"自动弹键盘"那条链路能不能生效的前提 ——
         *   ① `noteUserTap` 要认得出"用户点的是菜单里的搜索框"；
         *   ② `bounceFocus` 要把焦点收进**官方 onBlur 认得的那一层**，收错层等于把菜单关掉。
         */
        function surfaceOf(menu) {
          try {
            let el = menu;
            for (let i = 0; i < 4 && el; i++) {
              if (el.querySelector && el.querySelector('[role="searchbox"]')) return el;
              el = el.parentElement;
            }
          } catch (e) { /* 忽略 */ }
          return (menu && menu.parentElement) || menu;
        }

        function searchBoxOf(menu) {
          try {
            const s = surfaceOf(menu);
            return s ? s.querySelector('[role="searchbox"]') : null;
          } catch (e) { return null; }
        }

        function sectionsOf(menu) {
          return Array.from(menu.querySelectorAll('section[role="group"][aria-labelledby]'));
        }

        function groupTitleOf(section) {
          const id = section.getAttribute("aria-labelledby");
          const el = id ? document.getElementById(id) : null;
          return (el && el.textContent ? el.textContent : "").trim();
        }

        function rowsOf(section) {
          let rows = Array.from(section.querySelectorAll(':scope > button[role="menuitemradio"]'));
          if (!rows.length) rows = Array.from(section.querySelectorAll('button[role="menuitemradio"]'));
          return rows;
        }

        function modelNameOf(row) {
          return (row.getAttribute("title") || row.textContent || "").trim();
        }

        function haystackOf(row) {
          return ((row.getAttribute("title") || "") + " " + (row.textContent || "")).toLowerCase();
        }

        /**
         * 官方这个菜单**自带搜索**吗。
         * ① 结构判据（主）：分组容器自己就是 `role="menu"` ⇒ 新内核（真机实测成立）。
         * ② 兜底：菜单里已经坐着 `[role="searchbox"]`。
         * 认不出来按"没有"处理是不可取的（会多一个搜索框），但按"有"处理会少功能 ——
         * 这里沿用电脑端的取舍：**两条任一成立就算有**，都不成立才算没有。
         */
        function officialHasSearch(menu, groupsContainer) {
          try {
            if (groupsContainer && groupsContainer.getAttribute("role") === "menu") return true;
            if (menu.querySelector('[role="searchbox"]')) return true;
          } catch (e) { /* 认不出来按"没有" */ }
          return false;
        }

        // ── 建标签条 ──────────────────────────────────────────────────────
        function buildBar(menu, groupsContainer) {
          ensureStyle();

          const hasOfficial = officialHasSearch(menu, groupsContainer);
          stats.officialSearch = hasOfficial;

          const bar = document.createElement("div");
          bar.className = BAR;

          // ★★ 我们**一个输入框都不建**（用户 m08575 的决定：官方搜索框永远在，
          //    我们自己那个彻底关掉）。
          //
          //    为什么连"官方没有时才建"这条兜底也一并删掉 —— 那条分支**本身就是
          //    第二个搜索框的来源**：判据一旦在某次内核改动里失手，用户看到的就是
          //    两个框（这正是 m08483 报的障）。而这类兜底永远不会在"官方真的有搜索"
          //    的机器上被执行到 ⇒ 零收益、纯风险。
          //    ⇒ 搜索交给官方，我们只出标签与星标。

          const pills = document.createElement("div");
          pills.className = "dsh-mms-pills";
          bar.appendChild(pills);

          // ★ 插在分组容器的**紧前面**（不是 menu 的第一个孩子）：menu 的第一个孩子
          //   可能是"模型 / 推理等级"那两个切换项，插到它们前面会跑到菜单最顶部。
          groupsContainer.parentElement.insertBefore(bar, groupsContainer);

          const empty = document.createElement("div");
          empty.className = "dsh-mms-empty";
          empty.style.display = "none";
          groupsContainer.parentElement.insertBefore(empty, groupsContainer.nextSibling);

          const st = {
            bar, pills, empty, groups: groupsContainer,
            groupEl: null, groupName: null, favOnly: false, applying: false,
          };
          menu.__dshMms = st;

          return st;
        }

        /**
         * 把标签条 / 空态**挪回**分组容器前面。
         * 原因：新内核的 `MenuSurface` 在 root ↔ model 两个面板之间**是同一个元素**，
         * React 只增删它自己的孩子；我们那两个节点是它不认识的"外来户"，
         * 切换面板后位置可能落到别处。每次 sweep 顺手对一下位置。
         */
        function reseatBar(st) {
          try {
            const gc = st.groups;
            if (!gc || !gc.parentElement) return;
            const parent = gc.parentElement;
            if (st.bar.parentElement !== parent || st.bar.nextElementSibling !== gc) {
              parent.insertBefore(st.bar, gc);
            }
            if (st.empty.parentElement !== parent || st.empty.previousElementSibling !== gc) {
              parent.insertBefore(st.empty, gc.nextSibling);
            }
          } catch (e) { /* 位置对不上不影响功能，下次 sweep 再试 */ }
        }

        // ── 过滤 ──────────────────────────────────────────────────────────
        //
        // ★★ 这里修的是一个**真 bug**（电脑端用户报的"点那些标签后整个列表会消失"），
        //    根因不在"筛选算错了"，而在**焦点**。完整链条：
        //      ① 官方根节点上有 `onMouseDown: if (target.closest("button")) preventDefault()`
        //         ⇒ 点胶囊时焦点**根本不会落到胶囊上**；
        //      ② 官方开菜单时会把焦点 `focus()` 到**当前选中的那一行**
        //         （手机端 40 个模型 ⇒ 有搜索框 ⇒ 聚焦在官方搜索框上，见下）；
        //      ③ 我们一旦把焦点所在的那一段 `display:none`，焦点无处可去、掉到 `<body>`；
        //         官方根节点的 `onBlur`（真机源码 client.js:769-772：
        //         `if (event.relatedTarget instanceof Node && (rootRef…contains || menuRef…contains)) return; close();`）
        //         看到 relatedTarget 既不在 rootRef 也不在 menuRef ⇒ **close() ⇒ 菜单消失**。
        //    ⇒ 修法：**落 display 之前，先把焦点收回菜单里的一个安全落点**（见 focusSink）。
        //      顺序绝不能反：先藏再收，焦点已经掉出去了，收不回来。
        function apply(menu) {
          const st = menu.__dshMms;
          if (!st || st.applying) return;
          st.applying = true;
          stats.applies++;
          try {
            // ★ q 恒为空（我们不再有搜索框，见 buildBar）：官方的搜索框负责
            //   关键词过滤，它自己会把不匹配的行从 DOM 里去掉。保留下面的 q
            //   分支只为兼容"行被我们自己藏起来"的那条老路径，不改行为。
            const q = "";
            const sections = sectionsOf(menu);

            const names = sections.map(groupTitleOf);
            const counts = sections.map((s) => rowsOf(s).length);

            // ★ 选中的分组按**元素身份**认，不按名字字符串：官方原地改分组名时只改
            //   文本节点（characterData），元素不换。名字一变，胶囊上留存的旧字符串
            //   就一个分组都匹配不上 ⇒ 整张列表被藏空。身份认领对"原地改名"免疫。
            let selName = st.groupName || null;
            if (st.groupEl) {
              let at = sections.indexOf(st.groupEl);
              if (at < 0 && st.groupName) at = names.indexOf(st.groupName);
              if (at >= 0) { st.groupEl = sections[at]; selName = names[at]; }
              else { st.groupEl = null; selName = null; }   // 认不出来就放开：宁可显示全部
            } else if (selName && names.indexOf(selName) < 0) {
              selName = null;
            }
            st.groupName = selName;

            // 这一张菜单里有几个收藏（收藏胶囊上的数字：点它会看到的条数）
            let favInMenu = 0;
            if (fav.set.size) {
              for (const sec of sections) {
                const g = groupTitleOf(sec);
                for (const row of rowsOf(sec)) {
                  const m = modelNameOf(row);
                  if (m && favHas(g, m)) favInMenu++;
                }
              }
            }

            // 标签行：分组 > 1 时出「全部 + 各提供方」；收藏有货时**永远**出「收藏」
            // （只有一个提供方又还没收藏时整行不出 —— 那是它没意义、白占地方的时候）
            const showProviderPills = names.length > 1;
            const showFavPill = showProviderPills || fav.set.size > 0;
            if (showProviderPills || showFavPill) {
              st.pills.style.display = "";
              const total = counts.reduce((a, b) => a + b, 0);
              const want = [];
              if (showFavPill) want.push("\u2605 \u6536\u85cf " + favInMenu);
              if (showProviderPills) want.push("\u5168\u90e8 " + total);
              if (showProviderPills) names.forEach((n, i) => want.push(n + " " + counts[i]));
              if (st.pills.__dshWant !== want.join("|")) {
                st.pills.__dshWant = want.join("|");
                stats.pillBuilds++;
                st.pills.innerHTML = "";
                const mkPill = (label, value, sec, isFav) => {
                  const b = document.createElement("button");
                  b.type = "button";
                  b.className = "dsh-mms-pill";
                  b.textContent = label;
                  b.title = label;                      // 名字被 max-width 截断时还能看全名
                  b.dataset.value = value == null ? "" : value;
                  if (isFav) b.dataset.fav = "1";
                  b.__dshSec = sec || null;             // ★ 身份：这颗胶囊代表哪一段
                  b.__dshFav = !!isFav;
                  // ★ 与星标（makeStar）保持**同构**：先 preventDefault 掉 mousedown。
                  //   理由：移动端 WebView 在 mousedown 的默认动作里会「把焦点交给最近的
                  //   可聚焦元素」，从而可能把软键盘拉起来 —— 这正是用户报的「点标签就
                  //   弹键盘」（m08945）。星标一直有这个守卫而胶囊没有，是两者唯一的结构
                  //   差异；补上它让两条路径行为一致，click 照常触发、常驻不抢焦点。
                  b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
                  b.addEventListener("click", () => {
                    // ★ 标签之间**互斥、两个方向都清**：同时按"收藏 + 某提供方"筛，
                    //   很容易一条都不剩，而用户看不出这是两个条件叠出来的 ——
                    //   那正是"点了标签列表就消失"那份报告最容易复发的形态。
                    //   ⇒ 一次只有一个条件生效：全部 / 收藏 / 某个提供方。
                    if (b.__dshFav) {
                      st.favOnly = !st.favOnly;         // 再点一次 = 取消
                      if (st.favOnly) { st.groupEl = null; st.groupName = null; }
                    } else {
                      const on = b.__dshSec
                        ? (st.groupEl === b.__dshSec)
                        : (!st.groupEl && !st.groupName && !st.favOnly);
                      if (on) { st.groupEl = null; st.groupName = null; }
                      else { st.groupEl = b.__dshSec || null; st.groupName = b.dataset.value || null; }
                      st.favOnly = false;
                    }
                    apply(menu);
                    scheduleLayout();
                  });
                  return b;
                };
                let at = 0;
                if (showFavPill) st.pills.appendChild(mkPill(want[at++], null, null, true));
                if (showProviderPills) {
                  st.pills.appendChild(mkPill(want[at++], null, null, false));
                  names.forEach((n, i) => st.pills.appendChild(mkPill(want[at++], n, sections[i], false)));
                }
              }
              Array.from(st.pills.children).forEach((b) => {
                const on = b.__dshFav
                  ? !!st.favOnly
                  : (b.__dshSec ? (st.groupEl === b.__dshSec) : (!st.groupEl && !st.groupName && !st.favOnly));
                b.dataset.on = on ? "1" : "0";
              });
            } else {
              st.pills.style.display = "none";
              st.groupEl = null;
              st.groupName = null;
              st.favOnly = false;
            }

            // ① 先**只算**"谁会被藏"（不落属性）—— 必须先把结果算出来，
            //    才能在落属性**之前**把焦点从"即将被藏起来的那一段"里救走（见 ②）。
            let shown = 0;
            let totalRows = 0;
            const plan = sections.map((sec) => {
              const gname = groupTitleOf(sec);
              const groupOk = !selName || gname === selName;
              const groupHitByQuery = !!q && gname.toLowerCase().includes(q);
              const rows = rowsOf(sec);
              const show = rows.map((row) => {
                totalRows++;
                const hit = !q || groupHitByQuery || haystackOf(row).includes(q);
                const favOk = !st.favOnly || favHas(gname, modelNameOf(row));
                return groupOk && favOk && hit;
              });
              const shownInGroup = show.filter(Boolean).length;
              shown += shownInGroup;
              const filtering = !!q || !!st.favOnly;
              return { sec, rows, show, secShow: groupOk && (shownInGroup > 0 || !filtering) };
            });

            // ② ★★ 焦点保护 —— 这一个 if 就是"点标签整张列表消失"的修复本体。
            const ae = document.activeElement;
            if (ae && ae !== document.body && ae !== document.documentElement
              && menu.contains(ae) && !st.bar.contains(ae)) {
              for (const p of plan) {
                const at = p.rows.indexOf(ae);
                if (!p.secShow || (at >= 0 && !p.show[at])) {
                  focusSink(st, menu);
                  break;
                }
              }
            }

            // ③ 再落属性
            for (const p of plan) {
              for (let i = 0; i < p.rows.length; i++) {
                if (p.show[i]) p.rows[i].removeAttribute(HIDE);
                else p.rows[i].setAttribute(HIDE, "1");
              }
              if (p.secShow) p.sec.removeAttribute(GHIDE);
              else p.sec.setAttribute(GHIDE, "1");
            }

            // ④ 常驻星标跟着重排（被藏起来的行不会有星）
            scheduleLayout();

            // 空态：只有"筛到 0 条"才显示（真的没有模型是官方自己的空态，别抢）
            // ★ 只在内容真的变时才重建 DOM：每次 apply 都重写会产生 childList 变更，
            //   观察者又被触发 ⇒ 无限自我循环（真烧 CPU）。
            const filtering = !!q || !!selName || !!st.favOnly;
            const emptyKey = (filtering && shown === 0 && totalRows > 0)
              ? (st.favOnly && favInMenu === 0 ? (fav.set.size > 0 ? "favGone" : "favNone") : "e" + totalRows)
              : "";
            if (emptyKey) {
              if (st.empty.__dshKey !== emptyKey) {
                st.empty.__dshKey = emptyKey;
                st.empty.innerHTML = "";
                const span = document.createElement("span");
                span.textContent = emptyKey === "favNone"
                  // ★ 与电脑端文案不同：手机没有鼠标，"把鼠标移到行上"是句废话，
                  //   直接说清楚星标在哪（这是本次移植的可见差异之一）。
                  ? "\u8fd8\u6ca1\u6709\u6536\u85cf\u4efb\u4f55\u6a21\u578b\uff08\u70b9\u6a21\u578b\u884c\u53f3\u8fb9\u7684 \u2606 \u6536\u85cf\uff09"
                  : (emptyKey === "favGone"
                    ? "\u6536\u85cf\u91cc\u7684 " + fav.set.size + " \u4e2a\u6a21\u578b\u5728\u5f53\u524d\u5217\u8868\u91cc\u627e\u4e0d\u5230\uff08\u63d0\u4f9b\u65b9\u6216\u6a21\u578b\u53ef\u80fd\u6539\u540d\u4e86\uff09"
                    : "\u6ca1\u6709\u5339\u914d\u7684\u6a21\u578b\uff08\u5171 " + totalRows + " \u4e2a\uff09");
                const btn = document.createElement("button");
                btn.type = "button";
                btn.textContent = "\u6e05\u7a7a\u7b5b\u9009\u6761\u4ef6";
                // 同 mkPill / makeStar：先挡掉 mousedown 的默认焦点转移，避免拉软键盘
                btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
                btn.addEventListener("click", () => {
                  st.groupEl = null;
                  st.groupName = null;
                  st.favOnly = false;
                  apply(menu);
                });
                st.empty.appendChild(span);
                st.empty.appendChild(btn);
              }
              st.empty.style.display = "";
            } else {
              if (st.empty.__dshKey) { st.empty.__dshKey = ""; st.empty.innerHTML = ""; }
              st.empty.style.display = "none";
            }
          } catch (e) {
            try { console.warn("[dsh-mobile-model-search] 过滤失败（已忽略）", e); } catch (e2) { }
          } finally {
            st.applying = false;
          }
        }

        /**
         * 焦点该收到哪儿去（见 apply 的 ②）。
         *
         * ★★ 只收到**菜单容器本身**，绝不碰官方搜索框。
         *   · 收给官方搜索框 ⇒ 触屏上当场弹软键盘（用户 m08483 正要修的现象），
         *     而且我们已经把它的 `focus` 影子成空操作（见 guardSearchFocus）⇒
         *     那一下**根本不会生效**，焦点照样掉到 body、官方 onBlur 把菜单关掉。
         *   · 收给 `st.input` 同理 —— 用户 m08575 已决定我们自己那个框彻底不要，
         *     `st.input` 现在恒为 null。
         *   容器要给 `tabindex="-1"`，否则 `focus()` 不生效。容器在官方
         *   `menuRef` 罩的范围内，`contains` 对自身返回 true ⇒ 不触发 onBlur。
         */
        function focusSink(st, menu) {
          const sink = menu;
          try {
            if (!sink.hasAttribute("tabindex")) sink.setAttribute("tabindex", "-1");
          } catch (e) { /* 设不上也还是试着聚焦 */ }
          try { sink.focus({ preventScroll: true }); } catch (e) { /* 聚焦失败就算了 */ }
        }

        /**
         * ★★ 官方搜索框的"自动抢焦点"抑制（用户 m08483 的第 ② 条）。
         *
         * 根因（官方源码 `dsh-client-ui-model-selection/lib/client.js:600-620`）：
         *   useEffect(..., [open, pane, showSearch]) 里
         *     if (pane === "model" && showSearch) { searchRef.current?.focus(); return; }
         * 手机 49 个模型 ⇒ showSearch 恒真 ⇒ **每次进「模型」档都聚焦搜索框**，
         * 触屏上直接弹出软键盘。用户要的是"**只有我点它才弹**"。
         *
         * 为什么不能简单 `blur()` 了事：官方 `onBlur`（同文件 :769-772）判据是
         *   `relatedTarget` 不在 rootRef / menuRef 里就 `close()` ⇒ 把焦点扔到
         *   body 等于**当场把整个菜单关掉**。所以只能把焦点挪到**菜单内部**。
         *
         * 做法分三半：
         *   ① **文档级捕获**监听 `pointerdown`/`touchstart`/`mousedown`：只要用户
         *      伸手碰的是模型菜单里的搜索框，就在元素上打 `__dshMmsUserFocus`。
         *      ★ 必须挂在 document 上而不是等 sweep 装到元素上 —— sweep 是 60ms
         *        防抖，而用户完全可能在那之前就点下去；那时若还没人记录"这是用户
         *        点的"，第二道闸会把这次点击也弹回去，变成**点不开**。
         *   ② 把该 input 的 `focus` **own property 覆盖掉**（影子掉原型上的方法）：
         *      没有用户标记时，程序化 `focus()` 变成空操作。官方 ref 拿到的就是
         *      这个元素，`searchRef.current?.focus()` 必然走到我们这层。
         *   ③ 万一标记还没装上、官方已经先把焦点抢过去了 ⇒ 把焦点挪到菜单容器
         *      本身（补 `tabindex="-1"`，否则 focus 不生效）——容器在 `menuRef` 里，
         *      `contains` 对自身返回 true ⇒ 不会触发官方 onBlur。
         */
        let guardedInput = null;

        /** ① 记录"这一下真的是用户点的"。注册在文档捕获阶段，与 sweep 时序无关。 */
        function noteUserTap(e) {
          try {
            const t = e.target;
            if (!t || t.getAttribute("role") !== "searchbox") return;
            const menu = findModelMenu();
            if (!menu) return;
            const s = surfaceOf(menu);
            if (!s || !s.contains(t)) return;      // 我们管不着别的搜索框
            if (!t.__dshMmsUserFocus) stats.taps++;
            t.__dshMmsUserFocus = true;
          } catch (e2) { /* 忽略 */ }
        }

        function guardSearchFocus(menu) {
          let input = null;
          try { input = searchBoxOf(menu); } catch (e) { input = null; }
          if (!input) return;

          if (!input.__dshMmsFocusGuard) {
            input.__dshMmsFocusGuard = true;
            const orig = input.focus;
            input.focus = function () {
              if (!input.__dshMmsUserFocus) {
                stats.bounced++;                   // 程序化聚焦被拦下（这就是修复生效的证据）
                return undefined;
              }
              try { return orig.apply(this, arguments); } catch (e) { return undefined; }
            };
            guardedInput = input;
            stats.guarded++;
          }

          // ③ 兜底：已经被抢过焦点、而用户从没点过它 ⇒ 把焦点收回菜单内部
          try {
            if (document.activeElement === input && !input.__dshMmsUserFocus) {
              focusSink(null, menu);
            }
          } catch (e) { /* 收不回来就算了，绝不因此抛出去 */ }
        }

        /**
         * ★★ 第二道闸：文档级 `focusin` 兜底（解决**时序**问题）。
         *
         * 上面 `guardSearchFocus` 是在 `sweep()` 里装的，而 sweep 是 60ms 防抖 ——
         * 官方那个 `useEffect` 在菜单刚打开时**同步**就 `focus()` 了，等我们装上
         * 影子方法时，第一次软键盘**早就弹出来了**（正是用户报的现象）。
         *
         * `focusin` 是**同步**事件（focus 一落地就派发，不像 focus 那样不冒泡），
         * 这里在捕获阶段把它截住：焦点一旦落到官方搜索框、而用户从没点过它，
         * 立刻把焦点交回菜单容器。同一个任务内 blur 掉，Android WebView
         * 就不会为它拉起软键盘。
         *
         * ★ 判据必须用"用户点过没有"而不是"是谁聚焦的" —— 我们无法区分，
         *   但可以记录真实的 `pointerdown`：只有用户真伸手点它，才允许键盘出现。
         */
        function bounceFocus(e) {
          try {
            const t = e.target;
            if (!t || t.getAttribute("role") !== "searchbox") return;
            if (t.__dshMmsUserFocus) return;              // 用户点的 ⇒ 放行
            const menu = findModelMenu();
            if (!menu) return;
            const s = surfaceOf(menu);
            if (!s || !s.contains(t)) return;             // 我们管不着别的搜索框
            // ★ 收进 `menu`（内层 role="menu"）：它在官方 menuRef 罩的范围内，
            //   `contains` 对自身返回 true ⇒ 不会触发 onBlur 把菜单关掉。
            stats.bounced++;
            focusSink(null, menu);
          } catch (e2) { /* 绝不因此抛出去 */ }
        }

        /**
         * 菜单关了（或换了一个）⇒ 清掉"用户点过搜索框"的标记。
         * ★ 必需：`MenuSurface` 在 root ↔ model 之间**是同一个元素**，若不清，
         *   用户这次点过搜索框，下次开面板时官方那个 useEffect 又会畅通无阻地
         *   把键盘弹出来 —— 正是要修的现象。
         */
        function resetSearchFocusGuard() {
          try { if (guardedInput) guardedInput.__dshMmsUserFocus = false; } catch (e) { }
          guardedInput = null;
        }

        // ── ★★★ 常驻星标 ──────────────────────────────────────────────────
        //
        // 浮层挂在 `document.documentElement`（**不往 React 的行里塞节点**），
        // 每一行一颗，位置由 `getBoundingClientRect()` 每次重排时算出来。
        //
        // ★ 与电脑端的差别：电脑端只有**一颗**星、靠 `mouseover` 决定跟哪一行；
        //   手机没有 `mouseover` ⇒ 这里**每行一颗、常驻可见**，并主动重排：
        //     · 滚动 / 改尺寸 ⇒ rAF 节流的 scheduleLayout()
        //     · 菜单关闭     ⇒ teardownStars()
        const Z = "2147483647";

        let starRoot = null;        // 浮层根（documentElement 下）
        let menuRef = null;         // 当前装饰的菜单
        const stars = new Map();    // row 元素 -> <button>

        function ensureStarRoot() {
          if (starRoot && starRoot.isConnected) return;
          starRoot = mk("div", {
            position: "fixed", left: "0", top: "0", right: "0", bottom: "0",
            zIndex: Z, pointerEvents: "none",
          });
          starRoot.setAttribute("data-dsh-mms-overlay", "root");
          document.documentElement.appendChild(starRoot);
          swallowFromRoot(starRoot);              // ★ 必需，理由见该函数注释
        }

        /** 造一颗星。事件绑定只在造的时候做一次。 */
        function makeStar(row) {
          const b = mk("button", { zIndex: Z, pointerEvents: "auto", width: STAR_SIZE + "px", height: STAR_SIZE + "px" }, "\u2606");
          b.type = "button";
          b.className = "dsh-mms-star";
          b.tabIndex = -1;                        // 刻意不进 Tab 序
          b.setAttribute("data-dsh-mms-star", "1");
          b.__dshRow = row;
          // ★ 不让它抢焦点：焦点一离开菜单，官方 onBlur / closeOutside 就可能把菜单关掉。
          //   preventDefault 掉 mousedown ⇒ 焦点原地不动，click 照常触发。
          b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
          b.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleFav(row);
          });
          return b;
        }

        function teardownStars() {
          for (const b of stars.values()) {
            try { b.remove(); } catch (e) { /* 忽略 */ }
          }
          stars.clear();
          menuRef = null;
          if (starRoot) { try { starRoot.remove(); } catch (e) { /* 忽略 */ } starRoot = null; }
          resetSearchFocusGuard();     // ★ 菜单关了 ⇒ 清掉"用户点过搜索框"的标记
        }

        /**
         * 一行此刻**真的看得见吗** —— 用 elementFromPoint，不用矩形。
         * ★ 取行内**靠左**的一点：星标浮在行的右端，用右端点问会命中我们自己的按钮。
         */
        function rowVisible(row) {
          try {
            const r = row.getBoundingClientRect();
            if (r.width < 40 || r.height < 8) return false;
            if (r.bottom < 0 || r.top > window.innerHeight) return false;
            const x = r.left + 12;
            const y = r.top + r.height / 2;
            if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
            const top = document.elementFromPoint(x, y);
            if (!top) return false;
            return top === row || row.contains(top);
          } catch (e) { return false; }
        }

        /**
         * 行的可滚动祖先（列表容器）。
         * ★ 必须有：浮层是 `position:fixed`，**不受列表容器 overflow 裁剪** ——
         *   行滚出去一半时若不管它，星就会飘在菜单外的页面上。所以要拿到容器矩形，
         *   只给"整颗星都落在容器可视区内"的行出星。
         */
        function scrollerOf(row) {
          try {
            let el = row.parentElement;
            while (el && el !== document.body && el !== document.documentElement) {
              const cs = window.getComputedStyle(el);
              if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) return el;
              el = el.parentElement;
            }
          } catch (e) { /* 找不到就算了 */ }
          return null;
        }

        /**
         * 重排所有星：该有的有、该藏起来的藏、该收掉的收。
         * ★ 只做"位置与状态"，不重建 DOM（除非某一行还没有自己的星）。
         */
        function layout() {
          stats.layouts++;
          try {
            const menu = findModelMenu();
            if (!menu) { teardownStars(); return; }
            if (menu !== menuRef) { teardownStars(); menuRef = menu; ensureStarRoot(); }
            ensureStarRoot();

            const scCache = new Map();     // 滚动容器 -> Rect（同一次重排里只算一次）

            // ★ 本轮被**显式处理过**的行（见循环末尾的兜底回收）。
            const handled = new Set();

            for (const sec of sectionsOf(menu)) {
              // ★★ 整组被筛掉时**不能直接 continue**：星挂在 `documentElement` 下的
              //    浮层里，`<section>` 变 display:none 对它毫无作用 —— 跳过就等于让
              //    这些星一直 `display:flex` 飘在页面上，而且它们在同一个位置叠成一坨。
              //    这正是用户报的「点不同标签后星星越叠越多」。先逐行收起来再跳过。
              if (sec.getAttribute(GHIDE) === "1") {
                for (const row of rowsOf(sec)) {
                  handled.add(row);
                  const b = stars.get(row);
                  if (b && b.style.display !== "none") b.style.display = "none";
                }
                continue;
              }
              const gname = groupTitleOf(sec);
              for (const row of rowsOf(sec)) {
                handled.add(row);
                let b = stars.get(row);

                // 被筛掉的行不给星（这正是"筛完只剩收藏那几行"时该有的样子）
                if (row.getAttribute(HIDE) === "1") {
                  if (b) b.style.display = "none";
                  continue;
                }
                if (!rowVisible(row)) {
                  if (b) b.style.display = "none";
                  continue;
                }

                // 让出右侧空间：给行打我们自己的属性，CSS 用 padding-right 腾地方
                if (row.getAttribute(ROWMARK) !== "1") row.setAttribute(ROWMARK, "1");

                const r = row.getBoundingClientRect();

                // 滚动容器：星必须整颗落在它的可视区内
                let sc = scCache.get(sec);
                if (sc === undefined) { sc = scrollerOf(row); scCache.set(sec, sc); }
                let top = r.top + (r.height - STAR_SIZE) / 2;
                let size = STAR_SIZE;
                if (r.height > 0 && r.height < STAR_SIZE) size = Math.max(18, r.height - 2);
                top = r.top + (r.height - size) / 2;
                if (sc) {
                  const sr = sc.getBoundingClientRect();
                  if (top < sr.top - 0.5 || top + size > sr.bottom + 0.5) {
                    if (b) b.style.display = "none";
                    continue;
                  }
                }
                if (top + size < 0 || top > window.innerHeight) {
                  if (b) b.style.display = "none";
                  continue;
                }

                // 横向：落在行右侧让出来的那一条里
                const right = r.right - ROW_GUTTER;
                let left = right + (ROW_GUTTER - size) / 2;
                left = Math.max(r.left + 2, Math.min(left, window.innerWidth - size - 2));
                top = Math.max(2, Math.min(top, window.innerHeight - size - 2));

                if (!b) { b = makeStar(row); stars.set(row, b); starRoot.appendChild(b); }

                // ★★ 只在**真的变了**的时候写 DOM（用户 m08571 报的"上方一直在闪动"）。
                //   写 `textContent` 会换掉文本节点、写 `style` 会触发样式重算 ——
                //   layout() 是每帧都可能跑的，无条件重写等于让浏览器不停地重绘，
                //   越界一点就是肉眼可见的闪烁。逐项比对后再写，稳态下零写入。
                const on = favHas(gname, modelNameOf(row));
                const glyph = on ? "\u2605" : "\u2606";
                if (b.textContent !== glyph) b.textContent = glyph;
                const favFlag = on ? "1" : "0";
                if (b.dataset.fav !== favFlag) b.dataset.fav = favFlag;
                const label = (on ? "\u53d6\u6d88\u6536\u85cf\uff1a" : "\u52a0\u5165\u6536\u85cf\uff1a") + gname + " / " + modelNameOf(row);
                if (b.title !== label) { b.title = label; b.setAttribute("aria-label", label); }
                const pressed = on ? "true" : "false";
                if (b.getAttribute("aria-pressed") !== pressed) b.setAttribute("aria-pressed", pressed);
                const sizePx = size + "px";
                if (b.style.width !== sizePx) { b.style.width = sizePx; b.style.height = sizePx; }
                const leftPx = Math.round(left) + "px";
                if (b.style.left !== leftPx) b.style.left = leftPx;
                const topPx = Math.round(top) + "px";
                if (b.style.top !== topPx) b.style.top = topPx;
                if (b.style.display !== "flex") { b.style.display = "flex"; stats.starsShown++; }
              }
            }

            // 回收：行已经不在文档里（菜单关了 / 重新渲染过）就删掉那颗星；
            // 行还在但本轮**没被任何 section 枚举到**（React 把它挪走了、或组结构变了），
            // 也必须收起来 —— 否则它就永远停在最后一次 `display:flex` 的位置上。
            for (const [row, b] of Array.from(stars)) {
              if (!row.isConnected) { try { b.remove(); } catch (e) { } stars.delete(row); continue; }
              if (!handled.has(row) && b.style.display !== "none") b.style.display = "none";
            }
          } catch (e) {
            try { console.warn("[dsh-mobile-model-search] 重排星标失败（已忽略）", e); } catch (e2) { }
          }
        }

        // rAF 节流：滚动每帧都可能触发，重排只该跑一次
        let rafId = 0;
        function scheduleLayout() {
          if (rafId) return;
          try {
            rafId = window.requestAnimationFrame(() => { rafId = 0; layout(); });
          } catch (e) {
            rafId = 0;
            layout();
          }
        }

        /** 点星：收藏 ↔ 取消。 */
        function toggleFav(row) {
          try {
            const sec = row.closest('section[role="group"][aria-labelledby]');
            if (!sec) return;
            const p = groupTitleOf(sec);
            const m = modelNameOf(row);
            if (!m) return;
            const key = favKeyOf(p, m);
            if (fav.set.has(key)) {
              fav.keys = fav.keys.filter((it) => favKeyOf(it.p, it.m) !== key);
              fav.set.delete(key);
            } else {
              if (fav.keys.length >= MAX_FAV) return;
              fav.keys.push({ p: p, m: m });
              fav.set.add(key);
            }
            stats.fav.count = fav.keys.length;
            favSave();
            scheduleLayout();                       // 立刻换 ★/☆
            const menu = findModelMenu();
            if (menu && menu.__dshMms) apply(menu);  // 更新收藏胶囊的数字 / 收藏筛选下的行
          } catch (e) {
            try { console.warn("[dsh-mobile-model-search] 收藏失败（已忽略）", e); } catch (e2) { }
          }
        }

        // ── 观察菜单出现 / 内容变化 ───────────────────────────────────────
        let timer = null;
        // ★ 菜单**内部**的文本变化也要看（characterData）：官方把分组名渲染成
        //   `group.name`，提供方重新注册时 React 只改文本节点、不换元素 ⇒ 只观察
        //   childList 的话，标签上会一直挂着过期的名字。作用域只到菜单，别扫整页。
        let menuMo = null;
        let menuMoOn = null;
        // ★ 菜单开着时每秒自查一次：分组名"原地改名"只有 characterData 变更，
        //   实测观察者**偶发漏掉**这类记录 ⇒ 用一次廉价自查把它收敛。菜单一关就停。
        let menuTick = null;

        function startTick() {
          if (menuTick) return;
          menuTick = setInterval(() => {
            if (!menuMoOn || !menuMoOn.isConnected) { stopTick(); return; }
            schedule();
          }, 1000);
        }
        function stopTick() {
          if (menuTick) { clearInterval(menuTick); menuTick = null; }
        }
        function watchMenu(menu) {
          if (menuMo && menuMoOn === menu) return;
          if (menuMo) menuMo.disconnect();
          menuMoOn = menu;
          menuMo = new MutationObserver(schedule);
          menuMo.observe(menu, { childList: true, subtree: true, characterData: true });
          startTick();
        }
        function unwatchMenu() {
          if (menuMo) menuMo.disconnect();
          menuMo = null;
          menuMoOn = null;
          stopTick();
        }

        function sweep() {
          timer = null;
          stats.sweeps++;
          try {
            const menu = findModelMenu();
            if (!menu) { unwatchMenu(); teardownStars(); return; }
            const sections = sectionsOf(menu);
            const firstSec = sections[0];
            const groupsContainer = firstSec ? firstSec.parentElement : null;
            if (!groupsContainer || !groupsContainer.parentElement) return;
            if (!menu.__dshMms) {
              buildBar(menu, groupsContainer);
            } else {
              reseatBar(menu.__dshMms);
              // ★ 兜底：万一哪天内核变成"面板切回 root 时**保留**分组容器、只把它藏起来"，
              //   筛选条件会赖在同一个元素上不走，用户重进就会看到"怎么只剩几个模型"。
              //   ⚠️ 诚实标注：**手机端当前走不到这里**（切回 root 时分组容器整个卸载、
              //      findModelMenu() 当场返回 null，上面那个分支已经接管）。面向未来的护栏。
              const st = menu.__dshMms;
              if (!sections.length && (st.groupEl || st.groupName || st.favOnly)) {
                st.groupEl = null;
                st.groupName = null;
                st.favOnly = false;
              }
            }
            watchMenu(menu);
            guardSearchFocus(menu);     // ★ 压住官方"进模型档就聚焦搜索框"（会弹软键盘）
            apply(menu);
            scheduleLayout();
          } catch (e) {
            // ★ 失败就安静退出：官方界面照常用，最坏只是没有标签/星标
            try { console.warn("[dsh-mobile-model-search] 跳过（已忽略）", e); } catch (e2) { }
          }
        }

        function schedule() {
          if (timer) return;
          timer = setTimeout(sweep, 60);   // 合并同一批 mutation
        }

        // ── 启动 ──────────────────────────────────────────────────────────
        favLoad();
        try { ensureStarRoot(); } catch (e) {
          // 星标建不出来不该影响页面本身：官方界面照常用，只是不能收藏
          try { console.warn("[dsh-mobile-model-search] 星标浮层没建起来（已忽略）", e); } catch (e2) { }
        }

        const mo = new MutationObserver(schedule);
        mo.observe(document.body, { childList: true, subtree: true });

        // ★★ 压住官方"进模型档就聚焦搜索框"（触屏上=自动弹软键盘）。
        //   注册在**捕获阶段**：官方的 focus() 是同步调的，等 sweep 的 60ms
        //   防抖跑完再装影子方法，第一次键盘早弹出来了。详见 bounceFocus 注释。
        //   `noteUserTap` 必须挂在 document 上（不是等 sweep 装到 input 上）——
        //   用户可能在下一次 sweep 之前就点下去，那一下也得算"用户点的"。
        document.addEventListener("focusin", bounceFocus, true);
        document.addEventListener("pointerdown", noteUserTap, true);
        document.addEventListener("touchstart", noteUserTap, true);
        document.addEventListener("mousedown", noteUserTap, true);

        // ★ 滚动重排（捕获阶段能收到**内层滚动容器**的事件 —— scroll 不冒泡，
        //   但捕获趟能接到）。星是 position:fixed，不重排就会停在旧位置。
        window.addEventListener("scroll", scheduleLayout, true);
        window.addEventListener("resize", scheduleLayout, true);
        // 触摸拖动列表时也会滚动；scroll 事件在移动端**滚动结束后才发**得多，
        // 所以再补一条 touchmove 让星标跟着手指走（同样节流到 rAF）。
        window.addEventListener("touchmove", scheduleLayout, { capture: true, passive: true });

        // 给验收 / 排障留一个问得出来的口子
        try {
          window.__dshMobileModelSearch = {
            stats: stats,
            menu: () => menuRef,
            stars: () => stars.size,
            fav: () => ({ keys: fav.keys.slice(), source: fav.source, error: fav.error }),
            layout: layout,
            sweep: sweep,
          };
        } catch (e) { /* 忽略 */ }

        schedule();   // 页面加载时菜单可能已经开着（重载场景）
      })();
    }

    return { name, inject, apply };
  },
});
