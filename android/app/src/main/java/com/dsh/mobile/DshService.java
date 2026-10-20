package com.dsh.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 前台服务：拉起 proot 容器里的 DSH，并**保活**。
 *
 * ★★ 保活三件套（§D3 / docs/01）：
 *   ① 前台服务类型 specialUse（在 manifest 里声明）—— dataSync 有 6 小时上限，specialUse 没有
 *   ② 进程内拿 PARTIAL_WAKE_LOCK —— 不加的话 MIUI 会把整个 App 判为可回收
 *      （实测证据：am_kill [0,11436,com.termux,200,SwipeUpClean,160028]）
 *   ③ 引导用户开白名单 —— 见 MainActivity
 *
 * ★ 不实现开机自启（用户明确要求：容易被安卓盯上）。
 */
public class DshService extends Service {
    private static final String TAG = "DshService";
    private static final String CH_ID = "dsh_service";
    private static final int CH_NOTIFY_ID = 1001;

    public static final String ACTION_START = "com.dsh.mobile.START";
    public static final String ACTION_STOP = "com.dsh.mobile.STOP";
    /** 服务把状态广播出去给 Activity 用（简单起见用静态字段 + 回调）。 */
    public static volatile boolean running = false;
    public static volatile String lastStatus = "";
    /** 就绪后的完整 URL（含本次启动真实生成的 token）。MainActivity 读它。 */
    public static volatile String readyUrl = "";

    private Process proc;
    private PowerManager.WakeLock wakeLock;
    private Thread runner;
    private NotificationManager nm;

    @Override
    public void onCreate() {
        super.onCreate();
        nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }

        startForeground(CH_NOTIFY_ID, buildNotification("正在启动容器…"));

        // ★ WakeLock：保活三件套第 2 条
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dsh:container");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) wakeLock.acquire();

