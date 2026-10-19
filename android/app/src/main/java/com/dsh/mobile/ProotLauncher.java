package com.dsh.mobile;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 容器启动器 —— 把 §十四 实测通过的 proot 命令固化成 Java。
 *
 * ★★ 这套参数是**在真机上逐条验证过**的（Termux usr 不可见仍能跑起 DSH）。
 *   改动任何一条前，先回 docs/01-自包含APK实证报告.md 对一遍。
 *
 * ★ 三个历史坑（都已在下面处理）：
 *   ① proot 的 RUNPATH 写死了 Termux 路径 → 必须用 LD_LIBRARY_PATH 覆盖到我们自己的 lib
 *   ② 必须显式设 PROOT_LOADER，否则起不来
 *   ③ /tmp 不可写 → 必须设 PROOT_TMP_DIR
 *
 * ★★★ 2026-10-19 真机踩到的最关键一条：**proot 不能在 files/ 里执行**。
 *   实测：
 *     Cannot run program "/data/user/0/com.dsh.mobile/files/lib/proot":
 *     error=13, Permission denied
 *   原因：Android 10+ 的 W^X —— untrusted app 的私有目录**不可执行**。
 *   而 `nativeLibraryDir`（/data/app/.../lib/arm64）的 SELinux 上下文是 apk_data_file，
 *   **是可执行的**（实测 `libproot.so --version` 能跑，只报缺 libtalloc）。
 *
 *   ⇒ 所以最终布局是：
 *     · **proot 本体从 nativeLibraryDir 直接执行**（只有那里可执行）
 *     · loader / .so / sysdata / rootfs 仍在 files/（只需被读，不需被执行）
 *     · 用 LD_LIBRARY_PATH 让 proot 找到 files/lib 里的依赖
 *
 *   ★ 另外 jniLibs 只认 `lib*.so`，所以 `libtalloc.so.2` 被打包成 `libtalloc.so`。
 *     但 proot 的 ELF 里 NEEDED 写的是 `libtalloc.so.2`，所以必须在 files/lib
 *     里放一份**名字正确**的副本（见 stageBinaries）。
 */
final class ProotLauncher {
    private static final String TAG = "DshProot";

    private ProotLauncher() {}

    /** jniLibs 里的名字 → files/lib 里的名字（proot 的 NEEDED 要用后者） */
    private static final String[][] BINS = {
            {"libproot-loader.so",   "libproot-loader.so"},
            {"libproot-loader32.so", "libproot-loader32.so"},
            {"libandroid-shmem.so",  "libandroid-shmem.so"},
            {"libtalloc.so",         "libtalloc.so.2"},   // ★ 名字必须改回 .so.2
    };

    /** proot 本体在 jniLibs 里的名字（要被 exec，只能留在 nativeLibraryDir）。 */
    static final String PROOT_LIB = "libproot.so";

    /**
     * 把依赖库从 nativeLibraryDir 复制到 files/lib/。
     * ★ proot 本体**不复制** —— 它必须留在 nativeLibraryDir 才能执行。
     */
    static void stageBinaries(Context c) throws IOException {
        File lib = Cfg.libDir(c);
        if (!lib.exists() && !lib.mkdirs()) throw new IOException("无法创建 lib 目录");

        String nativeDir = c.getApplicationInfo().nativeLibraryDir;
        for (String[] pair : BINS) {
            File src = new File(nativeDir, pair[0]);
            File dst = new File(lib, pair[1]);
            if (!src.exists()) {
                throw new IOException("jniLibs 里缺少 " + pair[0] + "（查找路径 " + nativeDir + "）");
            }
            copy(src, dst);
            // ★★★ 必须显式设可执行位。
            //   踩过：copy 出来的文件是 -rw-------（600），loader 无法被 exec，
            //   表现为 proot 报 `execve("/usr/bin/sh"): Permission denied`，
            //   极易误判成 SELinux 问题（其实只是少了 +x）。
            //noinspection ResultOfMethodCallIgnored
            dst.setExecutable(true, false);
            //noinspection ResultOfMethodCallIgnored
            dst.setReadable(true, false);
        }
        Cfg.log(c, "依赖库已就位（含执行位）: " + lib.getAbsolutePath());
    }

