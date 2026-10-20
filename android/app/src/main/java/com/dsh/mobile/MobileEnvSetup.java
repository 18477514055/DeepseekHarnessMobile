package com.dsh.mobile;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;

/**
 * 移动端环境初始化 —— 把「桌面端产品」改造成「在手机容器里能用」。
 *
 * ★★★ 这个类解决的是**根因**，不是打补丁。依据是手机端探测出来的事实
 * （见 `_手机报告-20261020/DSH移动端-完整技术报告.md`）：
 *
 *   > 这不是「一个有 N 个 bug 的客户端」，而是「一个桌面端产品正在被移植到手机容器」。
 *
 * 官方 DSH 的默认工作区逻辑（`dsh-api-workspace-controller/lib/index.js:609`）：
 *
 * ```js
 * switch (platform) {
 *   case "darwin": osascript ...
 *   case "win32":  powershell ...
 *   case "linux":  xdg-user-dir DOCUMENTS
 *   default: throw new Error(`system Documents directory is unavailable on ${platform}`);
 * }
 * ```
 *
 * 我们跑在 Android 上，`process.platform === "linux"` ⇒ 走 `xdg-user-dir` 分支，
 * 而**精简 Debian 里根本没有这个命令**（实测：rootfs 的 82392 个条目里零命中）
 * ⇒ spawn 失败 ⇒ 抛错 ⇒ **首次启动弹「无法创建默认工作区」**。
 *
 * ★ 修法**不是改官方代码**，而是用它自己留的官方入口：
 *   同一份源码 L846 `documentsDirectory: z.string()` —— 注释明确写着
 *   「explicit deployment override for the system Documents directory」
 *   ⇒ 只要在用户 profile 的 `cordis.patch.yml` 里给 `workspace-controller` 这行
 *     补上 `documentsDirectory`，就会**跳过**整个 xdg 分支。
 *
 * 最终默认工作区路径 = `<documentsDirectory>/deepseek-harness/default-workspace`
 *   （L586 `DEFAULT_WORKSPACE_DIRECTORY = "default-workspace"`，L640 `paths.join`）
 *
 * ★ 选 `~/.dsh`（容器内 `/root/.dsh`，宿主 `files/dshhome`）作为 documentsDirectory 的理由：
 *   · 它在 **f2fs** 上 ⇒ POSIX 完整、git/npm/pnpm 开箱即用（报告 §3.2）
 *   · 它随 App 数据保留，卸载重装不丢（与 `dshhome` 同级）
 *   · 它**不会**落在 FUSE 共享存储上，避开硬链接 EPERM / 软链接 EACCES 那一堆坑
 *
 * ★ 用户若自己在 UI 里选了别的目录，那份选择由 DSH 自己存进 `workspace.json`，
 *   本类**不干预、不改写**（用户要求「工作区机制不用大改」）。
 */
final class MobileEnvSetup {

    private MobileEnvSetup() {}

    /** 容器内 dsh 的家（宿主是 files/dshhome）。 */
    private static final String IN_DOCUMENTS = "/root/.dsh";

    /**
     * 在容器启动**之前**做三件事。任何一步失败都只记日志、不阻断启动
     * （报告 §3.1 明确要求：「创建失败不要阻断启动，静默降级继续」）。
     */
    static void prepare(Context c) {
        try {
            File home = Cfg.dshHome(c);
            if (home == null) return;

            /* ★ 自己确保 dshhome 存在 —— 不能假定上游已经建过。
             *
             * `Cfg.dshHome()` 只是拼路径，**不会 mkdir**。
             * 而首次启动时 `installAdapt()` 可能因各种原因没跑到，
             * 那时 home 还不存在 ⇒ 下面的写文件全部失败。
             * ⇒ 先建目录（幂等），再干活。 */
            if (!home.isDirectory() && !home.mkdirs()) {
                Cfg.log(c, "⚠️ 无法创建 dshhome，跳过移动端环境初始化: " + home);
                return;
            }

            // ① 预建默认工作区目录（DSH 那边也会 mkdir，但先建好能省掉一次失败）
            ensureDefaultWorkspaceDir(c, home);

            // ② 写家级 patch：补 documentsDirectory，跳过 xdg-user-dir
            writeWorkspacePatch(c, home);

            // ③ 放一份用户指南到共享目录（**不注入、不写任何 AGENTS.md**）
            installUserGuide(c);

            // ④ 清理：早期版本曾把指南写进用户的全局指令位置，必须撤回
            cleanWrongAgentsMd(c, home);

        } catch (Throwable t) {
            Cfg.log(c, "⚠️ MobileEnvSetup.prepare 失败（不阻断启动）: " + t);
        }
    }

    // ------------------------------------------------------------------
    // ① 预建默认工作区目录
    // ------------------------------------------------------------------

