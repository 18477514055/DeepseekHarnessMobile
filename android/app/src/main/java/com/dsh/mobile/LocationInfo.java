package com.dsh.mobile;

import android.content.Context;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;

/**
 * ★ 2026-10-20：定位（只读最近一次已知位置，**不主动请求定位更新**）。
 *
 * ★★ 为什么不主动定位：
 *   主动 `requestLocationUpdates` 要等下一次定位（可能几十秒），还会耗电、
 *   而且从 Service 里申请权限会弹窗打断用户。
 *   `getLastKnownLocation` 是**同步、瞬时、无副作用**的，够用。
 *   拿不到就明确说"没有最近位置"，让容器里的模型自己决定要不要让用户先开一次地图。
 *
 * ★ 权限：需要 ACCESS_FINE_LOCATION 或 ACCESS_COARSE_LOCATION（调用方已检查）。
 */
final class LocationInfo {
    private LocationInfo() {}

    static String get(Context c) {
        try {
            LocationManager lm = (LocationManager)
                    c.getSystemService(Context.LOCATION_SERVICE);
            if (lm == null) return "ERR\n定位服务不可用\n";

            Location best = null;
            String bestProvider = null;

            for (String p : new String[]{LocationManager.GPS_PROVIDER,
                    LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER}) {
                try {
                    if (!lm.isProviderEnabled(p)) continue;
                    //noinspection MissingPermission  ← 调用方已检查
                    Location l = lm.getLastKnownLocation(p);
                    if (l == null) continue;
                    if (best == null || l.getTime() > best.getTime()) {
                        best = l;
                        bestProvider = p;
                    }
                } catch (Throwable ignored) { }
            }

            if (best == null) {
                return "ERR\n没有最近位置记录（可能刚开机或从未定位过）。"
                        + "请先打开地图类应用定位一次。\n";
            }

            long ageSec = (System.currentTimeMillis() - best.getTime()) / 1000;
            return "OK\n{"
                    + "\"lat\":" + best.getLatitude()
                    + ",\"lon\":" + best.getLongitude()
                    + ",\"accuracy\":" + (best.hasAccuracy() ? Math.round(best.getAccuracy()) : -1)
                    + ",\"provider\":\"" + bestProvider + "\""
                    + ",\"ageSeconds\":" + ageSec
                    + "}\n";
        } catch (Throwable t) {
            return "ERR\n定位读取失败: " + t + "\n";
        }
    }
}
