package com.dsh.mobile;

import android.content.Context;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.zip.GZIPInputStream;

/**
 * 首启把 assets/rootfs.gz.bin 展开到 files/rootfs/。
 *
 * ★★ 为什么是 gzip 而不是 zstd：
 *   Java 自带 GZIPInputStream，APK 里**不需要**额外塞解压二进制。zstd 压缩率更好
 *   （226MB vs 374MB），但要多带一个可执行文件并自己调，首启多一个失败点。
 *   第一版选简单可靠；真要省那 150MB 是后续优化项。
 *
 * ★★ 为什么自己写 tar 解析（不调容器里的 tar）：
 *   首启时容器还没起来，没法用容器内的 tar。
 *
 * ★★★ 这里踩过三个坑，全部记在下面（都很隐蔽）：
 *   ① tar 的**每个条目数据后要按 512 字节对齐**。忘了跳填充 ⇒ 下一个 header 错位
 *      ⇒ 解析出乱七八糟的文件名（实测解析出个叫 ":" 的文件）。
 *   ② 判目录要看**原始名字**：`./` 经 sanitize 变成空串，再 endsWith("/") 就失效。
 *   ③ **符号链接必须真建**：Debian rootfs 里 `/bin -> usr/bin`、`/lib -> usr/lib`
 *      是符号链接。当普通文件处理 ⇒ `/bin/sh` 不存在 ⇒ 容器根本起不来。
 */
final class RootfsInstaller {
    private static final String TAG = "DshRootfs";
    static final String ASSET_GZ = "rootfs.gz.bin";

    interface Progress {
        void onProgress(int percent, String detail);
    }

    private RootfsInstaller() {}

    static boolean isInstalled(Context c) {
        File rf = Cfg.rootfs(c);
        return Cfg.readyMarker(c).exists()
                && new File(rf, "opt/node/bin/node").exists()
                && new File(rf, "usr/bin/python3").exists()
                // ★ 是 usr/bin/sh，不是 bin/sh —— `bin` 本身是符号链接（-> usr/bin）。
                //   这一条是 tools/verify-tar.js 在电脑上测出来的，省了一次真机往返。
                && new File(rf, "usr/bin/sh").exists();
    }

    // ------------------------------------------------------------------
    // pnpm 增量包
    //
    // ★★★ 为什么需要它（2026-10-19 真机报错）：
    //   插件市场里填任何包名都报：
    //     Command failed with ENOENT: pnpm view dshmarket ... spawn pnpm ENOENT
    //   根因：**Debian rootfs 里没有 pnpm**（Node 官方包只带 npm/npx/corepack）。
    //   DSH 查插件信息、装插件全都靠 `pnpm view` / `pnpm add`，
    //   少了它整个插件系统就是死的。
    //
    // ★ 为什么不重打整个 rootfs：pnpm 目录 48MB，但 tar.gz 只有 **1.0MB**。
    //   单独做增量包最省事，重打整包要重传 1.3GB。
    // ------------------------------------------------------------------
    static final String ASSET_PNPM = "pnpm-incr.gz.bin";

    static boolean isPnpmInstalled(Context c) {
        // ★ 判据要看**真实入口文件 + 执行位**。
        //   只查 bin/pnpm 这个链接不够：链接存在但 .mjs 没有 +x 时，
        //   运行会报 `pnpm: Permission denied`（踩过）。
        File mjs = new File(Cfg.rootfs(c), "opt/node/lib/node_modules/pnpm/bin/pnpm.mjs");
        // ★★ 还要查**原生二进制**是不是实体文件。
        //   踩过（台账 §25）：增量包里那个位置原本是个指向 Termux `.l2s` 的
        //   绝对符号链接，装到别的设备就失效。pnpm 12 的 .mjs 是个引导器，
        //   发现二进制不在就会**去 registry.npmjs.org 下载 44MB** —— 在国内
        //   网络下极慢甚至会超时，而插件系统全靠 pnpm。
        //   现在包里直接带真二进制（22MB gz），这条外部依赖没了。
        File nativeBin = new File(Cfg.rootfs(c),
                "opt/node/lib/node_modules/pnpm/node_modules/@pnpm/exe.linux-arm64/pnpm");
        return mjs.exists() && mjs.canExecute()
                && nativeBin.exists() && !Files.isSymbolicLink(nativeBin.toPath())
                && new File(Cfg.rootfs(c), "opt/node/bin/pnpm").exists();
    }

    /**
     * 把 assets/pnpm-incr.gz.bin 解压到 rootfs/opt/node/lib/node_modules/，
     * 并补上 bin 下的 4 个符号链接。
     */
    static void installPnpm(Context c, Progress p) throws IOException {
        File nodeModules = new File(Cfg.rootfs(c), "opt/node/lib/node_modules");
        if (!nodeModules.exists() && !nodeModules.mkdirs()) {
            throw new IOException("无法创建 " + nodeModules);
        }

        p.onProgress(0, "安装 pnpm（插件系统必需）…");

        try (InputStream raw = c.getAssets().open(ASSET_PNPM)) {
            TarReader tar = new TarReader(new GZIPInputStream(
                    new BufferedInputStream(raw, 1 << 20), 1 << 20));

            TarReader.Entry e;
            int n = 0;
            while ((e = tar.next()) != null) {
                extract(nodeModules, e, tar);
                n++;
            }
            Cfg.log(c, "pnpm 解压完成，条目=" + n);
        }

        // ★★★ 补 bin 下的符号链接。
        //
        // 踩过一个大坑（2026-10-19）：
        //   pnpm 包根目录里原本有 4 个**绝对路径**符号链接
        //   （pn/pnpm/pnpx/pnx -> /data/data/com.termux/.../rootfs/.l2s/.l2s.pnpm0001），
        //   那是打包源机器上的位置。装到别的设备后那个路径不存在 ⇒ 链接失效 ⇒
        //   `pnpm: not found`。
        //   ★ 而且 `--link2symlink` 只把**硬链接**转成符号链接，不会修这些本来就存在的
        //     绝对链接 —— 所以打包时看不出来，装上才发现。
        //
        // 真实入口是 `pnpm/bin/pnpm.mjs`（11836 B），pnpx 是 `bin/pnpx.mjs`。
        // 这里用**相对路径**重建，且直接指向 .mjs。
        File bin = new File(Cfg.rootfs(c), "opt/node/bin");
        link(c, bin, "pnpm", "../lib/node_modules/pnpm/bin/pnpm.mjs");
        link(c, bin, "pnpx", "../lib/node_modules/pnpm/bin/pnpx.mjs");
        link(c, bin, "pn",   "../lib/node_modules/pnpm/bin/pnpm.mjs");
        link(c, bin, "pnx",  "../lib/node_modules/pnpm/bin/pnpx.mjs");

        // 顺手把包里那 4 个失效的绝对链接也修掉（万一有用到它们）
        File pnpmDir = new File(Cfg.rootfs(c), "opt/node/lib/node_modules/pnpm");
        link(c, pnpmDir, "pnpm", "bin/pnpm.mjs");
        link(c, pnpmDir, "pnpx", "bin/pnpx.mjs");
        link(c, pnpmDir, "pn",   "bin/pnpm.mjs");
        link(c, pnpmDir, "pnx",  "bin/pnpx.mjs");

        // ★★ 必须给 .mjs 加执行位！
        //   踩过：链接指向对了，但 `pnpm: Permission denied` —— 因为 tar 里那俩 .mjs
        //   是 600（数据文件），shebang 脚本没有 +x 就无法直接执行。
        File pnpmMjs = new File(pnpmDir, "bin/pnpm.mjs");
        File pnpxMjs = new File(pnpmDir, "bin/pnpx.mjs");
        //noinspection ResultOfMethodCallIgnored
        pnpmMjs.setExecutable(true, false);
        //noinspection ResultOfMethodCallIgnored
        pnpxMjs.setExecutable(true, false);
        //noinspection ResultOfMethodCallIgnored
        pnpmMjs.setReadable(true, false);
        //noinspection ResultOfMethodCallIgnored
        pnpxMjs.setReadable(true, false);

        // ★★★ 原生二进制（44MB，包里带的是压缩后的 22MB）。
        //
        //   为什么必须在这里再补一次：tar 条目里写了 755，但如果哪天包被重新打
        //   成 600，pnpm 会静默退回去下载外部二进制 —— 那个失败是**网络级**的，
        //   报错长得像"查询不到插件"，极难联想到执行位。显式补一次，代价为零。
        File nativeBin = new File(pnpmDir,
                "node_modules/@pnpm/exe.linux-arm64/pnpm");
        if (nativeBin.exists()) {
            //noinspection ResultOfMethodCallIgnored
            nativeBin.setExecutable(true, false);
            //noinspection ResultOfMethodCallIgnored
            nativeBin.setReadable(true, false);
            Cfg.log(c, "pnpm 原生二进制就位，大小=" + nativeBin.length());
        } else {
            // ★ 不抛异常：没有它 pnpm 12 会退回去自己下载，属于"慢但能活"。
            //   但必须留痕，否则以后又变成"界面正常、插件市场是死的"。
            Cfg.log(c, "警告：pnpm 原生二进制缺失，首次查询插件会尝试联网下载");
        }

        p.onProgress(100, "pnpm 已就位");
        Cfg.log(c, "pnpm 安装完成");
    }

