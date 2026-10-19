#!/system/bin/sh
# 只统计"关键路径"上的 Termux 依赖，不打印海量明细
R=/data/data/com.dsh.mobile/files/rootfs

echo "=== 1) 关键路径（决定能否启动）有没有 Termux 依赖 ==="
for p in opt/node/bin/node opt/node/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
         usr/bin/sh usr/bin/dash usr/bin/python3 usr/lib usr/bin lib \
         opt/node/lib/node_modules/pnpm/bin/pnpm.mjs; do
  if [ -L "$R/$p" ]; then
    t=$(readlink "$R/$p")
    case "$t" in
      *com.termux*) echo "  ❌ 依赖Termux: $p -> $t" ;;
      *) echo "  OK  $p -> $t" ;;
    esac
  elif [ -e "$R/$p" ]; then
    echo "  OK  $p (实体)"
  else
    echo "  MISS $p"
  fi
done

echo ""
echo "=== 2) Termux 依赖的总数（分区域）==="
echo -n "  opt/ 下:    "
find $R/opt -type l 2>/dev/null | while read f; do readlink "$f" 2>/dev/null; done | grep -c "com.termux" 
echo -n "  root/ 下:   "
find $R/root -type l 2>/dev/null | while read f; do readlink "$f" 2>/dev/null; done | grep -c "com.termux"
echo -n "  usr/ 下:    "
find $R/usr -type l 2>/dev/null | while read f; do readlink "$f" 2>/dev/null; done | grep -c "com.termux"
echo -n "  var/ 下:    "
find $R/var -type l 2>/dev/null | while read f; do readlink "$f" 2>/dev/null; done | grep -c "com.termux"

echo ""
echo "=== 3) 这些依赖在哪几个目录（归类）==="
find $R -type l 2>/dev/null | while read f; do
  t=$(readlink "$f" 2>/dev/null)
  case "$t" in
    *com.termux*)
      # 取相对路径的前 3 段
      rel=${f#$R/}
      echo "$rel" | cut -d/ -f1-3
      ;;
  esac
done | sort | uniq -c | sort -rn | head -12
