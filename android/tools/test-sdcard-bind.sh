#!/system/bin/sh
# 验证：proot 能不能把 /sdcard 的子目录 bind 进容器
T=/data/data/com.dsh.mobile/files
NL=$(cat $T/.nl 2>/dev/null)
NL="$NL/arm64"

echo "=== 1) /sdcard 的真实路径 ==="
ls -ld /sdcard 2>&1
readlink -f /sdcard 2>&1
echo "  /storage/emulated/0 存在吗："
ls -ld /storage/emulated/0 2>&1

echo ""
echo "=== 2) APK 的 uid 能写 /sdcard 吗（当前没有权限，预期失败）==="
mkdir -p /sdcard/DSH 2>&1 && echo "  能建" || echo "  不能建（需要权限）"

echo ""
echo "=== 3) 容器的 bind 源用哪个路径 ==="
echo "  proot 在 app 沙箱里，bind 源必须对它可见"
echo "  /sdcard → /storage/self/primary → /storage/emulated/0"
echo "  /storage/emulated/0 是真实挂载点"
ls -ld /storage/emulated/0/Android 2>&1 | head -2
