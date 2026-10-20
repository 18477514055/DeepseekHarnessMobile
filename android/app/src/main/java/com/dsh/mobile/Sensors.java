package com.dsh.mobile;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorManager;

import java.util.List;

/**
 * ★ 2026-10-20：列出设备传感器（只读清单，**不订阅数据流**）。
 *
 * ★★ 为什么不读数：从 Service 里持续订阅传感器会耗电、且需要额外生命周期管理；
 *   而"这台手机有什么传感器"本身就已经很有用了 ——
 *   模型据此决定能不能做「摇一摇」「计步」这类事情。
 *   真要读数时再单独加（并且要能停）。
 */
final class Sensors {
    private Sensors() {}

    static String list(Context c) {
        try {
            SensorManager sm = (SensorManager)
                    c.getSystemService(Context.SENSOR_SERVICE);
            if (sm == null) return "ERR\n传感器服务不可用\n";
            List<Sensor> all = sm.getSensorList(Sensor.TYPE_ALL);
            if (all == null || all.isEmpty()) return "OK\n[]\n";

            StringBuilder b = new StringBuilder("[");
            boolean first = true;
            for (Sensor s : all) {
                if (!first) b.append(',');
                first = false;
                b.append("{\"name\":\"").append(esc(s.getName())).append('"')
                        .append(",\"type\":").append(s.getType())
                        .append(",\"vendor\":\"").append(esc(s.getVendor())).append('"')
                        .append(",\"version\":").append(s.getVersion())
                        .append('}');
            }
            b.append(']');
            return "OK\n" + b + "\n";
        } catch (Throwable t) {
            return "ERR\n读取传感器列表失败: " + t + "\n";
        }
    }

    private static String esc(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
