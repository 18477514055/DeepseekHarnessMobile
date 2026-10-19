#!/system/bin/sh
# 用绝对路径查容器内工具（PATH 可能不完整）
T=/data/data/com.dsh.mobile/files
NL=$(cat $T/.nl 2>/dev/null)
[ -z "$NL" ] && NL=$(ls -d /data/app/*/com.dsh.mobile-*/lib 2>/dev/null | head -1)
NL="$NL/arm64"

PROOT_LOADER=$T/lib/libproot-loader.so PROOT_TMP_DIR=$T/tmp LD_LIBRARY_PATH=$T/lib \
  $NL/libproot.so --link2symlink -r $T/rootfs \
    -b /dev -b /proc -b /sys -b /dev/urandom:/dev/random -w /root \
    /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin \
      HOME=/root USER=root TERM=dumb \
      /bin/sh -c '
echo "=== 1) /usr/bin 有多少东西 ==="
/usr/bin/find /usr/bin -maxdepth 1 -type f 2>/dev/null | wc -l
echo "=== 2) /bin 与 /usr/bin 是同一个吗 ==="
/bin/ls -ld /bin /usr/bin 2>&1
echo "=== 3) 关键工具是否存在 ==="
for c in bash ls cat head tar gzip git python3 apt curl wget grep sed awk; do
  if [ -x /usr/bin/$c ]; then echo "  OK   /usr/bin/$c"
  elif [ -x /bin/$c ]; then echo "  OK   /bin/$c"
  else echo "  MISS $c"; fi
done
echo "=== 4) /usr/bin 前 20 项 ==="
/bin/ls /usr/bin 2>&1 | head -20
echo "=== 5) profiles ==="
/bin/ls /root/.dsh/profiles/ 2>&1
echo "=== 6) 插件数 ==="
/bin/ls /root/.dsh/profiles/web/node_modules/ 2>/dev/null | wc -l
' 2>&1