        if (runner == null || !runner.isAlive()) {
            runner = new Thread(this::bootContainer, "dsh-boot");
            runner.start();
        }
        // 用户点开 APP 就启动，被杀后由系统按 START_STICKY 尝试恢复
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (proc != null) {
            proc.destroy();
            proc = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ------------------------------------------------------------------

    private void bootContainer() {
        try {
            Cfg.log(this, "=== bootContainer 开始 ===");

            // ★ 诊断：只跑一次（没有 diag.log 时）。
            //   目的：在**真正的 app 进程（untrusted_app 域）**里测各路径能否 exec、
            //   共享存储能不能读写。shell 里的 run-as 是 runas_app 域，结果是假阴性。
            if (!new File(Cfg.files(this), "diag.log").exists()) {
                Cfg.log(this, "跑一次能力诊断…");
                Diag.runAll(this);
            }

            setStatus("准备 sysdata…");
            Sysdata.ensure(this);
            Cfg.log(this, "sysdata OK");

            setStatus("部署 proot…");
            ProotLauncher.stageBinaries(this);
            Cfg.log(this, "proot 五件套 OK");

            File tmp = Cfg.tmpDir(this);
            if (!tmp.exists() && !tmp.mkdirs()) throw new IOException("无法创建 tmp");
            File home = Cfg.dshHome(this);
            if (!home.exists() && !home.mkdirs()) throw new IOException("无法创建 dshhome");

            Cfg.log(this, "isInstalled=" + RootfsInstaller.isInstalled(this));
            if (!RootfsInstaller.isInstalled(this)) {
                setStatus("首次启动，正在解压运行环境（约 1~3 分钟）…");
                Cfg.log(this, "开始解压 rootfs");
                RootfsInstaller.install(this, (pct, detail) ->
                        updateNotification("解压运行环境 " + pct + "%", detail));
            }

            // ★ pnpm：插件系统必需（没它插件市场会报 spawn pnpm ENOENT）
            if (!RootfsInstaller.isPnpmInstalled(this)) {
                setStatus("安装 pnpm（插件系统必需）…");
                Cfg.log(this, "开始安装 pnpm");
                RootfsInstaller.installPnpm(this, (pct, detail) ->
                        updateNotification("安装 pnpm " + pct + "%", detail));
            } else {
                Cfg.log(this, "pnpm 已就位，跳过");
            }

            // ★★★ 移动端适配插件：随包分发，不能让用户自己去下载。
            //   ★ 必须**在容器启动前**装好 —— profile 是启动时读的，
            //     启动后再改要重启内核才生效。
            if (!RootfsInstaller.isAdaptInstalled(this)) {
                setStatus("安装移动端适配插件…");
                Cfg.log(this, "开始安装 dsh-mobile-adaption");
                RootfsInstaller.installAdapt(this, (pct, detail) ->
                        updateNotification("安装移动端适配 " + pct + "%", detail));
            } else {
                Cfg.log(this, "移动端适配插件已就位，跳过");
            }

            /* ★★★ 2026-10-20：**无条件**修 pnpm 的「最小发布年龄」限制。
             *
             * 为什么必须放在这里、而不是 installAdapt 里面：
             *   installAdapt 只在「插件没装好」时才被调用（见上面那个 if）。
             *   插件早已装好时它整段跳过 ⇒ 补丁永远没机会跑（这个坑刚踩过：
             *   日志里连一行 pnpm 补丁记录都没有）。
             *
             * 要修的问题（用户在手机上装 dsh-ledger-memory 时报的错）：
             *   Cannot edit "minimumReleaseAgeExclude" in
             *   "/root/.dsh/profiles/web/pnpm-workspace.yaml": it uses an inline
             *   YAML value that cannot be edited in place …
             *   → dsh: plugin command failed; pnpm add -w 'dsh-ledger-memory@1.2.9'
             *
             * ⇒ 把 minimumReleaseAge 设 0 并清掉 exclude 字段，
             *   这样 pnpm 不再产生那个字段，**以后装任何插件都不会再撞这个墙**。
             *
             * ★ 但 /root/.dsh 在 Android 侧权限是 000（只有容器内的 root 能忽略），
             *   所以真正的改写必须**在容器内**用 root 完成 ——
             *   这里先只负责"调起容器跑一段修正脚本"，见 fixPnpmInContainer()。 */
            try {
                RootfsInstaller.fixPnpmWorkspaceBeforeBoot(this);
            } catch (Throwable t) {
                Cfg.log(this, "⚠️ pnpm 配置修正失败（不影响启动）: " + t);
            }

            /* ★★★ 2026-10-20（用户要求）：移动端环境补齐。
             *
             * 做三件事（详见 MobileEnvSetup 的类注释）：
             *   ① 预建默认工作区目录
             *   ② 写**家级** patch（`$DSH_HOME/cordis.patch.yml`）补 documentsDirectory
             *      —— 官方会调 `xdg-user-dir DOCUMENTS`，而容器里没有这个命令
             *         ⇒ 首启必报「无法创建默认工作区」
             *   ③ 装内置 AGENTS.md，让模型一上来就懂环境限制
             *
             * ★ 必须**在容器启动之前**做：profile patch 要在 dsh 读取配置前就位。
             * ★ 全程 try/catch，失败只记日志 —— 报告明确要求「不要阻断启动」。 */
            try {
                MobileEnvSetup.prepare(this);
            } catch (Throwable t) {
                Cfg.log(this, "⚠️ 移动端环境初始化失败（不影响启动）: " + t);
            }

            setStatus("启动容器…");
            java.util.List<String> cmd = ProotLauncher.buildCommand(this);
            Cfg.log(this, "cmd = " + String.join(" ", cmd));

            /* ★★★ 2026-10-20：**先把 API 桥起来**，再拉起容器。
             *
             * 顺序有讲究：容器里的脚本可能一启动就调 API（比如读剪贴板），
             * 若桥还没 listen 就会 connect 失败。桥本身很轻（只 bind 一个
             * 抽象 socket），放在容器启动前没有代价。
             *
             * ★ 失败绝不影响容器启动 —— 桥挂了顶多是"没有 Android 能力"，
             *   而容器跑不起来才是致命的。 */
            try {
                ApiBridge.start(this);
            } catch (Throwable t) {
                Cfg.log(this, "⚠️ API 桥启动失败（不影响容器）: " + t);
            }

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            ProotLauncher.applyEnv(pb, this);

            FileOutputStream log = new FileOutputStream(Cfg.prootLog(this), false);
            proc = pb.start();

            // ★★★ 2026-10-19：从 **app 进程内部**自证共享存储是否真的可用。
            //
            // 为什么必须在这里做：`/storage/emulated/0` 受 FUSE 按 uid 隔离，
            // `adb shell run-as` 的 uid 不是 app 的 uid ⇒ 一定 Permission denied。
            // 那些 shell 测试结果全是假阴性，不能当判据。
            //
            // 这里直接检查 app 自己的 Files 接口，结果写进 boot.log，一目了然。
            {
                File phone = Cfg.phoneStorage(this);
                File shared = Cfg.sharedRoot(this);
                Cfg.log(this, "共享存储自检: /storage/emulated/0 exists="
                        + phone.isDirectory()
                        + " canRead=" + phone.canRead()
                        + " canList=" + (phone.list() != null ? phone.list().length + "项" : "null"));
                Cfg.log(this, "共享目录自检: " + shared.getAbsolutePath()
                        + " exists=" + shared.isDirectory()
                        + " canWrite=" + shared.canWrite());
                try {
                    File probe = new File(shared, "_probe_" + System.currentTimeMillis() + ".txt");
                    boolean ok = probe.createNewFile();
                    Cfg.log(this, "共享目录写入探测: " + ok);
                    if (ok) {
                        //noinspection ResultOfMethodCallIgnored
                        probe.delete();
                    }
                } catch (Exception pe) {
                    Cfg.log(this, "共享目录写入探测失败: " + pe);
                }

                // ★★★ 端到端验证：「容器里到底能不能读到手机文件」。
                //
                // 前面所有在 `adb shell run-as` 里做的测试都是**假阴性**
                // （FUSE 按 uid 隔离，run-as 的 uid 不是 app 的 uid）。
                // 唯一可信的做法：在 app 进程里、用 app 的 uid，去**列一遍容器内 /mnt/phone**。
                // 这块逻辑放在容器起来之后（见下面 verifyPhoneMountFromContainer）。
            }

            // 把容器输出写进 proot.log，同时盯 token 出现
            final Process p = proc;
            Thread logThread = new Thread(() -> {
                // ★★★ 2026-10-20：**同时镜像到 /sdcard/DeepseekHarness/proot.log**。
                //   理由同 Cfg.log：release 版不能 run-as，files/proot.log 读不到 ⇒
                //   容器起不来时完全没有诊断信息（这次就卡在这，只看到「容器已退出」）。
                File extLog = new File(Cfg.sharedRoot(this), "proot.log");
                try {
                    //noinspection ResultOfMethodCallIgnored
                    extLog.delete();
                } catch (Exception ignored) {
                }
                try (BufferedReader r = new BufferedReader(
                        new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = r.readLine()) != null) {
                        log.write((line + "\n").getBytes(StandardCharsets.UTF_8));
                        log.flush();
                        try (FileOutputStream ext =
                                     new FileOutputStream(extLog, true)) {
                            ext.write((line + "\n").getBytes(StandardCharsets.UTF_8));
                        } catch (Exception ignored) {
                        }
                        if (line.contains("dsh web:")) {
                            running = true;
                            setStatus("已就绪");
                            updateNotification("服务已就绪", "http://127.0.0.1:" + Cfg.PORT);
                        }
                    }
                } catch (IOException e) {
                    Log.w(TAG, "读容器输出结束: " + e.getMessage());
                }
            }, "dsh-log");
            logThread.setDaemon(true);
            logThread.start();

            // 等服务就绪（最多 180 秒：冷启动实测 48~90 秒）
            boolean ok = false;
            for (int i = 0; i < 90; i++) {
                if (probe()) { ok = true; break; }
                if (!proc.isAlive()) break;
                Thread.sleep(2000);
            }

            if (ok) {
                // ★★★ 容器就绪后，立刻做一次**容器内**的手机存储读取验证。
                //   这是唯一可信的判据：app 进程 + app uid + 真的进容器里去 ls。
                //   前面用 run-as 测的全是假阴性（FUSE 按 uid 隔离）。
                verifyPhoneMountFromContainer();

                // ★★★ token 必须从 proot.log 里现读，不能用写死的常量。
                //   踩过：Cfg.TOKEN 里那条是 Termux 时代的旧令牌，而 DSH 每次启动
                //   都会生成新 token ⇒ WebView 加载后显示 "dsh web authentication required"。
                String token = readTokenFromLog();
                if (token != null && !token.isEmpty()) {
                    readyUrl = "http://127.0.0.1:" + Cfg.PORT + "/?token=" + token;
                    Cfg.log(this, "就绪，token 已取到");

            /* ★ 2026-10-20（验收）：DSH 内核此时已经读完配置并可能建过工作区，
             *   把关键文件的实际状态打进 boot.log。
             *   为什么在这里：release 包没有任何别的通道能读到 app 私有目录里的这些文件。 */
            try {
                MobileEnvSetup.dumpState(this);
            } catch (Throwable t) {
                Cfg.log(this, "[验收] dumpState 失败（不影响运行）: " + t);
            }
                } else {
                    /* ★★★ 2026-10-20：**绝不能用空 token 加载页面**。
                       踩过（用户报「主界面已经出现了，但各项功能始终不能用」）：
                       脱敏时把 Cfg.TOKEN 改成了空串，一旦 token 读取失败就会回退到它，
                       加载出 `?token=`（空）⇒ 页面渲染出来但所有接口 401
                       ⇒ 用户看到"界面在、功能全废"，且要等好几分钟才有反应。
                       ⇒ 现在的策略：拿不到 token 就**明确报错**，不加载页面。
                         这样问题一眼可见，而不是伪装成"能用"。 */
                    readyUrl = null;
                    Cfg.log(this, "!!! 没读到 token，拒绝加载页面（避免空 token 的白屏假象）");
                    setStatus("启动异常：读不到 token，请重开 App");
                    updateNotification("启动异常", "读不到 token，请重开 App");
                    running = false;
                    proc.waitFor();
                    stopSelf();
                    return;
                }
                running = true;
                setStatus("已就绪");
                updateNotification("服务已就绪", "http://127.0.0.1:" + Cfg.PORT);
            } else {
                setStatus("启动失败，见 proot.log");
                updateNotification("启动失败", "详见 proot.log");
            }

            // 进程若退出，服务也跟着停（由用户重新点开）
            proc.waitFor();
            running = false;
            setStatus("容器已退出");
            stopSelf();

        } catch (Exception e) {
            Log.e(TAG, "启动失败", e);
            Cfg.log(this, "!!! 启动失败: " + e);
            java.io.StringWriter sw = new java.io.StringWriter();
            e.printStackTrace(new java.io.PrintWriter(sw));
            Cfg.log(this, sw.toString());
            setStatus("启动失败：" + e.getMessage());
            updateNotification("启动失败", String.valueOf(e.getMessage()));
        }
    }

