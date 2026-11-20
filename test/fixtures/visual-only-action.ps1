# The caption exists only in pixels. The fixture performs no external action.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DeskLatch OCR Acceptance'
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Location = New-Object System.Drawing.Point(120, 120)
$form.ClientSize = New-Object System.Drawing.Size(410, 230)
$form.TopMost = $true

$pointMode = $env:DESKLATCH_TEST_VISUAL_POINT -eq '1'
$surface = if ($pointMode) { New-Object System.Windows.Forms.PictureBox } else { New-Object System.Windows.Forms.Button }
$surface.AccessibleName = 'Visual command'
$surface.Location = New-Object System.Drawing.Point(100, 85)
$surface.Size = New-Object System.Drawing.Size(220, 78)
if ($pointMode) {
  $surface.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::CenterImage
  $surface.AccessibleRole = [System.Windows.Forms.AccessibleRole]::Graphic
} else {
  $surface.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
}
$surface.BackColor = [System.Drawing.Color]::White
$font = New-Object System.Drawing.Font('Segoe UI', 19, [System.Drawing.FontStyle]::Bold)
$bitmap = New-Object System.Drawing.Bitmap(202, 56)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.DrawString('Send message', $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.PointF(12, 9)))
  if ($pointMode) { $graphics.FillRectangle([System.Drawing.Brushes]::Magenta, 95, 45, 11, 10) }
} finally { $graphics.Dispose() }
$surface.Image = $bitmap
$surface.Add_Click({ [Console]::WriteLine('visual-click') })
$form.Controls.Add($surface)
$form.Add_Shown({
  $form.Activate()
  $center = $surface.PointToScreen((New-Object System.Drawing.Point(110, 61)))
  [Console]::WriteLine(('point:{0},{1}' -f $center.X, $center.Y))
})
try { [System.Windows.Forms.Application]::Run($form) } finally { $form.Dispose(); $bitmap.Dispose(); $font.Dispose() }
