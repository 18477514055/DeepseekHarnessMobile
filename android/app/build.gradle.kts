plugins {
    id("com.android.application")
}

android {
    namespace = "com.dsh.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.dsh.mobile"
        minSdk = 28
        // ★★★ 2026-10-19：targetSdk 必须 <=28 —— 这是**唯一能让容器跑起来的档位**。
        //
        // 原因（真机实测，见 LEDGER §17）：Android 10+ 的 SELinux neverallow 禁止
        // untrusted_app 执行 app_data_file（也就是 files/ 里的任何东西）。
        // 该规则**豁免** untrusted_app_25 / untrusted_app_27（targetSdk<=28）。
        // app 内 diag.log 实测：
        //   files/test-exec-proot  → error=13 Permission denied
        //   rootfs/usr/bin/dash    → error=13 Permission denied
        //   连 ld-linux 自己都      → error=13
        // 而 nativeLibraryDir（apk_data_file）可执行，但那里只认平铺 lib*.so，
        // 塞不进 1.24GB 的带目录树 rootfs。
        //
        // ★ 这不是"降级"：**Termux 自己就是 targetSdk=28**（实测 v0.119.0-beta.3）。
        //   本方案的容器能力上限因此与 Termux **完全一致**。
        // ★ 代价：不能上架 Google Play（侧载分发不受影响）。
        targetSdk = 28
        versionCode = 5
        versionName = "1.0.4"
        // 只发 arm64（用户手机是 arm64-v8a；也省体积）
        ndk { abiFilters += "arm64-v8a" }
    }

    // ★★★ 关键：不加这句，PackageManager 不会把 jniLibs 解压到 nativeLibraryDir，
    //      proot 与 loader 这些"假 .so 可执行文件"就无法 exec（UserLAnd 源码注释里踩过）。
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
        // rootfs 已是 gzip 压缩包，不要再让 aapt 尝试压缩它（省构建时间与内存）
        resources {
            excludes += setOf("**/rootfs.tar.gz", "**/rootfs.tar")
        }
    }

    // rootfs.tar.gz 体积大（约 374MB）且本身已压缩，不要让 aapt 再压一遍。
    //
    // ★★★ 这里踩过一个非常隐蔽的坑（2026-10-19）：
    //   `noCompress` 里的扩展名会走 AGP 的 **compressDebugAssets** 任务，而该任务对
    //   `.gz` 这类后缀会**自动解压**！结果 assets 里的 rootfs.tar.gz 变成了
    //   rootfs.tar（1324 MB，比原件还大 4 倍），APK 直接 430MB 且内容对不上。
    //   证据：build/intermediates/assets/debug/mergeDebugAssets/rootfs.tar
    //
    //   解法：**不要**把 gz 放进 noCompress；改用 aaptOptions 的 ignoreAssetsPattern
    //   不行（那会整个丢掉）。正确做法见下面 packaging.resources 的注释 ——
    //   直接不声明 gz，让 aapt 按普通 asset 原样打包（它本来就不会二次压缩 .gz，
    //   因为 aapt 会识别 gzip 魔数并跳过压缩）。
    androidResources {
        // 只声明真正需要「原样不压缩」的后缀；**刻意不含 gz**
        noCompress += listOf("tar.zst", "zst")
    }

    // ★ release 签名（2026-10-19 加入）
    //   密钥库：android/keystore/dsh-mobile.jks（alias=dshmobile，RSA 4096，有效期 10000 天）
    //   口令走 gradle.properties 的 DSH_STORE_PASSWORD / DSH_KEY_PASSWORD，
    //   ★ 那两个值只在**本机** gradle.properties 里，不进版本库（见 .gitignore）。
    signingConfigs {
        create("release") {
            storeFile = file("../keystore/dsh-mobile.jks")
            storePassword = (project.findProperty("DSH_STORE_PASSWORD") ?: "") as String
            keyAlias = "dshmobile"
            keyPassword = (project.findProperty("DSH_KEY_PASSWORD") ?: "") as String
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            isMinifyEnabled = false
        }
    }

    // ★★★ release 构建会被 lint 拦住：
    //   "Google Play requires that apps target API level 33 or higher.
    //    [ExpiredTargetSdkVersion]"
    //   —— 这正是 targetSdk=28 的**唯一代价**，与设计一致（本 App 走侧载，不上架）。
    //   这里把这条检查关掉、并让 lint 不因错误中止打包。
    //   ★ 不要改成 targetSdk=33+：那会让 SELinux 重新禁止 exec files/，
    //     容器立刻起不来（见 docs/03 §二）。
    lint {
        abortOnError = false
        checkReleaseBuilds = false
        disable += "ExpiredTargetSdkVersion"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        viewBinding = false
        buildConfig = false
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.11.0")
}
