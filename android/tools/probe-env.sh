T=/data/data/com.dsh.mobile/files
NL=$(ls -d /data/app/*/com.dsh.mobile-*/lib/arm64 2>/dev/null | head -1)
P=$NL/libproot.so
echo "nativeLib=$NL"

echo "=== Q) 只给 Java 会设的那几个环境变量，清掉其它 ==="
(
  # 保留白名单，其余 unset（模拟 ProcessBuilder.environment().clear()）
  for v in $(env | cut -d= -f1); do
    case "$v" in
      PATH|HOME|USER|TERM|PROOT_LOADER|PROOT_LOADER_32|PROOT_TMP_DIR|LD_LIBRARY_PATH|MDCG_PYTHON|PWD|SHLVL|_) ;;
      *) unset "$v" ;;
    esac
  done
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  export HOME=/root USER=root TERM=dumb
  export PROOT_LOADER=$T/lib/libproot-loader.so
  export PROOT_LOADER_32=$T/lib/libproot-loader32.so
  export PROOT_TMP_DIR=$T/tmp
  export LD_LIBRARY_PATH=$T/lib
  export MDCG_PYTHON=python3

  $P --link2symlink --sysvipc --kill-on-exit -L --change-id=0:0 --cwd=/root \
     --rootfs=$T/rootfs -b /dev -b /proc -b /sys -b /dev/urandom:/dev/random \
     -b $T/sysdata/sys_empty:/sys/fs/selinux -b $T/sysdata/loadavg:/proc/loadavg \
     -b $T/sysdata/stat:/proc/stat -b $T/sysdata/uptime:/proc/uptime \
     -b $T/sysdata/version:/proc/version -b $T/dshhome:/root/.dsh \
     /bin/sh -c 'echo Q-ok'
) 2>&1 | head -14

echo ""
echo "=== R) 再试：不清环境，但把 PATH 换掉（对照组）==="
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PROOT_LOADER=$T/lib/libproot-loader.so PROOT_TMP_DIR=$T/tmp LD_LIBRARY_PATH=$T/lib
$P --link2symlink --sysvipc --kill-on-exit -L --change-id=0:0 --cwd=/root \
   --rootfs=$T/rootfs -b /dev -b /proc -b /sys -b /dev/urandom:/dev/random \
   -b $T/sysdata/sys_empty:/sys/fs/selinux -b $T/sysdata/loadavg:/proc/loadavg \
   -b $T/sysdata/stat:/proc/stat -b $T/sysdata/uptime:/proc/uptime \
   -b $T/sysdata/version:/proc/version -b $T/dshhome:/root/.dsh \
   /bin/sh -c 'echo R-ok' 2>&1 | head -14