    private static void link(Context c, File dir, String name, String target) {
        File f = new File(dir, name);
        try {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            /* ★★★ 2026-10-20（真机崩溃后修）：这里原来是 `Path.of(target)`。
             *
             * `Path.of(String, String...)` 是 **Java 11** 的 API，Android 上直到
             * **API 33** 才提供。在 Android 10（API 29）上直接抛：
             *   java.lang.NoSuchMethodError: No static method of(...)Ljava/nio/file/Path;
             * ⇒ App 启动即崩（解压走不到符号链接那一步就死）。
             *
             * `File.toPath()` 从 API 1 就有，且语义等价（相对路径同样按 cwd 解析）。
             * ★ 编译期不会报错（JDK 里有这个 API），**只有低版本真机才会暴露** ——
             *   这就是为什么自家 Android 16 的设备测不出来。 */
            Files.createSymbolicLink(f.toPath(), new File(target).toPath());
        } catch (Exception ex) {
            Cfg.log(c, "建链接失败 " + name + ": " + ex.getMessage());
        }
    }

    // ------------------------------------------------------------------
    // 移动端适配插件（dsh-mobile-adaption）
    //
    // ★★★ 为什么要有这一段（2026-10-20 真机踩到）：
    //   插件源码本来就在 rootfs 的 `/root/plugin-src` 里（打包时保留了），
    //   但**首启生成的 dshhome 是官方默认 2-bundle profile**，没引用它 ⇒ 插件根本不加载。
    //   我一度以为改 Termux 容器里的那份就行 —— 那是**另一个实例**，
    //   APK 用的是自己独立解压的 rootfs，两边互不相干。
    //
    // ⇒ 做法：把插件作为**独立小资产**（67 KB）随包带上，
    //   首启解压到 rootfs 的 `/root/plugin-src`，并往 profile 里写一条 link 依赖。
    //   ★ 不重打 392 MB 的 rootfs，也不增加多少体积。
    // ------------------------------------------------------------------
    static final String ASSET_ADAPT = "mobile-adapt.gz.bin";
    /** 插件在容器里的落点。profile 用 `link:` 指过来。 */
    static final String ADAPT_DIR = "root/plugin-src";
    /** ★ 资产里条目的顶层前缀。tar 内路径是 `plugin-src/lib/client.js`，
     *  而落点必须是 `rootfs/root/plugin-src/...` ⇒ 解压后需要**再挪一层**。 */
    static final String ADAPT_TAR_PREFIX = "plugin-src";
    static final String ADAPT_NAME = "dsh-mobile-adaption";
    /**
     * ★★★ 插件内容版本戳。**每次改插件源码必须 +1**。
     *
     * 为什么必须有：`isAdaptInstalled()` 只看"文件在不在、名字对不对"，
     * 而 APK 升级时插件源码可能已经换了 ⇒ 不重装就还是旧的。
     * 踩过：改完 bug 出了新包，装上却还是老行为，因为判定"已装好"直接跳过了。
     */
    static final int ADAPT_BUILD = 33;
    static final String ADAPT_STAMP = ".adapt-build";

    static File adaptDir(Context c) { return new File(Cfg.rootfs(c), ADAPT_DIR); }

    /** 资产解压时的临时落点（rootfs 根下）。解完再整目录搬到 ADAPT_DIR。 */
    private static File adaptStaging(Context c) {
        return new File(Cfg.rootfs(c), ADAPT_TAR_PREFIX);
    }

    static boolean isAdaptInstalled(Context c) {
        File d = adaptDir(c);
        File client = new File(d, "lib/client.js");
        File pkg = new File(d, "package.json");
        if (!client.exists() || client.length() < 1000) return false;
        if (!pkg.exists()) return false;
        // ★ 判据看**包名对不对**（改过名，别只看文件在不在 —— 名字不对照样不加载）
        String t = readText(pkg, 4096);
        boolean ok = t.contains("\"" + ADAPT_NAME + "\"");
        if (!ok) Cfg.log(c, "插件 package.json 里的名字不是 " + ADAPT_NAME);
        // ★★ 2026-10-20 追加：**profile 必须能解析**。
        //   踩过：插件文件装对了，但 profile 被上一版写坏（尾逗号）⇒
        //   容器起不来。只看"插件在不在"会把这种情况判成"已装好"，
        //   于是永远跳过修复，永远起不来。
        if (ok && !profileIsHealthy(c)) {
            Cfg.log(c, "⚠️ profile 无法解析 ⇒ 视为未装好，将重新修复");
            return false;
        }
        // ★★ node_modules 里必须有一份**真实副本** —— 否则 profile 写了也没用
        //   （DSH 会 `skipping profile bundle ... cannot resolve`）。
        //   ★ 2026-10-20：从"符号链接"改成"真实目录复制" —— 更稳，见 linkIntoNodeModules 注释。
        if (ok) {
            File nmPkg = new File(new File(Cfg.dshHome(c), "profiles/web/node_modules"), ADAPT_NAME);
            boolean present = !Files.isSymbolicLink(nmPkg.toPath())
                    && new File(nmPkg, "package.json").exists()
                    && new File(nmPkg, "lib/client.js").exists();
            if (!present) {
                Cfg.log(c, "⚠️ node_modules 里没有 " + ADAPT_NAME + " 的实体副本 ⇒ 视为未装好");
                return false;
            }
        }
        // ★★ 版本戳：源码改过就必须重装（否则新包还在跑老插件）
        if (ok) {
            File stamp = new File(adaptDir(c), ADAPT_STAMP);
            String want = String.valueOf(ADAPT_BUILD);
            if (!stamp.exists() || !want.equals(readText(stamp, 64).trim())) {
                Cfg.log(c, "⚠️ 插件版本戳不符（期望 " + want + "）⇒ 重装");
                return false;
            }
        }
        return ok;
    }

    /** profile 是否存在且能被解析。不存在也算"健康"（首启会新建）。 */
    static boolean profileIsHealthy(Context c) {
        File pf = new File(new File(Cfg.dshHome(c), "profiles/web"), "package.json");
        if (!pf.exists()) return true;
        String t = readText(pf, 1 << 20);
        if (t.isEmpty()) return true;
        try {
            MiniJson.parse(t);
            return true;
        } catch (Throwable ex) {
            return false;
        }
    }

    /**
     * 修复坏掉的 profile：**直接删掉它**，让 DSH 首启重新生成一份官方的，
     * 然后我们再补丁。★ 删之前先备份成 `.broken-<时间戳>`，便于事后取证。
     */
    private static void healBrokenProfile(Context c) {
        File pf = new File(new File(Cfg.dshHome(c), "profiles/web"), "package.json");
        if (!pf.exists()) return;
        if (profileIsHealthy(c)) return;
        String ts = new java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US)
                .format(new java.util.Date());
        File bak = new File(pf.getParentFile(), "package.json.broken-" + ts);
        try {
            Files.copy(pf.toPath(), bak.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            Cfg.log(c, "坏 profile 已备份: " + bak.getName());
        } catch (Exception ignored) {
        }
        //noinspection ResultOfMethodCallIgnored
        pf.delete();
        Cfg.log(c, "已删除坏 profile，交回官方重新生成");
    }

