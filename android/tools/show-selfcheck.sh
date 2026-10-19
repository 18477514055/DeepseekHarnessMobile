#!/system/bin/sh
# 看 app 进程内的共享存储自检结果
T=/data/data/com.dsh.mobile/files
echo "=== boot.log 尾部 ==="
tail -12 $T/boot.log

echo ""
echo "=== 关键自检行 ==="
grep "自检" $T/boot.log 2>/dev/null | tail -5

echo ""
echo "=== proot.log 有无 bind 警告 ==="
grep -c "can't sanitize" $T/proot.log 2>/dev/null || echo 0
