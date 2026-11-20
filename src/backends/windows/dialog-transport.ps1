$ErrorActionPreference = "Stop"
$SelectorMatchLimit = 8

# This helper is a fixed, packaged worker. It accepts one bounded UTF-8 JSON
# request and emits one bounded UTF-8 JSON reply. It never receives captions,
# file paths, or executable code from the model.
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

function Reply([object] $value) {
  $json = $value | ConvertTo-Json -Compress -Depth 32
  [Console]::Out.Write($json)
}

function ErrorReply([string] $code) {
  return [ordered]@{ ok = $false; code = $code }
}

function CaptureDesktop([object] $request) {
  Add-Type -AssemblyName System.Drawing
  $width = [int]$request.width
  $height = [int]$request.height
  if ($width -lt 1 -or $height -lt 1 -or [long]$width * $height -gt 40000000) {
    return ErrorReply "desktop_capture_invalid_size"
  }
  # The parent works in the logical coordinate space returned by user32.
  # Sample the actual display pixels here, then scale the entire primary
  # display to that same logical grid before exposing the screenshot.
  $prior = [NativeWindowScope]::SetThreadDpiAwarenessContext([IntPtr](-4))
  if ($prior -eq [IntPtr]::Zero) { return ErrorReply "desktop_capture_dpi_unavailable" }
  $pixels = $null
  $reader = $null
  $scaled = $null
  $writer = $null
  $stream = $null
  try {
    $pixelWidth = [NativeWindowScope]::GetSystemMetrics(0)
    $pixelHeight = [NativeWindowScope]::GetSystemMetrics(1)
    if ($pixelWidth -lt 1 -or $pixelHeight -lt 1 -or [long]$pixelWidth * $pixelHeight -gt 40000000) {
      return ErrorReply "desktop_capture_invalid_size"
    }
    $pixels = [Drawing.Bitmap]::new($pixelWidth, $pixelHeight)
    $reader = [Drawing.Graphics]::FromImage($pixels)
    $reader.CopyFromScreen(0, 0, 0, 0, [Drawing.Size]::new($pixelWidth, $pixelHeight))
    $stream = [IO.MemoryStream]::new()
    if ($pixelWidth -eq $width -and $pixelHeight -eq $height) {
      $pixels.Save($stream, [Drawing.Imaging.ImageFormat]::Jpeg)
    } else {
      $scaled = [Drawing.Bitmap]::new($width, $height)
      $writer = [Drawing.Graphics]::FromImage($scaled)
      $writer.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
      $writer.DrawImage($pixels, 0, 0, $width, $height)
      $scaled.Save($stream, [Drawing.Imaging.ImageFormat]::Jpeg)
    }
    return [ordered]@{ ok = $true; width = $width; height = $height; data = [Convert]::ToBase64String($stream.ToArray()) }
  } finally {
    if ($stream) { $stream.Dispose() }
    if ($writer) { $writer.Dispose() }
    if ($scaled) { $scaled.Dispose() }
    if ($reader) { $reader.Dispose() }
    if ($pixels) { $pixels.Dispose() }
    [void][NativeWindowScope]::SetThreadDpiAwarenessContext($prior)
  }
}

function RequestString([object] $request, [string] $name) {
  $value = $request.$name
  if ($null -eq $value) { throw "native_uia_invalid_request" }
  $text = [string]$value
  if ($text.Length -eq 0 -or $text.Length -gt 4096) { throw "native_uia_invalid_request" }
  return $text
}

function RequestPid([object] $request) {
  $value = 0
  if (-not [int]::TryParse([string]$request.pid, [Globalization.NumberStyles]::Integer, [Globalization.CultureInfo]::InvariantCulture, [ref]$value)) {
    throw "invalid_window_identity"
  }
  if ($value -le 0 -or $value -gt 2147483647) { throw "invalid_window_identity" }
  return $value
}