    static void installAdapt(Context c, Progress p) throws IOException {
        p.onProgress(0, "安装移动端适配插件…");

        // ⓪ ★ 先修坏掉的 profile（上一版用文本拼接写坏了，尾逗号）。
        //   ★ 必须在打补丁之前做 —— 否则解析失败就永远改不进去。
        healBrokenProfile(c);

        // ① ★ 清掉上一次可能留下的残局：
        //    · rootfs/plugin-src        —— 上一版解错位置的残留
        //    · rootfs/root/plugin-src   —— 名字不对 / 版本戳不对的旧版
        File prevStaging = adaptStaging(c);
        if (prevStaging.exists()) deleteTree(prevStaging);
        File prevDest = adaptDir(c);
        boolean fresh = false;
        if (prevDest.exists()) {
            File pkg = new File(prevDest, "package.json");
            File stamp = new File(prevDest, ADAPT_STAMP);
            boolean nameOk = pkg.exists() && readText(pkg, 4096).contains("\"" + ADAPT_NAME + "\"");
            boolean buildOk = stamp.exists()
                    && String.valueOf(ADAPT_BUILD).equals(readText(stamp, 64).trim());
            fresh = nameOk && buildOk;
            if (!fresh) {
                Cfg.log(c, "清理旧版插件目录（名字或版本不符，期望 build=" + ADAPT_BUILD + "）");
                deleteTree(prevDest);
            }
        }

        // ② 只有"内容确实是最新版"才跳过解压
        if (!fresh) {
            int n = 0;
            try (InputStream raw = c.getAssets().open(ASSET_ADAPT)) {
                TarReader tar = new TarReader(new GZIPInputStream(
                        new BufferedInputStream(raw, 1 << 16), 1 << 16));
                TarReader.Entry e;
                while ((e = tar.next()) != null) {
                    extract(Cfg.rootfs(c), e, tar);
                    n++;
                }
            }
            Cfg.log(c, "移动端插件解压完成，条目=" + n);

            // ③ ★★ 挪到正确位置：rootfs/plugin-src → rootfs/root/plugin-src
            //   2026-10-20 踩过：不挪的话文件落在 rootfs 根，而 profile 的 link 指向
            //   /root/plugin-src ⇒ 校验失败（日志里表现为「包名不对」，极易误判成改名没生效）。
            File staging = adaptStaging(c);
            File dest = adaptDir(c);
            if (staging.exists()) {
                //noinspection ResultOfMethodCallIgnored
                dest.mkdirs();
                File[] kids = staging.listFiles();
                if (kids != null) {
                    for (File k : kids) {
                        File to = new File(dest, k.getName());
                        if (to.exists()) deleteTree(to);
                        if (!k.renameTo(to)) {
                            copyTree(k, to);
                            deleteTree(k);
                        }
                    }
                }
                //noinspection ResultOfMethodCallIgnored
                staging.delete();
                Cfg.log(c, "插件已安置到 " + dest.getAbsolutePath());
            }
        } else {
            Cfg.log(c, "插件文件已是正确版本，跳过解压");
        }

        // ④ ★★ 落盘后**先验文件**再改 profile。
        //   2026-10-20 踩过：解压后没验，直接把 link: 写进 profile，
        //   结果容器起不来只显示「容器已退出」，什么线索都没有。
        File dest = adaptDir(c);
        File client = new File(dest, "lib/client.js");
        File pkg = new File(dest, "package.json");
        if (!client.exists() || client.length() < 1000
                || !pkg.exists() || !readText(pkg, 4096).contains("\"" + ADAPT_NAME + "\"")) {
            Cfg.log(c, "❌ 插件文件校验失败，**不改 profile**（宁可不装，也不能把容器搞挂）");
            p.onProgress(100, "插件安装失败，已跳过");
            return;
        }
        Cfg.log(c, "插件文件校验通过: " + dest.getAbsolutePath());

        // ★ 写版本戳（最后一步，只有走到这里才算"这次装的是新版"）
        try {
            writeText(new File(dest, ADAPT_STAMP), String.valueOf(ADAPT_BUILD));
        } catch (Exception ex) {
            Cfg.log(c, "⚠️ 写版本戳失败: " + ex);
        }

        // ⑤ ★ profile 改动失败绝不能阻断启动 —— 顶多插件不生效，容器要能跑
        try {
            patchProfile(c);
        } catch (Throwable t) {
            Cfg.log(c, "⚠️ profile 补丁失败（不影响启动）: " + t);
        }

        // ⑥ ★★★ 关键一步：**真的把 node_modules 链接建出来**。
        //
        //   2026-10-20 踩到：profile 里写了 `"dsh-mobile-adaption": "link:/root/plugin-src"`
        //   之后容器起来了，但 proot.log 里是：
        //     dsh: skipping profile bundle "dsh-mobile-adaption":
        //     Error: cannot resolve profile bundle ... from the dsh installation
        //            or /root/.dsh/profiles/web
        //
        //   原因：`link:` 只是 **pnpm/npm 的依赖声明**，它需要
        //   `profiles/web/node_modules/<name>` 真的存在一个指向源的链接。
        //   只写 package.json 而不建 node_modules ⇒ DSH 解析不到 ⇒ **整个插件被跳过**。
        //   （这也解释了为什么界面看起来和没装插件时一样。）
        //
        //   ★ 它必须独立于 patchProfile：patchProfile 有"已含就跳过"的短路，
        //     而链接可能因为各种原因缺失（比如上一次 patchProfile 成功但建链接失败）。
        linkIntoNodeModules(c);

        /* ⑦ pnpm 的「最小发布年龄」修正在**容器内**做，由
         *   DshService.bootContainer() 无条件调用 fixPnpmWorkspaceBeforeBoot()。
         *   ★ 不放这里的原因：installAdapt 只在"插件没装好"时才被调用，
         *     插件已装好时整段跳过 ⇒ 补丁永远跑不到（踩过）。 */

        p.onProgress(100, "移动端插件已就位");
    }

