#!/system/bin/sh
# 在 Termux 那套 rootfs 里装 pnpm（作为打包源）
R=/data/data/com.termux/files/usr/var/lib/proot-distro/containers/dshim/rootfs
echo "=== 检查 Termux rootfs 的 node/npm ==="
export PATH=$R/opt/node/bin:/data/data/com.termux/files/usr/bin:/system/bin
$R/opt/node/bin/node --version
$R/opt/node/bin/npm --version 2>&1 | head -2

echo ""
echo "=== 用 Termux 的 proot-distro 直接装（更可靠）==="
echo "  用容器内环境装，避免宿主 glibc 不兼容"
