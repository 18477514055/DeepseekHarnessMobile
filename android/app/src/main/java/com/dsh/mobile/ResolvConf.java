package com.dsh.mobile;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import java.io.File;
import java.io.FileOutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * 容器 DNS —— 每次起 proot 之前，把**宿主当前可用**的 DNS 写进 rootfs 的 /etc/resolv.conf。
 *
 * ★★★ 为什么必须有这个类（2026-10-21 真机事故，1.0.5 回归）：
 *
 *   1.0.5 的 rootfs 是**在 PC 上重打**的（Debian WSL2 + qemu-user-static + chroot）。
 *   打 apt 时我按常规把宿主的 /etc/resolv.conf 复制进了 rootfs —— 而 WSL2 那份写的是：
 *       nameserver 10.255.255.254      ← WSL 的 NAT 网关，只在 Windows 主机上存在
 *   这个地址在手机上根本不存在 ⇒ 容器内 **所有** DNS 解析失败：
 *       curl: (6) Could not resolve host: registry.npmmirror.com
 *   表现为 `npm view` / `pnpm view` / `apt` / `git clone` **无输出、无报错、卡死**
 *   （请求发出去没人应答），极易误判成"网络问题"或"权限问题"。
 *
 *   真机取证（同一台机、同一时刻）：
 *     · 旧文件：getent hosts → 空；curl → `Could not resolve host`（t≈9.8s 超时）
 *     · 换成 223.5.5.5：getent → 立刻解析出 IPv6
 *       `npm view dshmarket` → **1.66.45**；`pnpm view dshmarket` → **1.66.45**
 *       `npm install dshmarket` → **added 7 packages in 20s**
 *   对照 1.0.4 的 rootfs：里面是 `8.8.8.8 / 8.8.4.4`（至少是可路由地址）
 *   ⇒ **这是 1.0.5 引入的回归，不是用户网络问题。**
 *
 * ★ 为什么在**每次启动时**写，而不是打进包里：
 *   ① DNS 随网络变化（WiFi / 移动网 / 开梯子 / 换路由器），打包时定死必然过期；
 *   ② 写一次就能**同时修好已装机用户** —— 不需要让他们重下 400MB 的 rootfs。
 *
 * ★ 为什么必须过滤 `fe80::` 和带 scope 的地址：
 *   本机 WiFi 的 DnsAddresses 实测是 `fe80::1%wlan0` + `192.168.1.1`。
 *   带 scope 的链路本地地址**没法**写进 resolv.conf（glibc 不认 `%wlan0` 这种写法），
 *   写进去只会让每条查询先白等一个超时 —— 比不写还慢。
 *
 * ★ 写失败**绝不能**拦住容器启动：DNS 不通只是网络不通，容器本身还能用。
 */
final class ResolvConf {

    private ResolvConf() {}

    /** 系统 DNS 最多取几个（多了会让 glibc 逐個等超时）。 */
    private static final int MAX_SYSTEM_DNS = 3;

    /**
     * 国内可用的公共 DNS —— 系统 DNS 取不到时的兜底。
     * ★ 选国内而不是 8.8.8.8：8.8.8.8 在国内经常不可达，
     *   而 1.0.4 的 rootfs 里恰恰写的就是 8.8.8.8（同样是隐患）。
     */
    private static final String[] FALLBACK = {
            "223.5.5.5",       // 阿里
            "119.29.29.29",    // 腾讯
            "114.114.114.114", // 114
    };

