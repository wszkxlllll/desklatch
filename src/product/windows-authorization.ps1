#requires -Version 5.1

<##
  DeskLatch Windows authorization page.

  Launcher requirements:
    powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File windows-authorization.ps1 `
      -NodePath <absolute node.exe> -CliPath <absolute windows-authorization.js> `
      -AuthorizationFile <absolute grants.json>

  The Node adapter is the authority for window discovery and persistence:
    node windows-authorization.js --snapshot <absolute grants.json>
    node windows-authorization.js --save <absolute grants.json>   # grants JSON on UTF-8 stdin

  This page never enumerates HWNDs, reads titles, launches applications, or
  talks to DeskLatch directly. It displays only the app-level inventory and
  grant snapshot returned by the trusted adapter.
##>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $NodePath,

  [Parameter(Mandatory = $true)]
  [string] $CliPath,

  [Parameter(Mandatory = $true)]
  [string] $AuthorizationFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Resolve-AbsoluteFilePath {
  param(
    [Parameter(Mandatory = $true)] [string] $Path,
    [Parameter(Mandatory = $true)] [string] $Label,
    [switch] $MustExist
  )

  if ([string]::IsNullOrWhiteSpace($Path) -or -not [System.IO.Path]::IsPathRooted($Path)) {
    throw "$Label must be an absolute path."
  }
  $full = [System.IO.Path]::GetFullPath($Path)
  if ($MustExist -and -not [System.IO.File]::Exists($full)) {
    throw "$Label was not found: $full"
  }
  return $full
}

function Get-Field {
  param(
    [Parameter(Mandatory = $false)] [object] $Object,
    [Parameter(Mandatory = $true)] [string] $Name,
    [Parameter(Mandatory = $false)] [object] $Default = $null
  )

  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $Default }
  return $property.Value
}

function Get-JsonItems {
  param([object] $Value)

  if ($null -eq $Value) { return @() }
  if ($Value -is [string]) { return @($Value) }
  if ($Value -is [System.Collections.IEnumerable]) { return @($Value) }
  return @($Value)
}

function Normalize-Text {
  param(
    [object] $Value,
    [int] $Maximum = 256
  )

  if ($null -eq $Value) { return $null }
  $text = ([string] $Value).Trim()
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  if ($text.Length -gt $Maximum) { return $text.Substring(0, $Maximum) }
  return $text
}

