# Makes the DSH x Thunderbird plugin persistent in the `web` profile, or rolls
# that change back.
#
#   powershell -File .\persistent-install.ps1            # apply (idempotent)
#   powershell -File .\persistent-install.ps1 -Rollback  # undo the profile change
#
# What "apply" changes in the profile (profiles/web/package.json):
#   1. dependencies: "dsh-thunderbird": "link:<this directory>"
#   2. dsh.profile.bundles: adds "dsh-thunderbird"
# plus a node_modules junction so the name resolves.
#
# It touches ONLY those two lines and the junction. It never edits
# cordis.patch.yml by hand: this package carries its own patch, which the loader
# applies because dsh.bundle.patch points at it (same mechanism as
# dsh-tududi-views / dsh-web-fetch-proxy).
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM.

param([switch]$Rollback)

$ErrorActionPreference = 'Stop'
$Repo = $PSScriptRoot
$Web = Join-Path $env:APPDATA 'dsh-desktop\harness\profiles\web'
$PkgJson = Join-Path $Web 'package.json'
$Junction = Join-Path $Web 'node_modules\dsh-thunderbird'
$DepLine = '    "dsh-thunderbird": "link:' + ($Repo -replace '\\', '/') + '",'
$BundleLine = '        "dsh-thunderbird",'

if (-not (Test-Path $PkgJson)) { throw "Profile package.json not found: $PkgJson" }

Write-Host "Repo      : $Repo"
Write-Host "Profile   : $Web"
Write-Host "Junction  : $Junction"
Write-Host ''

function Edit-Profile {
  param([string]$Mode)
  $lines = [System.Collections.Generic.List[string]](Get-Content $PkgJson)
  $before = $lines.Count
  $kept = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    $isDep = $line -match '^\s*"dsh-thunderbird"\s*:\s*"link:'
    $isBundle = $line -match '^\s*"dsh-thunderbird",\s*$'
    if ($Mode -eq 'remove') {
      if ($isDep -or $isBundle) { continue }
    } elseif ($Mode -eq 'add') {
      if ($isDep -or $isBundle) { continue }  # drop any stale copy, we re-insert below
    }
    $kept.Add($line)
  }
  if ($Mode -eq 'add') {
    # dependency: right before the dsh-tududi-views link: entry (or after the last dependency)
    $depAt = -1
    $bundleAt = -1
    for ($i = 0; $i -lt $kept.Count; $i++) {
      if ($depAt -lt 0 -and $kept[$i] -match '"dsh-tududi-views"\s*:\s*"link:') { $depAt = $i }
      if ($bundleAt -lt 0 -and $kept[$i] -match '^\s*"dsh-tududi-views",\s*$') { $bundleAt = $i }
    }
    if ($depAt -lt 0) { throw 'Could not find the dsh-tududi-views dependency line to anchor on.' }
    if ($bundleAt -lt 0) { throw 'Could not find the dsh-tududi-views bundle line to anchor on.' }
    $kept.Insert($bundleAt, $BundleLine)
    $kept.Insert($depAt, $DepLine)
  }
  Set-Content -Path $PkgJson -Value $kept -Encoding UTF8
  Write-Host ("profile package.json: {0} lines -> {1} lines ({2})" -f $before, $kept.Count, $Mode)
}

if ($Rollback) {
  Edit-Profile -Mode 'remove'
  if (Test-Path $Junction) {
    [System.IO.Directory]::Delete($Junction, $false)
    Write-Host "removed junction $Junction"
  } else {
    Write-Host 'junction already absent'
  }
  Write-Host ''
  Write-Host 'Rolled back. Restart DSH; the bridge will be gone until the package is re-added.'
  exit 0
}

if (Test-Path $Junction) {
  Write-Host 'junction already present'
} else {
  $out = cmd /c mklink /J "$Junction" "$Repo"
  Write-Host ($out -join ' ')
}

Edit-Profile -Mode 'add'

Write-Host ''
Write-Host 'Checking that node resolves the package from the profile...'
Push-Location $Web
& node --input-type=module -e "const m = await import('dsh-thunderbird'); console.log('resolved:', m.name, '| apply:', typeof m.apply, '| client export:', (await import('dsh-thunderbird/package.json', { with: { type: 'json' } }).catch(() => null)) ? 'declared' : 'see package.json');"
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) {
  Write-Host 'RESOLUTION FAILED - run with -Rollback before restarting DSH.' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host 'Applied. Restart DSH to load the plugin permanently.'
Write-Host 'If DSH does not start, run:  powershell -File .\persistent-install.ps1 -Rollback'
