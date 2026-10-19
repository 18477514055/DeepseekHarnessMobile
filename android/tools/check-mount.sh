#!/system/bin/sh
# 检查 proot 是否成功挂载了手机存储
T=/data/data/com.dsh.mobile/files
echo "=== 1) proot.log 全文（前 20 行）==="
head -20 $T/proot.log 2>&1

echo ""
echo "=== 2) boot.log 里的挂载记录 ==="
grep -i "手机存储\|共享\|bind" $T/boot.log 2>/dev/null | tail -5

echo ""
echo "=== 3) 命令行里有没有 /mnt/phone ==="
grep -o -- "--bind=[^ ]*" $T/boot.log 2>/dev/null | tail -4

echo ""
echo "=== 4) diag.log 里的共享目录探测（这是 app 进程内的真实结果）==="
sed -n '1,20p' $T/diag.log 2>/dev/null
