package com.dsh.mobile;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * 生成 proot 需要的 sysdata 伪造文件。
 *
 * ★★ 为什么必须有这个（§14.3 坑④）：
 *   Android 上 app 读不了真的 /proc/loadavg、/proc/stat、/proc/uptime、/proc/version
 *   （实测 /proc/1/cmdline → Permission denied）。proot-distro 的做法是**预先造好**
 *   这些文件，再用 --bind 覆盖进容器。我们必须自己造一份。
 *
 * ★ 内容不必精确（容器里的 free/uptime 只是显示用），但**格式必须对**，
 *   否则 coreutils 解析会报错。下面照 proot-distro 的形状写。
 */
final class Sysdata {
    private static final String TAG = "DshSysdata";

    private Sysdata() {}

    /** 一次性生成全部伪造文件。可重复调用（覆盖写）。 */
    static void ensure(Context c) throws IOException {
        File d = Cfg.sysdata(c);
        if (!d.exists() && !d.mkdirs()) throw new IOException("无法创建 sysdata: " + d);

        // sys_empty：一个空目录，bind 到 /sys/fs/selinux（Android 上那里对 app 不可读）
        File sysEmpty = new File(d, "sys_empty");
        if (!sysEmpty.exists() && !sysEmpty.mkdirs()) throw new IOException("无法创建 sys_empty");

        // /proc/loadavg  形如 "0.50 0.40 0.30 2/1234 5678"
        write(d, "loadavg", "0.50 0.40 0.30 2/1234 5678\n");

        // /proc/uptime   形如 "12345.67 98765.43"
        write(d, "uptime", "12345.67 98765.43\n");

        // /proc/version
        write(d, "version",
                "Linux version 6.17.0-PRoot-Distro (proot@distro) "
                        + "(gcc version 12.2.0 (Debian 12.2.0-14)) #1 SMP PREEMPT_DYNAMIC\n");

        // /proc/stat    至少要 cpu 行 + btime，否则不少工具会崩
        StringBuilder st = new StringBuilder();
        st.append("cpu  1000 0 1000 100000 0 0 0 0 0 0\n");
        for (int i = 0; i < 8; i++) {
            st.append("cpu").append(i).append("  125 0 125 12500 0 0 0 0 0 0\n");
        }
        st.append("intr 0\nctxt 0\nbtime 1700000000\nprocesses 1000\nprocs_running 1\nprocs_blocked 0\n");
        write(d, "stat", st.toString());

        // /proc/vmstat
        write(d, "vmstat",
                "nr_free_pages 100000\nnr_zone_inactive_anon 0\nnr_zone_active_anon 0\n"
                        + "pgpgin 0\npgpgout 0\npswpin 0\npswpout 0\n");

        // /proc/sys/kernel/overflowuid / overflowgid  —— 各一个数字
        write(d, "sysctl_kernel_overflowuid", "65534\n");
        write(d, "sysctl_kernel_overflowgid", "65534\n");

        // /proc/sys/kernel/cap_last_cap
        write(d, "sysctl_entry_cap_last_cap", "40\n");

        // /proc/sys/fs/inotify/max_user_watches
        write(d, "sysctl_inotify_max_user_watches", "8192\n");

        Log.i(TAG, "sysdata 就绪: " + d.getAbsolutePath());
    }

    private static void write(File dir, String name, String content) throws IOException {
        File f = new File(dir, name);
        try (FileOutputStream fos = new FileOutputStream(f)) {
            fos.write(content.getBytes(StandardCharsets.UTF_8));
        }
        // proot 以容器 root 身份读，权限给宽一点无妨（都是本 app 私有目录）
        //noinspection ResultOfMethodCallIgnored
        f.setReadable(true, false);
    }
}
