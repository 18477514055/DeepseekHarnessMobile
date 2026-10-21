package com.dsh.mobile;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * ★★★ 2026-10-21：独立终端的 Java 侧会话管理。
 *
 * <h3>它是什么</h3>
 * 起一个**独立的 proot 实例**（不是 DSH 那个），在里面跑
 * {@code node /sdcard/.../pty-bridge.js}，由 node-pty 创建真 PTY 并 fork bash。
 * 这样 **DSH 起不来也照样有终端** —— DSH 只是容器里的一个程序。
 *
 * <h3>为什么不自己 openpty</h3>
 * 本机**没装 NDK**（{@code %LOCALAPPDATA%\Android\Sdk\ndk} 不存在），
 * 走不了 JNI 直接调 {@code posix_openpt}。而 `script -c` 虽然能分配 PTY
 * （实测 stdio 是 tty、{@code stty size} 可用），却**改不了窗口尺寸**
 * （没有 TIOCSWINSZ 通道），vim/tmux 会按 80x24 画、在手机上完全错位。
 * ⇒ 用容器自带的 node + node-pty 是最省事且**能真正 resize** 的路。
 *
 * <h3>与 Java↔js 的分工</h3>
 * <pre>
 *   WebView(xterm.js)  ──prompt──▶  TerminalActivity.onJsPrompt
 *                                        │
 *                                   PtySession.write()
 *                                        │
 *                                   proc stdin（一行一个 JSON）
 *                                        │
 *                                   pty-bridge.js ──▶ node-pty ──▶ bash
 *                                        │
 *                                   proc stdout（分帧：D+len / M+json）
 *                                        │
 *                                   PtySession 读线程
 *                                        │
 *                              evaluateJavascript("__ptyOnData(...)")
 * </pre>
 *
 * <h3>分帧协议</h3>
 * PTY 输出是任意字节，直接按行读会被切碎。所以 bridge 侧用：
 * <ul>
 *   <li>{@code 'D' + 4 字节大端长度 + 原始字节} —— PTY 数据</li>
 *   <li>{@code 'M' + 一行 UTF-8 JSON + '\n'} —— 事件（ready / exit / error）</li>
 * </ul>
 * 本类按同一协议解，**不假设 stdout 是文本**。
 */
final class PtySession {
    private static final String TAG = "DshPty";

    /** 容器内 pty-bridge.js 的落点（rootfs 是只读的，只能放共享目录）。 */
    private static final String IN_BRIDGE = "/sdcard/pty-bridge.js";

    /** 回调：把数据/事件送回 UI。 */
    interface Sink {
        /** PTY 原始输出（已按 UTF-8 宽松解码）。空串表示忽略。 */
        void onData(String text);

        /** 状态文案（启动阶段）。 */
        void onStatus(String msg);

        /** 结束。reason 可能是空串。 */
        void onExit(int code, String reason);
    }

    private final Context app;
    private final Sink sink;

    private Process proc;
    private OutputStream stdin;
    private Thread reader;
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private volatile boolean ready = false;

    PtySession(Context c, Sink sink) {
        this.app = c.getApplicationContext();
        this.sink = sink;
    }

    /** 已就绪（bridge 报过 ready）？ */
    boolean isReady() {
        return ready && proc != null && proc.isAlive();
    }

    /* ------------------------------------------------------------------ */
    /* 启动                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 起容器 + PTY。**必须在后台线程调用**（proot 装配要几十毫秒到几百毫秒）。
     *
     * @throws IOException rootfs 还没解压、或 script 落盘失败
     */
    void start(int cols, int rows) throws IOException {
        if (!RootfsInstaller.isInstalled(app)) {
            throw new IOException("运行环境还没解压好。请先回到首页等「进入 DSH」变成可点，再试。");
        }

        /* ★ 把 bridge 脚本放到共享目录。
         * 为什么不放 rootfs 里：rootfs 是**只读**的（打包时定死），
         * 而 /sdcard 在容器内是 /storage/emulated/0/DeepseekHarness 的 bind，
         * 两边都可读写，是最省事的中转站。 */
        File shared = Cfg.sharedRoot(app);
        if (shared == null || !shared.isDirectory()) {
            throw new IOException("共享目录不可用，无法投放终端脚本。");
        }
        File script = new File(shared, "pty-bridge.js");
        copyAsset("term/pty-bridge.js", script);

        List<String> cmd = buildBridgeCommand(cols, rows, script);
        Cfg.log(app, "[PTY] cmd = " + String.join(" ", cmd));

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(false);   // ★ stderr 单独收，别污染分帧的 stdout
        ProotLauncher.applyEnv(pb, app);

        proc = pb.start();
        stdin = proc.getOutputStream();

        // stderr：单独线程读，只写日志，绝不进终端（否则调试输出会把屏搞花）
        startStderrDrain(proc.getErrorStream());

        // 先发 start，再开读线程
        send("{\"op\":\"start\",\"cols\":" + Math.max(1, cols)
                + ",\"rows\":" + Math.max(1, rows) + "}");

        startReader(proc.getInputStream());
    }

