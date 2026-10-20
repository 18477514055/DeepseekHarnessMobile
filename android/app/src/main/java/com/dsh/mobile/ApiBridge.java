package com.dsh.mobile;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.Log;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * ★★★ 2026-10-20：Android 能力桥（给容器内的 DSH 用）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════════════
 * PRoot 是**单向囚笼**：容器内看不到宿主应用数据，也调不到任何 Android API
 * （`am`/`content`/`pm`/`settings` 全不存在，勘察报告 §2.5 实测）。
 * 结果我们的「手机端 DSH」其实是一台**不能剪贴板、不能通知、不能震动**的
 * Linux 机器 —— 名不副实。Termux 靠 Termux:API 填这个缺口。
 *
 * ══════════════════════════════════════════════════════════════════
 * 机制：抽象命名空间 Unix socket（照 Termux:API）
 * ══════════════════════════════════════════════════════════════════
 * Termux 的 termux-api.c 里：
 *     memcpy(listen_addr.sun_path + 1, NAME, ...);   // 首字节留 \0
 * `sun_path[0] == '\0'` ⇒ **抽象命名空间**：内核按名字管理，
 * **不落磁盘、没有路径、不经 FUSE、不需要文件权限**。
 *
 * ★★ 关键：**proot 只拦文件路径类 syscall，不管 socket**。
 *    所以容器内进程能直接 connect 出来，**连 bind mount 都不用加**。
 *
 * ★ 我们比 Termux 少一步：它还要用 `am broadcast` 把 socket 地址传给 App，
 *   而我们的容器里没有 `am`。⇒ 地址**写死**，省掉协商。
 *
 * Android 侧对应类：`android.net.LocalServerSocket`（就是 AF_UNIX，
 * 名字不以 '@' 开头即抽象命名空间）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 协议（极简，一问一答）
 * ══════════════════════════════════════════════════════════════════
 * 请求： `<cmd> [arg]...\n`
 *       参数里的空格用 `\u0001` 转义（避免引号地狱）
 * 响应： `OK\n<payload>\n`  或  `ERR\n<message>\n`
 *       然后服务端关连接（约定：一次连接只处理一个请求）
 *
 * ══════════════════════════════════════════════════════════════════
 * 安全
 * ══════════════════════════════════════════════════════════════════
 * 抽象 socket 在**同 uid** 内可见；别的 App 拿不到（它们的 uid 不同）。
 * 另外只走本机 AF_UNIX，不开 TCP，不引入网络面。
 * ★ 不做额外鉴权的原因：能连上这个 socket 的，已经证明它跑在本 App 的
 *   uid 下 —— 那本来就有权读写本 App 全部数据。
 */
final class ApiBridge {
    private static final String TAG = "DshApiBridge";

    /** 抽象 socket 名（**不带** \0）。
     *
     * ★★★ 2026-10-20 踩过：一开始这里写成 "\0dsh.mobile.api"，
     *   结果容器内连不上（ECONNREFUSED）。
     *   原因：`android.net.LocalServerSocket` **自己**会把「不以 / 开头的名字」
     *   按**抽象命名空间**处理（内部把 sun_path[0] 置 0 并把名字拷到 +1），
     *   我们再手动加一个 \0 ⇒ 实际名字变成 "\0\0dsh.mobile.api"，
     *   与 Node 侧连的 "\0dsh.mobile.api" 差一个字节 ⇒ 永远连不上。
     *
     * ⇒ **Android 侧传纯名字，Node 侧加 \0**（Node 用 \0 前缀表示抽象）。 */
    static final String SOCKET_NAME = "dsh.mobile.api";

    /** 参数分隔符：用 \u0001 而不是空格，避开 shell 引号问题。 */
    static final String SEP = "\u0001";

    private static LocalServerSocket server;
    private static Thread acceptThread;
    private static volatile boolean running = false;
    private static Context appCtx;
    private static final Handler UI = new Handler(Looper.getMainLooper());

    private ApiBridge() {}

    static synchronized void start(Context c) {
        if (running) return;
        appCtx = c.getApplicationContext();
        try {
            server = new LocalServerSocket(SOCKET_NAME);
            running = true;
            acceptThread = new Thread(ApiBridge::acceptLoop, "dsh-api-bridge");
            acceptThread.setDaemon(true);
            acceptThread.start();
            Cfg.log(c, "API 桥已启动 socket=" + printableName());
        } catch (Throwable t) {
            running = false;
            Cfg.log(c, "⚠️ API 桥启动失败: " + t);
        }
    }

