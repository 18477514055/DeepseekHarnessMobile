package com.dsh.mobile;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import java.util.List;

/**
 * ★ 2026-10-20：列出已安装应用（只列**用户可见**的，即带启动图标的应用）。
 *
 * ★ 为什么不列全部包名：系统包有几百个，对模型没用还占输出。
 *   带 LAUNCHER intent 的才是用户真正能打开的应用。
 *
 * 用途举例：「帮我打开微信」「我装了哪些笔记类应用」。
 */
final class Apps {
    private Apps() {}

    static String list(Context c, String filter) {
        try {
            PackageManager pm = c.getPackageManager();
            Intent main = new Intent(Intent.ACTION_MAIN);
            main.addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> ris = pm.queryIntentActivities(main, 0);
            if (ris == null || ris.isEmpty()) return "OK\n[]\n";

            String f = filter == null ? "" : filter.trim().toLowerCase();
            StringBuilder b = new StringBuilder("[");
            boolean first = true;
            int n = 0;
            for (ResolveInfo ri : ris) {
                if (ri.activityInfo == null) continue;
                String pkg = ri.activityInfo.packageName;
                String label;
                try {
                    ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
                    label = pm.getApplicationLabel(ai).toString();
                } catch (Throwable t) {
                    label = pkg;
                }
                // 过滤（按包名或显示名，不区分大小写）
                if (!f.isEmpty()
                        && !pkg.toLowerCase().contains(f)
                        && !label.toLowerCase().contains(f)) continue;

                if (!first) b.append(',');
                first = false;
                b.append("{\"package\":\"").append(esc(pkg)).append('"')
                        .append(",\"label\":\"").append(esc(label)).append('"')
                        .append('}');
                if (++n >= 300) break;   // 防御：最多 300 条
            }
            b.append(']');
            return "OK\n" + b + "\n";
        } catch (Throwable t) {
            return "ERR\n列应用失败: " + t + "\n";
        }
    }

    private static String esc(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