    /**
     * 组装「proot 里跑 node pty-bridge.js」的命令。
     *
     * ★ 刻意与 {@link ProotLauncher#buildCommand} **保持同一套 bind**，
     *   只把最后的 {@code /bin/sh -c "exec node ... dsh" } 换成 bridge。
     *   不一致会出两种怪事：容器里看不到 /sdcard（bridge 自身就在那儿）、
     *   或 /root/.dsh 是空的（用户以为数据丢了）。
     */
    private List<String> buildBridgeCommand(int cols, int rows, File script) {
        File rootfs = Cfg.rootfs(app);
        File sd = Cfg.sysdata(app);

        List<String> cmd = new ArrayList<>();
        cmd.add(ProotLauncher.prootPath(app));
        cmd.add("--kill-on-exit");
        cmd.add("--link2symlink");
        cmd.add("--sysvipc");
        cmd.add("--kernel-release=\\Linux\\localhost\\6.17.0-PRoot-Distro\\#1 SMP PREEMPT_DYNAMIC Fri, 10 Oct 2025 00:00:00 +0000\\aarch64\\localdomain\\-1\\");
        cmd.add("-L");
        cmd.add("--change-id=0:0");
        cmd.add("--rootfs=" + Cfg.prootPathOf(rootfs));
        cmd.add("--cwd=/root");

        cmd.add("--bind=/dev");
        cmd.add("--bind=/proc");
        cmd.add("--bind=/sys");
        cmd.add("--bind=/dev/urandom:/dev/random");
        cmd.add("--bind=" + Cfg.prootPathOf(new File(sd, "sys_empty")) + ":/sys/fs/selinux");
        for (String[] kv : new String[][]{
                {"loadavg", "/proc/loadavg"}, {"stat", "/proc/stat"},
                {"uptime", "/proc/uptime"}, {"version", "/proc/version"},
                {"sysctl_kernel_overflowuid", "/proc/sys/kernel/overflowuid"},
                {"sysctl_kernel_overflowgid", "/proc/sys/kernel/overflowgid"},
        }) {
            File f = new File(sd, kv[0]);
            if (f.exists()) cmd.add("--bind=" + Cfg.prootPathOf(f) + ":" + kv[1]);
        }

        // 用户数据（与主容器一致，终端里能直接看到 ~/.dsh）
        cmd.add("--bind=" + Cfg.prootPathOf(Cfg.dshHome(app)) + ":/root/.dsh");

        // 共享目录 —— ★ script 就在这里面，缺了这条 bridge 根本读不到
        File sharedRoot = Cfg.sharedRoot(app);
        if (sharedRoot != null && sharedRoot.isDirectory()) {
            cmd.add("--bind=" + sharedRoot.getAbsolutePath() + ":" + Cfg.IN_SHARED);
        }
        File phone = Cfg.phoneStorage(app);
        if (phone != null && phone.isDirectory()) {
            cmd.add("--bind=" + phone.getAbsolutePath() + ":" + Cfg.IN_PHONE);
            cmd.add("--bind=" + phone.getAbsolutePath() + ":/root/手机存储");
        }

        cmd.add("/opt/node/bin/node");
        cmd.add(IN_BRIDGE);
        return cmd;
    }

    /* ------------------------------------------------------------------ */
    /* 读写                                                                */
    /* ------------------------------------------------------------------ */

    /** 发一条命令给 bridge（自动补换行）。 */
    void send(String jsonLine) {
        OutputStream out = stdin;
        if (out == null) return;
        try {
            out.write(jsonLine.getBytes(StandardCharsets.UTF_8));
            out.write('\n');
            out.flush();
        } catch (IOException e) {
            // 管道断了：让读线程去收尾，这里不重复报
        }
    }

