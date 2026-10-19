#!/system/bin/sh
# 查 pnpm 及插件安装所需工具
T=/data/data/com.dsh.mobile/files
NL=$(cat $T/.nl 2>/dev/null)
[ -z "$NL" ] && NL=$(ls -d /data/app/*/com.dsh.mobile-*/lib 2>/dev/null | head -1)
NL="$NL/arm64"

PROOT_LOADER=$T/lib/libproot-loader.so PROOT_TMP_DIR=$T/tmp LD_LIBRARY_PATH=$T/lib \
  $NL/libproot.so --link2symlink -r $T/rootfs -b /dev -b /proc -b /sys \
    -b /dev/urandom:/dev/random -b $T/dshhome:/root/.dsh -w /root \
    /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin \
      HOME=/root USER=root TERM=dumb /bin/sh -c '
echo "=== pnpm / npm / npx 在哪 ==="
for c in pnpm npm npx corepack yarn; do
  p=$(command -v $c 2>/dev/null)
  [ -n "$p" ] && echo "  OK   $c -> $p" || echo "  MISS $c"
done
echo ""
echo "=== /opt/node/bin 内容 ==="
ls /opt/node/bin/
echo ""
echo "=== npm 版本 ==="
npm --version 2>&1
echo ""
echo "=== corepack 能否启用 pnpm ==="
corepack --version 2>&1
' 2>&1
