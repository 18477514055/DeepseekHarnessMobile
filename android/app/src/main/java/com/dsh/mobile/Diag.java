package com.dsh.mobile;

import android.content.Context;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;

/**
 * 一次性诊断：从 **app 进程内部**（untrusted_app 域）逐项测试可执行性。
 *
 * ★ 为什么必须从 app 内部测：
 *   `adb shell run-as com.dsh.mobile` 跑在 **runas_app** 域，而真正的 app 进程是
 *   **untrusted_app** 域。SELinux 那条 neverallow 恰好**豁免了 runas_app 但没有豁免
 *   untrusted_app(targetSdk>28)** ⇒ 同一个命令在 shell 里成功、在 app 里失败。
 *   这就是为什么前面所有 shell 手测都 "OK"、而 app 一跑就 Permission denied。
 *
 * 结果写进 files/diag.log。
 */
final class Diag {
    private Diag() {}

    static void runAll(Context c) {
        StringBuilder sb = new StringBuilder();
        sb.append("=== 诊断开始 ===\n");

        String nativeDir = c.getApplicationInfo().nativeLibraryDir;
        File files = c.getFilesDir();

        // 0) ★ 存储权限与共享目录（2026-10-19 新增）
        sb.append("\n--- 共享目录探测 ---\n");
        File shared = Cfg.sharedRoot(c);
        sb.append("  path=").append(shared.getAbsolutePath())
          .append(" exists=").append(shared.exists())
          .append(" isDir=").append(shared.isDirectory())
          .append(" canRead=").append(shared.canRead())
          .append(" canWrite=").append(shared.canWrite()).append('\n');
        try {
            File probe = new File(shared, ".probe-" + System.currentTimeMillis());
            boolean created = probe.createNewFile();
            sb.append("  创建测试文件: ").append(created).append('\n');
            if (created) {
                //noinspection ResultOfMethodCallIgnored
                probe.delete();
            }
        } catch (Exception e) {
            sb.append("  创建测试文件失败: ").append(e.getClass().getSimpleName())
              .append(": ").append(e.getMessage()).append('\n');
        }
        // 列出内容
        String[] list = shared.list();
        sb.append("  目录条目数=").append(list == null ? "null(读不了)" : String.valueOf(list.length)).append('\n');
        if (list != null) {
            int n = 0;
            for (String s : list) {
                if (n++ < 8) sb.append("    ").append(s).append('\n');
            }
        }

        // 1) nativeLibraryDir 里的 ELF 能不能 exec（应该能）
        probe(sb, "nativeLibraryDir/libproot.so --version", c,
                new File(nativeDir, "libproot.so"), "--version");

        // 2) filesDir 里放一个可执行文件，能不能 exec（预期：不能）
        File copy = new File(files, "test-exec-proot");
        try {
            copyFile(new File(nativeDir, "libproot.so"), copy);
            //noinspection ResultOfMethodCallIgnored
            copy.setExecutable(true, false);
        } catch (Exception e) {
            sb.append("复制失败: ").append(e).append('\n');
        }
        probe(sb, "filesDir/test-exec-proot --version", c, copy, "--version");

        // 3) rootfs 里的 dash 直接 exec（预期：不能）
        probe(sb, "rootfs/usr/bin/dash -c echo", c,
                new File(Cfg.rootfs(c), "usr/bin/dash"), "-c", "echo hi");

        // 4) 用 linker 显式加载 dash（这是绕过 exec 位的常见思路）
        probe(sb, "ld-linux + dash", c,
                new File(Cfg.rootfs(c), "usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1"),
                Cfg.prootPathOf(new File(Cfg.rootfs(c), "usr/bin/dash")),
                "-c", "echo hi");

        // 5) 关键：proot 能不能在 app 里跑起来（只 --version，不碰 rootfs）
        probe(sb, "nativeLibraryDir/libproot.so（带 PROOT_LOADER）", c,
                new File(nativeDir, "libproot.so"), "--version");

        sb.append("=== 诊断结束 ===\n");

        try (FileOutputStream fos = new FileOutputStream(new File(files, "diag.log"))) {
            fos.write(sb.toString().getBytes("UTF-8"));
        } catch (Exception ignored) {
        }
        Cfg.log(c, "诊断已写入 diag.log");
    }

    private static void probe(StringBuilder sb, String label, Context c, File exe, String... args) {
        sb.append("\n--- ").append(label).append(" ---\n");
        sb.append("  path=").append(exe.getAbsolutePath())
          .append(" exists=").append(exe.exists())
          .append(" canExec=").append(exe.canExecute()).append('\n');
        try {
            java.util.List<String> cmd = new java.util.ArrayList<>();
            cmd.add(exe.getAbsolutePath());
            for (String a : args) cmd.add(a);

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            java.util.Map<String, String> env = pb.environment();
            env.put("LD_LIBRARY_PATH", Cfg.prootPathOf(Cfg.libDir(c)));
            env.put("PROOT_LOADER", Cfg.prootPathOf(new File(Cfg.libDir(c), "libproot-loader.so")));
            env.put("PROOT_TMP_DIR", Cfg.prootPathOf(Cfg.tmpDir(c)));

            Process p = pb.start();
            StringBuilder out = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                String line;
                int n = 0;
                while ((line = r.readLine()) != null && n < 6) {
                    out.append("    ").append(line).append('\n');
                    n++;
                }
            }
            int rc = p.waitFor();
            sb.append("  exit=").append(rc).append('\n').append(out);
        } catch (Exception e) {
            sb.append("  失败: ").append(e.getClass().getSimpleName())
              .append(": ").append(e.getMessage()).append('\n');
        }
    }

    private static void copyFile(File src, File dst) throws Exception {
        try (java.io.InputStream in = new java.io.FileInputStream(src);
             FileOutputStream out = new FileOutputStream(dst)) {
            byte[] b = new byte[1 << 16];
            int n;
            while ((n = in.read(b)) > 0) out.write(b, 0, n);
        }
    }
}
