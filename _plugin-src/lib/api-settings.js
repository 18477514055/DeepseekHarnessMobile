/* ==========================================================================
 * ★★★ 2026-10-20：API 设置页（用户要求）
 *
 * 用户原话：
 *   「可以把我们的这些增加的设置全部作为一个单独的出现在 Dsh 客户端内部的
 *     权限页面，可以放在那个设置面板里，作为一项可以名叫 API 设置，
 *     然后在里面调整设置的时候，自动引导用户跳转相关页面进行权限开启，
 *     如果检测到用户已经自行开启的，则 API 设置页面也自行同步。
 *     包括 adb 设置也可以放在这里。」
 *
 * ══════════════════════════════════════════════════════════════════
 * 设计要点
 * ══════════════════════════════════════════════════════════════════
 * ① **不改官方 DOM 结构**：只在官方设置面板的 nav 列表末尾**追加一项**
 *    「API 设置」，点它时把 content 区替换成我们自己的内容。
 *    ★ 官方一改版、我们最多是"没这个入口"，绝不会把设置面板弄坏。
 *
 * ② **状态自动同步**：页面里每 1.5 秒（仅当页面可见时）向 APK 拉一次
 *    `dsh-android perms`，用户在系统设置里开了权限、切回来立刻就能看到勾。
 *    ★ 用户明确要求「检测到用户已经自行开启的，则 API 设置页面也自行同步」。
 *
 * ③ **每项都能一键跳转**：点「去开启」→ 调 `openperms <name>`，
 *    由 APK 侧直接跳到**对应那一页**（不是笼统的设置首页）。
 *
 * ④ **ADB 三档开关**放在同一页，切到 full 需要二次确认（与 AdbBridge 一致）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 数据来源
 * ══════════════════════════════════════════════════════════════════
 * 全部经由 `dsh-android` CLI（容器内的 Node 客户端）→ 抽象 socket → APK。
 * 但**浏览器端不能直接跑 shell**，所以要经过服务端半（lib/index.js）
 * 暴露的 HTTP 路由转发。路由名：`/dsh-mobile/api/<cmd>`。
 *
 * ★ 若服务端路由不可用（老内核 / 插件没重启），页面会显示"桥不可用"，
 *   并给出手动命令，而不是假装能用。
 * ========================================================================== */
