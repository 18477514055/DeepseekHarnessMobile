#!/system/bin/sh
# 验证 pnpm 装好后插件查询是否恢复
T=/data/data/com.dsh.mobile/files
NL=$(cat $T/.nl 2>/dev/null)
NL="$NL/arm64"

PROOT_LOADER=$T/lib/libproot-loader.so PROOT_TMP_DIR=$T/tmp LD_LIBRARY_PATH=$T/lib \
  $NL/libproot.so --link2symlink -r $T/rootfs -b /dev -b /proc -b /sys \
    -b /dev/urandom:/dev/random -b $T/dshhome:/root/.dsh -w /root \
    /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin \
      HOME=/root USER=root TERM=dumb /bin/sh -c '
export PATH=/opt/node/bin:$PATH

echo "=== 复现 DSH 的那条命令 ==="
pnpm view dshmarket name version description dsh --json "--registry=https://registry.npmmirror.com/" "--config.fetch-retries=0" 2>&1 | head -20
echo "  exit=$?"
' 2>&1
