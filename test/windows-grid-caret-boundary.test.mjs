import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('native grid caret accepts only editor right/bottom rounding and rejects adjacent cells or unknown panes', {
  skip: process.platform !== 'win32',
}, () => {
  const sourcePath = fileURLToPath(new URL('../src/backends/windows/dialog-transport.ps1', import.meta.url));
  const sourcePathBase64 = Buffer.from(sourcePath, 'utf8').toString('base64');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$scriptPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + sourcePathBase64 + "'))",
    "$source = [IO.File]::ReadAllText($scriptPath, [Text.Encoding]::UTF8)",
    "$tokens = $null; $parseErrors = $null",
    "[void][System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)",
    "if ($parseErrors.Count -gt 0) { throw ('dialog_transport_parse_error:' + ($parseErrors -join ';')) }",
    "foreach ($name in @('GridCaretWithin', 'GridCaretWithinEditor', 'GridEditorProviderAllowed')) {",
    "  $pattern = '(?ms)^function ' + $name + '\\([^\\r\\n]*\\) \\{\\r?\\n.*?^\\}'",
    "  $match = [regex]::Match($source, $pattern)",
    "  if (-not $match.Success) { throw ('function_missing_' + $name) }",
    "  Invoke-Expression $match.Value",
    "}",
    "if ($source -notmatch 'if \\(-not \\(GridCaretWithin \\$caret \\$cellBounds\\) -or -not \\(GridCaretWithinEditor \\$caret \\$editorBounds\\)\\)') {",
    "  throw 'grid_focus_does_not_use_strict_cell_and_tolerant_editor_checks'",
    "}",
    "$cell = [pscustomobject]@{ x = 500.0; y = 578.0; width = 100.0; height = 22.0 }",
    "$editor = [pscustomobject]@{ x = 500.0; y = 578.0; width = 99.0; height = 21.0 }",
    "$observedCaret = [pscustomobject]@{ x = 510.0; y = 578.0; width = 2.0; height = 22.0 }",
    "$rightRoundedCaret = [pscustomobject]@{ x = 597.0; y = 580.0; width = 3.0; height = 10.0 }",
    "$centerOnRightEdge = [pscustomobject]@{ x = 598.0; y = 580.0; width = 2.0; height = 10.0 }",
    "$tooFarRight = [pscustomobject]@{ x = 598.0; y = 580.0; width = 3.0; height = 10.0 }",
    "$tooFarBottom = [pscustomobject]@{ x = 510.0; y = 578.0; width = 2.0; height = 23.0 }",
    "$tooFarLeft = [pscustomobject]@{ x = 499.0; y = 580.0; width = 2.0; height = 10.0 }",
    "$tooFarTop = [pscustomobject]@{ x = 510.0; y = 577.0; width = 2.0; height = 10.0 }",
    "$neighborCaret = [pscustomobject]@{ x = 600.0; y = 578.0; width = 1.0; height = 22.0 }",
    "$checks = [ordered]@{",
    "  observedOnePixelBottomRoundingAccepted = (GridCaretWithin $observedCaret $cell) -and (GridCaretWithinEditor $observedCaret $editor)",
    "  onePixelEditorRightRoundingAccepted = (GridCaretWithin $rightRoundedCaret $cell) -and (GridCaretWithinEditor $rightRoundedCaret $editor)",
    "  editorCenterMustRemainInside = -not (GridCaretWithinEditor $centerOnRightEdge $editor)",
    "  editorRightOverOnePixelRejected = -not (GridCaretWithinEditor $tooFarRight $editor)",
    "  editorBottomOverOnePixelRejected = -not (GridCaretWithinEditor $tooFarBottom $editor)",
    "  editorLeftToleranceRejected = -not (GridCaretWithinEditor $tooFarLeft $editor)",
    "  editorTopToleranceRejected = -not (GridCaretWithinEditor $tooFarTop $editor)",
    "  adjacentCellRejected = -not (GridCaretWithin $neighborCaret $cell)",
    "  excel6PaneChildAccepted = GridEditorProviderAllowed 'Pane' 'EXCEL6' $false $false $true",
    "  otherPaneClassRejected = -not (GridEditorProviderAllowed 'Pane' 'DialogPane' $false $false $true)",
    "  topLevelPaneRejected = -not (GridEditorProviderAllowed 'Pane' 'EXCEL6' $false $false $false)",
    "  writableEditAccepted = GridEditorProviderAllowed 'Edit' 'EXCEL6' $true $false $true",
    "  readOnlyEditRejected = -not (GridEditorProviderAllowed 'Edit' 'EXCEL6' $false $false $true)",
    "  passwordEditRejected = -not (GridEditorProviderAllowed 'Edit' 'EXCEL6' $true $true $true)",
    "  unverifiedRoleRejected = -not (GridEditorProviderAllowed 'Button' 'EXCEL6' $true $false $true)",
    "}",
    "$checks | ConvertTo-Json -Compress",
  ].join('\n');
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  const output = execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand,
  ], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  const checks = JSON.parse(output.trim());
  for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, name);
});