function RequestHwnd([object] $request) {
  $value = 0L
  if (-not [Int64]::TryParse([string]$request.hwnd, [Globalization.NumberStyles]::Integer, [Globalization.CultureInfo]::InvariantCulture, [ref]$value)) {
    throw "invalid_window_identity"
  }
  if ($value -le 0) { throw "invalid_window_identity" }
  return [IntPtr]$value
}

function NormalizeMatchText([string] $value) {
  if ($null -eq $value) { return "" }
  try { $normalized = $value.Normalize([Text.NormalizationForm]::FormKC) } catch { $normalized = $value }
  return (($normalized.ToLowerInvariant() -replace "\s+", " ").Trim())
}

function SelectorFor([object] $request) {
  if ($null -eq $request.where) { return $null }
  $where = $request.where
  $role = [string]$where.role
  $name = [string]$where.name
  # within is owned by the host's window router; state/aliases are not part of
  # this worker's exact selector protocol. Never reinterpret them locally.
  if ([string]::IsNullOrWhiteSpace($role) -or [string]::IsNullOrWhiteSpace($name) -or $null -ne $where.within -or $null -ne $where.state) {
    throw "native_uia_selector_noncanonical"
  }
  if ($role.Length -gt 256 -or $name.Length -gt 4096) { throw "native_uia_selector_invalid" }
  return [ordered]@{ role = $role; name = $name }
}

function SelectorMatches([object] $element, [object] $selector) {
  if ($null -eq $selector) { return $true }
  $role = NormalizeMatchText ([string]$element.role)
  $wantedRole = NormalizeMatchText ([string]$selector.role)
  if ($role -in @("edit", "input", "textfield")) { $role = "textbox" }
  if ($wantedRole -in @("edit", "input", "textfield")) { $wantedRole = "textbox" }
  $name = NormalizeMatchText ([string]$element.label)
  return $role -ceq $wantedRole -and $name -ceq (NormalizeMatchText ([string]$selector.name))
}

function ElementIdentity([System.Windows.Automation.AutomationElement] $element) {
  try {
    $ids = @($element.GetRuntimeId()) | ForEach-Object { [int]$_ }
    if ($ids.Count -eq 0) { return "" }
    return ($ids -join ".")
  } catch {
    return ""
  }
}

function RoleName([System.Windows.Automation.AutomationElement] $element) {
  try {
    $name = [string]$element.Current.ControlType.ProgrammaticName
    if ($name.StartsWith("ControlType.", [StringComparison]::Ordinal)) { return $name.Substring(12) }
    return $name
  } catch {
    return "Unknown"
  }
}

function PasswordValue([System.Windows.Automation.AutomationElement] $element) {
  try {
    $value = $element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsPasswordProperty)
    return $value -is [bool] -and [bool]$value
  } catch {
    return $false
  }
}

function Supports([System.Windows.Automation.AutomationElement] $element, [object] $pattern) {
  $currentPattern = $null
  try {
    return [bool]$element.TryGetCurrentPattern($pattern, [ref]$currentPattern)
  } catch {
    return $false
  }
}

function Bounds([System.Windows.Automation.AutomationElement] $element) {
  try {
    $rect = $element.Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0) { return $null }
    return [ordered]@{
      x = [double]$rect.X
      y = [double]$rect.Y
      width = [double]$rect.Width
      height = [double]$rect.Height
    }
  } catch {
    return $null
  }
}

function OwnedByTarget([System.Windows.Automation.AutomationElement] $element, [IntPtr] $hwnd) {
  try {
    $native = [Int64]$element.Current.NativeWindowHandle
    if ($native -eq 0) { return $true }
    # WPF/Office controls can expose an internal child HWND. Keep it only
    # when that child belongs to the enrolled native root; this prevents a
    # parent Word HWND from silently widening scope to an unrelated modal.
    return [NativeWindowScope]::GetAncestor([IntPtr]$native, 2).ToInt64() -eq $hwnd.ToInt64()
  } catch {
    return $false
  }
}