    private static void copyTree(File from, File to) throws IOException {
        if (from.isDirectory()) {
            //noinspection ResultOfMethodCallIgnored
            to.mkdirs();
            File[] kids = from.listFiles();
            if (kids != null) for (File k : kids) copyTree(k, new File(to, k.getName()));
        } else {
            File parent = to.getParentFile();
            if (parent != null && !parent.exists()) //noinspection ResultOfMethodCallIgnored
                parent.mkdirs();
            Files.copy(from.toPath(), to.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static void deleteTree(File f) {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /**
     * 往 <dshhome>/profiles/web/package.json 里注册插件。
     *
     * ★★★ 2026-10-20 血泪教训：**第一版用文本拼接，把 JSON 写坏了** ——
     *   `dependencies` 原本是空对象 `{}`，我往里插
     *   `"dsh-mobile-adaption": "link:...",` 之后**多了一个尾逗号**：
     *   ```
     *   "dependencies": { "dsh-mobile-adaption": "link:/root/plugin-src",},
     *   ```
     *   Node 的 JSON.parse 直接报 `Expected double-quoted property name`
     *   ⇒ 容器起不来，界面只显示「容器已退出」，**没有任何线索**
     *   （release 版不能 run-as，proot.log 也读不到 —— 后来镜像到 /sdcard 才看见）。
     *
     * ⇒ 现在的规矩：**改 JSON 必须保证结果可解析**。
     *   Android 没有内置 JSON 库，所以这里自己写一个小小的"够用"的序列化器：
     *   解析出顶层对象 → 改两个字段 → 重新序列化。
     *   ★ 只支持 profile 实际用到的类型（对象/数组/字符串/数字/布尔/null），
     *     够用，而且**永远不会产生尾逗号**。
     */
    private static void patchProfile(Context c) throws IOException {
        File dir = new File(Cfg.dshHome(c), "profiles/web");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File pf = new File(dir, "package.json");

        String linkPath = "/root/plugin-src";
        String depLine = "\"" + ADAPT_NAME + "\": \"link:" + linkPath + "\"";

        if (!pf.exists()) {
            // ★ 不存在就造一份最小值（官方首次启动会在此基础上合并）
            String json = "{\n"
                    + "  \"name\": \"dsh-profile-web\",\n"
                    + "  \"private\": true,\n"
                    + "  \"dependencies\": {\n    " + depLine + "\n  },\n"
                    + "  \"dsh\": {\n"
                    + "    \"profile\": {\n"
                    + "      \"bundles\": [\n"
                    + "        \"@deepseek-ai/dsh-base\",\n"
                    + "        \"@deepseek-ai/dsh-web-app\",\n"
                    + "        \"" + ADAPT_NAME + "\"\n"
                    + "      ]\n"
                    + "    }\n"
                    + "  }\n"
                    + "}\n";
            writeText(pf, json);
            Cfg.log(c, "profile 不存在，已新建并写入 " + ADAPT_NAME);
            return;
        }

        String t = readText(pf, 1 << 20);
        if (t.contains("\"" + ADAPT_NAME + "\"")) {
            Cfg.log(c, "profile 已含 " + ADAPT_NAME + "，跳过");
            return;
        }

        // ★ 先看原文件本身能不能解析。解析不了就别动它（宁可插件不生效）
        Object root;
        try {
            root = MiniJson.parse(t);
        } catch (Throwable ex) {
            Cfg.log(c, "⚠️ 现有 profile 无法解析，不敢改：" + ex.getMessage());
            return;
        }
        if (!(root instanceof java.util.Map)) {
            Cfg.log(c, "⚠️ profile 顶层不是对象，不敢改");
            return;
        }
        @SuppressWarnings("unchecked")
        java.util.Map<String, Object> obj = (java.util.Map<String, Object>) root;

        // ① dependencies
        Object depObj = obj.get("dependencies");
        java.util.Map<String, Object> dep;
        if (depObj instanceof java.util.Map) {
            @SuppressWarnings("unchecked")
            java.util.Map<String, Object> m = (java.util.Map<String, Object>) depObj;
            dep = m;
        } else {
            dep = new java.util.LinkedHashMap<>();
            obj.put("dependencies", dep);
        }
        dep.put(ADAPT_NAME, "link:" + linkPath);

        // ② dsh.profile.bundles
        Object dshObj = obj.get("dsh");
        java.util.Map<String, Object> dsh;
        if (dshObj instanceof java.util.Map) {
            @SuppressWarnings("unchecked")
            java.util.Map<String, Object> m = (java.util.Map<String, Object>) dshObj;
            dsh = m;
        } else {
            dsh = new java.util.LinkedHashMap<>();
            obj.put("dsh", dsh);
        }
        Object profObj = dsh.get("profile");
        java.util.Map<String, Object> prof;
        if (profObj instanceof java.util.Map) {
            @SuppressWarnings("unchecked")
            java.util.Map<String, Object> m = (java.util.Map<String, Object>) profObj;
            prof = m;
        } else {
            prof = new java.util.LinkedHashMap<>();
            dsh.put("profile", prof);
        }
        Object bunObj = prof.get("bundles");
        java.util.List<Object> bundles;
        if (bunObj instanceof java.util.List) {
            @SuppressWarnings("unchecked")
            java.util.List<Object> l = (java.util.List<Object>) bunObj;
            bundles = l;
        } else {
            bundles = new java.util.ArrayList<>();
            prof.put("bundles", bundles);
        }
        if (!bundles.contains(ADAPT_NAME)) bundles.add(ADAPT_NAME);

        // ③ 重新序列化（缩进 2 空格，与官方一致；★ 不可能产生尾逗号）
        String out = MiniJson.stringify(obj, 2) + "\n";

        // ④ ★ 写完再自查一遍：解析不回来就回滚，绝不留下坏文件
        try {
            MiniJson.parse(out);
        } catch (Throwable ex) {
            Cfg.log(c, "❌ 序列化结果自检失败，回滚 profile: " + ex.getMessage());
            return;
        }

        writeText(pf, out);
        Cfg.log(c, "profile 已写入 " + ADAPT_NAME + "，bundles=" + bundles.size());
    }

    /**
     * 把插件**真的复制**到 <dshhome>/profiles/web/node_modules/<name>。
     *
     * ★★★ 2026-10-20 用户点醒：**别搞链接，直接复制目录**。
     *
     *   我先前的做法是在 node_modules 里建符号链接 → `/root/plugin-src`。
     *   它能用，但很脆：
     *     · 链接目标是**容器内的绝对路径**，在宿主上看根本不存在；
     *     · 宿主/容器的路径前缀一旦不一致（改 bind、换 rootfs 布局），立刻断；
     *     · 排查时看到的是一个"指不出去"的链接，很难判断。
     *
     *   而插件总共只有 ~190 KB ⇒ **直接复制**，代价几乎为零，
     *   换来的是：node_modules 里是一份**自洽的真实包**，
     *   和 pnpm 装出来的结构完全一样，不依赖任何外部路径。
     *
     *   ★ 还顺带解决了"profile 里 link: 协议"的语义负担 ——
     *     package.json 里仍写 `link:` 是给 pnpm 看的（它不会再跑一遍），
     *     DSH 实际解析的就是 node_modules 里这份实体。
     */
    private static void linkIntoNodeModules(Context c) {
        File nm = new File(new File(Cfg.dshHome(c), "profiles/web"), "node_modules");
        //noinspection ResultOfMethodCallIgnored
        nm.mkdirs();
        File target = new File(nm, ADAPT_NAME);
        File src = adaptDir(c);

        try {
            // 清掉旧链接 / 旧目录（上一版建的是符号链接）
            if (Files.isSymbolicLink(target.toPath())) {
                //noinspection ResultOfMethodCallIgnored
                target.delete();
                Cfg.log(c, "清掉旧符号链接: " + ADAPT_NAME);
            } else if (target.exists()) {
                deleteTree(target);
            }
            copyTree(src, target);
            // ★ 校验：三样东西都在才算成功
            boolean ok = new File(target, "package.json").exists()
                    && new File(target, "lib/client.js").exists()
                    && new File(target, "lib/index.js").exists()
                    && new File(target, "cordis.patch.yml").exists();
            Cfg.log(c, (ok ? "已复制插件到 node_modules: " : "❌ 复制后校验失败: ")
                    + target.getAbsolutePath()
                    + " (package.json + lib/client.js + lib/index.js + cordis.patch.yml)");
        } catch (Exception ex) {
            Cfg.log(c, "❌ 复制插件到 node_modules 失败: " + ex);
        }

        installAndroidBridgeCli(c, target);
    }

    /* ★★★ 2026-10-20：把容器内的 `dsh-android` 命令装到 PATH 上。
     *
     * 做什么：
     *   · 从插件目录里的 `android-bridge/dsh-android.js` 取脚本
     *   · 在 `/opt/node/bin/dsh-android` 写一个 sh 包装器（node 执行它）
     *   · chmod +x
     *
     * 为什么放 /opt/node/bin：那里**本来就在 PATH 里**
     *   （ProotLauncher 的 PATH 含 /opt/node/bin），且是 rootfs 内
     *   真实可写目录（不像 /sdcard 是 FUSE、chmod +x 不生效）。
     *
     * ★ 失败不影响插件本身 —— 只是没有 Android 能力。 */
    private static void installAndroidBridgeCli(Context c, File pluginDir) {
        try {
            File src = new File(pluginDir, "android-bridge/dsh-android.js");
            if (!src.exists()) {
                Cfg.log(c, "android-bridge 脚本不存在，跳过 CLI 安装");
                return;
            }
            File binDir = new File(Cfg.rootfs(c), "opt/node/bin");
            if (!binDir.exists()) binDir.mkdirs();

            // 脚本本体放到 node_modules 之外，避免被插件更新覆盖
            File home = new File(Cfg.rootfs(c), "root/.dsh-android");
            if (!home.exists()) home.mkdirs();
            File js = new File(home, "dsh-android.js");
            Files.copy(src.toPath(), js.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);

            // 包装器：用绝对路径调 node，避免依赖 PATH
            File sh = new File(binDir, "dsh-android");
            writeText(sh, "#!/bin/sh\n"
                    + "exec /opt/node/bin/node /root/.dsh-android/dsh-android.js \"$@\"\n");
            //noinspection ResultOfMethodCallIgnored
            sh.setExecutable(true, false);
            //noinspection ResultOfMethodCallIgnored
            sh.setReadable(true, false);

            Cfg.log(c, "已安装 Android 桥 CLI: " + sh.getAbsolutePath()
                    + "（executable=" + sh.canExecute() + "）");
        } catch (Throwable t) {
            Cfg.log(c, "⚠️ 安装 Android 桥 CLI 失败: " + t);
        }
    }

    /**
     * 极小的 JSON 解析 / 序列化器（只为 profile 服务）。
     * ★ 为什么不用 Gson/org.json：Android 框架自带的 `org.json` 序列化时
     *   会对 key 排序、并可能改变转义风格；而这份 profile 是**官方写的**，
     *   我们只想"原样改两个字段"，不希望顺手把其它内容重排。
     *   自己实现可以保证：**输入输出都合法、不产生尾逗号、保持插入顺序**。
     */
    static final class MiniJson {
        private final String s;
        private int i;

        private MiniJson(String s) { this.s = s; this.i = 0; }

        static Object parse(String text) {
            MiniJson p = new MiniJson(text);
            p.ws();
            Object v = p.value();
            p.ws();
            if (p.i < p.s.length()) throw new IllegalArgumentException("尾部有多余内容 @" + p.i);
            return v;
        }

        private void ws() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }

        private Object value() {
            if (i >= s.length()) throw new IllegalArgumentException("意外结束");
            char ch = s.charAt(i);
            switch (ch) {
                case '{': return object();
                case '[': return array();
                case '"': return string();
                case 't': expect("true"); return Boolean.TRUE;
                case 'f': expect("false"); return Boolean.FALSE;
                case 'n': expect("null"); return null;
                default: return number();
            }
        }

        private void expect(String lit) {
            if (!s.startsWith(lit, i)) throw new IllegalArgumentException("期望 " + lit + " @" + i);
            i += lit.length();
        }

        private java.util.Map<String, Object> object() {
            java.util.Map<String, Object> m = new java.util.LinkedHashMap<>();
            i++; // {
            ws();
            if (i < s.length() && s.charAt(i) == '}') { i++; return m; }
            while (true) {
                ws();
                if (i >= s.length() || s.charAt(i) != '"')
                    throw new IllegalArgumentException("对象键必须是字符串 @" + i);
                String k = string();
                ws();
                if (i >= s.length() || s.charAt(i) != ':')
                    throw new IllegalArgumentException("缺少冒号 @" + i);
                i++;
                ws();
                m.put(k, value());
                ws();
                if (i >= s.length()) throw new IllegalArgumentException("对象未闭合");
                char c = s.charAt(i);
                if (c == ',') { i++; continue; }
                if (c == '}') { i++; return m; }
                throw new IllegalArgumentException("对象内意外字符 " + c + " @" + i);
            }
        }

        private java.util.List<Object> array() {
            java.util.List<Object> l = new java.util.ArrayList<>();
            i++; // [
            ws();
            if (i < s.length() && s.charAt(i) == ']') { i++; return l; }
            while (true) {
                ws();
                l.add(value());
                ws();
                if (i >= s.length()) throw new IllegalArgumentException("数组未闭合");
                char c = s.charAt(i);
                if (c == ',') { i++; continue; }
                if (c == ']') { i++; return l; }
                throw new IllegalArgumentException("数组内意外字符 " + c + " @" + i);
            }
        }

        private String string() {
            StringBuilder b = new StringBuilder();
            i++; // "
            while (i < s.length()) {
                char c = s.charAt(i++);
                if (c == '"') return b.toString();
                if (c == '\\') {
                    if (i >= s.length()) break;
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"': b.append('"'); break;
                        case '\\': b.append('\\'); break;
                        case '/': b.append('/'); break;
                        case 'b': b.append('\b'); break;
                        case 'f': b.append('\f'); break;
                        case 'n': b.append('\n'); break;
                        case 'r': b.append('\r'); break;
                        case 't': b.append('\t'); break;
                        case 'u':
                            if (i + 4 > s.length()) throw new IllegalArgumentException("\\u 不完整");
                            b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                            i += 4;
                            break;
                        default: throw new IllegalArgumentException("未知转义 \\" + e);
                    }
                } else b.append(c);
            }
            throw new IllegalArgumentException("字符串未闭合");
        }

        private Object number() {
            int st = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            if (st == i) throw new IllegalArgumentException("非法字符 @" + st);
            String num = s.substring(st, i);
            if (num.indexOf('.') < 0 && num.indexOf('e') < 0 && num.indexOf('E') < 0) {
                try { return Long.parseLong(num); } catch (NumberFormatException ignored) { }
            }
            return Double.parseDouble(num);
        }

        static String stringify(Object v, int indent) {
            StringBuilder b = new StringBuilder();
            write(b, v, indent, 0);
            return b.toString();
        }

        private static void pad(StringBuilder b, int n) {
            for (int k = 0; k < n; k++) b.append(' ');
        }

        @SuppressWarnings("unchecked")
        private static void write(StringBuilder b, Object v, int indent, int depth) {
            if (v == null) { b.append("null"); return; }
            if (v instanceof String) { esc(b, (String) v); return; }
            if (v instanceof Boolean || v instanceof Number) { b.append(v); return; }
            if (v instanceof java.util.Map) {
                java.util.Map<String, Object> m = (java.util.Map<String, Object>) v;
                if (m.isEmpty()) { b.append("{}"); return; }
                b.append("{\n");
                int n = 0;
                for (java.util.Map.Entry<String, Object> e : m.entrySet()) {
                    pad(b, (depth + 1) * indent);
                    esc(b, e.getKey());
                    b.append(": ");
                    write(b, e.getValue(), indent, depth + 1);
                    if (++n < m.size()) b.append(',');
                    b.append('\n');
                }
                pad(b, depth * indent);
                b.append('}');
                return;
            }
            if (v instanceof java.util.List) {
                java.util.List<Object> l = (java.util.List<Object>) v;
                if (l.isEmpty()) { b.append("[]"); return; }
                b.append("[\n");
                for (int k = 0; k < l.size(); k++) {
                    pad(b, (depth + 1) * indent);
                    write(b, l.get(k), indent, depth + 1);
                    if (k + 1 < l.size()) b.append(',');
                    b.append('\n');
                }
                pad(b, depth * indent);
                b.append(']');
                return;
            }
            esc(b, String.valueOf(v));
        }

        private static void esc(StringBuilder b, String s) {
            b.append('"');
            for (int k = 0; k < s.length(); k++) {
                char c = s.charAt(k);
                switch (c) {
                    case '"': b.append("\\\""); break;
                    case '\\': b.append("\\\\"); break;
                    case '\n': b.append("\\n"); break;
                    case '\r': b.append("\\r"); break;
                    case '\t': b.append("\\t"); break;
                    default:
                        if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                        else b.append(c);
                }
            }
            b.append('"');
        }
    }

    private static String readText(File f, int cap) {
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[Math.min(cap, (int) Math.max(1, f.length()))];
            int off = 0, r;
            while (off < buf.length && (r = in.read(buf, off, buf.length - off)) > 0) off += r;
            return new String(buf, 0, off, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    private static void writeText(File f, String s) throws IOException {
        try (OutputStream os = new FileOutputStream(f)) {
            os.write(s.getBytes(StandardCharsets.UTF_8));
        }
    }

    /* ======================================================================
     * ★★★ 2026-10-20：pnpm「最小发布年龄」限制的修复
     *
     * 用户报错原文：
     *   Cannot edit "minimumReleaseAgeExclude" in
     *   "/root/.dsh/profiles/web/pnpm-workspace.yaml": it uses an inline YAML
     *   value that cannot be edited in place (a multi-line flow collection,
     *   an alias, or a scalar). Reformat it to block style and try again.
     *   → dsh: plugin command failed; pnpm add -w 'dsh-ledger-memory@1.2.9'
     *
     * 机理：pnpm 默认开启 minimumReleaseAge（新包要「放一阵」才允许安装）。
     *   DSH 的插件管理器往 pnpm-workspace.yaml 写豁免名单时用**流式 YAML**
     *   （`minimumReleaseAgeExclude: [x, y]`），而 pnpm 内部更新该字段只支持
     *   **块式**（每项一行 `- x`）⇒ 报上面的错 ⇒ **所有插件都装不上**。
     *
     * 修法：**让它不产生这个字段**。
     *   ① 在 pnpm-workspace.yaml 里写 `minimumReleaseAge: 0`（关闭该策略）；
     *   ② 把已存在的 `minimumReleaseAgeExclude` 删掉（无论流式还是块式）；
     *   ③ 若 yaml 里已有流式的该字段，重写成块式再删，
     *      避免 pnpm 下次又因为"改不了"而报错。
     *
     * ★ 只动 pnpm-workspace.yaml 这一个文件，不碰 package.json。
     * ★ 全流程 try/catch，任何异常都不影响容器启动。
     * ====================================================================== */
    private static final String PNPM_WS = "profiles/web/pnpm-workspace.yaml";

    /* ======================================================================
     * ★★★ 2026-10-20：在**容器内**修 pnpm-workspace.yaml
     *
     * 为什么必须进容器：
     *   实测 `/root/.dsh` 在 Android 侧的权限是 `d---------`（000）——
     *   App 进程（uid 10420）连 ls 都做不到，更别说读写了。
     *   容器里 DSH 是以 root 跑的（root 可无视权限位），所以只有容器内能改。
     *
     * 做法：起一个**临时的 proot**（和主容器同一套 rootfs），
     *   跑一段 sh 脚本，把文件规整成 pnpm 能接受、DSH 也不会再撞墙的形态。
     *   ★ 这个临时 proot 很短命，跑完就退出，不影响随后启动的主容器。
     *
     * 修什么（用户报错）：
     *   Cannot edit "minimumReleaseAgeExclude" in
     *   "/root/.dsh/profiles/web/pnpm-workspace.yaml": it uses an inline YAML
     *   value that cannot be edited in place …
     *   → dsh: plugin command failed; pnpm add -w 'dsh-ledger-memory@1.2.9'
     *
     * 怎么修：
     *   ① 删掉 minimumReleaseAgeExclude（流式/块式都删）；
     *   ② 写 `minimumReleaseAge: 0` 关闭该策略 ⇒ pnpm 不再产生那个字段。
     *
     * ★ 用 printf 生成脚本再执行，避免多层引号被 shell 吃掉。
     * ====================================================================== */
    static void fixPnpmWorkspaceBeforeBoot(Context c) {
        try {
            File rootfs = Cfg.rootfs(c);

            /* ★★★ 路径必须走 **Android 侧**的 Cfg.dshHome()，不能用 rootfs/root/.dsh。
             *
             * 踩过：我一开始按"容器里的 /root/.dsh"去 rootfs 下找
             *   rootfs/root/.dsh/profiles/web/pnpm-workspace.yaml
             * 结果日志是「pnpm-workspace.yaml 尚未生成，跳过」——
             * 其实文件一直在，只是**真实位置**是：
             *   files/dshhome/profiles/web/pnpm-workspace.yaml
             * 因为 ProotLauncher 启动时做了 bind：
             *   --bind=<files/dshhome>:/root/.dsh
             * ⇒ 容器看到的 /root/.dsh 就是它，rootfs 里那个目录是空的。
             *
             * ★ 因此：
             *   · 判断"文件在不在" → 用 Android 侧 Files API（Cfg.dshHome）；
             *   · 真正的改写 → 仍要进容器（Android 侧权限是 000，root 才能写）。
             *     容器内路径依旧是 /root/.dsh/...（bind 之后它就是那个文件）。 */
            File wsAndroid = new File(Cfg.dshHome(c), PNPM_WS);
            if (!wsAndroid.exists()) {
                Cfg.log(c, "pnpm-workspace.yaml 尚未生成（DSH 还没初始化 profile），跳过 pnpm 限制修正");
                return;
            }
            Cfg.log(c, "准备修 pnpm 限制，目标=" + wsAndroid.getAbsolutePath());

            java.util.List<String> cmd = new java.util.ArrayList<>();
            cmd.add(ProotLauncher.prootPath(c));
            cmd.add("--link2symlink");
            cmd.add("--rootfs=" + Cfg.prootPathOf(rootfs));
            cmd.add("--cwd=/root");
            cmd.add("--bind=/dev");
            cmd.add("--bind=/proc");
            /* ★★★ 关键：把真实家目录 bind 进容器。
             * 这个临时 proot 是**独立新实例**，不像主容器那样自带 bind ——
             * 不挂这一条，容器里 /root/.dsh 是 rootfs 里的空目录，
             * 脚本会报 PNPM_WS_ABSENT（我第一版就是这么错的）。 */
            cmd.add("--bind=" + Cfg.prootPathOf(Cfg.dshHome(c)) + ":/root/.dsh");
            /* ★★★ 2026-10-20：**还必须把共享目录挂进来**。
             *
             * 踩过：这个临时 proot 是独立实例，不像主容器那样自带
             *   --bind=<shared>:/sdcard
             * 所以容器里 `/sdcard` 根本不存在，脚本里的
             *   mkdir -p /sdcard/DeepseekHarness/_dbg
             * 直接报 `mkdir: cannot create directory '/sdcard': Operation not permitted`
             * （rootfs 根是只读的，建不了顶层目录）。
             * ⇒ 导出/写回两个阶段都依赖 /sdcard，必须显式挂。 */
            cmd.add("--bind=" + Cfg.prootPathOf(Cfg.sharedRoot(c)) + ":/sdcard");
            cmd.add("/bin/sh");
            cmd.add("-c");

            /* 修正脚本（★ 2026-10-20 重写：上一版 sed 范围删除把整个文件删空了）
             *
             * 上一版错在哪：
             *   sed -i '/^minimumReleaseAgeExclude:/,+20{...}' ——
             *   "+20" 会从匹配行往后吃 20 行，而这个文件里 `packages:` 等配置
             *   就在附近 ⇒ **整份文件被删成只剩 allowBuilds**，
             *   用户的 pnpm 配置直接毁掉。
             *
             * 这一版的原则：**只做精确的整行删除，绝不按范围删**。
             *   ① 删掉所有以 minimumReleaseAgeExclude 开头的行（流式单行）；
             *   ② 删掉所有以 minimumReleaseAge: 开头的行（旧值）；
             *   ③ 追加 minimumReleaseAge: 0；
             *   ④ 改前先备份到 .bak，改完打印全文供核对。
             *   ★ 流式多行（`[...` 换行 `]`）这种形态这里不尝试修补 ——
             *     pnpm 一旦报那个错，说明它已经写进去了；我们删掉整行后
             *     剩下的孤立 `]` 会在下一步用 awk 收尾时清掉。
             */
            /* ★★★ 2026-10-20 补救：如果上一次是**被旧版脚本改坏**的，先用 .bak 还原。
             * 判据：文件里既没有 `packages:` 也没有 `nodeLinker:`（正常文件必有其一），
             * 但存在 .bak ⇒ 说明上次删过头了，还原它再重新处理。
             * ★ 这段必须在新脚本之前跑，否则会在坏文件上继续改。 */
            String sh =
                    "W=/root/.dsh/profiles/web/pnpm-workspace.yaml; "
                  + "if [ ! -f $W ]; then echo PNPM_WS_ABSENT; exit 0; fi; "
                  // 顺手把插件管理器最近一次的失败日志导出到共享目录，便于定位
                  + "L=/root/.dsh/profiles/web/.plugin-manager/logs; "
                  + "OUT=/sdcard/DeepseekHarness/_dbg; mkdir -p $OUT 2>/dev/null; "
                  + "if [ -d $L ]; then "
                  + "  for d in $(ls -1t $L 2>/dev/null | head -3); do "
                  + "    cp $L/$d/*.log $OUT/plug-$d.log 2>/dev/null && echo EXPORTED:$d; "
                  + "  done; "
                  + "fi; "
                  /* ★ 顺带清掉 rootfs 里可能残留的 npm 明文令牌（老设备已经解压过的那份）。 */
                  + "N=/root/.npmrc; "
                  + "if [ -f $N ] && grep -q 'authToken' $N 2>/dev/null; then "
                  + "  grep -v 'authToken' $N > $N.new && mv $N.new $N && echo NPMRC_TOKEN_CLEARED; "
                  + "fi; "
                  + "if [ -f $W.bak ]; then "
                  + "  if ! grep -qE '^(packages|nodeLinker):' $W && grep -qE '^(packages|nodeLinker):' $W.bak; then "
                  + "    cp $W.bak $W && echo HEALED_FROM_BAK; "
                  + "  fi; "
                  + "fi; "
                  + "cp $W $W.bak2 && echo BACKUP_OK || echo BACKUP_FAIL; "
                  // ① ② 精确整行删除（不用范围删除！）
                  + "grep -v '^[[:space:]]*minimumReleaseAgeExclude:' $W.bak "
                  + "  | grep -v '^[[:space:]]*minimumReleaseAge:' "
                  + "  > $W.tmp1; "
                  // ③ 清掉可能残留的孤立流式括号行（只有在 exclude 被删后才可能出现）
                  + "awk 'BEGIN{skip=0} "
                  + "  /^[[:space:]]*\\][[:space:]]*$/{next} "
                  + "  {print}' $W.tmp1 > $W.tmp2; "
                  // ④ 追加设置
                  + "cp $W.tmp2 $W; "
                  + "printf '\\nminimumReleaseAge: 0\\n' >> $W; "
                  + "rm -f $W.tmp1 $W.tmp2; "
                  /* ★★★ 2026-10-20（关键修法）：把 **JSON 风格 YAML 转成块式 YAML**。
                   *
                   * 真根因（用户截图为证）：
                   *   pnpm 报 "it uses an inline YAML value that cannot be edited
                   *   in place (a multi-line flow collection, an alias, or a scalar)"。
                   *   注意它说**包括 scalar** —— 也就是说我们补的 `minimumReleaseAge: 0`
                   *   同样"不可原地编辑"。真正的原因是**整个文件是 JSON 风格**：
                   *     {
                   *       allowBuilds:
                   *         { "@google/genai@1.52.0": true }
                   *     }
                   *   外层那一对大括号就是"flow collection"⇒ pnpm 的 YAML 结构化编辑器
                   *   无法对它做原地修改 ⇒ 任何插件都装不上。
                   *
                   * 修法：去掉最外层 `{ }`，把内部缩进减 2 格，变成普通块式 YAML。
                   *   · 只处理"**整个文件就是一个大括号块**"这一种形态（我们的目标场景）；
                   *   · 若文件本来就不是 JSON 风格，这段什么都不做。
                   *   · 改完仍走后面的自检，不合格自动还原。 */
                  /* ★ 判据只看**第一行是不是 `{`** —— 具体是不是 JSON 风格
                     交给 Java 侧的 jsonStyleToBlock() 去判断（它有大括号配平逻辑）。
                     ★ 上一版这里还要求"最后一行是 }"，但我自己往末尾追加过
                      minimumReleaseAge: 0 ⇒ 永远判不中（日志里一直是 IS_BLOCK_STYLE）。
                     现在无条件把文件导出，让 Java 决定要不要转。 */
                  /* ★★ 2026-10-20 改用 **rootfs 内的临时目录** 做中转，不走共享存储。
                   *
                   * 踩过：`cp` 到 /sdcard 虽返回 0（&& echo EXPORTED_FOR_JAVA 打出来了），
                   * 但文件**根本没落盘** —— 共享存储是 FUSE，临时 proot 里写入不生效。
                   * ⇒ 改成写到 rootfs/root/_wsxfer/（容器内真实可写、Android 侧也能读）。 */
                  + "mkdir -p /root/_wsxfer; "
                  + "cp $W /root/_wsxfer/ws-before.yaml "
                  + "&& echo EXPORTED_FOR_JAVA || echo EXPORT_FAIL; "
                  + "ls -la /root/_wsxfer/ 2>&1; "
                  + "echo ---WS-BEFORE---; cat $W; echo ---WS-END---";

            cmd.add(sh);

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            ProotLauncher.applyEnv(pb, c);

            Process p = pb.start();
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    sb.append(line).append('\n');
                    if (sb.length() > 4000) break;      // 防御：绝不刷爆日志
                }
            }
            p.waitFor();
            Cfg.log(c, "[pnpm 修正] " + sb.toString().replace("\n", " | "));

            /* ★★★ 第二阶段：Java 侧做 JSON→块式 转换，再写回容器。
             *
             * 为什么不在 shell 里一次做完：把 JSON 风格 YAML 转成块式 YAML
             * 涉及"按嵌套深度重算缩进"，写成多行 awk 既难读也难验证。
             * Java 这边有同名方法的单测（PC 上 3 组用例全过），
             * 而且失败能打日志。
             *
             * 流程：
             *   ① 读 files/dshHome/.../pnpm-workspace.yaml（Android 侧可读）；
             *   ② jsonStyleToBlock() 转换；
             *   ③ 若确有变化 ⇒ 写到共享目录的临时文件；
             *   ④ 容器内 cp 覆盖回去（容器里是 root，能写 000 权限的目录）。
             */
            try {
                /* ★★ 读**共享目录里的副本**，不读 wsAndroid。
                 *
                 * 踩过：`wsAndroid.exists()` 在 Android 侧返回 false
                 * （/root/.dsh 权限 000，App 进程 uid 读不到），
                 * 于是整段转换被跳过 —— 日志里只有 WS-BEFORE，没有"已生成块式"。
                 * 而阶段一已经让容器把文件 cp 到 /sdcard/_dbg/ws-before.yaml，
                 * 那一份**一定可读**，就用它。 */
                /* ★★ 2026-10-20：中转改走 **rootfs 内的目录**，不再用共享存储。
                 * 踩过：写到 /sdcard 的 cp 返回成功、&& 也打印了，
                 * 但文件在 FUSE 上根本不存在（临时 proot 里写共享存储不生效）。
                 * rootfs/root/_wsxfer 是容器内真实可写、Android 侧也能直接读。 */
                File exported = new File(rootfs, "root/_wsxfer/ws-before.yaml");
                if (!exported.exists()) {
                    Cfg.log(c, "⚠️ 没找到 " + exported.getAbsolutePath() + "，跳过 Java 转换");
                    return;
                }
                String orig = new String(java.nio.file.Files.readAllBytes(exported.toPath()),
                        StandardCharsets.UTF_8);
                Cfg.log(c, "读到导出的 YAML，" + orig.length() + " 字符，开始判断形态");
                String conv = jsonStyleToBlock(orig);
                if (!conv.equals(orig)) {
                    File staging = new File(rootfs, "root/_wsxfer/ws-new.yaml");
                    //noinspection ResultOfMethodCallIgnored
                    staging.getParentFile().mkdirs();
                    writeText(staging, conv);
                    Cfg.log(c, "已生成块式 YAML，准备写回容器（原 " + orig.length()
                            + " 字符 → 新 " + conv.length() + " 字符）");

                    // 容器内把它写回真实位置
                    java.util.List<String> cmd2 = new java.util.ArrayList<>();
                    cmd2.add(ProotLauncher.prootPath(c));
                    cmd2.add("--link2symlink");
                    cmd2.add("--rootfs=" + Cfg.prootPathOf(rootfs));
                    cmd2.add("--cwd=/root");
                    cmd2.add("--bind=/dev");
                    cmd2.add("--bind=/proc");
                    cmd2.add("--bind=" + Cfg.prootPathOf(Cfg.dshHome(c)) + ":/root/.dsh");
                    /* ★ 不需要再挂共享目录 —— 中转文件就在 rootfs 内
                     *   (root/_wsxfer/ws-new.yaml)，容器里天然可见。 */
                    cmd2.add("/bin/sh");
                    cmd2.add("-c");
                    cmd2.add("cp /root/_wsxfer/ws-new.yaml /root/.dsh/profiles/web/pnpm-workspace.yaml "
                           + "&& echo WRITTEN_BACK || echo WRITEBACK_FAIL; "
                           + "rm -rf /root/_wsxfer; "
                           + "echo ---WS-AFTER---; "
                           + "cat /root/.dsh/profiles/web/pnpm-workspace.yaml; "
                           + "echo ---WS-END---");

                    ProcessBuilder pb2 = new ProcessBuilder(cmd2);
                    pb2.redirectErrorStream(true);
                    ProotLauncher.applyEnv(pb2, c);
                    Process p2 = pb2.start();
                    StringBuilder sb2 = new StringBuilder();
                    try (BufferedReader r2 = new BufferedReader(
                            new InputStreamReader(p2.getInputStream(), StandardCharsets.UTF_8))) {
                        String line;
                        while ((line = r2.readLine()) != null) {
                            sb2.append(line).append(" | ");
                            if (sb2.length() > 3000) break;
                        }
                    }
                    p2.waitFor();
                    Cfg.log(c, "[pnpm 写回] " + sb2);
                } else {
                    Cfg.log(c, "pnpm-workspace.yaml 已是块式，无需转换");
                }
            } catch (Throwable t2) {
                Cfg.log(c, "⚠️ Java 侧转换/写回失败: " + t2);
            }
        } catch (Throwable t) {
            Cfg.log(c, "⚠️ fixPnpmWorkspaceBeforeBoot 失败（不影响启动）: " + t);
        }
    }

    /**
     * 把 **JSON 风格的 YAML** 转成**块式 YAML**。
     *
     * ★★★ 2026-10-20：true 根因就在这个方法存在的原因里。
     *
     * 用户设备上的 `/root/.dsh/profiles/web/pnpm-workspace.yaml` 长这样：
     * ```
     * {
     *   allowBuilds:
     *     {
     *       "@google/genai@1.52.0": true,
     *       protobufjs@7.6.6: true
     *     }
     * }
     * ```
     * 整份文件被一对 `{ }` 包着（flow collection）。pnpm 的 YAML 结构化编辑器
     * **无法对有 flow collection 的文件做原地修改**，于是报：
     *   Cannot edit "minimumReleaseAgeExclude" … it uses an inline YAML value
     *   that cannot be edited in place (a multi-line flow collection, an alias,
     *   or a scalar).
     *
     * ★ 注意它连 **scalar** 都算 —— 所以我之前补的 `minimumReleaseAge: 0`
     *   同样无效。**必须把整个文件变成块式**，这是唯一解法。
     *
     * 算法（不用"数大括号"的猜测，按嵌套深度重建缩进）：
     *   · 只处理"整份文件被一对 { } 包住"的形态，其它原样返回（绝不乱改）；
     *   · 跳过所有纯 `{` / `}` / `},` 标记行；
     *   · 维护 depth：最外层 { 不计，内层 { +1，} -1；
     *   · 每个键值行的缩进 = depth × 2 空格；
     *   · 去掉行尾逗号（JSON 遗留）。
     *
     * ★ 已在 PC 上用 Node 复现同一算法跑过 3 组用例（真实形态 / 已是块式 / 块式带设置），
     *   全部通过；「已是块式」必须**逐字不变**。
     */
    static String jsonStyleToBlock(String src) {
        String[] lines = src.split("\n", -1);

        // ① 找第一个非空行，必须是 `{`
        int startIdx = -1;
        for (int i = 0; i < lines.length; i++) {
            if (!lines[i].trim().isEmpty()) { startIdx = i; break; }
        }
        if (startIdx < 0 || !"{".equals(lines[startIdx].trim())) return src;  // 不是 JSON 风格

        /* ★★★ 2026-10-20：判据改成「**开头是 { 且大括号能配平**」，
         *   不再要求"最后一行是 }"。
         *
         * 踩过：上一版要求最后一行必须是 `}`，但我自己往文件末尾追加过
         * `minimumReleaseAge: 0` ⇒ 最后一行是它 ⇒ 判定失败 ⇒ 永远不转换。
         * 日志证据：`IS_BLOCK_STYLE` 但文件明明以 `{` 开头。
         *
         * ⇒ 正确做法：从 `{` 开始扫，维护 depth；
         *   depth 归零那一刻 = 最外层闭合 ⇒ 转换到此为止，
         *   **它之后的内容原样保留**（那就是我们追加的设置）。 */
        StringBuilder out = new StringBuilder();
        int depth = 0;
        boolean closed = false;
        int i = startIdx;

        for (; i < lines.length; i++) {
            String t = lines[i].trim();
            if (t.isEmpty()) continue;

            if ("{".equals(t)) { depth++; continue; }
            if ("}".equals(t) || "},".equals(t)) {
                depth--;
                if (depth == 0) { closed = true; i++; break; }  // 最外层闭合，结束
                continue;
            }

            // 键值行：缩进 = (depth - 1) 层（最外层 { 不算一层）
            String line = t.replaceAll(",[ \t]*$", "");
            for (int k = 0; k < Math.max(0, depth - 1); k++) out.append("  ");
            out.append(line).append('\n');
        }

        if (!closed) return src;      // 大括号没配平 ⇒ 不动

        // 把 } 之后的内容原样保留（我们追加的 minimumReleaseAge 就在那里）
        StringBuilder rest = new StringBuilder();
        for (int k = i; k < lines.length; k++) {
            if (!lines[k].trim().isEmpty()) rest.append(lines[k].trim()).append('\n');
        }
        String result = out.toString();
        if (rest.length() > 0) result += "\n" + rest;
        return result;
    }


    /** 阻塞操作（几百 MB），必须在后台线程调用。 */
    static void install(Context c, Progress p) throws IOException {
        File rootfs = Cfg.rootfs(c);
        File ready = Cfg.readyMarker(c);
        //noinspection ResultOfMethodCallIgnored
        ready.delete();

        long totalGz = assetSize(c, ASSET_GZ);
        if (totalGz == -2) throw new IOException("assets 里找不到 " + ASSET_GZ);

        int lastPct = -1;
        long entries = 0;

        try (InputStream raw = c.getAssets().open(ASSET_GZ)) {
            CountingInputStream counting = new CountingInputStream(
                    new BufferedInputStream(raw, 1 << 20));
            TarReader tar = new TarReader(new GZIPInputStream(counting, 1 << 20));

            TarReader.Entry e;
            while ((e = tar.next()) != null) {
                entries++;
                try {
                    extract(rootfs, e, tar);
                } catch (IOException ex) {
                    // 单个条目失败不该让整个安装挂掉（例如只读属性、已存在的链接）
                    Cfg.log(c, "跳过条目 " + e.name + " : " + ex.getMessage());
                    tar.skipEntryData();
                }

                int pct;
                if (totalGz > 0) {
                    pct = (int) (counting.count() * 100 / totalGz);
                } else {
                    pct = (int) (95 * entries / (entries + 4000.0));
                }
                if (pct != lastPct) {
                    lastPct = pct;
                    p.onProgress(Math.min(99, pct), "已展开 " + entries + " 项");
                }
            }
        }

        p.onProgress(100, "写入完成标记");

        /* ★★★ 2026-10-20：**从解压出来的 rootfs 里清掉 npm 明文令牌**。
         *
         * 发现：rootfs 的 `root/.npmrc` 里带着一条真实的
         *   //registry.npmjs.org/:_authToken=npm_xxx…
         * 这个文件会随 APK 分发给**每一个下载者** ⇒ 等于把 npm 账号公开。
         *
         * 处理：
         *   ① 保留 registry 设置（国内镜像，对用户有用）；
         *   ② **删掉 _authToken 那一行**（以及任何含 token/密码的行）。
         *
         * ★ 为什么不直接重打 rootfs.gz.bin：392 MB 的包重打一次要很久，
         *   而这是纯文本一行的删除 —— 解压后立即做，效果等价、代价近乎零。
         * ★ 无论 assets 里的原始 rootfs 有没有这条，这里都做一次"根治"，
         *   以后换 rootfs 也自动免疫。 */
        try {
            File npmrc = new File(rootfs, "root/.npmrc");
            if (npmrc.exists()) {
                StringBuilder keep = new StringBuilder();
                java.io.BufferedReader br = new java.io.BufferedReader(
                        new InputStreamReader(new FileInputStream(npmrc), StandardCharsets.UTF_8));
                String line;
                int dropped = 0;
                while ((line = br.readLine()) != null) {
                    String t = line.trim();
                    // 丢掉任何形如 xxx=_authToken / token / password 的行
                    if (t.matches("(?i).*(_authToken|_auth\\b|password|token)=.*")) {
                        dropped++;
                        continue;
                    }
                    keep.append(line).append('\n');
                }
                br.close();
                writeText(npmrc, keep.toString());
                Cfg.log(c, dropped > 0
                        ? "已从 rootfs/.npmrc 清除 " + dropped + " 条凭据（保留 registry）"
                        : "rootfs/.npmrc 无凭据，保持原样");
            }
        } catch (Throwable t) {
            Cfg.log(c, "⚠️ 清理 npmrc 凭据失败（不影响启动）: " + t);
        }

        try (FileOutputStream fos = new FileOutputStream(ready)) {
            fos.write("ok\n".getBytes());
        }
        Cfg.log(c, "解压完成，条目=" + entries);
    }

    private static void extract(File rootfs, TarReader.Entry e, TarReader tar) throws IOException {
        if (e.name.isEmpty()) return; // 顶层 "./"

        File out = new File(rootfs, e.name);

        switch (e.type) {
            case '5': // 目录
                //noinspection ResultOfMethodCallIgnored
                out.mkdirs();
                return;

            case '2': { // 符号链接
                File parent = out.getParentFile();
                if (parent != null && !parent.exists()) //noinspection ResultOfMethodCallIgnored
                    parent.mkdirs();
                //noinspection ResultOfMethodCallIgnored
                out.delete(); // 已存在就替换（重复安装场景）
                Path link = out.toPath();
                /* ★★★ 2026-10-20（真机崩溃后修，与 link() 同一根因）：
                 * `Path.of(...)` 是 Java 11 API，Android 到 API 33 才有。
                 * Android 10 上抛 NoSuchMethodError ⇒ **首启解压直接崩**。
                 * 改用 `new File(...).toPath()`（API 1 起就有）。 */
                Files.createSymbolicLink(link, new File(e.linkName).toPath());
                return;
            }

            case '1': { // 硬链接
                File parent = out.getParentFile();
                if (parent != null && !parent.exists()) //noinspection ResultOfMethodCallIgnored
                    parent.mkdirs();
                File target = new File(rootfs, sanitize(e.linkName));
                if (target.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    out.delete();
                    Files.createLink(out.toPath(), target.toPath());
                }
                return;
            }

            default: { // 普通文件（'0' / 0 / '7'）
                File parent = out.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs()) {
                    throw new IOException("无法创建目录: " + parent);
                }
                try (OutputStream os = new FileOutputStream(out)) {
                    tar.copyEntryDataTo(os, e.size);
                }
                if ((e.mode & 0111) != 0) {
                    //noinspection ResultOfMethodCallIgnored
                    out.setExecutable(true, false);
                }
            }
        }
    }

    /**
     * ★★ 坑：`openFd()` 在 asset **被压缩进 APK** 时会抛异常（要求 STORED + 对齐）。
     *   原实现用它取长度，失败就返回 -1，上层报「assets 里找不到 xxx」——
     *   **这个报错是误导性的**：asset 明明在，只是被 deflate 了。
     *   现在：openFd 失败时用 open() 探真存在性。
     */
    private static long assetSize(Context c, String name) {
        try {
            return c.getAssets().openFd(name).getLength();
        } catch (IOException e) {
            try (InputStream in = c.getAssets().open(name)) {
                return -1;
            } catch (IOException e2) {
                return -2;
            }
        }
    }

    static String sanitize(String name) {
        String n = name.replace('\\', '/');
        while (n.startsWith("./")) n = n.substring(2);
        while (n.startsWith("/")) n = n.substring(1);
        if (n.contains("..")) n = n.replace("..", "_");
        return n;
    }

    // ------------------------------------------------------------------

    private static final class CountingInputStream extends InputStream {
        private final InputStream in;
        private long count;
        CountingInputStream(InputStream in) { this.in = in; }
        long count() { return count; }
        @Override public int read() throws IOException {
            int b = in.read();
            if (b >= 0) count++;
            return b;
        }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            int n = in.read(b, off, len);
            if (n > 0) count += n;
            return n;
        }
        @Override public void close() throws IOException { in.close(); }
    }

