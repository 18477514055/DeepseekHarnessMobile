#!/system/bin/sh
# 直接从容器内部调 DSH 的插件查询接口，验证 pnpm 是否真的可用
T=/data/data/com.dsh.mobile/files
NL=$(cat $T/.nl 2>/dev/null)
NL="$NL/arm64"

PROOT_LOADER=$T/lib/libproot-loader.so PROOT_TMP_DIR=$T/tmp LD_LIBRARY_PATH=$T/lib \
  $NL/libproot.so --link2symlink -r $T/rootfs -b /dev -b /proc -b /sys \
    -b /dev/urandom:/dev/random -b $T/dshhome:/root/.dsh -w /root \
    /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin \
      HOME=/root USER=root TERM=dumb /bin/sh -c '
export PATH=/opt/node/bin:$PATH
echo "=== 1) pnpm 版本 ==="
pnpm --version 2>&1 | tail -2
echo ""
echo "=== 2) 模拟插件市场搜索（真实命令）==="
pnpm view dsh-mobile-adapt name version description --json "--registry=https://registry.npmmirror.com/" "--config.fetch-retries=0" 2>&1 | tail -8
echo ""
echo "=== 3) 再试一个 ==="
pnpm view dsh-ledger-memory name version --json "--registry=https://registry.npmmirror.com/" "--config.fetch-retries=0" 2>&1 | tail -6
' 2>&1
