#!/system/bin/sh
# 验证共享目录：容器内 /sdcard 是否可用、双向流动是否通
T=/data/data/com.dsh.mobile/files
NL=$(cat $T/.nl 2>/dev/null)
[ -z "$NL" ] && NL=$(ls -d /data/app/*/com.dsh.mobile-*/lib 2>/dev/null | head -1)
NL="$NL/arm64"

PROOT_LOADER=$T/lib/libproot-loader.so PROOT_TMP_DIR=$T/tmp LD_LIBRARY_PATH=$T/lib \
  $NL/libproot.so --link2symlink -r $T/rootfs -b /dev -b /proc -b /sys \
    -b /dev/urandom:/dev/random -b $T/dshhome:/root/.dsh \
    -b /storage/emulated/0/DSH:/sdcard -w /root \
    /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin \
      HOME=/root USER=root TERM=dumb /bin/sh -c '
echo "=== 1) 容器内 /sdcard 是什么 ==="
ls -ld /sdcard 2>&1
echo "  内容："
ls /sdcard 2>&1 | head -5

echo ""
echo "=== 2) 从容器写一个文件到 /sdcard ==="
echo "hello-from-container-$(date +%s)" > /sdcard/_from_container.txt 2>&1
cat /sdcard/_from_container.txt 2>&1

echo ""
echo "=== 3) 在容器里建个子目录并写文件 ==="
mkdir -p /sdcard/测试目录 2>&1
echo "中文路径也能用" > /sdcard/测试目录/中文.txt 2>&1
ls -l /sdcard/测试目录/ 2>&1
' 2>&1
