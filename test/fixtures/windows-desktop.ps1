param(
  [switch]$PopupOnStart,
  [switch]$ProductFixture
)

# Run with: powershell.exe -NoProfile -STA -File windows-desktop.ps1
# This fixture is intentionally disposable and contains no file or network IO.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'DeskLatch Desktop Fixture'
$form.Name = 'DeskLatchDesktopFixture'
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Location = New-Object System.Drawing.Point(80, 80)
$form.Size = New-Object System.Drawing.Size(520, 360)
$form.MinimumSize = New-Object System.Drawing.Size(420, 300)

$layout = New-Object System.Windows.Forms.TableLayoutPanel
$layout.Dock = [System.Windows.Forms.DockStyle]::Fill
$layout.Padding = New-Object System.Windows.Forms.Padding(16)
$layout.ColumnCount = 2
$layout.RowCount = 6
$layout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 150)))
$layout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))

$counterLabel = New-Object System.Windows.Forms.Label
$counterLabel.Text = 'Counter: 0'
$counterLabel.Name = 'FixtureCounter'
$counterLabel.AutoSize = $true
$counterLabel.AccessibleName = 'Fixture counter'
$counterLabel.Anchor = [System.Windows.Forms.AnchorStyles]::Left

$increment = New-Object System.Windows.Forms.Button
$increment.Text = 'Increment fixture counter'
$increment.Name = 'IncrementFixtureCounter'
$increment.AccessibleName = 'Increment fixture counter'
$increment.AutoSize = $true

$editorLabel = New-Object System.Windows.Forms.Label
$editorLabel.Text = 'Editor'
$editorLabel.Name = 'FixtureEditorLabel'
$editorLabel.AutoSize = $true

$editor = New-Object System.Windows.Forms.TextBox
$editor.Text = ''
$editor.Name = 'FixtureEditor'
$editor.AccessibleName = 'Fixture editor'
$editor.Dock = [System.Windows.Forms.DockStyle]::Fill

$scrollLabel = New-Object System.Windows.Forms.Label
$scrollLabel.Text = 'Scroll area'
$scrollLabel.Name = 'FixtureScrollLabel'
$scrollLabel.AutoSize = $true

$scroll = New-Object System.Windows.Forms.Panel
$scroll.Name = 'FixtureScrollArea'
$scroll.AccessibleName = 'Fixture scroll area'
$scroll.AutoScroll = $true
$scroll.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$scroll.Dock = [System.Windows.Forms.DockStyle]::Fill
$scrollText = New-Object System.Windows.Forms.Label
$scrollText.AutoSize = $true
$scrollText.Name = 'FixtureRows'
$scrollText.Text = (1..120 | ForEach-Object { "Fixture row $_" }) -join [Environment]::NewLine
$scroll.Controls.Add($scrollText)

$popupButton = New-Object System.Windows.Forms.Button
$popupButton.Text = 'Open fixture popup'
$popupButton.Name = 'OpenFixturePopup'
$popupButton.AccessibleName = 'Open fixture popup'
$popupButton.AutoSize = $true

$status = New-Object System.Windows.Forms.Label
$status.Text = 'Ready'
$status.Name = 'FixtureStatus'
$status.AccessibleName = 'Fixture status'
$status.AutoSize = $true

$null = $layout.Controls.Add($counterLabel, 0, 0)
$null = $layout.Controls.Add($increment, 1, 0)
$null = $layout.Controls.Add($editorLabel, 0, 1)
$null = $layout.Controls.Add($editor, 1, 1)
$null = $layout.Controls.Add($scrollLabel, 0, 2)
$null = $layout.Controls.Add($scroll, 1, 2)
$null = $layout.Controls.Add($popupButton, 1, 3)
$null = $layout.Controls.Add($status, 1, 4)
$form.Controls.Add($layout)

$script:count = 0
$increment.Add_Click({
  $script:count++
  $counterLabel.Text = "Counter: $script:count"
  $increment.Text = "Counter: $script:count"
  $status.Text = "Clicked $script:count"
})
$editor.Add_TextChanged({ $status.Text = "Text length: $($editor.Text.Length)" })
if ($ProductFixture) {
  $form.Text = 'DeskLatch Native Acceptance'
  $form.Size = New-Object System.Drawing.Size(560, 460)
  $layout.RowCount = 7
  $actions = New-Object System.Windows.Forms.FlowLayoutPanel
  $actions.AutoSize = $true
  foreach ($name in @('Search', 'Continue', 'Send message')) {
    $button = New-Object System.Windows.Forms.Button
    $button.Text = $name
    $button.AutoSize = $true
    $button.Add_Click({ param($source, $eventArgs) [Console]::WriteLine('clicked:' + $source.Text) })
    [void]$actions.Controls.Add($button)
  }
  $null = $layout.Controls.Add($actions, 0, 5)
  $layout.SetColumnSpan($actions, 2)
}
$popupButton.Add_Click({
  $popup = New-Object System.Windows.Forms.Form
  $popup.Text = 'DeskLatch Fixture Popup'
  $popup.Name = 'DeskLatchFixturePopup'
  $popup.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $popup.Location = New-Object System.Drawing.Point(($form.Location.X + 80), ($form.Location.Y + 80))
  $popup.Size = New-Object System.Drawing.Size(300, 160)
  $popup.Owner = $form
  $popupLabel = New-Object System.Windows.Forms.Label
  $popupLabel.Text = 'Popup guard'
  $popupLabel.Name = 'PopupGuardLabel'
  $popupLabel.AccessibleName = 'Popup guard'
  $popupLabel.AutoSize = $true
  $popupLabel.Location = New-Object System.Drawing.Point(24, 24)
  $close = New-Object System.Windows.Forms.Button
  $close.Text = 'Close popup'
  $close.Name = 'CloseFixturePopup'
  $close.AccessibleName = 'Close popup'
  $close.AutoSize = $true
  $close.Location = New-Object System.Drawing.Point(24, 64)
  $close.Add_Click({ param($source, $eventArgs) $source.FindForm().Close() })
  $popup.Controls.Add($popupLabel)
  $popup.Controls.Add($close)
  $popup.Show($form)
})

if ($PopupOnStart) { $form.Add_Shown({ $popupButton.PerformClick() }) }
[System.Windows.Forms.Application]::Run($form)
