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
  if ($running.Count -gt 0) { throw "请从系统托盘完全退出 DeepSeek Harness，再管理 DeskLatch 插件。" }
}

function Resolve-DshProfile([string]$RequestedHome, [string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name) -or $Name -in @(".", "..") -or $Name -match '[/\\:\x00-\x1f]') {
    throw "请选择有效的 DSH 配置名称。"
  }
  $homePath = if ($RequestedHome) {
    Resolve-TargetPath $RequestedHome
  } elseif ($env:DSH_HOME) {
    Resolve-TargetPath $env:DSH_HOME
  } else {
    Join-Path ([Environment]::GetFolderPath("UserProfile")) ".dsh"
  }
  return [pscustomobject]@{
    Home = $homePath
    Name = $Name
    Directory = Join-Path (Join-Path $homePath "profiles") $Name
  }
}

function Get-DshStoreDirectory($Profile) {
  $metadata = Join-Path $Profile.Directory "node_modules\.modules.yaml"
  if (-not (Test-Path -LiteralPath $metadata -PathType Leaf)) {
    return Join-Path $Profile.Directory ".plugin-manager\pnpm-store"
  }

  # pnpm v11 writes JSON into .modules.yaml. Older versions write YAML.
  $raw = [IO.File]::ReadAllText($metadata, [Text.UTF8Encoding]::new($false, $true))
  $store = $null
  if ($raw.TrimStart().StartsWith("{")) {
    $parsed = $raw | ConvertFrom-Json
    $property = $parsed.PSObject.Properties["storeDir"]
    if ($property) { $store = $property.Value }
  } else {
    $binding = [regex]::Matches($raw, '(?m)^storeDir:[ \t]*([^\r\n]+)')
    if ($binding.Count -eq 1) {
      $scalar = $binding[0].Groups[1].Value.Trim()
      if ($scalar -match "^'((?:[^']|'')*)'[ \t]*(?:#.*)?$") {
        $store = $Matches[1].Replace("''", "'")
      } elseif ($scalar -match '^("(?:[^"\\]|\\.)*")[ \t]*(?:#.*)?$') {
        $store = $Matches[1] | ConvertFrom-Json
      } else {
        $store = ($scalar -replace '[ \t]+#.*$', '').Trim()
      }
    }
  }
  if ($store -isnot [string] -or $store -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\)' -or $store -match '[\x00-\x1f"]') {
    throw "无法从 DSH 配置读取已绑定的 pnpm 仓库。请检查 $metadata。"
  }
  # The bundled pnpm accepts its recorded, versioned store directly.
  return [IO.Path]::GetFullPath($store)
}

function Get-DshPluginDependency($Profile) {
  $manifest = Join-Path $Profile.Directory "package.json"
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return }
  $package = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  $dependencies = $package.PSObject.Properties["dependencies"]
  if ($dependencies -and $dependencies.Value) {
    $plugin = $dependencies.Value.PSObject.Properties["desklatch-dsh"]
    if ($plugin) { return $plugin.Value }
  }
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
