[CmdletBinding()]
param(
  [switch]$NoGui,
  [string]$InstallRoot,
  [string]$DshCommand,
  [string]$DshHome,
  [string]$DshProfile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (-not $InstallRoot) { $InstallRoot = $PSScriptRoot }
$script:LogSink = $null
. (Join-Path $PSScriptRoot "setup-common.ps1")
if (-not $NoGui) { Add-Type -AssemblyName System.Windows.Forms }

function Remove-DeskLatchPlugin {
  $root = Resolve-TargetPath $InstallRoot
  $receiptPath = Join-Path $root ".desklatch\windows\dsh-install.json"
  if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
    $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($receipt.version -ne 1) { throw "DeskLatch 安装记录版本无效。" }
    if (-not $DshCommand) { $DshCommand = $receipt.dshCommand }
    if (-not $DshHome) { $DshHome = $receipt.dshHome }
    if (-not $DshProfile) { $DshProfile = $receipt.dshProfile }
  } elseif (-not $DshProfile) {
    throw "此目录没有 DSH 安装记录。请从 DeskLatch 的实际安装目录运行卸载程序。"
  }
  $profile = Resolve-DshProfile $DshHome $DshProfile
  if (-not (Get-DshPluginDependency $profile)) {
    return "此 DSH 配置中没有 DeskLatch 插件。"
  }

  Assert-DshClosed
  $command = Resolve-DshExecutable $DshCommand
  if (-not $command) { throw "找不到安装时使用的 DeepSeek Harness 启动文件。" }
  $store = Get-DshStoreDirectory $profile
  if (-not $NoGui) {
    $confirm = [Windows.Forms.MessageBox]::Show(
      "从 DSH 的 $($profile.Name) 配置卸载 DeskLatch 插件？",
      "卸载 DeskLatch 插件",
      [Windows.Forms.MessageBoxButtons]::YesNo,
      [Windows.Forms.MessageBoxIcon]::Question,
      [Windows.Forms.MessageBoxDefaultButton]::Button2
    )
    if ($confirm -ne [Windows.Forms.DialogResult]::Yes) { return }
  }
  $environment = @{ DSH_HOME = $profile.Home }
  $tempDirectory = Join-Path $root ".desklatch\cache\tmp"
  if (Test-Path -LiteralPath $tempDirectory -PathType Container) {
    $environment.TEMP = $tempDirectory
    $environment.TMP = $tempDirectory
  }
  $arguments = @("plugin", "--profile", $profile.Name, "remove", "--store-dir", $store, "desklatch-dsh")
  Invoke-External -File $command -Arguments $arguments -WorkingDirectory $root -Environment $environment -Label "DSH DeskLatch plugin removal" | Out-Null
  if ((Get-DshPluginDependency $profile) -or (Test-Path -LiteralPath (Join-Path $profile.Directory "node_modules\desklatch-dsh"))) {
    throw "DSH 配置中仍留有 DeskLatch 插件。"
  }
  return "DeskLatch 插件已卸载。"
}

try {
  $message = Remove-DeskLatchPlugin
  if ($message) {
    if ($NoGui) {
      Write-Output $message
    } else {
      [void][Windows.Forms.MessageBox]::Show($message, "DeskLatch 插件卸载", [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Information)
    }
  }
  exit 0
} catch {
  if ($NoGui) { throw }
  [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, "DeskLatch 卸载失败", [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error)
  exit 1
}
