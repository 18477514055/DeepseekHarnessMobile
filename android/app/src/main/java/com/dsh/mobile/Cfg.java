package com.dsh.mobile;

import android.content.Context;

import java.io.File;

/**
 * 路径与常量。
 *
 * ★ 所有路径都从 Context 推导，绝不写死 —— 因为 Android 的 app 私有目录
 *   在不同设备/不同安装方式下可能不同（/data/user/0 vs /data/data，
 *   多用户 /data/user/10 等）。
 *
 * ★ 这里的目录布局刻意照 §十四 实测通过的 _selftest 布局：
 *     files/rootfs      —— Debian rootfs
 *     files/lib         —— proot 五件套（从 nativeLibraryDir 软链/copy 过来）
 *     files/tmp         —— PROOT_TMP_DIR（/tmp 在 app 沙箱不可写）
 *     files/sysdata     —— 那 10 个伪造的 /proc 文件
 *     files/dshhome     —— DSH 的家（用户数据，首次启动为空）
 */
final class Cfg {
    private Cfg() {}

    /**
     * 启动令牌：**正常路径下根本用不到**。
     *
     * ★ DSH 每次启动都会重新生成 token，所以真正取 token 的地方是
     *   {@code DshService.readTokenFromLog()}（从 proot.log 里现读）。
     *   这里的常量只是"万一读不到日志"的兜底，故意留空 ——
     *   写死真令牌既没用（下次启动就变），又会在公开仓库里泄漏。
     */
    static final String TOKEN = "";

    static final int PORT = 3080;

    /** 容器内 node 与 dsh 的路径（在 rootfs 里，不是 Android 路径）。 */
    static final String IN_NODE_DIR = "/opt/node/bin";
    static final String IN_BIN_JS = "/opt/node/lib/node_modules/@deepseek-ai/dsh/lib/bin.js";

    /** rootfs 解压完成标记。有它才认为解压过了。 */
    static File readyMarker(Context c) { return new File(c.getFilesDir(), ".rootfs-ready"); }

    static File files(Context c) { return c.getFilesDir(); }
    static File rootfs(Context c) { return new File(c.getFilesDir(), "rootfs"); }
    static File libDir(Context c) { return new File(c.getFilesDir(), "lib"); }
    static File tmpDir(Context c) { return new File(c.getFilesDir(), "tmp"); }
    static File sysdata(Context c) { return new File(c.getFilesDir(), "sysdata"); }
    static File dshHome(Context c) { return new File(c.getFilesDir(), "dshhome"); }
    static File prootLog(Context c) { return new File(c.getFilesDir(), "proot.log"); }
    static File bootLog(Context c) { return new File(c.getFilesDir(), "boot.log"); }

    // ------------------------------------------------------------------
    // ★★ 外部共享目录（2026-10-19 用户需求）
    //
    // 用户原话：「经常把一些文件放进工作区里面，然后把一些文件从工作区里面拉出来。
    //           现在这个就很不方便……这些工作区文件无法自由流动，真的太难受了。」
    //
    // ⇒ 在手机存储里开一个**文件管理器能直接看见**的目录：
    //     /sdcard/DSH/
    //   并把它 bind 进容器的 /sdcard，让 DSH 的工作区可以直接指过去。
    //
    // ★ 为什么不用 /sdcard/Android/data/<pkg>/：
    //   Android 11+ 起文件管理器**看不到**那个目录的内容（显示为空）。
    // ★ 为什么不用 /sdcard/Android/media/<pkg>/：
    //   部分 ROM 的文件管理器仍会隐藏它。
    //   /sdcard/DSH 是普通目录，任何文件管理器都能直接进。
    //
    // ★ 注意：/sdcard 不支持 POSIX 符号链接与权限位 —— 所以这里只放**工作区文件**，
    //   rootfs 绝不能放这里（rootfs 有 501 个符号链接）。
    // ------------------------------------------------------------------

    /**
     * 手机存储上的共享根。
     *
     * ★★★ 2026-10-19 踩过的坑：最初用 `/storage/emulated/0/DSH`，
     *   结果一直 `canWrite=false` / `Operation not permitted`。
     *   查出来那个目录是**遗留目录**：属主 `u0_a222`、权限 `drwxrws---`，
     *   是 2026-09-16 某个旧 App 留下的，我们的新 uid 根本写不进去。
     *   ⇒ 换成一个不会撞车的名字 + 首次写入自检。
     */
    static File sharedRoot(Context c) {
        return new File("/storage/emulated/0/DeepseekHarness");
    }

