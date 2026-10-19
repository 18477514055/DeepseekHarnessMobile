#!/system/bin/sh
# 查 /root/.dsh 到底在哪、谁是它的主人
T=/data/data/com.dsh.mobile/files
NL=$(cat $T/.nl 2>/dev/null)
[ -z "$NL" ] && NL=$(ls -d /data/app/*/com.dsh.mobile-*/lib 2>/dev/null | head -1)
NL="$NL/arm64"

echo "=== 宿主侧：dshhome 目录 ==="
ls -ld $T/dshhome 2>&1
ls -la $T/dshhome 2>&1 | head -10
echo ""
echo "=== rootfs 里的 /root ==="
ls -ld $T/rootfs/root 2>&1

echo ""
echo "=== 容器内看 /root 与 /root/.dsh ==="
PROOT_LOADER=$T/lib/libproot-loader.so PROOT_TMP_DIR=$T/tmp LD_LIBRARY_PATH=$T/lib \
  $NL/libproot.so --link2symlink -r $T/rootfs \
    -b /dev -b /proc -b /sys -b /dev/urandom:/dev/random \
    -b $T/dshhome:/root/.dsh -w /root \
    /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root /bin/sh -c '
id
ls -ld /root /root/.dsh 2>&1
ls /root/.dsh 2>&1 | head -12
echo "--- profiles ---"
ls /root/.dsh/profiles 2>&1
' 2>&1
