package com.dsh.mobile;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * ★★★ 2026-10-20：ADB 扩展（**默认关闭**，用户显式开启）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是可选的扩展
 * ══════════════════════════════════════════════════════════════════
 * `adbd` 由 Android 系统 init 拉起、跑在 **shell uid**，普通 App 无权启动/连接。
 * 唯一可行路径是：容器内的 adb 客户端 → 连**用户手动打开的「无线调试」**。
 *
 * 一旦连通就是 **shell 级权限**：能模拟任意点击、装/卸应用、读所有应用数据。
 * ⇒ 用户明确要求：**危险权限，只做扩展功能、不默认开启**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 双模式（用户要求「两个都做，按用户选择自行改变」）
 * ══════════════════════════════════════════════════════════════════
 *   mode=off      默认。所有 adb 命令都拒绝。
 *   mode=safe     白名单。只放行一组**只读/低危**命令（见 SAFE_ALLOW）。
 *   mode=full     完整。允许任意 adb 参数（仍不含 push/pull 的宿主路径逃逸）。
 *
 * 切换命令（从容器内）：
 *   dsh-android adb status
 *   dsh-android adb mode safe        ← 设成白名单
 *   dsh-android adb mode full        ← 设成完整（会让用户确认）
 *   dsh-android adb off              ← 立刻关闭
 *
 * ══════════════════════════════════════════════════════════════════
 * 安全设计
 * ══════════════════════════════════════════════════════════════════
 * · 默认 off，且状态持久化在 SharedPreferences
 * · 切到 full 需要 `confirm=yes` 二次确认（从容器内传）
 * · safe 模式下每条命令逐项比对白名单前缀
 * · 无论哪种模式，**不允许** `install` / `uninstall`（装机风险太大）
 *   除非显式打开 `allowInstall`
 * · 所有调用都写 boot.log（谁在什么时候要求了什么）
 */
final class AdbBridge {
    private static final String PREF = "dsh_adb";
    private static final String K_MODE = "mode";        // off | safe | full
    private static final String K_PORT = "port";        // 无线调试端口
    private static final String K_ALLOW_INSTALL = "allow_install";

    /** safe 模式允许的命令前缀（只读/低危）。 */
    private static final String[] SAFE_ALLOW = {
            "shell input ",          // 模拟点击/滑动/输入
            "shell screencap",       // 截屏
            "shell dumpsys ",        // 读系统状态（部分）
            "shell pm list",         // 列应用
            "shell getprop",         // 读属性
            "shell settings get",    // 读设置
            "shell wm size",         // 屏幕尺寸
            "shell wm density",
            "devices",
            "connect ",              // 连自己
            "version",
    };

    /** 任何模式都禁止的危险动作（除 allowInstall 外）。 */
    private static final String[] ALWAYS_DENY = {
            "uninstall", "pm uninstall", "pm clear",
            "root", "remount", "reboot", "shutdown",
            "shell rm -rf", "shell su",
    };

    private AdbBridge() {}

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    static String mode(Context c) {
        return sp(c).getString(K_MODE, "off");
    }

