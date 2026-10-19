#!/system/bin/sh
# 检查 APK 内 rootfs 的功能完整度
T=/data/data/com.dsh.mobile/files
R=$T/rootfs

echo "=== 1) web profile 目录 ==="
ls -la $R/root/.dsh/profiles/ 2>&1

echo ""
echo "=== 2) web profile 的 package.json ==="
cat $R/root/.dsh/profiles/web/package.json 2>&1 | head -40

echo ""
echo "=== 3) 已安装的插件（node_modules 顶层）==="
ls $R/root/.dsh/profiles/web/node_modules/ 2>&1 | head -30

echo ""
echo "=== 4) dsh 自带的 profile 模板（决定默认有几个插件）==="
ls $R/opt/node/lib/node_modules/@deepseek-ai/ 2>&1
