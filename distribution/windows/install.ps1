[CmdletBinding()]
param(
  [string]$InstallRoot,
  [switch]$Plan,
  [switch]$NoGui,
  [ValidateSet("dsh", "mcp")][string]$Route,
  [ValidateSet("Skip", "Install", "Existing")][string]$OcrChoice = "Skip",
  [ValidateSet("Skip", "Install", "Existing")][string]$E2bChoice = "Skip",
  [string]$OcrConfig,
  [string]$PythonExecutable,
  [string]$E2bEnvFile,
  [string]$DshCommand,
  [string]$DshHome,
  [string]$DshProfile = "desktop"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
$script:DistributionRoot = Split-Path -Parent $PSScriptRoot
$script:LogSink = $null
$script:LogBox = $null
$script:ProgressBar = $null

. (Join-Path $PSScriptRoot "node-runtime.ps1")
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot "python-runtime.ps1") -PathType Leaf) {
  . (Join-Path $PSScriptRoot "python-runtime.ps1")
}

function Get-DefaultInstallRoot {
  if ($env:DESKLATCH_INSTALL_ROOT -and $env:DESKLATCH_INSTALL_ROOT.Trim().Length -gt 0) {
    return [IO.Path]::GetFullPath($env:DESKLATCH_INSTALL_ROOT)
  }
  return (Join-Path $script:DistributionRoot "installed")
}

function Resolve-TargetPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw "An install root is required." }
  if ($Path.IndexOf([char]0) -ge 0) { throw "The install root contains an invalid character." }
  return [IO.Path]::GetFullPath($Path)
}

function Redact-Output([string]$Text) {
  if ($null -eq $Text) { return "" }
  return [regex]::Replace($Text, '(?im)(E2B_API_KEY|OPENAI_API_KEY|DEEPSEEK_API_KEY|[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[=:]\s*[^\s;]+', '$1=<redacted>')
}

function Write-InstallLog([string]$Message) {
  $safe = Redact-Output $Message
  if ($script:LogSink) { & $script:LogSink $safe } else { Write-Host $safe }
}

function Get-Artifact([bool]$Dsh) {
  $files = @()
  foreach ($directory in @($script:DistributionRoot, $PSScriptRoot)) {
    if (Test-Path -LiteralPath $directory -PathType Container) {
      $files += @(Get-ChildItem -LiteralPath $directory -Filter "*.tgz" -File -ErrorAction SilentlyContinue)
    }
  }
  $files = @($files | Sort-Object FullName -Unique)
  if ($Dsh) { return $files | Where-Object { $_.Name -like "desklatch-dsh-*.tgz" } | Sort-Object Name | Select-Object -Last 1 }
  return $files | Where-Object { $_.Name -like "desklatch-*.tgz" -and $_.Name -notlike "desklatch-dsh-*.tgz" } | Sort-Object Name | Select-Object -Last 1
}

function Resolve-DshExecutable([string]$Requested) {
  if ($Requested -and (Test-Path -LiteralPath $Requested -PathType Leaf)) { return [IO.Path]::GetFullPath($Requested) }
  if ($env:DESKLATCH_DSH_CMD -and (Test-Path -LiteralPath $env:DESKLATCH_DSH_CMD -PathType Leaf)) { return [IO.Path]::GetFullPath($env:DESKLATCH_DSH_CMD) }
  $command = Get-Command dsh.cmd -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }) {
    $candidate = Join-Path $base "DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return $null
}

function Assert-DshClosed {
  $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in @("DeepSeek Harness", "DeepSeekHarness", "DeepSeekHarnessDesktop") })
  if ($running.Count -gt 0) { throw "Quit DSH Desktop completely before installing the native bundle, then run the installer again." }
}