    /**
     * 预建 `<dshhome>/../` 之外的那条路径对应的**宿主**目录。
     *
     * ★ 容器内 `/root/.dsh` = 宿主 `files/dshhome`，所以
     *   容器内 `/root/.dsh/deepseek-harness/default-workspace`
     *   = 宿主 `files/dshhome/deepseek-harness/default-workspace`。
     *   在 Android 侧直接建好，容器起来就能看见。
     */
    private static void ensureDefaultWorkspaceDir(Context c, File home) {
        File ws = new File(new File(home, "deepseek-harness"), "default-workspace");
        if (ws.isDirectory()) {
            Cfg.log(c, "默认工作区目录已存在: " + ws.getAbsolutePath());
            return;
        }
        boolean ok = ws.mkdirs();
        Cfg.log(c, (ok ? "已预建默认工作区目录: " : "⚠️ 预建默认工作区失败: ")
                + ws.getAbsolutePath());
    }

    // ------------------------------------------------------------------
    // ② 写 profile cordis.patch.yml
    // ------------------------------------------------------------------

    /**
     * 往**家级** patch（`$DSH_HOME/cordis.patch.yml`）补 `workspace-controller` 的
     * `documentsDirectory`。
     *
     * ★★★ 为什么是「家级」而不是「profile 级」——查源码确认的分层（`lib/profile-boot-*.js`）：
     *
     * ```js
     * /** The home-level user patch layer ($DSH_HOME/cordis.patch.yml), applied
     *  * over every profile's own layer. *\/
     * function homePatchPath() { return join(resolveDshHome(), PROFILE_PATCH_FILENAME); }
     * ```
     *
     * ⇒ 配置树是**依次叠加**的：`bundle patches` → `profiles/<名>/cordis.patch.yml`
     *   → **`$DSH_HOME/cordis.patch.yml`（家级，覆盖前面所有）** → `--patch overlays`
     *
     * 两个位置都会被读到，但**家级有两个好处**：
     *   ① 对所有 profile 生效（不分 web / 别的名字）
     *   ② 不会被「重建 profile」冲掉 —— 源码 L134 明确写着重建 profile 时会
     *      「delete ... its dependencies and **user patch**」，那份指的是 profile 级的
     *
     * ★ 幂等：文件里已含 `documentsDirectory` 就完全不动。
     * ★ 已存在则**追加**一段，不整份重写（避免踩「整份重写丢内容」那个老坑）。
     */
    private static void writeWorkspacePatch(Context c, File home) {
        if (home == null || !home.isDirectory()) {
            Cfg.log(c, "dshhome 尚未生成，跳过 workspace patch（下次启动再写）");
            return;
        }
        File patch = new File(home, "cordis.patch.yml");

        String existing = "";
        try {
            if (patch.exists()) existing = readText(patch);
        } catch (Throwable ignored) { }

        // ★ 幂等判据：已经配过就退出
        if (existing.contains("documentsDirectory")) {
            Cfg.log(c, "workspace patch 已存在 documentsDirectory，跳过");
            return;
        }

        StringBuilder sb = new StringBuilder();
        if (existing.length() == 0) {
            sb.append("# 由 DSH Mobile 生成：补上移动端环境缺失的默认工作区目录。\n");
            sb.append("# 官方在这里会调 `xdg-user-dir DOCUMENTS`，而容器里没有这个命令，\n");
            sb.append("# 于是抛「system Documents directory is unavailable」⇒ 首启建不出工作区。\n");
            sb.append("# 下面的 documentsDirectory 是官方留的覆盖入口，会跳过整段 xdg 逻辑。\n");
        } else {
            if (!existing.endsWith("\n")) sb.append(existing).append("\n");
            else sb.append(existing);
            sb.append("\n");
        }

        sb.append("\n# ── DSH Mobile: 默认工作区 ──────────────────────────────────\n");
        sb.append("- id: workspace-controller\n");
        sb.append("  config:\n");
        // ★ YAML 里含 `/` 的普通字符串加引号更稳（避免被当成特殊标记）
        sb.append("    documentsDirectory: \"").append(IN_DOCUMENTS).append("\"\n");

        try {
            writeText(patch, sb.toString());
            Cfg.log(c, "已写 workspace patch: " + patch.getAbsolutePath()
                    + "（documentsDirectory=" + IN_DOCUMENTS + "）");
        } catch (Throwable t) {
            Cfg.log(c, "⚠️ 写 workspace patch 失败（不阻断）: " + t);
        }
    }

    // ------------------------------------------------------------------
    // ③ 使用指南（放共享目录，不注入）
    // ------------------------------------------------------------------

