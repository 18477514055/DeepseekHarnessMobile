#!/system/bin/sh
# 验证容器内能浏览整个手机存储
T=/data/data/com.dsh.mobile/files
NL=$(cat $T/.nl 2>/dev/null)
[ -z "$NL" ] && NL=$(ls -d /data/app/*/com.dsh.mobile-*/lib 2>/dev/null | head -1)
NL="$NL/arm64"

PROOT_LOADER=$T/lib/libproot-loader.so PROOT_TMP_DIR=$T/tmp LD_LIBRARY_PATH=$T/lib \
  $NL/libproot.so --link2symlink -r $T/rootfs -b /dev -b /proc -b /sys \
    -b /dev/urandom:/dev/random -b $T/dshhome:/root/.dsh \
    -b /storage/emulated/0/DSH:/sdcard \
    -b /storage/emulated/0:/mnt/phone -w /root \
    /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin \
      HOME=/root USER=root TERM=dumb /bin/sh -c '
echo "=== 1) 容器内能不能看到 /mnt/phone ==="
ls -ld /mnt/phone 2>&1
echo ""
echo "=== 2) 手机存储根目录内容（前 15 项）==="
ls /mnt/phone 2>&1 | head -15
echo ""
echo "=== 3) 能不能进子目录 ==="
for d in Download DCIM Documents Pictures; do
  if [ -d "/mnt/phone/$d" ]; then echo "  OK   /mnt/phone/$d"; else echo "  MISS /mnt/phone/$d"; fi
done
echo ""
echo "=== 4) 列出 Download 里的文件 ==="
ls /mnt/phone/Download 2>&1 | head -8
echo ""
echo "=== 5) 写入测试 ==="
echo "write-test-$(date +%s)" > "/mnt/phone/DSH/_write_test.txt" 2>&1 \
  && echo "  写入 OK" && cat /mnt/phone/DSH/_write_test.txt \
  || echo "  写入失败"
echo ""
echo "=== 6) /sdcard 也通吗 ==="
ls /sdcard 2>&1 | head -5
' 2>&1
