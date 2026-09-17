# Installs the DSH Thunderbird Bridge MailExtension into a Thunderbird profile.
#
#   powershell -File .\install-addon.ps1                 # auto-detect the profile in use
#   powershell -File .\install-addon.ps1 -ProfilePath X  # explicit profile
#   powershell -File .\install-addon.ps1 -Uninstall
#
# Thunderbird must have been started at least once so its profile exists.
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI when the file
# has no BOM, which corrupts non-ASCII source text.

param(
  [string]$ProfilePath,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$AddonId = 'dsh-thunderbird-bridge@dsh.local'
$Source = Join-Path $PSScriptRoot 'thunderbird-addon'

function Get-NewestProfile {
  param([string[]]$Paths)
  $base = Join-Path $env:APPDATA 'Thunderbird'
  $best = $null
  $bestTime = [datetime]::MinValue
  foreach ($rel in $Paths) {
    $full = Join-Path $base $rel
    if (-not (Test-Path $full)) { continue }
    $stamp = Join-Path $full 'prefs.js'
    if (-not (Test-Path $stamp)) { $stamp = $full }
    $t = (Get-Item $stamp).LastWriteTime
    if ($t -gt $bestTime) { $bestTime = $t; $best = $full }
  }
  return $best
}

function Get-DefaultProfile {
  $dir = Join-Path $env:APPDATA 'Thunderbird'

  # installs.ini maps each installation to the profile it actually opened, which
  # is the one the user is running. profiles.ini's Default=1 can point at a
  # profile no installation uses.
  $installs = Join-Path $dir 'installs.ini'
  $fromInstalls = @()
  if (Test-Path $installs) {
    foreach ($line in Get-Content $installs) {
      if ($line -match '^\s*Default\s*=\s*(.+?)\s*$') { $fromInstalls += $Matches[1] }
    }
  }
  $picked = Get-NewestProfile -Paths $fromInstalls
  if ($picked) { return $picked }

  $ini = Join-Path $dir 'profiles.ini'
  if (-not (Test-Path $ini)) {
    throw "Cannot find $ini - start Thunderbird once so it creates its profile directory."
  }
  $fromIni = @()
  foreach ($line in Get-Content $ini) {
    if ($line -match '^\s*Path\s*=\s*(.+?)\s*$') { $fromIni += $Matches[1] }
  }
  $picked = Get-NewestProfile -Paths $fromIni
  if ($picked) { return $picked }
  throw 'No used Thunderbird profile directory was found.'
}

function Get-ThunderbirdExe {
  $paths = @(
    (Join-Path $env:ProgramFiles 'Mozilla Thunderbird\thunderbird.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Mozilla Thunderbird\thunderbird.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Mozilla Thunderbird\thunderbird.exe')
  )
  foreach ($p in $paths) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

if (-not $ProfilePath) { $ProfilePath = Get-DefaultProfile }
if (-not (Test-Path $ProfilePath)) { throw "Profile directory does not exist: $ProfilePath" }

$target = Join-Path $ProfilePath "extensions\$AddonId"
$userJs = Join-Path $ProfilePath 'user.js'
$exe = Get-ThunderbirdExe

Write-Host ("Thunderbird : " + $(if ($exe) { $exe } else { 'not detected (file placement only)' }))
Write-Host "Profile     : $ProfilePath"

if ($Uninstall) {
  if (Test-Path $target) {
    Remove-Item -Recurse -Force $target
    Write-Host "Removed $target"
  } else {
    Write-Host 'Add-on is not installed; nothing to remove.'
  }
  Write-Host 'Note: xpinstall.signatures.required=false is left in user.js; delete that line if you want it gone.'
  exit 0
}

if (-not (Test-Path $Source)) { throw "Add-on source directory not found: $Source" }

if (Test-Path $target) { Remove-Item -Recurse -Force $target }
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $Source '*') $target -Recurse -Force
Write-Host "Installed to $target"

# An unsigned extension only loads from a profile when signature enforcement is off.
$prefs = @(
  'user_pref("xpinstall.signatures.required", false);',
  'user_pref("extensions.autoDisableScopes", 0);'
)
$existing = if (Test-Path $userJs) { Get-Content $userJs -Raw } else { '' }
$added = @()
foreach ($pref in $prefs) {
  $key = ($pref -split '"')[1]
  if ($existing -notmatch [regex]::Escape($key)) { $added += $pref }
}
if ($added.Count -gt 0) {
  Add-Content -Path $userJs -Value '// added by dsh-thunderbird install-addon.ps1'
  Add-Content -Path $userJs -Value $added
  Write-Host "Wrote $($added.Count) preference(s) to $userJs"
} else {
  Write-Host 'user.js already carries the required preferences'
}

Write-Host ''
Write-Host 'Next:'
Write-Host '  1. Quit Thunderbird completely and start it again.'
Write-Host '  2. Settings > Add-ons and Themes > Extensions: confirm "DSH Thunderbird Bridge" is enabled.'
Write-Host '  3. Open its Options and confirm the DSH address (default http://127.0.0.1:43129).'
Write-Host '  4. Verify: curl http://127.0.0.1:43129/api/thunderbird/status  should report "online": true'
Write-Host ''
Write-Host 'Prefer not to touch preferences? Load it temporarily instead:'
Write-Host '  Settings > Add-ons > Debug Add-ons > Load Temporary Add-on'
Write-Host "  $Source\manifest.json   (gone after restart)"