function Quote-WindowsArgument([string]$Value) {
  if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Invoke-External {
  param([Parameter(Mandatory = $true)][string]$File, [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory, [hashtable]$Environment = @{}, [string]$Label = "command")
  $actualFile = $File
  $actualArguments = @($Arguments)
  $commandLine = $null
  if ([IO.Path]::GetExtension($File).ToLowerInvariant() -eq ".cmd") {
    $commandText = "call " + (Quote-WindowsArgument $File) + " " + (($Arguments | ForEach-Object { Quote-WindowsArgument ([string]$_) }) -join " ")
    $actualFile = $env:ComSpec
    $commandLine = "/d /s /c " + $commandText
  }
  Write-InstallLog ("Running " + $Label + ": " + $File + " " + (($Arguments | ForEach-Object { Quote-WindowsArgument ([string]$_) }) -join " "))
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $actualFile
  $start.Arguments = if ($commandLine) { $commandLine } else { ($actualArguments | ForEach-Object { Quote-WindowsArgument ([string]$_) }) -join " " }
  $start.WorkingDirectory = $WorkingDirectory
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
  $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
  foreach ($key in $Environment.Keys) { $start.EnvironmentVariables[$key] = [string]$Environment[$key] }
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  if (-not $process.Start()) { throw ("Could not start " + $Label + ".") }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $stdout = $stdoutTask.Result
  $stderr = $stderrTask.Result
  if ($stdout) { Write-InstallLog $stdout.TrimEnd() }
  if ($stderr) { Write-InstallLog $stderr.TrimEnd() }
  if ($process.ExitCode -ne 0) { throw ("The " + $Label + " failed with exit code " + $process.ExitCode + ".") }
  return $stdout
}

function New-ScopedEnvironment([string]$Root, [string]$DshHome) {
  $cache = Join-Path $Root ".desklatch\cache"
  New-Item -ItemType Directory -Path $cache, (Join-Path $cache "npm"), (Join-Path $cache "pnpm"), (Join-Path $cache "pip"), (Join-Path $cache "tmp") -Force | Out-Null
  $environment = @{
    TEMP = (Join-Path $cache "tmp")
    TMP = (Join-Path $cache "tmp")
    npm_config_cache = (Join-Path $cache "npm")
    npm_config_fund = "false"
    npm_config_audit = "false"
    npm_config_update_notifier = "false"
    PNPM_HOME = (Join-Path $cache "pnpm-home")
    PIP_CACHE_DIR = (Join-Path $cache "pip")
  }
  if ($DshHome) { $environment.DSH_HOME = $DshHome }
  return $environment
}

function Write-SecretEnvFile([string]$Path, [string]$ApiKey) {
  if ([string]::IsNullOrWhiteSpace($ApiKey)) { return $null }
  if ($ApiKey -match '[\r\n]') { throw "The E2B API key must be a single line." }
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $temporary = $Path + "." + $PID + ".tmp"
  if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force }
  New-Item -ItemType File -Path $temporary -Force | Out-Null
  try {
    $acl = Get-Acl -LiteralPath $temporary
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $fileRule = New-Object Security.AccessControl.FileSystemAccessRule($sid, "Read,Write", "Allow")
    [void]$acl.AddAccessRule($fileRule)
    Set-Acl -LiteralPath $temporary -AclObject $acl
    [IO.File]::WriteAllText($temporary, ("E2B_API_KEY=" + $ApiKey.Trim() + "`r`n"), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
    return $Path
  } catch {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    throw "Could not protect the E2B key file under the selected root; no key was saved."
  }
}

function Invoke-SetupFlow {
  param([Parameter(Mandatory = $true)][hashtable]$Options)
  $root = Resolve-TargetPath $Options.InstallRoot
  if ($Options.E2bChoice -eq "Existing" -and [string]::IsNullOrWhiteSpace($Options.E2bEnvFile)) { throw "Choose an existing E2B .env file." }
  if ($Options.OcrChoice -eq "Existing" -and [string]::IsNullOrWhiteSpace($Options.OcrConfig)) { throw "Choose the existing OCR JSON file." }
  $core = Get-Artifact $false
  if (-not $core) { throw "No desklatch-<version>.tgz was found beside the Windows installer. Run the distribution pack step first." }
  $dsh = $null
  $dshCommand = $null
  if ($Options.Route -eq "dsh") {
    $dsh = Get-Artifact $true
    if (-not $dsh) { throw "No desklatch-dsh-<version>.tgz was found beside the Windows installer." }
    $dshCommand = Resolve-DshExecutable $Options.DshCommand
    if (-not $dshCommand) { throw "未找到 DeepSeek Harness。请先安装并启动一次，或在向导中选择 dsh.cmd。" }
    if ([string]::IsNullOrWhiteSpace($Options.DshProfile)) { throw "请选择 DSH 配置。" }
    Assert-DshClosed
  }
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  $processCache = Join-Path $root ".desklatch\cache\tmp"
  New-Item -ItemType Directory -Path $processCache -Force | Out-Null
  $env:TEMP = $processCache
  $env:TMP = $processCache
  $manifestPath = Join-Path $root "package.json"
  if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw "The selected install root contains an invalid package.json. Choose a new empty folder." }
    $hasDeskDependency = $false
    if ($manifest.PSObject.Properties.Name -contains "dependencies" -and $manifest.dependencies) {
      $hasDeskDependency = $manifest.dependencies.PSObject.Properties.Name -contains "desklatch"
    }
    if ($manifest.name -and $manifest.name -ne "desklatch-local-install" -and -not $hasDeskDependency) {
      throw "The selected install root already belongs to another project. Choose a new folder so the installer does not alter it."
    }
  } else {
    $manifestText = "{`r`n  `"name`": `"desklatch-local-install`",`r`n  `"private`": true,`r`n  `"type`": `"module`"`r`n}`r`n"
    [IO.File]::WriteAllText($manifestPath, $manifestText, (New-Object Text.UTF8Encoding($false)))
  }
  $status = { param($message) Write-InstallLog $message }
  $nodePair = Resolve-DeskLatchNode -InstallRoot $root -Status $status
  $ocrPython = $Options.PythonExecutable
  if (($Options.OcrChoice -eq "Install") -and [string]::IsNullOrWhiteSpace($ocrPython) -and (Get-Command Resolve-DeskLatchPython -ErrorAction SilentlyContinue)) {
    $ocrPython = Resolve-DeskLatchPython -InstallRoot $root -Status $status
  }
  $dshHome = if ($Options.DshHome) { Resolve-TargetPath $Options.DshHome } elseif ($env:DSH_HOME) { $env:DSH_HOME } else { $null }
  $environment = New-ScopedEnvironment $root $dshHome
  $npmArguments = @("install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", $core.FullName)
  Invoke-External -File $nodePair.Node -Arguments (@($nodePair.Npm) + $npmArguments) -WorkingDirectory $root -Environment $environment -Label "npm package installation" | Out-Null

  $setupArguments = @("exec", "--", "desklatch-setup", $Options.Route, "--windows")
  if ($Options.Route -eq "mcp") { $setupArguments += @("--install", "--output", (Join-Path $root "desklatch.mcp.json")) }
  else { $setupArguments += @("--bundle", $dsh.FullName) }
  if ($Options.E2bChoice -eq "Install") { $setupArguments += "--install-e2b" }
  if ($Options.E2bChoice -eq "Existing") {
    $setupArguments += "--e2b"
    if ($Options.E2bEnvFile) { $setupArguments += @("--env-file", $Options.E2bEnvFile) }
  }
  if ($Options.E2bChoice -eq "Install" -and $Options.E2bEnvFile) { $setupArguments += @("--env-file", $Options.E2bEnvFile) }
  if ($Options.OcrChoice -eq "Install") {
    $setupArguments += "--install-ocr"
    if ($ocrPython) { $setupArguments += @("--python", $ocrPython) }
  }
  if ($Options.OcrChoice -eq "Existing") {
    if (-not $Options.OcrConfig) { throw "Choose the existing OCR JSON file." }
    $setupArguments += @("--ocr", $Options.OcrConfig)
  }
  Invoke-External -File $nodePair.Node -Arguments (@($nodePair.Npm) + $setupArguments) -WorkingDirectory $root -Environment $environment -Label "npm exec -- desklatch-setup" | Out-Null

  if ($Options.Route -eq "dsh") {
    Assert-DshClosed
    Write-InstallLog "DSH Desktop must be fully closed before the official profile command runs."
    $storeDirectory = Join-Path $root ".desklatch\cache\pnpm"
    # The bundle uses checked platform binaries and does not need dependency build scripts.
    Invoke-External -File $dshCommand -Arguments @("plugin", "--profile", $Options.DshProfile, "add", "--ignore-scripts", "--store-dir", $storeDirectory, $dsh.FullName) -WorkingDirectory $root -Environment $environment -Label "official DSH bundle installation" | Out-Null
    $registerArguments = @("exec", "--", "desklatch-setup", "dsh", "--windows", "--register-windows-location", "--bundle", $dsh.FullName)
    Invoke-External -File $nodePair.Node -Arguments (@($nodePair.Npm) + $registerArguments) -WorkingDirectory $root -Environment $environment -Label "Windows authorization registration" | Out-Null
    Write-InstallLog ("DSH bundle installed for profile " + $Options.DshProfile + ". Restart DSH to load the native tools.")
  } else {
    Write-InstallLog ("MCP configuration written to " + (Join-Path $root "desklatch.mcp.json") + ". Add this server entry to your MCP client; no DSH profile was changed.")
  }
  return $root
}

