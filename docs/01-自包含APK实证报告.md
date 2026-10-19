# 自包含 APK · 实证报告（2026-10-19）

> 这份文档是 `LEDGER.md` 的详细附件 —— 台账只留摘要，过程与全部实测数据在这里。
> 对应台账章节：§十四。

---

## 一、决定性验证：脱离 Termux 跑通

**测试目录**：手机 `$HOME/_selftest/`（完全独立于现有环境）
**测完处理**：只杀 3089，3080 正式服务未受任何影响

### 结果

```
>>> 容器起来了
PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
NAME="Debian GNU/Linux"
node:
v24.18.0
Termux usr 可见?
  ✗ 不可见(真独立)

[+48s] http=401
dsh web: http://127.0.0.1:3089/?token=...
```

**并存验证**：`3080 → 401` 与 `3089 → 401` 同时成立。
测试实例用的是 `_selftest/lib/libproot.so`（自己的副本），
**不是** Termux 的 `$PREFIX/bin/proot`。

---

## 二、proot 的完整依赖清单

| 文件 | 来源 | 体积 |
|---|---|---|
| `proot` | `$PREFIX/bin/proot` | 244,088 B |
| `libproot-loader.so` | `$PREFIX/libexec/proot/loader` | 18,136 B |
| `libproot-loader32.so` | `$PREFIX/libexec/proot/loader32` | 6,244 B |
| `libandroid-shmem.so` | `$PREFIX/lib/libandroid-shmem.so` | 14,432 B |
| `libtalloc.so.2` | `$PREFIX/lib/libtalloc.so.2.4.3` | 31,440 B |
| **合计** | | **约 314 KB** |

★ 注意：`libexec/proot/loader` 这个文件**很容易漏**，但漏了就起不来。

---

## 三、★ 四个实测踩到的坑

### 坑 ①：proot 有 RUNPATH 硬依赖 ⇒ "跑起来了"可能是假独立

```
$ readelf -d libproot.so
  0x000000000000001d (RUNPATH)  Library runpath: [/data/data/com.termux/files/usr/lib]
```

第一次用自己的 lib 目录跑 `--version`，输出正常 —— 但它**从 Termux 的 lib 读的库**。
必须 `LD_LIBRARY_PATH=$T/lib` 显式覆盖，才能证明真独立。

★ **教训：`有输出` ≠ `独立`。** 必须把 Termux 路径屏蔽后重测。

### 坑 ②：必须显式设 `PROOT_LOADER`

```sh
strings proot | grep PROOT_LOADER
→ PROOT_LOADER
→ PROOT_LOADER_32
```

不设会失败。要指向 `libexec/proot/loader`。

### 坑 ③：`/tmp` 不可写

```
$ touch /tmp/_probe
touch: cannot touch '/tmp/_probe': Permission denied
```

必须设 `PROOT_TMP_DIR`，指到 app 可写目录。

### 坑 ④：`sysdata` 那 10 个伪造文件是硬需求

```
loadavg(25B)                          stat(1278B)
sys_empty(目录, 3452B)                 uptime(14B)
version(151B)                         vmstat(3557B)
sysctl_entry_cap_last_cap(3B)         sysctl_inotify_max_user_watches(5B)
sysctl_kernel_overflowgid(6B)         sysctl_kernel_overflowuid(6B)
```

Android 上真 `/proc/loadavg`、`/proc/stat`、`/proc/uptime`、`/proc/version`
对 app **不可读**（实测 `/proc/1/cmdline: Permission denied`），
proot-distro 用这些**预先伪造的文件** bind 进去。

⇒ 自包含版必须自己生成一份，否则容器里 `free` / `uptime` / `ps` 会报错。

---

## 四、★ 打包清单必须包含 python3

测试容器的精简 PATH 下报：

```
[lingshu-bridge] 灵枢进程启动失败: spawn python3 ENOENT
[lingshu-bridge] 解释器「python3」不可执行（ENOENT）。Linux/macOS 发行版按 PEP 394
只提供 python3（这是默认状态，不是环境损坏）。修法（任一）：
  ① cordis.yml 的 config.python 设为 'python3'（优先级最高）
  ② 设环境变量 MDCG_PYTHON=python3（容器/CI 推荐）
  ③ 确认 python3 在 PATH 中（which python3）。改完需重启 DSH。
```

`lingshu-bridge`（记忆库插件）要 spawn `python3`。
⇒ **正式打包的 rootfs 必须带 python3**，否则这个插件会挂。
（本次测试没带所以报错；DSH 主体不受影响，仍正常起到 401。）