    /**
     * ★★★ 端到端验证「容器内能不能读到手机文件」。
     *
     * 为什么必须在 app 进程里跑：`/storage/emulated/0` 受 FUSE 按 uid 隔离，
     * `adb shell run-as` 的 uid 不是 app 的 uid ⇒ 那些测试一定是 Permission denied，
     * 全是假阴性（这一轮为此浪费了好几轮）。
     *
     * 做法：用同一套 proot 参数（但只跑 `ls`，不启动 DSH），
     * 在 app 进程里 fork 出来，把结果写进 boot.log。
     */
    private void verifyPhoneMountFromContainer() {
        try {
            File phone = Cfg.phoneStorage(this);
            if (phone == null || !phone.isDirectory()) {
                Cfg.log(this, "[容器内验证] 跳过：手机存储不可用");
                return;
            }

            java.util.List<String> cmd = new java.util.ArrayList<>();
            cmd.add(ProotLauncher.prootPath(this));
            cmd.add("--link2symlink");
            cmd.add("--rootfs=" + Cfg.prootPathOf(Cfg.rootfs(this)));
            cmd.add("--cwd=/root");
            cmd.add("--bind=/dev");
            cmd.add("--bind=/proc");
            cmd.add("--bind=/sys");
            cmd.add("--bind=" + phone.getAbsolutePath() + ":" + Cfg.IN_PHONE);
            cmd.add("/bin/sh");
            cmd.add("-c");
            cmd.add("echo CONTAINER_LS_BEGIN; "
                    + "ls " + Cfg.IN_PHONE + " 2>&1 | head -20; "
                    + "echo ---WRITE---; "
                    // ★ 关键：验证容器内能不能**写**手机目录
                    + "D=" + Cfg.IN_PHONE + "/DeepseekHarness; mkdir -p $D 2>&1; "
                    + "echo 'container-write-'$(date +%s) > $D/_from_container.txt 2>&1 "
                    + "&& cat $D/_from_container.txt || echo WRITE_FAILED; "
                    /* ★★★ 2026-10-20：把 profile 里的 pnpm 配置文件**导出到共享目录**。
                       起因：用户在手机上装 dsh-ledger-memory 时 pnpm 报
                         「Cannot edit "minimumReleaseAgeExclude" … inline YAML value
                          that cannot be edited in place」
                       —— 要修就得先看到真实文件内容，而 /root/.dsh 只有容器内能读。
                       这里每次启动顺手导出一份（很小，几 KB），方便排查。 */
                    + "mkdir -p $D/_dbg 2>&1; "
                    + "echo ---DSHHOME---; ls -ld /root/.dsh 2>&1; ls /root/.dsh 2>&1 | head -5; "
                    + "echo ---ID---; id 2>&1; "
                    + "echo ---FINDWS---; find /root /data -maxdepth 6 -name 'pnpm-workspace.yaml' 2>/dev/null | head -10; "
                    + "cp /root/.dsh/profiles/web/pnpm-workspace.yaml $D/_dbg/ 2>&1 && echo EXPORT_WS_OK || echo EXPORT_WS_FAIL; "
                    + "cp /root/.dsh/profiles/web/package.json $D/_dbg/ 2>&1 && echo EXPORT_PKG_OK || echo EXPORT_PKG_FAIL; "
                    + "cp /root/.dsh/profiles/web/.npmrc $D/_dbg/ 2>&1 && echo EXPORT_NPMRC_OK || echo EXPORT_NPMRC_FAIL; "
                    /* ★★★ 2026-10-20：**Android 能力桥连通性自检**。
                       这是唯一可信的判据 —— 只有真的从**容器内**发起连接
                       才能证明「抽象 socket 能穿过 proot」，在 adb shell 里测全是假阴性。
                       期望输出：BRIDGE_PING=pong */
                    + "echo ---BRIDGE---; "
                    + "if command -v dsh-android >/dev/null 2>&1; then "
                    + "  echo BRIDGE_CLI_FOUND; "
                    + "  echo BRIDGE_PING=$(dsh-android ping 2>&1); "
                    + "  echo BRIDGE_BATTERY=$(dsh-android battery 2>&1); "
                    + "  echo BRIDGE_DEVICE=$(dsh-android device 2>&1); "
                    + "  echo BRIDGE_CLIPSET=$(dsh-android clipboard-set 'bridgetest-'$(date +%s) 2>&1); "
                    + "  echo BRIDGE_CLIPGET=$(dsh-android clipboard-get 2>&1); "
                    + "  echo BRIDGE_VIBRATE=$(dsh-android vibrate 120 2>&1); "
                    + "  echo BRIDGE_TOAST=$(dsh-android toast 'DSH 桥测试' 2>&1); "
                    + "  echo BRIDGE_NOTIFY=$(dsh-android notify 'DSH 桥' '通知能力测试' 2>&1); "
                    /* ★ 2026-10-20 新增能力的自检 */
                    + "  echo BRIDGE_PERMS=$(dsh-android perms 2>&1); "
                    + "  echo BRIDGE_SENSORS=$(dsh-android sensors 2>&1 | head -c 120); "
                    + "  echo BRIDGE_APPS=$(dsh-android apps 2>&1 | head -c 80); "
                    + "  echo BRIDGE_TTS=$(dsh-android tts 'test' 2>&1); "
                    + "  echo BRIDGE_LOC=$(dsh-android location 2>&1 | head -c 100); "
                    + "  echo BRIDGE_ADB=$(dsh-android adb status 2>&1); "
                    + "else echo BRIDGE_CLI_MISSING; fi; "
                    + "echo CONTAINER_LS_END");

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            ProotLauncher.applyEnv(pb, this);

            Process p = pb.start();
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line).append(" | ");
            }
            p.waitFor();

