<#
  Builds the shell-extension DLL and the sparse package that puts
  "Open with Vatra Wave" in Windows 11's main right-click menu.

    .\build.ps1                 # build + sign (self-signed dev cert) -> out\
    .\build.ps1 -Install        # also copy the DLL into the install folder,
                                # trust the dev cert (one UAC prompt) and
                                # register the package against that folder

  A sparse package must be signed by a certificate the machine trusts, and its
  Publisher must equal the certificate subject. Without a real code-signing
  certificate this only works on machines that trust the dev cert, which is
  why it is not wired into the installer / release workflow yet.
#>
param(
  [switch]$Install,
  [string]$InstallDir = "$env:LOCALAPPDATA\Vatra Wave",
  [string]$Subject = "CN=MusicTagCleaner Dev"
)
$ErrorActionPreference = 'Stop'

$here    = $PSScriptRoot
$tauri   = Resolve-Path "$here\..\.."
$out     = Join-Path $here 'out'
$stage   = Join-Path $out 'stage'
$pkg     = Join-Path $out 'MusicTagCleaner.ShellExtension.msix'
$cerFile = Join-Path $out 'MusicTagCleaner-dev.cer'

$sdk = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $sdk) { throw 'Windows SDK (makeappx.exe / signtool.exe) not found.' }
$makeappx = $sdk.FullName
$signtool = Join-Path $sdk.DirectoryName 'signtool.exe'

# 1. DLL
Push-Location "$tauri\shell-ext"
cargo build --release
if ($LASTEXITCODE) { throw 'cargo build failed' }
Pop-Location
$dll = "$tauri\shell-ext\target\release\music_tag_cleaner_shell.dll"

# 2. Stage the manifest (version from tauri.conf.json, publisher = cert subject)
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$stage\Assets" | Out-Null
$version = (Get-Content "$tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
[xml]$m = Get-Content "$here\AppxManifest.xml" -Raw
$m.Package.Identity.Publisher = $Subject
$m.Package.Identity.Version = "$version.0"
$m.Save("$stage\AppxManifest.xml")
# Visual assets: the taskbar / Settings -> Apps pick Square44x44Logo by scale
# and targetsize, so a single oversized PNG renders blank. Resize the largest
# source icon to every size the manifest and shell look up.
Add-Type -AssemblyName System.Drawing
function New-Logo([string]$name, [int]$size) {
  $src = [System.Drawing.Image]::FromFile((Join-Path $tauri 'icons\icon.png'))
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.SmoothingMode = 'HighQuality'
  $g.PixelOffsetMode = 'HighQuality'
  $g.DrawImage($src, 0, 0, $size, $size)
  $bmp.Save("$stage\Assets\$name.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $src.Dispose()
}
New-Logo 'StoreLogo' 50
New-Logo 'Square150x150Logo' 150
New-Logo 'Square44x44Logo' 44
foreach ($t in 16, 24, 32, 48, 256) {
  New-Logo "Square44x44Logo.targetsize-$t" $t
  New-Logo "Square44x44Logo.targetsize-${t}_altform-unplated" $t
}

# 3. Pack
& $makeappx pack /o /nv /d $stage /p $pkg
if ($LASTEXITCODE) { throw 'makeappx failed' }

# 4. Sign with a self-signed code-signing cert (created once, kept in CurrentUser\My)
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $Subject } |
  Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type Custom -Subject $Subject `
    -KeyUsage DigitalSignature -FriendlyName 'MusicTagCleaner dev signing' `
    -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(5) `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
}
Export-Certificate -Cert $cert -FilePath $cerFile | Out-Null
& $signtool sign /fd SHA256 /sha1 $cert.Thumbprint /s My $pkg
if ($LASTEXITCODE) { throw 'signtool failed' }
Write-Host "Built $pkg"

if (-not $Install) { return }

# 5. Install: DLL next to the exe, trust the cert, register the package
if (-not (Test-Path "$InstallDir\music-tag-cleaner.exe")) {
  throw "Vatra Wave is not installed in $InstallDir"
}
Get-AppxPackage SergioAlexo.MusicTagCleaner.ShellExtension | Remove-AppxPackage
# Explorer's COM surrogate holds the old DLL open until it exits.
Get-Process dllhost -ErrorAction SilentlyContinue | Where-Object {
  $_.Modules.FileName -contains "$InstallDir\music_tag_cleaner_shell.dll"
} | Stop-Process -Force -ErrorAction SilentlyContinue
Copy-Item $dll $InstallDir -Force

$trusted = Get-ChildItem Cert:\LocalMachine\TrustedPeople |
  Where-Object Thumbprint -eq $cert.Thumbprint
if (-not $trusted) {
  Write-Host 'Trusting the dev certificate (admin prompt)...'
  $p = Start-Process certutil -Verb RunAs -Wait -PassThru `
    -ArgumentList '-addstore', 'TrustedPeople', "`"$cerFile`""
  if ($p.ExitCode) { throw 'Could not trust the certificate.' }
}

Add-AppxPackage -Path $pkg -ExternalLocation $InstallDir
Write-Host 'Registered. Right-click an audio file to see "Open with Vatra Wave".'