function RootFor([int] $processId, [IntPtr] $hwnd) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) { throw "window_not_found" }
  $current = $root.Current
  if ([int]$current.ProcessId -ne $processId) { throw "window_owner_changed" }
  if ([Int64]$current.NativeWindowHandle -ne $hwnd.ToInt64()) { throw "window_identity_mismatch" }
  return $root
}

function TokenFor([int] $processId, [IntPtr] $hwnd, [string] $rootIdentity, [string] $elementIdentity, [string] $role, [string] $materialContextToken = "") {
  if ([string]::IsNullOrEmpty($elementIdentity)) { return $null }
  $payload = [ordered]@{
    v = 1
    pid = $processId
    hwnd = $hwnd.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture)
    root = $rootIdentity
    element = $elementIdentity
    role = $role
    material = $materialContextToken
  }
  $payloadJson = $payload | ConvertTo-Json -Compress -Depth 8
  $bytes = [Text.Encoding]::UTF8.GetBytes($payloadJson)
  $encoded = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
  return "uia1.$encoded"
}

function MaterialContextToken(
  [int] $processId,
  [IntPtr] $hwnd,
  [string] $rootIdentity,
  [object[]] $elements
) {
  $parts = New-Object System.Collections.Generic.List[string]
  [void]$parts.Add("pid=$processId")
  [void]$parts.Add("hwnd=$($hwnd.ToInt64())")
  [void]$parts.Add("root=$rootIdentity")
  foreach ($item in $elements) {
    if ($item.password -eq $true) { continue }
    [void]$parts.Add([string]$item.role)
    [void]$parts.Add([string]$item.label)
    [void]$parts.Add([string]$item.value)
    # Runtime identity is private but material: a replacement UIA node with
    # identical public text must not inherit an earlier approval.
    $identity = ""
    if (-not [string]::IsNullOrEmpty([string]$item.element_token)) {
      try { $identity = [string](DecodeToken ([string]$item.element_token)).element } catch { $identity = "" }
    }
    [void]$parts.Add($identity)
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($parts -join [char]0x1f))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
  $hex = -join ($digest | ForEach-Object { $_.ToString("x2") })
  return "uia-material-v1.$hex"
}

function EditableRole([string] $role) {
  $normalized = $role.ToLowerInvariant() -replace "[ _-]", ""
  return @("edit", "textbox", "textfield", "combobox", "document", "searchbox", "spinner") -contains $normalized
}

function NativeActions([System.Windows.Automation.AutomationElement] $element, [bool] $password, [string] $role) {
  $actions = New-Object System.Collections.Generic.List[string]
  if ($password) { return @() }
  if (Supports $element ([System.Windows.Automation.InvokePattern]::Pattern)) { [void]$actions.Add("invoke") }
  # Office Backstage commands may expose only SelectionItemPattern. Select is
  # the genuine UIA operation here; do not request focus or use global input.
  if (Supports $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)) { [void]$actions.Add("invoke") }
  if ((EditableRole $role) -and (Supports $element ([System.Windows.Automation.ValuePattern]::Pattern))) { [void]$actions.Add("set_value") }
  if (Supports $element ([System.Windows.Automation.ScrollPattern]::Pattern)) { [void]$actions.Add("scroll") }
  return [object[]]$actions.ToArray()
}