    /**
     * 撤回早期版本写错的全局指令。
     *
     * ★ 历史：2026-10-20 前几版曾把本指南写进
     *   `$DSH_HOME/AGENTS.md`（用户的全局指令），还一度"内容不同就覆盖"。
     *   用户当场指出：「全局指令用户和模型会改啊，这可不行（不能把全局指令占为己有）」
     *   ⇒ 已改为只放共享目录的《使用指南.md》，不再注入。
     *
     * ★ 这个函数负责**把之前写错的那份删掉**（只删我们写的那份，认内容）。
     *   判据：目标文件**存在**且**内容与当前 assets 完全一致** ⇒ 说明是我们写的，删。
     *   任何其它情况（用户改过、或本来就是他自己的）⇒ **一个字节都不动**。
     *
     * ★ 只在 dshhome 下判断，不碰 `~/.agents`（那版没发出去过）。
     */
    private static void cleanWrongAgentsMd(Context c, File home) {
        try {
            File wrong = new File(home, "AGENTS.md");
            if (!wrong.exists() || !wrong.isFile()) return;

            byte[] mine = null;
            java.io.InputStream in = null;
            try {
                in = c.getAssets().open("使用指南.md");
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                mine = bo.toByteArray();
            } finally {
                try { if (in != null) in.close(); } catch (Throwable ignored) { }
            }

            if (wrong.length() != mine.length) {
                Cfg.log(c, "用户全局指令不是分发包写的（大小不同），保持不动");
                return;
            }
            byte[] cur = new byte[(int) wrong.length()];
            java.io.FileInputStream fi = new java.io.FileInputStream(wrong);
            int off = 0, k;
            try {
                while (off < cur.length && (k = fi.read(cur, off, cur.length - off)) > 0) off += k;
            } finally {
                try { fi.close(); } catch (Throwable ignored) { }
            }
            if (off == cur.length && java.util.Arrays.equals(cur, mine)) {
                boolean ok = wrong.delete();
                Cfg.log(c, (ok ? "已撤回" : "⚠️ 撤回失败")
                        + "早期误写入的全局指令: " + wrong.getAbsolutePath()
                        + "（内容与分发包指南完全一致 ⇒ 是我们写的）");
            } else {
                Cfg.log(c, "用户全局指令内容与分发包不同（用户改过），保持不动");
            }
        } catch (Throwable t) {
            Cfg.log(c, "⚠️ cleanWrongAgentsMd 失败（不阻断）: " + t);
        }
    }

