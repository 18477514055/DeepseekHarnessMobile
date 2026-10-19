# Deepseek Harness Mobile

把 **DeepSeek Harness** 装进一个 APK：装完就能用，**不需要 Termux**、不需要 root、不需要外部运行时。

> 这不是远程桌面、也不是套壳网页。APK 里自带一个 **proot + Debian rootfs** 容器，
> Node.js 和 DSH 主程序都跑在里面，数据留在应用私有目录。

---

## 它是什么

| 项 | 值 |
|---|---|
| 应用名 | Deepseek Harness Mobile |
| 包名 | `com.dsh.mobile` |
| targetSdk / minSdk | **28 / 28**（★ 不可改，见下） |
| ABI | `arm64-v8a` |
| 容器 | proot 5.1.107.92 + Debian 13 (trixie) |
| 运行时 | Node.js（打包在 rootfs 内） |
| 侧载 | 是（不上架 Google Play） |

## 为什么 targetSdk 必须是 28

Android 的 SELinux `neverallow` 规则禁止 `untrusted_app` 域执行 `app_data_file`。
只有 `untrusted_app_25` / `untrusted_app_27`（即 **targetSdk ≤ 28**）被豁免。
Termux 自己也是 28。

⇒ 想上架 Play 就必须 targetSdk ≥ 33，容器立刻起不来。**这是自包含方案的根本代价。**

## 架构

```
┌─────────────────────────────────────────┐
│ Android App (com.dsh.mobile)            │
│  · MainActivity  → WebView              │
│  · DshService    → 前台服务 + 唤醒锁     │
│  · ProotLauncher → 起容器               │
│  · RootfsInstaller → 首次解压 rootfs    │
├─────────────────────────────────────────┤
│  jniLibs (nativeLibraryDir = apk_data_file, 可执行) │
│    libproot.so / libproot-loader.so / …  │
├─────────────────────────────────────────┤
│  files/rootfs  (posix 符号链接，必须留在 /data) │
│    Debian 13 + Node.js + @deepseek-ai/dsh │
├─────────────────────────────────────────┤
│  /storage/emulated/0/DeepseekHarness     │
│    ← 与手机文件管理器双向可见             │
└─────────────────────────────────────────┘
```

### 三条绕不开的硬约束

1. **proot 必须从 `nativeLibraryDir` 执行**
   那里挂的是 `apk_data_file`，有可执行权限；`files/` 是 `app_data_file`，没有。

2. **rootfs 必须留在 `/data/data/`**
   rootfs 里有 **501 个符号链接**（`bin → usr/bin` 等），`/sdcard` 是 FUSE，不支持 POSIX 符号链接。

3. **`useLegacyPackaging = true`**
   不写这句，PackageManager 不会把 jniLibs 解出来，`nativeLibraryDir` 是空的。

## 构建

```cmd
cd android
build.cmd            :: debug APK
build.cmd release    :: release APK
```

### 前置：三个大文件不在仓库里

仓库**只放源码**，以下载荷需自行准备（见 `docs/`）：

| 文件 | 大小 | 说明 |
|---|---|---|
| `android/app/src/main/assets/rootfs.gz.bin` | ~392 MB | Debian rootfs（gzip） |
| `android/app/src/main/assets/pnpm-incr.gz.bin` | ~23 MB | pnpm 二进制增量包 |
| `android/app/src/main/assets/mobile-adapt.gz.bin` | ~76 KB | 内置移动端插件（由 `_pk.cjs` 生成） |

★ 后缀是 `.gz.bin` 而不是 `.gz` —— **AGP 会自动解压 `.gz`**，把 374 MB 变成 1.3 GB。

### 本机路径

`build.cmd` 支持 `android/build.local.cmd` 覆盖（该文件被 gitignore）：

```cmd
set "AS_JDK=C:\Program Files\Android\Android Studio\jbr"
set "SDK=%LOCALAPPDATA%\Android\Sdk"
set "GRADLE=gradle.bat"
```

### 签名

`android/gradle.properties` 里的 `DSH_STORE_PASSWORD` / `DSH_KEY_PASSWORD` 需要自己填，
密钥库放 `android/keystore/dsh-mobile.jks`。两者都**不进版本库**。

## 目录结构

```
android/               Android 工程（Java + Gradle）
_plugin-src/           内置移动端插件 dsh-mobile-adaption
_ms-src/               插件：标签筛选 + 收藏
_pk.cjs                把插件打成 assets/mobile-adapt.gz.bin
_fixicon.cjs           从官方 favicon.svg 生成图标矢量图
_favicon.svg           官方鲸鱼图标源文件
docs/                  实证报告与工程说明
```

## 已知限制

- **不上架**：targetSdk=28 是硬约束。
- **不做开机自启**：Android 会因此限制应用（这是刻意设计），改为「点开后常驻」。
- **首次启动慢**：要解压 ~392 MB rootfs，约 30~60 秒。
- **仅 arm64-v8a**。

## License

MIT —— 见 [LICENSE](LICENSE)。

★ 第三方组件各自的许可证见 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md)。
其中 **proot 是 GPL-2.0**（分发二进制需附源码），**Debian rootfs 内各包沿用其原许可证**。