function ElementRecord(
  [System.Windows.Automation.AutomationElement] $element,
  [int] $index,
  [int] $depth,
  [string] $parent,
  [int] $processId,
  [IntPtr] $hwnd,
  [string] $rootIdentity
) {
  $role = RoleName $element
  $password = PasswordValue $element
  $actions = @(NativeActions $element $password $role)
  $record = [ordered]@{
    element_index = [string]$index
    depth = $depth
    role = $role
    actions = $actions
  }
  # A provider failure must never be mistaken for a complete selector walk.
  # Unknown role or missing RuntimeId is conservative evidence of that failure.
  if ($role -eq "Unknown" -or [string]::IsNullOrEmpty((ElementIdentity $element))) { $record.provider_error = $true }
  if (-not [string]::IsNullOrEmpty($parent)) { $record.parent_index = $parent }
  try {
    if ([bool]$element.Current.IsEnabled) { $record.enabled = $true } else { $record.enabled = $false }
  } catch { }
  if ($password) {
    $record.password = $true
  } else {
    try {
      $label = [string]$element.Current.Name
      if (-not [string]::IsNullOrEmpty($label)) { $record.label = $label }
    } catch { }
    if ($actions -contains "set_value") {
      $record.editable = $true
      try {
        $pattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
          $value = [string]([System.Windows.Automation.ValuePattern]$pattern).Current.Value
          if ($null -ne $value) { $record.value = $value }
        }
      } catch { }
    }
    try {
      if ([bool]$element.Current.HasKeyboardFocus) { $record.focused = $true }
    } catch { }
    $rect = Bounds $element
    if ($null -ne $rect) { $record.frame = $rect }
    $runtimeId = ElementIdentity $element
    if (-not [string]::IsNullOrEmpty($runtimeId)) { $record.runtime_id = $runtimeId }
    $token = TokenFor $processId $hwnd $rootIdentity (ElementIdentity $element) $role
    if ($null -ne $token) { $record.element_token = $token }
  }
  return [pscustomobject]$record
}

function WalkElements(
  [System.Windows.Automation.AutomationElement] $root,
  [int] $processId,
  [IntPtr] $hwnd,
  [int] $maxElements,
  [int] $maxDepth,
  [string] $rootIdentity
) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Generic.Queue[object]
  $queue.Enqueue([pscustomobject]@{ element = $root; depth = 0; parent = "" })
  $elements = New-Object System.Collections.Generic.List[object]
  $complete = $true
  $examined = 1
  while ($queue.Count -gt 0) {
    if ($elements.Count -ge $maxElements) { $complete = $false; break }
    $entry = $queue.Dequeue()
    $item = ElementRecord $entry.element $elements.Count $entry.depth $entry.parent $processId $hwnd $rootIdentity
    if ($item.provider_error -eq $true) { $complete = $false }
    [void]$elements.Add($item)
    $child = $null
    try { $child = $walker.GetFirstChild($entry.element) } catch { $complete = $false; $child = $null }
    while ($null -ne $child) {
      if ($examined -ge $maxElements) { $complete = $false; break }
      $examined++
      $owned = $false
      try { $owned = OwnedByTarget $child $hwnd } catch { $complete = $false }
      if ($owned) {
        if ($entry.depth -ge $maxDepth) {
          # Probe the first omitted owned descendant so bounded depth is never
          # reported as a complete UIA document.
          $complete = $false
          break
        } elseif ($queue.Count + $elements.Count -ge $maxElements) {
          $complete = $false
          break
        } else {
          $queue.Enqueue([pscustomobject]@{ element = $child; depth = $entry.depth + 1; parent = [string]($elements.Count - 1) })
        }
      }
      try { $child = $walker.GetNextSibling($child) } catch { $complete = $false; $child = $null }
    }
  }
  if ($queue.Count -gt 0) { $complete = $false }
  $elementArray = [object[]]$elements.ToArray()
  $contextToken = MaterialContextToken $processId $hwnd $rootIdentity $elementArray
  foreach ($item in $elementArray) {
    if ($item.password -ne $true) {
      $item | Add-Member -NotePropertyName approval_context_token -NotePropertyValue $contextToken
      if (-not [string]::IsNullOrEmpty([string]$item.element_token)) {
        $decoded = DecodeToken ([string]$item.element_token)
        $item.element_token = TokenFor $processId $hwnd $rootIdentity ([string]$decoded.element) ([string]$decoded.role) $contextToken
      }
    }
    if ($null -ne $item.PSObject.Properties["provider_error"]) { $item.PSObject.Properties.Remove("provider_error") }
  }
  return [pscustomobject]@{ elements = $elementArray; complete = $complete; approval_context_token = $contextToken }
}