    static synchronized void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (Throwable ignored) { }
        server = null;
    }

    /** 抽象名字在日志里显示成 @name（Linux 的惯例写法）。 */
    static String printableName() { return "@" + SOCKET_NAME; }

    // ------------------------------------------------------------------

    private static void acceptLoop() {
        while (running) {
            LocalSocket sock = null;
            try {
                sock = server.accept();
                handleConn(sock);
            } catch (Throwable t) {
                if (running) {
                    // 单次连接出错不影响服务；睡一下避免忙等
                    try { Thread.sleep(200); } catch (InterruptedException ignored) { }
                }
            } finally {
                if (sock != null) try { sock.close(); } catch (Throwable ignored) { }
            }
        }
    }

    private static void handleConn(LocalSocket sock) {
        try {
            BufferedReader in = new BufferedReader(new InputStreamReader(
                    sock.getInputStream(), StandardCharsets.UTF_8));
            OutputStream out = sock.getOutputStream();

            String line = in.readLine();
            if (line == null) return;
            String resp = dispatch(line);
            out.write(resp.getBytes(StandardCharsets.UTF_8));
            out.flush();
        } catch (Throwable t) {
            Log.w(TAG, "处理连接失败: " + t);
        }
    }

    /** 解析一条请求并返回完整响应文本。 */
    private static String dispatch(String raw) {
        try {
            String[] parts = raw.split(SEP, -1);
            String cmd = parts.length > 0 ? parts[0].trim() : "";
            String a1 = parts.length > 1 ? parts[1] : "";
            String a2 = parts.length > 2 ? parts[2] : "";

            switch (cmd) {
                case "ping":
                    return ok("pong");

                case "clipboard.get": {
                    String v = getClipboard();
                    return ok(v == null ? "" : v);
                }
                case "clipboard.set": {
                    setClipboard(a1);
                    return ok("ok");
                }

                case "toast": {
                    final String msg = a1;
                    UI.post(() -> {
                        try { Toast.makeText(appCtx, msg, Toast.LENGTH_SHORT).show(); }
                        catch (Throwable ignored) { }
                    });
                    return ok("ok");
                }

                case "notify": {
                    // a1=标题 a2=正文
                    try {
                        DshService.notifyExternal(appCtx, a1, a2);
                        return ok("ok");
                    } catch (Throwable t) {
                        return err("notify 失败: " + t);
                    }
                }

                case "vibrate": {
                    long ms = 200;
                    try { if (!a1.isEmpty()) ms = Long.parseLong(a1.trim()); } catch (Throwable ignored) { }
                    vibrate(ms);
                    return ok("ok");
                }

                case "battery": {
                    return ok(batteryJson());
                }

                case "device": {
                    return ok(deviceJson());
                }

                case "openurl": {
                    try {
                        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(a1));
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        appCtx.startActivity(i);
                        return ok("ok");
                    } catch (Throwable t) {
                        return err("打开失败: " + t);
                    }
                }

                case "share": {
                    // a1=文本内容
                    try {
                        Intent i = new Intent(Intent.ACTION_SEND);
                        i.setType("text/plain");
                        i.putExtra(Intent.EXTRA_TEXT, a1);
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        appCtx.startActivity(Intent.createChooser(i, "分享")
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                        return ok("ok");
                    } catch (Throwable t) {
                        return err("分享失败: " + t);
                    }
                }

                /* ============ 2026-10-20 新增：不用 ADB 的能力 ============ */

                case "perms": {
                    // 当前权限快照
                    return ok(Perms.snapshot(appCtx));
                }

                case "openperms": {
                    /* ★ 权限引导：直接跳到**对应那一页**，不让用户自己找。 */
                    String used = Perms.open(appCtx, a1);
                    return ok(used);
                }

                case "tts": {
                    /* 文字转语音（朗读一段话）。a1=要读的文本 */
                    if (a1 == null || a1.isEmpty()) return err("tts 需要文本参数");
                    return Tts.speak(appCtx, a1);
                }

                case "tts.stop": {
                    Tts.stop();
                    return ok("ok");
                }

                case "camera": {
                    /* 拍照：拉起系统相机，结果存到 App 私有目录，返回路径。
                     * ★ 需要 CAMERA 权限（部分设备不申请也能用系统相机，但取景会受限）。 */
                    if (!Perms.granted(appCtx, android.Manifest.permission.CAMERA)) {
                        return err("没有相机权限。" + Perms.hintFor("camera"));
                    }
                    return err("camera 需要界面前台，暂不支持无界面调用；" +
                            "请用 gallery 选图，或在 App 内点按触发");
                }

                case "gallery": {
                    /* 相册选图：拉起系统文件选择器（SAF），不需要读存储权限。
                     * ★ 这条最适合"把图片交给视觉模型"的场景。 */
                    return err("gallery 需要界面前台，暂不支持无界面调用");
                }

                case "location": {
                    /* 粗定位（不需要网络，靠 GPS/基站）。
                     * ★ 需要定位权限；没权限时明确告知怎么开。 */
                    if (!Perms.granted(appCtx, android.Manifest.permission.ACCESS_FINE_LOCATION)
                            && !Perms.granted(appCtx, android.Manifest.permission.ACCESS_COARSE_LOCATION)) {
                        return err("没有定位权限。" + Perms.hintFor("location"));
                    }
                    return LocationInfo.get(appCtx);
                }

                case "sensors": {
                    return Sensors.list(appCtx);
                }

                case "apps": {
                    /* 列出已安装应用（用户可见的）。a1=可选过滤关键字 */
                    return Apps.list(appCtx, a1);
                }

                case "adb": {
                    /* ADB 扩展：默认关闭，需用户显式开启。见 AdbBridge。 */
                    return AdbBridge.handle(appCtx, a1, a2);
                }

                default:
                    return err("未知命令: " + cmd);
            }
        } catch (Throwable t) {
            return err("异常: " + t);
        }
    }

    // ---------------------- 具体能力 ----------------------

    private static String getClipboard() {
        try {
            ClipboardManager cm = (ClipboardManager)
                    appCtx.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip()) return "";
            ClipData cd = cm.getPrimaryClip();
            if (cd == null || cd.getItemCount() == 0) return "";
            CharSequence t = cd.getItemAt(0).coerceToText(appCtx);
            return t == null ? "" : t.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    private static void setClipboard(String s) {
        try {
            ClipboardManager cm = (ClipboardManager)
                    appCtx.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("dsh", s));
        } catch (Throwable ignored) { }
    }

    private static void vibrate(long ms) {
        try {
            Vibrator v = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager vm = (VibratorManager)
                        appCtx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                if (vm != null) v = vm.getDefaultVibrator();
            } else {
                v = (Vibrator) appCtx.getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (v == null || !v.hasVibrator()) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                //noinspection deprecation
                v.vibrate(ms);
            }
        } catch (Throwable ignored) { }
    }

    private static String batteryJson() {
        try {
            BatteryManager bm = (BatteryManager)
                    appCtx.getSystemService(Context.BATTERY_SERVICE);
            int pct = bm == null ? -1 : bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            Intent it = appCtx.registerReceiver(null,
                    new android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            String status = "unknown", plugged = "no";
            if (it != null) {
                int st = it.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                if (st == BatteryManager.BATTERY_STATUS_CHARGING) status = "charging";
                else if (st == BatteryManager.BATTERY_STATUS_FULL) status = "full";
                else if (st == BatteryManager.BATTERY_STATUS_DISCHARGING) status = "discharging";
                int pl = it.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
                plugged = pl == 0 ? "no" : (pl == BatteryManager.BATTERY_PLUGGED_AC ? "ac"
                        : pl == BatteryManager.BATTERY_PLUGGED_USB ? "usb" : "wireless");
            }
            return "{\"level\":" + pct + ",\"status\":\"" + status
                    + "\",\"plugged\":\"" + plugged + "\"}";
        } catch (Throwable t) {
            return "{\"error\":\"" + t + "\"}";
        }
    }

    private static String deviceJson() {
        try {
            String model = Build.MODEL == null ? "" : Build.MODEL;
            return "{\"model\":\"" + esc(model) + "\""
                    + ",\"brand\":\"" + esc(String.valueOf(Build.BRAND)) + "\""
                    + ",\"sdk\":" + Build.VERSION.SDK_INT
                    + ",\"abi\":\"" + esc(Build.SUPPORTED_ABIS[0]) + "\"}";
        } catch (Throwable t) {
            return "{\"error\":\"" + t + "\"}";
        }
    }

    private static String esc(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static String ok(String payload) { return "OK\n" + payload + "\n"; }
    private static String err(String msg) { return "ERR\n" + msg + "\n"; }
}