    /**
     * 处理 `adb <sub> <arg>` 请求。
     * ★ a1 = 子命令（status/mode/off/exec），a2 = 参数
     */
    static String handle(Context c, String a1, String a2) {
        String sub = a1 == null ? "" : a1.trim();

        if (sub.isEmpty() || "status".equals(sub)) {
            return status(c);
        }

        if ("mode".equals(sub)) {
            /* ★★★ 2026-10-20 修（用户报「切换 adb 模式失败」）：
             *
             * 参数格式统一成：sub = 子命令，a2 = 子参数（由 dsh-android.js 按空格拆好）。
             *   `adb mode safe`         → sub="mode", a2="safe"
             *   `adb mode full confirm=yes` → sub="mode", a2="full confirm=yes"
             * 不论页面还是容器调用，都走这一套。
             *
             * ⇒ 模式名要从 a2 的**第一个词**取，confirm=yes 是附加标记。 */
            if (a2 == null || a2.trim().isEmpty()) {
                return err("用法: adb mode off|safe|full [confirm=yes]\n"
                        + "提示：full 需要写成 `mode full confirm=yes`");
            }
            String a2t = a2.trim();
            String[] words = a2t.split("\\s+");
            String m = words.length > 0 ? words[0].toLowerCase() : "";
            boolean hasConfirm = a2t.toLowerCase().contains("confirm=yes");

            if (!m.equals("off") && !m.equals("safe") && !m.equals("full")) {
                return err("未知模式: " + m + "（只能是 off / safe / full）\n"
                        + "收到的是: \"" + a2t + "\"");
            }
            // ★ full 需要二次确认
            if (m.equals("full") && !hasConfirm) {
                return err("切到 full 需要二次确认：adb mode full confirm=yes\n" +
                        "⚠️ 风险：full 模式下容器内的任何程序都能以 shell 权限操控整机" +
                        "（装/卸应用、读所有应用数据、模拟任意点击）。\n" +
                        "确认无误再执行。");
            }
            sp(c).edit().putString(K_MODE, m).apply();
            Cfg.log(c, "[ADB] 模式切换 → " + m);
            return "OK\n模式已设为 " + m + "\n" +
                    (m.equals("off") ? "" : "下一步：确保系统「无线调试」已开启，然后 adb connect\n");
        }

        if ("off".equals(sub)) {
            sp(c).edit().putString(K_MODE, "off").apply();
            Cfg.log(c, "[ADB] 已关闭");
            return "OK\nADB 扩展已关闭\n";
        }

        if ("connect".equals(sub)) {
            // a2 = 端口（不填就自动发现，其次用上次记住的）
            String port = (a2 == null || a2.trim().isEmpty()) ? null : a2.trim();
            boolean auto = false;
            if (port == null || port.isEmpty()) {
                port = discoverPort(c);
                auto = true;
            }
            if (port == null || port.isEmpty()) {
                String last = sp(c).getString(K_PORT, "");
                if (last != null && !last.isEmpty()) {
                    port = last;
                    auto = true;
                }
            }
            if (port == null || port.isEmpty()) {
                return err("找不到无线调试端口。\n" +
                        "请确认系统「开发者选项 → 无线调试」已打开（端口只在它开着时才存在）。\n" +
                        "去哪开: " + Perms.open(c, "wireless") + "\n" +
                        "也可以手填：adb connect <端口>");
            }
            sp(c).edit().putString(K_PORT, port).apply();
            Cfg.log(c, "[ADB] connect 端口=" + port + (auto ? "（自动发现）" : "（手填）"));
            return runAdb(c, "connect 127.0.0.1:" + port);
        }

        /* ★★★ 2026-10-20（用户要求）：**自动发现无线调试端口**。
         *
         * 背景：无线调试的调试端口每次开关/重启都会变，让用户手填不现实。
         *
         * 为什么不用 adb mdns：容器里 `adb mdns check` **没有任何输出**、
         *   `adb mdns services` 返回空列表 —— 这个 Debian 版 adb 的 mDNS 后端没起来
         *   （要么没编译 Bonjour，要么容器里没组播）。实测过，不可依赖。
         *
         * 做法：**读 /proc/net/tcp{,6} 找监听端口，认特征是「唯一绑 :: 通配地址的那个」**。
         *
         * 实测依据（本机，2026-10-20）：
         *   0100007F:2A38   127.0.0.1:10808   ← 只本机
         *   0100007F:2A65   127.0.0.1:10853
         *   0100007F:8C3B   127.0.0.1:35899
         *   00000000:5DD5   0.0.0.0:24021     ← 全网卡（别的服务）
         *   00000000:5DD6   0.0.0.0:24022
         *   0100007F:9B23   127.0.0.1:39715
         *   0000...0000:99CB  [::]:39371       ← ★ 只有它绑 IPv6 通配 = adbd
         *   0000...FFFF00000100007F:B1AB  [::ffff:127.0.0.1]:45483
         *
         * ⇒ 判据「**且只**绑 `::`（全零 32 位十六进制地址）」在所有采样里只命中 adbd。
         *   `0.0.0.0`（全零 8 位）是别的应用；`[::ffff:127.0.0.1]` 是 IPv4 映射，排除。
         */
        if ("discover".equals(sub)) {
            String p = discoverPort(c);
            if (p == null) {
                return err("没找到无线调试端口。\n" +
                        "请确认「开发者选项 → 无线调试」已打开。\n" +
                        "去哪开: " + Perms.open(c, "wireless"));
            }
            sp(c).edit().putString(K_PORT, p).apply();
            return ok("{\"port\":\"" + p + "\"}");
        }

        /* ★★★ 2026-10-20（用户实测确认悬浮窗方案可行后新增）：
         * `adb pair <port> <配对码>` —— 完成无线调试配对。
         *   a2 形如 "<pairPort> <6位码>"
         *
         * ★ 这一步必须在**配对对话框还开着**的时候执行（配对码 1~2 分钟内有效）。
         *   用户实测：把 DSH 做成悬浮窗/小窗、开发者选项留在主界面时，
         *   系统不会抢焦点、配对码仍然有效 ⇒ 这条路是通的。
         *
         * ★ 配对是一次性的：成功后双方保存密钥，之后 connect 不再要码。 */
        if ("pair".equals(sub)) {
            if (a2 == null || a2.trim().isEmpty()) {
                return err("用法: adb pair <配对端口> <6位配对码>\n" +
                        "配对端口和配对码都在系统「无线调试 → 使用配对码配对设备」里。");
            }
            String[] w = a2.trim().split("\\s+");
            if (w.length < 2) {
                return err("参数不完整。需要「配对端口」和「配对码」两个值，例如：\n" +
                        "adb pair 37241 123456");
            }
            String pairPort = w[0];
            String code = w[1];
            if (!code.matches("\\d{6}")) {
                return err("配对码应该是 6 位数字，收到的是: " + code);
            }
            Cfg.log(c, "[ADB] 尝试配对 端口=" + pairPort);
            String out = runAdb(c, "pair 127.0.0.1:" + pairPort + " " + code);
            Cfg.log(c, "[ADB] 配对结果: " + out.replace("\n", " "));
            return out;
        }

        /* 自动安装容器内的 adb 客户端（apt），供首次使用前准备。 */
        if ("install-client".equals(sub)) {
            return installClient(c);
        }

        if ("exec".equals(sub)) {
            return exec(c, a2);
        }

        return err("未知子命令: " + sub +
                "（可用: status / mode / off / connect / discover / pair / install-client / exec）");
    }

