#!/system/bin/sh
# 从容器内部查功能完整度（root/ 是 700，宿主 run-as 读不了）
T=/data/data/com.dsh.mobile/files
NL=$(cat $T/.nl 2>/dev/null)
[ -z "$NL" ] && NL=$(ls -d /data/app/*/com.dsh.mobile-*/lib 2>/dev/null | head -1)
NL="$NL/arm64"
echo "NL=$NL"
ls "$NL/libproot.so" >/dev/null 2>&1 || echo "WARN: libproot.so 不在 $NL"

PROOT_LOADER=$T/lib/libproot-loader.so \
PROOT_TMP_DIR=$T/tmp \
LD_LIBRARY_PATH=$T/lib \
  $NL/libproot.so --link2symlink -r $T/rootfs \
    -b /dev -b /proc -b /sys -b /dev/urandom:/dev/random -w /root \
    /bin/sh -c '
echo "=== A) profiles 目录 ==="
ls /root/.dsh/profiles/

echo ""
echo "=== B) web profile 的 package.json ==="
cat /root/.dsh/profiles/web/package.json 2>/dev/null | head -45

echo ""
echo "=== C) 已装插件 ==="
ls /root/.dsh/profiles/web/node_modules/ 2>/dev/null | head -25

echo ""
echo "=== D) dsh 版本与 profile 模板 ==="
export PATH=/opt/node/bin:$PATH
node /opt/node/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --version 2>&1 | head -3

echo ""
echo "=== E) 常用命令是否在 ==="
for c in node npm git python3 tar gzip curl wget bash apt; do
  p=$(command -v $c 2>/dev/null)
  if [ -n "$p" ]; then echo "  OK   $c -> $p"; else echo "  MISS $c"; fi
done
' 2>&1
