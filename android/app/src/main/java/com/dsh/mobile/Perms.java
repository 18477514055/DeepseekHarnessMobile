package com.dsh.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

/**
 * ★★★ 2026-10-20：**权限引导**（用户明确要求的产品原则）。
 *
 * 用户原话：「我们做出来的这些功能，如果涉及到权限的，应该**引导用户自己去权限页面调整**」
 *        「同时要引导用户跳到相关页面，**不是用户自己去找**」
 *
 * ══════════════════════════════════════════════════════════════════
 * 两条设计原则
 * ══════════════════════════════════════════════════════════════════
 * ① **不让用户自己找**：每个权限都直接跳到**对应那一页**，
 *    而不是只丢一句「去设置里开一下」。
 *    · 普通运行时权限 → 应用详情页（`ACTION_APPLICATION_DETAILS_SETTINGS`）
 *    · 所有文件访问   → 直接跳「所有文件访问」那一页（否则用户根本找不到）
 *    · 通知           → 直接跳「通知」那一页
 *    · 电池优化       → 直接跳「忽略电池优化」列表
 *    · 开发者选项/无线调试 → 开发者选项页（并说明要开哪一项）
 *
 * ② **能力失败时要能自救**：命令返回 ERR 时附带「怎么修」，
 *    用户/模型据此调 `dsh-android openperms <name>` 一步跳过去。
 *
 * ══════════════════════════════════════════════════════════════════
 * 命令：`openperms <name>`
 * ══════════════════════════════════════════════════════════════════
 * 支持的名字见 PAGES 表。未知名字返回可用的列表。
 */
final class Perms {
    private Perms() {}

    /**
     * 权限名 → (中文说明, 跳转 Intent 构造)。
     * ★ 每一项都跳**具体那一页**，不跳笼统的设置首页。
     */
    static final String[] NAMES = {
            "app",            // 应用详情（总入口）
            "allfiles",       // 所有文件访问
            "notify",         // 通知
            "battery",        // 电池优化
            "overlay",        // 显示在其他应用上层
            "usage",          // 使用情况访问
            "devoptions",     // 开发者选项（ADB 相关）
            "wireless",       // 无线调试
    };

    /** 给人看的能力说明（用于 ERR 时提示"需要哪个权限"）。 */
    static String hintFor(String cap) {
        switch (cap) {
            case "camera":   return "需要相机权限：dsh-android openperms app";
            case "gallery":  return "相册选择通常不需要权限；若失败，dsh-android openperms app";
            case "notify":   return "需要通知权限：dsh-android openperms notify";
            case "location": return "需要定位权限：dsh-android openperms app";
            case "adb":      return "需要开启无线调试：dsh-android openperms wireless";
            default:         return "若功能不可用，试试 dsh-android openperms app";
        }
    }

    /** 查某个运行时权限现在**到底有没有**（读真实状态，不读缓存）。 */
    static boolean granted(Context c, String permission) {
        try {
            return c.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 是否已授予「所有文件访问」（Android 11+ 的特殊 appop，不能用 checkSelfPermission）。 */
    static boolean hasAllFiles(Context c) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                return android.os.Environment.isExternalStorageManager();
            }
            return granted(c,
                    android.Manifest.permission.WRITE_EXTERNAL_STORAGE);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 输出当前权限快照（JSON），供 `dsh-android perms` 显示。 */
    static String snapshot(Context c) {
        StringBuilder b = new StringBuilder("{");
        b.append("\"allFiles\":").append(hasAllFiles(c));
        b.append(",\"camera\":").append(granted(c, android.Manifest.permission.CAMERA));
        b.append(",\"location\":").append(
                granted(c, android.Manifest.permission.ACCESS_FINE_LOCATION)
                        || granted(c, android.Manifest.permission.ACCESS_COARSE_LOCATION));
        b.append(",\"recordAudio\":").append(granted(c, android.Manifest.permission.RECORD_AUDIO));
        b.append(",\"storage\":").append(granted(c, android.Manifest.permission.READ_EXTERNAL_STORAGE));
        b.append("}");
        return b.toString();
    }

    /**
     * 跳到对应的权限页。**返回实际使用的跳转描述**（便于日志与排障）。
     *
     * ★ 全部带 FLAG_ACTIVITY_NEW_TASK —— 我们从 Service 上下文调起 Activity。
     * ★ 每个分支都有 fallback（跳到应用详情页），保证不会"点了没反应"。
     */
    static String open(Context c, String name) {
        String who = name == null ? "app" : name.trim().toLowerCase();
        try {
            switch (who) {
                case "allfiles": {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        // ★ 直接跳「所有文件访问」那一页 —— 用户自己找很难找到
                        Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                        i.setData(Uri.parse("package:" + c.getPackageName()));
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        c.startActivity(i);
                        return "allfiles";
                    }
                    break;  // 旧系统没有这一页，落到 app
                }
                case "notify": {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                        i.putExtra(Settings.EXTRA_APP_PACKAGE, c.getPackageName());
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        c.startActivity(i);
                        return "notify";
                    }
                    break;
                }
                case "battery": {
                    Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    i.setData(Uri.parse("package:" + c.getPackageName()));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    c.startActivity(i);
                    return "battery";
                }
                case "overlay": {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
                        i.setData(Uri.parse("package:" + c.getPackageName()));
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        c.startActivity(i);
                        return "overlay";
                    }
                    break;
                }
                case "usage": {
                    Intent i = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    c.startActivity(i);
                    return "usage";
                }
                case "devoptions": {
                    Intent i = new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    c.startActivity(i);
                    return "devoptions";
                }
                case "wireless": {
                    /* ★ 无线调试没有公开的直达 Action。
                     *   能做的：跳开发者选项页，用户在里面找「无线调试」。
                     *   实测 Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS 可直达。 */
                    Intent i = new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    c.startActivity(i);
                    return "devoptions(无线调试在这一页里找)";
                }
                default:
                    break;
            }
        } catch (Throwable t) {
            android.util.Log.w("DshPerms", "跳转 " + who + " 失败: " + t);
        }

        // ★ 统一兜底：应用详情页（一定有）
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + c.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
            return "app(fallback)";
        } catch (Throwable t) {
            return "FAILED: " + t;
        }
    }
}