    /** proot 可执行文件的绝对路径（在 nativeLibraryDir，只有那里能 exec）。 */
    static String prootPath(Context c) {
        return new File(c.getApplicationInfo().nativeLibraryDir, PROOT_LIB).getAbsolutePath();
    }

    /** 组装 proot 的完整命令（env 由 applyEnv 给）。 */
    static List<String> buildCommand(Context c) {
        File rootfs = Cfg.rootfs(c);
        File sd = Cfg.sysdata(c);

        List<String> cmd = new ArrayList<>();

        // ---- proot 本体（★ 必须从 nativeLibraryDir 执行）----
        // 注意 nativeLibraryDir 是 /data/app/...，proot 对它是只读访问，不需要改写路径。
        cmd.add(prootPath(c));
        cmd.add("--kill-on-exit");
        cmd.add("--link2symlink");
        cmd.add("--sysvipc");

        // ★ 反斜杠是转义，不是笔误（§12.3 第 2 点）
        cmd.add("--kernel-release=\\Linux\\localhost\\6.17.0-PRoot-Distro\\#1 SMP PREEMPT_DYNAMIC Fri, 10 Oct 2025 00:00:00 +0000\\aarch64\\localdomain\\-1\\");
        cmd.add("-L");
        cmd.add("--change-id=0:0");
        // ★ 所有 app 私有目录路径都要走 prootPathOf（/data/user/0 → /data/data）
        cmd.add("--rootfs=" + Cfg.prootPathOf(rootfs));
        cmd.add("--cwd=/root");

        // ---- 基础 bind ----
        cmd.add("--bind=/dev");
        cmd.add("--bind=/proc");
        cmd.add("--bind=/sys");
        cmd.add("--bind=/dev/urandom:/dev/random");

        // ---- sysdata（Android 上真 /proc/* 对 app 不可读）----
        cmd.add("--bind=" + Cfg.prootPathOf(new File(sd, "sys_empty")) + ":/sys/fs/selinux");
        cmd.add("--bind=" + Cfg.prootPathOf(new File(sd, "loadavg")) + ":/proc/loadavg");
        cmd.add("--bind=" + Cfg.prootPathOf(new File(sd, "stat")) + ":/proc/stat");
        cmd.add("--bind=" + Cfg.prootPathOf(new File(sd, "uptime")) + ":/proc/uptime");
        cmd.add("--bind=" + Cfg.prootPathOf(new File(sd, "version")) + ":/proc/version");

        // ---- 用户数据：bind 进容器，卸载重装可保留 ----
        cmd.add("--bind=" + Cfg.prootPathOf(Cfg.dshHome(c)) + ":/root/.dsh");

        // ---- ★★ 共享目录：手机存储 /sdcard/DSH → 容器内 /sdcard ----
        //
        // 用户要的是「工作区文件能自由流动」：手机文件管理器里丢进去的文件，
        // DSH 里能直接看到；DSH 里产出的文件，文件管理器里能直接拿走。
        //
        // ★★★ 2026-10-19 用户追加需求（原话）：
        //   「能不能让我在 DSH 里面正常的访问外部文件？甚至是选择一个手机自己的文件夹
        //    作为工作区。在侧边栏打开一个外部文件也是可以正常显示的，而不是只能看到
        //    容器的根目录。相当于现在侧边栏允许访问整个手机文件管理器。」
        //
        //   ⇒ 不再是"只挂一个 DSH 目录"，而是**把整个手机共享存储挂进容器**：
        //     /storage/emulated/0  →  容器内 /mnt/phone
        //   这样 DSH 的「添加工作区」可以选到手机上的任意文件夹，
        //   侧边栏也能浏览/打开外部文件。
        //
        // ★ 两条 bind 都挂：
        //     /storage/emulated/0       → /mnt/phone   （整个手机存储，满足新需求）
        //     /storage/emulated/0/DSH   → /sdcard      （保留一个顺手的小入口）
        //
        // ★ bind 源用 /storage/emulated/0（真实挂载点），不用 /sdcard
        //   （/sdcard 是符号链接，proot 对符号链接做 bind 源可能解析异常）。
        // ★ 只在路径确实存在时才 bind —— 没存储权限时不 bind，容器照样能起（降级不崩溃）。
        File sharedRoot = Cfg.sharedRoot(c);
        if (Cfg.ensureSharedRoot(c)) {
            cmd.add("--bind=" + sharedRoot.getAbsolutePath() + ":" + Cfg.IN_SHARED);
        }

        File phone = Cfg.phoneStorage(c);
        if (phone != null && phone.isDirectory()) {
            cmd.add("--bind=" + phone.getAbsolutePath() + ":" + Cfg.IN_PHONE);
            Cfg.log(c, "手机存储已挂载: " + phone.getAbsolutePath() + " → " + Cfg.IN_PHONE);
        } else {
            Cfg.log(c, "⚠️ 手机存储不可用，跳过 /mnt/phone 挂载");
        }

        // ★★★ 便捷入口：把手机存储**同时**挂到 /root 下，叫 手机存储。
        //
        // 为什么：DSH 的「选择工作区目录」弹层默认从 HOME(/root) 开始浏览，
        // 而 /mnt/phone 在别的树枝上，用户要一层层退到 / 才能看到 —— 太绕。
        // 挂一个 /root/手机存储 过去，弹层里第一屏就能看到，点进去就是整个手机。
        //
        // ★ 用中文目录名是因为它直接显示在 UI 上，中文更好认。
        //   /sdcard 不支持这些，但这是容器内的挂载点（在 /data 上），没问题。
        if (phone != null && phone.isDirectory()) {
            cmd.add("--bind=" + phone.getAbsolutePath() + ":/root/手机存储");
            Cfg.log(c, "便捷入口: /root/手机存储 → 手机存储根");
        }


        // ★★ 刻意 **不** bind Termux 的 usr（proot-distro 默认有，我们不要）

        // ---- 容器内命令 ----
        cmd.add("/bin/sh");
        cmd.add("-c");
        cmd.add("export PATH=" + Cfg.IN_NODE_DIR + ":$PATH; "
                + "cd /root; "
                + "exec node " + Cfg.IN_BIN_JS
                + " web --no-open --host 127.0.0.1 --port " + Cfg.PORT);

        return cmd;
    }

    /** 环境变量：env -i 的等价物。 */
    static void applyEnv(ProcessBuilder pb, Context c) {
        java.util.Map<String, String> env = pb.environment();
        env.clear();
        env.put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        env.put("HOME", "/root");
        env.put("USER", "root");
        env.put("TERM", "dumb");
        // ★ 这三个路径 proot 会自己去做文件操作，必须用 /data/data 形式
        env.put("PROOT_LOADER", Cfg.prootPathOf(new File(Cfg.libDir(c), "libproot-loader.so")));
        env.put("PROOT_LOADER_32", Cfg.prootPathOf(new File(Cfg.libDir(c), "libproot-loader32.so")));
        env.put("PROOT_TMP_DIR", Cfg.prootPathOf(Cfg.tmpDir(c)));
        // ★ 让 proot 找到 files/lib 里的 libtalloc.so.2 / libandroid-shmem.so
        env.put("LD_LIBRARY_PATH", Cfg.prootPathOf(Cfg.libDir(c)));
        // lingshu-bridge 要 spawn python3（§14.4）
        env.put("MDCG_PYTHON", "python3");
    }

    private static void copy(File src, File dst) throws IOException {
        try (InputStream in = new java.io.FileInputStream(src);
             FileOutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }
}