function Show-Plan {
  $root = if ($InstallRoot) { Resolve-TargetPath $InstallRoot } else { Get-DefaultInstallRoot }
  Write-Output "DeskLatch Windows installer plan"
  Write-Output ("Install root: " + $root)
  Write-Output ("Default route: " + $(if ($Route) { $Route } else { "mcp or dsh in the GUI" }))
  Write-Output ("DSH_HOME: " + $(if ($DshHome) { (Resolve-TargetPath $DshHome) } elseif ($env:DSH_HOME) { $env:DSH_HOME } else { "existing DSH default" }))
  Write-Output "Optional E2B: Skip by default; choose Install or Existing in the GUI."
  Write-Output "Optional OCR: Skip by default; choose Install or Existing in the GUI."
  Write-Output "Project, npm/pip/pnpm cache, and temp writes are scoped to the install root. DSH uses its existing DSH_HOME unless -DshHome is supplied."
  Write-Output "No command was run and no existing DSH profile was changed."
  $core = Get-Artifact $false
  $dsh = Get-Artifact $true
  Write-Output ("Core artifact: " + $(if ($core) { $core.FullName } else { "not found" }))
  Write-Output ("DSH artifact: " + $(if ($dsh) { $dsh.FullName } else { "not found" }))
}

function Add-ChoiceItems($Combo) {
  [void]$Combo.Items.Add("跳过")
  [void]$Combo.Items.Add("安装")
  [void]$Combo.Items.Add("使用已有配置")
  $Combo.SelectedIndex = 0
}

