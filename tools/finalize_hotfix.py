from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

index_path = ROOT / "server/index.js"
index = index_path.read_text(encoding="utf-8")
valid_marker = "fs.writeFileSync(rotationMarker, 'per-installation TLS key v2\\n');"
if valid_marker not in index:
    index, count = re.subn(
        r"fs\.writeFileSync\(rotationMarker, 'per-installation TLS key v2\s*'\);",
        lambda _: valid_marker,
        index,
        count=1,
    )
    if count != 1:
        raise RuntimeError("Could not repair the TLS rotation marker string")
index_path.write_text(index, encoding="utf-8")

main_path = ROOT / "mobile_app/lib/main.dart"
main = main_path.read_text(encoding="utf-8")
main = main.replace(
    "throw const HandshakeException('Server certificate unavailable');",
    "throw HandshakeException('Server certificate unavailable');",
)
main_path.write_text(main, encoding="utf-8")

workflow = """name: Build and Test GigaLimit

on:
  pull_request:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Java
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'

      - name: Setup Flutter
        uses: subosito/flutter-action@v2
        with:
          flutter-version: '3.44.0'
          channel: stable

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.24'

      - name: Setup Android SDK
        uses: android-actions/setup-android@v3
        with:
          accept-android-sdk-licenses: true

      - name: Install Android NDK
        run: |
          sdkmanager "ndk;27.2.12479018"
          echo "NDK_HOME=$ANDROID_HOME/ndk/27.2.12479018" >> "$GITHUB_ENV"

      - name: Install server dependencies
        working-directory: server
        run: npm ci

      - name: Check server syntax
        working-directory: server
        run: |
          node --check index.js
          node --check db.js
          node --check build_bundle.js

      - name: Run server security tests
        working-directory: server
        run: node --test test/*.test.js

      - name: Build tun2socks for arm64-v8a
        working-directory: mobile_app/tun2socks
        run: |
          export CGO_ENABLED=1 GOOS=android GOARCH=arm64
          export CC=$ANDROID_HOME/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android35-clang
          export CXX=$ANDROID_HOME/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android35-clang++
          go build -v -buildmode=c-shared -o ../android/app/src/main/jniLibs/arm64-v8a/libtun2socks.so .

      - name: Build tun2socks for armeabi-v7a
        working-directory: mobile_app/tun2socks
        run: |
          export CGO_ENABLED=1 GOOS=android GOARCH=arm GOARM=7
          export CC=$ANDROID_HOME/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/armv7a-linux-androideabi35-clang
          export CXX=$ANDROID_HOME/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/armv7a-linux-androideabi35-clang++
          go build -v -buildmode=c-shared -o ../android/app/src/main/jniLibs/armeabi-v7a/libtun2socks.so .

      - name: Build tun2socks for x86_64
        working-directory: mobile_app/tun2socks
        run: |
          export CGO_ENABLED=1 GOOS=android GOARCH=amd64
          export CC=$ANDROID_HOME/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android35-clang
          export CXX=$ANDROID_HOME/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android35-clang++
          go build -v -buildmode=c-shared -o ../android/app/src/main/jniLibs/x86_64/libtun2socks.so .

      - name: Remove generated Go headers
        run: rm -f mobile_app/android/app/src/main/jniLibs/*/libtun2socks.h

      - name: Flutter dependencies
        working-directory: mobile_app
        run: flutter pub get

      - name: Flutter analyze
        working-directory: mobile_app
        run: flutter analyze --no-fatal-infos --no-fatal-warnings

      - name: Flutter tests
        working-directory: mobile_app
        run: flutter test

      - name: Build Android APK
        working-directory: mobile_app
        run: |
          flutter build apk --release
          cp build/app/outputs/flutter-apk/app-release.apk build/app/outputs/flutter-apk/GigaLimit_App.apk

      - name: Build Windows server executable
        working-directory: server
        run: npm run build:exe

      - name: Create release tag
        if: github.event_name == 'workflow_dispatch'
        run: |
          TAG="v1.0.0-${{ github.run_number }}"
          git tag "$TAG"
          git push origin "$TAG"

      - name: Release matching server and app
        if: github.event_name == 'workflow_dispatch'
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v1.0.0-${{ github.run_number }}
          name: GigaLimit v1.0.0-${{ github.run_number }}
          files: |
            mobile_app/build/app/outputs/flutter-apk/GigaLimit_App.apk
            server/GigaLimit_Server.exe
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
"""
(ROOT / ".github/workflows/build.yml").write_text(workflow, encoding="utf-8")

for relative in (
    ".github/workflows/runtime-migration.yml",
    "runtime_security_error.txt",
    "tools/apply_runtime_security.py",
    "tools/run_runtime_security.py",
    "tools/fix_post_migration.py",
    ".github/workflows/finalize-hotfix.yml",
):
    path = ROOT / relative
    if path.exists():
        path.unlink()

Path(__file__).unlink()
print("Final hotfix cleanup applied")
