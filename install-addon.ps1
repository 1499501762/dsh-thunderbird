# Installs the DSH Thunderbird Bridge MailExtension into a Thunderbird profile.
#
#   powershell -File .\install-addon.ps1                       # build + install + start
#   powershell -File .\install-addon.ps1 -SkipBuild            # install the existing xpi
#   powershell -File .\install-addon.ps1 -ProfilePath <dir>    # explicit profile
#
# This is a thin wrapper: the real work lives in dev/install-extension.py, which
# builds the .xpi with forward-slash entry names and installs it through
# Marionette + AddonManager.
#
# Do NOT "install" by copying an .xpi into <profile>\extensions\. Modern Gecko
# does not scan that directory and Thunderbird deletes the file on next start.
# That is the single most expensive mistake to make here; see README.md.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI when the file
# has no BOM, which corrupts non-ASCII source text.

param(
  [string]$ProfilePath,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$python = $null
foreach ($candidate in 'python', 'python3', 'py') {
  $found = Get-Command $candidate -ErrorAction SilentlyContinue
  if ($found) { $python = $found.Source; break }
}
if (-not $python) { throw 'Python 3 was not found on PATH; it is required to build and install the add-on.' }

$installer = Join-Path $PSScriptRoot 'dev\install-extension.py'
if (-not (Test-Path $installer)) { throw "Installer not found: $installer" }

$cliArgs = @($installer)
if ($ProfilePath) { $cliArgs += @('--profile', $ProfilePath) }
if ($SkipBuild) { $cliArgs += '--no-build' }

Write-Host "Python    : $python"
Write-Host "Installer : $installer"
Write-Host ''
& $python @cliArgs
exit $LASTEXITCODE
