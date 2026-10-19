# Android 工程说明（Deepseek Harness Mobile）

> 目标：一个 APK，装上就能用，**不依赖 Termux**、不依赖任何外部 APP。
> 容器（proot + Debian rootfs）**保留**，整个塞进 APK。

---

## 一、怎么构建

```cmd
cd android
build.cmd            :: 出 debug APK
build.cmd release    :: 出 release APK（用 release 签名，侧载用）
```

`build.cmd` 会先跑 `tools/verify-tar.js` 自检，通过才打包。

**环境**（脚本里已固定，不用手配）：

| 项 | 值 |
|---|---|
| JDK | `C:\Program Files\Android\Android Studio\jbr`（25.0.3） |
| SDK | `%LOCALAPPDATA%\Android\Sdk`（build-tools 36.0.0 / platform android-37.0） |
| Gradle | `%USERPROFILE%\.gradle\wrapper\dists\gradle-9.7.1-bin\...\gradle.bat` |

★ **本机路径走 `build.local.cmd`**（不进版本库）：
在 `android/` 下建一个 `build.local.cmd`，里面 `set "SDK=..."` / `set "GRADLE=..."`，
`build.cmd` 会自动加载它。这样绝对路径不会泄漏到公开仓库。

---

## 二、★ 构建环境的两个硬约束（都踩过）

### 1. AGP 必须是 9.x，不能用 8.x

```
Gradle 9.6.0 起移除了 org.gradle.api.problems.internal.InternalProblems，
而 AGP 8.x 依赖它，报：
  "Plugin 'com.android.internal.application' relies on ... a Gradle internal API
   that was removed in Gradle 9.6.0 ... or use Gradle 9.5."
```

本机只有 Gradle 9.7.1 ⇒ **必须 AGP 9.x**（当前用 9.4.1）。

### 2. 工程路径含中文，必须关掉 AGP 的路径检查

`gradle.properties` 里：

```properties
android.overridePathCheck=true
```

不加就直接 `Your project path contains non-ASCII characters` 拒绝构建。

---

## 三、★ assets 命名：为什么叫 `rootfs.gz.bin`

这是本项目最隐蔽的一个坑。

**现象**：assets 里明明是 `rootfs.tar.gz`（374 MB），构建后 APK 里却是
`assets/rootfs.tar`（**1324 MB**，比原件还大 4 倍），APK 变成 430 MB。

**根因**：AGP 的 `compressDebugAssets` 任务对 `.gz` 后缀会**自动解压**。
`noCompress` 里声明 `.gz` 反而会触发它 —— 因为那个列表走的就是这条任务。

**解法**：把文件改名成 **`rootfs.gz.bin`**，扩展名不认识就不会被动。
Java 侧用 `GZIPInputStream` 解压，逻辑不变。

**验证方法**：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z=[IO.Compression.ZipFile]::OpenRead("app\build\outputs\apk\debug\app-debug.apk")
$z.Entries | Where-Object {$_.FullName -like "assets/*"} | Select-Object FullName, Length
```

必须看到 `assets/rootfs.gz.bin  391967377`（≈374 MB），**不是** `rootfs.tar`。

---

## 四、jniLibs 命名：只能是 `lib*.so`

jniLibs 里的文件必须满足 `lib<name>.so`，否则 **AGP 会静默丢弃**。

踩过：`libtalloc.so.2` 不符合规则，没被打进 APK，
运行时 proot 找不到依赖库 ⇒ 莫名其妙的启动失败。

现在 `libtalloc.so.2` 在 jniLibs 里叫 **`libtalloc.so`**，
Java 侧复制到 `files/lib/` 时再改回 `libtalloc.so.2`（见 `ProotLauncher.BINS`）。

**验证方法**：

```powershell
$z.Entries | Where-Object {$_.FullName -like "lib/*"} | Select-Object FullName
```

必须五个都在：`libproot.so` / `libproot-loader.so` / `libproot-loader32.so` /
`libandroid-shmem.so` / `libtalloc.so`。

---

## 五、目录结构

```
android/
├── build.cmd                          一键构建（纯 ASCII + CRLF）
├── gradle.properties                  ★ 含 android.overridePathCheck=true
├── settings.gradle.kts
├── build.gradle.kts                   ★ AGP 9.4.1
├── tools/
│   ├── verify-tar.js                  电脑端验证 tar 解析（几秒，替代真机往返）
│   ├── verify-extract.js              电脑端模拟完整解压到临时目录
│   └── fix-cmd-encoding.js            把 .cmd 写成纯 ASCII + CRLF
└── app/
    ├── build.gradle.kts               ★ useLegacyPackaging = true 是关键
    └── src/main/
        ├── AndroidManifest.xml        ★ specialUse 前台服务
        ├── assets/rootfs.gz.bin       374 MB
        ├── jniLibs/arm64-v8a/         proot 五件套（约 314 KB）
        ├── java/com/dsh/mobile/
        │   ├── Cfg.java               路径常量 + 启动日志
        │   ├── Sysdata.java           生成 10 个伪造 /proc 文件
        │   ├── RootfsInstaller.java   ★ 自写 tar 解析（三个坑，见下）
        │   ├── ProotLauncher.java     ★ proot 命令行（真机验证过）
        │   ├── DshService.java        前台服务 + wake lock + 拉起容器
        │   └── MainActivity.java      进度页 → WebView
        └── res/