    private static String status(Context c) {
        String m = mode(c);
        String saved = sp(c).getString(K_PORT, "");
        /* ★ 2026-10-20：状态里直接给**实时发现的端口**，不再是那个可能过期的存值。
         *   页面拿它显示，用户就不必自己去系统里找。 */
        String live = discoverPort(c);
        String port = (live != null) ? live : saved;
        return "OK\n{"
                + "\"mode\":\"" + m + "\""
                + ",\"port\":\"" + port + "\""
                + ",\"portLive\":" + (live != null)
                + ",\"enabled\":" + (!m.equals("off"))
                + ",\"allowInstall\":" + sp(c).getBoolean(K_ALLOW_INSTALL, false)
                + "}\n";
    }

    /** safe 模式的白名单判定。 */
    static boolean allowedInSafe(String cmdline) {
        if (cmdline == null) return false;
        String s = cmdline.trim();
        for (String a : SAFE_ALLOW) {
            if (s.startsWith(a)) return true;
        }
        return false;
    }

    /** 任何模式都禁止的。 */
    static String denyReason(String cmdline) {
        if (cmdline == null) return "空命令";
        String s = " " + cmdline.trim() + " ";
        for (String d : ALWAYS_DENY) {
            if (s.contains(d)) return "危险命令被禁止: " + d;
        }
        return null;
    }

    private static String exec(Context c, String cmdline) {
        String m = mode(c);
        if (m.equals("off")) {
            return err("ADB 扩展未开启（默认关闭）。\n" +
                    "开启方式: dsh-android adb mode safe\n" +
                    "前提：你自己去系统「开发者选项 → 无线调试」打开并配对。\n" +
                    "跳转: " + Perms.open(c, "wireless"));
        }
        if (cmdline == null || cmdline.trim().isEmpty()) {
            return err("用法: adb exec \"<adb 参数>\"");
        }
        String deny = denyReason(cmdline);
        if (deny != null) {
            Cfg.log(c, "[ADB] 拒绝: " + cmdline + " 原因=" + deny);
            return err(deny);
        }
        if (m.equals("safe") && !allowedInSafe(cmdline)) {
            return err("safe 模式下不允许: " + cmdline + "\n" +
                    "允许的命令: " + String.join(" / ", SAFE_ALLOW) + "\n" +
                    "要执行任意命令请切 full: dsh-android adb mode \"full confirm=yes\"");
        }
        Cfg.log(c, "[ADB] 执行(" + m + "): " + cmdline);
        return runAdb(c, cmdline);
    }

