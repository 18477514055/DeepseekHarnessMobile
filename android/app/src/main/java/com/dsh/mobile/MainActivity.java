package com.dsh.mobile;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import java.io.File;

/**
 * 主界面：先显示解压/启动进度，就绪后切到 WebView 加载 127.0.0.1:3080。
 *
 * ★ 与旧 APK（com.dsh.shell）的区别：旧的是靠 Termux 的 RUN_COMMAND intent
 *   把一个外部 APP 拉起来；这里是**自己在进程里拉起 proot 容器**，不依赖任何外部 APP。
 */
public class MainActivity extends AppCompatActivity {
    private static final String TAG = "DshMain";

    private TextView statusText;
    private TextView detailText;
    private ProgressBar progress;
    private View splash;
    private View webWrap;
    private WebView webView;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean webShown = false;
    private long startedAt = 0;
    private static final int REQ_STORAGE = 1001;
    /** 是否已经弹过「所有文件访问」引导（只弹一次，别烦人）。 */
    private boolean allFilesGuided = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        statusText = findViewById(R.id.statusText);
        detailText = findViewById(R.id.detailText);
        progress = findViewById(R.id.progress);
        splash = findViewById(R.id.splash);
        webWrap = findViewById(R.id.webWrap);
        webView = findViewById(R.id.webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        CookieManager.getInstance().setAcceptCookie(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                // 只允许本机；外链交给系统浏览器
                if ("127.0.0.1".equals(u.getHost()) || "localhost".equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) { }
                return true;
            }

            /* ★★★ 2026-10-20：记录**页面加载各阶段**的真实时间点。
               为什么加：用户报「更新后首次打开，进去后几分钟主界面的功能都不能用」，
               但外层 boot.log 只能看到容器起来那一刻，看不到**页面内部**在等什么
               （内核初始化 profile / 加载插件 / 拉模型清单都发生在页面里）。
               有了这三条，下次首次打开就能直接看出卡在哪个阶段：
                 PAGE_START  → onPageStarted
                 PAGE_DONE   → onPageFinished（DOM 好了，但功能不一定就绪）
                 PAGE_PROGRESS → onProgressChanged 到达 100 */
            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap fav) {
                Cfg.log(MainActivity.this,
                        "PAGE_START url=" + url.replaceAll("token=[^&]+", "token=***"));
                /* ★★★ 2026-10-20：**到这一刻才撤启动页**。
                   为什么：原来是 showWeb 里先 splash.GONE 再 loadUrl，
                   而 WebView 从 loadUrl 到真正发出请求要 8~9 秒（渲染进程冷启动），
                   这段时间 splash 已消失、页面还没画 ⇒ 用户看到的就是「黑屏 7~8 秒」。
                   实测（JZQ8H6U46PBY9PV8）：showWeb 21:56:51.087 → PAGE_START 21:56:59.965，
                   中间 8.9 秒全黑，而页面本身只用了 0.77 秒。
                   ⇒ 启动页必须压到「页面真的开始了」再收，宁可多留一会儿也不要露黑底。 */
                revealWeb();
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                Cfg.log(MainActivity.this, "PAGE_DONE（DOM 就绪）");
            }
        });

        // ★★★ 2026-10-20：把页面 console 转发到 /sdcard/DeepseekHarness/web.log。
        //   为什么加这个：插件的手势问题我改了四版都没修好 ——
        //   因为**看不到运行时的真实值**，只能靠猜。带上这条后，
        //   `adb shell cat /sdcard/DeepseekHarness/web.log` 就能看到
        //   手势每一步为什么被跳过（平台/滚动区/面板页/阈值不够…）。
        //   ★ 只记 `[DSH-DIAG]` 前缀的，避免把官方日志刷爆。
        webView.setWebChromeClient(new android.webkit.WebChromeClient() {
            /* ★★★ 2026-10-20：记录页面加载进度，只记 10/50/100 三个点。
               和 PAGE_START/PAGE_DONE 配合，能区分「DOM 到了」和「资源全到了」。 */
            @Override
            public void onProgressChanged(WebView v, int p) {
                if (p == 10 || p == 50 || p == 100) {
                    Cfg.log(MainActivity.this, "PAGE_PROGRESS " + p + "%");
                }
            }

            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage cm) {
                try {
                    String msg = cm.message();
                    if (msg != null && msg.startsWith("[DSH-DIAG]")) {
                        File dir = Cfg.sharedRoot(MainActivity.this);
                        if (dir.exists() || dir.mkdirs() || dir.exists()) {
                            try (java.io.FileOutputStream fos = new java.io.FileOutputStream(
                                    new File(dir, "web.log"), true)) {
                                fos.write((msg + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
                            }
                        }
                    }
                } catch (Exception ignored) { }
                return false;
            }
        });

        // ★ 先要存储权限，再启服务 —— 因为服务启动时要 bind 手机存储进容器。
        //   targetSdk=28 ⇒ READ/WRITE_EXTERNAL_STORAGE 走运行时弹窗即可；
        //   ★ 但「写手机存储」还额外需要 MANAGE_EXTERNAL_STORAGE（特殊 appop，
        //     不受 targetSdk 限制，只能由用户在系统设置里手动开，没有 API 弹窗）。
        //     参考台账 §24.2：判据一律看 `cmd appops get`，不要凭 API 等级推断。
        requestStorageThenStart();
    }

    /**
     * 「所有文件访问」是否已授予。
     * ★ Android 11+ 用 Environment.isExternalStorageManager()；
     *   R 以下没有这个开关，直接当作已授予（targetSdk=28 时 WRITE 就够）。
     */
    private boolean hasAllFilesAccess() {
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                return Environment.isExternalStorageManager();
            } catch (Throwable t) {
                return false;
            }
        }
        return true;
    }

    /**
     * 引导用户去开「所有文件访问权限」。
     * ★ 这个权限**没有运行时弹窗**，只能跳系统设置页让用户自己点。
     *   跳不过去就退到本 App 的详情页，再不行就只给文字提示。
     */
    private void guideAllFilesAccess() {
        if (allFilesGuided) return;
        allFilesGuided = true;
        statusText.setText("还需要「所有文件访问权限」，才能把文件写进手机目录");
        String msg = "要让 DSH 能往手机目录里写文件，需要开一个系统开关：\n\n"
                + "「所有文件访问权限」\n\n"
                + "点「去开启」会跳到设置页，找到这个开关打开即可。\n"
                + "不开也能用，只是容器里对手机存储是只读的。";
        new androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle("再开一个权限")
                .setMessage(msg)
                .setPositiveButton("去开启", (d, w) -> openAllFilesSettings())
                .setNegativeButton("稍后", (d, w) -> startDshService())
                .setCancelable(false)
                .show();
    }

    private void openAllFilesSettings() {
        // 优先跳到本 App 的「所有文件访问」页
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                Intent i = new Intent(
                        Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        Uri.parse("package:" + getPackageName()));
                startActivity(i);
                return;
            } catch (Exception ignored) { }
            try {
                // 部分 ROM 只有总列表页
                startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                return;
            } catch (Exception ignored) { }
        }
        openAppSettings();
    }

    private void requestStorageThenStart() {
        if (Build.VERSION.SDK_INT >= 23
                && checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                   != PackageManager.PERMISSION_GRANTED) {
            statusText.setText("需要存储权限，才能让工作区文件与手机互通");
            requestPermissions(new String[]{
                    android.Manifest.permission.READ_EXTERNAL_STORAGE,
                    android.Manifest.permission.WRITE_EXTERNAL_STORAGE
            }, REQ_STORAGE);
            return;
        }
        // 运行时权限有了 —— 再查「所有文件访问」（没有弹窗，只能引导）
        if (!hasAllFilesAccess()) {
            guideAllFilesAccess();
            return;
        }
        startDshService();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_STORAGE) {
            boolean granted = grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (!granted) {
                // 不阻断启动：没权限只是共享目录不可用，容器照样能跑
                Toast.makeText(this,
                        "没给存储权限：DSH 照常能用，但手机和容器之间看不到共享文件夹",
                        Toast.LENGTH_LONG).show();
            }
            // ★ 拿到运行时权限后还要查「所有文件访问」—— 这才是能写的关键
            if (!granted || hasAllFilesAccess()) {
                startDshService();
            } else {
                guideAllFilesAccess();
            }
        }
    }

    /**
     * ★ 从系统设置页返回时重新判定。
     *   上一版没有这段 ⇒ 用户在设置里开完「所有文件访问」回到 App，
     *   界面永远停在引导弹窗，必须杀掉重开才行（踩过）。
     */
    @Override
    protected void onResume() {
        super.onResume();
        if (webShown || startedAt != 0) return;   // 已经启动了，不用再判定
        if (!allFilesGuided) return;              // 没弹过引导，说明还在前面那步
        if (hasAllFilesAccess()) {
            Toast.makeText(this, "「所有文件访问」已开启", Toast.LENGTH_SHORT).show();
            startDshService();
        }
    }

    private void startDshService() {
        // 启动前台服务（它负责解压 + 拉起容器 + 保活）
        startedAt = System.currentTimeMillis();
        Intent svc = new Intent(this, DshService.class);
        svc.setAction(DshService.ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(svc);
        } else {
            startService(svc);
        }

        pollStatus();
    }

    /** 每秒轮询一次：服务就绪了就切 WebView。 */
    private void pollStatus() {
        ui.postDelayed(() -> {
            String st = DshService.lastStatus;
            if (st != null && !st.isEmpty()) {
                statusText.setText(st);
                if (st.startsWith("解压")) {
                    // 进度由通知体现；这里给个不确定态
                    progress.setIndeterminate(true);
                }
            }

            // ★★★ 判据必须是「readyUrl 已取到」，不能是「端口能连上」。
            //   踩过：probeNow() 一返回 401 就切 WebView，那一刻服务刚 listening、
            //   但 token 还没从 proot.log 里读出来 ⇒ readyUrl 为空 ⇒ 退回用写死的旧
            //   token ⇒ 页面显示 "dsh web authentication required"。
            //   （日志里 `loading ...token=***` 看着正常，其实 *** 底下是旧令牌。）
            String url = DshService.readyUrl;
            if (DshService.running && url != null && !url.isEmpty()) {
                showWeb(url);
            } else {
                long el = (System.currentTimeMillis() - startedAt) / 1000;
                /* ★★★ 2026-10-20（P1 性能 / 用户原话）：
                   「可以让这个软件的启动页本身自己就先区分开加载各种各样东西的阶段，
                     用户自己也能看得见，我们也刚好可以用得上这个分段测试。」

                   ⇒ 启动页现在把**已完成阶段的耗时**逐条列出来：
                     用户看得见卡在哪一步；我们顺手就有了分段数据。
                   ★ 数据来源是 DshService.stageTimings（每次 setStatus 自动记一段），
                     不是另造一套 —— 显示的和日志里的是同一份。 */
                java.util.List<String> stages =
                        new java.util.ArrayList<>(DshService.stageTimings);
                StringBuilder sb = new StringBuilder();
                sb.append("已等待 ").append(el).append(" 秒");
                if (!stages.isEmpty()) {
                    sb.append("\n");
                    // 只列最近 6 段，避免长启动把屏幕占满
                    int from = Math.max(0, stages.size() - 6);
                    for (int i = from; i < stages.size(); i++) {
                        if (i > from) sb.append("\n");
                        sb.append("· ").append(stages.get(i));
                    }
                } else {
                    sb.append("\n（首次启动需解压约 1~3 分钟）");
                }
                detailText.setText(sb.toString());
                pollStatus();
            }
        }, 1000);
    }

    private boolean probeNow() {
        try {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                    new java.net.URL("http://127.0.0.1:" + Cfg.PORT + "/").openConnection();
            c.setConnectTimeout(1500);
            c.setReadTimeout(1500);
            int code = c.getResponseCode();
            c.disconnect();
            return code == 401 || code == 200 || code == 303;
        } catch (Exception e) {
            return false;
        }
    }

    /* ★★★ 2026-10-20（修「7~8 秒黑屏」）：撤启动页的**唯一入口**。
       谁调：
         · onPageStarted —— 正常路径，页面真的开始加载了
         · showWeb 里的 12 秒兜底 —— 万一 onPageStarted 不来（离线 / 端口错）
       为什么要收口成一个方法：以前 splash.GONE 散在 showWeb 里，
       撤得太早就是这次黑屏的根因。收成一个入口，以后只有"该撤的时候"才撤。
       用 post 到主线程：onPageStarted 虽在主线程，但兜底调用点可能在别的时机。 */
    private void revealWeb() {
        ui.post(() -> {
            if (splash != null && splash.getVisibility() != View.GONE) {
                splash.setVisibility(View.GONE);
                Cfg.log(this, "revealWeb 已撤启动页（t=" + System.currentTimeMillis() + "）");
            }
        });
    }

    private void showWeb(String url) {
        if (webShown) return;
        webShown = true;
        progress.setIndeterminate(false);
        progress.setProgress(100);

        Log.i(TAG, "loading " + url.replaceAll("token=[^&]+", "token=***"));
        /* ★★★ 2026-10-20：把**是否带 token / token 有多长**记进 boot.log。
           为什么要记长度：真机日志里出现过「日志说 token 已取到，但 PAGE_START
           的 URL 是 http://127.0.0.1:3080/（没有 ?token=）」的矛盾。
           不把长度记下来，就无法区分是"URL 真的没带"还是"日志被正则抹掉了"。 */
        Cfg.log(this, "showWeb urlLen=" + url.length()
                + " hasToken=" + (url.contains("?token=") && !url.endsWith("?token=")));

        /* ★★★ 2026-10-20（修「7~8 秒黑屏」）：
           原顺序是 splash.GONE → webWrap.VISIBLE → loadUrl。
           实测 WebView 从 loadUrl 到 onPageStarted 要 8~9 秒（渲染进程冷启动），
           这段时间启动页已撤、页面没画 ⇒ 全黑。
           ⇒ 现在：WebView 从布局加载起就在底层可见（不靠这里切），splash **不撤**，
              由 onPageStarted / revealWeb() 负责撤；同时留一个 12 秒兜底，
              万一 onPageStarted 不来（离线/端口错），也不能让启动页永远卡着。 */
        webView.loadUrl(url);

        // ★ 兜底：12 秒还没等到 onPageStarted，就先撤（总比一直挡着强）
        ui.postDelayed(this::revealWeb, 12000);

        // ★★★ 2026-10-20：**主动注入**一段诊断 —— 不依赖插件的 console.log
        //   （实测 web.log 根本没生成 ⇒ onConsoleMessage 或 console.log 没走通）。
        //   ★ 改成**每 2 秒 dump 一次**（共 40 次 ≈ 80 秒），这样用户划一下之后
        //     我能在日志里看到"划之前 / 划之后"两个快照，直接对比出哪条 CSS 没生效。
        ui.postDelayed(this::dumpDiag, 3000);
        ui.postDelayed(() -> startDiagLoop(40), 5000);

        // 顺便提示一下后台策略（不做开机自启，但要提醒用户别被系统杀）
        maybePromptBattery();
    }

    /** 每隔 2 秒 dump 一次，连续 n 次。 */
    private void startDiagLoop(int times) {
        if (times <= 0) return;
        dumpDiag();
        ui.postDelayed(() -> startDiagLoop(times - 1), 2000);
    }

    /**
     * 把页面内关键状态 dump 到 /sdcard/DeepseekHarness/web.log。
     * ★ 用 evaluateJavascript 主动去问，而不是等页面来告诉我 ——
     *   这样即使插件的 console 通路坏了，也能拿到现场。
     * ★★ 2026-10-20：加了**侧栏元素的真实几何**（getBoundingClientRect + computedStyle）。
     *   因为日志显示手势逻辑跑通了（rail → railOpen 都执行了），
     *   但用户看到的仍是"没反应" ⇒ 问题在**渲染层**，不在逻辑层。
     *   只有拿到 width/display/transform/overflow 这些真实值，才能定位是哪条 CSS 没生效。
     */
    private void dumpDiag() {
        if (webView == null) return;
        String js =
            "(function(){try{" +
            "var h=document.documentElement;" +
            "var f=document.querySelector('[class*=\"frame\"]');" +
            "var c=f&&f.querySelector('[class*=\"centerCol\"]');" +
            "var sb=document.querySelector('[class*=\"sidebarCol\"]');" +
            "var o={};" +
            "o.pluginLoaded=!!(window.__dshMobileHealth);" +
            "o.health=window.__dshMobileHealth||null;" +
            "o.hasBack=typeof window.__dshBack==='function';" +
            "o.rail=h.getAttribute('data-dsh-rail');" +
            "o.overlay=h.getAttribute('data-dsh-sidebar-overlay');" +
            "o.panelAttr=h.getAttribute('data-dsh-panel-open');" +
            "o.collapsed=f?f.hasAttribute('data-sidebar-collapsed'):null;" +
            "o.hasEditor=!!(c&&c.querySelector('[data-lexical-editor],[contenteditable=\"true\"]'));" +
            "o.w=window.innerWidth;o.h=window.innerHeight;" +
            // ★ 侧栏元素的**真实几何**（这是判断"到底显示没显示"的唯一硬证据）
            "if(sb){var r=sb.getBoundingClientRect();var cs=getComputedStyle(sb);" +
            "o.sidebar={x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)," +
            "display:cs.display,visibility:cs.visibility,opacity:cs.opacity," +
            "position:cs.position,transform:cs.transform,overflow:cs.overflow," +
            "gridCol:cs.gridColumn,zIndex:cs.zIndex};}" +
            "else o.sidebar=null;" +
            "if(f){var fr=f.getBoundingClientRect();var fc=getComputedStyle(f);" +
            "o.frame={w:Math.round(fr.width),cols:fc.gridTemplateColumns,overflow:fc.overflow,overflowX:fc.overflowX};}" +
            "o.railStateFn=typeof window.__dshRailState==='function'?(window.__dshRailState()):null;" +
            "return JSON.stringify(o);" +
            "}catch(e){return JSON.stringify({err:String(e)});}})()";
        webView.evaluateJavascript(js, value -> {
            try {
                File dir = Cfg.sharedRoot(this);
                if (dir.exists() || dir.mkdirs() || dir.exists()) {
                    try (java.io.FileOutputStream fos = new java.io.FileOutputStream(
                            new File(dir, "web.log"), true)) {
                        fos.write(("[DIAG] " + value + "\n")
                                .getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    }
                }
                Log.i(TAG, "diag dumped: " + value);
            } catch (Exception e) {
                Log.w(TAG, "diag write failed: " + e.getMessage());
            }
        });
    }

    private boolean batteryPrompted = false;

    private void maybePromptBattery() {
        if (batteryPrompted) return;
        batteryPrompted = true;
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                new androidx.appcompat.app.AlertDialog.Builder(this)
                        .setTitle("让它在后台活着")
                        .setMessage("系统的省电策略可能把后台清掉。\n\n"
                                + "建议到「设置 → 应用 → Deepseek Harness Mobile」里：\n"
                                + "· 省电策略设为「无限制」\n"
                                + "· 允许自启动\n"
                                + "· 在最近任务里把它加锁\n\n"
                                + "本 App 不会自己申请开机自启（那样容易被系统盯上），"
                                + "所以重启手机后需要你手动点开一次。")
                        .setPositiveButton("去设置", (d, w) -> openAppSettings())
                        .setNegativeButton("知道了", null)
                        .show();
            }
        } catch (Exception e) {
            Log.w(TAG, "battery prompt: " + e.getMessage());
        }
    }

    private void openAppSettings() {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception e) {
            Toast.makeText(this, "请手动打开系统设置", Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * 系统返回键。
     *
     * ★★★ 2026-10-20 修（用户报「系统返回键直接回桌面，应该返回上一层」）：
     *
     *   旧实现只有两行：
     *     if (webView.canGoBack()) webView.goBack(); else moveTaskToBack(true);
     *
     *   两个致命问题：
     *   ① **从来没人调用过插件的 `window.__dshBack()`** —— 插件里那套
     *      「先关设置页 → 再收侧栏 → 再关弹窗 → 最后回主界面」的层次逻辑**完全没生效**。
     *   ② SPA 里 `canGoBack()` 基本恒为 false（页面没有真的跳转），
     *      于是永远走 `moveTaskToBack` ⇒ **一按返回就回桌面**。
     *
     *   现在的顺序：
     *     ① 先在 WebView 里问插件：这一层能不能关？能就关掉，返回键就此消化；
     *     ② 关不掉、但 WebView 确实有历史 → goBack；
     *     ③ 都不行 → 退到后台（**不 finish，服务继续跑**）。
     *
     *   ★ 用 evaluateJavascript 的异步回调，不能同步等（会卡 UI 线程）。
     *     回调里判断 `true` 就算已处理。
     */
    @Override
    public void onBackPressed() {
        if (!webShown || webView == null) {
            moveTaskToBack(true);
            return;
        }
        try {
            webView.evaluateJavascript(
                    "(function(){try{return (window.__dshBack&&window.__dshBack())?'1':'0'}catch(e){return '0'}})()",
                    value -> {
                        boolean handled = value != null && value.contains("1");
                        if (handled) return;                 // 插件已经把这一层关掉了
                        if (webView.canGoBack()) {
                            webView.goBack();
                        } else {
                            // 退到后台但不停止服务（保持常驻）
                            moveTaskToBack(true);
                        }
                    });
        } catch (Exception e) {
            Log.w(TAG, "back: " + e.getMessage());
            moveTaskToBack(true);
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        ui.removeCallbacksAndMessages(null);
    }
}