function Get-ChoiceCode([string]$Display) {
  if ($Display -eq "安装") { return "Install" }
  if ($Display -eq "使用已有配置") { return "Existing" }
  return "Skip"
}

function Set-ChoiceSelection($Combo, [string]$Code) {
  if ($Code -eq "Install") { $Combo.SelectedIndex = 1 }
  elseif ($Code -eq "Existing") { $Combo.SelectedIndex = 2 }
  else { $Combo.SelectedIndex = 0 }
}

function Start-Gui {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [Windows.Forms.Application]::EnableVisualStyles()
  $form = New-Object Windows.Forms.Form
  $form.Text = "DeskLatch 安装向导"
  $form.StartPosition = "CenterScreen"
  $form.Size = New-Object Drawing.Size(760, 650)
  $form.MinimumSize = New-Object Drawing.Size(760, 650)

  function Add-Label([string]$Text, [int]$X, [int]$Y) {
    $label = New-Object Windows.Forms.Label
    $label.Text = $Text
    $label.Location = New-Object Drawing.Point($X, $Y)
    $label.AutoSize = $true
    $form.Controls.Add($label)
    return $label
  }
  $rootLabel = Add-Label "安装目录" 20 20
  $rootBox = New-Object Windows.Forms.TextBox
  $rootBox.Location = New-Object Drawing.Point(120, 17); $rootBox.Size = New-Object Drawing.Size(510, 24)
  $rootBox.Text = if ($InstallRoot) { $InstallRoot } else { Get-DefaultInstallRoot }
  $form.Controls.Add($rootBox)
  $rootBrowse = New-Object Windows.Forms.Button
  $rootBrowse.Text = "浏览..."; $rootBrowse.Location = New-Object Drawing.Point(640, 16)
  $rootBrowse.Add_Click({ $dialog = New-Object Windows.Forms.FolderBrowserDialog; $dialog.SelectedPath = $rootBox.Text; if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { $rootBox.Text = $dialog.SelectedPath } })
  $form.Controls.Add($rootBrowse)

  $routeGroup = New-Object Windows.Forms.GroupBox
  $routeGroup.Text = "连接方式"; $routeGroup.Location = New-Object Drawing.Point(20, 55); $routeGroup.Size = New-Object Drawing.Size(710, 65)
  $form.Controls.Add($routeGroup)
  $dshRadio = New-Object Windows.Forms.RadioButton
  $dshRadio.Text = "DeepSeek Harness 插件（含审批卡）"; $dshRadio.Location = New-Object Drawing.Point(15, 25); $dshRadio.AutoSize = $true
  $mcpRadio = New-Object Windows.Forms.RadioButton
  $mcpRadio.Text = "MCP（适合其他客户端）"; $mcpRadio.Location = New-Object Drawing.Point(390, 25); $mcpRadio.AutoSize = $true
  $detectedDsh = Resolve-DshExecutable $DshCommand
  if ($Route -eq "dsh" -or (-not $Route -and $detectedDsh)) { $dshRadio.Checked = $true } else { $mcpRadio.Checked = $true }
  $routeGroup.Controls.Add($dshRadio); $routeGroup.Controls.Add($mcpRadio)

  $dshReadyLabel = Add-Label "已检测到 DeepSeek Harness。请从系统托盘退出后安装。" 20 135
  $dshPathLabel = Add-Label "DSH 启动文件" 20 135
  $dshPathBox = New-Object Windows.Forms.TextBox
  $dshPathBox.Text = $detectedDsh; $dshPathBox.Location = New-Object Drawing.Point(120, 132); $dshPathBox.Size = New-Object Drawing.Size(510, 24); $form.Controls.Add($dshPathBox)
  $dshPathBrowse = New-Object Windows.Forms.Button
  $dshPathBrowse.Text = "浏览..."; $dshPathBrowse.Location = New-Object Drawing.Point(640, 131)
  $dshPathBrowse.Add_Click({ $dialog = New-Object Windows.Forms.OpenFileDialog; $dialog.Filter = "dsh.cmd|dsh.cmd|Command files|*.cmd"; if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { $dshPathBox.Text = $dialog.FileName } })
  $form.Controls.Add($dshPathBrowse)

  Add-Label "E2B 云电脑" 20 175 | Out-Null
  $e2bCombo = New-Object Windows.Forms.ComboBox
  $e2bCombo.DropDownStyle = [Windows.Forms.ComboBoxStyle]::DropDownList; $e2bCombo.Location = New-Object Drawing.Point(120, 172); $e2bCombo.Size = New-Object Drawing.Size(180, 24); Add-ChoiceItems $e2bCombo; Set-ChoiceSelection $e2bCombo $E2bChoice; $form.Controls.Add($e2bCombo)
  $e2bKeyLabel = Add-Label "密钥（可稍后）" 320 175
  $e2bKeyBox = New-Object Windows.Forms.TextBox
  $e2bKeyBox.UseSystemPasswordChar = $true; $e2bKeyBox.Location = New-Object Drawing.Point(420, 172); $e2bKeyBox.Size = New-Object Drawing.Size(210, 24); $form.Controls.Add($e2bKeyBox)
  $e2bDashboard = New-Object Windows.Forms.Button
  $e2bDashboard.Text = "获取密钥"; $e2bDashboard.Location = New-Object Drawing.Point(640, 171)
  $e2bDashboard.Add_Click({ Start-Process 'https://e2b.dev/dashboard' })
  $form.Controls.Add($e2bDashboard)
  $e2bFileBox = New-Object Windows.Forms.TextBox
  $e2bFileBox.Location = New-Object Drawing.Point(120, 202); $e2bFileBox.Size = New-Object Drawing.Size(510, 24); $e2bFileBox.Text = $E2bEnvFile; $form.Controls.Add($e2bFileBox)
  $e2bFileBrowse = New-Object Windows.Forms.Button
  $e2bFileBrowse.Text = "选择已有 .env..."; $e2bFileBrowse.Location = New-Object Drawing.Point(640, 201)
  $e2bFileBrowse.Add_Click({ $dialog = New-Object Windows.Forms.OpenFileDialog; $dialog.Filter = "Environment files|*.env|All files|*.*"; if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { $e2bFileBox.Text = $dialog.FileName } })
  $form.Controls.Add($e2bFileBrowse)

  Add-Label "本地文字识别" 20 242 | Out-Null
  $ocrCombo = New-Object Windows.Forms.ComboBox
  $ocrCombo.DropDownStyle = [Windows.Forms.ComboBoxStyle]::DropDownList; $ocrCombo.Location = New-Object Drawing.Point(120, 239); $ocrCombo.Size = New-Object Drawing.Size(180, 24); Add-ChoiceItems $ocrCombo; Set-ChoiceSelection $ocrCombo $OcrChoice; $form.Controls.Add($ocrCombo)
  $ocrInstallLabel = Add-Label "自动准备 Python 和识别模型。" 320 242
  $ocrFileBox = New-Object Windows.Forms.TextBox
  $ocrFileBox.Location = New-Object Drawing.Point(120, 269); $ocrFileBox.Size = New-Object Drawing.Size(510, 24); $ocrFileBox.Text = $OcrConfig; $form.Controls.Add($ocrFileBox)
  $ocrFileBrowse = New-Object Windows.Forms.Button
  $ocrFileBrowse.Text = "选择已有 OCR JSON..."; $ocrFileBrowse.Location = New-Object Drawing.Point(640, 268)
  $ocrFileBrowse.Add_Click({ $dialog = New-Object Windows.Forms.OpenFileDialog; $dialog.Filter = "OCR JSON|*.json|All files|*.*"; if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { $ocrFileBox.Text = $dialog.FileName } })
  $form.Controls.Add($ocrFileBrowse)

  Add-Label "可选组件默认跳过。安装文件和缓存放在所选目录。" 20 310 | Out-Null
  $script:LogBox = New-Object Windows.Forms.TextBox
  $script:LogBox.Multiline = $true; $script:LogBox.ReadOnly = $true; $script:LogBox.ScrollBars = [Windows.Forms.ScrollBars]::Vertical; $script:LogBox.Location = New-Object Drawing.Point(20, 340); $script:LogBox.Size = New-Object Drawing.Size(710, 205); $form.Controls.Add($script:LogBox)
  $script:ProgressBar = New-Object Windows.Forms.ProgressBar
  $script:ProgressBar.Style = [Windows.Forms.ProgressBarStyle]::Marquee; $script:ProgressBar.MarqueeAnimationSpeed = 30; $script:ProgressBar.Location = New-Object Drawing.Point(20, 555); $script:ProgressBar.Size = New-Object Drawing.Size(500, 22); $script:ProgressBar.Visible = $false; $form.Controls.Add($script:ProgressBar)
  $startButton = New-Object Windows.Forms.Button
  $startButton.Text = "开始安装"; $startButton.Location = New-Object Drawing.Point(540, 552); $startButton.Size = New-Object Drawing.Size(90, 30); $form.Controls.Add($startButton)
  $closeButton = New-Object Windows.Forms.Button
  $closeButton.Text = "关闭"; $closeButton.Location = New-Object Drawing.Point(640, 552); $closeButton.Size = New-Object Drawing.Size(90, 30); $closeButton.Add_Click({ $form.Close() }); $form.Controls.Add($closeButton)
  $authorizeButton = New-Object Windows.Forms.Button
  $authorizeButton.Text = "打开授权页"; $authorizeButton.Location = New-Object Drawing.Point(390, 552); $authorizeButton.Size = New-Object Drawing.Size(140, 30); $authorizeButton.Enabled = $false
  $authorizeButton.Add_Click({
    $authorizePath = Join-Path $state.InstalledRoot "DeskLatch-Authorize.cmd"
    if (Test-Path -LiteralPath $authorizePath -PathType Leaf) { Start-Process -FilePath $authorizePath -WorkingDirectory $state.InstalledRoot -WindowStyle Hidden }
    else { [Windows.Forms.MessageBox]::Show($form, "授权启动文件尚未生成。请先完成安装。", "DeskLatch 安装", [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Information) | Out-Null }
  })
  $form.Controls.Add($authorizeButton)
  $copyButton = New-Object Windows.Forms.Button
  $copyButton.Text = "复制 MCP 配置"; $copyButton.Location = New-Object Drawing.Point(20, 552); $copyButton.Size = New-Object Drawing.Size(135, 30); $copyButton.Visible = $false
  $form.Controls.Add($copyButton)

  $updateState = {
    $isDsh = $dshRadio.Checked
    foreach ($control in @($dshPathLabel, $dshPathBox, $dshPathBrowse)) { $control.Visible = $isDsh -and -not $detectedDsh }
    $dshReadyLabel.Visible = $isDsh -and [bool]$detectedDsh
    $e2bChoice = Get-ChoiceCode ([string]$e2bCombo.SelectedItem); $ocrChoice = Get-ChoiceCode ([string]$ocrCombo.SelectedItem)
    foreach ($control in @($e2bKeyLabel, $e2bKeyBox, $e2bDashboard)) { $control.Visible = ($e2bChoice -eq "Install") }
    foreach ($control in @($e2bFileBox, $e2bFileBrowse)) { $control.Visible = ($e2bChoice -eq "Existing") }
    foreach ($control in @($ocrFileBox, $ocrFileBrowse)) { $control.Visible = ($ocrChoice -eq "Existing") }
    $ocrInstallLabel.Visible = ($ocrChoice -eq "Install")
  }
  $dshRadio.Add_CheckedChanged($updateState); $mcpRadio.Add_CheckedChanged($updateState); $e2bCombo.Add_SelectedIndexChanged($updateState); $ocrCombo.Add_SelectedIndexChanged($updateState); & $updateState

  $script:LogSink = { param([string]$Message) if ($script:LogBox -and -not $script:LogBox.IsDisposed) { $script:LogBox.AppendText($Message + [Environment]::NewLine) } }
  $state = @{ Process = $null; OutputTask = $null; ErrorTask = $null; Route = $null; McpConfig = $null; InstalledRoot = $null }
  $copyButton.Add_Click({
    try { [Windows.Forms.Clipboard]::SetText([IO.File]::ReadAllText($state.McpConfig, [Text.Encoding]::UTF8)); $copyButton.Text = "配置已复制" }
    catch { [Windows.Forms.MessageBox]::Show($form, "复制失败。可在安装目录打开 desklatch.mcp.json。", "DeskLatch 安装") | Out-Null }
  })
  $timer = New-Object Windows.Forms.Timer
  $timer.Interval = 250
  $timer.Add_Tick({
    if (-not $state.Process) { return }
    if ($state.Process.HasExited) {
      $timer.Stop()
      $stdout = ""
      try {
        $stdout = $state.OutputTask.Result
        $stderr = $state.ErrorTask.Result
        if ($stdout) { $script:LogBox.AppendText((Redact-Output $stdout)) }
        if ($stderr) { $script:LogBox.AppendText((Redact-Output $stderr)) }
      } catch { $script:LogBox.AppendText("无法读取安装进程输出。`r`n") }
      $script:ProgressBar.Visible = $false
      $startButton.Enabled = $true
      $closeButton.Enabled = $true
      if ($state.Process.ExitCode -eq 0) {
        $authorizeButton.Enabled = Test-Path -LiteralPath (Join-Path $state.InstalledRoot "DeskLatch-Authorize.cmd") -PathType Leaf
        $nextStep = if ($state.Route -eq "dsh") { "打开授权页选择应用，再重新打开 DeepSeek Harness。关键动作会在 DSH 会话中请求确认。" } else { "打开授权页选择应用，再复制 MCP 配置到你的客户端。关键动作会弹出 Windows 审批窗口。" }
        if ($stdout -match 'E2B_API_KEY_MISSING') { $nextStep += " E2B 已安装，之后可重开向导填写密钥。" }
        $copyButton.Visible = $state.Route -eq "mcp"
        [Windows.Forms.MessageBox]::Show($form, $nextStep, "DeskLatch 安装完成", [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Information) | Out-Null
      } else {
        [Windows.Forms.MessageBox]::Show($form, "安装失败。请查看日志并修正前置条件后重试。", "DeskLatch 安装失败", [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error) | Out-Null
      }
      $state.Process.Dispose()
      $state.Process = $null
    }
  })
  $form.Add_FormClosing({ param($sender, $eventArgs) if ($state.Process) { $eventArgs.Cancel = $true; [Windows.Forms.MessageBox]::Show($form, "安装仍在进行，请等待完成后再关闭窗口。", "DeskLatch 安装", [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Information) | Out-Null } })
  $startButton.Add_Click({
    if ($state.Process) { return }
    try {
      $options = @{ InstallRoot = $rootBox.Text; Route = if ($dshRadio.Checked) { "dsh" } else { "mcp" }; E2bChoice = Get-ChoiceCode ([string]$e2bCombo.SelectedItem); OcrChoice = Get-ChoiceCode ([string]$ocrCombo.SelectedItem); E2bEnvFile = $e2bFileBox.Text; OcrConfig = $ocrFileBox.Text; PythonExecutable = $PythonExecutable; DshCommand = $dshPathBox.Text; DshHome = $DshHome; DshProfile = $DshProfile }
      if ($options.Route -eq "dsh" -and [string]::IsNullOrWhiteSpace($options.DshProfile)) { throw "Enter a DSH profile name." }
      if ($options.E2bChoice -eq "Existing" -and [string]::IsNullOrWhiteSpace($options.E2bEnvFile)) { throw "Choose an existing E2B .env file." }
      if ($options.OcrChoice -eq "Existing" -and [string]::IsNullOrWhiteSpace($options.OcrConfig)) { throw "Choose an existing OCR JSON file." }
      if ($options.E2bChoice -eq "Install" -and $e2bKeyBox.Text) { $options.E2bEnvFile = Write-SecretEnvFile (Join-Path (Resolve-TargetPath $options.InstallRoot) ".desklatch\e2b.env") $e2bKeyBox.Text; $e2bKeyBox.Clear() }
      New-Item -ItemType Directory -Path (Resolve-TargetPath $options.InstallRoot) -Force | Out-Null
      $childArgs = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath, "-NoGui", "-InstallRoot", $options.InstallRoot, "-Route", $options.Route, "-E2bChoice", $options.E2bChoice, "-OcrChoice", $options.OcrChoice, "-DshProfile", $options.DshProfile)
      foreach ($pair in @(@("-E2bEnvFile", $options.E2bEnvFile), @("-OcrConfig", $options.OcrConfig), @("-PythonExecutable", $options.PythonExecutable), @("-DshCommand", $options.DshCommand), @("-DshHome", $options.DshHome))) { if ($pair[1]) { $childArgs += @($pair[0], $pair[1]) } }
      $start = New-Object Diagnostics.ProcessStartInfo
      $start.FileName = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
      $start.Arguments = ($childArgs | ForEach-Object { Quote-WindowsArgument ([string]$_) }) -join " "
      $start.WorkingDirectory = (Resolve-TargetPath $options.InstallRoot)
      $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
      try { $start.StandardOutputEncoding = New-Object Text.UTF8Encoding($false); $start.StandardErrorEncoding = New-Object Text.UTF8Encoding($false) } catch { }
      $state.Process = New-Object Diagnostics.Process; $state.Process.StartInfo = $start
      if (-not $state.Process.Start()) { throw "Could not start the installer worker." }
      $state.Route = $options.Route; $state.InstalledRoot = $start.WorkingDirectory; $state.McpConfig = Join-Path $state.InstalledRoot "desklatch.mcp.json"
      $state.OutputTask = $state.Process.StandardOutput.ReadToEndAsync()
      $state.ErrorTask = $state.Process.StandardError.ReadToEndAsync()
      $startButton.Enabled = $false; $closeButton.Enabled = $false; $authorizeButton.Enabled = $false; $copyButton.Visible = $false; $script:ProgressBar.Visible = $true; $timer.Start(); $script:LogBox.AppendText("开始安装，请稍候。`r`n")
    } catch { [Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, "DeskLatch 安装", [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Warning) | Out-Null }
  })
  [void]$form.ShowDialog()
}

if ($Plan) { Show-Plan; exit 0 }
if (-not $NoGui -and [Environment]::UserInteractive) { Start-Gui; exit 0 }
if (-not $Route) { throw "A route is required in non-GUI mode. Use -Route mcp or -Route dsh." }
$options = @{ InstallRoot = if ($InstallRoot) { $InstallRoot } else { Get-DefaultInstallRoot }; Route = $Route; E2bChoice = $E2bChoice; OcrChoice = $OcrChoice; E2bEnvFile = $E2bEnvFile; OcrConfig = $OcrConfig; PythonExecutable = $PythonExecutable; DshCommand = $DshCommand; DshHome = $DshHome; DshProfile = $DshProfile }
Invoke-SetupFlow -Options $options | Out-Null
