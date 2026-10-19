// 顶层构建文件。★ 只声明插件，不声明仓库（仓库在 settings.gradle.kts）。
//
// ★ 版本选择的硬约束（2026-10-19 实测踩过）：
//   Gradle **9.6.0 起移除了** `org.gradle.api.problems.internal.InternalProblems`，
//   而 AGP 8.x 依赖它 ⇒ AGP 8.13.0 + Gradle 9.7.1 直接报：
//     "Plugin 'com.android.internal.application' relies on ... a Gradle internal API
//      that was removed in Gradle 9.6.0 ... or use Gradle 9.5."
//   本机只有 Gradle 9.7.1，所以必须用 **AGP 9.x**（已发布正式版 9.4.1）。
plugins {
    id("com.android.application") version "9.4.1" apply false
}
