#!/system/bin/sh
# 完整的容器内环境（带 dshhome bind），查功能完整度
T=/data/data/com.dsh.mobile/files
NL=$(cat $T/.nl 2>/dev/null)
[ -z "$NL" ] && NL=$(ls -d /data/app/*/com.dsh.mobile-*/lib 2>/dev/null | head -1)
NL="$NL/arm64"

PROOT_LOADER=$T/lib/libproot-loader.so PROOT_TMP_DIR=$T/tmp LD_LIBRARY_PATH=$T/lib \
  $NL/libproot.so --link2symlink -r $T/rootfs -b /dev -b /proc -b /sys \
    -b /dev/urandom:/dev/random -b $T/dshhome:/root/.dsh -w /root \
    /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin \
      HOME=/root USER=root TERM=dumb /bin/sh -c '
echo "=== A) web profile 的 package.json ==="
cat /root/.dsh/profiles/web/package.json 2>&1

echo ""
echo "=== B) 已安装插件（node_modules 计数与清单）==="
ls /root/.dsh/profiles/web/node_modules/ 2>/dev/null | wc -l
ls /root/.dsh/profiles/web/node_modules/ 2>/dev/null | head -30
' 2>&1
