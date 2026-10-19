#!/system/bin/sh
# 查 APK 是否依赖 Termux（卸载 Termux 会不会导致 APK 挂掉）
R=/data/data/com.dsh.mobile/files/rootfs

echo "=== 1) 目录本身是独立的吗 ==="
ls -ld /data/data/com.dsh.mobile/files 2>&1
ls -ld /data/data/com.termux 2>&1

echo ""
echo "=== 2) ★ 关键：统计指向 com.termux 的符号链接（全盘扫）==="
CNT=0
find $R -type l 2>/dev/null | while read f; do
  t=$(readlink "$f" 2>/dev/null)
  case "$t" in
    *com.termux*) echo "  BAD: $f -> $t" ;;
  esac
done
echo "  （上面若为空 = 没有指向 Termux 的链接）"

echo ""
echo "=== 3) 检查 dshhome（用户数据）里有没有 ==="
find /data/data/com.dsh.mobile/files/dshhome -type l 2>/dev/null | while read f; do
  t=$(readlink "$f" 2>/dev/null)
  case "$t" in
    *com.termux*) echo "  BAD: $f -> $t" ;;
  esac
done
echo "  （同上）"

echo ""
echo "=== 4) ★ 检查绝对路径的符号链接（不只 termux，所有绝对路径都可能有问题）==="
find $R/opt -type l 2>/dev/null | head -50 | while read f; do
  t=$(readlink "$f" 2>/dev/null)
  case "$t" in
    /*) echo "  绝对链接: ${f#$R} -> $t" ;;
  esac
done | head -20

echo ""
echo "=== 5) 磁盘占用（证明是独立数据）==="
du -sh /data/data/com.dsh.mobile 2>/dev/null