    /** 键盘输入。 */
    void write(String data) {
        if (data == null || data.isEmpty()) return;
        StringBuilder sb = new StringBuilder(data.length() + 16);
        sb.append("{\"op\":\"write\",\"data\":");
        jsonString(sb, data);
        sb.append('}');
        send(sb.toString());
    }

    /** 窗口尺寸变化。 */
    void resize(int cols, int rows) {
        if (cols <= 0 || rows <= 0) return;
        send("{\"op\":\"resize\",\"cols\":" + cols + ",\"rows\":" + rows + "}");
    }

    /** 主动结束。 */
    void stop() {
        send("{\"op\":\"stop\"}");
        close();
    }

    /** 释放资源（不等待进程）。 */
    void close() {
        if (!closed.compareAndSet(false, true)) return;
        try { if (stdin != null) stdin.close(); } catch (IOException ignored) { }
        try { if (proc != null) proc.destroy(); } catch (Throwable ignored) { }
    }

    /* ------------------------------------------------------------------ */
    /* 读线程                                                              */
    /* ------------------------------------------------------------------ */

    private void startReader(final InputStream in) {
        reader = new Thread(() -> {
            byte[] head = new byte[5];
            int exitCode = 0;
            String exitReason = "";
            try {
                while (true) {
                    if (!readFully(in, head, 5)) break;   // EOF
                    int type = head[0] & 0xFF;

                    if (type == 'D') {
                        long len = ((long) (head[1] & 0xFF) << 24)
                                | ((head[2] & 0xFF) << 16)
                                | ((head[3] & 0xFF) << 8)
                                | (head[4] & 0xFF);
                        if (len < 0 || len > 8L * 1024 * 1024) {
                            Cfg.log(app, "[PTY] 帧长度异常: " + len + "，断开");
                            break;
                        }
                        byte[] data = new byte[(int) len];
                        if (len > 0 && !readFully(in, data, (int) len)) break;
                        /* ★ 用 UTF-8 宽松解码（替换非法字节），不做流式切分 ——
                         *   xterm.js 的 write() 本身能接受被拆开的多字节序列
                         *   （它内部有增量解码器），这里再拆反而更糟。 */
                        sink.onData(new String(data, StandardCharsets.UTF_8));
                    } else if (type == 'M') {
                        String line = readLine(in);
                        if (line == null) break;
                        if (line.startsWith("{")) {
                            String op = JsonField.get(line, "op");
                            if ("ready".equals(op)) {
                                ready = true;
                                sink.onStatus(null);
                            } else if ("exit".equals(op)) {
                                exitCode = (int) JsonField.getLong(line, "code", 0);
                                exitReason = JsonField.get(line, "reason");
                                break;
                            } else if ("error".equals(op)) {
                                exitReason = JsonField.get(line, "msg");
                                Cfg.log(app, "[PTY] bridge 报错: " + exitReason);
                                break;
                            }
                        }
                    } else {
                        Cfg.log(app, "[PTY] 未知帧类型 0x" + Integer.toHexString(type) + "，断开");
                        break;
                    }
                }
            } catch (Throwable t) {
                Cfg.log(app, "[PTY] 读线程异常: " + t);
            } finally {
                ready = false;
                Cfg.log(app, "[PTY] 结束 code=" + exitCode + " reason=" + exitReason);
                sink.onExit(exitCode, exitReason);
            }
        }, "dsh-pty-reader");
        reader.setDaemon(true);
        reader.start();
    }

    private void startStderrDrain(final InputStream err) {
        Thread t = new Thread(() -> {
            byte[] buf = new byte[4096];
            StringBuilder line = new StringBuilder();
            try {
                int n;
                while ((n = err.read(buf)) > 0) {
                    line.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                    int idx;
                    while ((idx = line.indexOf("\n")) >= 0) {
                        String s = line.substring(0, idx);
                        line.delete(0, idx + 1);
                        if (!s.trim().isEmpty()) Cfg.log(app, "[PTY:err] " + s);
                    }
                    if (line.length() > 8192) line.setLength(0);
                }
            } catch (Throwable ignored) {
            }
        }, "dsh-pty-stderr");
        t.setDaemon(true);
        t.start();
    }

