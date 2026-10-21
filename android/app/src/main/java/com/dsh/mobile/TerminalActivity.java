package com.dsh.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * ★★★ 2026-10-21：独立终端 —— **容器自己的终端**，不依附 DSH。
 *
 * <h3>为什么要有它</h3>
 * 用户原话：「**Dsh 只是我们这个游戏中的一个程序**。我想要的一个终端是
 * **独立控制这个容器**。甚至将这个容器可以当**第二个 Termux**。」
 *
 * 在此之前，终端是 DSH 那个 node 进程 fork 出来的（容器内 ps 实测），
 * 所以 **DSH 起不来就没有终端**，连自救的办法都没有。
 * 本 Activity 直接拿 {@link PtySession} 起**独立的 proot 实例**，与 DSH 无关。
 *
 * <h3>为什么用 onJsPrompt 而不是 addJavascriptInterface</h3>
 * {@code MainActivity.java:131} 早就写明：「后者会把一个 Java 对象暴露给任意页面脚本，
 * 是已知的高危面」。本项目一路回避它。
 * <p>
 * 但终端需要**大量、高频、双向**的字节传输（按键、PTY 输出），
 * {@code evaluateJavascript} 单向上限太低、{@code WebMessage} 又要 API 23+ 的兼容成本。
 * {@code onJsPrompt} 是**同步一问一答**：js 里 {@code window.prompt('DSHPty', json)}
 * 直接被这里截住，返回值就是 Java 的答复 —— 天然支持双向，而且**页面拿不到任何 Java 对象**，
 * 只拿到一个字符串。安全性等价于 evaluateJavascript。
 * <p>
 * ★ 再收一道：只对**我们自己加载的**本地页面开放（{@link #bridgeAllowed}），
 * 任何跳转到外部 URL 的情况一律返回 null。
 */
public class TerminalActivity extends Activity {

    private static final String BRIDGE = "DSHPty";

    private WebView web;
    private PtySession session;
    private FrameLayout root;

    /** 只有加载的是我们自己的 assets 页面时才允许 prompt 过桥。 */
    private volatile boolean bridgeAllowed = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);

        /* 深色 + 全屏：终端页不该有标题栏占地方。
         * ★ 不用 FLAG_FULLSCREEN（会和软键盘的 adjustResize 打架），
         *   只去掉标题栏、让内容延伸到状态栏下方。 */
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setBackgroundDrawableResource(android.R.color.black);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#1E1E1E"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#1E1E1E"));
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // 本地 assets 页面：允许 file:// 访问同目录资源（xterm.js / css）
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        // ★ 不缩放：终端字号由 xterm 自己管，网页缩放会让行列数算错
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        // 缓存无所谓（本地文件），但别让它去联网拿旧版本
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, android.webkit.WebResourceRequest req) {
                // 终端页里不该有外链；有就拦掉，避免跳出后 bridge 仍开着
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                Cfg.log(TerminalActivity.this, "[TERM] 页面加载完成 " + url);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            /* ★★★ 这是整个终端的咽喉：js → Java 的唯一通道。 */
            @Override
            public boolean onJsPrompt(WebView view, String url, String message,
                                      String defaultValue, JsPromptResult result) {
                if (!BRIDGE.equals(message)) return false;   // 不是我们的，走默认处理
                if (!bridgeAllowed) {
                    result.confirm("");
                    return true;
                }
                String reply;
                try {
                    reply = handleBridge(defaultValue == null ? "{}" : defaultValue);
                } catch (Throwable t) {
                    Cfg.log(TerminalActivity.this, "[TERM] bridge 异常: " + t);
                    reply = "ERR " + t;
                }
                result.confirm(reply == null ? "" : reply);
                return true;
            }

            /* 终端页面不该弹 alert；但万一有，别把 WebView 卡死 */
            @Override
            public boolean onJsAlert(WebView v, String url, String msg, JsResult r) {
                r.confirm();
                return true;
            }
        });

        bridgeAllowed = true;
        web.loadUrl("file:///android_asset/term/index.html");

        // 软键盘：让内容整体上推，而不是盖住终端底部
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    }

    /* ------------------------------------------------------------------ */
    /* js → Java                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * 处理一条 bridge 请求。**在 UI 线程同步执行**（onJsPrompt 就是 UI 线程）。
     * 返回的字符串会原样交给 js。
     */
    private String handleBridge(String json) {
        String op = PtySession.JsonField.get(json, "op");

        if ("start".equals(op)) {
            int cols = (int) PtySession.JsonField.getLong(json, "cols", 80);
            int rows = (int) PtySession.JsonField.getLong(json, "rows", 24);
            return startSession(cols, rows);
        }

        if ("write".equals(op)) {
            if (session != null) session.write(PtySession.JsonField.get(json, "data"));
            return "ok";
        }

        if ("resize".equals(op)) {
            if (session != null) {
                session.resize((int) PtySession.JsonField.getLong(json, "cols", 0),
                        (int) PtySession.JsonField.getLong(json, "rows", 0));
            }
            return "ok";
        }

        if ("alive".equals(op)) {
            return (session != null && session.isReady()) ? "1" : "0";
        }

        if ("clipboard".equals(op)) {
            try {
                ClipboardManager cm = (ClipboardManager)
                        getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null || !cm.hasPrimaryClip()) return "";
                ClipData cd = cm.getPrimaryClip();
                if (cd == null || cd.getItemCount() == 0) return "";
                CharSequence t = cd.getItemAt(0).coerceToText(this);
                return t == null ? "" : t.toString();
            } catch (Throwable e) {
                return "";
            }
        }

        if ("stop".equals(op)) {
            if (session != null) session.stop();
            return "ok";
        }

        return "ERR unknown op " + op;
    }

    /**
     * 起会话。★ 必须给 js 一个同步答复，但 proot 装配要好几百毫秒 ——
     * 直接在 UI 线程等会卡界面。做法：先回 "ok"，真正的启动放到后台线程，
     * 进度用 {@code __ptyOnStatus} 推给页面。
     */
    private String startSession(final int cols, final int rows) {
        if (session != null && session.isReady()) return "ok";

        if (!RootfsInstaller.isInstalled(this)) {
            return "运行环境还没解压好。请先回首页，等「进入 DSH」变成可点再试。";
        }

        final PtySession s = new PtySession(this, new PtySession.Sink() {
            @Override
            public void onData(String text) {
                if (text == null || text.isEmpty()) return;
                runJs("__ptyOnData(" + quote(text) + ")");
            }

            @Override
            public void onStatus(String msg) {
                if (msg == null) return;
                runJs("__ptyOnStatus(" + quote(msg) + ")");
            }

            @Override
            public void onExit(int code, String reason) {
                runJs("__ptyOnExit(" + code + "," + quote(reason == null ? "" : reason) + ")");
            }
        });
        session = s;

        new Thread(() -> {
            try {
                Cfg.log(TerminalActivity.this, "[TERM] 启动 PTY (" + cols + "x" + rows + ")");
                s.start(cols, rows);
            } catch (Throwable t) {
                Cfg.log(TerminalActivity.this, "[TERM] 启动失败: " + t);
                runJs("__ptyOnExit(-1," + quote(String.valueOf(t.getMessage())) + ")");
            }
        }, "dsh-term-start").start();

        return "ok";
    }

    /* ------------------------------------------------------------------ */
    /* Java → js                                                           */
    /* ------------------------------------------------------------------ */

    /** 在 UI 线程执行一段 JS。 */
    private void runJs(final String code) {
        runOnUiThread(() -> {
            if (web == null) return;
            try {
                web.evaluateJavascript(code, null);
            } catch (Throwable ignored) { }
        });
    }

    /** 把字符串包成 JS 字面量（含引号）。 */
    private static String quote(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 16);
        PtySession.jsonString(sb, s);
        return sb.toString();
    }

    /* ------------------------------------------------------------------ */
    /* 生命周期                                                            */
    /* ------------------------------------------------------------------ */

    @Override
    public void onBackPressed() {
        /* ★★★ 2026-10-21（用户原话）：
         *   「如果现在我在这个全局终端页面的话，系统返回就应该**返回启动页**，
         *     **而不是直接退出到桌面**。」
         *
         * 为什么要专门处理：TerminalActivity 是从 MainActivity 起来的，
         * 默认按返回会 finish() 本页 → 回到 MainActivity（启动页）——这条路本来就是对的，
         * 但**如果启动页已经被压栈销毁**（比如从设置面板里唤起、或系统回收过 MainActivity），
         * 再按返回就会直接退到桌面。所以这里**显式**保证回到启动页：
         *   ① 有 MainActivity 在栈里 ⇒ 正常 finish，系统自己回去；
         *   ② 没有 ⇒ 主动拉一个 MainActivity，并把当前任务带到前台。
         *
         * ★ 另外：终端里 bash/vim/tmux 也需要返回键（在很多手机上是 ESC）。
         *   但用户要的是**返回=回启动页**，所以不把返回键转给 bash ——
         *   要 ESC 就用底部工具条那个「Esc」键（键盘工具条就是为这个做的）。
         *   这是用户明确的选择，不要擅自改回去。 */
        try {
            if (session != null) session.stop();
        } catch (Throwable ignored) { }

        if (isTaskRoot()) {
            // 本页是任务根（被系统恢复过 / 直接唤起）⇒ 主动补一个启动页
            try {
                Intent i = new Intent(this, MainActivity.class);
                i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                startActivity(i);
            } catch (Throwable ignored) { }
        }
        super.onBackPressed();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // 音量键照常（用户可能要调），其余交给 WebView
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
            web.requestFocus();
        }
    }

    @Override
    protected void onDestroy() {
        bridgeAllowed = false;
        try { if (session != null) session.close(); } catch (Throwable ignored) { }
        try {
            if (web != null) {
                web.loadUrl("about:blank");
                web.destroy();
            }
        } catch (Throwable ignored) { }
        super.onDestroy();
    }
}
