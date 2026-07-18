# build_tun2socks.ps1
# Cross-compiles tun2socks for Android ARM and ARM64
# Requires: Go 1.21+ (https://go.dev/dl/)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tunDir = Join-Path $scriptDir "tun2socks"
$assetsDir = Join-Path $scriptDir "android\app\src\main\assets"

Write-Host "=== Building tun2socks for Android ===" -ForegroundColor Green

try {
    $goVersion = & go version 2>&1
    Write-Host "Found: $goVersion" -ForegroundColor Cyan
} catch {
    Write-Host "ERROR: Go is not installed. Download from https://go.dev/dl/" -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null

Write-Host "`nDownloading dependencies..." -ForegroundColor Yellow
Push-Location $tunDir
go mod tidy
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
Pop-Location

$builds = @(
    @{ Arch = "arm64";   Suffix = "arm64-v8a";     GOARM = "" },
    @{ Arch = "arm";     Suffix = "armeabi-v7a";   GOARM = "7" }
)

foreach ($b in $builds) {
    Write-Host "`nBuilding for $($b.Suffix)..." -ForegroundColor Yellow
    $outFile = Join-Path $assetsDir "tun2socks_$($b.Suffix)"

    $env:CGO_ENABLED = "0"
    $env:GOOS = "linux"
    $env:GOARCH = $b.Arch
    $env:GOARM = $b.GOARM

    Push-Location $tunDir
    go build -ldflags="-s -w" -trimpath -o $outFile .
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

Write-Host "`n=== Build complete ===" -ForegroundColor Green
Get-ChildItem (Join-Path $assetsDir "tun2socks_*") -ErrorAction SilentlyContinue | ForEach-Object {
    $size = [math]::Round($_.Length / 1MB, 1)
    Write-Host "  $($_.Name) ($size MB)"
}
Write-Host "`nNext: cd mobile_app && flutter build apk --release" -ForegroundColor Cyan