function Observe([object] $request) {
  $processId = RequestPid $request
  $hwnd = RequestHwnd $request
  $maxElements = 512
  $maxDepth = 32
  if ($null -ne $request.max_elements) { $maxElements = [Math]::Min(512, [Math]::Max(1, [int]$request.max_elements)) }
  if ($null -ne $request.max_depth) { $maxDepth = [Math]::Min(32, [Math]::Max(1, [int]$request.max_depth)) }
  $selector = SelectorFor $request
  $root = RootFor $processId $hwnd
  $rootIdentity = ElementIdentity $root
  if ([string]::IsNullOrEmpty($rootIdentity)) { throw "native_uia_identity_unavailable" }
  $walk = WalkElements $root $processId $hwnd $maxElements $maxDepth $rootIdentity
  $returnedElements = @($walk.elements)
  $selectorMatchCount = $null
  $selectorTooMany = $false
  if ($null -ne $selector) {
    $matches = @($walk.elements | Where-Object { SelectorMatches $_ $selector })
    $selectorMatchCount = $matches.Count
    if ($matches.Count -gt $SelectorMatchLimit) {
      $selectorTooMany = $true
      $returnedElements = @($matches | Select-Object -First $SelectorMatchLimit)
    } else {
      $returnedElements = $matches
    }
  }
  $complete = [bool]$walk.complete
  # The runtime checks uniqueness against the complete candidate list.
  # Truncation, depth limits and provider errors leave completeness false.
  if ($selectorTooMany) { $complete = $false }
  $reply = [ordered]@{
    ok = $true
    pid = $processId
    window_id = $hwnd.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture)
    snapshot_id = [Guid]::NewGuid().ToString("N")
    root_identity = $rootIdentity
    elements = $returnedElements
    elements_complete = $complete
  }
  if ($null -ne $selector) {
    $reply.selector_match_count = $selectorMatchCount
    $reply.selector_bounded = $true
  }
  try {
    $title = [string]$root.Current.Name
    if (-not [string]::IsNullOrEmpty($title)) { $reply.window_title = $title }
  } catch { }
  $rect = Bounds $root
  if ($null -ne $rect) { $reply.window_bounds = $rect }
  return [pscustomobject]$reply
}

function Focus([object] $request) {
  $processId = RequestPid $request
  $hwnd = RequestHwnd $request
  $root = RootFor $processId $hwnd
  $rootIdentity = ElementIdentity $root
  if ([string]::IsNullOrEmpty($rootIdentity)) { throw "native_uia_identity_unavailable" }
  $reply = [ordered]@{
    ok = $true
    pid = $processId
    window_id = $hwnd.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture)
    root_identity = $rootIdentity
    focused = $false
    focused_within_target = $false
  }
  $focused = $null
  try { $focused = [System.Windows.Automation.AutomationElement]::FocusedElement } catch { $focused = $null }
  if ($null -eq $focused) { return [pscustomobject]$reply }
  try {
    if ([int]$focused.Current.ProcessId -ne $processId) { return [pscustomobject]$reply }
  } catch { return [pscustomobject]$reply }
  if (-not (FocusedWithinTarget $root $hwnd $focused $rootIdentity)) { return [pscustomobject]$reply }
  $runtimeId = ElementIdentity $focused
  if ([string]::IsNullOrEmpty($runtimeId)) { return [pscustomobject]$reply }
  $reply.focused = $true
  $reply.focused_within_target = $true
  $reply.focused_runtime_id = $runtimeId
  try {
    $reply.focused_role = RoleName $focused
    $focusedBounds = Bounds $focused
    if ($null -ne $focusedBounds) { $reply.focused_bounds = $focusedBounds }
  } catch { }
  return [pscustomobject]$reply
}