(function () {
  'use strict';

  var FLAG = '__dshMobileApiSettings';
  if (window[FLAG]) return;
  window[FLAG] = true;

  var POLL_MS = 1500;
  var pollTimer = null;
  var panelEl = null;       // 我们自己渲染的内容根
  var lastPerms = null;
  var lastAdb = null;

  /* ---------------- 与容器通信 ---------------- */

  /** 调服务端半的路由（服务端会用 dsh-android 转发给 APK）。 */
  function call(cmd, args) {
    var url = '/dsh-mobile/api/' + encodeURIComponent(cmd);
    if (args) url += '?args=' + encodeURIComponent(args);
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j || j.ok !== true) throw new Error((j && j.error) || '桥返回失败');
        return j.data;
      });
  }

  /* ---------------- 页面数据模型 ---------------- */

  /**
   * 权限项定义。`key` 与 APK 的 `perms` JSON 字段对应；
   * `perm` 是 openperms 的名字（跳到哪一页由 APK 决定）。
   */
  var PERM_ITEMS = [
    { key: 'allFiles', name: '所有文件访问', perm: 'allfiles',
      desc: '让 DSH 能读写手机存储里的任意文件（工作区互通）' },
    { key: 'camera', name: '相机', perm: 'app',
      desc: '拍照 / 扫码（暂未启用界面调用）' },
    { key: 'location', name: '定位', perm: 'app',
      desc: '读取最近一次位置（不主动持续定位）' },
    { key: 'recordAudio', name: '麦克风', perm: 'app',
      desc: '录音（暂未启用）' },
    { key: 'storage', name: '存储读取', perm: 'app',
      desc: '读取外部存储（旧版权限模型）' }
  ];

  var ADB_MODES = [
    { v: 'off',  name: '关闭', desc: '默认。所有 adb 命令都被拒绝' },
    { v: 'safe', name: '安全模式', desc: '仅放行截屏 / 输入 / 读状态等只读命令' },
    { v: 'full', name: '完整模式', desc: '允许任意 adb 命令（需二次确认，风险最高）' }
  ];

  /* ---------------- 渲染 ---------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  var CSS = [
    '.dsh-api-wrap{padding:16px 14px 40px;font-size:14px;line-height:1.55;}',
    '.dsh-api-h{font-size:16px;font-weight:600;margin:18px 0 8px;opacity:.92;}',
    '.dsh-api-h:first-child{margin-top:0;}',
    '.dsh-api-sub{font-size:12px;opacity:.55;margin:-4px 0 10px;}',
    '.dsh-api-row{display:flex;align-items:flex-start;gap:10px;padding:11px 12px;',
    '  border:1px solid rgba(128,128,128,.18);border-radius:10px;margin-bottom:8px;}',
    '.dsh-api-row .t{flex:1;min-width:0;}',
    '.dsh-api-row .n{font-weight:500;}',
    '.dsh-api-row .d{font-size:12px;opacity:.55;margin-top:2px;}',
    '.dsh-api-badge{flex:none;font-size:12px;padding:2px 8px;border-radius:99px;',
    '  border:1px solid currentColor;opacity:.75;white-space:nowrap;}',
    '.dsh-api-badge.on{color:#16a34a;background:rgba(22,163,74,.10);}',
    '.dsh-api-badge.off{color:#b45309;background:rgba(180,83,9,.10);}',
    '.dsh-api-btn{flex:none;font-size:12px;padding:5px 10px;border-radius:8px;cursor:pointer;',
    '  border:1px solid rgba(128,128,128,.30);background:transparent;color:inherit;}',
    '.dsh-api-btn:active{opacity:.6;}',
    '.dsh-api-btn.primary{border-color:#4D6BFE;color:#4D6BFE;}',
    '.dsh-api-btn.danger{border-color:#dc2626;color:#dc2626;}',
    '.dsh-api-note{font-size:12px;opacity:.6;margin:6px 0 14px;}',
    '.dsh-api-warn{font-size:12px;padding:10px 12px;border-radius:10px;margin:8px 0 14px;',
    '  background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.28);color:#b91c1c;}',
    '.dsh-api-err{font-size:12px;padding:10px 12px;border-radius:10px;margin:8px 0;',
    '  background:rgba(180,83,9,.08);border:1px solid rgba(180,83,9,.28);}'
  ].join('');

  function ensureCss() {
    if (document.getElementById('dsh-api-css')) return;
    var s = document.createElement('style');
    s.id = 'dsh-api-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /** 渲染整页（perms + adb）。数据缺失时显示占位。 */
  function render() {
    if (!panelEl) return;
    ensureCss();
    panelEl.innerHTML = '';

    /* ---- 顶部说明 ---- */
    var intro = el('div', 'dsh-api-sub',
      '这些是「手机端 DSH」额外提供的能力。涉及系统权限的项目，' +
      '点「去开启」会直接跳到对应的设置页面；你在系统里开好后，这里会自动勾上。');
    panelEl.appendChild(intro);

    /* ---- 权限区 ---- */
    panelEl.appendChild(el('div', 'dsh-api-h', '系统权限'));

    if (!lastPerms) {
      var e1 = el('div', 'dsh-api-err',
        '权限状态读不到（容器桥未就绪）。可在容器里执行：dsh-android perms');
      panelEl.appendChild(e1);
    } else {
      for (var i = 0; i < PERM_ITEMS.length; i++) {
        panelEl.appendChild(permRow(PERM_ITEMS[i]));
      }
    }

    /* ---- ADB 区 ---- */
    panelEl.appendChild(el('div', 'dsh-api-h', 'ADB 扩展'));
    var warn = el('div', 'dsh-api-warn',
      '⚠️ ADB 是 shell 级权限，比任何普通应用都高。开启后容器里的程序能模拟任意点击、' +
      '装/卸应用、读取其他应用数据。默认关闭，仅在你明确需要时开启。');
    panelEl.appendChild(warn);

    if (!lastAdb) {
      panelEl.appendChild(el('div', 'dsh-api-err',
        'ADB 状态读不到。可在容器里执行：dsh-android adb status'));
    } else {
      panelEl.appendChild(adbBlock(lastAdb));
    }

    /* ---- 底部说明 ---- */
    panelEl.appendChild(el('div', 'dsh-api-note',
      '提示：所有能力都由容器内的 dsh-android 命令提供，' +
      '在容器里敲 `dsh-android` 可看完整命令列表。'));
  }

  function permRow(item) {
    var on = !!(lastPerms && lastPerms[item.key]);
    var row = el('div', 'dsh-api-row');

    var t = el('div', 't');
    t.appendChild(el('div', 'n', item.name));
    t.appendChild(el('div', 'd', item.desc));
    row.appendChild(t);

    var badge = el('span', 'dsh-api-badge ' + (on ? 'on' : 'off'), on ? '已开启' : '未开启');
    row.appendChild(badge);

    if (!on) {
      var btn = el('button', 'dsh-api-btn primary', '去开启');
      btn.addEventListener('click', function () {
        btn.textContent = '跳转中…';
        call('openperms', item.perm).then(function (used) {
          btn.textContent = '去开启';
          // ★ 跳过去后，用户在系统里开完回来，靠轮询自动同步（见 startPoll）
          console.log('[DSH-API] openperms ->', used);
        }).catch(function (e) {
          btn.textContent = '去开启';
          alert('跳转失败：' + e.message + '\n可在容器里执行：dsh-android openperms ' + item.perm);
        });
      });
      row.appendChild(btn);
    }
    return row;
  }

  function adbBlock(st) {
    var wrap = el('div');

    var cur = (st && st.mode) || 'off';
    for (var i = 0; i < ADB_MODES.length; i++) {
      (function (m) {
        var on = (cur === m.v);
        var row = el('div', 'dsh-api-row');
        var t = el('div', 't');
        t.appendChild(el('div', 'n', m.name + (on ? '（当前）' : '')));
        t.appendChild(el('div', 'd', m.desc));
        row.appendChild(t);

        var badge = el('span', 'dsh-api-badge ' + (on ? 'on' : 'off'), on ? '使用中' : '未启用');
        row.appendChild(badge);

        var btn = el('button', 'dsh-api-btn' + (m.v === 'full' ? ' danger' : ''), '切换');
        btn.addEventListener('click', function () {
          var args = m.v;
          if (m.v === 'full') {
            if (!confirm(
              '切到「完整模式」吗？\n\n' +
              '这会让容器里的程序获得 shell 级权限：\n' +
              '· 模拟任意点击/滑动/输入\n' +
              '· 安装或卸载应用\n' +
              '· 读取其他应用的数据\n\n' +
              '前提：你已在系统「开发者选项 → 无线调试」里开启并配对。\n' +
              '确定继续？')) return;
            args = 'full confirm=yes';
          }
          if (m.v === 'off') {
            btn.textContent = '切换中…';
            call('adb', 'mode off').then(refresh).catch(function (e) {
              btn.textContent = '切换';
              alert('切换失败：' + e.message);
            });
            return;
          }
          btn.textContent = '切换中…';
          call('adb', 'mode ' + args).then(function () {
            if (m.v !== 'off') {
              // ★ 切到 safe/full 后提示去开无线调试
              setTimeout(function () {
                if (confirm('已切换到' + m.name + '。\n\n' +
                  '还需要在系统里打开「无线调试」才能实际使用。\n' +
                  '现在跳过去吗？')) {
                  call('openperms', 'wireless').catch(function () {});
                }
              }, 120);
            }
            refresh();
          }).catch(function (e) {
            btn.textContent = '切换';
            alert('切换失败：' + e.message);
          });
        });
        row.appendChild(btn);
        wrap.appendChild(row);
      })(ADB_MODES[i]);
    }

    if (cur !== 'off') {
      var portRow = el('div', 'dsh-api-note',
        '已在「无线调试」里看到的端口号（形如 5555），连上后容器内就能用 adb：' +
        'dsh-android adb connect <端口>');
      wrap.appendChild(portRow);
    }
    return wrap;
  }

  /* ---------------- 数据刷新（自动同步） ---------------- */

  function refresh() {
    return Promise.all([
      call('perms').catch(function () { return null; }),
      call('adb', 'status').catch(function () { return null; })
    ]).then(function (r) {
      var perms = r[0], adb = r[1];
      var changed = JSON.stringify(perms) !== JSON.stringify(lastPerms)
                 || JSON.stringify(adb) !== JSON.stringify(lastAdb);
      lastPerms = perms;
      lastAdb = adb;
      if (changed) render();   // ★ 只在真的变了才重绘，避免每 1.5s 闪一次
    });
  }

  /** 页面可见时才轮询 —— 用户切去系统设置开权限、再切回来，立刻就能看到。 */
  function startPoll() {
    stopPoll();
    pollTimer = setInterval(function () {
      if (document.hidden) return;
      if (!panelEl || !document.body.contains(panelEl)) return;
      refresh();
    }, POLL_MS);
  }
  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  /* ---------------- 挂进官方设置面板 ---------------- */

  var NAV_ID = 'dsh-api-nav';

  /** 在设置面板的 nav 里插入「API 设置」一项（幂等）。 */
  function injectNav(dlg) {
    try {
      if (!dlg) return;
      if (dlg.querySelector('#' + NAV_ID)) return;
      var nav = dlg.querySelector('[class*="nav"]');
      if (!nav) return;

      // 找一个 navCell 当模板（保持官方样式）
      var tpl = nav.querySelector('[class*="navCell"]');
      if (!tpl) return;

      var item = tpl.cloneNode(true);
      item.id = NAV_ID;
      item.setAttribute('data-dsh-api-nav', '1');
      // 去掉可能的选中态
      item.removeAttribute('aria-current');
      item.className = tpl.className.replace(/\S*(active|selected)\S*/gi, '').trim();
      // 换文字：navCell 里通常有一个 span/div 承载文本
      var txt = item.querySelector('span,div');
      if (txt) txt.textContent = 'API 设置';
      else item.textContent = 'API 设置';
      // 去掉图标上的特殊标记（保留原图标也行，这里不强求）
      nav.appendChild(item);

      console.log('[DSH-API] 已在设置导航插入「API 设置」');
    } catch (e) {
      console.warn('[DSH-API] injectNav 失败', e);
    }
  }

  /** 点「API 设置」时，把 content 区换成我们的面板。 */
  function showPanel(dlg) {
    try {
      var content = dlg.querySelector('[class*="content"]');
      if (!content) return;
      // 隐藏官方原有内容（不删，返回时能恢复）
      var kids = content.children;
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].getAttribute('data-dsh-api-keep') === '1') continue;
        kids[i].style.display = 'none';
      }
      // 我们的面板只建一次
      if (!panelEl || !content.contains(panelEl)) {
        panelEl = el('div', 'dsh-api-wrap');
        panelEl.setAttribute('data-dsh-api-keep', '1');
        panelEl.setAttribute('data-dsh-api-panel', '1');
        content.appendChild(panelEl);
      }
      panelEl.style.display = '';
      render();
      refresh();
      startPoll();
    } catch (e) {
      console.warn('[DSH-API] showPanel 失败', e);
    }
  }

  function hidePanel(dlg) {
    try {
      if (!panelEl) return;
      panelEl.style.display = 'none';
      var content = dlg && dlg.querySelector('[class*="content"]');
      if (content) {
        var kids = content.children;
        for (var i = 0; i < kids.length; i++) {
          if (kids[i].getAttribute('data-dsh-api-keep') === '1') continue;
          kids[i].style.display = '';
        }
      }
      stopPoll();
    } catch (e) {}
  }

  /** 找出当前打开的设置面板（与主插件同一判据）。 */
  function findDialog() {
    var all = document.querySelectorAll('[role="dialog"]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].hasAttribute('data-dsh-ghost')) continue;
      if (all[i].querySelector('[class*="navCell"],[class*="content"] > [class*="options"]')) return all[i];
    }
    return null;
  }

  /* ---------------- 事件接线 ---------------- */

  function boot() {
    // ① 点 nav 里的「API 设置」
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var nav = t.closest('#' + NAV_ID);
      if (!nav) return;
      var dlg = findDialog();
      if (!dlg) return;
      showPanel(dlg);
      ev.preventDefault();
      ev.stopPropagation();
    }, true);

    // ② 点别的 nav 项 ⇒ 收起我们的面板，恢复官方内容
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest('#' + NAV_ID)) return;                 // 我们自己
      var cell = t.closest('[class*="navCell"]');
      if (!cell) return;
      var dlg = findDialog();
      if (!dlg) return;
      if (!panelEl) return;
      hidePanel(dlg);
    }, true);

    // ③ 面板出现时注入 nav（MutationObserver，覆盖"设置关了又开"）
    try {
      new MutationObserver(function () {
        var dlg = findDialog();
        if (dlg) injectNav(dlg);
      }).observe(document.body, { childList: true, subtree: true });
    } catch (e) {}

    // ④ 首屏若已有面板（热重载场景）
    var d0 = findDialog();
    if (d0) injectNav(d0);

    // ⑤ 页面重新可见时立刻刷一次（用户从系统设置切回来）
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && panelEl && document.body.contains(panelEl)) refresh();
    });

    try {
      window.__dshApiSettings = {
        refresh: refresh,
        render: render,
        show: function () { var d = findDialog(); if (d) showPanel(d); },
        hide: function () { var d = findDialog(); if (d) hidePanel(d); },
        state: function () { return { perms: lastPerms, adb: lastAdb }; }
      };
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