    /**
     * 放一份**用户指南**到共享目录，供**用户和模型按需查阅**。
     *
     * ★★★ 2026-10-20 用户定的原则（这是最终方案）：
     *   > 「干脆直接放一份用户指南，不用注入，遇到问题模型和用户自己会去看」
     *
     * ⇒ **不往任何 AGENTS.md 写东西。**
     *   · 不写 `$DSH_HOME/AGENTS.md` —— 那是用户的全局指令，分发包无权占为己有
     *   · 也不写 `$AGENTS_HOME/AGENTS.md` —— 同样属于用户
     *   · 不注入、不自动进上下文
     *
     * ★ 为什么这样更好：
     *   · 全局指令是**用户的**，任何自动写入都是越界（哪怕内容都是好意）
     *   · 环境说明属于「遇到问题查手册」，不该占每个会话的上下文预算
     *   · 放在共享目录里，**手机文件管理器也能直接看到**，用户不用进容器
     *
     * ★ 落点：`/storage/emulated/0/DeepseekHarness/使用指南.md`
     *   （容器内 `/sdcard/使用指南.md`，`/mnt/phone/DeepseekHarness/使用指南.md`）
     *   —— 共享目录，用户和模型都够得着。
     */
    private static void installUserGuide(Context c) {
        File dest = new File(Cfg.sharedRoot(c), "使用指南.md");

        byte[] asset = null;
        java.io.InputStream in = null;
        try {
            in = c.getAssets().open("使用指南.md");
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            asset = bo.toByteArray();
        } catch (Throwable t) {
            Cfg.log(c, "⚠️ 读 assets/使用指南.md 失败: " + t);
            return;
        } finally {
            try { if (in != null) in.close(); } catch (Throwable ignored) { }
        }

        // 内容一致就跳过
        if (dest.exists() && dest.length() == asset.length) {
            try {
                byte[] cur = new byte[(int) dest.length()];
                java.io.FileInputStream fi = new java.io.FileInputStream(dest);
                int off = 0, k;
                try {
                    while (off < cur.length && (k = fi.read(cur, off, cur.length - off)) > 0) off += k;
                } finally {
                    try { fi.close(); } catch (Throwable ignored) { }
                }
                if (off == cur.length && java.util.Arrays.equals(cur, asset)) {
                    Cfg.log(c, "使用指南 内容一致，跳过（" + asset.length + " B）");
                    return;
                }
            } catch (Throwable ignored) { }
        }

        boolean existed = dest.exists();
        try {
            java.io.File parent = dest.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                Cfg.log(c, "⚠️ 无法创建 " + parent + "，跳过使用指南");
                return;
            }
            java.io.FileOutputStream out = new java.io.FileOutputStream(dest);
            try {
                out.write(asset);
                out.flush();
            } finally {
                try { out.close(); } catch (Throwable ignored) { }
            }
            Cfg.log(c, (existed ? "已更新" : "已写入") + "使用指南: "
                    + dest.getAbsolutePath() + "（" + asset.length + " B）"
                    + "  ★ 未注入任何 AGENTS.md");
        } catch (Throwable t) {
            Cfg.log(c, "⚠️ 写使用指南失败（不阻断）: " + t);
        }
    }

    // ------------------------------------------------------------------
    // 小工具（UTF-8 无 BOM —— 本机硬规矩，BOM 会让 YAML 解析失败）
    // ------------------------------------------------------------------

    /**
     * 把三个关键文件的实际内容/状态打进 boot.log —— **验收用**。
     *
     * ★ 为什么要这个：release 包 `run-as` 用不了，Android 侧 `shell` 读不了 app 私有目录，
     *   而容器里 `ls /root/.dsh` 会报 Permission denied（proot 的 readdir 限制）。
     *   ⇒ **APK 自己的进程是唯一能可靠读到它们的地方**，所以由它来落日志。
     *
     * ★ 纯只读，不修改任何东西。
     */
    static void dumpState(Context c) {
        try {
            File home = Cfg.dshHome(c);
            Cfg.log(c, "=== [验收] 移动端环境状态 ===");

            // ① 家级 patch
            File patch = new File(home, "cordis.patch.yml");
            if (patch.exists()) {
                Cfg.log(c, "[验收] cordis.patch.yml 存在，" + patch.length() + " B：");
                for (String ln : readText(patch).split("\n")) {
                    if (ln.trim().length() > 0) Cfg.log(c, "[验收]   | " + ln);
                }
            } else {
                Cfg.log(c, "[验收] ❌ cordis.patch.yml 不存在");
            }

            // ② 默认工作区目录
            File ws = new File(new File(home, "deepseek-harness"), "default-workspace");
            Cfg.log(c, "[验收] 默认工作区目录: " + ws.getAbsolutePath()
                    + "  exists=" + ws.exists() + " isDir=" + ws.isDirectory());

            // ③ workspace.json
            File wj = new File(new File(home, "storages"), "workspace.json");
            if (wj.exists()) {
                String t = readText(wj);
                Cfg.log(c, "[验收] workspace.json 存在，" + wj.length() + " B");
                Cfg.log(c, "[验收]   含 default-workspace = " + t.contains("default-workspace"));
                Cfg.log(c, "[验收]   含 deepseek-harness = " + t.contains("deepseek-harness"));
                if (t.length() < 1500) Cfg.log(c, "[验收]   " + t.replace("\n", " "));
            } else {
                Cfg.log(c, "[验收] workspace.json 不存在（还没建过工作区）");
            }

            // ④ 用户全局指令（**只读检查，绝不写**）
            File ug = new File(home, "AGENTS.md");
            Cfg.log(c, "[验收] 用户全局指令 $DSH_HOME/AGENTS.md exists=" + ug.exists()
                    + " size=" + (ug.exists() ? ug.length() : 0) + " B"
                    + "  ★ 分发包不改它");

            // ⑤ 使用指南（分发包放的，在共享目录）
            File guide = new File(Cfg.sharedRoot(c), "使用指南.md");
            Cfg.log(c, "[验收] 使用指南 exists=" + guide.exists()
                    + " size=" + (guide.exists() ? guide.length() : 0) + " B");

            Cfg.log(c, "=== [验收] 结束 ===");
        } catch (Throwable t) {
            Cfg.log(c, "[验收] dumpState 失败: " + t);
        }
    }

    private static String readText(File f) throws IOException {
        byte[] buf = new byte[(int) Math.min(f.length(), 1 << 20)];
        java.io.FileInputStream in = new java.io.FileInputStream(f);
        try {
            int off = 0, n;
            while (off < buf.length && (n = in.read(buf, off, buf.length - off)) > 0) off += n;
            return new String(buf, 0, off, StandardCharsets.UTF_8);
        } finally {
            try { in.close(); } catch (Throwable ignored) { }
        }
    }

    private static void writeText(File f, String content) throws IOException {
        File parent = f.getParentFile();
        if (parent != null && !parent.isDirectory()) parent.mkdirs();
        Writer w = new OutputStreamWriter(new FileOutputStream(f), StandardCharsets.UTF_8);
        try {
            w.write(content);
        } finally {
            try { w.close(); } catch (Throwable ignored) { }
        }
    }
}
