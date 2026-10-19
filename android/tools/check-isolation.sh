#!/system/bin/sh
# 检查 APK 与 Termux 是否共享目录、是否互相干扰
echo "=== 1) APK 的数据根 ==="
ls -ld /data/data/com.dsh.mobile/files 2>&1
echo "  内容："
ls /data/data/com.dsh.mobile/files 2>&1

echo ""
echo "=== 2) Termux 的数据根 ==="
ls -ld /data/data/com.termux/files 2>&1

echo ""
echo "=== 3) 两边是否互相引用（关键判据）==="
echo "  --- APK 的 proot 命令行里有没有 com.termux ---"
echo "  （从 boot.log 看，已知：没有 --bind=.../com.termux）"
echo "  --- APK 的 rootfs 里有没有指向 termux 的链接 ---"
find /data/data/com.dsh.mobile/files/rootfs/opt -maxdepth 3 -type l 2>/dev/null | while read f; do
  t=$(readlink "$f" 2>/dev/null)
  case "$t" in
    *com.termux*) echo "  ⚠ $f -> $t" ;;
  esac
done
echo "  (以上若为空 = 没有跨引用)"

echo ""
echo "=== 4) 磁盘占用对照 ==="
du -sh /data/data/com.dsh.mobile/files 2>/dev/null
du -sh /data/data/com.termux 2>/dev/null

echo ""
echo "=== 5) 外部存储是否可见（/sdcard）==="
ls -ld /sdcard /storage/emulated/0 2>&1
echo "  APK 能读 /sdcard 吗："
ls /sdcard/ 2>&1 | head -3
