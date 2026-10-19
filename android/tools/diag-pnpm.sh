#!/system/bin/sh
# 诊断 pnpm 符号链接为什么没建成功
T=/data/data/com.dsh.mobile/files
R=$T/rootfs

echo "=== 1) pnpm 目录在不在 ==="
ls -ld $R/opt/node/lib/node_modules/pnpm 2>&1
ls $R/opt/node/lib/node_modules/pnpm/ 2>&1 | head -6

echo ""
echo "=== 2) bin 下的链接 ==="
ls -l $R/opt/node/bin/ 2>&1

echo ""
echo "=== 3) 宿主侧看到的（run-as 能读 opt 吗）==="
ls -ld $R/opt/node/bin 2>&1
