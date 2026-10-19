# Third-Party Notices

This project bundles or links against the following third-party components.
Each remains under its own license; the MIT license of this project does not
override them.

## proot

- **Version**: 5.1.107.92 (termux fork)
- **License**: GPL-2.0
- **Source**: https://github.com/termux/proot
- **Usage**: bundled as `libproot.so` in `android/app/src/main/jniLibs/arm64-v8a/`
- **Note**: GPL-2.0 requires that the corresponding source be made available
  when the binary is distributed. The upstream repository above is the source
  this binary was built from. GPL-2.0 is not copyleft over the separate
  Android application that merely invokes it as a subprocess.

## proot loaders

- `libproot-loader.so`, `libproot-loader32.so` — same origin and license as proot (GPL-2.0).

## libandroid-shmem

- **License**: BSD-2-Clause
- **Source**: https://github.com/termux/libandroid-shmem
- **Usage**: `jniLibs/arm64-v8a/libandroid-shmem.so`

## talloc

- **License**: LGPL-3.0-or-later
- **Source**: https://talloc.samba.org/
- **Usage**: `jniLibs/arm64-v8a/libtalloc.so` (runtime-renamed to `libtalloc.so.2`)

## Debian rootfs

- **Version**: Debian 13 (trixie), arm64
- **License**: each bundled package carries its own license; Debian's
  `copyright` files inside the rootfs are authoritative.
- **Usage**: distributed as `rootfs.gz.bin` (not in this repository)

## Node.js

- **License**: MIT
- **Source**: https://nodejs.org/
- **Usage**: installed into the Debian rootfs

## pnpm

- **License**: MIT
- **Source**: https://github.com/pnpm/pnpm
- **Usage**: `pnpm-incr.gz.bin`

## @deepseek-ai/dsh

- **License**: see the package's own LICENSE inside the rootfs
- **Usage**: the DeepSeek Harness server, installed inside the rootfs

## DeepSeek whale logo

- The whale mark used for the launcher icon and splash screen is derived from
  the DeepSeek web frontend favicon (`favicon.svg`).
- **It is a DeepSeek trademark.** This project is not affiliated with or
  endorsed by DeepSeek. If you redistribute a modified build, consider
  replacing the mark.
