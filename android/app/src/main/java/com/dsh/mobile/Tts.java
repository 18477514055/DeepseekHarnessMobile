package com.dsh.mobile;

import android.content.Context;
import android.speech.tts.TextToSpeech;

import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * ★ 2026-10-20：文字转语音（TTS）。
 *
 * 用途：容器里的 DSH 跑完长任务后可以「说一声」，比通知更直接。
 *
 * ★ 实现要点：
 *   · TextToSpeech 初始化是**异步**的，必须等 onInit 回调；
 *   · 从 Service 上下文调用时要指定 QUEUE_FLUSH；
 *   · 用 CountDownLatch 把异步初始化变成同步（最多等 3 秒，避免卡死桥线程）；
 *   · 失败一律返回可读的错误，不抛异常。
 */
final class Tts {
    private static TextToSpeech engine;
    private static boolean ready = false;

    private Tts() {}

    private static synchronized boolean ensure(Context c) {
        if (engine != null && ready) return true;
        final CountDownLatch latch = new CountDownLatch(1);
        try {
            engine = new TextToSpeech(c.getApplicationContext(), status -> {
                try {
                    if (status == TextToSpeech.SUCCESS) {
                        ready = true;
                        try { engine.setLanguage(Locale.CHINA); } catch (Throwable ignored) { }
                    }
                } finally {
                    latch.countDown();
                }
            });
            // 最多等 3 秒（引擎初始化通常 <1s；个别 ROM 慢）
            latch.await(3, TimeUnit.SECONDS);
        } catch (Throwable t) {
            return false;
        }
        return ready;
    }

    static String speak(Context c, String text) {
        try {
            if (!ensure(c)) {
                return "ERR\nTTS 引擎初始化失败（设备可能没有安装语音引擎）。"
                        + "可在系统「设置 → 文字转语音」里检查。\n";
            }
            int r = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "dsh-tts");
            return (r == TextToSpeech.SUCCESS) ? "OK\nok\n" : "ERR\nTTS 播报失败\n";
        } catch (Throwable t) {
            return "ERR\nTTS 异常: " + t + "\n";
        }
    }

    static void stop() {
        try { if (engine != null) engine.stop(); } catch (Throwable ignored) { }
    }
}