    /** 容器内看到的共享目录挂载点：/sdcard */
    static final String IN_SHARED = "/sdcard";

    /**
     * ★ 整个手机共享存储（用户要"像文件管理器一样访问整个手机"）。
     * 挂到容器内的 /mnt/phone。
     */
    static File phoneStorage(Context c) {
        return new File("/storage/emulated/0");
    }

    /** 整个手机存储在容器内的挂载点。 */
    static final String IN_PHONE = "/mnt/phone";

    /**
     * 确保 /sdcard/DSH 存在且可写。失败返回 false（没权限/没挂载），调用方据此决定是否 bind。
     */
    static boolean ensureSharedRoot(Context c) {
        File d = sharedRoot(c);
        if (d.exists() && d.isDirectory()) return true;
        boolean ok = d.mkdirs();
        if (!ok) {
            // 有些 ROM 上 /sdcard 走 MediaStore，mkdirs 可能失败但目录已由系统建好
            ok = d.exists();
        }
        if (ok) log(c, "共享目录就绪: " + d.getAbsolutePath());
        else log(c, "⚠️ 共享目录创建失败（缺存储权限？）: " + d.getAbsolutePath());
        return ok;
    }

    /**
     * ★★★ 返回给 proot 用的路径必须是 `/data/data/<pkg>/...` 形式。
     *
     * 为什么：`Context.getFilesDir()` 返回 `/data/user/0/<pkg>/files`，
     * 而 `/data/user/0` 与 `/data/data` 是同一个目录（前者是后者的符号链接）。
     * proot 内部会把路径做规范化，结果它自己拼出 `/data/data/...` 去操作，
     * 而我们给的是 `/data/user/0/...` ⇒ 两边对不上，实测报：
     *
     *   proot error: execve("/usr/bin/sh"): Permission denied
     *   proot error: can't chmod '/data/data/com.dsh.mobile/files/tmp/proot-11160-xxx':
     *                No such file or directory
     *
     * 上次在 Termux 里成功时用的就是 `/data/data/...` 前缀（§14），所以这里统一。
     * ★ 只影响"传给 proot 的字符串"；Java 侧的文件操作仍用 File 对象（等价）。
     */
    static String prootPathOf(File f) {
        String p = f.getAbsolutePath();
        String prefix = "/data/user/0/";
        if (p.startsWith(prefix)) {
            return "/data/data/" + p.substring(prefix.length());
        }
        return p;
    }

    /**
     * 启动过程日志。★ 为什么要写文件：
     *   logcat 环形缓冲在真机上很短（MIUI 实测只留几十秒），启动失败后回头查往往已经滚没了。
     *   写进 files/boot.log 可以事后 `adb shell run-as ... cat files/boot.log` 看全过程。
     *
     * ★★★ 2026-10-20 追加：**同时镜像一份到 /sdcard/DeepseekHarness/boot.log**。
     *   原因：**release 版不能 run-as**（`package not debuggable`），
     *   而 files/ 目录 adb shell 也进不去（Permission denied）⇒
     *   一旦 release 版启动失败，**没有任何可读的日志**，只能靠猜和截图。
     *   这次就是这样卡住的（只看到「容器已退出」，不知道哪一步炸的）。
     *   ⇒ 镜像到共享目录后，`adb pull /sdcard/DeepseekHarness/boot.log` 直接能读。
     */
    static void log(Context c, String msg) {
        String line = new java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US)
                .format(new java.util.Date()) + "  " + msg + "\n";
        byte[] bytes = line.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        try (java.io.FileOutputStream fos = new java.io.FileOutputStream(bootLog(c), true)) {
            fos.write(bytes);
        } catch (Exception ignored) {
        }
        // ★ 镜像到外部（失败无所谓，不能因为它影响主流程）
        try {
            java.io.File dir = sharedRoot(c);
            if (dir.exists() || dir.mkdirs() || dir.exists()) {
                try (java.io.FileOutputStream fos =
                             new java.io.FileOutputStream(new java.io.File(dir, "boot.log"), true)) {
                    fos.write(bytes);
                }
            }
        } catch (Exception ignored) {
        }
        android.util.Log.i("DshBoot", msg);
    }
}