---

## 五、已验证的完整启动命令（可直接固化）

```sh
T=<app files dir>
RF=$T/rootfs
SD=$T/sysdata

env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  HOME=/root USER=root TERM=dumb \
  PROOT_LOADER=$T/lib/libproot-loader.so \
  PROOT_TMP_DIR=$T/tmp \
  LD_LIBRARY_PATH=$T/lib \
  $T/lib/libproot.so \
  --kill-on-exit --link2symlink --sysvipc \
  "--kernel-release=\Linux\localhost\6.17.0-PRoot-Distro\#1 SMP PREEMPT_DYNAMIC Fri, 10 Oct 2025 00:00:00 +0000\aarch64\localdomain\-1\\" \
  -L --change-id=0:0 --rootfs=$RF --cwd=/root \
  --bind=/dev --bind=/proc --bind=/sys \
  --bind=/dev/urandom:/dev/random \
  --bind=$SD/sys_empty:/sys/fs/selinux \
  --bind=$SD/loadavg:/proc/loadavg \
  --bind=$SD/stat:/proc/stat \
  --bind=$SD/uptime:/proc/uptime \
  --bind=$SD/version:/proc/version \
  /bin/sh -c 'export PATH=/opt/node/bin:$PATH; cd /root; \
               exec node /opt/node/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
               web --no-open --host 127.0.0.1 --port 3080'
```

★ **没有** `--bind=/data/data/com.termux/files/usr`（proot-distro 默认有，我们去掉）。
★ 就绪约 **48 秒**（精简环境；正式环境插件更多，预计 55~90 秒，与现状一致）。

---

## 六、体积实测（真数字）

排除项：`tmp`、`root/.npm`、`root/.dsh`、`root/.dsh-cand`、`root/.local`、`root/.cache`、
`opt/.../dsh.retired-0.2.0`、`dev`、`proc`、`sys`、`.l2s`

★ 陷阱：`-C $RF .` 时必须用**相对路径** `--exclude=./tmp`，绝对路径匹配不上（踩过）。

| 项 | 体积 | 耗时 |
|---|---|---|
| 干净 tar（未压缩） | **1.24 GB** | 95 秒 |
| **zstd -19** | **226.2 MB** | 104 秒（构建机） |
| zstd -3 | 305.9 MB | 7 秒 |

压缩比约 **5.6:1**。**APK 预计 230~250 MB**。

- 侧载：完全没问题
- **超过 Play base 模块 200MB 上限** ⇒ 上架需 Play Asset Delivery 分包
- 104 秒是**构建机**耗时；用户手机上要做的是**解压**（快得多，但必须配进度条）
- 必须压进 200MB 以内 → 用 `-19`；要出包快 → `-3`（7 秒，只大 80MB）

---

## 七、node 不依赖 Termux（关键）

```
node 的 RUNPATH / RPATH : 无（走 ld.so.cache 默认路径）

只给 Debian lib:
  env -i PATH=/usr/bin:/bin LD_LIBRARY_PATH=/usr/lib/aarch64-linux-gnu \
    /opt/node/bin/node -e 'console.log(process.version)'
  → node OK in debian libs: v24.18.0
```

node 的 NEEDED：
```
libdl.so.2 / libstdc++.so.6 / libm.so.6 / libgcc_s.so.1
libpthread.so.0 / libc.so.6 / ld-linux-aarch64.so.1
```

Debian rootfs 全都有：`/usr/lib/aarch64-linux-gnu/{libc.so.6, libstdc++.so.6, libgcc_s.so.1}`。
`/etc/ld.so.conf.d/*.conf` 含该路径，`ldconfig -p` 已验证。

⇒ **打包 rootfs 就够，不需要携带 Termux 的任何东西。**

---

## 八、现状总账

| 项 | 状态 |
|---|---|
| 容器方案 | **保留**，proot 原样 |
| 脱离 Termux | ✅ **已实证** |
| DSH 在独立容器 | ✅ **跑通**，48 秒到 401 |
| proot 全套依赖 | 约 314 KB |
| rootfs | 1.24 GB → zstd -19 **226 MB** |
| APK 预计 | **230~250 MB** |
| 未知数 | **无** |

**剩下的全是工程活**：建 Android 工程 → rootfs 压进 assets → 首启解压 + 进度条 →
jniLibs 放 proot 五件套 → 前台服务 specialUse → WebView 从 `RUN_COMMAND` 改成
`Runtime.exec()` 调上面那条命令 → 生成 sysdata 十个假文件 → 带上 python3。