function FocusedWithinTarget(
  [System.Windows.Automation.AutomationElement] $root,
  [IntPtr] $hwnd,
  [System.Windows.Automation.AutomationElement] $focused,
  [string] $rootIdentity
) {
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $current = $focused
  for ($depth = 0; $depth -lt 64 -and $null -ne $current; $depth += 1) {
    try {
      $native = [Int64]$current.Current.NativeWindowHandle
      if ($native -ne 0 -and [NativeWindowScope]::GetAncestor([IntPtr]$native, 2).ToInt64() -eq $hwnd.ToInt64()) { return $true }
      if ((ElementIdentity $current) -eq $rootIdentity) { return $true }
      $current = $walker.GetParent($current)
    } catch { return $false }
  }
  return $false
}

function DecodeToken([string] $token) {
  if ($token.Length -lt 6 -or $token.Length -gt 4096 -or -not $token.StartsWith("uia1.", [StringComparison]::Ordinal)) { throw "native_uia_token_invalid" }
  try {
    $encoded = $token.Substring(5).Replace("-", "+").Replace("_", "/")
    while (($encoded.Length % 4) -ne 0) { $encoded += "=" }
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
    return $json | ConvertFrom-Json
  } catch { throw "native_uia_token_invalid" }
}

function FindByIdentity(
  [System.Windows.Automation.AutomationElement] $root,
  [IntPtr] $hwnd,
  [string] $identity,
  [int] $maxElements,
  [int] $maxDepth
) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Generic.Queue[object]
  $queue.Enqueue([pscustomobject]@{ element = $root; depth = 0 })
  $count = 0
  $examined = 1
  while ($queue.Count -gt 0 -and $count -lt $maxElements) {
    $entry = $queue.Dequeue()
    $count++
    if (-not (OwnedByTarget $entry.element $hwnd)) { continue }
    if ((ElementIdentity $entry.element) -eq $identity) { return $entry.element }
    if ($entry.depth -ge $maxDepth) { continue }
    $child = $null
    try { $child = $walker.GetFirstChild($entry.element) } catch { $child = $null }
    while ($null -ne $child) {
      if ($examined -ge $maxElements) { break }
      $examined++
      if (OwnedByTarget $child $hwnd) {
        $queue.Enqueue([pscustomobject]@{ element = $child; depth = $entry.depth + 1 })
      }
      try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
    }
  }
  return $null
}

