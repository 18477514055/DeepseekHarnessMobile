window.__ModuleLoader__.load({
  id: "dsh-mobile-adaption",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var CSS = `
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
html, body { overscroll-behavior-y: contain; }
body { padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); }

/* ===== 去掉安卓 Chrome 的点击蓝框闪烁 =====
   App 自己从没设过 -webkit-tap-highlight-color，所以每个原生按钮点下去
   都会闪一下系统默认的半透明蓝。这个属性不继承，只能逐个/通配地关：
   触屏设备上一律关掉。纯视觉，不影响布局、不影响 :hover/:active 反馈。 */
@media (pointer: coarse) {
  *, *::before, *::after { -webkit-tap-highlight-color: transparent; }
}
/* 手机上关掉 App 原生 Tooltip（触屏没有 hover，点完按钮 500ms 才冒出来的黑底小字） */
@media (pointer: coarse) {
  [role="tooltip"] { display: none !important; }
}
pre, table { max-width: 100%; overflow-x: auto; }
@media (max-width: 820px) {
  [class*="stepper"] { min-width: 96px !important; }
}

/* ===== 布局总纲：网格尺寸两态恒定，侧栏改用覆盖层滑动 =====
   卡顿根因：之前靠 grid-template-columns 过渡，浏览器每帧都要把整个对话区重新布局，
   手机上基本必然掉帧。现在网格永远是「0 | 1fr | auto」——中间列尺寸一次都不变；
   展开时把 sidebarCol 移出网格流、变成整屏绝对定位层，只用 transform 滑入：
   纯合成器动画，零重排。 */
[class*="frame"] { grid-template-columns: 0 minmax(0, 1fr) auto !important; }
/* sidebarCol 出流后不再参与自动排布，中间/右侧列必须显式钉在 2、3 列 */
[class*="frame"] [class*="centerCol"] { grid-column: 2 !important; min-width: 0 !important; }
[class*="frame"] [class*="rightbarCol"] { grid-column: 3 !important; }

/* ===== ★★★ 2026-10-19（用户第 1 条）：侧边栏改成**两级展开** =====
   用户的抱怨（原话）：「侧边栏拉出来后占据整个屏幕，甚至被视为新的一层页面…
   极大的影响我的手感」。所以不再用"整屏覆盖层"。

   新模型（三个状态）：
     ① 收起 closed     —— 侧栏宽 0，主界面占满
     ② 图标轨 rail     —— 只露出图标那一窄栏，**滑出来**（translateX），停 3 秒无操作自动收回
     ③ 完整 open       —— 侧栏**原生宽度拉满 100vw**（用户 2026-10-20 实测可行），
                          主界面被自然挤成 0 宽；左滑收起

   ★ 2026-10-20 修订：原方案是"官方推挤 + 主界面 visibility:hidden"，
     用户实测后发现**直接把原生宽度拉满更简单、改动更小**，而且不用碰主区。
     已按此改（见下面 ③ 的注释）。代价是侧栏展开不再算"单独一页"，
     返回键会直接回桌面 —— 用户已知，说后面再处理。

   动画一律只用 transform（合成器），不碰 grid-template-columns。 */

/* ② 图标轨：侧栏变成贴左的窄条，从 -100% 滑入。
      ★ 用 absolute 出流，这样不会挤压主界面（用户要"图标栏是划出来的"）。
      ★ 宽度：真机截图量出来图标条约 43dp（1220px 宽 / DPR≈2.97 → 127px 物理）。
        但官方原生图标轨本身就在这个量级，**不要收得更窄**（会切图标）。
        这里取 56px = 官方侧栏收起态的常见值，且给不同图标留余量。 */
html[data-dsh-rail="1"] [class*="sidebarCol"] {
  position: absolute !important;
  left: 0 !important; top: 0 !important; bottom: 0 !important;
  width: 56px !important; min-width: 56px !important; max-width: 56px !important;
  right: auto !important;
  z-index: 29 !important;
  overflow: hidden !important;
  animation: dshRailSlideIn .24s cubic-bezier(.22,.61,.36,1);
}
html[data-dsh-rail="1"]:not([data-dsh-rail-closing]) [class*="sidebarCol"] {
  animation: dshRailSlideIn .24s cubic-bezier(.22,.61,.36,1);
}
html[data-dsh-rail-closing="1"] [class*="sidebarCol"] {
  animation: dshRailSlideOut .22s cubic-bezier(.22,.61,.36,1) forwards;
}
@keyframes dshRailSlideIn  { from { transform: translateX(-100%); } to { transform: translateX(0); } }
@keyframes dshRailSlideOut { from { transform: translateX(0); } to { transform: translateX(-100%); } }

/* ③ 完整侧栏：★★★ 2026-10-20 用户实测结论 —— **把原生宽度拉满整屏**。
   ----------------------------------------------------------------------------
   用户原话：
     「我发现这个侧边栏其实没必要做主界面消失，我刚刚试了一下，通过调整侧边栏的
       原生宽度，是可以直接把侧边栏的宽度拉满整个屏幕的…不过这意味着另外一个点就是
       侧边栏的展开状态，就不再被视为单独一页了…我倒是想这么做，后面再考虑这个返回键的问题。」

   ★★★ 2026-10-20 第二轮修正（用户报「第二步图标消失、侧栏没出现，第三步全废」）：

   上一版是给 sidebarCol 设 width:100% —— **完全错了**。
   因为网格第一列被我们固定成 0 宽，而 sidebarCol 就在第一列里，
   它的 width:100% 解析出来是 **0px** ⇒ 侧栏"消失"了，主界面也没让位。
   更糟的是接着 overlay 属性残留导致横向溢出，而手势入口有
   inHorizontalScroller() 守卫（检测到横向可滚动就直接 return）
   ⇒ **之后所有滑动全部失效**，连图标都拉不出来。

   ⇒ 正确做法：**撑开第一列**，而不是给元素设宽度。
     网格从 0 | 1fr | auto 变成 100vw | 1fr | auto：
     侧栏自然铺满整个视口，主界面被挤成 0 —— 这就是用户说的"调原生宽度"。
     官方布局完全照旧，不涉及任何定位/覆盖层。 */
html[data-dsh-sidebar-overlay="1"] [class*="frame"] {
  grid-template-columns: 100vw minmax(0, 1fr) auto !important;
}
html[data-dsh-sidebar-overlay="1"] [class*="sidebarCol"] {
  /* ★ 不再设宽度 —— 让它按网格列自然铺满。
     只保证不被裁剪、并且是第一个网格项。 */
  grid-column: 1 !important;
  position: relative !important;
  min-width: 0 !important;
  max-width: none !important;
  width: auto !important;
  z-index: 30 !important;
}
html[data-dsh-sidebar-overlay="1"]:not([data-dsh-sidebar-closing]) [class*="sidebarCol"] {
  animation: dshSideSlideIn .26s cubic-bezier(.22,.61,.36,1);
}
/* 退出：必须 forwards，否则动画播完到属性移除之间的那几毫秒会闪回原位 */
html[data-dsh-sidebar-closing="1"] [class*="sidebarCol"] {
  animation: dshSideSlideOut .26s cubic-bezier(.22,.61,.36,1) forwards;
}
/* 折叠的那一瞬间 App 已把侧栏内容切成图标轨，退出期间先藏起来，
   只让整块面板滑走，避免「文字突然变图标」的跳变 */
html[data-dsh-sidebar-closing="1"] [class*="sidebarCol"] > * { visibility: hidden !important; }

@keyframes dshSideSlideIn { from { transform: translateX(-100%); } to { transform: translateX(0); } }
@keyframes dshSideSlideOut { from { transform: translateX(0); } to { transform: translateX(-100%); } }

/* ★★★ 防横向溢出 —— 这条不是美观问题，是**功能问题**：
   overlay 展开时 100vw 可能比容器宽几个像素，一旦出现横向滚动，
   手势代码里的 inHorizontalScroller() 守卫会把**所有滑动手势直接 return**
   ⇒ 用户表现为"之后连侧边栏都划不出来"（2026-10-20 真机就是这个症状）。
   ⇒ 必须从根上裁掉横向溢出。 */
[class*="frame"] { overflow-x: clip !important; }
html, body { overflow-x: hidden !important; max-width: 100vw !important; }
html[data-dsh-sidebar-overlay="1"]:not([data-dsh-sidebar-closing]) [class*="sidebarCol"] {
  animation: dshSideSlideIn .26s cubic-bezier(.22,.61,.36,1);
}
/* 退出：必须 forwards，否则动画播完到属性移除之间的那几毫秒会闪回原位 */
html[data-dsh-sidebar-closing="1"] [class*="sidebarCol"] {
  animation: dshSideSlideOut .26s cubic-bezier(.22,.61,.36,1) forwards;
}
/* 折叠的那一瞬间 App 已把侧栏内容切成图标轨，退出期间先藏起来，
   只让整块面板滑走，避免「文字突然变图标」的跳变 */
html[data-dsh-sidebar-closing="1"] [class*="sidebarCol"] > * { visibility: hidden !important; }

@keyframes dshSideSlideIn { from { transform: translateX(-100%); } to { transform: translateX(0); } }
@keyframes dshSideSlideOut { from { transform: translateX(0); } to { transform: translateX(-100%); } }

/* ★ 主界面不需要额外处理了 —— 侧栏占满 100vw 之后，grid 的中间列自然被挤成 0。
   原来那条 centerCol{visibility:hidden} 已按用户要求删除（"没必要做主界面消失"）。 */

/* 图标轨状态下，侧栏内容不要被拉成整行（官方收成 56px 图标轨时本来就窄，
   这里只是防止某些版本里子元素 width:100% 撑开） */
html[data-dsh-rail="1"] [class*="sidebarCol"] > * { width: 100% !important; max-width: 100% !important; }
html[data-dsh-sidebar-overlay="1"] [class*="sidebarCol"] > *,
html[data-dsh-sidebar-overlay="1"] [class*="sidebarCol"] > * > * {
  width: 100% !important; max-width: 100% !important; min-width: 0 !important;
}

/* ★★★ 2026-10-06 撤回：这里曾有一条"根因修法"，在收起态放开 sidebarCol 的裁剪，
   好让官方自带的左上角按钮露出来。**实测证明它是个错误**（用户 m07110 报告"错位 + 与主界面重叠"）：
   收起态放开裁剪后露出来的**不是那一个按钮，而是整个侧栏** ——
     打开侧边栏(10,18,36,36) / 新建会话(10,66) / 插件(10,114) / 自动化任务(10,162)
     / 添加工作区(10,210) / 搜索会话(10,258) / 设置(-8,760)
   统统叠在主界面上。左侧扫描（x=5..60, y=5..805, 步长 5）命中 **662 个点**。
   （我当时的"安全证明"是尺子错了：只量了横向 right>60，漏掉纵向贴左边缘那一列。
     教训：溢出检测必须二维。）

   现在的方案：**不放开裁剪**，官方按钮保持不可见；开侧栏统一走
     · ⋮ 菜单的「唤出侧边栏」项，或
     · 屏幕左缘右划手势（installEdgeSwipe）
   两者都是**程序化 .click()**，实测对 0 宽/被裁元素同样有效（不依赖可见性），
   所以不必再为"点得到"破坏官方布局。 */

/* ★ 2026-10-06 撤回（用户 m07494）：这里原来在面板页/设置页隐藏官方侧栏按钮，
   为的是给注入的「返回」键让位。返回键已删除，这条隐藏规则一并去掉 ——
   官方按钮由官方自己按状态显隐，我们不再干预。 */

/* 触摸设备：把侧栏自带的收起按钮放大到易点尺寸 */
@media (pointer: coarse) {
  [class*="frame"]:not([data-sidebar-collapsed]) [class*="sidebarCol"] button[aria-label="收起侧边栏"] {
    width: 40px !important; height: 40px !important; min-width: 40px !important;
  }
}

/* ===== 设置面板：两页全屏模型 ===== */
[data-dsh-settings="1"] {
  position: fixed !important;
  inset: 0 !important;
  width: 100vw !important; max-width: 100vw !important;
  height: 100vh !important; max-height: 100vh !important;
  height: 100dvh !important; max-height: 100dvh !important;
  margin: 0 !important; padding: 0 !important;
  transform: none !important; box-sizing: border-box !important;
  border-radius: 0 !important;
}
/* 页 A：导航（默认，无属性时） */
[data-dsh-settings="1"]:not([data-dsh-settings-view="content"]) > div[class*="content"] { display: none !important; }
[data-dsh-settings="1"]:not([data-dsh-settings-view="content"]) > nav,
[data-dsh-settings="1"]:not([data-dsh-settings-view="content"]) > nav > div {
  width: 100% !important; max-width: none !important; box-sizing: border-box !important;
}
/* 页 B：内容 */
[data-dsh-settings="1"][data-dsh-settings-view="content"] > nav { display: none !important; }
[data-dsh-settings="1"][data-dsh-settings-view="content"] > div[class*="content"] { width: 100% !important; max-width: none !important; }
/* ★ 2026-10-06：这条 header 的 padding-left:48px 原是给注入返回键让位，返回键删了，一并去掉。 */
[data-dsh-settings="1"][data-dsh-settings-view="content"] > div[class*="content"] > div[class*="options"] {
  width: 100% !important; max-width: 100% !important; min-width: 0 !important;
  box-sizing: border-box !important; overflow-x: hidden !important;
  /* 底部留白：让靠底的选项滚上来后，弹出层能向下展开而不翻转压住按钮 */
  padding-bottom: calc(170px + env(safe-area-inset-bottom)) !important;
}
[data-dsh-settings="1"][data-dsh-settings-view="content"] > div[class*="content"] {
  max-width: 100vw !important; min-width: 0 !important;
}
/* 只约束设置页的直接子元素，不能碰后代（会压塌 stepper 等控件） */
[data-dsh-settings="1"][data-dsh-settings-view="content"] [class*="options"] > * {
  max-width: 100% !important; box-sizing: border-box !important;
}

#dsh-mobile-update {
  position: fixed;
  /* 下移到与余额面板大致同一高度；原来是 10px，会压住会话标题 */
  top: calc(112px + env(safe-area-inset-top));
  left: 50%; transform: translateX(-50%);
  height: 32px; padding: 0 16px; border-radius: 16px;
  /* 不透明底：原来用的是 interactive-bg-hover（半透明令牌），浮在正文上很难受。
     改用设置面板同款的不透明层色，亮/暗主题会自动跟随。 */
  background: var(--dsw-alias-bg-layer-2, var(--dsw-specific-menu, #ffffff));
  color: var(--dsw-alias-label-primary, #111114);
  border: .5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.22));
  font-size: 13px; line-height: 32px;
  z-index: 99999; cursor: pointer; white-space: nowrap;
  box-shadow: 0 4px 16px rgba(0,0,0,.18);
  -webkit-tap-highlight-color: transparent;
}
#dsh-mobile-update:active { filter: brightness(.94); }

#dsh-mobile-toast {
  position: fixed; left: 50%; bottom: calc(96px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  background: var(--dsw-alias-bg-module-platform, #232325);
  color: var(--dsw-alias-label-primary, #eeeeee);
  font-size: 13px; line-height: 20px; padding: 8px 16px; border-radius: 16px;
  z-index: 100002; pointer-events: none; white-space: nowrap;
  box-shadow: 0 4px 16px rgba(0,0,0,.35);
  animation: dshToastIn .18s ease-out;
}
@keyframes dshToastIn { from { opacity: 0; margin-bottom: -6px; } to { opacity: 1; margin-bottom: 0; } }
/* 设置页切换：滑动 + 淡入（动画结束不保留 transform，不影响弹出层定位） */
@keyframes dshPaneInR { from { opacity: 0; transform: translateX(-26px); } to { opacity: 1; transform: translateX(0); } }
@keyframes dshPaneInL { from { opacity: 0; transform: translateX(26px); }  to { opacity: 1; transform: translateX(0); } }
.dsh-pane-in-r { animation: dshPaneInR .24s cubic-bezier(.22,.61,.36,1); }
.dsh-pane-in-l { animation: dshPaneInL .24s cubic-bezier(.22,.61,.36,1); }

/* 侧栏展开/收起：加一点淡入，减轻突兀感 */
@keyframes dshFadeIn { from { opacity: .35; } to { opacity: 1; } }
.dsh-fade-in { animation: dshFadeIn .18s ease-out; }
/* 左侧栏展开：从左侧滑入 */
@keyframes dshSideIn { from { opacity: .25; transform: translateX(-38px); } to { opacity: 1; transform: translateX(0); } }
.dsh-side-in { animation: dshSideIn .26s cubic-bezier(.22,.61,.36,1); }

/* ===== 设置面板整体：从左侧滑入 / 向左侧滑出 =====
   注意用独立属性 translate，而不是 transform —— 面板基类上有 transform: none !important，
   规范里 !important 声明优先级高于动画，用 transform 做动画会被它整个吃掉。 */
@keyframes dshSettingsIn  { from { translate: -100% 0; } to { translate: 0 0; } }
@keyframes dshSettingsOut { from { translate: 0 0; }    to { translate: -100% 0; } }
.dsh-settings-in  { animation: dshSettingsIn .26s cubic-bezier(.22,.61,.36,1); }
/* 退出必须 forwards：动画结束到残影移除之间不能闪回原位 */
.dsh-settings-out { animation: dshSettingsOut .24s cubic-bezier(.22,.61,.36,1) forwards; }
/* 残影：React 卸载后顶替画面的那一层 */
.dsh-settings-ghost { pointer-events: none !important; z-index: 100001 !important; }

/* 面板已经整屏不透明，它后面那层全屏 backdrop-filter 遮罩纯属浪费，
   还是「整屏闪一下」的主要嫌疑，直接去掉 */
[data-dsh-settings-layer="1"] > [class*="mask"] { display: none !important; }

/* ★★★ 2026-10-06 删除全部注入式「返回」键（用户 m07494）
   用户原话要点："你没有把之前插入的那几个返回键删除干净，我觉得他们没什么用，
   现在只需要读取手机自己的返回动作就可以了。"

   这里原来是一个 fixed 在左上角的 28×28 圆形返回键，被设置面板和主区面板页复用。
   为了给它腾位置，还牵连了一串"让位"补丁，本轮**一并删除**：
     · #dsh-mobile-settings-back 的 5 条样式（本体 + svg + hover/active + 两个显隐开关）
     · [data-dsh-settings="1"] nav [class*="navTitle"] { padding-left: 48px }   导航页标题让位
     · [data-dsh-settings-view="content"] … > div[class*="header"] { padding-left: 48px }
     · html[data-dsh-panel-open="1"] header[class*="pageHead"] { padding-left: 0 }
     · html[data-dsh-panel-open="1"] #dsh-mobile-settings-back { top:0; left:0 }
     · header[class*="_header"] { padding-left: 44px }   ← 这是更早那个 rail-toggle 的遗留，
                                                          按钮上一轮已删，这条补丁是死代码

   ★ 返回能力**没有丢**，改由手机自己的返回动作承担：
     APK 侧 MainActivity.onBackPressed 会回调 window.__dshBack()
     （已从手机上的 com.dsh.shell v1.4.9 base.apk 的 classes.dex 里核实：
       字符串表含 __dshBack 与 onBackPressed，调用形如
       (function(){try{return (window.__dshBack && window.__dshBack()) ? '1' : '0';}catch(e){return '0';}})()）。
     原来按钮 click 里的那套"一层一层退"逻辑，已原样搬进 window.__dshBack()
     的 settingsBack()（见 installSettingsNav 附近），行为与点按钮完全一致。 */

/* ===== 把「Agent 预设」与「后台任务」从标题行搬进 ⋮ 菜单 ===== */
/* 预设只是一个只读 span（带 title 提示），没有点击行为 —— 直接隐藏，
   信息原样在菜单里复现，所以不存在"藏了就打不开"的风险 */
html[data-dsh-moved-preset="1"] [class*="SVAs4q_label"] { display: none !important; }

/* 后台任务带下拉列表，绝对不能 display:none —— 子树会一起不渲染、弹层也就没了。
   改成 1×1 隐形锚点、定位到 ⋮ 下方：弹层仍从它原位展开（top:calc(100% + 5px)），
   点击行为、列表内容、实时刷新全部是原生的 */
html[data-dsh-moved-jobs="1"] [class*="QsffPG_root"] {
  position: fixed !important;
  left: 16px !important; top: 54px !important;
  width: 1px !important; height: 1px !important;
  overflow: visible !important; z-index: 100000 !important;
}
html[data-dsh-moved-jobs="1"] [class*="QsffPG_trigger"] {
  opacity: 0 !important; width: 1px !important; height: 1px !important;
  min-height: 0 !important; padding: 0 !important; gap: 0 !important;
  border: 0 !important; overflow: hidden !important; pointer-events: none !important;
}
/* 芯片藏了，但"后台还在跑"必须看得出来：在 ⋮ 上点一个小圆点 */
html[data-dsh-moved-jobs="1"] body:has([class*="QsffPG_root"]) button[class*="moreButton"] { position: relative; }
html[data-dsh-moved-jobs="1"] body:has([class*="QsffPG_root"]) button[class*="moreButton"]::after {
  content: ""; position: absolute; top: 2px; right: 2px;
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-state-business-primary, #4d6bfe);
}

/* ===== ★ 座位收纳（2026-10-08，用户 m06007）：输入框下方的「上拉列表」 =====
   只在手机窄屏启用（与文件里其它窄屏判据一致：820px）。宽屏整段不生效，
   第三方座位照旧原地显示 —— 用户明确选的「宽屏保持现状」。 */
@media (max-width: 820px) {

/* 28×28 圆按钮，遵 AGENTS.md §1.2：padding 0、无外圈、无多余底色 */
.dsh-st-trigger {
  box-sizing: border-box; width: 28px; height: 28px; padding: 0; margin: 0;
  display: inline-flex; align-items: center; justify-content: center;
  flex: none; border: 0; border-radius: 999px; background: transparent;
  color: var(--dsw-alias-label-tertiary, #81858c); cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.dsh-st-trigger:active { background: rgba(127, 127, 127, .16); }
/* 上拉箭头：纯 CSS 画，不引外部图 */
.dsh-st-chev { display: block; width: 9px; height: 9px; margin-top: 3px;
  border-left: 1.5px solid currentColor; border-top: 1.5px solid currentColor;
  transform: rotate(45deg); }
.dsh-st-trigger[aria-expanded="true"] .dsh-st-chev { margin-top: -2px; transform: rotate(225deg); }

/* 抽屉遮罩：盖在聊天区上，点一下收回 */
#dsh-st-scrim {
  position: fixed; inset: 0; z-index: 41; display: none;
  background: rgba(0, 0, 0, .28);
}
html[data-dsh-seat-tray="open"] #dsh-st-scrim { display: block; }

/* 抽屉本体：底部上拉面板 */
#dsh-st-panel {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 42;
  display: none; flex-direction: column; max-height: 62vh;
  padding-bottom: env(safe-area-inset-bottom);
  background: var(--dsw-alias-bg-base, #fff);
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .25));
  border-radius: var(--dsw-radius-panel, 12px) var(--dsw-radius-panel, 12px) 0 0;
  box-shadow: 0 -10px 30px rgba(0, 0, 0, .2);
}
html[data-dsh-seat-tray="open"] #dsh-st-panel { display: flex; }
.dsh-st-grip { flex: none; width: 32px; height: 4px; margin: 8px auto 2px;
  border-radius: 999px; background: var(--dsw-alias-border-l2, rgba(127, 127, 127, .35)); }
.dsh-st-title { flex: none; padding: 4px 14px 6px; font-size: 12px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary, #81858c); }
/* 收录到的座位都进这里；每个座位一格，纵向排开、可滚动 */
.dsh-st-body { display: flex; flex-direction: column; gap: 2px;
  padding: 0 8px 10px; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.dsh-st-cell { display: flex; align-items: center; min-height: 36px;
  padding: 0 6px; border-radius: 10px; }
.dsh-st-cell:empty { display: none; }

}   /* @media (max-width: 820px) */

`;

    /* ========== 侧栏展开状态 -> <html> 标记 ==========
       ★★★ 2026-10-20 重写：**官方 data-sidebar-collapsed 是唯一真相**。
       上一版让 railState 在这里"说了算"，结果和官方属性互相打脸：
         railToOpen 设 overlay=1 → syncStateNow 看到官方还是 collapsed → 删掉
         → 界面什么都没变，但我的状态变量说"已展开" → 之后手势全错。
       ⇒ 现在这里**只做一件事**：把官方状态翻译成 overlay 属性（带退场动画）。
         不再有任何"我的状态优先"，也就不可能不同步。 */
    var sidebarOverlayState = "unknown";   /* unknown | open | closing | closed */
    var sidebarCloseTimer = null;

    function syncSidebarOverlay(expanded) {
      var html = document.documentElement;
      /* rail 态（图标轨）下官方一定是收起的，但 overlay 也不该存在——
         宽度由 data-dsh-rail 控。★ 这条要优先于下面的官方判断。 */
      if (railIsOpen()) {
        if (sidebarCloseTimer) { clearTimeout(sidebarCloseTimer); sidebarCloseTimer = null; }
        sidebarOverlayState = "closed";
        html.removeAttribute("data-dsh-sidebar-overlay");
        html.removeAttribute("data-dsh-sidebar-closing");
        return;
      }
      if (expanded) {
        if (sidebarCloseTimer) { clearTimeout(sidebarCloseTimer); sidebarCloseTimer = null; }
        html.setAttribute("data-dsh-sidebar-overlay", "1");
        html.removeAttribute("data-dsh-sidebar-closing");
        sidebarOverlayState = "open";
        return;
      }
      if (sidebarOverlayState === "open") {
        /* 展开 -> 折叠：先保留覆盖层，把退出动画播完 */
        sidebarOverlayState = "closing";
        html.setAttribute("data-dsh-sidebar-closing", "1");
        sidebarCloseTimer = setTimeout(function () {
          sidebarCloseTimer = null;
          sidebarOverlayState = "closed";
          /* ★ 到点复查：这 280ms 里如果又变宽了，就别删 */
          if (officialExpanded() && !railIsOpen()) {
            sidebarOverlayState = "open";
            html.removeAttribute("data-dsh-sidebar-closing");
            return;
          }
          html.removeAttribute("data-dsh-sidebar-overlay");
          html.removeAttribute("data-dsh-sidebar-closing");
        }, 280);
        return;
      }
      if (sidebarOverlayState === "unknown") {
        sidebarOverlayState = "closed";
        html.removeAttribute("data-dsh-sidebar-overlay");
        html.removeAttribute("data-dsh-sidebar-closing");
      }
      /* closing / closed：什么都不做，别打断定时器（200ms 轮询会反复进来） */
    }

    function syncStateNow() {
      try {
        var f = document.querySelector('[class*="frame"]');
        var expanded = !!(f && !f.hasAttribute("data-sidebar-collapsed"));
        document.documentElement.setAttribute("data-dsh-mobile-expanded", expanded ? "1" : "0");
        syncSidebarOverlay(expanded);
      } catch (e) {}
    }

    /* ========== ★★★ 2026-10-19（用户第 1 条）：两级侧边栏 ==========
       用户原话：
         「主界面显示的那个侧边栏，我感觉平时可以收起来，然后做一个向右滑的手势之后，
           滑出来的不再是整个侧边栏。而是侧面的那些图标
           （注意侧边栏的这些图标的那一栏是划出来的，不是直接出现的，这样子比较顺滑…
           如果做了第1个动作之后，没有再继续滑动或者是点击侧边栏的这些按钮，则三秒后又收回去。），
           第2次滑动才会直接滑开侧边栏」

       ================== ★★★ 2026-10-20 重写：改成「无状态」 ==================
       用户实测两轮都是「刚打开能划出侧栏，再划一次打不开大侧栏，之后连侧栏都划不出来」。

       根因（前两版都有）：我维护了一个 `railState` 变量，而**官方有它自己的
       `data-sidebar-collapsed`**。两套状态必然会分流：
         · railToOpen() 里点了官方按钮 → 官方改了自己的属性
         · syncStateNow() 根据官方属性又去改我的属性
         · 定时器（3 秒收回 / 240ms 动画）在两者之间插入
       ⇒ 只要有一次不同步，`railState` 就和真实 DOM 对不上，
         之后所有手势分支全错，而且是**不可恢复**的（要刷新页面才行）。

       ⇒ 现在**不再维护任何状态变量**。唯一真相是 DOM：
         · `data-dsh-rail="1"`        ⇔ 图标轨展开中
         · 官方 `data-sidebar-collapsed` ⇔ 完整侧栏开/收
       所有判断都**当场读 DOM**，定时器只做"到点检查一次真实状态再决定要不要收"。
       这样即使中间出任何岔子，下一次手势也能自愈 —— 因为没有状态可以错。 */

    var RAIL_IDLE_MS = 3000;          /* 用户明确要求：3 秒无操作自动收回 */
    var railIdleTimer = null;
    var railCloseTimer = null;


    /* ★★★ 2026-10-20：诊断探针。
       前面几轮我一直在"猜"，改了四版都没修好 —— 因为看不到运行时的真实值。
       这里把手势相关状态**打印到 console**，App 侧再转发到
       /sdcard/DeepseekHarness/web.log（见 MainActivity 的 onConsoleMessage）。

       ★★ 血泪：第一版诊断**自己把功能搞坏了** ——
         `railSnapshot()` 里调了 `htmlEl()`，而它定义在更靠后的位置，
         实测报 `ReferenceError`，异常被 `touchstart` 的 try 吞掉
         ⇒ 后面的 `mode = ...` 根本没执行 ⇒ 手势静默失效。
       ⇒ 规矩：**诊断必须绝对无副作用**。
         · 不调用任何自定义函数（只用 DOM API 与内建）
         · 全程 try/catch，出错也绝不向外抛
         · 放在主逻辑**之外**，不夹在赋值语句中间 */
    function diagLog(tag, obj) {
      try {
        console.log("[DSH-DIAG] " + tag + " " + JSON.stringify(obj === undefined ? null : obj));
      } catch (e) {
        try { console.log("[DSH-DIAG] " + tag + " <unserializable>"); } catch (e2) {}
      }
    }

    /** 取 <html> 元素。★ 这个函数被状态机调用 7 次，绝不能少。 */
    function htmlEl() { return document.documentElement; }

    function railSnapshot() {
      try {
        var h = document.documentElement;
        var frame = document.querySelector('[class*="frame"]');
        var center = frame && frame.querySelector('[class*="centerCol"]');
        return {
          rail: h.getAttribute("data-dsh-rail"),
          overlay: h.getAttribute("data-dsh-sidebar-overlay"),
          panelAttr: h.getAttribute("data-dsh-panel-open"),
          hasLayout: !!layoutApi,
          hasEditor: !!(center && center.querySelector('[data-lexical-editor], [contenteditable="true"]')),
          collapsed: frame ? frame.hasAttribute("data-sidebar-collapsed") : null,
          w: window.innerWidth
        };
      } catch (e) { return { err: String(e) }; }
    }

    /* ---- 真实状态读取（唯一真相） ---- */
    function railIsOpen() {
      return htmlEl().getAttribute("data-dsh-rail") === "1";
    }
    function officialExpanded() {
      try {
        var f = document.querySelector('[class*="frame"]');
        return !!(f && !f.hasAttribute("data-sidebar-collapsed"));
      } catch (e) { return false; }
    }

    function clearRailIdle() {
      if (railIdleTimer) { clearTimeout(railIdleTimer); railIdleTimer = null; }
    }
    function clearRailClose() {
      if (railCloseTimer) { clearTimeout(railCloseTimer); railCloseTimer = null; }
    }

    /* 进入图标轨 */
    function enterRail() {
      try {
        clearRailIdle();
        clearRailClose();
        var h = htmlEl();
        h.removeAttribute("data-dsh-rail-closing");
        h.setAttribute("data-dsh-rail", "1");
        armRailIdle();
      } catch (e) {}
    }

    /* 3 秒无操作 ⇒ **先读真实状态**再决定收不收（不靠变量） */
    function armRailIdle() {
      clearRailIdle();
      railIdleTimer = setTimeout(function () {
        railIdleTimer = null;
        if (railIsOpen()) exitRail(true);
      }, RAIL_IDLE_MS);
    }

    /* 离开图标轨 */
    function exitRail(animated) {
      try {
        clearRailIdle();
        if (!railIsOpen()) return;
        var h = htmlEl();
        if (animated) {
          clearRailClose();
          h.setAttribute("data-dsh-rail-closing", "1");
          railCloseTimer = setTimeout(function () {
            railCloseTimer = null;
            /* ★ 到点再查一次：这 240ms 里如果又开了图标轨，就别删 */
            if (railIsOpen() && h.getAttribute("data-dsh-rail-closing") === "1") {
              h.removeAttribute("data-dsh-rail");
              h.removeAttribute("data-dsh-rail-closing");
            }
          }, 240);
        } else {
          h.removeAttribute("data-dsh-rail");
          h.removeAttribute("data-dsh-rail-closing");
        }
      } catch (e) {}
    }

    /* 图标轨 → 完整侧栏：**只做一件事，把官方侧栏展开**。
       ★ 宽度 100% 由 CSS 根据官方 `data-sidebar-collapsed` 之外的状态决定 ——
         等等，CSS 用的是我们自己的 data-dsh-sidebar-overlay。
       ⇒ 所以这里显式加它，并且**不再依赖 syncStateNow 去补**。 */
    function railToOpen() {
      clearRailIdle();
      clearRailClose();
      var h = htmlEl();
      h.removeAttribute("data-dsh-rail");
      h.removeAttribute("data-dsh-rail-closing");
      h.setAttribute("data-dsh-sidebar-overlay", "1");
      h.removeAttribute("data-dsh-sidebar-closing");
      try {
        var f = document.querySelector('[class*="frame"]');
        if (f && f.hasAttribute("data-sidebar-collapsed")) {
          var tog = findSidebarToggle();
          if (tog) tog.click();
        }
      } catch (e) {}
    }

    /* 完整侧栏 → 收起 */
    function openToClosed() {
      clearRailIdle();
      clearRailClose();
      var h = htmlEl();
      h.removeAttribute("data-dsh-rail");
      h.removeAttribute("data-dsh-rail-closing");
      if (h.getAttribute("data-dsh-sidebar-overlay") === "1") {
        h.setAttribute("data-dsh-sidebar-closing", "1");
        railCloseTimer = setTimeout(function () {
          railCloseTimer = null;
          h.removeAttribute("data-dsh-sidebar-overlay");
          h.removeAttribute("data-dsh-sidebar-closing");
        }, 280);
      } else {
        h.removeAttribute("data-dsh-sidebar-overlay");
        h.removeAttribute("data-dsh-sidebar-closing");
      }
      try {
        var f = document.querySelector('[class*="frame"]');
        if (f && !f.hasAttribute("data-sidebar-collapsed")) {
          var tog = findSidebarToggle();
          if (tog) tog.click();
        }
      } catch (e) {}
    }

    /* 用户在图标轨上继续操作 ⇒ 重置 3 秒计时 */
    function railActivity() {
      if (railIsOpen()) armRailIdle();
    }

    /* ★ 供排查用：把当前真实状态暴露出去 */
    try {
      window.__dshRailState = function () {
        var h = htmlEl();
        var frame = document.querySelector('[class*="frame"]');
        var center = frame && frame.querySelector('[class*="centerCol"]');
        return {
          rail: h.getAttribute("data-dsh-rail"),
          railClosing: h.getAttribute("data-dsh-rail-closing"),
          overlay: h.getAttribute("data-dsh-sidebar-overlay"),
          overlayClosing: h.getAttribute("data-dsh-sidebar-closing"),
          panelAttr: h.getAttribute("data-dsh-panel-open"),
          hasEditor: !!(center && center.querySelector('[data-lexical-editor], [contenteditable="true"]')),
          panelIsOpen: panelIsOpen(),
          collapsed: frame ? frame.hasAttribute("data-sidebar-collapsed") : null
        };
      };
    } catch (e) {}

    /* ========== 主区面板页（插件面板 / 自动化任务）==========
       ★ 2026-10-05 用户反馈：官方 0.2.0 新增的这两个入口在手机上"进去出不来" ——
         点进去之后满屏侧栏不收、没有返回键、右划也不返回。

       好消息是官方给了正规途径，不必去猜 DOM：
           ctx.layout.panelInfo.getSnapshot() -> { activePanelId }   面板页是否打开
           ctx.layout.panelInfo.subscribe(cb)                         被动感知
           ctx.layout.selectPanel(null)                               回到对话
           ctx.layout.toggleSidebar()                                 收起/展开侧栏
       这几个 API 来自官方包 @deepseek-ai/dsh-client-ui-layout（ctx.layout 服务），
       是本插件唯一一处"官方一等公民"依赖 —— 靠 client.js 末尾的 inject:["layout"] 声明拿到。
       ★ 仍然遵守老规矩：**任何一步失败都不抛错**，面板页顶多少一个返回键，
         不会把整个界面带崩（这一点在 2026-10-05 已用真实 boot 失败验证过：inject 写错会白屏）。 */
    var layoutApi = null;
    /* ★ 2026-10-07：官方 connection 服务句柄的持有位（installConnectionResume 用）。
       由 apply(ctx) 填充；取不到时保持 null，功能静默待命。 */
    var ctxRef = null;
    var PANEL_WATCH_MS = 300;

    function panelIsOpen() {
      /* ★★★ 2026-10-20 第三次修正 —— 前两版都在猜，这次**只用官方 API**。
         为什么把 DOM 判据整个删掉：
           v7 用的是「中间列没有对话编辑器 **且** 有 ≥2 个可见可交互元素」。
           但**主界面在"还没选工作区"时本来就没有输入框**（界面上是
           「选择一个工作区开始」），而"选择工作区""标准模式"这些又都是可交互元素
           ⇒ 主界面被误判成面板页 ⇒ 手势被 `if (!hasEditor && panelIsOpen()) return;`
             直接挡掉 ⇒ **右滑彻底失效**（这就是用户说的"还不行"）。
         ⇒ 结论：**没有任何 DOM 特征能可靠区分"面板页"和"未选工作区的主界面"**。
           唯一可靠的只有官方 `layout.panelInfo`。
         ★ 如果 layoutApi 取不到 —— 那就干脆认为"面板页没开着"。
           因为 layoutApi 都没有的话，官方面板功能本身也用不了。 */
      try {
        if (!layoutApi || !layoutApi.panelInfo) return false;
        var s = layoutApi.panelInfo.getSnapshot();
        return !!(s && s.activePanelId !== null && s.activePanelId !== undefined);
      } catch (e) { return false; }
    }

    function syncPanelOpen() {
      try {
        var html = document.documentElement;
        if (panelIsOpen()) html.setAttribute("data-dsh-panel-open", "1");
        else html.removeAttribute("data-dsh-panel-open");
      } catch (e) {}
    }

    /** 面板页 → 回对话。返回 true 表示确实做了事。 */
    function backToConversation() {
      /* ① 首选官方 API（最干净） */
      try {
        if (layoutApi && panelIsOpen()) {
          layoutApi.selectPanel(null);
          syncPanelOpen();
          return true;
        }
      } catch (e) {}
      /* ② ★★ 兜底（2026-10-20）：layoutApi 取不到 / 调不动时，
            从 DOM 上把面板页关掉 —— 点一下侧栏里的"对话"入口。
            ★ 这是用户报「插件/自动化任务页按返回回桌面」的最后一道保险：
              宁可多点一次 DOM，也不能让返回键掉到 App 去退到桌面。 */
      try {
        if (!panelIsOpen()) return false;
        var cands = document.querySelectorAll(
            '[class*="sidebarCol"] button, [class*="sidebarCol"] a, [role="menuitem"], [role="tab"]');
        for (var i = 0; i < cands.length; i++) {
          var el = cands[i];
          var label = ((el.getAttribute("aria-label") || "") + " "
                     + (el.getAttribute("title") || "") + " "
                     + (el.textContent || "")).replace(/\s+/g, "");
          if (/^(对话|会话|聊天|chat|conversation)$/i.test(label)) {
            el.click();
            syncPanelOpen();
            return true;
          }
        }
      } catch (e) {}
      return false;
    }

    function installPanelWatcher() {
      /* ★★ 2026-10-20 修（这是「主界面右滑失效」的源头）：
         原来第一行是 `if (!layoutApi) throw new Error(...)` ——
         `layoutApi` 取不到就**整个功能不跑** ⇒ `data-dsh-panel-open` 永远不被更新
         ⇒ 一旦它曾经是 "1" 就永远留着 ⇒ `panelIsOpen()` 恒 true ⇒ 手势全被挡。
         ⇒ 现在**不抛错**：没有 layoutApi 也照常轮询，靠 DOM 判据更新属性。
           （`panelIsOpen()` 本身已经能走 DOM 判据，不依赖 layoutApi。） */
      if (window.__dshPanelWatcher) return;
      window.__dshPanelWatcher = true;
      try {
        if (layoutApi && layoutApi.panelInfo && layoutApi.panelInfo.subscribe) {
          layoutApi.panelInfo.subscribe(function () { syncPanelOpen(); });
        }
      } catch (e) {}
      /* 订阅是主通道；轮询兜底（无论有没有 layoutApi 都要跑） */
      try { setInterval(syncPanelOpen, PANEL_WATCH_MS); } catch (e) {}
      syncPanelOpen();
    }

    /* ========== 侧栏切换：只按官方按钮做程序化点击，不再注入任何按钮 ==========
       ★ 2026-10-06 用户 m07110：删掉左上角那个注入式圆形按钮（"颜色和位置都奇怪"，
         且与官方按钮几何重合）。开侧栏改由 ⋮ 菜单的「唤出侧边栏」与左缘右划手势承担。
       ★ 官方按钮在收起态被 0 宽的 sidebarCol 裁掉、elementFromPoint 够不着 ——
         这是**官方布局的正常结果**，不是故障，所以不再做"够不着就启用替身"的自愈。 */
    function findSidebarToggle() {
      var col = document.querySelector('[class*="sidebarCol"]');
      if (!col) return null;
      var sels = ['button[class*="_toggle"]', 'button[class*="_brand"]'];
      for (var i = 0; i < sels.length; i++) {
        var e = col.querySelector(sels[i]);
        if (e) return e;
      }
      return null;
    }

    /* ========== 设置面板：两页全屏 ========== */
    function isGhost(el) {
      return !!(el && ((el.classList && el.classList.contains("dsh-settings-ghost")) ||
                       (el.hasAttribute && el.hasAttribute("data-dsh-ghost"))));
    }

    /* 认出"设置面板"，用来做全屏两页布局。
       ★ 2026-10-05 二次修正：判据里原本有 [class*="options"]，而官方 0.2.0 的
       「添加插件」安装弹层（X_2TxG_installDialog）里含一个 X_2TxG_optionsRow，
       于是它被误认成设置面板、被打上 data-dsh-settings="1"；随后本插件那条
       [data-dsh-settings="1"]:not([data-dsh-settings-view="content"]) > div[class*="content"]
       { display:none } 就把弹层主体藏了，只剩 footer 掉到 y=0 —— 用户看到的
       「点添加插件整个页面往上飘」。
       真实设置面板（VOzbGW_panel）的形态：子节点 = NAV.VOzbGW_nav + DIV.VOzbGW_content，
       navCell=4，且 [class*="content"] 的直接子里有 [class*="options"]。
       安装弹层 navCell=0、也没有 content>options。
       ⇒ 判据改为 navCell 或 content 的直接子 options，两者都不误伤。 */
    function findSettingsDialog() {
      var all = document.querySelectorAll('[role="dialog"]');
      for (var i = 0; i < all.length; i++) {
        /* 残影是面板的克隆，同样带 role="dialog" 和 navCell。
           不排除它就会形成自指：残影被当成「面板还开着」→ 再克隆一份 → 无限套娃 */
        if (isGhost(all[i])) continue;
        if (all[i].querySelector('[class*="navCell"],[class*="content"] > [class*="options"]')) return all[i];
      }
      return null;
    }

    /* ---------- 设置面板残影（供退出动画用） ---------- */
    var settingsGhostTimer = null;

    function refreshSettingsGhost() {
      var dlg = findSettingsDialog();
      if (!dlg) { window.__dshGhostFor = null; return; }
      if (isGhost(dlg)) return;                       /* 绝不克隆残影 */
      try {
        var g = dlg.cloneNode(true);
        var ids = g.querySelectorAll("[id]");
        for (var i = 0; i < ids.length; i++) ids[i].removeAttribute("id");
        g.removeAttribute("id");
        /* 去掉所有「我是对话框」的标识，否则它会再次被 findSettingsDialog 认出来 */
        g.removeAttribute("role");
        g.removeAttribute("aria-modal");
        g.setAttribute("data-dsh-ghost", "1");
        g.classList.remove("dsh-settings-in");
        g.classList.add("dsh-settings-ghost");
        /* 同步滚动位置，残影和真实画面一致 */
        var a = dlg.querySelectorAll("*"), b = g.querySelectorAll("*");
        var n = Math.min(a.length, b.length);
        for (var k = 0; k < n; k++) { b[k].scrollTop = a[k].scrollTop; b[k].scrollLeft = a[k].scrollLeft; }
        window.__dshGhost = g;
      } catch (e) {}
    }

    function playSettingsExit() {
      var g = window.__dshGhost;
      window.__dshGhost = null;
      if (!g) return false;
      if (isGhost(g)) return false;
      try {
        if (settingsGhostTimer) { clearTimeout(settingsGhostTimer); settingsGhostTimer = null; }
        /* 任何遗留残影先清干净，保证屏幕上永远最多一层 */
        var stale = document.querySelectorAll(".dsh-settings-ghost");
        for (var si = 0; si < stale.length; si++) {
          if (stale[si].parentNode) stale[si].parentNode.removeChild(stale[si]);
        }
        document.body.appendChild(g);
        document.documentElement.setAttribute("data-dsh-settings-closing", "1");
        g.classList.add("dsh-settings-out");
        settingsGhostTimer = setTimeout(function () {
          settingsGhostTimer = null;
          document.documentElement.removeAttribute("data-dsh-settings-closing");
          if (g.parentNode) g.parentNode.removeChild(g);
        }, 260);
      } catch (e) { return false; }
      return true;
    }

    /* 兜底：面板以任何方式消失时，用残影补上退出动画 */
    function maybeSettingsExit() {
      if (!window.__dshGhost || isGhost(window.__dshGhost)) return false;
      if (findSettingsDialog()) return false;
      return playSettingsExit();
    }

    var settingsDesired = "nav";
    function syncSettingsView() {
      var dlg = findSettingsDialog();
      var tagged = document.querySelectorAll('[data-dsh-settings="1"]');
      for (var i = 0; i < tagged.length; i++) {
        /* 残影必须保留这个属性，它的整屏样式全靠它；扒掉会掉进 body 文档流 */
        if (tagged[i] !== dlg && !isGhost(tagged[i])) tagged[i].removeAttribute("data-dsh-settings");
      }
      var newlyOpened = !!(dlg && !window.__dshHadDlg);
      if (dlg && dlg.getAttribute("data-dsh-settings") !== "1") dlg.setAttribute("data-dsh-settings", "1");
      if (newlyOpened) {
        try {
          dlg.classList.remove("dsh-settings-in");
          void dlg.offsetWidth;
          dlg.classList.add("dsh-settings-in");
        } catch (e) {}
      }
      /* 给外层 overlay 打标，用来干掉它那层全屏模糊遮罩 */
      var layer = dlg ? dlg.parentElement : null;
      if (layer && (layer === document.body || layer === document.documentElement)) layer = null;
      var layers = document.querySelectorAll('[data-dsh-settings-layer="1"]');
      for (var li = 0; li < layers.length; li++) {
        if (layers[li] !== layer) layers[li].removeAttribute("data-dsh-settings-layer");
      }
      if (layer) layer.setAttribute("data-dsh-settings-layer", "1");

      /* 首次见到这个面板：先存一份残影，并持续跟踪它的变化保持新鲜 */
      if (dlg && window.__dshGhostFor !== dlg) {
        window.__dshGhostFor = dlg;
        refreshSettingsGhost();
        try {
          var ghostQueued = false;
          new MutationObserver(function () {
            if (ghostQueued) return;
            ghostQueued = true;
            requestAnimationFrame(function () { ghostQueued = false; refreshSettingsGhost(); });
          }).observe(dlg, {
            childList: true, subtree: true,
            attributes: true, attributeFilter: ["class", "data-dsh-settings-view"]
          });
        } catch (e) {}
      }
      window.__dshHadDlg = !!dlg;
      if (!dlg) settingsDesired = "nav";
      if (dlg) {
        if (settingsDesired === "content") dlg.setAttribute("data-dsh-settings-view", "content");
        else dlg.removeAttribute("data-dsh-settings-view");
      }
      document.documentElement.setAttribute("data-dsh-settings-view", dlg ? settingsDesired : "nav");
      document.documentElement.setAttribute("data-dsh-settings-open", dlg ? "1" : "0");
      syncStateNow();
    }

    function setSettingsView(v) {
      if (v === settingsDesired) return;
      settingsDesired = v;
      syncSettingsView();
      try {
        var dlg = findSettingsDialog();
        if (!dlg) return;
        var pane = (v === "content")
          ? dlg.querySelector('div[class*="content"]')
          : dlg.querySelector("nav");
        if (!pane) return;
        pane.classList.remove("dsh-pane-in-l", "dsh-pane-in-r");
        void pane.offsetWidth;                       /* 强制重排以重启动画 */
        pane.classList.add(v === "content" ? "dsh-pane-in-l" : "dsh-pane-in-r");
      } catch (e) {}
    }

    /** ★ 2026-10-06：这里原来会创建一个 <button id="dsh-mobile-settings-back">
        注入到 body 上，作为设置页/面板页的"返回键"。用户 m07494 要求删掉它，
        改由手机自己的返回动作（APK 的 onBackPressed → window.__dshBack()）承担。

        所以本函数现在只保留"设置页两页化"的状态机（nav / content 视图切换）——
        那是靠 CSS 类实现的移动端适配，与返回键无关，必须留下。
        原来按钮 click 里那套"一层一层退"的判断，已原样搬进 settingsBack()（见下）。 */
    function settingsBack() {
      /* ★ 2026-10-20：原来这里 ① 判"主区面板页"并调 backToConversation()。
         现在那条已经提到 __dshBack 的最前面（⓪）—— 面板页是"页"级，
         必须最先处理，否则会先被侧栏/设置页抢走。
         ⇒ 这里**只负责设置页的两级返回**，不再管面板页。 */
      /* ① 设置页的内容页 → 回导航页 */
      if (document.documentElement.getAttribute("data-dsh-settings-view") === "content") {
        setSettingsView("nav");
        return true;
      }
      /* ② 设置页的导航页 → 关掉整个设置面板（带退场残影） */
      var dlg = findSettingsDialog();
      var cb = dlg ? dlg.querySelector('button[class*="close"]') : null;
      if (cb) {
        refreshSettingsGhost();   /* 此刻画面还在，克隆最新的 */
        playSettingsExit();       /* 立刻开始左滑，React 卸载时已是残影在顶着 */
        cb.click();
        return true;
      }
      return false;
    }

    function installSettingsNav() {
      if (window.__dshMobileSettingsNav) return;
      window.__dshMobileSettingsNav = true;

      document.addEventListener("click", function (ev) {
        var t = ev.target;
        var cell = (t && t.closest) ? t.closest('[class*="navCell"]') : null;
        if (cell && cell.closest('[data-dsh-settings="1"]')) setTimeout(function () { setSettingsView("content"); }, 30);
      }, true);

      try {
        new MutationObserver(function (records) {
          for (var i = 0; i < records.length; i++) {
            var added = records[i].addedNodes;
            for (var j = 0; j < added.length; j++) {
              var n = added[j];
              if (n.nodeType !== 1) continue;
              if ((n.matches && n.matches('[role="dialog"]')) ||
                  (n.querySelector && n.querySelector('[class*="navCell"]'))) {
                syncSettingsView();
                return;
              }
            }
          }
        }).observe(document.body, { childList: true, subtree: true });
      } catch (e) {}

      setInterval(syncSettingsView, 200);
    }

    /* ========== 把「刷新页面」收进会话头的 ⋮ 菜单 ========== */
    function refreshPageNow() { try { location.reload(); } catch (e) {} }

    /* ---------- 检查更新 ---------- */
    var updateBusy = false;

    function showToast(msg) {
      try {
        var t = document.createElement("div");
        t.id = "dsh-mobile-toast";
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2800);
      } catch (e) {}
    }

    /* ========== 重启内核（杀死并重拉） ==========
       链路（★ 2026-10-06 架构重做，别再改回「App 桥优先」）：
         这里 POST /dsh-mobile/kernel-restart
           → 服务端半（**就跑在内核进程里**）经 am 把 dsh-kernel-relaunch
             投到 Termux 侧（脚本内容：等端口释放 → dsh-new start → 装回看门狗）
           → 服务端半回 200，随后给自己 SIGTERM（官方优雅退出路径）
           → 内核退出、proot 跟着退 → Termux 侧脚本把新的内核拉起来。
         内核就绪实测约 20~40 秒。
       ★ 为什么由服务端半「自杀」，而不是让 Termux 去杀：
         杀内核需要在 SELinux 域 u:r:runas_app 里发信号。Termux 侧一切进程
         —— 包括 App 经 am 投递的 RUN_COMMAND、甚至从 Termux 里
         `proot-distro login` 起的容器会话 —— 都在 u:r:untrusted_app_27 域；
         同 uid（10398）不同域 ⇒ 对内核 pid 的 kill 一律 Permission denied。
         服务端半恰好就在内核进程里，杀自己既合法又干净。
         （上一版把「杀」整个放在 Termux 侧，就是用户点了报"重启失败"的根因。）
       ★ 回退：路由不存在（旧内核还没换上新服务端半）或调用失败时，退到 App 的
         repair("kernel-restart") 桥 → Termux 侧 dsh-kernel-relaunch。它只会
         "重拉"，不会杀内核，所以只在「内核已经死了、只差重新拉起」时有救。
       ★ 页面必然断连：内核就是页面来源。APK 侧已有 3 秒节流的等待页 + 端口
          探活轮询（ping 通就 loadUrl），服务一回来它会自己把界面装回去
          ⇒ 这里**不做** location.reload()（那会立刻拿到失败页）。 */
    var kernelRestartBusy = false;

    function kernelRestartViaBridge() {
      try {
        if (window.DshShell && typeof window.DshShell.repair === "function") {
          window.DshShell.repair("kernel-restart");
          return true;
        }
      } catch (e) {}
      return false;
    }

    function kernelRestartNow() {
      if (kernelRestartBusy) return;
      kernelRestartBusy = true;
      showToast("\u23f3 \u6b63\u5728\u91cd\u542f\u5185\u6838\u2026\uff08\u9875\u9762\u4f1a\u65ad\u5f00\uff0c\u7ea6 20~40 \u79d2\u540e\u81ea\u52a8\u56de\u6765\uff09");
      var settled = false;
      function done() { settled = true; }
      /* 只在「内核还活着、但这条路由根本不存在」时退回 App 桥。
         旧内核没有这条路由，这时 App 桥是唯一能试的路（虽然也救不回来，
         但保留原回退语义）。 */
      function fallback() {
        if (settled) return;
        settled = true;
        if (!kernelRestartViaBridge()) showToast("\u91cd\u542f\u5931\u8d25\uff1a\u5e94\u7528\u6865\u4e0d\u53ef\u7528");
      }
      /* 服务端明确报错（500/409，例如「重拉脚本没起来，已取消本次重启」）：
         内核还活着，这时**绝不能**再去投递一次重拉 —— 那只会让 Termux 侧
         白等一轮端口释放。直接把服务端给的原因播出来。 */
      function showServerError(r) {
        var st = r ? r.status : "?";
        function say(obj) {
          done();
          showToast("\u91cd\u542f\u5931\u8d25\uff08" + st + "\uff09" + ((obj && obj.error) ? " " + obj.error : ""));
        }
        try { r.json().then(say).catch(function () { say(null); }); }
        catch (e) { say(null); }
      }
      /* fetch 在网络层直接抛错时，无法立刻区分「成功自杀把连接带走了」和
         「路由真的不可达」。★ 重启成功时内核必然自己死掉，这条连接**必然**
         被截断。所以等内核该死透的时刻（1.5s）再探一次插件路由：
           探得通 = 内核还活着 = 这条 POST 真失败了 ⇒ 退 App 桥；
           探不通 = 内核已倒 = 正是我们成功自杀 ⇒ 判成功，绝不回退，
                    否则会再投递一次，引发第二次重拉（双起容器）。
         服务端侧的 flock + 印记文件是第二道保险，但客户端本就不该乱回退。 */
      function confirmDead() {
        setTimeout(function () {
          if (settled) return;
          try {
            fetch("/dsh-mobile", { method: "GET", cache: "no-store" })
              .then(function (r) { if (r && r.ok) fallback(); else done(); })
              .catch(function () { done(); });
          } catch (e) { done(); }
        }, 1500);
      }
      /* 忙碌位兜底：任一环节静默失败时 30 秒后解除，让用户能再点一次。
         正常路径下页面早断了，这个定时器随之消失。★ 必须挂在两条分支之前，
         否则「没有 fetch 直接回退」那条早退会把忙碌位永久锁死。 */
      setTimeout(function () { kernelRestartBusy = false; }, 30000);
      /* 老 WebView 可能压根没有 fetch：探活也无法做，App 桥是唯一还能用的路。 */
      if (typeof fetch !== "function") { fallback(); return; }
      try {
        fetch("/dsh-mobile/kernel-restart", { method: "POST" })
          .then(function (r) {
            if (r && r.ok) { done(); return; }
            /* 404/405 = 旧内核没有这条路由（服务端半还没换新）⇒ 只能试 App 桥；
               其它 4xx/5xx = 新内核明确拒绝 ⇒ 播原因，不重拉。 */
            if (r && (r.status === 404 || r.status === 405)) return fallback();
            showServerError(r);
          })
          .catch(function () { confirmDead(); });
      } catch (e) { confirmDead(); }
    }

    /* ★ 2026-10-06：接上 APK 的 repair 结果回调。
       应用侧一直在调 window.__dshRepair(text, code)（MainActivity.pushRepair），
       但官方 bundle 与本插件过去都没有实现它 ⇒ 回调一直打空，
       「重启内核」失败时用户看不到任何原因。这里补上，只做 toast，不改界面。 */
    try {
      window.__dshRepair = function (text, code) {
        try {
          var s = String(text == null ? "" : text);
          var lines = s.split("\n");
          /* 挑最后一条带 [ok]/[err] 前缀的行 —— dsh-app-repair 收尾还有一行
             "[done] 结束"，直接取末行会把真正的原因盖掉。 */
          var pick = "", fallback = "";
          for (var i = 0; i < lines.length; i++) {
            var l = lines[i].replace(/\s+$/, "");
            if (!l.trim()) continue;
            fallback = l.trim();
            if (/^\s*\[(ok|err|warn)\]/i.test(l)) pick = l.trim();
          }
          var msg = pick || fallback;
          var c = String(code == null ? "" : code);
          showToast(c === "0"
            ? "\u5185\u6838\u91cd\u542f\uff1a" + (msg || "\u5df2\u53d1\u51fa")
            : "\u5185\u6838\u91cd\u542f\u5931\u8d25\uff08" + c + "\uff09" + (msg ? " " + msg : ""));
        } catch (e) {}
      };
    } catch (e) {}

    function startUpdateDownload(d) {
      try {
        var b = document.getElementById("dsh-mobile-update");
        if (!b) {
          b = document.createElement("button");
          b.id = "dsh-mobile-update";
          b.type = "button";
          document.body.appendChild(b);
        }
        b.disabled = true;
        b.textContent = "\u23f3 \u6b63\u5728\u4e0b\u8f7d v" + (d.versionName || "") + "\u2026";
        /* 交给 App 的 DownloadListener：下载完成后自动拉起系统安装器 */
        location.href = "/dsh-update.apk";
      } catch (e) {}
    }

    /**
     * 点「检查更新」后的流程：
     *   1) 让原生壳通知 Termux 扫描存储里的安装包（App 自己读不了 /sdcard 的 apk）
     *   2) 轮询已发布版本，比「已安装」新就自动下载并拉安装器
     *   3) 约 8 秒仍无新版则提示已是最新
     */
    function checkForUpdate() {
      if (updateBusy) return;
      updateBusy = true;
      try { if (window.DshShell && window.DshShell.checkUpdate) window.DshShell.checkUpdate(); } catch (e) {}
      var tries = 0;
      var timer = setInterval(function () {
        tries++;
        if (tries > 4) {
          clearInterval(timer); updateBusy = false;
          showToast("\u5df2\u662f\u6700\u65b0\u7248\u672c\uff08v" + (window.__DSH_APP_VERSION_NAME || window.__DSH_APP_VERSION || "?") + "\uff09");
          return;
        }
        fetch("/dsh-version.json", { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (!d || !d.versionCode) return;
            var cur = window.__DSH_APP_VERSION || 0;
            if (d.versionCode > cur) {
              clearInterval(timer); updateBusy = false;
              startUpdateDownload(d);
              return;
            }
            if (tries >= 3) {
              clearInterval(timer); updateBusy = false;
              showToast("\u5df2\u662f\u6700\u65b0\u7248\u672c\uff08v" + (window.__DSH_APP_VERSION_NAME || cur) + "\uff09");
            }
          })
          .catch(function () {});
      }, 2000);
    }

    /* 原生类名前缀（CSS Modules 哈希），跟着本版本 DSH 走 */
    var JOBS_ROOT   = '[class*="QsffPG_root"]';
    var JOBS_COUNT  = '[class*="QsffPG_count"]';
    var PRESET_LABEL = '[class*="SVAs4q_label"]';
    var ICON_JOBS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';
    var ICON_REFRESH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01"/><path d="M20.5 3.5v6h-6"/></svg>';

    var ICON_POWER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v9"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/></svg>';
    var ICON_PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4.5l12 7.5-12 7.5z"/></svg>';
    var ICON_STOP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    var ICON_UPDATE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V8"/><path d="M6.5 13.5 12 8l5.5 5.5"/><path d="M5 4h14"/></svg>';
    /* [projection] 「电脑 DSH」的图标：一台显示器 + 底座 */
    var ICON_COMPUTER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg>';
    var ICON_GLOBE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z"/></svg>';
    var ICON_KEY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12 20 3"/><path d="M17 6l3 3"/></svg>';
    /* 内核切换（两层结构：旧版 Termux / 新版容器）—— 双向箭头 */
    var ICON_SWAP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13"/><path d="M14 5l3 3-3 3"/><path d="M20 16H7"/><path d="M10 13l-3 3 3 3"/></svg>';

    /* ★ 2026-10-06：「侧栏镜像」各键的图标（⋮ 菜单里与官方侧栏一一对应，用户 m07110）
       ★ ICON_HOME 已随「回到主界面」一并删除（用户 m07494）。 */
    var ICON_SIDEBAR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 4v16"/></svg>';
    var ICON_PLUGIN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/></svg>';
    var ICON_SCHEDULE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/></svg>';
    var ICON_NEWCHAT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';
    /* ★ 2026-10-06 新增：搜索会话（放大镜）/ 添加工作区（文件夹+）/ 设置（齿轮） */
    var ICON_SEARCH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>';
    var ICON_ADDWS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/><path d="M12 11.5v5"/><path d="M9.5 14h5"/></svg>';
    var ICON_SETTINGS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M18 6l-1.4 1.4M7.4 16.6 6 18M18 18l-1.4-1.4M7.4 7.4 6 6"/></svg>';

    /* 官方侧栏「新建会话」按钮的 aria-label —— 认得它就能直接触发官方的新建流程 */
    var NEWCHAT_ARIA = "\u65b0\u5efa\u4f1a\u8bdd";

    /* 原生壳（DshShell APK）注入的 window.DshShell；浏览器里不存在 */
    function dshShellState() {
      try {
        if (window.DshShell && typeof window.DshShell.state === "function") {
          var o = JSON.parse(window.DshShell.state() || "{}");
          return o && typeof o === "object" ? o : null;
        }
      } catch (e) {}
      return null;
    }

    /* ★ 2026-10-05：把「原生壳桥到底在不在」做成可上报的探针。
       为什么需要它：APK 的 WebView **不开 devtools socket**（只有手机浏览器开），
       所以 CDP 进不去，那批依赖 window.DshShell 的菜单项在 APK 里是否真的出现
       以前只能靠截图猜。改成由页面自己把结论 POST 到 /dsh-mobile/report，
       落盘成 mobile-doctor.json —— 与 health/contract 走同一条"一处产生、一处消费"的通道。
       只读，绝不调用任何有副作用的桥方法（requestSetup/startServer/repair 一律不碰）。 */
    function shellProbe() {
      var out = { has: false };
      try {
        out.has = typeof window.DshShell !== "undefined" && window.DshShell !== null;
        if (!out.has) return out;
        out.typeof = typeof window.DshShell;
        try { out.keys = Object.keys(window.DshShell); } catch (e) { out.keys = "ERR:" + e.message; }
        out.hasState = typeof window.DshShell.state === "function";
        out.hasCheckUpdate = typeof window.DshShell.checkUpdate === "function";
        out.hasRepair = typeof window.DshShell.repair === "function";
        out.hasStartServer = typeof window.DshShell.startServer === "function";
        out.hasOpenPane = typeof window.DshShell.openPane === "function";
        /* 唯一允许调用的是 state() —— 纯查询，不改任何状态 */
        if (out.hasState) {
          try {
            var raw = window.DshShell.state();
            out.stateRaw = String(raw).slice(0, 400);
            var o = JSON.parse(raw || "{}");
            out.parsed = true;
            out.termuxPerm = !!(o && o.termuxPerm);
            out.stateText = o && o.stateText;
            out.versionName = o && o.versionName;
          } catch (e2) { out.parsed = false; out.stateErr = String((e2 && e2.message) || e2).slice(0, 120); }
        }
        /* 结论：dshShellState() 返回非 null 时，下面那批「原生壳」菜单项
           （重启内核 / 网页版 / 开放平台，以及权限未授予时的授权项）才会进 want[]。
           此处刻意不写具体条数：2026-10-06 把「启动/停止服务」合并成「重启内核」后
           数量已变，写死数字只会变成下一个过期断言。 */
        out.willInjectShellItems = !!dshShellState();
      } catch (e) { out.err = String((e && e.message) || e).slice(0, 120); }
      return out;
    }

    /* ---------- 定位这两个原生芯片（类名优先，文案兜底）---------- */
    function findJobsChip() {
      var el = document.querySelector(JOBS_ROOT);
      if (el) return el;
      /* 兜底：按文案 "N 个后台任务[运行中]" 找 */
      var btns = document.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) {
        var tx = (btns[i].textContent || "").trim();
        if (/\d+\s*\u4e2a\u540e\u53f0\u4efb\u52a1/.test(tx)) return btns[i];
      }
      return null;
    }

    function findPresetChip() {
      var el = document.querySelector(PRESET_LABEL);
      if (el) return el;
      /* 兜底：带 title 的短文本 span（AgentPresetLabel 的特征） */
      var cands = document.querySelectorAll("span[title]");
      for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        if (c.querySelector("svg") && !c.querySelector("button") &&
            (c.textContent || "").trim().length <= 14) return c;
      }
      return null;
    }

    /* ---------- 用内联样式直接隐藏（拿到元素就不依赖任何选择器）---------- */
    function hideJobsChip(el) {
      if (!el) return;
      var r = el.style;
      r.setProperty("position", "fixed", "important");
      r.setProperty("left", "16px", "important");
      r.setProperty("top", "54px", "important");
      r.setProperty("width", "1px", "important");
      r.setProperty("height", "1px", "important");
      r.setProperty("overflow", "visible", "important");   /* 不能裁掉里面的弹层 */
      r.setProperty("z-index", "100000", "important");
      var t = el.querySelector("button") || el;
      var q = t.style;
      q.setProperty("opacity", "0", "important");
      q.setProperty("width", "1px", "important");
      q.setProperty("height", "1px", "important");
      q.setProperty("min-height", "0", "important");
      q.setProperty("min-width", "0", "important");
      q.setProperty("padding", "0", "important");
      q.setProperty("gap", "0", "important");
      q.setProperty("border", "0", "important");
      q.setProperty("overflow", "hidden", "important");
      q.setProperty("pointer-events", "none", "important");
    }

    function hidePresetChip(el) {
      if (!el) return;
      el.style.setProperty("display", "none", "important");
    }

    /* 一发现就隐藏，不再要求「先点一次 ⋮ 解锁」。
       入口保底改由胶囊面板承担：后台任务可在面板里直接展开列表，Agent 预设也在面板里。
       所以即使 ⋮ 菜单注入哪天失效，功能依然可达。 */
    function syncMovedChips() {
      var html = document.documentElement;
      var jobs = findJobsChip();
      var preset = findPresetChip();
      if (jobs) { html.setAttribute("data-dsh-moved-jobs", "1"); hideJobsChip(jobs); }
      else html.removeAttribute("data-dsh-moved-jobs");
      if (preset) { html.setAttribute("data-dsh-moved-preset", "1"); hidePresetChip(preset); }
      else html.removeAttribute("data-dsh-moved-preset");
    }

    function closeMoreMenu() {
      try {
        var t = document.querySelector('button[class*="moreButton"]');
        if (t && t.getAttribute("aria-expanded") === "true") t.click();
      } catch (e) {}
    }

    /* 打开原生后台任务列表：锚点已在 CSS 里挪到 ⋮ 下方 */
    function openJobsList() {
      try {
        var root = document.querySelector(JOBS_ROOT);
        if (!root) return;
        var trig = root.querySelector("button");
        if (trig) trig.click();
      } catch (e) {}
    }

    /* ========== ★ 2026-10-06：⋮ 菜单镜像官方侧栏（用户 m07110） ==========
       用户原话要点："官方的侧边栏不是有5个按键吗？把他们的名字记在右上角的这个菜单栏中。
       在菜单栏里面调用。同时也保留手机动作滑出侧边栏的作用。同时右上角的这个菜单中
       再加上一个功能，回到主界面。侧边栏的这几个按键就不用保留了。"

       于是：菜单里出现官方侧栏的 5 个按键（新建会话 / 插件 / 自动化任务 / 搜索会话 /
       添加工作区 / 设置），名字与官方文案一致；用户不必再展开侧栏去点它们。
       开侧栏本身仍保留「唤出侧边栏」一项 + 左缘右划手势。

       ★ 实现原则（沿用本文件一贯做法）：**全部走程序化 .click() 找官方按钮，
         不自己实现业务逻辑**。理由：官方按钮点在哪个 handler 上是它的实现细节，
         我们只管"代用户点一下"，官方改版最多让某一项变成空操作，不会做错事。
       ★ 2026-10-06：「回到主界面」一项已按用户 m07494 删除（⋮ 菜单只在会话页存在，
         而那时回首页的需求与「新建会话」重合，见下方 goHome 处的说明）。

       ★ 判据一律用 aria-label 而不是 CSS 哈希：无障碍标签属于官方对外契约，
         改版时比 class 后缀稳得多。收起态这些按钮全都还在 DOM 里（实测 7 个全在），
         程序化 .click() 对被裁剪元素同样有效 —— 这正是"不必展开侧栏也能用"的依据。 */

    /** 通用：按官方 aria-label 找一个按钮并点击。找不到就什么都不做（不抛错）。 */
    function clickByAria(label) {
      try {
        var b = document.querySelector('button[aria-label="' + label + '"]');
        if (b) { b.click(); return true; }
      } catch (e) {}
      return false;
    }

    /** 唤出侧边栏（已展开则什么都不做）。 */
    function openSidebar() {
      try {
        var frame = document.querySelector('[class*="frame"]');
        if (frame && !frame.hasAttribute("data-sidebar-collapsed")) return;
        var tog = findSidebarToggle();
        if (tog) { tog.click(); setTimeout(syncStateNow, 250); }
      } catch (e) {}
    }

    /** 切到官方主区面板（"plugins" 插件面板 / "schedules" 自动化任务）。
        走官方 ctx.layout.selectPanel(id)，不碰 DOM。 */
    function openPanelById(id) {
      try {
        if (!layoutApi || typeof layoutApi.selectPanel !== "function") return;
        layoutApi.selectPanel(id);
        setTimeout(syncPanelOpen, 60);
      } catch (e) {}
    }

    /** 新建会话：点官方侧栏里那个「新建会话」按钮（收起态下它仍能程序化点击）。
        判据用 aria-label 而不是 CSS 哈希 —— 官方改版不易动无障碍标签。 */
    function startNewChat() {
      clickByAria(NEWCHAT_ARIA);
    }

    /** 搜索会话 / 添加工作区 / 设置 —— 都是"代用户点官方按钮"。
        （设置按钮在侧栏底部，收起态 rect 为 (-8,760,36,36)，仍在 DOM 内可点。） */
    function openSessionSearch() { clickByAria("\u641c\u7d22\u4f1a\u8bdd"); }
    function addWorkspace() { clickByAria("\u6dfb\u52a0\u5de5\u4f5c\u533a"); }

    /* ★ 2026-10-18（0.2.1-rc.2 兼容）：「设置」不再是按钮，而是菜单里的一项。
       证据（同一份健康报告升级前后对比）：aria.设置 由 1 变 0，其余 8 个 aria 锚点全在。
       根因不是探测姿势错了，是官方真换了结构：
         · 0.2.0：侧栏底部有一个 button[aria-label="设置"]（settings-general 的 fallback）。
         · 0.2.1：settings-account 把自己注入 settings.launcher 槽 ⇒ fallback 不再渲染；
           侧栏底部只剩 button[aria-label="账号菜单"]（未登录时文案「更多」），
           「设置」变成它弹出菜单里的一项。
       ⇒ 修法：候选链 —— 先试旧按钮（老版本仍走这条），再展开账号菜单点「设置」。
          以后官方再换形态，最多让这一项变成空操作，不会做错事。 */
    function openSettings() {
      /* ① 老形态：侧栏底部直接就是设置按钮 */
      if (clickByAria("\u8bbe\u7f6e")) return true;
      /* ② 新形态：展开账号菜单。菜单由 React 渲染，不能同步查，要等它挂载。 */
      if (!(clickByAria("\u8d26\u53f7\u83dc\u5355") || clickByAria("\u66f4\u591a"))) return false;
      var tryFind = function () {
        try {
          var menus = document.querySelectorAll('[role="menu"]');
          for (var i = 0; i < menus.length; i++) {
            var items = menus[i].querySelectorAll('[role="menuitem"], [role="menuitemradio"], button, li');
            for (var j = 0; j < items.length; j++) {
              if ((items[j].textContent || "").trim() !== "\u8bbe\u7f6e") continue;
              var target = items[j].querySelector('button, [role="menuitem"], [role="menuitemradio"]') || items[j];
              target.click();
              return true;
            }
          }
        } catch (e) {}
        return false;
      };
      if (tryFind()) return true;
      setTimeout(tryFind, 60);
      setTimeout(tryFind, 180);
      return true;   /* 账号菜单已经点开了：即使没找到「设置」，也不算什么都没做 */
    }

    /* ★ 2026-10-06 删除「回到主界面」（用户 m07494）：
       用户原话要点 —— "位于其他页面的时候回到主界面，这个按钮是完全调不出来的，
       这个是存在于菜单栏中，而这个菜单栏是只有主界面才有的，没什么用，把它去掉就可以了。"

       ★ 这个判断是对的，而且比表面更深一层：⋮ 菜单**只存在于会话页**
         （欢迎页 header 是 wSkVaW_headerBlank，moreButton 数量为 0），
         所以「回到主界面」永远只能在已经不在主界面、但恰好有 ⋮ 的会话页被点到 ——
         而那时点它 = 回欢迎页 = 与隔壁的「新建会话」几乎同效，纯属冗余。
         真正需要它的场景（在设置页 / 插件面板想回首页）根本没有 ⋮ 可点。
       连带删掉的：goHome()、ICON_HOME、ctxRef（只为它而留）。
       留下的「新建会话」已能覆盖"回到没有会话的首页"这个需求 ——
       官方侧栏那枚按钮在无最近工作区时本身就调 clearMain()。 */

    function setMenuItemLabel(clone, text) {
      var deepest = null, depth = -1, all = clone.querySelectorAll("*");
      for (var j = 0; j < all.length; j++) {
        if (all[j].children.length) continue;
        if (!(all[j].textContent || "").trim()) continue;
        var dep = 0, q = all[j];
        while (q && q !== clone) { dep++; q = q.parentElement; }
        if (dep > depth) { depth = dep; deepest = all[j]; }
      }
      if (deepest) deepest.textContent = text;
    }

    function setMenuItemIcon(clone, svgHTML) {
      var box = clone.querySelector('[class*="itemIcon"]');
      if (box && svgHTML) box.innerHTML = svgHTML;
    }

    function injectMenuItems() {
      var diag = [];
      try {
        syncMovedChips();
        var more = document.querySelector('button[class*="moreButton"]');
        diag.push("\u22ee:" + (more ? "\u2713" : "\u2717"));
        if (!more) { window.__dshMenuDiag = diag.join(" "); return; }

        /* 全文档查找，不假设它们在 <header> 里 */
        var jobsRoot = findJobsChip();
        var preset = findPresetChip();
        diag.push("\u4efb\u52a1:" + (jobsRoot ? "\u2713" : "\u2717"));
        diag.push("\u9884\u8bbe:" + (preset ? "\u2713" : "\u2717"));

        var tr = more.getBoundingClientRect();
        var menus = document.querySelectorAll('[role="menu"]');
        var m = null;
        for (var i = 0; i < menus.length; i++) {
          var r = menus[i].getBoundingClientRect();
          if (r.width < 20 || r.height < 12) continue;          /* 关着的菜单 */
          if (Math.abs(r.right - tr.right) > 100) continue;     /* 不是这个 ⋮ 的 */
          if (r.top < tr.top - 30 || r.top > tr.bottom + 30) continue;
          m = menus[i];
          break;
        }
        diag.push("\u83dc\u5355:" + (m ? "\u2713" : "\u2717"));
        diag.push("J:" + (jobsRoot ? String(jobsRoot.className || "").split(" ")[0].slice(0, 20) : "\u2014"));
        diag.push("P:" + (preset ? String(preset.className || "").split(" ")[0].slice(0, 20) : "\u2014"));
        var hd = document.documentElement;
        diag.push("hide:" + (hd.getAttribute("data-dsh-moved-jobs") || "-") + "/" + (hd.getAttribute("data-dsh-moved-preset") || "-"));
        window.__dshMenuDiag = diag.join(" ");
        /* ★ 2026-10-05：want[] 的构造**故意放在 `if (!m)` 之前**。
           原来菜单没打开时直接 return，于是"打算注入什么"完全观测不到，
           报告里只能看到 menuReport=null —— 分不清"没观测"和"没构造"。
           现在无论菜单开没开，都先把意图算出来记到 window.__dshMenuWant，
           自我检查页面在 APK 里就能不点菜单也回读这份清单（零副作用）。 */

        var want = [];

        /* ★ 2026-10-06：⋮ 菜单镜像「官方侧栏」的按键（用户 m07110）。
           名字逐字抄官方文案，与侧栏里看到的一致；用户不必再展开侧栏去点它们。
           顺序：回到主界面 → 唤出侧边栏 → 官方侧栏 5 键（新建会话/插件/自动化任务/
                 搜索会话/添加工作区）→ 设置。
           ★ 「回到主界面」放最前：它是"离当前上下文最远"的动作，且用户明确新加的一项。 */
        want.push({ key: "sidebar", label: "\u5524\u51fa\u4fa7\u8fb9\u680f", icon: ICON_SIDEBAR, run: openSidebar });
        want.push({ key: "newChat", label: "\u65b0\u5efa\u4f1a\u8bdd", icon: ICON_NEWCHAT, run: startNewChat });
        want.push({ key: "panelPlugins", label: "\u63d2\u4ef6", icon: ICON_PLUGIN, run: function () { openPanelById("plugins"); } });
        want.push({ key: "panelSchedules", label: "\u81ea\u52a8\u5316\u4efb\u52a1", icon: ICON_SCHEDULE, run: function () { openPanelById("schedules"); } });
        want.push({ key: "search", label: "\u641c\u7d22\u4f1a\u8bdd", icon: ICON_SEARCH, run: openSessionSearch });
        want.push({ key: "addWs", label: "\u6dfb\u52a0\u5de5\u4f5c\u533a", icon: ICON_ADDWS, run: addWorkspace });
        want.push({ key: "settings", label: "\u8bbe\u7f6e", icon: ICON_SETTINGS, run: openSettings });

        if (jobsRoot) {
          var cnt = jobsRoot.querySelector(JOBS_COUNT);
          var txt = cnt ? (cnt.textContent || "").trim() : "";
          want.push({
            key: "jobs",
            label: txt ? "\u540e\u53f0\u4efb\u52a1 \u00b7 " + txt : "\u540e\u53f0\u4efb\u52a1",
            icon: ICON_JOBS, run: openJobsList
          });
        }
        if (preset) {
          var ps = preset.querySelector("svg");
          want.push({
            key: "preset",
            label: (preset.textContent || "").trim() || "Agent \u9884\u8bbe",
            icon: ps ? ps.outerHTML : "", run: null
          });
        }
        /* 刷新永远在：即使两个芯片都没找到，这一项也必须注入 */
        /* [projection] 电脑 DSH —— 把电脑端 DSH 的官方界面投到手机上。
           ★ 用户要求：「像 DS 网页版和开放平台那样子直接打开一个 web」
             ⇒ 走 APK 桥 `DshShell.openUrl(url, title)`（应用内独立 WebView，
                与「DS 网页版 / 开放平台」同款体验）。
           ★ 目标是**固定地址**（Pages Functions 反代）⇒ 电脑端重启换隧道也不影响。
             它落到 /proj-pair/enter：配对过就直接给官方界面，
             没配对就给配对页（扫码或手输 8 位配对码）。
           ★ 桥不在（浏览器里打开）时退化为新标签页，不让这一项变成死的。 */
        want.push({
          key: "computerDsh",
          label: "\u7535\u8111 DSH",
          icon: ICON_COMPUTER,
          run: function () {
            var url = "https://dsh-projection.pages.dev/proj-pair/enter";
            try {
              if (window.DshShell && typeof window.DshShell.openUrl === "function") {
                window.DshShell.openUrl(url, "\u7535\u8111 DSH");
                return;
              }
            } catch (e) {}
            try { window.open(url, "_blank"); } catch (e) {}
          }
        });

        want.push({ key: "refresh", label: "\u5237\u65b0\u9875\u9762", icon: ICON_REFRESH, run: refreshPageNow });

        /* 原生壳提供的后台自启控制（浏览器里没有 window.DshShell，自动跳过） */
        var shell = dshShellState();
        if (shell) {
          if (!shell.termuxPerm) {
            want.push({
              key: "setup",
              label: "\u6388\u4e88\u300c\u5728 Termux \u4e2d\u8fd0\u884c\u547d\u4ee4\u300d\u6743\u9650",
              icon: ICON_POWER,
              run: function () { try { window.DshShell.requestSetup(); } catch (e) {} }
            });
          }
          /* ★ 2026-10-06：原「启动 DSH 服务 / 停止 DSH 服务」两项合并为这一项。
             旧的为什么坏：页面本身由内核提供 —— 点「停止」= 自杀（页面随即失联），
             点「启动」又因服务已在跑而空转；更要命的是「杀内核」这件事从 Termux
             侧根本做不到（SELinux 域不同，kill 一律 Permission denied），用户看到
             的就是"这两项失效了"。
             现在点一下 → POST /dsh-mobile/kernel-restart → 服务端半（跑在内核里）
             经 am 投递 Termux 侧重拉脚本，然后给自己 SIGTERM → 内核退出并重新拉取，
             专治不支持热加载的插件。详见 kernelRestartNow() 上方注释。 */
          want.push({
            key: "svcrestart",
            label: "\u91cd\u542f\u5185\u6838\uff08\u6740\u6b7b\u5e76\u91cd\u62c9\uff09" + (shell.termuxPerm ? "" : "  \u5f85\u6388\u6743"),
            icon: ICON_SWAP,
            run: kernelRestartNow
          });
          /* 应用内打开（独立 WebView，无 JS 桥；不上传文件；允许截屏） */
          want.push({
            key: "panechat", label: "DeepSeek \u7f51\u9875\u7248", icon: ICON_GLOBE,
            run: function () { try { window.DshShell.openPane("chat"); } catch (e) {} }
          });
          want.push({
            key: "paneplat", label: "DeepSeek \u5f00\u653e\u5e73\u53f0", icon: ICON_KEY,
            run: function () { try { window.DshShell.openPane("platform"); } catch (e) {} }
          });
        }

        /* ========== 内核切换三项:已按用户要求移除（2026-10-05）==========
           原「切到新版内核 v0.2.0 / 切回旧版内核 v0.1.5 / 内核切换状态」三项走
           window.DshShell.repair("kernel-new"|"kernel-old"|"kernel-status")。
           移除理由：旧版 0.1.5 已冻结（包目录改名，任何入口都起不来），
           新版容器 0.2.0 是唯一可用内核 ⇒ 三项点下去都没有实际意义，
           留在菜单里只会让人误以为还能切回去。
           ★ 如果将来真的需要回滚能力，恢复办法：把这段 if (shell) {...} 加回来即可，
             APK 侧的 repair() 桥方法还在（dex 里已核实存在），不用改 APK。 */

        /* 检查更新：扫描存储里的安装包 → 有新版就自动下载并拉起安装器 */
        want.push({
          key: "update",
          label: "\u68c0\u67e5\u66f4\u65b0  v" + (window.__DSH_APP_VERSION_NAME || (shell && shell.versionName) || "?"),
          icon: ICON_UPDATE,
          run: checkForUpdate
        });

        var stamp = want.map(function (w) { return w.key + ":" + w.label; }).join("|");
        /* 长期诊断：把"打算注入哪些项"记下来，供自我检查页面在 APK 里回读。
           只写变量，没有任何副作用（不点菜单、不发请求）。 */
        try { window.__dshMenuWant = want.map(function (w) { return w.key + "\u0000" + w.label; }); } catch (eW) {}

        /* 菜单没打开时，意图已记入 __dshMenuWant，到此为止（不做 DOM 操作）。 */
        if (!m) return;
        /* 模板项：优先原生 menuitem，退而求其次用菜单的第一个孩子 */
        var nativeBtn = m.querySelector('[role="menuitem"]');
        var template = nativeBtn ? (nativeBtn.parentElement || nativeBtn) : m.firstElementChild;
        if (!template || template === m) { window.__dshMenuDiag += " \u65e0\u6a21\u677f"; return; }

        if (m.getAttribute("data-dsh-menu") === stamp) return;   /* 已是最新 */

        var old = m.querySelectorAll('[data-dsh-menu-item="1"]');
        for (var o = old.length - 1; o >= 0; o--) if (old[o].parentNode) old[o].parentNode.removeChild(old[o]);

        var ok = 0;
        for (var w = 0; w < want.length; w++) {
          var clone;
          try {
            clone = template.cloneNode(true);
          } catch (e2) { diag.push("clone:" + (e2 && e2.message)); break; }
          try {
            var ids = clone.querySelectorAll("[id]");
            for (var k = 0; k < ids.length; k++) ids[k].removeAttribute("id");
            clone.removeAttribute("id");
            clone.setAttribute("data-dsh-menu-item", "1");
            setMenuItemLabel(clone, want[w].label);
            setMenuItemIcon(clone, want[w].icon);
            (function (it, cl) {
              var btn = cl.querySelector('[role="menuitem"]') || cl;
              btn.removeAttribute("disabled");
              btn.addEventListener("click", function (ev) {
                ev.preventDefault(); ev.stopPropagation();
                closeMoreMenu();
                if (it.run) setTimeout(it.run, 110);
              }, true);
            })(want[w], clone);
            /* 挂到模板项所在的容器里 —— 不假设模板是菜单的直接子节点 */
            var host = template.parentNode || m;
            host.insertBefore(clone, template);
            ok++;
          } catch (e3) { diag.push("ins:" + (e3 && e3.message)); }
        }
        if (ok) m.setAttribute("data-dsh-menu", stamp);
        diag.push("\u6ce8\u5165:" + ok + "/" + want.length);
        /* 注入成功才隐藏原生芯片，失败则芯片留着，入口不会丢 */
        if (ok && jobsRoot) document.documentElement.setAttribute("data-dsh-moved-jobs", "1");
        if (ok && preset) document.documentElement.setAttribute("data-dsh-moved-preset", "1");
      } catch (e) {
        diag.push("err:" + (e && e.message || e));
      }
      window.__dshMenuDiag = diag.join(" ");
    }

    function installMenuInjector() {
      if (window.__dshMenuInjector) return;
      window.__dshMenuInjector = true;
      /* 点 ⋮ 之后立刻补一次（菜单刚挂载，观察器可能还没跑到） */
      document.addEventListener("click", function (ev) {
        var t = ev.target;
        if (!(t && t.closest && t.closest('button[class*="moreButton"]'))) return;
        setTimeout(injectMenuItems, 30);
        setTimeout(injectMenuItems, 120);
      }, true);
      setInterval(injectMenuItems, 400);
    }

    /* ========== 「指令」按钮与软键盘隔离 ==========
       ★★★ 2026-10-19（用户第 5 条要求）：**任何情况下都不要自动把焦点锁到输入框**，
       只有用户**主动点击**输入框才聚焦。

       原实现是"操作后 ~1.5 秒内压制"，靠一个时间窗口兜。用户实测仍然觉得
       焦点/键盘会自己冒出来 —— 因为窗口一过，官方任何一次 focus() 都能得逞。
       所以改成**白名单式**：只有当"用户自己的手指"落下时，才允许输入框获得焦点；
       其余一切来源（新建对话、切会话、面板返回、脚本 focus、autofocus…）一律拦。

       实现要点（这是本功能唯一可靠的做法）：
       ① 拦 focusin（捕获阶段，比官方任何监听都早）→ 不是用户手势引起的，立刻 blur；
       ② 拦 element.focus —— 官方调 focus() 时也骗不过去；
       ③ 拦 pointerdown / touchstart 记"用户正在点"，用极短的有效期（600ms），
          过期即视为非用户来源；
       ④ 拦 autofocus 属性，进 DOM 就摘掉。
       ★ 关键克制：**用户真点输入框时必须放行**，否则输入框就废了。
         所以 ③ 记下的"手指位置"要和被聚焦的元素做包含判断。 */
    var USER_GESTURE_MS = 600;
    var lastUserGestureAt = 0;
    var lastUserGestureTarget = null;

    function installKeyboardIsolation() {
      if (window.__dshMobileKbIsolation) return;
      window.__dshMobileKbIsolation = true;

      function isEditor(el) {
        try {
          return !!(el && el.closest
            && el.closest('[data-lexical-editor], [contenteditable="true"]'));
        } catch (e) { return false; }
      }

      /* ③ 记录用户手势（越早越好：捕获阶段、passive） */
      function markGesture(ev) {
        try {
          var t = ev.target;
          if (!isEditor(t)) return;          /* 只有点在输入框上才算"想聚焦" */
          lastUserGestureAt = Date.now();
          lastUserGestureTarget = t;
        } catch (e) {}
      }
      document.addEventListener("pointerdown", markGesture, { capture: true, passive: true });
      document.addEventListener("touchstart", markGesture, { capture: true, passive: true });

      /* 用户手势是否仍然有效，且目标就是这次被聚焦的那个编辑器 */
      function userWantsFocus(el) {
        if (!lastUserGestureAt) return false;
        if (Date.now() - lastUserGestureAt > USER_GESTURE_MS) return false;
        if (!lastUserGestureTarget) return false;
        try {
          return isEditor(el)
            && (el === lastUserGestureTarget || el.contains(lastUserGestureTarget)
                || lastUserGestureTarget.contains(el));
        } catch (e) { return false; }
      }

      /* ① focusin 拦截：比任何官方监听都早（捕获阶段） */
      document.addEventListener("focusin", function (ev) {
        try {
          var el = ev.target;
          if (!isEditor(el)) return;
          if (userWantsFocus(el)) return;     /* ★ 用户主动点的，放行 */
          try { el.blur(); } catch (e) {}
          /* blur 可能不生效（有的编辑器会自己抢回来），补一枪 inputmode */
          try { el.setAttribute("inputmode", "none"); } catch (e) {}
        } catch (e) {}
      }, true);

      /* ② 拦 element.focus：官方脚本调 focus() 也拦住 */
      try {
        var rawFocus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function () {
          try {
            if (isEditor(this) && !userWantsFocus(this)) {
              try { this.setAttribute("inputmode", "none"); } catch (e) {}
              return;                          /* 直接吞掉，不进原生 focus */
            }
          } catch (e) {}
          return rawFocus.apply(this, arguments);
        };
        window.__dshFocusPatched = true;
      } catch (e) { /* 某些环境不允许改原型，退回只靠 focusin */ }

      /* ④ autofocus 属性：进 DOM 就摘掉 */
      try {
        new MutationObserver(function (muts) {
          for (var i = 0; i < muts.length; i++) {
            var nodes = muts[i].addedNodes || [];
            for (var j = 0; j < nodes.length; j++) {
              var n = nodes[j];
              if (!n || n.nodeType !== 1) continue;
              try {
                if (n.hasAttribute && n.hasAttribute("autofocus")) n.removeAttribute("autofocus");
                if (n.querySelectorAll) {
                  var kids = n.querySelectorAll("[autofocus]");
                  for (var k = 0; k < kids.length; k++) kids[k].removeAttribute("autofocus");
                }
              } catch (e) {}
            }
          }
        }).observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
    }

    /* ★ 保留原函数（别处有引用），但语义改成"允许一小段放行"的老用法已不需要；
       现在它只做一件事：把当前误聚焦的编辑器踢掉。 */
    function noKeyboardBriefly(ms) {
      try {
        window.__dshMobileNoKbUntil = Date.now() + (ms || 1500);
        [80, 200, 380, 600].forEach(function (d) {
          setTimeout(function () {
            try {
              var a = document.activeElement;
              if (a && a.blur && a.closest
                  && a.closest('[data-lexical-editor], [contenteditable="true"]')) a.blur();
            } catch (e) {}
          }, d);
        });
      } catch (e) {}
    }
    function installNoKeyboardGuard() {
      /* ★ 2026-10-19：守卫已并入 installKeyboardIsolation 的 focusin 拦截，
         这里保留空实现只是为了不破坏既有调用点（autoCollapse 里还在调）。 */
    }

    /* ========== 系统返回键：先关掉本页的层，再交给 App ==========
       ★ 用户 2026-09-16 反馈：不管在哪个界面，系统返回都直接回桌面。
       ★ 2026-10-19 用户第 6 条：返回键作用保留。
       ★★★ 2026-10-20 修（用户报「系统返回键直接回桌面，应该返回上一层」）：
         真正的根因在 **App 侧根本没调用过这个函数**（`onBackPressed` 只写了 goBack）。
         已在 `MainActivity.onBackPressed` 里接上 evaluateJavascript 调用。
         这里同时把**层次顺序**再理一遍，见下面编号。 */
    function installBackHandler() {
      if (window.__dshBackInstalled) return;
      window.__dshBackInstalled = true;
      window.__dshBack = function () {
        try {
          /* ⓪ ★★ 面板页（插件 / 自动化任务）**最先判**。
             理由：它们是把主界面**替换掉**的页，不是"层"。
             用户按一次返回，最期望的是"回到主界面"。
             ★ 2026-10-20：`panelIsOpen()` 现在只信官方 API（见该函数注释）。
               所以这里再加一条**不依赖它**的兜底：只要"回对话"这个动作**能成功**，
               就说明当前确实在面板页里 —— 直接调，不先判。
               （`backToConversation()` 自己会在不是面板页时返回 false，安全。） */
          if (layoutApi && panelIsOpen()) {
            if (backToConversation()) return true;
          }

          /* ① 设置页：内容页 → 导航页 → 关整个面板 */
          if (settingsBack()) return true;

          /* ② 图标轨（我们自己的一级展开）→ 收回 */
          if (railIsOpen()) { exitRail(true); return true; }

          /* ③ 完整侧栏 → 收起 */
          var frame = document.querySelector('[class*="frame"]');
          if (frame && !frame.hasAttribute("data-sidebar-collapsed")) {
            openToClosed();
            return true;
          }

          /* ④ 任何弹窗 / 官方设置层 → 发 Escape（多数弹层都认） */
          if (document.querySelector('[data-dsh-settings-layer="1"], [role="dialog"]')) {
            try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true })); } catch (e) {}
            return true;
          }

          /* ⑤ 还有一层没试到：面板页兜底再试一次（有些时序下面板是异步开的） */
          if (backToConversation()) return true;

          return false;   /* 确实没有可关的层 ⇒ 交给 App 退到后台 */
        } catch (e) { return false; }
      };
    }

    /* ========== 边缘滑动开关左侧栏（2026-09-16 用户提问：能不能向右划把侧栏划出来）==========
       ★ 重要前提：Android 15 手势导航下**最左那条边（约 24px）= 系统"返回"**，WebView 收不到；
         所以这里从"左侧一带"（默认左边 160px 内）起手，**把最边缘留给系统返回**。
         想要"最边缘也能划"就得改 APK（setSystemGestureExclusionRects），需要重打包+装一次。
       v1 是"划一下触发"（不是跟手拖动）：向右划开、向左划关。 */
    /** ★ 2026-09-16 用户反馈：左右滑动表格时很容易误开侧栏 ⇒
     *  起手点若在"横向可滚动"的容器里（表格、代码块、任何 overflow-x:auto/scroll），本手势直接不介入。
     *
     *  ★★★ 2026-10-20 追加一个重要例外（这是"之后连侧边栏都划不出来"的根因之一）：
     *  这个守卫是"检测到横向可滚动就 **return**"，它**分不清**溢出是谁造成的。
     *  而我们把侧栏撑到 100vw 之后，frame 本身就可能横向溢出
     *  ⇒ 守卫把**侧栏自己的手势**也挡了 ⇒ 死锁。
     *  ⇒ 如果当前正处在我们的 rail / overlay 状态，说明溢出是我们自己造成的，
     *     **不要**用这个守卫拦（否则再也回不去了）。
     *  ★ 只检查 <html> 上的属性，不碰布局，开销为零。
     */
    function inHorizontalScroller(el) {
      try {
        var h = document.documentElement;
        if (h.getAttribute("data-dsh-rail") === "1"
            || h.getAttribute("data-dsh-sidebar-overlay") === "1") {
          return false;   /* 我们自己的状态 ⇒ 不拦，保证能划回去 */
        }
      } catch (e) {}
      var n = el, i = 0;
      while (n && i < 6) {
        try {
          if (n.scrollWidth && n.clientWidth && n.scrollWidth > n.clientWidth + 8) {
            var ox = "";
            try { ox = window.getComputedStyle(n).overflowX || ""; } catch (e) {}
            if (ox === "auto" || ox === "scroll" || ox === "overlay") return true;
          }
          var tag = (n.tagName || "").toLowerCase();
          if (tag === "table" || tag === "pre") return true;
        } catch (e) {}
        n = n.parentElement; i++;
      }
      return false;
    }

    var EDGE_BAND = 220;      /* 起手带（已放宽为整屏，保留常量供老逻辑兼容） */
    var EDGE_MIN = 42;        /* 触发位移（用户：再迟钝一点，但**不超过第1版的45**） */
    var EDGE_SLOPE = 62;      /* 纵向容差（再收严一点） */
    function installEdgeSwipe() {
      if (window.__dshMobileEdgeSwipe) return;
      window.__dshMobileEdgeSwipe = true;
      var sx = 0, sy = 0, st = 0, mode = "";
      /* ★ 2026-10-20：touchmove 里累计的峰值位移（见 touchstart 注释） */
      var maxDx = 0, maxDy = 0, moved = false;
      document.addEventListener("touchstart", function (ev) {
        try {
          mode = "";
          if (window.innerWidth > 820) { diagLog("touch.skip.wide", { w: window.innerWidth }); return; }
          if (!ev.touches || ev.touches.length !== 1) { diagLog("touch.skip.multi", { n: ev.touches ? ev.touches.length : -1 }); return; }
          var t0 = ev.target;
          if (t0 && t0.closest && t0.closest('[data-lexical-editor], [contenteditable="true"]')) { diagLog("touch.skip.editor", {}); return; }
          if (inHorizontalScroller(t0)) { diagLog("touch.skip.hscroll", railSnapshot()); return; }
          if (document.querySelector('[data-dsh-settings-layer="1"]')) { diagLog("touch.skip.settings", {}); return; }
          var frame = document.querySelector('[class*="frame"]');
          if (!frame) { diagLog("touch.skip.noframe", {}); return; }
          var collapsed = frame.hasAttribute("data-sidebar-collapsed");
          var x = ev.touches[0].clientX, y = ev.touches[0].clientY;
          sx = x; sy = y; st = Date.now();
          /* ★★★ 2026-10-20：记录**移动过程中的最大位移**。
             为什么：真机日志里 `touchend` 的 dx 恒为 0 ——
             因为侧栏（或内部列表）接管了滑动、或者浏览器发了 touchcancel，
             touchend 报的坐标和起点一样。只靠 touchend 算位移会得出"没动过"的错误结论。
             ⇒ 现在用 touchmove 记峰值，touchend 时取 max(峰值, touchend位移)。 */
          maxDx = 0; maxDy = 0; moved = false;
          var w = window.innerWidth;
          var inBand = (x >= 20 && x <= w - 20);
          if (!inBand) { diagLog("touch.skip.band", { x: x, w: w }); return; }

          /* ★★★ 2026-10-20（用户澄清）：**面板页（插件/自动化任务）这类界面上，
                向右滑不触发任何东西。** 回主界面只走系统返回键。

                ★★ 第三次修正：前两版这里都因为"猜面板页"猜错而把主界面手势挡死。
                  这一版**只信官方 API**：`panelIsOpen()` 现在内部只看
                  `layoutApi.panelInfo`，取不到就返回 false ⇒ **绝不误挡**。
                  再叠一层保险：`layoutApi` 都没有时，直接当作"不是面板页"。 */
          if (layoutApi && panelIsOpen()) { diagLog("touch.skip.panel", railSnapshot()); return; }
          /* ★★★ 2026-10-19（用户第 1 条）：手势改成**三级**语义。
               · 现在处于图标轨（rail）且是右划 → "railOpen"（继续展开成完整侧栏）
               · 侧栏完全展开时右划进来的情况由 collapsed=false 分支兜（"close"）
               · 侧栏收起时右划 → "rail"（先只滑出图标轨）
             面板页那条（"back"）保留原样：面板页上右划仍然 = 回对话。 */
          if (railIsOpen()) {
            /* ★★ 2026-10-20 修 bug（用户报「再划一次打不开大侧栏」）：
               原来这里要求 `x < 120`（起手点在左侧 120px 内）才算"继续展开"。
               可图标条本身只有 ~42dp 宽，用户第二下基本从**屏幕中间**划过来，
               根本不在 120px 内 ⇒ 被判成 railClose / 或什么都不做
               ⇒ **永远打不开完整侧栏**。
               ⇒ 现在 rail 态**不限制起手位置**：右滑=展开，左滑=收回（在 touchend 里按 dx 判）。 */
            mode = inBand ? "railOpen" : "";
          } else {
            /* ★ 2026-10-20：面板页已经不在这里判了 —— 上面那条 `if (panelIsOpen()) return;`
               会在更早的位置直接退出，所以走到这里的都不是面板页。 */
            mode = inBand ? (collapsed ? "rail" : "close") : "";
          }
          /* ★ 诊断放在**赋值之后**：即使它炸了，mode 也已经算好了。
             （第一版就是因为它夹在赋值前面炸掉，把整个手势搞失效的。） */
          diagLog("touch.mode", { mode: mode, rail: railIsOpen(), collapsed: collapsed });
          /* 在图标轨上碰一下就算"继续操作" ⇒ 重置 3 秒计时（用户要求） */
          if (railIsOpen()) railActivity();
        } catch (e) { mode = ""; }
      }, { capture: true, passive: true });
      /* ★★★ 2026-10-20：记录滑动过程中的位移峰值。
         真机日志显示 `touchend` 的 dx 恒为 0（滑动被侧栏内部容器接管 /
         浏览器发了 touchcancel），只信 touchend 会得出"没动过"的错误结论。
         ⇒ 在 touchmove 里累计，touchend 取两者较大的那个。 */
      document.addEventListener("touchmove", function (ev) {
        try {
          if (!mode) return;
          var t = (ev.touches && ev.touches[0]) || null;
          if (!t) return;
          var dx = t.clientX - sx, dy = t.clientY - sy;
          if (Math.abs(dx) > Math.abs(maxDx)) maxDx = dx;
          if (Math.abs(dy) > Math.abs(maxDy)) maxDy = dy;
          if (Math.abs(dx) > 10 || Math.abs(dy) > 10) moved = true;
        } catch (e) {}
      }, { capture: true, passive: true });

      document.addEventListener("touchend", function (ev) {
        try {
          if (!mode) return;
          var m = mode; mode = "";
          var t = (ev.changedTouches && ev.changedTouches[0]) || null;
          if (!t) return;
          var endDx = t.clientX - sx, endDy = t.clientY - sy;
          /* ★ 取"终点位移"与"过程峰值"里绝对值更大的那个 ——
             解决 touchend 报 0 的情况。 */
          var dx = Math.abs(endDx) >= Math.abs(maxDx) ? endDx : maxDx;
          var dy = Math.abs(endDy) >= Math.abs(maxDy) ? endDy : maxDy;
          var dt = Date.now() - st;
          diagLog("touch.end", { mode: m, dx: dx, dy: dy, dt: dt,
                                 endDx: endDx, peakDx: maxDx, moved: moved,
                                 min: EDGE_MIN, slope: EDGE_SLOPE });
          if (dt > 750 || Math.abs(dy) > EDGE_SLOPE) { diagLog("touch.reject.slopetime", { dt: dt, dy: dy }); return; }

          /* ★ 2026-10-20：`"back"`（面板页右划回主界面）**已删除**。
             用户明确要求面板页上右划「不触发任何东西」，只留系统返回。
             面板页在 touchstart 里就 early-return 了，这里走不到 "back"。 */
          if (m === "railOpen") {                 /* 图标轨：右滑 → 完整侧栏；左滑 → 收回 */
            if (dx >= EDGE_MIN) railToOpen();
            else if (dx <= -EDGE_MIN) exitRail(true);
            return;
          }
          /* railClose 已被合并进 railOpen 分支（按 dx 正负分开），这里不再需要 */
          if (m === "rail") {                     /* 收起 → 图标轨（第一段） */
            if (dx >= EDGE_MIN) enterRail();
            return;
          }
          if (m === "close") {                    /* 完整侧栏 → 收起 */
            /* ★★★ 2026-10-20 修（用户报「右滑失效」的真相）：
               原来的条件是 `if (dx > -EDGE_MIN) return;` —— **只认左滑**。
               但用户一旦进了完整侧栏，右滑就再也出不去了（因为 collapsed=false
               会一直走 close 分支，而 close 只认左滑）⇒ 表现为"手势彻底失效"。

               ★ 现在**两个方向都能收起**：左滑（原本的）或右滑（新增的逃生口）。
                 右滑在"完整侧栏"状态下语义上是"往里推"的逆操作，不会误伤
                 （因为侧栏已经占满全屏，主界面不可见，不存在"右滑开侧栏"的需求）。
               ★ 另外还接受"点一下空白"（dx≈0 且 dt 很短）——见下。 */
            var frame = document.querySelector('[class*="frame"]');
            if (frame && frame.hasAttribute("data-sidebar-collapsed")) return;
            /* ★ 双向都能收：左滑（原语义）或右滑（新增逃生口）。
               ★ 不加"点一下就收" —— 那会把侧栏里正常的点击按钮全变成"收起"，太危险。 */
            if ((dx <= -EDGE_MIN) || (dx >= EDGE_MIN)) { openToClosed(); return; }
            return;
            return;
          }
        } catch (e) {}
      }, { capture: true, passive: true });

      /* ★ 用户第 1 条要求：「如果做了第1个动作之后，没有再继续滑动或者是点击侧边栏的
         这些按钮，则三秒后又收回去」。
         任何落在侧栏里的点击都算"继续操作"，重置计时器；
         点了具体条目（会话/新建/设置…）则直接进完整侧栏 —— 那是明确的意图。 */
      document.addEventListener("click", function (ev) {
        try {
          if (!railIsOpen()) return;
          var t = ev.target;
          if (!t || !t.closest) return;
          if (!t.closest('[class*="sidebarCol"]')) return;   /* 只认侧栏内的点击 */
          railActivity();
          /* ★★ 2026-10-20 改：这里原本是"点图标 ⇒ 自动继续展开成完整侧栏"。
             但用户新要求是「点侧栏里任何按键后**自动收起**」，两者冲突。
             ⇒ 删掉展开逻辑。现在点图标的行为由 installAutoCollapse 统一处理：
               直接执行那个按钮（新建/搜索/添加工作区…），然后收起侧栏。
             ★ 那个 ⋯ 的例外也在 installAutoCollapse 里判断。 */
        } catch (e) {}
      }, true);
    }

    /* ========== 点会话 / 点「新建对话」后都自动收起侧栏 ========== */
    /** 判断这次点击是不是侧栏里的"新建对话"类按钮（文字或 aria-label 命中）。
     *  ★ 2026-09-16 用户反馈：在左侧栏点「创建新的对话」之后**没有自动跳回主界面**
     *    —— 原因是这里原来只认 sessionRow（已存在的会话行），新建按钮不在其中。 */
    function isNewChatTarget(t) {
      try {
        var el = t.closest && t.closest('button, a, [role="button"], [role="menuitem"], [class*="item"], [class*="Item"]');
        if (!el) return false;
        var txt = (el.textContent || "") + " ";
        try {
          txt += (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "") + " " + (el.getAttribute("data-testid") || "");
        } catch (e2) {}
        return /新对话|新建对话|创建新的对话|新的对话|新建会话|新会话|新建任务|new chat|new conversation/i.test(txt);
      } catch (e) { return false; }
    }
    function collapseSidebar(delay) {
      setTimeout(function () {
        try {
          /* ★★★ 2026-10-20 修（用户报「侧边栏收回后又自动拉起」）：
             这里原来**无条件**点官方 toggle。问题是：
             ① collapseSidebar 是**延时**执行的（0~320ms）
             ② 这段时间里官方很可能**自己已经把侧栏收起了**
                （点对话/面板页/关闭按钮，官方本来就会收）
             ③ 定时器到点时，侧栏已经是"收起"状态
             ④ 我再点一下 toggle ⇒ **又把它打开了** ⇒ "收回后又自动拉起"

             ⇒ 修法：**点之前重新读一次真实状态**，只有"官方侧栏确实还开着"才点。
               `toggle` 是开关不是按钮 —— 这条教训本项目已栽过两次。 */
          var h = htmlEl();
          var wasRail = railIsOpen();
          h.removeAttribute("data-dsh-rail");
          h.removeAttribute("data-dsh-rail-closing");
          h.removeAttribute("data-dsh-sidebar-overlay");
          h.removeAttribute("data-dsh-sidebar-closing");
          clearRailIdle();
          clearRailClose();

          var stillExpanded = false;
          try {
            var f2 = document.querySelector('[class*="frame"]');
            stillExpanded = !!(f2 && !f2.hasAttribute("data-sidebar-collapsed"));
          } catch (e) { stillExpanded = false; }

          diagLog(stillExpanded ? "collapse.do" : "collapse.skip",
                  { wasRail: wasRail, stillExpanded: stillExpanded, delay: delay });

          if (!wasRail && stillExpanded) {
            var tog = findSidebarToggle();
            if (tog) tog.click();
          }
          setTimeout(syncStateNow, 250);
        } catch (e) {}
      }, delay);
    }
    /* ========== 点侧栏里的东西后自动收起（2026-10-20 用户新增要求）==========
       用户原话：
         「点击侧边栏里任何一个按键后自动收起侧边栏（但是，点击左下角这个按键后不要收回，
           他会拉起一个列表，包含设置，意见反馈，登录，点了这三个后再收回侧边栏）。」

       ⇒ 规则：
         · 侧栏里**任何按钮** → 收起
         · **唯一例外**：左下角那个 `⋯`（点开是一个含「设置/意见反馈/登录」的列表）→ **不收起**
         · 点列表里那三项 → 收起

       ★★ 怎么认那个 `⋯`？**不猜 class、不猜 aria** —— 那些都是官方的实现细节，
          一升级就变（这个项目已经被"猜 CSS 类名"坑过好几次）。
          改成**看结果**：点完之后等 160ms，看页面上有没有浮出**含
          「设置/意见反馈/登录」**的列表。有 ⇒ 这是"开列表"的按钮，保留侧栏；
          没有 ⇒ 收起。

          这样做的好处：不依赖任何选择器，官方换写法也不影响；
          代价是收起慢了 160ms —— 肉眼几乎无感，换来的是不会误判。 */


    /* ========== 点侧栏里的东西后**按白名单**收起（2026-10-20 用户第 11 条）==========
       用户原话：
         「现在点击侧边栏任何按钮不再直接回主界面，只有以下几个回去——
           插件和自动化任务以及和这两个注册同类座位的其他按钮（很多插件会在这里加按钮），
           新对话按钮，任何一个对话，侧边栏右上角的关闭侧边栏按钮——只有这几个会回去。」

       ★★★ 这一条把上一轮的逻辑**整个反过来**了：
         · 上一轮（用户第 9 条）：默认**都收起**，只有 `⋯` 例外
         · 这一轮（第 11 条）：默认**都不收起**，只有白名单里的才收起

       ⇒ 白名单只有三类：
         ① **对话 / 会话行**（点任何一个对话 → 回主界面看它）
         ② **新建对话**按钮
         ③ **面板类座位**：插件、自动化任务，**以及其它插件注册到同一批座位的按钮**
         ④ **侧栏右上角的"关闭侧边栏"按钮**

       ★★ 关键难点：③ 要能覆盖"很多插件都会在这里加按钮"。
          不能只认「插件」「自动化任务」两个中文词 —— 那只能覆盖官方的两个。
          做法：**认座位容器**，不认文字。
          官方和第三方插件注册的这类入口，都渲染在同一个"座位区"里；
          我们先动态探测出那个容器（包含"插件"或"自动化任务"文字的那个块），
          然后**同一个容器里的任何条目**都算面板类。
          这样第三方插件加的按钮，只要在同区，就自动被覆盖 —— 不需要知道它叫什么。

       ★ `hasSettingsPopup()` 那套 160ms 猜法**整个删掉**了 —— 不需要了：
         现在默认不收起，只有明确命中白名单才收，不存在"误收"的风险。 */

    /** 判断元素是否在"面板类座位区"里（插件 / 自动化任务 / 第三方插件加的同类入口）。
     *
     * ★★★ 2026-10-20 第二次修正（用户报「点 ⋯ 那三个选项后侧栏也收起了」）：
     *
     * 旧实现是"找「插件」「自动化任务」的共同父容器，往上层最多 4 层，
     * 目标在这个容器里就算"。
     *
     * **它把 `⋯` 也吞了。** 因为侧栏那一整列就是同一个容器 ——
     * 往上层走 2~3 层就必然把整条侧栏当"座位区"，于是**侧栏里任何东西**都命中。
     * 日志证据：
     *   `auto.whitelist {"hit":"panelSeat"}` ← 点 `⋯` 时命中了
     *   `collapse.do {stillExpanded:true}`    ← 于是真的收起了
     *
     * ⇒ 现在的判据换成**几何 + 邻近**，不再靠祖先层级：
     *   ① 目标必须在**上半屏**（面板类座位都在侧栏上部；`⋯` 在左下角）
     *   ② 目标的**纵向位置必须与锚点接近**（同一组按钮是挨着的）
     *   ③ 另外保留"文字直接命中"这一条（官方的插件/自动化任务）
     *   三条任一命中才算。这样 `⋯` 在底部、离锚点远，两条都不满足。 */
    function inPanelSeatArea(el) {
      try {
        if (!el || !el.closest) return false;

        /* ① 文字直接命中（最可靠，仅覆盖官方的两个 + 名字里带这些词的插件） */
        var own = el.closest('button, a, [role="button"], [role="menuitem"], [class*="item"], [class*="Item"], [class*="row"], [class*="Row"]');
        if (own) {
          var txt = ((own.textContent || "") + " "
                   + (own.getAttribute("aria-label") || "") + " "
                   + (own.getAttribute("title") || "")).replace(/\s+/g, "");
          if (/插件|自动化任务|automation/i.test(txt)) return true;
        }

        /* ② 几何 + 邻近：目标要在上半屏，且与锚点纵向接近 */
        var tr, er;
        try { er = el.getBoundingClientRect(); } catch (e) { return false; }
        if (!er || er.width <= 0) return false;

        var vh = window.innerHeight || 800;
        /* ★ 关键：下半屏一律不算面板座位区。`⋯` 在左下角，直接被这里挡掉。 */
        if (er.top > vh * 0.55) return false;

        var cands = document.querySelectorAll(
            '[class*="sidebarCol"] button, [class*="sidebarCol"] a, [class*="sidebarCol"] [role="button"], [class*="sidebarCol"] [role="menuitem"]');
        var anchorTop = -1;
        for (var i = 0; i < cands.length; i++) {
          var s = ((cands[i].textContent || "") + " "
                 + (cands[i].getAttribute("aria-label") || "")).replace(/\s+/g, "");
          if (!/插件|自动化任务|automation/i.test(s)) continue;
          try { tr = cands[i].getBoundingClientRect(); } catch (e) { continue; }
          if (tr && tr.width > 0) { anchorTop = tr.top; break; }
        }
        if (anchorTop < 0) return false;

        /* ★ 与锚点的纵向距离不超过 ~3 个按钮高（约 180px）才算同一组。
           `⋯` 与插件区通常隔着整列会话列表，距离远超这个值。 */
        return Math.abs(er.top - anchorTop) <= 180;
      } catch (e) {}
      return false;
    }

    /** 是不是"关闭侧边栏"按钮（侧栏右上角那个）。 */
    function isCloseSidebarBtn(el) {
      try {
        if (!el || !el.closest) return false;
        var btn = el.closest('button, [role="button"]');
        if (!btn) return false;
        var txt = ((btn.getAttribute("aria-label") || "") + " "
                 + (btn.getAttribute("title") || "") + " "
                 + (btn.textContent || "")).replace(/\s+/g, "");
        if (/关闭侧边栏|收起侧边栏|close.?sidebar|收起|关闭/i.test(txt)) return true;
        return false;
      } catch (e) { return false; }
    }

    function installAutoCollapse() {
      if (window.__dshMobileAutoCollapse) return;
      window.__dshMobileAutoCollapse = true;
      document.addEventListener("click", function (ev) {
        try {
          if (window.innerWidth > 820) return;
          var t = ev.target;
          if (!t || !t.closest) return;

          var frame = document.querySelector('[class*="frame"]');
          if (!frame || frame.hasAttribute("data-sidebar-collapsed")) return;   /* 侧栏本来就没开 */

          /* ★★★ 2026-10-20：**先处理 `⋯` 弹出列表里的三项**。
             它们渲染在**浮层**里（不在 sidebarCol 内），所以必须放在
             "只处理侧栏内点击"那道门之前，否则永远走不到。
             用户第 9 条明确要求：「点了这三个后再收回侧边栏」。 */
          if (!t.closest('[class*="sidebarCol"]')) {
            var ltxt = ((t.textContent || "") + " "
                      + (t.getAttribute && t.getAttribute("aria-label") || "")).replace(/\s+/g, "");
            /* 只在"确实有浮层"时判断，避免把主界面上的同名文字误伤 */
            var inPopup = false;
            try {
              var pops = document.querySelectorAll(
                  '[role="menu"], [role="listbox"], [class*="menu"], [class*="popup"], [class*="dropdown"]');
              for (var pi = 0; pi < pops.length; pi++) {
                var pr = pops[pi].getBoundingClientRect();
                if (pr && pr.width > 40 && pr.height > 20 && pops[pi].contains(t)) { inPopup = true; break; }
              }
            } catch (e) {}
            if (inPopup && /^(设置|意见反馈|登录)$/.test(ltxt)) {
              diagLog("auto.whitelist", { hit: "popupItem", label: ltxt });
              installNoKeyboardGuard();
              noKeyboardBriefly(1200);
              collapseSidebar(120);
              return;
            }
            return;   /* 其它不在侧栏内的点击一律不管 */
          }

          /* ★★★ 2026-10-20：**底部那个 `⋯` 明确放行** —— 点它只拉起列表，不收侧栏。
             用户报「点 ⋯ 那三个选项后侧栏也收起了」，根因是 inPanelSeatArea
             把 `⋯` 误判成"面板类座位"（旧的共同容器判据会吞掉整条侧栏）。
             除了把 inPanelSeatArea 改成几何判据，这里再加一道**最外层保险**：
             只要点在侧栏**底部 35%** 区域内的按钮，一律不算白名单。
             ★ 用户明确说过 `⋯` 在左下角；面板类座位都在上部。 */
          try {
            var er0 = t.getBoundingClientRect ? t.getBoundingClientRect() : null;
            var vh0 = window.innerHeight || 800;
            if (er0 && er0.top > vh0 * 0.65) {
              diagLog("auto.keepOpen", { why: "bottomZone", top: Math.round(er0.top), vh: vh0 });
              return;
            }
          } catch (e) {}

          /* ---- 白名单（只有这四类会收起）---- */

          /* ① 侧栏右上角"关闭侧边栏"按钮 */
          if (isCloseSidebarBtn(t)) {
            diagLog("auto.whitelist", { hit: "closeBtn" });
            collapseSidebar(0);
            return;
          }

          /* ② 任何一个对话（会话行） */
          var isSession = !!t.closest('[class*="sessionRow"]');
          if (isSession) {
            diagLog("auto.whitelist", { hit: "session" });
            installNoKeyboardGuard();
            noKeyboardBriefly(1800);      /* 切会话不要自动弹键盘（原有行为） */
            collapseSidebar(150);
            return;
          }

          /* ③ 新建对话按钮 */
          if (isNewChatTarget(t)) {
            diagLog("auto.whitelist", { hit: "newChat" });
            installNoKeyboardGuard();
            noKeyboardBriefly(1500);
            collapseSidebar(320);
            return;
          }

          /* ④ 面板类座位：插件 / 自动化任务 / **第三方插件注册到同一批座位的按钮** */
          if (inPanelSeatArea(t)) {
            diagLog("auto.whitelist", { hit: "panelSeat" });
            installNoKeyboardGuard();
            noKeyboardBriefly(1500);
            collapseSidebar(150);
            return;
          }

          /* ---- 其余一律**不收起**（用户第 11 条的核心）---- */
          try { diagLog("auto.keepOpen", { txt: (t.textContent || "").replace(/\s+/g, "").slice(0, 12) }); } catch (e) {}
        } catch (e) {}
      }, true);
    }

    /* ========== ★ 回前台秒回：把官方连接层的退避清零（2026-10-07，任务 m02710） ==========
       症状：App 放后台一段时间再回来，页面要「加载好久」才恢复。

       病灶（读官方源码定位，非猜测）：连接层的重试退避最多顶到 10 秒，
       而**只有两件事会把它清零** —— ① 浏览器 online/offline 事件翻转
       ② 手动调 handle.reconnect()。官方前端**完全不监听 visibilitychange**
       （整个 dsh-client-connection/lib/client.js 里零命中），APK 壳回前台也不发任何信号。
       所以切后台期间连接一旦断了，attempt 会一路涨到 5 次以上，
       `backoffCap = min(10000, 500 * 2^(attempt-1))` 恒为 10s，
       `backoffDelay = cap/2 + random()*cap/2` ⇒ 回前台后最坏要等约 10 秒才重连一次。

       修法：在页面重新可见时调 `ctx.get("connection").reconnect()`。
       官方实现是 `attempt = 0; immediateRetry = true; 并 abort 当前流`
       ⇒ **退避立刻归零、马上重试**，不用刷新页面、更不用重下那 24MB 前端包。

       ★ 关键克制：**连接正常时绝不碰它**。因为 reconnect() 会 abort 当前流，
         如果用户只是切出去看一眼再回来、而回复正在流式输出，乱调会把回复打断。
         所以只有在状态确实不是 "connected" 时才动手 —— 那时它本来就是断的。 */
    function installConnectionResume() {
      if (window.__dshResume) return;
      window.__dshResume = true;

      var MIN_HIDDEN_MS = 1000;   /* 短于这个的后台切换不动连接，避免无谓重连 */
      var KICK_GAP_MS = 3000;     /* 连续触发时的最小间隔（防抖） */
      var hiddenAt = 0;
      var lastKick = 0;
      /* ★ 2026-10-10 取证计数：用户报「滑后台回来要重连好久」，光靠猜不够，
         这几个数字随报告落盘，下次一眼看出到底有没有被唤醒、被唤醒几次。 */
      var diag = { vis: 0, page: 0, pageshow: 0, online: 0, shellKnock: 0, kicks: 0, skipConn: 0, startAsk: 0, last: "" };
      window.__dshResumeStats = function () { return diag; };

      function conn() {
        try { return ctxRef ? ctxRef.get("connection") : null; } catch (e) { return null; }
      }
      function stateOf(h) {
        try { var s = h.state.getSnapshot(); return typeof s === "string" ? s : ""; } catch (e) { return ""; }
      }

      /* ★ 2026-10-10 关键加固：**一次唤醒要试多次**。
         病灶（在真机上才会显现）：WebView 被系统冻结时 JS 全停，连接层
         **察觉不到流已经断了**，state 仍停在 "connected"。回前台的第一瞬间
         调 revive() 会被「活着就别打扰它」挡回去；等流真正报错、state 落到
         connecting/disconnected，往往已经是几百毫秒到几秒之后 —— 原来只补
         一次 2 秒后的重试，经常正好错开这个窗口，于是页面只能干等退避到期
         （最坏 10 秒一次），看起来就是「回来要重连好久」。
         所以改成一段**递增的重试序列**：只要还没连上就继续试，一旦连上立刻停。
         全程用 state 守卫 ⇒ 连接正常时是纯空操作，绝不打断正在流的回复。 */
      function revive(why) {
        try {
          var h = conn();
          if (!h || typeof h.reconnect !== "function") return;
          var st = stateOf(h);
          if (st === "connected") { diag.skipConn++; return; }   /* ★ 活着就别打扰它 */
          var now = Date.now();
          if (now - lastKick < KICK_GAP_MS) return;
          lastKick = now;
          diag.kicks++;
          diag.last = why + ":" + (st || "?") + "@" + now;
          h.reconnect();
          window.__dshResumeDiag = diag.last;
        } catch (e) {}
      }

      /* 回前台后的重试序列（毫秒）：由近及远，覆盖「流稍后才报错」的窗口。
         每次都会重新判 state，连上就不再动手。 */
      var RETRY_AT = [0, 1500, 4000, 9000];
      function reviveBurst(why) {
        try {
          for (var i = 0; i < RETRY_AT.length; i++) {
            (function (idx) {
              var d = RETRY_AT[idx];
              if (d === 0) { revive(why); return; }
              setTimeout(function () { revive(why + "+" + d + "ms"); }, d);
            })(i);
          }
        } catch (e) {}
      }

      /* ★ 前台心跳：可见期间每 8 秒看一眼。若一直不是 connected，就再踢一次。
         这条是「回前台后卡在半死状态」的兜底：不依赖事件是否派发，
         只要页面在跑就会自己发现没连上。连接正常时依旧是空操作。 */
      var beat = null, beats = 0;
      function startBeat() {
        try {
          if (beat) return;
          beat = setInterval(function () {
            beats++;
            try {
              if (document.visibilityState === "hidden") return;
              var h = conn();
              if (!h) return;
              if (stateOf(h) !== "connected") {
                /* 只在「已经不是 connected」时出手，且带 3 秒间隔 */
                revive("beat");
              }
            } catch (e) {}
          }, 8000);
        } catch (e) {}
      }

      /* ★ 确认服务端还在不在。页面里 fetch 同一来源，失败 = 内核真没了。
         这种情况光靠 reconnect() 没用（连不上就是连不上），要请 App 外壳
         把内核重新拉起来（window.DshShell.startServer 是外壳已有的座位）。 */
      var lastShellAsk = 0;
      function ensureServerAlive(why) {
        try {
          if (!window.DshShell || typeof window.DshShell.startServer !== "function") return;
          var ctl = typeof AbortController === "function" ? new AbortController() : null;
          var to = ctl ? setTimeout(function () { try { ctl.abort(); } catch (e) {} }, 4000) : null;
          fetch("/dsh-version.json", { cache: "no-store", signal: ctl ? ctl.signal : undefined })
            .then(function () { if (to) clearTimeout(to); })
            .catch(function () {
              if (to) clearTimeout(to);
              var now = Date.now();
              if (now - lastShellAsk < 15000) return;   /* 15 秒内只求一次，别刷屏 */
              lastShellAsk = now;
              diag.startAsk++;
              try { window.DshShell.startServer(); } catch (e) {}
            });
        } catch (e) {}
      }

      try {
        document.addEventListener("visibilitychange", function () {
          try {
            diag.vis++;
            if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
            var away = hiddenAt ? Date.now() - hiddenAt : 0;
            hiddenAt = 0;
            if (away < MIN_HIDDEN_MS) return;
            reviveBurst("visible");
            ensureServerAlive("visible");
          } catch (e) {}
        });
        /* Page Lifecycle：被系统冻结/解冻时也给一次机会（部分 WebView 只发 resume） */
        document.addEventListener("resume", function () { diag.page++; reviveBurst("resume"); });
        document.addEventListener("freeze", function () { hiddenAt = Date.now(); });
        window.addEventListener("pageshow", function (e) {
          diag.pageshow++;
          /* 从 bfcache 恢复（persisted）说明页面被整个冻结过，必定要救一次 */
          reviveBurst(e && e.persisted ? "pageshow-bfcache" : "pageshow");
        });
        window.addEventListener("online", function () { diag.online++; reviveBurst("online"); });
        /* App 壳在 onResume 里主动调这个（见 APK 侧 MainActivity.onResume 注入），
           让「回前台」不必等 WebView 自己派发 visibilitychange。 */
        window.__dshResumeKick = function () { diag.shellKnock++; reviveBurst("shell"); ensureServerAlive("shell"); };
        startBeat();
      } catch (e) { throw e; }
    }

    /* ========== 页面内一键更新（仅 App 内生效） ========== */
    function installUpdateChecker() {
      if (window.__dshUpdateChecker) return;
      window.__dshUpdateChecker = true;

      var tries = 0;
      var timer = setInterval(function () {
        tries++;
        if (window.__DSH_APP_VERSION) { clearInterval(timer); doUpdateCheck(); }
        else if (tries > 40) clearInterval(timer);   /* 20 秒拿不到说明是普通浏览器，不显示更新入口 */
      }, 500);
    }

    function doUpdateCheck() {
      try {
        fetch("/dsh-version.json", { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (!d || !d.versionCode) return;
            var cur = window.__DSH_APP_VERSION || 0;
            if (d.versionCode <= cur) return;
            mountUpdateButton(cur, d);
          })
          .catch(function () {});
      } catch (e) {}
    }

    function mountUpdateButton(cur, d) {
      if (document.getElementById("dsh-mobile-update")) return;
      var b = document.createElement("button");
      b.id = "dsh-mobile-update";
      b.type = "button";
      b.textContent = "\u2b06\ufe0f \u65b0\u7248\u672c " + d.versionName
        + "\uff08\u5f53\u524d " + (window.__DSH_APP_VERSION_NAME || cur) + "\uff09\u70b9\u51fb\u66f4\u65b0";
      b.addEventListener("click", function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        b.textContent = "\u23f3 \u6b63\u5728\u4e0b\u8f7d\u66f4\u65b0\u2026";
        location.href = "/dsh-update.apk";   /* App 的 DownloadListener 会接管并拉起安装器 */
      });
      document.body.appendChild(b);
    }

    /* ========== 右栏状态同步（原「余额胶囊」逻辑的遗存骨架） ==========
       ★ 2026-10-05 用户要求删除余额胶囊（"经常干扰我的UI以及出现在奇奇怪怪的地方"）。
       但原来那段代码里有三样东西**与胶囊无关**，删胶囊时**必须留下**：
         ① <html data-dsh-rightbar-open> —— CSS 靠它隐藏左上角侧栏按钮；
         ② maybeSettingsExit() —— 设置面板"退场残影"的**唯一**兜底调用点；
         ③ injectMenuItems() 的 rAF 补跑 —— 让 ⋮ 菜单不必等 400ms 轮询。
       所以这里只保留状态同步骨架；胶囊本身（pill / refresh / panel / 锚定 / 显隐）全部删除。
       ★ 教训：删一个功能前先确认"这段代码里还有没有别人的东西" —— 显隐函数当时兼着
         右栏状态同步，锚定函数兼着 rAF 维护队列，直接整段删会把左上角侧栏按钮和
         设置页退场动画一起删掉。 */

    /* 右侧栏是否已展开（frame 上的原生状态属性）
       ★ 2026-10-05 修 bug：0.2.0 改掉了面板 CSS ——
         关闭态**同样**是 display:flex + visibility:visible，只用 aria-hidden="true" 表示关闭，
         于是"看 visibility"的旧判据恒为真 ⇒ 永远返回 true。
         实测（真机 CDP）：关 = aria-hidden="true" / frame 无 data-rightbar-fullscreen；
                          开 = aria-hidden=null    / frame 有 data-rightbar-fullscreen。
         所以先跳过 aria-hidden 的面板，再看 visibility。 */
    function rightbarOpen() {
      try {
        var panels = document.querySelectorAll("[data-sidebar-right-panel]");
        for (var i = 0; i < panels.length; i++) {
          var p = panels[i];
          if (p.getAttribute("aria-hidden") === "true") continue;
          var cs = window.getComputedStyle(p);
          if (cs && cs.display !== "none" && cs.visibility !== "hidden") return true;
        }
        /* 次判据：打开的那一次提交里就已存在的属性（也覆盖面板尚未挂载的瞬间） */
        if (document.querySelector("[data-sidebar-right-open]")) return true;
        var f = document.querySelector('[class*="frame"]');
        if (!f) return false;
        if (f.hasAttribute("data-rightbar-fullscreen")) return true;
        if (!f.hasAttribute("data-rightbar-collapsed")) return true;   /* 没有 collapsed = 有轨道 = 已展开 */
        return false;
      } catch (e) { return false; }
    }

    function installRightbarState() {
      if (window.__dshRightbarState) return;
      window.__dshRightbarState = true;

      /* 右栏状态同步到 <html>，CSS 用它隐藏左上角那个侧栏按钮。
         走同一个 rightbarOpen()，所以滑出全程都不会提前露出来 */
      function syncRightbar() {
        try {
          document.documentElement.setAttribute("data-dsh-rightbar-open", rightbarOpen() ? "1" : "0");
        } catch (e) {}
      }

      syncRightbar();

      /* 任何一次点击都可能打开右栏：立即重算，不等 150ms 轮询 */
      function kickRightbar() {
        syncRightbar();
        setTimeout(syncRightbar, 60);
        setTimeout(syncRightbar, 200);
        setTimeout(syncRightbar, 420);
      }
      document.addEventListener("pointerdown", kickRightbar, true);
      document.addEventListener("click", kickRightbar, true);
      setInterval(syncRightbar, 150);

      /* ★ 保留下来的"与胶囊无关"的维护工作：
         maybeSettingsExit() 是设置面板退场残影的**唯一**兜底调用点。
         MutationObserver 回调在浏览器绘制之前执行，所以右栏"开始滑动"的那一帧
         <html> 上的属性就已经更新，不会留下滑行残影。
         ★ 2026-10-19（用户第 4 条）：原来这里还调 injectMenuItems()，
           但菜单注入已整体停用 ⇒ **不能再调**，否则会把官方的
           「Agent 预设」「后台任务」藏掉又不搬进菜单（两处都看不见）。 */
      var rafQueued = false;
      function queueMaintenance() {
        if (rafQueued) return;
        rafQueued = true;
        requestAnimationFrame(function () {
          rafQueued = false;
          syncRightbar();
          maybeSettingsExit();
        });
      }

      function attachFrameObserver() {
        var f = document.querySelector('[class*="frame"]');
        if (!f || f === window.__dshFrameEl) return;
        window.__dshFrameEl = f;
        try {
          new MutationObserver(function () { syncStateNow(); syncRightbar(); }).observe(f, {
            attributes: true,
            attributeFilter: ["data-rightbar-collapsed", "data-rightbar-fullscreen",
                              "data-rightbar-instant", "data-sidebar-collapsed", "class"]
          });
        } catch (e) {}
        /* 右栏面板是 absolute 覆盖层，它自己的属性一变就立刻重算 */
        try {
          var rbCol = f.querySelector('[class*="rightbarCol"]');
          if (rbCol && rbCol !== window.__dshRbCol) {
            window.__dshRbCol = rbCol;
            new MutationObserver(function () { syncRightbar(); }).observe(rbCol, {
              attributes: true, childList: true, subtree: true,
              attributeFilter: ["data-sidebar-right-open", "data-sidebar-right-panel",
                                "aria-hidden", "class", "style"]
            });
          }
          /* 滑出动画结束的那一瞬间，属性没有变化、观察器不会响，所以补一个 transition 收尾回调 */
          var panel = f.querySelector("[data-sidebar-right-panel]");
          if (panel && panel !== window.__dshRbPanel) {
            window.__dshRbPanel = panel;
            var onSettle = function (ev) {
              if (!ev || ev.propertyName === "transform" || ev.propertyName === "visibility") {
                syncRightbar();
              }
            };
            panel.addEventListener("transitionend", onSettle);
            panel.addEventListener("transitioncancel", onSettle);
          }
        } catch (e) {}
      }
      attachFrameObserver();
      setInterval(attachFrameObserver, 3000);   /* frame 被重建时补挂 */

      try {
        /* 设置面板 / 左侧栏状态挂在 <html> 上 */
        new MutationObserver(function () { syncRightbar(); }).observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-dsh-settings-open", "data-dsh-mobile-expanded"]
        });
        /* 菜单 / 对话框是动态挂到 body 的，用 rAF 合并，避免流式输出时抖动 */
        new MutationObserver(queueMaintenance).observe(document.body, {
          childList: true, subtree: true
        });
      } catch (e) {}
    }

    /* ========== ★ 模型选择器：搜索 + 平台筛选（2026-09-23） ==========
       用户要的：主界面输入框里的模型选择弹层，加「搜索框」+「按平台筛选」。
       官方这段（@deepseek-ai/dsh-client-ui-model-selection）在本版本里两样都没有
       （连 <input> 都没有，只有按 provider 分组的标题），所以只能由插件补。
       这是"改别人页面"的固有代价，按下面的最小侵入原则做：

        ① 只往弹层的**列表容器之前**插一个自己的工具条；不删、不移动、不重排官方节点。
        ② 过滤只改官方选项的 style.display，React 重渲染后由轮询重新施加。
        ③ 锚点优先用**语义属性**（section[role=group] / [role=menuitemradio] / div.scrollable）；
           CSS 类名只用「稳定后缀」兜底取名字（*_modelName / *_groupTitle）——
           哈希前缀会随官方构建变，导出名不会。
        ④ 弹层关掉即复位（下次打开干净）；失败由 feature() 兜住，只关这一项。

       ★ 为什么搜索框放在列表上方而不是弹层顶部：官方弹层是两级菜单（先 Model/Effort
         两个 cell，进 Model 才是列表）。插在列表容器之前 ⇒ 搜索框只出现在模型列表里，
         不会污染第一级，也不会盖住任何官方行。 */

    /* ========== ★ 兜底降级框架（2026-09-20） ==========
       为什么要有它（用户定的优先级最高的一件事）：
         改造前插件是"一次性全量生效"——apply() 里一个 try/catch 包住全部，
         **任何一处抛错就整页白屏**，唯一自救是"划掉应用重开"。
         而官方一升级，某个 CSS 哈希失效是大概率事件 ⇒ 等于"升级就可能全废"。
       现在的规矩（三件事）：
         1. 每个功能**单独** try/catch —— 一个坏了只关掉那一个，其余照常。
         2. 失败**自动重试**（最多 RETRY_MAX 次，每次间隔 RETRY_MS）：
            官方 DOM 常常比插件晚就绪，早失败不等于真坏；重试能让它自愈。
         3. 健康状态**可导出**：写进 window.__dshMobileHealth 与 localStorage，
            供"校验要用的解析器和消费方同款"的原则用 —— dsh-mobile-doctor 读的就是它。
       注意：这里**绝不**做任何会抛错的探测（例如无条件访问 ctx.xxx），
             所有取值都先判存在，保证框架自身永不成为故障源。 */
    var RETRY_MS = 1500;
    var RETRY_MAX = 30;
    var health = {};        /* 功能名 -> "ok" | "fail" | "pending" */
    var attempts = {};      /* 功能名 -> 已试次数 */
    var registry = [];      /* [{name, fn}] */

    function feature(name, fn) {
      registry.push({ name: name, fn: fn });
      health[name] = "pending";
      attempts[name] = 0;
    }

    function runFeature(ent) {
      var name = ent.name;
      if (health[name] === "ok" || health[name] === "fail") return;
      attempts[name]++;
      try {
        ent.fn();
        health[name] = "ok";
      } catch (e) {
        /* 记录原因（最多留前 80 字），失败不冒泡、不影响别的功能 */
        try { health[name + ":err"] = String((e && e.message) || e).slice(0, 80); } catch (e2) {}
        if (attempts[name] >= RETRY_MAX) {
          health[name] = "fail";
        } else {
          setTimeout(function () { runFeature(ent); }, RETRY_MS);
        }
      }
      publishHealth();
    }

    function publishHealth() {
      try {
        var bad = 0, pending = 0;
        for (var k in health) {
          if (k.indexOf(":err") >= 0) continue;
          if (health[k] === "fail") bad++;
          else if (health[k] === "pending") pending++;
        }
        var snapshot = {
          plugin: "dsh-mobile-adaption",
          at: Date.now(),
          failed: bad,
          pending: pending,
          detail: health
        };
        window.__dshMobileHealth = snapshot;
        /* 存一份到 localStorage：dsh-mobile-doctor 读它，
           这样"坏没坏"的判据只有一处写入、一处读取，不会两边各写一遍。 */
        try { localStorage.setItem("dsh-mobile-health", JSON.stringify(snapshot)); } catch (e) {}
        /* 有功能真失败时挂一个标记：给人（和你）一个一眼可见的信号，
           但不改界面布局 —— 只加属性，样式由 CSS 决定要不要画指示器。 */
        if (bad > 0) document.documentElement.setAttribute("data-dsh-feature-degraded", "1");
        else document.documentElement.removeAttribute("data-dsh-feature-degraded");
      } catch (e) {}
    }

    /* 把官方面板的"打开"事件也计入健康：面板打不开时能看出是契约失效而非插件崩 */
    function markFeatureFailed(name) {
      try { health[name] = "fail"; publishHealth(); } catch (e) {}
    }

    /* ========== ★ 官方契约清单 + 探测器（2026-09-20） ==========
       目的（用户核心关切）：官方一升级，我们把哪些官方内部实现当成了依赖？
       答案集中在这一处，**不再散落在 1600 行里**。升级后跑一次探测就知道坏了什么。

       三类依赖的稳定性天差地别（这是整个改造的理论基础）：
         · OFFICIAL_DATA  官方 data-* 属性 —— 官方有意暴露的行为标记，最稳
         · CLASS_HASH     官方 CSS Modules 类名（带随机后缀）—— 私有实现，无保证
         · DOM_SHAPE      官方内部 DOM 结构/层级 —— 最脆，官方改版必受影响

       ★ 规矩：本节只做**登记与探测**，不实现功能。
         新增对官方的依赖时，必须同步登记到这里 —— 否则下次升级就没有检查项。
         探测失败**绝不抛错**（探针本身不能成为故障源）。 */
    var CONTRACT = {
      /* ★ 20261008.2：座位收纳补「追溯扫描」（seatSweep / seatBump）——
         官方 `immediately` 是死字段，装载顺序是竞态，包装钩子拦不到先注册的座位。
         版本号跳一位，好让上游报告里一眼分出浏览器跑的是哪一版。
         ★ 20261008.3：补 seatTrayDiag() 取证段（写进报告 rep.seatTray），
         让「workbuddy 的座位到底有没有自动被收进门」在手机上也能核实。
         ★ 20261010.1：修「滑后台回来要重连好久」。connectionResume 改成
         **回前台后递增重试序列 + 前台心跳**（原来只补一次 2 秒后的重试，
         经常正好错过「流稍后才报错」的窗口），并新增 resume 取证段。 */
      version: "20261018.1",
      officialData: [
        "data-sidebar-collapsed",        /* 侧栏开合（ui-layout 维护） */
        "data-sidebar-right-open",       /* 右栏是否打开 */
        "data-sidebar-right-panel",      /* 右栏面板标识 */
        "data-rightbar-collapsed",       /* 右栏收起 */
        "data-rightbar-fullscreen",      /* 右栏全屏 */
        "data-lexical-editor"            /* 输入框（判定是否在编辑器内） */
      ],
      classHash: [
        "frame", "sidebarCol", "centerCol", "rightbarCol",
        "content", "options", "navCell", "navTitle", "sessionRow",
        "mask", "itemIcon", "header", "close", "item", "sidebar",
        "stepper", "Item", "_toggle", "_header", "_brand",
        "QsffPG_root", "QsffPG_trigger", "QsffPG_count", "SVAs4q_label", "moreButton",
        /* ★ 2026-10-05 新增：官方 0.2.0 的"主区面板页"（插件面板 / 自动化任务）。
           panelRow 是侧栏里的入口座位，pageHead 是面板页标题行。
           ★ 这两个座位实测**没有任何 data- 属性、也没有 aria-current**，只有 class 与文字，
             所以这里只能登记 class —— 它是本插件里最脆的一类依赖，官方改版即失效。
             功能侧已有兜底：panelRow 认不出 = 点座位后侧栏不收（还能手动收），
             pageHead 认不出 = 面板页标题行的测量失真（功能本身照常工作）。 */
        "panelRow", "panelList", "pageHead",
        /* ★ 2026-10-06 依赖变更（用户 m07110）：开侧栏不再注入自己的按钮、也不再放开
           sidebarCol 的裁剪，改为**程序化点击官方按钮**（位置：sidebarCol 内
           button[class*="_toggle"]）。所以这里登记项仍是上面已有的 frame / sidebarCol /
           _toggle 三条，依赖关系变了必须留名 —— 官方若把收起态按钮移出 sidebarCol，
           findSidebarToggle() 返回 null，health.railButton 转 fail，届时来查这里。
           ★ 判据已从"elementFromPoint 够不够得着"改为"在不在 DOM 里"：
             收起态 sidebarCol 宽 1px + overflow:hidden，官方按钮**本来就被裁**，
             命中测试必然落空 —— 那是官方布局的正常结果，不是故障。详见 apply() ⑤。 */
      ],
      ariaLabels: [
        /* ★ 2026-10-07 清理：原表里的「添加附件」全代码无消费者（报告长期
           aria.添加附件=0，属"登记了但没人用"），已摘除。
           同批报告里「收起侧边栏」也为 0，但那条**有**真实消费者
           （下面 @media (pointer: coarse) 的放大规则），只是当次没开侧栏 ⇒ 保留。
           教训：报告里的 0 要先去代码里找消费者再决定删不删。 */
        "收起侧边栏", "打开右侧边栏", "更多操作", "发送消息",
        /* ★ 2026-10-07 补登记：输入框左侧的「指令」按钮。它在键盘隔离逻辑里
           被 closest('button[aria-label="指令"]') 使用（点它时不弹软键盘），
           但一直没进契约表 ⇒ 官方若改掉这个标签，功能会静默失效而无人报。
           选 aria-label 而非 CSS 哈希，理由同「新建会话」条。 */
        "指令",
        /* ★ 2026-10-06：「新建会话」——⋮ 菜单的「新建会话」项靠它找到官方按钮。
           选 aria-label 而不是 CSS 哈希，是因为无障碍标签属于官方对外契约，
           改版时比 class 后缀稳得多。 */
        "新建会话",
        /* ★ 2026-10-06 新增（用户 m07110）：⋮ 菜单镜像官方侧栏的另外三键，
           同样是"按 aria-label 找官方按钮再代点"。这四条一起构成菜单里
           （新建会话 / 搜索会话 / 添加工作区 / 设置）的全部 DOM 依赖。
           ★ 2026-10-18：官方 0.2.1-rc.2 起**「设置」不再是按钮**（侧栏底部换成账号菜单，
             设置变成菜单里的一项）⇒ 它已从本表摘除，改登记「账号菜单」。
             判据：同一份报告里 aria.设置 由 1→0，而 aria.账号菜单 出现。
             openSettings() 现在走候选链：旧「设置」按钮 → 账号菜单里那一项，
             所以两个版本都能点开；这里只登记"新形态下真实存在的那个按钮"。 */
        "搜索会话", "添加工作区", "账号菜单"
      ],
      /* ★ 只在「模型选择弹层打开」时才存在的官方锚点（原 modelSearch 功能用）。
         不参与上面的定时探测 —— 弹层没开时它们本来就查不到，放进去只会天天误报"契约失效"。
         ★ 2026-10-06 起由**独立插件** `dsh-mobile-model-search` 自证（本文件的
         modelSearch 功能已摘除注册）：它的工具条能挂上、标签能取到提供方名，
         就说明这几个锚点仍然成立。选它们而不是 CSS 哈希，是因为这些是
         **语义/结构属性**，官方改版不易变动：
           section[role=group]        平台分组
           [role=menuitemradio]       模型选项（点击即选中）
           div.scrollable             列表滚动容器（也是工具条的插入锚点）
           groupTitle / modelName     真名在 aria-labelledby 指向的元素上 */
      pickerOpenOnly: [
        'section[role="group"]',
        '[role="menuitemradio"]',
        "div.scrollable",
        "groupTitle",
        "modelName"
      ],
      /* ★ 2026-10-07 新增依赖类别：**官方服务**（不是 DOM，所以单独一类）。
         connectionResume 功能靠 `ctx.get("connection")` 拿官方连接层句柄，
         再调 handle.reconnect() 把重试退避清零。
         探测的是**能力形状**而不是"对象存在"：官方只要改掉 reconnect 的名字
         或把 state 快照换成别的形式，这里就会报失效 —— 那正是需要人工来看的信号。
         这一条依赖比 DOM 那两类都稳（官方在 dsh-client-connection 里明确
         `ctx.provide("connection", handle)`，属于服务契约），但仍登记在册。 */
      services: [
        "connection:reconnect",
        "connection:state",
        /* ★ 2026-10-08（任务 m06007，座位收纳）：官方 slots 服务的两个能力。
           座位收纳靠 `ctx.get("slots")`，包装它的 register() 把工具行的座位换成
           portal 门；触发按钮靠 inject() 等官方把槽声明出来。
           探测的仍是能力形状：register / inject 可调用。 */
        "slots:register",
        "slots:inject"
      ],
      /* ★ 2026-10-08：座位收纳依赖的**槽名**（既不是 DOM 也不是服务）。
         前两条 = 收纳目标（工具行）；第三条 = 我们触发按钮的座位。
         官方若改掉或移除这三个槽名，座位收纳会静默失效（register 抛
         「槽未声明」，只记进 health），所以登记在此，升级后一眼看出。
         探测方式：`ctx.get("slots").spec(名字)` 有返回即算存在（永不抛错）。 */
      slotNames: [
        "conversation.input.left",
        "conversation.input.right",
        "conversation.composer.dock"
      ]
    };

    /* scanContract()：在真实 DOM 上逐条探测契约是否还成立。
       返回 {at, version, data:{}, hash:{}, aria:{}, missData:[], missHash:[], missAria:[],
             nowData/nowHash/nowAria:{}, scans, uiContext}
       ★ 只读、无副作用、永不抛错。

       ★ 2026-10-06 语义修正：单次快照 → **整页生命周期取并集**。
         为什么必须改：官方大量内部节点是按界面状态挂载的 ——
           没打开会话就没有输入框([data-lexical-editor])、没有发送键；
           侧栏收起/会话列表没数据就没有 sessionRow/navCell/navTitle；
           没有后台任务就没有 QsffPG_* ；没挂载预设就没有 SVAs4q_label。
         单次快照会把"这一瞬没走到那个界面"误判成"官方把这个实现删了" ——
         实测一次加载后就报了 25 个假失效（同一页面几分钟前的另一份记录里，
         那些选择器明明命中过）。
         现在的判据：**页面存活期内命中过一次 = 该契约点仍然成立**；
         从未命中 = 未证实（可能只是界面没走到，也可能官方真改了），单独列出，
         并附 uiContext 说明当时界面走到哪一步，交给人/doctor 判断。
         并集只在内存里，刷新页面即重来。 */
    var everSeen = { data: {}, hash: {}, aria: {} };
    var scanCount = 0;

    function scanContract() {
      var rep = {
        at: Date.now(), version: CONTRACT.version,
        data: {}, hash: {}, aria: {},
        nowData: {}, nowHash: {}, nowAria: {},
        missData: [], missHash: [], missAria: [],
        services: {}, missServices: [],
        slots: {}, missSlots: [],
        scans: 0
      };
      scanCount++;
      rep.scans = scanCount;
      var i, sel, hit;
      for (i = 0; i < CONTRACT.officialData.length; i++) {
        sel = CONTRACT.officialData[i];
        try { hit = document.querySelector("[" + sel + "]") ? 1 : 0; } catch (e) { hit = -1; }
        if (hit > 0) everSeen.data[sel] = 1;
        rep.nowData[sel] = hit;
        rep.data[sel] = everSeen.data[sel] ? 1 : (hit === -1 ? -1 : 0);
        if (!rep.data[sel]) rep.missData.push(sel);
      }
      for (i = 0; i < CONTRACT.classHash.length; i++) {
        sel = CONTRACT.classHash[i];
        try { hit = document.querySelector('[class*="' + sel + '"]') ? 1 : 0; } catch (e) { hit = -1; }
        if (hit > 0) everSeen.hash[sel] = 1;
        rep.nowHash[sel] = hit;
        rep.hash[sel] = everSeen.hash[sel] ? 1 : (hit === -1 ? -1 : 0);
        if (!rep.hash[sel]) rep.missHash.push(sel);
      }
      for (i = 0; i < CONTRACT.ariaLabels.length; i++) {
        sel = CONTRACT.ariaLabels[i];
        try {
          hit = document.querySelector('button[aria-label="' + sel + '"]') ? 1 : 0;
        } catch (e) { hit = -1; }
        if (hit > 0) everSeen.aria[sel] = 1;
        rep.nowAria[sel] = hit;
        rep.aria[sel] = everSeen.aria[sel] ? 1 : (hit === -1 ? -1 : 0);
        if (!rep.aria[sel]) rep.missAria.push(sel);
      }
      /* ★ 2026-10-07：官方**服务**契约探测（不是 DOM 依赖，单独一类）。
         判据是能力形状：reconnect 可调用、state.getSnapshot 可读。
         ★ 与 DOM 探测一样永不抛错；未提供时不标 -1（那不是"失效"，是"未安装"）。 */
      rep.services = {};
      for (i = 0; i < CONTRACT.services.length; i++) {
        sel = CONTRACT.services[i];
        hit = 0;
        try {
          var svcName = sel.split(":")[0];
          var capName = sel.split(":")[1];
          var svc = ctxRef ? ctxRef.get(svcName) : null;
          if (svc) {
            if (capName === "reconnect") hit = (typeof svc.reconnect === "function") ? 1 : 0;
            else if (capName === "state") {
              hit = (svc.state && typeof svc.state.getSnapshot === "function") ? 1 : 0;
            }
            else if (capName === "register") hit = (typeof svc.register === "function") ? 1 : 0;
            else if (capName === "inject") hit = (typeof svc.inject === "function") ? 1 : 0;
          }
        } catch (e) { hit = -1; }
        if (hit > 0) {
          if (!everSeen.services) everSeen.services = {};
          everSeen.services[sel] = 1;
        }
        rep.services[sel] = (everSeen.services && everSeen.services[sel]) ? 1 : (hit === -1 ? -1 : 0);
        if (!rep.services[sel]) rep.missServices.push(sel);
      }
      /* ★ 2026-10-08：槽名探测（座位收纳的落点）。
         `spec(名字)` 在槽已声明时返回 spec，未声明时返回 undefined —— 用「有没有
         返回」判存在，不去看 spec 的字段（那是官方内部形状，改了不该报我们失效）。
         ★ 与 DOM 探测一样永不抛错；slots 服务缺失时全记 0（不是 -1，那是"未安装"）。 */
      for (i = 0; i < CONTRACT.slotNames.length; i++) {
        sel = CONTRACT.slotNames[i];
        hit = 0;
        try {
          var sl = ctxRef ? ctxRef.get("slots") : null;
          if (sl && typeof sl.spec === "function" && sl.spec(sel) !== undefined) hit = 1;
        } catch (e) { hit = -1; }
        if (hit > 0) {
          if (!everSeen.slots) everSeen.slots = {};
          everSeen.slots[sel] = 1;
        }
        rep.slots[sel] = (everSeen.slots && everSeen.slots[sel]) ? 1 : (hit === -1 ? -1 : 0);
        if (!rep.slots[sel]) rep.missSlots.push(sel);
      }
      /* 界面上下文：没有它，「从未命中」会被读成「官方改了」，
         而实际常常只是"还没走到那个界面"。字段全部容错，取不到就不写。 */
      try {
        var frame = document.querySelector('[class*="frame"]');
        rep.uiContext = {
          conversation: !!document.querySelector("[data-lexical-editor]"),
          sidebarExpanded: frame ? !frame.hasAttribute("data-sidebar-collapsed") : null,
          moreMenu: (function () {
            try { return !!(window.__dshMenuDiag && window.__dshMenuDiag.indexOf("\u22ee:\u2713") >= 0); }
            catch (e) { return null; }
          })()
        };
      } catch (e) {}
      return rep;
    }

    /* ========== ★ 座位收纳：输入框下方的「上拉列表」（2026-10-08，用户 m06007） ==========
       需求（用户原话）：「在输入框下方留一个上拉列表按键，要求任何插件注册座位时，
       注册的东西自动进入列表（重点是自动）」。用户已定三项：
         · 只收**工具行**（conversation.input.left / .right）里第三方插件注册的座位，
           官方自己的座位（模型 / 权限 / 计划 / 统计胶囊）原地不动；
         · 展开形态 = 底部抽屉，盖在聊天区上；
         · 只有手机窄屏（≤820px）启用，宽屏保持现状。

       ★ 为什么是「换组件」而不是「搬 DOM」（这是本功能唯一的关键决定）：
         一开始想做的是：让座位照常渲染，然后把已经渲染出来的 DOM 节点 appendChild 到
         抽屉里。**这条路是死的**，而且理由很硬 —— React 卸载一个宿主节点时，是拿
         「该节点的宿主父 fiber 记录的 stateNode」直接 `parentNode.removeChild(child)`，
         **不检查实际父节点**（生产包里的卸载路径就是
         `nt.removeChild(i.stateNode)`）。节点一旦被我们搬走，React 下次重渲染/卸载
         就会对旧父节点删一个已经不在那儿的子节点 ⇒ 抛
         `NotFoundError: Failed to execute 'removeChild' on 'Node'` ⇒ 整棵组件树崩。
         所以：**不移动任何节点**，改成在注册那一刻把组件本身换成一个小小的「门」组件，
         由这个门用 `ReactDOM.createPortal` 把真正的座位渲染进我们的抽屉容器。
         好处（逐条对应要求）：
           ① React 从头到尾自己管这些节点 ⇒ 卸载永远干净，不会出现上面的崩溃；
           ② portal 只换 DOM 落点、**不换 React 树**⇒ React context（会话作用域、
              官方 standardKit 给的 t / useStore / useProjection）原样可用；
           ③ 我们没改官方任何一个文件（AGENTS.md §3.3 三级落点铁律）。

       ★ 为什么敢「无条件换掉这两个槽里的每一个条目」而不去猜注册者是谁：
         实测 `conversation.input.left` / `.right` 这两个槽里，**官方注册数 = 0**
         （官方那两处只有 renderSlot 调用点与类型声明，没有注册），唯一的第三方是
         dsh-connect-workbuddy。所以「把这两个槽的条目全收进来」恰好等于「只收第三方」，
         不需要去读 `registrant`（那个字段在 entry.options 里根本不存在 —— SlotCore
         只保留 key/id/order/label/priority 五键）。将来官方若真往这两个槽里注册东西，
         本插件自己的注册带了 `dshSeatTray: true` 标记会被跳过，官方条目则会同被收纳，
         届时按注释里的坐标回来改判据即可。

       坐标（2026-10-07 实测）：
         · `SlotRegistry` 实例 = `ctx.get("slots")`，`register` 定义在
           `@deepseek-ai/dsh-client-ui-renderer/lib/client.js`；实例上打补丁经
           cordis traceable 代理后**新 get 仍然看得见**（已在本容器用真 cordis 验证）。
         · `conversation.composer.dock` 由官方 `registerComposerBar()` 声明
           （dsh-client-ui-conversation/lib/client.js），位于输入卡片正下方 ⇒ 我们的
           触发按钮注册在这里（官方留好的座位，不是自己造位置）。
         · 槽声明晚于本插件 apply ⇒ 必须用 `slots.inject(key, cb)` 等声明，不能直接 register。 */
    var SEAT_SLOTS = { "conversation.input.left": 1, "conversation.input.right": 1 };
    var SEAT_NARROW_PX = 820;
    var seatTray = {
      installed: false, ctx: null, slots: null, React: null, ReactDOM: null,
      cells: {}, order: [], open: false, dom: null, subs: [], version: 0
    };

    function seatNarrow() {
      try { return window.innerWidth <= SEAT_NARROW_PX; } catch (e) { return false; }
    }
    function seatNotify() {
      seatTray.version++;
      for (var i = 0; i < seatTray.subs.length; i++) {
        try { seatTray.subs[i](); } catch (e) {}
      }
    }
    /* 订阅抽屉状态：任何一处（新座位注册 / 注销 / 开合 / 旋屏）都走这里 ⇒ 触发按钮
       和抽屉面板总能重渲染。不用 useSyncExternalStore 是为了兼容更老的 React。 */
    function useSeatTray() {
      var React = seatTray.React;
      var bump = React.useState(0)[1];
      var id = seatTray.version;
      React.useEffect(function () {
        var fn = function () { try { bump(seatTray.version); } catch (e) {} };
        seatTray.subs.push(fn);
        return function () {
          var i = seatTray.subs.indexOf(fn);
          if (i >= 0) seatTray.subs.splice(i, 1);
        };
      }, []);
      return id;
    }

    /* 抽屉 DOM：遮罩 + 面板 + 内容区。刻意用命令式创建而不是再造一个 slot ——
       这是我们自己的浮层，不进任何官方座位，也不参与官方布局。 */
    function seatEnsureDom() {
      if (seatTray.dom && document.body.contains(seatTray.dom.panel)) return seatTray.dom;
      var scrim = document.createElement("div");
      scrim.id = "dsh-st-scrim";
      var panel = document.createElement("div");
      panel.id = "dsh-st-panel";
      var grip = document.createElement("div");
      grip.className = "dsh-st-grip";
      var title = document.createElement("div");
      title.className = "dsh-st-title";
      title.textContent = "附加选项";
      var body = document.createElement("div");
      body.className = "dsh-st-body";
      panel.appendChild(grip);
      panel.appendChild(title);
      panel.appendChild(body);
      document.body.appendChild(scrim);
      document.body.appendChild(panel);
      var dom = { scrim: scrim, panel: panel, body: body };
      /* 点遮罩 = 收回；面板上滑下滑 = 收回（用户要的「再点/下滑收回」） */
      scrim.addEventListener("click", function () { seatTraySetOpen(false); });
      var y0 = null;
      panel.addEventListener("touchstart", function (ev) {
        try { y0 = ev.touches && ev.touches[0] ? ev.touches[0].clientY : null; } catch (e) { y0 = null; }
      }, { passive: true });
      panel.addEventListener("touchmove", function (ev) {
        try {
          if (y0 === null) return;
          var y1 = ev.touches && ev.touches[0] ? ev.touches[0].clientY : null;
          if (y1 !== null && y1 - y0 > 48) { y0 = null; seatTraySetOpen(false); }
        } catch (e) {}
      }, { passive: true });
      panel.addEventListener("touchend", function () { y0 = null; }, { passive: true });
      seatTray.dom = dom;
      return dom;
    }

    function seatTraySetOpen(open) {
      seatTray.open = !!open;
      try {
        if (seatTray.open) {
          seatEnsureDom();
          document.documentElement.setAttribute("data-dsh-seat-tray", "open");
        } else {
          document.documentElement.removeAttribute("data-dsh-seat-tray");
        }
      } catch (e) {}
      seatNotify();
    }

    /* 每个被收纳的座位一个格子。格子由「门」组件在 mount 时创建、unmount 时退休；
       退休时先等 React 把 portal 里的孩子摘干净再删格子，避免和 React 抢节点。 */
    function seatEnsureCell(id) {
      if (seatTray.cells[id]) return seatTray.cells[id];
      var dom = seatEnsureDom();
      var cell = document.createElement("div");
      cell.className = "dsh-st-cell";
      cell.setAttribute("data-dsh-seat-cell", id);
      dom.body.appendChild(cell);
      seatTray.cells[id] = cell;
      seatTray.order.push(id);
      return cell;
    }
    function seatRetireCell(id) {
      var cell = seatTray.cells[id];
      if (!cell) return;
      delete seatTray.cells[id];
      var i = seatTray.order.indexOf(id);
      if (i >= 0) seatTray.order.splice(i, 1);
      var tries = 0;
      var kill = function () {
        try {
          if (cell.childElementCount === 0) {
            if (cell.parentNode) cell.parentNode.removeChild(cell);
            return true;
          }
        } catch (e) { return true; }
        return false;
      };
      if (kill()) { seatNotify(); return; }
      var iv = setInterval(function () {
        tries++;
        if (kill() || tries > 20) {
          clearInterval(iv);
          if (tries > 20) { try { if (cell.parentNode) cell.parentNode.removeChild(cell); } catch (e) {} }
          seatNotify();
        }
      }, 100);
    }

    /* 「门」：把真正的座位 portal 进对应格子；宽屏时原样就地渲染（保持现状）。
       ★ props 原样透传 —— portal 不换 React 树，所以官方给座的 t / useStore /
       useProjection / SessionProvider 全都照旧可用。 */
    function seatMakeGate(Comp, id) {
      var React = seatTray.React, ReactDOM = seatTray.ReactDOM;
      var gate = function DshSeatGate(props) {
        /* ★ 三条 hook 必须无条件、定序调用（早退只能发生在 hook 之后）——
           否则旋屏切换宽窄时 hook 数量变化，React 直接抛错。 */
        useSeatTray();
        var narrow = seatNarrow();
        var cellRef = React.useRef(null);
        /* 格子是幂等的（同一 id 只有一个），所以在 render 里建也安全，
           而且能避免「先就地渲染一帧再搬进抽屉」的闪动。 */
        if (narrow && !cellRef.current) cellRef.current = seatEnsureCell(id);
        React.useEffect(function () {
          if (!cellRef.current) return;
          seatNotify();                                   /* 座位数变了 ⇒ 按钮该出现 */
          return function () {                            /* 真卸载：格子一起退休 */
            seatRetireCell(id);
            cellRef.current = null;
          };
        }, [narrow]);
        var el = React.createElement(Comp, props);
        /* 宽屏就地渲染 = 用户要的「宽屏保持现状」；窄屏才进抽屉。 */
        if (!narrow || !cellRef.current) return el;
        return ReactDOM.createPortal(el, cellRef.current);
      };
      /* 记号：追溯扫描靠它认「这个组件已经是门了」，避免重复包一层。 */
      try { gate.__dshSeatGate = true; } catch (e) {}
      return gate;
    }

    /* 追溯扫描：把**已经注册进来**的座位就地换成门。
       ★ 为什么必须有这一步：官方 `immediately` 字段是死的（宿主写进 manifest、
       客户端 `parseBootManifest` 读出来，但 `start()` 只解构 `{ id }` 就把它丢了），
       72 个插件是 `Promise.all` 并发 create ⇒ 本插件**不保证**早于
       dsh-connect-workbuddy 执行 apply。若它在我们的包装装好之前就注册了，
       那次注册走的是原 register，包装拦不到 —— 只能事后来扫。
       ★ 能这么干是因为：渲染组件在 render 时现读 `entry.component`
       （renderer @32096 / @32571 / @34979 三处都是 `const Comp = entry.component`），
       而 `slots.entries(key)` 返回的就是这些 entry 对象本身（SlotCore.entries 返回
       缓存数组引用），就地改写立刻对渲染可见。 */
    function seatSweep(key) {
      var slots = seatTray.slots;
      if (!slots || typeof slots.entries !== "function") return 0;
      var list = null;
      try { list = slots.entries(key); } catch (e) { return 0; }
      if (!list || !list.length) return 0;
      var n = 0;
      for (var i = 0; i < list.length; i++) {
        var en = list[i];
        if (!en || !en.options) continue;
        if (en.options.dshSeatTray) continue;                 /* 我们自己注册的（含下面那个 bump）不碰 */
        var comp = en.component;
        if (typeof comp !== "function") continue;
        if (comp.__dshSeatGate) continue;                     /* 已经是门了 */
        en.component = seatMakeGate(comp, key + "#" + String(en.options.id || en.options.key || "seat"));
        n++;
      }
      /* ★ 换了组件但没动 SlotCore 的 rec.version ⇒ 官方 outlet 的
         useSyncExternalStore 快照没变，不会重渲染。而且 uSES 的 getSnapshot 是
         `() => host.getVersion(key)`，只有 version 变才重渲染。所以借一次
         「注册一个立即注销的空条目」把 version 顶一下 —— 全程只用公开 API，
         且注册与注销同步完成，flush 的微任务跑到时它已经不在表里了。 */
      if (n > 0) seatBump(key);
      return n;
    }

    /* 顶版本用的一次性空条目（渲染 null）。带 dshSeatTray 标记，绝不被自己收进抽屉。 */
    function seatBump(key) {
      try {
        var slots = seatTray.slots;
        if (!slots || typeof slots.register !== "function") return;
        var d = slots.register({ name: key, id: "__dsh_seat_bump__", order: 2147483000, dshSeatTray: true }, function () { return null; });
        if (typeof d === "function") d();
      } catch (e) {}
    }

    /* 诊断快照：让「自动收录到底有没有收到 workbuddy 的座位」能在报告里被看见，
       而不必让用户在手机上开 devtools（APK 的 WebView 根本没开 devtools socket）。
       ★ 只读，永不抛错。 */
    function seatTrayDiag() {
      try {
        var d = {
          installed: !!seatTray.installed,
          narrow: seatNarrow(),
          swept: seatTray.swept || 0,   /* 追溯扫描换到门的条数（>0 = 确实收到了先注册的座位） */
          open: !!seatTray.open,
          seats: []
        };
        var slots = seatTray.slots;
        if (slots && typeof slots.entries === "function") {
          for (var key in SEAT_SLOTS) {
            if (!Object.prototype.hasOwnProperty.call(SEAT_SLOTS, key)) continue;
            var list = null;
            try { list = slots.entries(key) || []; } catch (e) { list = []; }
            for (var i = 0; i < list.length; i++) {
              var en = list[i];
              if (!en || !en.options) continue;
              if (en.options.dshSeatTray) continue;
              d.seats.push({
                slot: key,
                id: String(en.options.id || en.options.key || "seat"),
                order: en.options.order == null ? 0 : en.options.order,
                registrant: en.options.registrant == null ? null : String(en.options.registrant),
                gated: !!(en.component && en.component.__dshSeatGate)
              });
            }
          }
        }
        return d;
      } catch (e) {
        return { error: String((e && e.message) || e).slice(0, 80) };
      }
    }

    /* 触发按钮：注册在官方 conversation.composer.dock（输入卡片正下方）。
       没有收录到任何座位、或宽屏时返回 null —— 「把我们全关掉，主界面看不出少了什么」。 */
    function seatMakeTrigger() {
      var React = seatTray.React;
      return function DshSeatTrigger() {
        useSeatTray();
        if (!seatNarrow()) return null;
        if (seatTray.order.length === 0) return null;
        var open = seatTray.open;
        var label = open ? "收起附加选项" : "展开附加选项";
        return React.createElement("button", {
          type: "button",
          className: "dsh-st-trigger",
          "aria-expanded": open ? "true" : "false",
          "aria-label": label,
          title: label,
          onClick: function (ev) {
            try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
            seatTraySetOpen(!seatTray.open);
          }
        }, React.createElement("span", { className: "dsh-st-chev" }));
      };
    }

    function installSeatTray() {
      if (seatTray.installed) return;
      if (typeof document === "undefined") throw new Error("no document");
      var ctx = ctxRef;
      if (!ctx || typeof ctx.get !== "function") throw new Error("no ctx");
      var slots = ctx.get("slots");
      if (!slots || typeof slots.register !== "function") throw new Error("no slots service");
      var React = require("react");
      var ReactDOM = require("react-dom");
      if (!React || typeof React.createElement !== "function") throw new Error("no react");
      if (!ReactDOM || typeof ReactDOM.createPortal !== "function") throw new Error("no react-dom.createPortal");
      seatTray.React = React;
      seatTray.ReactDOM = ReactDOM;
      seatTray.ctx = ctx;
      seatTray.slots = slots;

      /* ① 装钩子：把这两个槽里的每个座位换成「门」。
         实例级打补丁（已用真 cordis 验证：补丁装到 slots 实例上，之后每次
         ctx.get("slots") 拿到的代理都看得见它）。原样 return 原注册的 disposer，
         绝不吞掉 —— 官方靠它做 effect 清理与真卸载。 */
      var origRegister = slots.register;
      var wrapped = function (options, component) {
        var self = this;
        try {
          var nm = options && options.name;
          if (nm && SEAT_SLOTS[nm] && !options.dshSeatTray && typeof component === "function") {
            var id = nm + "#" + String((options && (options.id || options.key)) || "seat");
            var gate = seatMakeGate(component, id);
            var opts2 = {};
            for (var k in options) {
              if (Object.prototype.hasOwnProperty.call(options, k)) opts2[k] = options[k];
            }
            /* 保留原 options（含 id/order/locale/inject/children/store）已全部拷过，
               只把渲染组件换成门 —— 别的语义一个都不动。 */
            return origRegister.call(self, opts2, gate);
          }
        } catch (e) {}
        return origRegister.apply(self, arguments);
      };
      try { slots.register = wrapped; } catch (e) { throw e; }

      /* ①b ★ 追溯扫描 + 声明期再扫：身份竞态的双保险。
         包装钩子只能拦住「装好之后」的注册；若 workbuddy 的 apply 先跑完，
         它的注册（走它自己的 slots.inject，落点是槽**声明**那一刻）就可能
         早于/晚于我们的回调，两种次序都要兜住：
           · 它的 inject 回调先跑 ⇒ 注册已进表，本次扫描就地换成门；
           · 我们的回调先跑 ⇒ 扫描落空，但它的注册随后走的是已打补丁的
             register，包装钩子直接拦住。
         两个槽各挂一次 inject（只做通知、不注册任何东西）。 */
      var seatKeys = [];
      for (var sk in SEAT_SLOTS) {
        if (Object.prototype.hasOwnProperty.call(SEAT_SLOTS, sk)) seatKeys.push(sk);
      }
      var sweepAll = function () {
        for (var i = 0; i < seatKeys.length; i++) {
          try { seatTray.swept = (seatTray.swept || 0) + seatSweep(seatKeys[i]); } catch (e) {}
        }
      };
      try { sweepAll(); } catch (e) {}
      for (var si = 0; si < seatKeys.length; si++) {
        (function (key) {
          try {
            slots.inject(key, function () {
              try { seatTray.swept = (seatTray.swept || 0) + seatSweep(key); } catch (e) {}
            });
          } catch (e) {}
        })(seatKeys[si]);
      }

      /* ② 触发按钮：必须用 inject 等官方把 conversation.composer.dock 声明出来
          （本插件 apply 早于会话界面注册，直接 register 会抛「槽未声明」）。 */
      try {
        slots.inject("conversation.composer.dock", function () {
          return slots.register({
            name: "conversation.composer.dock",
            id: "dsh-seat-tray",
            order: 30,
            dshSeatTray: true
          }, seatMakeTrigger());
        });
      } catch (e) {
        /* 触发按钮挂不上不算致命：座位仍会被收纳，只是少一个入口。
           但这种情况必须留痕，所以记进 health（见下方 catch 分支）。 */
        health.seatTrayTrigger = String((e && e.message) || e).slice(0, 80);
      }

      seatTray.installed = true;
      try { window.__dshSeatTray = seatTray; } catch (e) {}
      /* 取证入口：手机上随时可以在报告里看到「收到几个座位、是不是都换成了门」。
         不改界面、不注册任何东西，纯读。 */
      try { window.__dshSeatTrayDiag = seatTrayDiag; } catch (e) {}
    }

    /* ========== 启动 ========== */
    function apply(ctx) {
      if (typeof document === "undefined") return;

      /* ⓪ 官方 layout 服务（面板页支持用）。
         ★ 唯一一处"官方一等公民"依赖，靠文件末尾的 inject:["layout"] 声明拿到。
           用 ctx.get() 而不是 ctx.layout：**取不到时返回 undefined 而不是抛错**，
           这样万一哪天官方不提供 layout 了，也只是面板页少几个便利功能，界面照常。 */
      try { layoutApi = ctx.get("layout") || null; } catch (e) { layoutApi = null; }

      /* ⓪b ★ 2026-10-07：记下 ctx，供 installConnectionResume 取官方 connection 服务。
         用 try 包住：取不到也不影响任何既有功能。 */
      try { ctxRef = ctx; } catch (e) { ctxRef = null; }

      /* ① 样式与 viewport：这两件是最基础的，单独兜底但不阻断后续 */
      try {
        var tag = document.createElement("style");
        tag.id = "dsh-mobile-adaption";
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (e) { markFeatureFailed("style"); }
      try {
        var m = document.querySelector('meta[name="viewport"]');
        if (m) m.setAttribute("content", "width=device-width, initial-scale=1, interactive-widget=resizes-content");
      } catch (e) { markFeatureFailed("viewport"); }

      /* ② 登记各功能（顺序即执行顺序，保持与原实现一致） */
      feature("keyboardIsolation", installKeyboardIsolation);
      feature("settingsNav", installSettingsNav);
      feature("panelWatcher", installPanelWatcher);   /* ★ 2026-10-05：面板页显隐标记（必须在 edgeSwipe/backHandler 之前，它们依赖这个标记） */
      feature("autoCollapse", installAutoCollapse);
      feature("edgeSwipe", installEdgeSwipe);
      feature("backHandler", installBackHandler);
      feature("updateChecker", installUpdateChecker);
      /* ★ 2026-10-05：原 "usageBadge"（余额胶囊）已按用户要求删除。
         但那段代码兼着右栏状态同步 + 设置面板退场兜底 + 菜单 rAF 补跑，
         所以换成本项 —— 只做状态同步，不再创建任何 UI。 */
      feature("rightbarState", installRightbarState);
      /* ★★★ 2026-10-19（用户第 4 条要求）：⋮ 菜单**清空所有非官方注入项**，
         直接用官方原生菜单。以后要加功能再单独说。
         
         为什么是"摘注册"而不是删代码：
           ① 回退最省事 —— 把下面这一行加回来就恢复；
           ② 那段代码里 syncMovedChips() / findJobsChip() 等还被别处引用，
              连同 CSS（把「Agent 预设」「后台任务」从标题行隐藏的规则）一起删
              容易出暗坑。
         
         ★ 注意：**menuInjector 停用后，CSS 里那两条"隐藏原始 chip"的规则也必须停**，
           否则官方的「Agent 预设」「后台任务」会被藏掉却没人搬进菜单 ⇒ **两处都看不见**。
           已用 html[data-dsh-menu-inject="1"] 作为开关前缀（见 CSS 段）。
           下面 ④ 里会显式移除该属性。 */
      /* feature("menuInjector", installMenuInjector); */
      /* ★ 2026-10-07（任务 m02710）：回前台秒回 —— 页面重新可见时把官方连接层的
         重试退避清零。纯监听 + 调官方 reconnect()，不碰界面、不改 DOM。
         放在这一批里有讲究：它不依赖 layout，取不到 connection 服务时也只是静默待命。 */
      feature("connectionResume", installConnectionResume);
      /* ★ 2026-10-08（任务 m06007）：座位收纳 —— 输入框下方的「上拉列表」。
         只在手机窄屏启用；把工具行里第三方插件注册的座位自动收进底部抽屉。
         放在 connectionResume 之后：它不依赖 layout，靠 ctx.get("slots") 探测，
         取不到时由 feature() 框架按 RETRY_MS 重试（官方服务比插件晚就绪是常态）。 */
      feature("seatTray", installSeatTray);
      /* ★ 2026-10-19（用户第 7 条补充）：官方的模型弹层**已经有搜索框**，
         所以那套"我们自己再造一个搜索框"的代码（`MS_CSS` + `installModelSearch`）
         **已整段删除**，不是摘注册 —— 用户明确要求「以后彻底去掉，
         保留这个代码也没用，还有可能发生一点冲突，比如渲染上的一点小麻烦」。
         标签筛选 + 收藏由独立插件 `dsh-mobile-model-search` 提供，与本插件无关。 */

      /* ③ 依次执行；每个都是独立 try/catch，互不影响 */
      for (var i = 0; i < registry.length; i++) runFeature(registry[i]);

      /* ④ 侧栏状态同步（官方属性驱动；观察器失败也不影响其余功能） */
      try {
        new MutationObserver(syncStateNow).observe(document.documentElement, {
          attributes: true, attributeFilter: ["data-sidebar-collapsed"], subtree: true
        });
      } catch (e) {}
      try { syncStateNow(); } catch (e) { markFeatureFailed("syncState"); }

      /* ⑤ ★ 2026-10-06 由「替身按钮自愈」简化为**一次性存在性探测**。
             原实现每 500ms 用 elementFromPoint 问"官方按钮够不够得着"，够不着就注入替身按钮。
             两件事现在都错了：
               a) 用户 m07110 明确不要那个注入按钮（"颜色和位置都奇怪"），替身机制已删；
               b) "够不着"其实是**官方布局的正常结果** —— 收起态 sidebarCol 宽 1px、overflow:hidden，
                  官方按钮本来就被裁，elementFromPoint 必然落空。把它当故障是把正常当异常。
             现在只回答一个对升级有意义的问题：**官方按钮还在不在 DOM 里**（我们靠它开侧栏）。
             在 ⇒ ok；不在 ⇒ fail（此时「唤出侧边栏」菜单项会变成空操作，
             但左缘右划手势仍可用，用户不会被困住）。只探一次，不轮询、不注入、不改界面。 */
      try {
        var togOnce = findSidebarToggle();
        if (togOnce) {
          health.railButton = "ok";
        } else {
          /* 官方 DOM 比插件晚，给 3 秒宽限再定论；仍没有才记 fail。 */
          setTimeout(function () {
            try {
              if (findSidebarToggle()) health.railButton = "ok";
              else { health.railButton = "fail"; health["railButton:note"] = "\u5b98\u65b9\u4fa7\u680f\u6309\u94ae\u672a\u627e\u5230\uff08findSidebarToggle \u8fd4\u56de null\uff09"; }
              publishHealth();
            } catch (e) {}
          }, 3000);
        }
      } catch (e) { markFeatureFailed("railButton"); }

      /* ⑥ 捕获未处理的异常也计入健康（只记录，不阻止）——便于线上定位 */
      try {
        window.addEventListener("error", function (ev) {
          try { health["uncaught"] = String((ev && ev.message) || "?").slice(0, 80); publishHealth(); } catch (e) {}
        });
        window.addEventListener("unhandledrejection", function (ev) {
          try {
            var r = ev && ev.reason;
            health["unhandledRejection"] = String((r && r.message) || r || "?").slice(0, 80);
            publishHealth();
          } catch (e) {}
        });
      } catch (e) {}

      /* ⑦ 契约探测：官方 DOM 往往晚于插件就绪，所以在几个时间点各扫一次，
            取最后一次结果（后面的越过前面的）。★ 探测本身永不抛错。 */

      /* ★ 2026-10-06 修复「假绿灯」：上报只留一个写入口，且永远以完整扫描为底。
         病灶：⋮ 观察者（⑧）原先自己拼一份**精简报文**直接 POST，与这里的完整报文
         抢同一个文件、后写者赢 —— 只要用户点开过一次 ⋮，契约段（data/hash/aria）
         就被抹掉，dsh-mobile-doctor 读到空段反而报「0/0 全部契约有效」。
         现在：完整扫描存进 lastReport，任何一次上报都从它复制、只覆盖本次更新的字段。 */
      var lastReport = null;   /* 契约段的唯一来源；null = 还没扫过 */
      var postReport = function (extra) {
        try {
          var payload = {}, k;
          if (lastReport) {
            for (k in lastReport) {
              if (Object.prototype.hasOwnProperty.call(lastReport, k)) payload[k] = lastReport[k];
            }
          }
          if (extra) {
            for (k in extra) {
              if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
            }
          }
          if (!payload.version) payload.version = CONTRACT.version;
          payload.at = Date.now();
          /* 可选加分项：服务端半要重启 DSH 才注册路由，在那之前 404 属预期，绝不当失败。 */
          fetch("/dsh-mobile/report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          }).catch(function () {});
        } catch (e) {}
      };

      try {
        var doScan = function () {
          try {
            var rep = scanContract();
            window.__dshMobileContract = rep;
            try { localStorage.setItem("dsh-mobile-contract", JSON.stringify(rep)); } catch (e) {}
            /* ★ 上报：localStorage 是**主通道**（不依赖任何服务端改动，刷新即生效）；
               POST 到 /dsh-mobile/report 是**可选加分项** —— 服务端半要重启 DSH 才注册，
               在那之前这个 POST 会 404，属于预期，**绝不当失败处理**。 */
            try {
              rep.health = health;
              /* ★ 2026-10-05：把"原生壳桥在不在 + 壳菜单项会不会注入"一并上报。
                 这是 APK 侧唯一可用的取证通道（APK 的 WebView 不开 devtools socket）。 */
              try { rep.shell = shellProbe(); } catch (e3) {}
              try { rep.menuDiag = window.__dshMenuDiag || null; } catch (e4) {}
              try { rep.menuReport = window.__dshMenuReport || null; } catch (e5) {}
              /* ★ 2026-10-08：座位收纳的取证。用户要的是「任何插件注册座位都**自动**
                 进列表」，判据就是：workbuddy（先于我们 apply 的第三方）的座位
                 有没有被换成门（gated=true）。手机上开不了 devtools，所以把它写进报告。 */
              try { rep.seatTray = seatTrayDiag(); } catch (e7) {}
              /* ★ 2026-10-10：「回前台要重连好久」的取证。
                 没有它只能靠猜 —— 有了它，下次一看报告就知道：
                 页面到底有没有收到 visibilitychange/pageshow（vis/page/onl）、
                 App 壳有没有来敲门（shell）、我们实际踢了几次重连（kicks）、
                 以及被「还连着，别打扰」挡掉几次（skipConn）和当时的状态（last）。 */
              try { rep.resume = (typeof window.__dshResumeStats === "function") ? window.__dshResumeStats() : null; } catch (e8) {}
              try { rep.resumeLast = window.__dshResumeDiag || null; } catch (e9) {}
              /* 长期诊断：本次打算注入的菜单项清单（只读变量，零副作用）。
                 意义：不点开 ⋮ 也能在报告里证明"哪些项被构造出来了"，
                 因为 ⋮ 没被点开时 menuReport 永远是 null，无法区分
                 "没观测" 与 "没构造"。 */
              try {
                var ww = window.__dshMenuWant;
                rep.menuWant = ww ? ww.map(function (s) { return String(s).split("\u0000")[1]; }) : null;
              } catch (e6) {}
              localStorage.setItem("dsh-mobile-report-full", JSON.stringify(rep));
              lastReport = rep;   /* ★ 存底：此后所有上报（含 ⋮ 观察者）都以它为基础 */
              /* 每次都发：报告要能反映"扫了几次、当时界面走到哪一步"，
                 省这点本地往返反而让医生读到一份偏旧的快照。POST 体积很小，不值当。 */
              postReport(null);
            } catch (e) {}
            publishHealth();
          } catch (e) {}
        };
        doScan();
        setTimeout(doScan, 3000);
        setTimeout(doScan, 10000);
        /* ★ 2026-10-06：官方大量节点是按界面状态、且往往晚于 10 秒才挂载的。
           并集语义下多扫不亏（只增不减），补扫到 60 秒，把"慢慢长出来"的界面收进来。
           ★ 想彻底确证某个依赖：把对应界面打开（进会话 / 开右栏 / 点开 ⋮）再刷新页面，
             这样并集里就会带上那一刻的命中记录。 */
        var extraN = 0;
        var extraTimer = setInterval(function () {
          extraN++;
          if (extraN > 10) { clearInterval(extraTimer); return; }
          doScan();
        }, 5000);
      } catch (e) {}

      /* ⑧ ★ 2026-10-05：菜单注入结果自检（只为取证，不改界面）。
         目的：APK 的 WebView 不开 devtools socket，CDP 进不去，
         "依赖 window.DshShell 的那批菜单项到底注入了没有"只能靠页面自己说。
         做法：装一个**被动观察者** —— 不主动点开菜单（那会改界面状态），
         而是等用户自己点开 ⋮ 时，injectMenuItems() 跑完会把结论写进
         window.__dshMenuDiag；这里只把那一刻的"实际注入条目"抄一份到
         __dshMenuReport，由 doScan 一并上报。
         ★ 若用户从不点开 ⋮，这份报告就是 null —— 那不算失败，是"未观测"。 */
      try {
        window.__dshMenuReport = null;
        var lastDiag = null;
        setInterval(function () {
          try {
            var d = window.__dshMenuDiag;
            if (!d || d === lastDiag) return;
            lastDiag = d;
            /* 菜单已展开时，把注入项的文本与 key 抄下来。
               ★ 不猜容器：注入项都带 data-dsh-menu-item="1"，全文档查最稳
                 （之前按 [class*="viewport"] 找是猜的，官方改类名就会漏）。 */
            var items = [];
            var nodes = document.querySelectorAll('[data-dsh-menu-item="1"]');
            for (var i = 0; i < nodes.length; i++) {
              items.push((nodes[i].textContent || "").trim().slice(0, 40));
            }
            /* ★★ 2026-10-05 只在"菜单确实开着"时写报告。
               原因：菜单**关闭**时 __dshMenuDiag 也会变（菜单:✓ → 菜单:✗），
               那一刻 DOM 里的注入项已经没了，nodes.length = 0。
               旧代码照样写一份 injectedCount:0 / injected:[] 并 POST，
               把上一次"菜单真开着、确实看到 10 项"的好证据**覆盖掉**了 ——
               结果就是报告里永远只看到 0，看起来像"注入失效"的假红灯。
               ★ 判据用 diag 里的菜单开合标记，而不是 nodes.length：
                 这样"菜单开着却只有 0 项"仍会被如实记下（那才是真出问题）。 */
            if (d.indexOf("\u83dc\u5355:\u2713") < 0) return;
            window.__dshMenuReport = {
              at: Date.now(),
              diag: d,
              injectedCount: nodes.length,
              injected: items,
              shellWillInject: !!dshShellState()
            };
            /* ★ 观测到就立刻上报一次：doScan 跑在 0/3s/10s，此后每 5 秒补扫
               一次、最多再补 10 次（补到 60 秒，见下面 extraTimer）—— 而用户点开 ⋮
               往往在那之后 —— 不补这一次，报告就永远停在 null。
               ★ 2026-10-06：⋮ 打开是界面最全的时刻之一，先补一次契约扫描
                 （并集可能因此新增命中），再走 postReport() 覆盖本次字段 ——
                 完整扫描的契约段（data/hash/aria）原样带过去，不再被抹掉。 */
            try { if (typeof doScan === "function") doScan(); } catch (e7) {}
            postReport({
              menuReport: window.__dshMenuReport,
              shell: shellProbe(),
              health: health
            });
          } catch (e) {}
        }, 500);
      } catch (e) {}

      publishHealth();
    }

    exports.name = "dsh-mobile-adaption";
    exports.apply = apply;
    exports.inject = ["layout"];
    return module.exports;
  }
});