    /** 极简 tar 解析。只认 普通文件 / 目录 / 符号链接 / 硬链接 / GNU 长名 / PAX。 */
    private static final class TarReader {
        static final class Entry {
            String name;
            String linkName;
            char type;
            long size;
            int mode;
        }

        private final InputStream in;
        private final byte[] hdr = new byte[512];
        private long unreadData = 0;   // 当前条目还剩多少数据字节未读
        private String longName = null;
        private String longLink = null;

        TarReader(InputStream in) { this.in = in; }

        Entry next() throws IOException {
            skipEntryData(); // 保证上一个条目的数据+填充被完全跳过

            while (true) {
                int n = readFully(hdr, 512);
                if (n < 512) return null;

                boolean allZero = true;
                for (byte b : hdr) { if (b != 0) { allZero = false; break; } }
                if (allZero) return null;

                String name = cstr(hdr, 0, 100);
                int mode = (int) octal(hdr, 100, 8);
                long size = octal(hdr, 124, 12);
                char type = (char) (hdr[156] & 0xff);
                String linkName = cstr(hdr, 157, 100);

                if (type == 'L') {           // GNU 长文件名
                    longName = readBlockString(size);
                    continue;
                }
                if (type == 'K') {           // GNU 长链接名
                    longLink = readBlockString(size);
                    continue;
                }
                if (type == 'x' || type == 'g') { // PAX
                    skipExact(size + pad(size));
                    continue;
                }

                String raw = longName != null ? longName : combine(hdr, name);
                Entry e = new Entry();
                e.mode = mode;
                e.type = type;
                e.name = sanitize(raw);
                e.linkName = longLink != null ? longLink : linkName;
                longName = null;
                longLink = null;

                boolean isDir = (type == '5')
                        || (type == 0 && raw.endsWith("/"))
                        || e.name.isEmpty();
                e.size = isDir ? 0 : size;
                unreadData = isDir ? 0 : size;
                return e;
            }
        }

