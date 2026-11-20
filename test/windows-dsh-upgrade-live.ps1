param(
  [Parameter(Mandatory)][string]$LegacySetup,
  [Parameter(Mandatory)][string]$Setup,
  [Parameter(Mandatory)][string]$DshCommand,
  [Parameter(Mandatory)][string]$WorkDirectory,
  [string]$E2bEnvFile,
  [string]$OcrConfig
)

$ErrorActionPreference = "Stop"
$LegacySetup = (Resolve-Path -LiteralPath $LegacySetup).Path
$Setup = (Resolve-Path -LiteralPath $Setup).Path
$DshCommand = (Resolve-Path -LiteralPath $DshCommand).Path
$work = [IO.Path]::GetFullPath($WorkDirectory)
if (Test-Path -LiteralPath $work) { throw "Choose a new disposable test directory." }
New-Item -ItemType Directory -Path $work | Out-Null

$headlessHome = Join-Path $work "dsh"
$env:DSH_HOME = $headlessHome
$env:DESKLATCH_WINDOWS_GRANTS_FILE = Join-Path $work "test-grants.json"
$oldRoot = Join-Path $work "old-install"
$newRoot = Join-Path $work "new install"
$profile = Join-Path $headlessHome "profiles\headless"
$manifest = Join-Path $profile "node_modules\.modules.yaml"
$package = Join-Path $profile "node_modules\desklatch-dsh\package.json"
$shell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$dshArgs = @("-DshCommand", $DshCommand, "-DshHome", $headlessHome, "-DshProfile", "headless")
$optional = @()
if ($E2bEnvFile) { $optional += @("-E2bChoice", "Existing", "-E2bEnvFile", $E2bEnvFile) }
if ($OcrConfig) { $optional += @("-OcrChoice", "Existing", "-OcrConfig", $OcrConfig) }

function Invoke-Setup([string]$Installer, [string]$Root, [string[]]$Options = @()) {
  & $shell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Installer -NoGui -Route dsh -InstallRoot $Root @dshArgs @Options
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $package -PathType Leaf)) { throw "Fixture installation failed." }
}

function Assert-Removed {
  if (Test-Path -LiteralPath $package -PathType Leaf) { throw "Fixture plugin is still installed." }
}

function Read-BoundStore {
  (Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).storeDir
}

Invoke-Setup $LegacySetup $oldRoot
$boundStore = Read-BoundStore
if (-not $boundStore.StartsWith($oldRoot + "\")) { throw "The legacy installer did not bind the store under its install directory." }

& $shell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $LegacySetup -NoGui -RemoveDshPlugin -InstallRoot $oldRoot @dshArgs
if ($LASTEXITCODE -ne 0) { throw "Legacy removal failed." }
Assert-Removed
if ((Read-BoundStore) -ine $boundStore) { throw "The legacy profile must still retain the old store binding." }

$legacyBundle = Join-Path (Split-Path -Parent $LegacySetup) "desklatch-dsh-0.1.0-dev.3.tgz"
$conflictingStore = Join-Path $newRoot ".desklatch\cache\pnpm"
$legacyFailure = & $DshCommand plugin --profile headless add --ignore-scripts --store-dir $conflictingStore $legacyBundle 2>&1 | Out-String
if ($LASTEXITCODE -eq 0 -or $legacyFailure -notmatch 'ERR_PNPM_UNEXPECTED_STORE') { throw "The old add command did not reproduce the store error." }
"Reproduced the original pnpm store conflict."

Invoke-Setup $Setup $newRoot $optional
if ((Read-BoundStore) -ine $boundStore) { throw "The replacement installation changed the existing profile store." }
$uninstall = Join-Path $newRoot "DeskLatch-Uninstall.cmd"
if (-not (Test-Path -LiteralPath $uninstall -PathType Leaf)) { throw "Standalone uninstaller is missing." }
& $uninstall -NoGui
if ($LASTEXITCODE -ne 0) { throw "Standalone uninstall failed." }
Assert-Removed
& $uninstall -NoGui
if ($LASTEXITCODE -ne 0) { throw "Repeated standalone uninstall failed." }
Assert-Removed
Invoke-Setup $Setup $newRoot $optional
if ((Read-BoundStore) -ine $boundStore) { throw "Retry changed the existing profile store." }
"Verified a different installation root, standalone uninstall, and reinstall against the original profile store."
