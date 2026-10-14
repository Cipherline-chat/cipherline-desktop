<#
.SYNOPSIS
  Fail unless EVERY Windows PE file the build ships carries a valid Authenticode signature.

.DESCRIPTION
  Why this exists: electron-builder signs only *.exe by default. The 1.0.21-staging.157 installer (built with Azure
  signing ON) shipped Cipherline.exe / elevate.exe signed but left audio_capture.node, ffmpeg.dll, libEGL.dll,
  libGLESv2.dll, vk_swiftshader.dll, vulkan-1.dll and dxcompiler.dll unsigned. On Windows 11 with Smart App Control
  (or any code-integrity policy) the unsigned audio_capture.node is blocked at load ("we can't confirm who published
  audio_capture.node"), so screen-share audio capture silently fails. The fix is build.win.signExts in package.json;
  THIS script is the gate that proves it worked, on the packaged output, before anything is uploaded.

  Checked:
    * every *.exe in <ReleaseDir> (the NSIS installer and the portable exe), non-recursive
    * every *.exe, *.dll and *.node anywhere under <ReleaseDir>\win-unpacked (the exact tree the installer carries,
      including resources\app.asar.unpacked where native addons live)

  A file passes when Get-AuthenticodeSignature reports Status = Valid. Nothing is allowlisted: a Microsoft-signed
  redistributable that is Valid passes on its own merits. Files in -MustBePublisher (the app exe, the native addon
  and the installers) must additionally be signed by -Publisher, so a "Valid" signature from some other issuer on
  OUR files is not accepted.

  Also fails (never passes vacuously) if win-unpacked is missing, no PE files were found, or the native addon
  audio_capture.node was not among them.

  Compatible with Windows PowerShell 5.1 (the self-hosted runner's `shell: powershell`) and pwsh 7.

.PARAMETER ReleaseDir
  electron-builder's output directory (apps/desktop/release).

.PARAMETER Publisher
  Substring the signer certificate subject must contain for our own files. Default 'CN=Cipherline LLC'.
#>
param(
  [Parameter(Mandatory = $true)][string]$ReleaseDir,
  [string]$Publisher = 'CN=Cipherline LLC'
)

$ErrorActionPreference = 'Stop'

$unpacked = Join-Path $ReleaseDir 'win-unpacked'
if (-not (Test-Path -LiteralPath $unpacked -PathType Container)) {
  Write-Error "win-unpacked not found under $ReleaseDir - cannot verify the shipped files."
  exit 1
}

# Installers / portable exe (release root only; win-unpacked is walked separately below).
$installers = @(Get-ChildItem -LiteralPath $ReleaseDir -File -Filter *.exe)
if ($installers.Count -eq 0) {
  Write-Error "No installer .exe found in $ReleaseDir"
  exit 1
}

# Everything the installer will lay down on disk.
# Enumerate every file, then filter by extension. Windows PowerShell 5.1's -Include + -Recurse
# silently misses files in nested folders such as resources\app.asar.unpacked\build\Release
# (it reported audio_capture.node missing although electron-builder had just signed it).
$peExtensions = @('.exe', '.dll', '.node')
$unpackedFiles = @(Get-ChildItem -LiteralPath $unpacked -Recurse -File -Force | Where-Object { $peExtensions -contains $_.Extension.ToLowerInvariant() })
if ($unpackedFiles.Count -eq 0) {
  Write-Error "No PE files (*.exe, *.dll, *.node) found under $unpacked"
  exit 1
}
if (-not ($unpackedFiles | Where-Object { $_.Name -eq 'audio_capture.node' })) {
  Write-Error "audio_capture.node was not found under $unpacked - the enumeration is wrong or the native addon was not packaged."
  exit 1
}

# Files that must be signed by US, not merely by somebody.
$mustBePublisher = @('Cipherline.exe', 'audio_capture.node')

$all = @($installers) + @($unpackedFiles)
$bad = New-Object System.Collections.Generic.List[string]
foreach ($f in $all) {
  $sig = Get-AuthenticodeSignature -LiteralPath $f.FullName
  $subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '(none)' }
  $rel = $f.FullName.Substring((Resolve-Path -LiteralPath $ReleaseDir).Path.Length).TrimStart('\', '/')
  Write-Host ("{0,-9} {1}  [{2}]" -f $sig.Status, $rel, $subject)

  if ($sig.Status -ne 'Valid') {
    $bad.Add("$rel ($($sig.Status))")
    continue
  }
  $ours = ($installers -contains $f) -or ($mustBePublisher -contains $f.Name)
  if ($ours -and $subject -notlike "*$Publisher*") {
    $bad.Add("$rel (signed by '$subject', expected '$Publisher')")
  }
}

Write-Host ("Checked {0} PE files ({1} installer(s), {2} under win-unpacked)." -f $all.Count, $installers.Count, $unpackedFiles.Count)
if ($bad.Count -gt 0) {
  Write-Host ("::error::{0} shipped PE file(s) are unsigned or wrongly signed: {1}" -f $bad.Count, ($bad -join '; '))
  Write-Error ("Unsigned or wrongly signed: " + ($bad -join ', '))
  exit 1
}
Write-Host 'All shipped PE files carry a valid signature.'
exit 0
