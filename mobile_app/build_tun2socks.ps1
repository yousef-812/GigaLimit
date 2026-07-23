# build_tun2socks.ps1
# Builds the JNI shared libraries consumed by VpnProxyService.
# Requires: Go 1.21+ and an installed Android NDK.

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tunDir = Join-Path $scriptDir "tun2socks"
$jniLibsDir = Join-Path $scriptDir "android\app\src\main\jniLibs"
$ndkRoot = if ($env:ANDROID_NDK_HOME) {
    $env:ANDROID_NDK_HOME
} elseif (Test-Path "C:\AndroidSDK\ndk") {
    Get-ChildItem "C:\AndroidSDK\ndk" -Directory |
        Sort-Object Name -Descending |
        Select-Object -First 1 -ExpandProperty FullName
} else {
    throw "Android NDK not found. Set ANDROID_NDK_HOME to the NDK directory."
}
$toolchainDir = Join-Path $ndkRoot "toolchains\llvm\prebuilt\windows-x86_64\bin"

if (-not (Test-Path $toolchainDir)) {
    throw "Android NDK LLVM toolchain not found at $toolchainDir"
}

Write-Host "=== Building tun2socks for Android ===" -ForegroundColor Green

try {
    $goVersion = & go version 2>&1
    Write-Host "Found: $goVersion" -ForegroundColor Cyan
} catch {
    Write-Host "ERROR: Go is not installed. Download from https://go.dev/dl/" -ForegroundColor Red
    exit 1
}

Write-Host "`nDownloading dependencies..." -ForegroundColor Yellow
Push-Location $tunDir
go mod tidy
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
Pop-Location

$builds = @(
    @{ Arch = "arm64"; Suffix = "arm64-v8a"; GOARM = ""; Compiler = "aarch64-linux-android21-clang" },
    @{ Arch = "arm"; Suffix = "armeabi-v7a"; GOARM = "7"; Compiler = "armv7a-linux-androideabi21-clang" }
)

foreach ($b in $builds) {
    Write-Host "`nBuilding for $($b.Suffix)..." -ForegroundColor Yellow
    $abiDir = Join-Path $jniLibsDir $b.Suffix
    $outFile = Join-Path $abiDir "libtun2socks.so"
    New-Item -ItemType Directory -Force -Path $abiDir | Out-Null

    $env:CGO_ENABLED = "1"
    $env:GOOS = "android"
    $env:GOARCH = $b.Arch
    $env:GOARM = $b.GOARM
    $env:CC = Join-Path $toolchainDir $b.Compiler

    Push-Location $tunDir
    go build -buildmode=c-shared -ldflags="-s -w" -trimpath -o $outFile .
    $exitCode = $LASTEXITCODE
    Pop-Location

    if ($exitCode -ne 0) {
        Write-Host "  ERROR: Failed to build for $($b.Suffix)" -ForegroundColor Red
    } else {
        $size = [math]::Round((Get-Item $outFile).Length / 1MB, 1)
        Write-Host "  OK: tun2socks_$($b.Suffix) ($size MB)" -ForegroundColor Green
    }
}

$env:CGO_ENABLED = ""
$env:GOOS = ""
$env:GOARCH = ""
$env:GOARM = ""
$env:CC = ""

Write-Host "`n=== Build complete ===" -ForegroundColor Green
Get-ChildItem $jniLibsDir -Recurse -Filter "libtun2socks.so" -ErrorAction SilentlyContinue | ForEach-Object {
    $size = [math]::Round($_.Length / 1MB, 1)
    Write-Host "  $($_.FullName) ($size MB)"
}
Write-Host "`nNext: cd mobile_app && flutter build apk --release" -ForegroundColor Cyan