    private static boolean readFully(InputStream in, byte[] b, int len) throws IOException {
        int off = 0;
        while (off < len) {
            int n = in.read(b, off, len - off);
            if (n < 0) return false;
            off += n;
        }
        return true;
    }

    /** 读一行（到 '\n'），返回不含换行；EOF 返回 null。 */
    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        while (true) {
            int c = in.read();
            if (c < 0) return sb.length() == 0 ? null : sb.toString();
            if (c == '\n') return sb.toString();
            if (c != '\r') sb.append((char) c);
            if (sb.length() > 1024 * 1024) return null;   // 防御：异常长行
        }
    }

    /* ------------------------------------------------------------------ */
    /* 小工具                                                              */
    /* ------------------------------------------------------------------ */

    /** 把字符串写成 JSON 字面量（含引号）。 */
    static void jsonString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                case '\b': sb.append("\\b");  break;
                case '\f': sb.append("\\f");  break;
                default:
                    if (ch < 0x20) {
                        sb.append(String.format("\\u%04x", (int) ch));
                    } else {
                        sb.append(ch);
                    }
            }
        }
        sb.append('"');
    }

    /**
     * 极简 JSON 字段读取器 —— **只为读 bridge 发来的那一行事件**。
     *
     * ★ 为什么不用 org.json：本项目一路只用自己写的 MiniJson（写侧），
     *   而 org.json 在部分 ROM 上有行为差异（andorid.jar 实现与标准库不同）。
     *   这里只需要从**我们自己生成**的、字段顺序固定的短 JSON 里取几个标量，
     *   写个 40 行的解析器比引依赖更可控。
     */
    static final class JsonField {

        /** 取字符串字段；没有或类型不对返回空串。 */
        static String get(String json, String key) {
            if (json == null) return "";
            int i = json.indexOf("\"" + key + "\"");
            if (i < 0) return "";
            int c = json.indexOf(':', i + key.length() + 2);
            if (c < 0) return "";
            int p = c + 1;
            while (p < json.length() && Character.isWhitespace(json.charAt(p))) p++;
            if (p >= json.length()) return "";

            char ch = json.charAt(p);
            if (ch == '"') {
                StringBuilder sb = new StringBuilder();
                for (int k = p + 1; k < json.length(); k++) {
                    char x = json.charAt(k);
                    if (x == '\\' && k + 1 < json.length()) {
                        char e = json.charAt(++k);
                        switch (e) {
                            case 'n': sb.append('\n'); break;
                            case 'r': sb.append('\r'); break;
                            case 't': sb.append('\t'); break;
                            case 'b': sb.append('\b'); break;
                            case 'f': sb.append('\f'); break;
                            case 'u':
                                if (k + 4 < json.length()) {
                                    try {
                                        sb.append((char) Integer.parseInt(
                                                json.substring(k + 1, k + 5), 16));
                                        k += 4;
                                    } catch (NumberFormatException ignored) { }
                                }
                                break;
                            default: sb.append(e);
                        }
                    } else if (x == '"') {
                        break;
                    } else {
                        sb.append(x);
                    }
                }
                return sb.toString();
            }

            // 数字 / true / false / null：读到分隔符为止
            int e = p;
            while (e < json.length()) {
                char x = json.charAt(e);
                if (x == ',' || x == '}' || x == ']' || Character.isWhitespace(x)) break;
                e++;
            }
            String raw = json.substring(p, e);
            return "null".equals(raw) ? "" : raw;
        }

        /** 取整数字段；缺失或解析失败返回 def。 */
        static long getLong(String json, String key, long def) {
            try {
                String s = get(json, key);
                if (s.isEmpty()) return def;
                return Long.parseLong(s.trim());
            } catch (NumberFormatException e) {
                return def;
            }
        }
    }

    private void copyAsset(String assetName, File dst) throws IOException {
        InputStream in = app.getAssets().open(assetName);
        try {
            // 已经一样就不重写（避免每次进终端都动 /sdcard）
            if (dst.isFile() && dst.length() == in.available()) {
                return;
            }
            FileOutputStream out = new FileOutputStream(dst, false);
            try {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            } finally {
                try { out.close(); } catch (IOException ignored) { }
            }
        } finally {
            try { in.close(); } catch (IOException ignored) { }
        }
    }
}