function PhysicalDispatchCheck(
  [int] $processId,
  [IntPtr] $hwnd,
  [System.Windows.Automation.AutomationElement] $element
) {
  if (-not [NativeWindowScope]::IsWindow($hwnd)) { return "native_uia_target_unavailable" }
  if (-not [NativeWindowScope]::IsWindowVisible($hwnd)) { return "native_uia_target_not_visible" }
  if ([NativeWindowScope]::IsIconic($hwnd)) { return "native_uia_target_minimized" }
  if ([NativeWindowScope]::GetAncestor($hwnd, 2).ToInt64() -ne $hwnd.ToInt64()) { return "native_uia_target_not_top_level" }
  $targetRect = New-Object 'NativeWindowScope+NativeWindowRect'
  if (-not [NativeWindowScope]::GetWindowRect($hwnd, [ref]$targetRect)) { return "native_uia_target_unavailable" }
  if ($targetRect.Right -le $targetRect.Left -or $targetRect.Bottom -le $targetRect.Top) { return "native_uia_target_not_visible" }
  try {
    $current = $element.Current
    if ([int]$current.ProcessId -ne $processId) { return "native_uia_window_owner_changed" }
    if (-not [bool]$current.IsEnabled) { return "control_disabled" }
    if ([bool]$element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)) { return "native_uia_control_occluded" }
    $bounds = $current.BoundingRectangle
    if ($bounds.Width -le 0 -or $bounds.Height -le 0) { return "native_uia_control_unbounded" }
    # UIA reports device-independent coordinates while user32's HWND and
    # WindowFromPoint use physical pixels. Word is commonly at 150% scaling,
    # so project the UIA center through the exact enrolled root bounds instead
    # of comparing the two coordinate spaces directly.
    $uiX = [double]$bounds.X + ($bounds.Width / 2.0)
    $uiY = [double]$bounds.Y + ($bounds.Height / 2.0)
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $rootBounds = $root.Current.BoundingRectangle
    if ($rootBounds.Width -le 0 -or $rootBounds.Height -le 0) { return "native_uia_physical_evidence_unavailable" }
    $scaleX = $targetRect.Width / $rootBounds.Width
    $scaleY = $targetRect.Height / $rootBounds.Height
    if ($scaleX -le 0 -or $scaleY -le 0 -or $scaleX -gt 10 -or $scaleY -gt 10) { return "native_uia_physical_evidence_unavailable" }
    $x = [int][Math]::Round($targetRect.Left + (($uiX - $rootBounds.X) * $scaleX))
    $y = [int][Math]::Round($targetRect.Top + (($uiY - $rootBounds.Y) * $scaleY))
    if ($x -lt $targetRect.Left -or $x -ge $targetRect.Right -or $y -lt $targetRect.Top -or $y -ge $targetRect.Bottom) {
      return "native_uia_control_outside_target"
    }
    $point = New-Object 'NativeWindowScope+NativeWindowPoint'
    $point.X = $x
    $point.Y = $y
    $hit = [NativeWindowScope]::WindowFromPoint($point)
    if ($hit.ToInt64() -eq 0) { return "native_uia_target_occluded" }
    if ([NativeWindowScope]::GetAncestor($hit, 2).ToInt64() -ne $hwnd.ToInt64()) { return "native_uia_target_occluded" }

    # WindowFromPoint catches foreign top-level windows. UIA FromPoint also
    # catches a sibling control from the same HWND covering this target.
    $uiPoint = [System.Windows.Point]::new($uiX, $uiY)
    $pointElement = [System.Windows.Automation.AutomationElement]::FromPoint($uiPoint)
    if ($null -eq $pointElement) { return "native_uia_control_occluded" }
    try {
      if ([bool]$pointElement.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)) {
        return "native_uia_control_occluded"
      }
    } catch { return "native_uia_physical_evidence_unavailable" }
    $targetIdentity = ElementIdentity $element
    $pointIdentity = ElementIdentity $pointElement
    $sameElement = -not [string]::IsNullOrEmpty($targetIdentity) -and $targetIdentity -eq $pointIdentity
    if (-not $sameElement) {
      $rawWalker = [System.Windows.Automation.TreeWalker]::RawViewWalker
      $ancestor = $pointElement
      $descendant = $false
      for ($depth = 0; $depth -lt 32 -and $null -ne $ancestor; $depth += 1) {
        if ((ElementIdentity $ancestor) -eq $targetIdentity) { $descendant = $true; break }
        try { $ancestor = $rawWalker.GetParent($ancestor) } catch { return "native_uia_physical_evidence_unavailable" }
      }
      if (-not $descendant) { return "native_uia_control_occluded" }
    }
  } catch {
    return "native_uia_physical_evidence_unavailable"
  }
  return $null
}