            Cfg.log(this, "[容器内验证] " + sb);
        } catch (Exception e) {
            Cfg.log(this, "[容器内验证] 失败: " + e);
        }
    }

    /** HTTP 探活：401 = 服务起来了（未认证被正确拒绝）。 */
    private boolean probe() {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL("http://127.0.0.1:" + Cfg.PORT + "/").openConnection();
            conn.setConnectTimeout(2000);
            conn.setReadTimeout(2000);
            int code = conn.getResponseCode();
            return code == 401 || code == 200 || code == 303;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * 从 files/proot.log 里读本次启动生成的 token。
     * 日志形如：`dsh web: http://127.0.0.1:3080/?token=XXXX`
     * ★ 必须现读，不能写死 —— 每次启动 token 都会变。
     *
     * ★★★ 2026-10-20 修（用户报「主界面已经出现了，但各项功能始终不能用」）：
     *   这里原来**只读一次**。而写 proot.log 的是另一个线程（dsh-log），
     *   而 {@code probe()} 只要端口能连就返回 true（401 也算"通"）——
     *   那一刻 token 那一行**可能还没落盘**。
     *   于是 readTokenFromLog() 读到空 → 返回 null → 回退到 Cfg.TOKEN
     *   （脱敏后已是空串）→ WebView 加载的 URL **没有 token**
     *   ⇒ 页面能显示，但所有接口 401 ⇒ 用户看到的就是"界面在、功能全废"。
     *
     *   ⇒ 改成**带超时的重试**：最多等 15 秒，每 200ms 重读一次。
     *     这个等待很短、且只在拿到 token 后才继续，不会拖慢正常启动。
     */
    private String readTokenFromLog() {
        File log = Cfg.prootLog(this);
        java.util.regex.Pattern p =
                java.util.regex.Pattern.compile("127\\.0\\.0\\.1:" + Cfg.PORT + "/\\?token=([A-Za-z0-9_-]+)");
        long deadline = System.currentTimeMillis() + 15000;   // 最多等 15 秒
        int tries = 0;
        while (System.currentTimeMillis() < deadline) {
            tries++;
            if (log.exists()) {
                try (BufferedReader r = new BufferedReader(new java.io.FileReader(log))) {
                    String line;
                    while ((line = r.readLine()) != null) {
                        java.util.regex.Matcher m = p.matcher(line);
                        if (m.find()) {
                            if (tries > 1) Cfg.log(this, "token 重试 " + tries + " 次后取到");
                            return m.group(1);
                        }
                    }
                } catch (Exception e) {
                    Cfg.log(this, "读 token 失败: " + e.getMessage());
                }
            }
            try { Thread.sleep(200); } catch (InterruptedException ie) { break; }
        }
        Cfg.log(this, "⚠️ 等了 " + tries + " 次（约 15 秒）仍没读到 token");
        return null;
    }

    private void setStatus(String s) {
        lastStatus = s;
        Log.i(TAG, s);
    }

    // ---------------------- 通知 ----------------------

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CH_ID,
                    getString(R.string.notif_channel_name),
                    NotificationManager.IMPORTANCE_LOW);
            ch.setDescription(getString(R.string.notif_channel_desc));
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification(String text) {
        return buildNotification(getString(R.string.notif_title), text);
    }

    private Notification buildNotification(String title, String text) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CH_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void updateNotification(String text) {
        updateNotification(getString(R.string.notif_title), text);
    }

    private void updateNotification(String title, String text) {
        nm.notify(CH_NOTIFY_ID, buildNotification(title, text));
    }

    /* ★★★ 2026-10-20：给 API 桥用的「发一条通知」。
     * 与 updateNotification 的区别：用**独立的通知 id**，
     * 这样容器内发的消息不会覆盖掉"服务已就绪"那条常驻通知。 */
    private static final int CH_API_NOTIFY_ID = 1001;
    private static int apiNotifySeq = 1001;

    static void notifyExternal(Context c, String title, String body) {
        try {
            android.app.NotificationManager m = (android.app.NotificationManager)
                    c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (m == null) return;
            ensureApiChannel(c, m);
            int id = ++apiNotifySeq;
            android.app.Notification n = new NotificationCompat.Builder(c, CH_API)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle(title == null || title.isEmpty() ? "DSH" : title)
                    .setContentText(body == null ? "" : body)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(body == null ? "" : body))
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                    .setAutoCancel(true)
                    .build();
            m.notify(id, n);
        } catch (Throwable t) {
            android.util.Log.w("DshNotify", "notifyExternal 失败: " + t);
        }
    }

    private static final String CH_API = "dsh_api_msg";

    private static void ensureApiChannel(Context c, android.app.NotificationManager m) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.app.NotificationChannel ch = new android.app.NotificationChannel(
                    CH_API, "来自容器内的消息", android.app.NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("DSH 在容器里调用通知能力时使用");
            m.createNotificationChannel(ch);
        }
    }
}