    /**
     * 保证 rootfs 里的 /etc/resolv.conf 指向当前可用的 DNS。
     *
     * ★ 幂等：内容没变就不写文件。
     * ★ 不抛异常：任何失败都只记日志。
     *
     * @param c 任意 Context（Application 或 Service 都行）
     */
    static void ensure(Context c) {
        try {
            File etc = new File(Cfg.rootfs(c), "etc");
            if (!etc.isDirectory()) {
                // rootfs 还没解压完 —— 这时候别去造目录，否则 isInstalled 的判定会被搅乱
                return;
            }

            List<String> dns = collect(c);

            StringBuilder sb = new StringBuilder();
            sb.append("# 由 DSH Mobile 在每次启动容器前自动生成，请勿手工编辑。\n");
            sb.append("# 原因：容器内 DNS 必须跟随宿主当前网络，不能沿用打包机的配置。\n");
            for (String s : dns) {
                sb.append("nameserver ").append(s).append('\n');
            }
            // ★ 让 glibc 别在一个坏掉的 DNS 上死等：每条查询 2 秒、只试 1 次就换下一个。
            //   默认是 5 秒 × 2 次，三个服务器全坏就是 30 秒 —— 用户看到的就是"卡死"。
            sb.append("options timeout:2 attempts:1\n");

            String want = sb.toString();
            File f = new File(etc, "resolv.conf");
            if (want.equals(readSmall(f))) {
                Cfg.log(c, "[DNS] resolv.conf 已是最新: " + dns);
                return;
            }

            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(want.getBytes("UTF-8"));
            }
            Cfg.log(c, "[DNS] resolv.conf 已写入: " + dns);
        } catch (Throwable t) {
            // ★ 绝不 rethrow：DNS 写失败只是网络可能不通，容器必须照常能起
            Cfg.log(c, "[DNS] ⚠️ 写入失败（不阻塞启动）: " + t);
        }
    }

    /**
     * 收集 DNS：**先宿主系统的，再国内公共的**。
     *
     * ★ 顺序很重要：内网域名只有系统 DNS 认得。
     *   而公共 DNS 对不存在的域名会**立刻**返回 NXDOMAIN（不会让 glibc 去试下一个），
     *   所以公共 DNS 必须排在后面。
     */
    private static List<String> collect(Context c) {
        LinkedHashSet<String> out = new LinkedHashSet<>();
        List<String> v4 = new ArrayList<>();
        List<String> v6 = new ArrayList<>();

        try {
            ConnectivityManager cm =
                    (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                for (Network n : cm.getAllNetworks()) {
                    NetworkCapabilities nc = cm.getNetworkCapabilities(n);
                    if (nc == null) continue;
                    if (!nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue;
                    LinkProperties lp = cm.getLinkProperties(n);
                    if (lp == null) continue;
                    for (InetAddress a : lp.getDnsServers()) {
                        if (a == null) continue;
                        if (a.isAnyLocalAddress() || a.isLoopbackAddress() || a.isLinkLocalAddress()) {
                            continue;   // 127.x / ::1 / fe80::
                        }
                        String h = a.getHostAddress();
                        if (h == null || h.isEmpty()) continue;
                        if (h.indexOf('%') >= 0) continue;   // ★ fe80::1%wlan0 —— 写进去无效
                        if (a instanceof Inet4Address) v4.add(h);
                        else v6.add(h);
                    }
                }
            }
        } catch (Throwable ignored) {
            // 缺 ACCESS_NETWORK_STATE / 系统异常 —— 直接用兜底，不报错
        }

        // IPv4 优先：容器里的老程序（apt、部分 npm 包）对纯 IPv6 环境并不友好
        for (String s : v4) {
            if (out.size() >= MAX_SYSTEM_DNS) break;
            out.add(s);
        }
        for (String s : v6) {
            if (out.size() >= MAX_SYSTEM_DNS) break;
            out.add(s);
        }

        for (String s : FALLBACK) out.add(s);
        return new ArrayList<>(out);
    }

    /** 读一个很小的文本文件；不存在或读失败返回 null。 */
    private static String readSmall(File f) {
        try {
            if (!f.isFile() || f.length() > 8192) return null;
            byte[] buf = new byte[(int) f.length()];
            try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                int off = 0;
                while (off < buf.length) {
                    int n = in.read(buf, off, buf.length - off);
                    if (n <= 0) break;
                    off += n;
                }
                if (off != buf.length) return null;
            }
            return new String(buf, "UTF-8");
        } catch (Throwable t) {
            return null;
        }
    }
}
