package com.dsh.mobile;

import android.content.Context;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
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
            Files.createSymbolicLink(f.toPath(), Path.of(target));
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
    static final int ADAPT_BUILD = 15;
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
                Files.createSymbolicLink(link, Path.of(e.linkName));
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
