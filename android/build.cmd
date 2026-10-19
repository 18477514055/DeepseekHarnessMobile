@echo off
REM ==========================================================================
REM  Deepseek Harness Mobile - one-click build
REM
REM  Why this script: the build needs JAVA_HOME / ANDROID_HOME / an absolute
REM  gradle path. Typing them by hand is error prone.
REM
REM  NOTE: this file is deliberately pure ASCII + CRLF, so it works under both
REM  GBK and UTF-8 code pages on Windows with no mojibake.
REM
REM  Usage:  build.cmd            -> debug APK
REM          build.cmd release    -> release APK (still debug-signed, for sideload)
REM ==========================================================================
setlocal

REM --------------------------------------------------------------------------
REM  Local overrides: if build.local.cmd exists next to this file, load it.
REM  That file is gitignored, so machine-specific absolute paths (SDK, Gradle
REM  dist, JDK) never leak into the public repo.
REM --------------------------------------------------------------------------
if exist "%~dp0build.local.cmd" call "%~dp0build.local.cmd"

if not defined AS_JDK set "AS_JDK=C:\Program Files\Android\Android Studio\jbr"
if not defined SDK if defined ANDROID_SDK_ROOT set "SDK=%ANDROID_SDK_ROOT%"
if not defined SDK set "SDK=%LOCALAPPDATA%\Android\Sdk"
if not defined GRADLE set "GRADLE=gradle.bat"

if not exist "%AS_JDK%\bin\java.exe" (
  echo [x] Android Studio JDK not found: %AS_JDK%
  exit /b 1
)
if not exist "%SDK%\platforms" (
  echo [x] Android SDK not found: %SDK%
  exit /b 1
)
if not exist "%GRADLE%" (
  echo [x] gradle not found: %GRADLE%
  exit /b 1
)

set "JAVA_HOME=%AS_JDK%"
set "ANDROID_HOME=%SDK%"
set "ANDROID_SDK_ROOT=%SDK%"
set "PATH=%JAVA_HOME%\bin;%PATH%"

cd /d "%~dp0"

set "TASK=assembleDebug"
if /i "%~1"=="release" set "TASK=assembleRelease"

echo === checking rootfs and jniLibs ===
if not exist "app\src\main\assets\rootfs.gz.bin" (
  echo [x] missing assets\rootfs.gz.bin ^(374MB rootfs archive^)
  exit /b 1
)
for %%F in (libproot.so libproot-loader.so libproot-loader32.so libandroid-shmem.so libtalloc.so) do (
  if not exist "app\src\main\jniLibs\arm64-v8a\%%F" (
    echo [x] missing jniLibs\arm64-v8a\%%F
    exit /b 1
  )
)
echo     OK

echo.
echo === tar parser self-check ^(on PC, takes seconds^) ===
node tools\verify-tar.js
if errorlevel 1 (
  echo [x] tar self-check failed - fix it before packaging
  exit /b 1
)

echo.
echo === gradle %TASK% ===
call "%GRADLE%" %TASK% --no-daemon
if errorlevel 1 (
  echo [x] build failed
  exit /b 1
)

echo.
for /r "app\build\outputs\apk" %%P in (*.apk) do (
  echo APK: %%P
)
endlocal