```

---

## 六、★★ RootfsInstaller 踩过的三个 tar 坑

都在电脑端用 `tools/verify-tar.js` 测出来了（**不要靠真机往返发现这些**，
一次装 APK 要 5 分钟，这里跑一遍 4 秒）。

### 坑① 每个条目数据后必须跳过 512 字节对齐填充

忘了跳 ⇒ 下一个 header 错位 ⇒ 解析出乱七八糟的文件名（实测解析出一个叫 `:` 的文件）。

```java
// 读完 size 字节后
int p = pad(size);          // (512 - size % 512) % 512
if (p > 0) skipExact(p);    // ← 漏了这行就全错位
```

### 坑② 判目录要用**原始名字**

`sanitize("./")` 返回空串，之后 `name.endsWith("/")` 就失效，顶层 `./` 被当文件写 ⇒
`EISDIR: files/rootfs`。

```java
e.isDir = (type == '5')
        || (type == 0 && raw.endsWith("/"))   // 用 raw，不是 sanitize 后的
        || e.name.isEmpty();
```

### 坑③ 符号链接必须真建

Debian rootfs 里有 **501 个符号链接**，包括：

```
bin             -> usr/bin        ← 没有它，连 /bin/sh 都不存在
lib             -> usr/lib
usr/bin/sh      -> dash
usr/bin/python3 -> python3.13
etc/os-release  -> ../usr/lib/os-release
```

当普通文件处理 ⇒ `/bin/sh` 不存在 ⇒ 容器根本起不来。

```java
case '2':  // 符号链接
    Files.createSymbolicLink(out.toPath(), Path.of(e.linkName));
```

★ 连带影响：`isInstalled()` 必须查 **`usr/bin/sh`**，不能查 `bin/sh`
（`bin` 本身是链接）。这一条是电脑端测试发现的。

---

## 七、电脑端与真机验证的分工

| 能在这台电脑上验证的 | 只能在真机上验证的 |
|---|---|
| tar 解析正确性（条目数 / 类型 / 名称 / 链接目标） | 符号链接能否 `createSymbolicLink` |
| 解压后的文件树结构 | 可执行位是否真的生效 |
| 关键文件是否都在包里 | proot 能否在 app 沙箱里 exec |
| APK 里 assets / jniLibs 是否打对 | 容器能否起来、DSH 能否监听 3080 |
| 构建是否成功 | 解压耗时、WebView 渲染 |

★ **Windows 上 `createSymbolicLink` 需要管理员权限或开发者模式**（实测 EPERM），
chmod 也基本无效 ⇒ `verify-extract.js` 在 Windows 上会把这 5 项标成「⏭️ 跳过」，
**那不是失败**。要真验这些，用 WSL 或直接在真机上跑。

---

## 八、运行时的目录布局（files/）

```
files/
├── rootfs/           Debian rootfs（首启从 assets 解压，约 1.24 GB）
├── lib/              proot 五件套（从 nativeLibraryDir 复制）
├── tmp/              PROOT_TMP_DIR（app 沙箱里 /tmp 不可写）
├── sysdata/          10 个伪造的 /proc 文件（Android 上真 /proc 读不了）
├── dshhome/          bind 到容器内 /root/.dsh（用户数据，可保留）
├── boot.log          启动过程日志（★ logcat 会很短，事后查这个）
├── proot.log         容器 stdout/stderr
└── .rootfs-ready     解压完成标记
```

---

## 九、保活三件套（用户明确：不做开机自启）

1. **前台服务 `specialUse`**（manifest 已声明）
   `dataSync` 在 targetSdk≥35 时后台累计 6 小时会被系统停掉，`specialUse` 没有上限。
2. **`PARTIAL_WAKE_LOCK`**（`DshService` 里拿）
   不拿的话 MIUI 会把整个 App 判为可回收（实测 `am_kill ... SwipeUpClean`）。
3. **引导用户开白名单**（`MainActivity.maybePromptBattery()`）

★ **不做 `BOOT_COMPLETED`** —— 用户原话「那样子的话容易被安卓盯上」。
代价：手机重启后需要手动点开一次。
