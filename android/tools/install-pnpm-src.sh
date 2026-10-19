#!/system/bin/sh
# 在 Termux 的 dshim 容器里装 pnpm —— 这就是打包源
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH=$PREFIX/bin:$HOME/bin:/system/bin

echo "=== 在 dshim 容器内装 pnpm ==="
timeout 240 proot-distro login dshim -- /bin/sh -c '
export PATH=/opt/node/bin:$PATH
echo "  node: $(node -v)"
echo "  npm : $(npm -v 2>&1 | head -1)"
echo "  --- 开始装 pnpm ---"
npm i -g pnpm --registry=https://registry.npmmirror.com/ 2>&1 | tail -6
echo "  --- 验证 ---"
command -v pnpm && pnpm --version
' 2>&1 | tail -18