function Dispatch([object] $request) {
  $processId = RequestPid $request
  $hwnd = RequestHwnd $request
  $token = RequestString $request "token"
  $decoded = DecodeToken $token
  if ([int]$decoded.pid -ne $processId -or [string]$decoded.hwnd -ne $hwnd.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture)) {
    return ErrorReply "native_uia_window_identity_mismatch"
  }
  $root = RootFor $processId $hwnd
  $rootIdentity = ElementIdentity $root
  if ([string]::IsNullOrEmpty($rootIdentity)) { return ErrorReply "native_uia_identity_unavailable" }
  if ([string]$decoded.root -ne $rootIdentity) { return ErrorReply "stale_uia_identity" }
  $maxElements = 512
  $maxDepth = 32
  if ($null -ne $request.max_elements) { $maxElements = [Math]::Min(512, [Math]::Max(1, [int]$request.max_elements)) }
  if ($null -ne $request.max_depth) { $maxDepth = [Math]::Min(32, [Math]::Max(1, [int]$request.max_depth)) }
  $freshWalk = WalkElements $root $processId $hwnd $maxElements $maxDepth $rootIdentity
  if (-not $freshWalk.complete) { return ErrorReply "native_uia_observation_incomplete" }
  if ([string]$decoded.material -ne [string]$freshWalk.approval_context_token) { return ErrorReply "stale_uia_material_context" }
  $element = FindByIdentity $root $hwnd ([string]$decoded.element) $maxElements $maxDepth
  if ($null -eq $element) { return ErrorReply "stale_uia_identity" }
  if ((RoleName $element) -ne [string]$decoded.role) { return ErrorReply "stale_uia_identity" }
  if (-not [bool]$element.Current.IsEnabled) { return ErrorReply "control_disabled" }
  if (PasswordValue $element) { return ErrorReply "sensitive_control_not_writable" }
  $action = [string]$request.action
  if ($action -eq "click") {
    $pattern = $null
    $invoke = $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)
    if (-not $invoke) {
      $pattern = $null
      $select = $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)
      if (-not $select) { return ErrorReply "native_uia_pattern_unavailable" }
    }
    $physicalError = PhysicalDispatchCheck $processId $hwnd $element
    if ($null -ne $physicalError) { return ErrorReply $physicalError }
    if ($invoke) {
      try { ([System.Windows.Automation.InvokePattern]$pattern).Invoke() } catch { return [ordered]@{ ok = $false; status = "unknown"; code = "native_uia_invoke_unknown" } }
    } else {
      try { ([System.Windows.Automation.SelectionItemPattern]$pattern).Select() } catch { return [ordered]@{ ok = $false; status = "unknown"; code = "native_uia_select_unknown" } }
    }
    return [ordered]@{ ok = $true; status = "dispatched" }
  }
  if ($action -eq "setValue") {
    $value = [string]$request.value
    if ($value.Length -gt 16384 -or $value -match "[\x00-\x1f\x7f-\x9f\u2028\u2029]") { return ErrorReply "invalid_text" }
    $pattern = $null
    if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { return ErrorReply "native_uia_pattern_unavailable" }
    $physicalError = PhysicalDispatchCheck $processId $hwnd $element
    if ($null -ne $physicalError) { return ErrorReply $physicalError }
    try { ([System.Windows.Automation.ValuePattern]$pattern).SetValue($value) } catch { return [ordered]@{ ok = $false; status = "unknown"; code = "native_uia_set_value_unknown" } }
    return [ordered]@{ ok = $true; status = "dispatched" }
  }
  return ErrorReply "native_uia_action_not_supported"
}

$reply = $null
try {
  $raw = [Console]::In.ReadToEnd()
  if ($raw.Length -gt 1048576) {
    $reply = ErrorReply "native_uia_input_limit"
  } else {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeWindowScope {
  [StructLayout(LayoutKind.Sequential)]
  public struct NativeWindowPoint { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct NativeWindowRect { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hwnd, out NativeWindowRect rect);
  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(NativeWindowPoint point);
  [DllImport("user32.dll")]
  public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int index);
}
"@
    $request = $raw | ConvertFrom-Json
    if ($null -eq $request -or [string]::IsNullOrEmpty([string]$request.op)) {
      $reply = ErrorReply "native_uia_invalid_request"
    } elseif ([string]$request.op -eq "observe") {
      $reply = Observe $request
    } elseif ([string]$request.op -eq "focus") {
      $reply = Focus $request
    } elseif ([string]$request.op -eq "desktop_image") {
      $reply = CaptureDesktop $request
    } elseif ([string]$request.op -eq "dispatch") {
      $reply = Dispatch $request
    } else {
      $reply = ErrorReply "native_uia_unknown_operation"
    }
  }
} catch {
  $code = [string]$_.Exception.Message
  if ([string]::IsNullOrEmpty($code) -or $code.Length -gt 96 -or $code -notmatch "^[a-z0-9_]+$") { $code = "native_uia_failed" }
  $reply = ErrorReply $code
}
Reply $reply
