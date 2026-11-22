# Builds a Windows installer from the working tree with the `release-fast`
# Cargo profile and installs it silently over the per-user install.
#
#   npm run install:local          build + install
#   npm run install:local -- -Force  also closes a running Music Tag Cleaner
#   npm run install:local -- -BuildOnly  just builds the installer
#
# For trying a change in the real installed app before a release. It is not a
# release build: no LTO, and no updater signature (that needs the CI signing
# key), so never upload this installer. Publish through the `v*` tag instead.
param([switch]$Force, [switch]$BuildOnly)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$running = Get-Process music-tag-cleaner -ErrorAction SilentlyContinue
if ($running -and -not $BuildOnly) {
    if (-not $Force) {
        Write-Host "Music Tag Cleaner is running - close it first (or pass -Force)." -ForegroundColor Yellow
        exit 1
    }
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

# `--` hands `--profile` to cargo; the Tauri CLI reads it to find the bundle folder.
# The config goes in a file: Windows PowerShell 5.1 strips the inner quotes
# of a JSON string passed to a native program. No updater artifacts, because
# signing them needs the CI key.
$noUpdater = Join-Path $root "src-tauri\target\install-local.conf.json"
New-Item -ItemType Directory -Force (Split-Path $noUpdater) | Out-Null
Set-Content -Path $noUpdater -Value '{"bundle":{"createUpdaterArtifacts":false}}' -Encoding ascii
# The project's own CLI; `npx` cannot resolve it when npm itself launched us.
$tauri = Join-Path $root "node_modules\.bin\tauri.cmd"
& $tauri build --bundles nsis --config $noUpdater -- --profile release-fast
if ($LASTEXITCODE -ne 0) { throw "tauri build failed ($LASTEXITCODE)" }

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$setup = Join-Path $root "src-tauri\target\release-fast\bundle\nsis\MusicTagCleaner_${version}_x64-setup.exe"
if (-not (Test-Path $setup)) { throw "Installer not found: $setup" }
if ($BuildOnly) {
    Write-Host "Built $setup" -ForegroundColor Green
    exit 0
}

Write-Host "Installing $setup ..."
$p = Start-Process $setup -ArgumentList "/S" -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "Installer exited with $($p.ExitCode)" }

$exe = Join-Path $env:LOCALAPPDATA "MusicTagCleaner\music-tag-cleaner.exe"
$installed = (Get-Item $exe).VersionInfo.ProductVersion
Write-Host "Installed Music Tag Cleaner $installed ($((Get-Item $exe).LastWriteTime))" -ForegroundColor Green