        /** 把当前条目的剩余数据（含尾部填充）读完。 */
        void skipEntryData() throws IOException {
            if (unreadData > 0) skipExact(unreadData + pad(unreadData));
            unreadData = 0;
        }

        void copyEntryDataTo(OutputStream os, long size) throws IOException {
            byte[] buf = new byte[1 << 16];
            long left = size;
            while (left > 0) {
                int want = (int) Math.min(buf.length, left);
                int r = in.read(buf, 0, want);
                if (r < 0) throw new IOException("tar 数据提前结束");
                os.write(buf, 0, r);
                left -= r;
            }
            // ★★ 关键：读完 size 字节后必须再跳过对齐填充，否则下一个 header 错位
            int p = pad(size);
            if (p > 0) skipExact(p);
            unreadData = 0;
        }

        private String readBlockString(long size) throws IOException {
            byte[] b = new byte[(int) size];
            int n = readFully(b, size);
            skipExact(pad(size));
            unreadData = 0;
            return new String(b, 0, Math.max(0, n), StandardCharsets.UTF_8)
                    .replace("\0", "").trim();
        }

        private int readFully(byte[] b, long len) throws IOException {
            int want = (int) len;
            int off = 0;
            while (off < want) {
                int n = in.read(b, off, want - off);
                if (n < 0) break;
                off += n;
            }
            return off;
        }

        private void skipExact(long n) throws IOException {
            long left = n;
            byte[] buf = new byte[1 << 16];
            while (left > 0) {
                int want = (int) Math.min(buf.length, left);
                int r = in.read(buf, 0, want);
                if (r < 0) return;
                left -= r;
            }
        }

        private static int pad(long size) {
            return (int) ((512 - (size % 512)) % 512);
        }

        private static String combine(byte[] h, String name) {
            String prefix = cstr(h, 345, 155);
            return prefix.isEmpty() ? name : prefix + "/" + name;
        }

        private static String cstr(byte[] b, int off, int len) {
            int end = off;
            while (end < off + len && b[end] != 0) end++;
            return new String(b, off, end - off, StandardCharsets.UTF_8).trim();
        }

        private static long octal(byte[] b, int off, int len) {
            // 高位为 0x80 表示 base-256（大文件），这里 rootfs 用不到，保守返回 0
            if ((b[off] & 0x80) != 0) return 0;
            String s = new String(b, off, len, StandardCharsets.US_ASCII)
                    .replace("\0", " ").trim();
            if (s.isEmpty()) return 0;
            try {
                return Long.parseLong(s, 8);
            } catch (NumberFormatException ex) {
                return 0;
            }
        }
    }
}
