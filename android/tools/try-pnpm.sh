#!/system/bin/sh
# 尝试启用 pnpm 并测试插件查询是否恢复
T=/data/data/com.dsh.mobile/files
NL=$(cat $T/.nl 2>/dev/null)
NL="$NL/arm64"

PROOT_LOADER=$T/lib/libproot-loader.so PROOT_TMP_DIR=$T/tmp LD_LIBRARY_PATH=$T/lib \
  $NL/libproot.so --link2symlink -r $T/rootfs -b /dev -b /proc -b /sys \
    -b /dev/urandom:/dev/random -b $T/dshhome:/root/.dsh -w /root \
    /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin \
      HOME=/root USER=root TERM=dumb /bin/sh -c '
export PATH=/opt/node/bin:$PATH

echo "=== 1) corepack 能不能直接启用 pnpm（需联网下载）==="
timeout 60 corepack prepare pnpm@latest --activate 2>&1 | tail -6
echo "  exit=$?"

echo ""
echo "=== 2) 现在有 pnpm 了吗 ==="
command -v pnpm && pnpm --version 2>&1 || echo "  仍然没有"

echo ""
echo "=== 3) npm 全局装 pnpm（另一条路）==="
timeout 90 npm i -g pnpm --registry=https://registry.npmmirror.com/ 2>&1 | tail -8
command -v pnpm && pnpm --version 2>&1 || echo "  仍然没有"
' 2>&1