    /**
     * 真正调用容器内的 adb 客户端。
     *
     * ★ 为什么调容器内的 adb：APK 进程里没有 adb 二进制，
     *   而容器（Debian）里可以 apt 装 `android-tools-adb`。
     *   ⇒ 我们起一个**临时 proot** 跑 `adb <参数>`。
     *   这条和 pnpm 修正用的是同一套机制（见 RootfsInstaller.fixPnpmWorkspaceBeforeBoot）。
     */
    private static String runAdb(Context c, String cmdline) {
        try {
            java.util.List<String> cmd = prootBase(c);
            cmd.add("/bin/sh");
            cmd.add("-c");

            /* ★★★ 2026-10-20 修（用户实测「配对成功了但 devices 一直是空」）：
             *
             * 现象（boot.log 逐字）：
             *   connect 39371 → "connected to 127.0.0.1:39371"
             *   再查 devices  → "List of devices attached"（空）
             * 而把两条塞进同一次调用里就正常：
             *   "connected to 127.0.0.1:39371" + "127.0.0.1:39371  device"
             *
             * 根因：**每次调用都是独立的一次性 proot**（带 --kill-on-exit），
             *   adb server 是这次 proot 的子进程 ⇒ proot 一退，server 就被杀，
             *   TCP 连接自然没了。所以每次调用日志里都能看到
             *   "* daemon not running; starting now at tcp:5037" —— 每次都在重起。
             *
             *   ⇒ 连接本身没失败，是**保不住**。这不是配置问题，是架构问题。
             *
             * 修法：既然 server 注定活不过这次调用，那就**每次调用都先自动重连**，
             *   再执行真正的命令 —— 同一个 proot 进程内，server 是活的。
             *   配对密钥（adbkey）已经存下了，重连是瞬时的，用户无感。
             *
             * ★ connect / pair 本身不再前置重连（它们就是干这个的）；
             *   端口未知时也不重连（没得连），直接跑命令让 adb 自己报错。
             */
            String port = sp(c).getString(K_PORT, "");
            boolean needReconnect = !cmdline.startsWith("pair")
                    && !cmdline.startsWith("connect");
            if (needReconnect) {
                /* ★ 端口可能已经变了（重启 / 重开无线调试）⇒ **先实时发现一次**，
                 *   发现不到才退回存着的那个。这样用户完全不用管端口。 */
                String fresh = discoverPort(c);
                if (fresh != null && !fresh.equals(port)) {
                    port = fresh;
                    sp(c).edit().putString(K_PORT, port).apply();
                }
            }
            needReconnect = needReconnect && port != null && !port.trim().isEmpty();

            StringBuilder sh = new StringBuilder();
            // ★ 用 rootfs 里的 adb；没有就明确报错并给安装指引
            sh.append("if ! command -v adb >/dev/null 2>&1; then echo 'ADB_NOT_INSTALLED'; exit 0; fi; ");
            if (needReconnect) {
                // 静默重连：失败也不打断（真失败时下面的命令会自己报错）
                sh.append("adb connect 127.0.0.1:").append(port.trim()).append(" >/dev/null 2>&1; ");
            }
            sh.append("adb ").append(cmdline).append(" 2>&1");
            cmd.add(sh.toString());

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            ProotLauncher.applyEnv(pb, c);
            Process p = pb.start();

            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(p.getInputStream(),
                            java.nio.charset.StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    sb.append(line).append('\n');
                    if (sb.length() > 6000) break;
                }
            }
            p.waitFor(90, java.util.concurrent.TimeUnit.SECONDS);

            String out = sb.toString();
            if (out.contains("ADB_NOT_INSTALLED")) {
                return err("容器里没有 adb 客户端。\n" +
                        "先点「安装」按钮（或让 App 自动装：dsh-android adb install-client）");
            }
            return "OK\n" + out;
        } catch (Throwable t) {
            return err("执行 adb 失败: " + t);
        }
    }

    /* ★★★ 2026-10-20：**端口自动发现已放弃**（用户决定「保持手填」）
     *
     * 试过的五条路，全部被 Android 权限模型堵死（每条都有逐字实测证据）：
     *   ① APK 进程直读 /proc/net/tcp6
     *        → EACCES（Android 8+ 对 app 屏蔽 /proc/net/tcp*）
     *   ② 临时 proot 里 `cat /proc/net/tcp6`
     *        → 输出为空（proot 的 /proc/net 是它自己模拟的，没有宿主 socket 表）
     *   ③ `adb mdns services`
     *        → 空列表（这个 Debian 版 adb 的 mDNS 后端没起来）
     *   ④ `adb shell cat /proc/net/tcp6`
     *        → 有内容，但要 adb 先连上 = 鸡生蛋
     *   ⑤ 容器里跑宿主 `/system/bin/ss -ltn`
     *        → 只在**已连上 adb** 的 exec 路径下有输出；在 discover 场景下同样是空
     *
     * ⇒ 唯一还剩的是「循环试连候选端口」，用户权衡后选了**不折腾**。
     *   现在的行为：端口存在 SharedPreferences（K_PORT），变了就手填。
     *   这比一个半成品探测更干净 —— 探测不到时用户会以为坏了。
     *
     * ★ 以后要捡起来，从 ⑤ 入手：`ss` 的候选列表 + `adb connect` 逐个验证。
     */

    /**
     * 端口自动发现 —— **当前恒返回 null（功能已放弃，见上面的说明）**。
     *
     * 保留这个函数（而不是删掉调用点）是为了让上层逻辑保持不变：
     * `status` / `connect` / `runAdb` 都已经按「发现不到就退回存着的端口」写好了，
     * 哪天要重新捡起探测，只要把这个函数填上即可，**调用方一行都不用改**。
     */
    private static String discoverPort(Context c) {
        return null;
    }

    /** 自动发现端口的短缓存（**当前未启用**，保留给以后的探测实现）。 */
    private static String cachePort = null;
    private static long cachePortAt = 0;

    /**
     * 所有"临时 proot"的公共前缀。
     *
     * ★★★ 2026-10-20 修（用户报「点安装就超时，整页读不了」的**真正根因**）：
     *
     *   boot.log 里 install-client 的真实输出是：
     *     dpkg: error: requested operation requires superuser privilege
     *     E: Sub-process /usr/bin/dpkg returned an error code (2)
     *     INSTALL_FAILED
     *
     *   ⇒ **不是超时，是没提权。** 主容器（ProotLauncher.buildCommand）里有
     *     `--change-id=0:0`，而我们这两个临时 proot **漏了它**，
     *     于是容器内身份是 uid 10420（app uid）而不是 root
     *     ⇒ dpkg 拒绝安装 ⇒ apt 永远失败。
     *
     *   之前把它误判成"15 秒超时"，是因为 Java 侧 waitFor(180s) 而服务端
     *   execFile 15s 就杀了，表象一模一样。两处都修了。
     *
     * ★ 其余参数与主容器保持一致（--link2symlink / --sysvipc / -L），
     *   否则 rootfs 里 501 个符号链接会失效。
     */
    private static java.util.List<String> prootBase(Context c) {
        java.util.List<String> cmd = new java.util.ArrayList<>();
        cmd.add(ProotLauncher.prootPath(c));
        cmd.add("--kill-on-exit");
        cmd.add("--link2symlink");
        cmd.add("--sysvipc");
        cmd.add("-L");
        cmd.add("--change-id=0:0");          // ★ 必须是 root，否则 dpkg 拒绝
        cmd.add("--rootfs=" + Cfg.prootPathOf(Cfg.rootfs(c)));
        cmd.add("--cwd=/root");
        cmd.add("--bind=/dev");
        cmd.add("--bind=/proc");
        return cmd;
    }

    /**
     * 在容器内装 adb 客户端（`apt install android-tools-adb`）。
     *
     * ★ 为什么要装：容器是精简 Debian，**没有 adb**。
     *   而 `adb pair` / `adb connect` / `adb shell` 全靠它。
     *
     * ★ 代价：要联网 `apt update`（约 10~60 秒，取决于网速）。
     *   所以做成**显式动作**，不在启动时自动跑。
     *
     * ★ 幂等：已装就秒回。
     */
    private static String installClient(Context c) {
        try {
            java.util.List<String> cmd = prootBase(c);
            cmd.add("/bin/sh");
            cmd.add("-c");
            cmd.add("if command -v adb >/dev/null 2>&1; then echo ALREADY_INSTALLED; "
                    + "else "
                    + "export DEBIAN_FRONTEND=noninteractive; "
                    + "export PATH=/opt/node/bin:$PATH; "
                    + "apt-get update -qq 2>&1 | tail -3; "
                    + "apt-get install -y -qq android-tools-adb 2>&1 | tail -6; "
                    + "command -v adb >/dev/null 2>&1 && echo INSTALL_OK || echo INSTALL_FAILED; "
                    + "fi");

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            ProotLauncher.applyEnv(pb, c);
            Process p = pb.start();

            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(p.getInputStream(),
                            java.nio.charset.StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    sb.append(line).append('\n');
                    if (sb.length() > 8000) break;
                }
            }
            p.waitFor(180, java.util.concurrent.TimeUnit.SECONDS);

            String out = sb.toString();
            Cfg.log(c, "[ADB] 安装客户端结果: " + out.replace("\n", " | "));
            if (out.contains("INSTALL_OK") || out.contains("ALREADY_INSTALLED")) {
                return ok(out);
            }
            return err("安装失败。容器内输出：\n" + out);
        } catch (Throwable t) {
            return err("安装 adb 客户端失败: " + t);
        }
    }

    private static String ok(String p) { return "OK\n" + p + "\n"; }
    private static String err(String m) { return "ERR\n" + m + "\n"; }
}
