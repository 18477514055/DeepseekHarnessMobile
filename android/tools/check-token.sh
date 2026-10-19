#!/system/bin/sh
# 检查 token 与服务状态
T=/data/data/com.dsh.mobile/files
echo "=== proot.log 里的 token ==="
grep -o 'token=[A-Za-z0-9_-]*' $T/proot.log 2>/dev/null | head -2
echo ""
echo "=== 用容器里的 node 测：这个 token 有效吗 ==="
NL=$(cat $T/.nl 2>/dev/null)
TOK=$(grep -o 'token=[A-Za-z0-9_-]*' $T/proot.log 2>/dev/null | head -1 | cut -d= -f2)
echo "TOK=$TOK"
echo "NL=$NL"
