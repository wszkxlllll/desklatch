$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$message = [string]$request.summary
if ($request.context) { $message += "`r`n`r`n" + [string]$request.context }
$answer = [Windows.Forms.MessageBox]::Show(
  $message, 'DeskLatch 审批',
  [Windows.Forms.MessageBoxButtons]::YesNo,
  [Windows.Forms.MessageBoxIcon]::Question,
  [Windows.Forms.MessageBoxDefaultButton]::Button2
)
if ($answer -eq [Windows.Forms.DialogResult]::Yes) { [Console]::Write('approve') }
else { [Console]::Write('deny') }