function ConvertTo-WindowsArgument {
  param([Parameter(Mandatory = $true)] [string] $Value)

  # ProcessStartInfo.ArgumentList is used whenever the host runtime exposes
  # it. This fallback follows CommandLineToArgvW quoting and never invokes a
  # shell, so a path cannot inject another command.
  if ($Value -notmatch '[\s"]') { return $Value }
  $escaped = $Value -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

function Invoke-AuthorizationCli {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Snapshot", "Save")]
    [string] $Mode,

    [Parameter(Mandatory = $false)]
    [object] $Grants
  )

  $arguments = if ($Mode -eq "Snapshot") {
    @($CliPath, "--snapshot", $AuthorizationFile)
  } else {
    @($CliPath, "--save", $AuthorizationFile)
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $NodePath
  $startInfo.WorkingDirectory = [System.IO.Path]::GetDirectoryName($CliPath)
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.RedirectStandardInput = ($Mode -eq "Save")
  $startInfo.StandardOutputEncoding = $script:Utf8NoBom
  $startInfo.StandardErrorEncoding = $script:Utf8NoBom

  $argumentListProperty = $startInfo.PSObject.Properties["ArgumentList"]
  if ($null -ne $argumentListProperty) {
    foreach ($argument in $arguments) { [void] $startInfo.ArgumentList.Add($argument) }
  } else {
    $startInfo.Arguments = (($arguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join " ")
  }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  $exitCode = -1
  try {
    if (-not $process.Start()) { throw "Unable to start the authorization adapter." }

    if ($Mode -eq "Save") {
      $inputJson = $Grants | ConvertTo-Json -Depth 8 -Compress
      $inputBytes = $script:Utf8NoBom.GetBytes($inputJson)
      $inputStream = $process.StandardInput.BaseStream
      $inputStream.Write($inputBytes, 0, $inputBytes.Length)
      $inputStream.Flush()
      $process.StandardInput.Close()
    }

    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $exitCode = $process.ExitCode
  } finally {
    $process.Dispose()
  }

  if ($exitCode -ne 0) {
    $detail = Normalize-Text $stderr 512
    if ($null -eq $detail) { $detail = "exit code $exitCode" }
    throw "The authorization adapter failed: $detail"
  }
  if ([string]::IsNullOrWhiteSpace($stdout)) { throw "The authorization adapter returned no JSON." }
  try {
    return $stdout | ConvertFrom-Json
  } catch {
    throw "The authorization adapter returned invalid UTF-8 JSON."
  }
}

function ConvertTo-NormalizedSnapshot {
  param([Parameter(Mandatory = $true)] [object] $Raw)

  $rawGrants = Get-Field $Raw "grants" $Raw
  $grantApps = @()
  $grantIds = @{}
  foreach ($item in Get-JsonItems (Get-Field $rawGrants "apps" @())) {
    $id = Normalize-Text (Get-Field $item "id") 256
    if ($null -eq $id -or $grantIds.ContainsKey($id)) { continue }
    $name = Normalize-Text (Get-Field $item "name") 256
    if ($null -eq $name) { $name = $id }
    $grantIds[$id] = $true
    $grantApps += [pscustomobject]([ordered]@{ id = $id; name = $name })
  }

  $applications = @()
  $applicationIds = @{}
  foreach ($item in Get-JsonItems (Get-Field $Raw "applications" @())) {
    $id = Normalize-Text (Get-Field $item "id") 256
    if ($null -eq $id -or $applicationIds.ContainsKey($id)) { continue }
    $name = Normalize-Text (Get-Field $item "name") 256
    if ($null -eq $name) { $name = $id }
    $windowValue = Get-Field $item "windows" 0
    $windowCount = 0
    if ($windowValue -is [ValueType]) {
      try { $windowCount = [Math]::Max(0, [int] $windowValue) } catch { $windowCount = 0 }
    } else {
      $windowCount = @(Get-JsonItems $windowValue).Count
    }
    $applicationIds[$id] = $true
    $applications += [pscustomobject]([ordered]@{ id = $id; name = $name; windows = $windowCount })
  }

  $allowForegroundInput = [bool](Get-Field $rawGrants "allowForegroundInput" $false)
  $allowDesktopCapture = [bool](Get-Field $rawGrants "allowDesktopCapture" $false)
  $allowLocalWindowEvidence = [bool](Get-Field $rawGrants "allowLocalWindowEvidence" $allowDesktopCapture)
  return [pscustomobject]([ordered]@{
      grants = [pscustomobject]([ordered]@{
          version = 1
          apps = $grantApps
          allowForegroundInput = $allowForegroundInput
          allowDesktopCapture = $allowDesktopCapture
          allowLocalWindowEvidence = $allowLocalWindowEvidence
        })
      applications = $applications
    })
}

function Get-MergedApplications {
  param([Parameter(Mandatory = $true)] [object] $Snapshot)

  $grantById = @{}
  foreach ($grant in Get-JsonItems (Get-Field $Snapshot.grants "apps" @())) {
    $id = Normalize-Text (Get-Field $grant "id") 256
    if ($null -ne $id) { $grantById[$id] = $grant }
  }

  $rows = @()
  $seen = @{}
  foreach ($application in Get-JsonItems (Get-Field $Snapshot "applications" @())) {
    $id = Normalize-Text (Get-Field $application "id") 256
    if ($null -eq $id -or $seen.ContainsKey($id)) { continue }
    $name = Normalize-Text (Get-Field $application "name") 256
    if ($null -eq $name) { $name = $id }
    $windowCount = 0
    try { $windowCount = [Math]::Max(0, [int] (Get-Field $application "windows" 0)) } catch { $windowCount = 0 }
    $seen[$id] = $true
    $rows += [pscustomobject]([ordered]@{
        id = $id
        name = $name
        windows = $windowCount
        granted = $grantById.ContainsKey($id)
      })
  }

  # Closed apps remain visible only when the saved grants retain them. Their
  # zero-window row lets a user revoke a future-window permission safely.
  foreach ($grant in Get-JsonItems (Get-Field $Snapshot.grants "apps" @())) {
    $id = Normalize-Text (Get-Field $grant "id") 256
    if ($null -eq $id -or $seen.ContainsKey($id)) { continue }
    $name = Normalize-Text (Get-Field $grant "name") 256
    if ($null -eq $name) { $name = $id }
    $seen[$id] = $true
    $rows += [pscustomobject]([ordered]@{ id = $id; name = $name; windows = 0; granted = $true })
  }
  return $rows
}

function New-UiLabel {
  param(
    [Parameter(Mandatory = $true)] [string] $Text,
    [Parameter(Mandatory = $false)] [int] $Height = 24
  )
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Text
  $label.AutoSize = $false
  $label.Height = $Height
  return $label
}

function Set-Status {
  param(
    [Parameter(Mandatory = $true)] [string] $Text,
    [switch] $Error
  )
  $script:Ui.status.Text = $Text
  $script:Ui.status.ForeColor = if ($Error) {
    [System.Drawing.Color]::Firebrick
  } else {
    [System.Drawing.Color]::DimGray
  }
}

function Get-GrantsFromUi {
  $apps = @()
  foreach ($row in $script:State.rows) {
    $checkBox = $script:Ui.appChecks[$row.id]
    if ($null -ne $checkBox -and $checkBox.Checked) {
      $apps += [pscustomobject]([ordered]@{ id = $row.id; name = $row.name })
    }
  }
  return [pscustomobject]([ordered]@{
      version = 1
      apps = $apps
      allowForegroundInput = [bool] $script:Ui.foreground.Checked
      allowDesktopCapture = [bool] $script:Ui.screenshots.Checked
      allowLocalWindowEvidence = [bool] $script:Ui.localEvidence.Checked
    })
}

function Set-PageSnapshot {
  param([Parameter(Mandatory = $true)] [object] $Snapshot)

  $script:State.snapshot = $Snapshot
  $script:State.rows = @(Get-MergedApplications $Snapshot)
  $script:State.suppressChanges = $true
  try {
    $script:Ui.appChecks = @{}
    $script:Ui.appFlow.SuspendLayout()
    $script:Ui.appFlow.Controls.Clear()
    if ($script:State.rows.Count -eq 0) {
      $empty = New-UiLabel "当前没有检测到可授权的用户应用。刷新会重新读取实际窗口。" 48
      $empty.Width = [Math]::Max(480, $script:Ui.appFlow.ClientSize.Width - 10)
      $empty.Dock = [System.Windows.Forms.DockStyle]::Top
      $empty.Padding = New-Object System.Windows.Forms.Padding(10, 12, 10, 4)
      $script:Ui.appFlow.Controls.Add($empty)
    } else {
      foreach ($row in $script:State.rows) {
        $card = New-Object System.Windows.Forms.Panel
        $card.Width = [Math]::Max(480, $script:Ui.appFlow.ClientSize.Width - 34)
        $card.Height = 66
        $card.Margin = New-Object System.Windows.Forms.Padding(4, 4, 4, 0)
        $card.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle

        $checkBox = New-Object System.Windows.Forms.CheckBox
        $checkBox.Text = "允许自动操作：$($row.name)"
        $checkBox.Checked = [bool] $row.granted
        $checkBox.AutoSize = $true
        $checkBox.Location = New-Object System.Drawing.Point(12, 10)
        $checkBox.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
        $checkBox.Tag = $row.id
        $checkBox.Add_CheckedChanged({
            if (-not $script:State.suppressChanges) { $script:State.dirty = $true }
          })

        $detailText = if ($row.windows -gt 0) {
          "$($row.windows) 个当前窗口；授权也适用于之后打开的同一应用窗口"
        } else {
          "当前没有窗口；保留授权可用于之后打开的同一应用窗口"
        }
        $detail = New-UiLabel $detailText 22
        $detail.Location = New-Object System.Drawing.Point(34, 34)
        $detail.Width = $card.Width - 46
        $detail.Anchor = [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
        $detail.ForeColor = [System.Drawing.Color]::DimGray

        $card.Controls.Add($checkBox)
        $card.Controls.Add($detail)
        $script:Ui.appFlow.Controls.Add($card)
        $script:Ui.appChecks[$row.id] = $checkBox
      }
    }
    $script:Ui.foreground.Checked = [bool] $Snapshot.grants.allowForegroundInput
    $script:Ui.screenshots.Checked = [bool] $Snapshot.grants.allowDesktopCapture
    $script:Ui.localEvidence.Checked = [bool] $Snapshot.grants.allowLocalWindowEvidence
    $script:State.loaded = $true
    $script:State.dirty = $false
    $script:Ui.save.Enabled = $true
  } finally {
    $script:State.suppressChanges = $false
    $script:Ui.appFlow.ResumeLayout($true)
  }
}

function Refresh-AuthorizationPage {
  $script:Ui.refresh.Enabled = $false
  $script:Ui.save.Enabled = $false
  Set-Status "正在读取实际应用窗口…"
  try {
    $raw = Invoke-AuthorizationCli -Mode Snapshot
    $snapshot = ConvertTo-NormalizedSnapshot $raw
    Set-PageSnapshot $snapshot
    Set-Status "已读取实际窗口；未显示子窗口或对话框标题。"
  } catch {
    $script:State.loaded = $false
    $script:State.dirty = $false
    $script:Ui.appFlow.Controls.Clear()
    Set-Status ("读取失败：" + $_.Exception.Message) -Error
  } finally {
    $script:Ui.refresh.Enabled = $true
    $script:Ui.save.Enabled = [bool] $script:State.loaded
  }
}

function Save-AuthorizationPage {
  if (-not $script:State.loaded) { return }
  $script:Ui.save.Enabled = $false
  $script:Ui.refresh.Enabled = $false
  Set-Status "正在保存授权…"
  try {
    $grants = Get-GrantsFromUi
    $raw = Invoke-AuthorizationCli -Mode Save -Grants $grants
    $snapshot = ConvertTo-NormalizedSnapshot $raw
    Set-PageSnapshot $snapshot
    Set-Status "授权已保存。"
  } catch {
    Set-Status ("保存失败：" + $_.Exception.Message) -Error
  } finally {
    $script:Ui.refresh.Enabled = $true
    $script:Ui.save.Enabled = [bool] $script:State.loaded
  }
}

try {
  $NodePath = Resolve-AbsoluteFilePath $NodePath "NodePath" -MustExist
  $CliPath = Resolve-AbsoluteFilePath $CliPath "CliPath" -MustExist
  $AuthorizationFile = Resolve-AbsoluteFilePath $AuthorizationFile "AuthorizationFile"

  if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne [System.Threading.ApartmentState]::STA) {
    throw "The launcher must start Windows PowerShell with -STA."
  }

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()
  [System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

  $script:State = @{
    loaded = $false
    dirty = $false
    suppressChanges = $false
    snapshot = $null
    rows = @()
  }

  $form = New-Object System.Windows.Forms.Form
  $form.Text = "DeskLatch 自动化授权"
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $form.Width = 760
  $form.Height = 700
  $form.MinimumSize = New-Object System.Drawing.Size(640, 560)
  $form.Font = New-Object System.Drawing.Font("Segoe UI", 10)
  $form.BackColor = [System.Drawing.Color]::White

  $header = New-Object System.Windows.Forms.Panel
  $header.Dock = [System.Windows.Forms.DockStyle]::Top
  $header.Height = 94
  $header.Padding = New-Object System.Windows.Forms.Padding(24, 16, 24, 4)
  $title = New-UiLabel "自动化授权" 32
  $title.Dock = [System.Windows.Forms.DockStyle]::Top
  $title.Font = New-Object System.Drawing.Font("Segoe UI", 16, [System.Drawing.FontStyle]::Bold)
  $title.ForeColor = [System.Drawing.Color]::FromArgb(27, 39, 58)
  $subtitle = New-UiLabel "选择允许 DeskLatch 操作的应用；只展示应用名称和当前窗口数量。" 34
  $subtitle.Dock = [System.Windows.Forms.DockStyle]::Top
  $subtitle.ForeColor = [System.Drawing.Color]::DimGray
  $header.Controls.Add($subtitle)
  $header.Controls.Add($title)

  $footer = New-Object System.Windows.Forms.Panel
  $footer.Dock = [System.Windows.Forms.DockStyle]::Bottom
  $footer.Height = 72
  $footer.Padding = New-Object System.Windows.Forms.Padding(24, 8, 24, 12)
  $status = New-UiLabel "正在读取实际应用窗口…" 28
  $status.Dock = [System.Windows.Forms.DockStyle]::Fill
  $status.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
  $refresh = New-Object System.Windows.Forms.Button
  $refresh.Text = "刷新"
  $refresh.Width = 84
  $refresh.Height = 34
  $refresh.Dock = [System.Windows.Forms.DockStyle]::Right
  $save = New-Object System.Windows.Forms.Button
  $save.Text = "保存授权"
  $save.Width = 112
  $save.Height = 34
  $save.Dock = [System.Windows.Forms.DockStyle]::Right
  $save.Enabled = $false
  $footer.Controls.Add($status)
  $footer.Controls.Add($refresh)
  $footer.Controls.Add($save)

  $body = New-Object System.Windows.Forms.Panel
  $body.Dock = [System.Windows.Forms.DockStyle]::Fill
  $body.AutoScroll = $true
  $body.Padding = New-Object System.Windows.Forms.Padding(24, 8, 24, 12)

  $appsGroup = New-Object System.Windows.Forms.GroupBox
  $appsGroup.Text = "应用授权"
  $appsGroup.Dock = [System.Windows.Forms.DockStyle]::Top
  $appsGroup.Height = 338
  $appsGroup.Padding = New-Object System.Windows.Forms.Padding(10, 28, 10, 10)
  $appFlow = New-Object System.Windows.Forms.FlowLayoutPanel
  $appFlow.Dock = [System.Windows.Forms.DockStyle]::Fill
  $appFlow.FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
  $appFlow.WrapContents = $false
  $appFlow.AutoScroll = $true
  $appFlow.Padding = New-Object System.Windows.Forms.Padding(2)
  $appsGroup.Controls.Add($appFlow)

  $permissionsGroup = New-Object System.Windows.Forms.GroupBox
  $permissionsGroup.Text = "高级权限（分别确认）"
  $permissionsGroup.Dock = [System.Windows.Forms.DockStyle]::Top
  $permissionsGroup.Height = 174
  $permissionsGroup.Padding = New-Object System.Windows.Forms.Padding(14, 28, 14, 10)
  $foreground = New-Object System.Windows.Forms.CheckBox
  $foreground.Text = "允许前台输入（键盘、鼠标和窗口激活）"
  $foreground.AutoSize = $true
  $foreground.Location = New-Object System.Drawing.Point(16, 32)
  $foreground.Add_CheckedChanged({ if (-not $script:State.suppressChanges) { $script:State.dirty = $true } })
  $screenshots = New-Object System.Windows.Forms.CheckBox
  $screenshots.Text = "允许向模型提供全桌面截图（可能包含其他应用）"
  $screenshots.AutoSize = $true
  $screenshots.Location = New-Object System.Drawing.Point(16, 66)
  $screenshots.Add_CheckedChanged({ if (-not $script:State.suppressChanges) { $script:State.dirty = $true } })
  $localEvidence = New-Object System.Windows.Forms.CheckBox
  $localEvidence.Text = "允许本机识别已授权窗口的局部文字（需要 OCR）"
  $localEvidence.AutoSize = $true
  $localEvidence.Location = New-Object System.Drawing.Point(16, 98)
  $localEvidence.Add_CheckedChanged({ if (-not $script:State.suppressChanges) { $script:State.dirty = $true } })
  $scope = New-UiLabel "首次安装默认关闭，三项权限可分别设置。" 24
  $scope.Location = New-Object System.Drawing.Point(16, 130)
  $scope.Width = 660
  $scope.ForeColor = [System.Drawing.Color]::DimGray
  $permissionsGroup.Controls.Add($foreground)
  $permissionsGroup.Controls.Add($screenshots)
  $permissionsGroup.Controls.Add($localEvidence)
  $permissionsGroup.Controls.Add($scope)

  $body.Controls.Add($permissionsGroup)
  $body.Controls.Add($appsGroup)
  $form.Controls.Add($body)
  $form.Controls.Add($footer)
  $form.Controls.Add($header)

  $script:Ui = @{
    form = $form
    status = $status
    refresh = $refresh
    save = $save
    appFlow = $appFlow
    foreground = $foreground
    screenshots = $screenshots
    localEvidence = $localEvidence
    appChecks = @{}
  }

  $refresh.Add_Click({ Refresh-AuthorizationPage })
  $save.Add_Click({ Save-AuthorizationPage })
  $form.Add_Shown({ Refresh-AuthorizationPage })
  try { [void]$form.ShowDialog() } finally { $form.Dispose() }
} catch {
  $message = $_.Exception.Message
  try {
    [System.Windows.Forms.MessageBox]::Show($message, "DeskLatch 自动化授权", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
  } catch {
    Write-Error $message
  }
  exit 1
}
