$ErrorActionPreference = "Stop"
$SelectorMatchLimit = 8
$script:PointerLinkAttributeChecked = $false
$script:PointerLinkAttributeValue = $null

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
  # The parent and pointer inspector both use primary-display physical pixels.
  $prior = [NativeWindowScope]::SetThreadDpiAwarenessContext([IntPtr](-4))
  if ($prior -eq [IntPtr]::Zero) { return ErrorReply "desktop_capture_dpi_unavailable" }
  $pixels = $null
  $reader = $null
  $stream = $null
  try {
    $pixelWidth = [NativeWindowScope]::GetSystemMetrics(0)
    $pixelHeight = [NativeWindowScope]::GetSystemMetrics(1)
    if ($pixelWidth -ne $width -or $pixelHeight -ne $height) {
      return ErrorReply "desktop_capture_geometry_changed"
    }
    $pixels = [Drawing.Bitmap]::new($pixelWidth, $pixelHeight)
    $reader = [Drawing.Graphics]::FromImage($pixels)
    $reader.CopyFromScreen(0, 0, 0, 0, [Drawing.Size]::new($pixelWidth, $pixelHeight))
    $stream = [IO.MemoryStream]::new()
    $pixels.Save($stream, [Drawing.Imaging.ImageFormat]::Jpeg)
    return [ordered]@{ ok = $true; width = $width; height = $height; data = [Convert]::ToBase64String($stream.ToArray()) }
  } finally {
    if ($stream) { $stream.Dispose() }
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

function GridNumber([object] $value) {
  if ($null -eq $value -or $value -is [bool]) { throw "native_grid_request_invalid" }
  $number = 0.0
  if (-not [double]::TryParse([string]$value, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
    throw "native_grid_request_invalid"
  }
  if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { throw "native_grid_request_invalid" }
  return $number
}

function GridPoint([object] $request) {
  if ($null -eq $request.point) { throw "native_grid_request_invalid" }
  $xValue = GridNumber $request.point.x
  $yValue = GridNumber $request.point.y
  if ($xValue -lt [int]::MinValue -or $xValue -gt [int]::MaxValue -or $yValue -lt [int]::MinValue -or $yValue -gt [int]::MaxValue) {
    throw "native_grid_request_invalid"
  }
  return [pscustomobject]@{
    x = [int][Math]::Round($xValue, [MidpointRounding]::AwayFromZero)
    y = [int][Math]::Round($yValue, [MidpointRounding]::AwayFromZero)
  }
}

function GridRect([object] $value) {
  if ($null -eq $value) { throw "native_grid_request_invalid" }
  $x = GridNumber $value.x
  $y = GridNumber $value.y
  $width = GridNumber $value.width
  $height = GridNumber $value.height
  if ($width -le 0 -or $height -le 0 -or $width -gt 1000000 -or $height -gt 1000000) { throw "native_grid_request_invalid" }
  return [pscustomobject]@{ x = $x; y = $y; width = $width; height = $height }
}

function GridItemRequest([object] $value, [bool] $requireRuntimeId) {
  if ($null -eq $value) { throw "native_grid_request_invalid" }
  $role = [string]$value.role
  $normalizedRole = NormalizeGridRole $role
  if ($normalizedRole -notin @("dataitem", "cell", "gridcell")) { throw "native_grid_item_role_invalid" }
  $name = $null
  if ($null -ne $value.PSObject.Properties["name"]) {
    $name = [string]$value.name
    if ($name.Length -gt 4096) { throw "native_grid_request_invalid" }
  }
  $runtimeId = ""
  if ($null -ne $value.PSObject.Properties["runtime_id"]) { $runtimeId = [string]$value.runtime_id }
  elseif ($null -ne $value.PSObject.Properties["runtimeId"]) { $runtimeId = [string]$value.runtimeId }
  if ($runtimeId.Length -gt 1024 -or ($requireRuntimeId -and $runtimeId.Length -eq 0)) { throw "native_grid_request_invalid" }
  return [pscustomobject]@{
    role = $role
    normalized_role = $normalizedRole
    name = $name
    runtime_id = $runtimeId
    bounds = (GridRect $value.bounds)
  }
}

function NormalizeGridRole([string] $role) {
  if ($null -eq $role) { return "" }
  $normalized = $role.Trim()
  if ($normalized.StartsWith("ControlType.", [StringComparison]::OrdinalIgnoreCase)) { $normalized = $normalized.Substring(12) }
  return ($normalized.ToLowerInvariant() -replace "[ _-]", "")
}

function GridRoleMatches([string] $actual, [object] $requested) {
  return (NormalizeGridRole $actual) -ceq [string]$requested.normalized_role
}

function GridPhysicalPoint([object] $point) {
  $native = New-Object 'NativeWindowScope+NativeWindowPoint'
  $native.X = [int]$point.x
  $native.Y = [int]$point.y
  $hit = [NativeWindowScope]::WindowFromPoint($native)
  if ($hit.ToInt64() -eq 0) { throw "native_grid_point_unavailable" }
  return $hit
}

function GridTarget([int] $processId, [IntPtr] $hwnd, [object] $point, [bool] $requireForeground = $true) {
  if (-not [NativeWindowScope]::IsWindow($hwnd)) { throw "native_grid_target_unavailable" }
  if (-not [NativeWindowScope]::IsWindowVisible($hwnd) -or [NativeWindowScope]::IsIconic($hwnd)) { throw "native_grid_target_not_visible" }
  if ([NativeWindowScope]::GetAncestor($hwnd, 2).ToInt64() -ne $hwnd.ToInt64()) { throw "native_grid_target_not_top_level" }
  $root = RootFor $processId $hwnd
  $rootIdentity = ElementIdentity $root
  if ([string]::IsNullOrEmpty($rootIdentity)) { throw "native_grid_identity_unavailable" }
  $targetRect = New-Object 'NativeWindowScope+NativeWindowRect'
  if (-not [NativeWindowScope]::GetWindowRect($hwnd, [ref]$targetRect)) { throw "native_grid_target_unavailable" }
  $x = [int]$point.x
  $y = [int]$point.y
  if (($targetRect.Right -le $targetRect.Left -or $targetRect.Bottom -le $targetRect.Top -or
    $x -lt $targetRect.Left -or $x -ge $targetRect.Right -or $y -lt $targetRect.Top -or $y -ge $targetRect.Bottom)) {
    throw "native_grid_point_outside_target"
  }
  if ($requireForeground) {
    $foreground = [NativeWindowScope]::GetForegroundWindow()
    if ($foreground.ToInt64() -ne $hwnd.ToInt64()) { throw "native_grid_foreground_changed" }
  }
  $hitHwnd = GridPhysicalPoint $point
  if ([NativeWindowScope]::GetAncestor($hitHwnd, 2).ToInt64() -ne $hwnd.ToInt64()) { throw "native_grid_target_occluded" }
  $uiRect = $root.Current.BoundingRectangle
  if ($uiRect.Width -le 0 -or $uiRect.Height -le 0) { throw "native_grid_physical_evidence_unavailable" }
  $scaleX = ($targetRect.Right - $targetRect.Left) / [double]$uiRect.Width
  $scaleY = ($targetRect.Bottom - $targetRect.Top) / [double]$uiRect.Height
  if ($scaleX -le 0 -or $scaleY -le 0 -or $scaleX -gt 10 -or $scaleY -gt 10) { throw "native_grid_physical_evidence_unavailable" }
  return [pscustomobject]@{
    pid = $processId
    hwnd = $hwnd
    root = $root
    root_identity = $rootIdentity
    target_rect = $targetRect
    ui_rect = $uiRect
    scale_x = $scaleX
    scale_y = $scaleY
    point = $point
    hit_hwnd = $hitHwnd
  }
}

function GridPointInRect([double] $x, [double] $y, [object] $rect) {
  return $x -ge [double]$rect.x -and $y -ge [double]$rect.y -and $x -lt ([double]$rect.x + [double]$rect.width) -and $y -lt ([double]$rect.y + [double]$rect.height)
}

function GridRectsMatch([object] $left, [object] $right, [double] $tolerance = 2.0) {
  if ($null -eq $left -or $null -eq $right) { return $false }
  return ([Math]::Abs([double]$left.x - [double]$right.x) -le $tolerance -and
    [Math]::Abs([double]$left.y - [double]$right.y) -le $tolerance -and
    [Math]::Abs([double]$left.width - [double]$right.width) -le ($tolerance * 2) -and
    [Math]::Abs([double]$left.height - [double]$right.height) -le ($tolerance * 2))
}

function GridUiPoint([object] $context) {
  $targetRect = $context.target_rect
  $uiRect = $context.ui_rect
  return [System.Windows.Point]::new(
    [double]$uiRect.X + (([double]$context.point.x - [double]$targetRect.Left) / [double]$context.scale_x),
    [double]$uiRect.Y + (([double]$context.point.y - [double]$targetRect.Top) / [double]$context.scale_y)
  )
}

function GridPhysicalBounds([object] $context, [System.Windows.Automation.AutomationElement] $element) {
  try {
    $rect = $element.Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0) { return $null }
    $x = [double]$context.target_rect.Left + (([double]$rect.X - [double]$context.ui_rect.X) * [double]$context.scale_x)
    $y = [double]$context.target_rect.Top + (([double]$rect.Y - [double]$context.ui_rect.Y) * [double]$context.scale_y)
    return [pscustomobject]@{
      x = $x
      y = $y
      width = [double]$rect.Width * [double]$context.scale_x
      height = [double]$rect.Height * [double]$context.scale_y
    }
  } catch {
    return $null
  }
}

function PointerIdentity([System.Windows.Automation.AutomationElement] $element, [object] $context) {
  if ($null -eq $element -or -not (GridElementIsOwned $element $context.pid $context.hwnd)) { return $null }
  $runtimeId = ElementIdentity $element
  $role = RoleName $element
  $bounds = GridPhysicalBounds $context $element
  $inside = $null -ne $bounds -and (GridPointInRect ([double]$context.point.x) ([double]$context.point.y) $bounds)
  if ([string]::IsNullOrEmpty($runtimeId) -or [string]::IsNullOrEmpty($role) -or $null -eq $bounds -or -not $inside) { return $null }
  $name = ""
  try { $name = [string]$element.Current.Name } catch { }
  $result = [ordered]@{ runtime_id = $runtimeId; role = $role; bounds = $bounds }
  if (-not [string]::IsNullOrEmpty($name)) { $result.name = $name }
  return [pscustomobject]$result
}

function PointerTextPattern([System.Windows.Automation.AutomationElement] $element) {
  $pattern = $null
  try {
    if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { return $null }
    return [System.Windows.Automation.TextPattern]$pattern
  } catch { return $null }
}

function PointerPlainTextRole([string] $role) {
  return (NormalizeGridRole $role) -in @("edit", "custom", "document", "text")
}

function PointerActionable([System.Windows.Automation.AutomationElement] $element) {
  if ($null -eq $element) { return $true }
  $normalized = NormalizeGridRole (RoleName $element)
  if ($normalized -in @("hyperlink", "link", "button", "checkbox", "radiobutton", "combobox", "listitem", "menuitem", "tab", "treeitem", "slider", "scrollbar", "spinner", "splitbutton", "image")) { return $true }
  $invoke = Supports $element ([System.Windows.Automation.InvokePattern]::Pattern)
  $selection = Supports $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  $toggle = Supports $element ([System.Windows.Automation.TogglePattern]::Pattern)
  $expand = Supports $element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  return $invoke -or $selection -or $toggle -or $expand
}

function PointerRangeIsPlainText(
  [System.Windows.Automation.TextPattern] $pattern,
  [System.Windows.Point] $point,
  [object] $context,
  [string] $allowedEnclosingRuntimeId
) {
  try {
    $range = $pattern.RangeFromPoint($point)
    if ($null -eq $range) { return $false }
    return -not (PointerRangeHasLink $range $context $allowedEnclosingRuntimeId)
  } catch { return $false }
}

function PointerLinkAttribute() {
  if ($script:PointerLinkAttributeChecked) { return $script:PointerLinkAttributeValue }
  $script:PointerLinkAttributeChecked = $true
  try {
    $flags = [System.Reflection.BindingFlags]::Public -bor [System.Reflection.BindingFlags]::Static
    foreach ($member in [System.Windows.Automation.TextPattern].GetMember("LinkAttribute", $flags)) {
      if ($member -is [System.Reflection.PropertyInfo]) {
        $script:PointerLinkAttributeValue = $member.GetValue($null, $null)
        break
      }
      if ($member -is [System.Reflection.FieldInfo]) {
        $script:PointerLinkAttributeValue = $member.GetValue($null)
        break
      }
    }
  } catch {
    $script:PointerLinkAttributeValue = $null
  }
  return $script:PointerLinkAttributeValue
}

function PointerRangeHasLink(
  [System.Windows.Automation.Text.TextPatternRange] $range,
  [object] $context,
  [string] $allowedEnclosingRuntimeId
) {
  try {
    $enclosing = $range.GetEnclosingElement()
    if ($null -eq $enclosing -or -not (GridElementIsOwned $enclosing $context.pid $context.hwnd)) { return $true }
    $enclosingRuntimeId = ElementIdentity $enclosing
    $enclosingRole = NormalizeGridRole (RoleName $enclosing)
    if ((PointerActionable $enclosing) -and ($enclosingRuntimeId -ne $allowedEnclosingRuntimeId)) { return $true }
    $linkAttribute = PointerLinkAttribute
    if ($null -ne $linkAttribute) {
      try {
        $link = $range.GetAttributeValue($linkAttribute)
        if ($null -ne $link -and $link -ne [System.Windows.Automation.AutomationElement]::NotSupported) { return $true }
      } catch {
        # The property exists but this provider could not answer it; fail
        # closed for this proof rather than treating an unknown link as text.
        return $true
      }
    }
    if ($enclosingRole -in @("hyperlink", "link")) { return $true }
    foreach ($child in @($range.GetChildren())) {
      if ($null -eq $child) { continue }
      $owned = GridElementIsOwned $child $context.pid $context.hwnd
      if (-not $owned) { return $true }
      $role = NormalizeGridRole (RoleName $child)
      $childRuntimeId = ElementIdentity $child
      if ($childRuntimeId -eq $allowedEnclosingRuntimeId) { continue }
      if ($role -in @("hyperlink", "link")) { return $true }
      if ((PointerActionable $child) -and $role -notin @("edit", "text", "document")) { return $true }
    }
    return $false
  } catch { return $true }
}

function PointerPathHasLink(
  [System.Collections.Generic.List[object]] $path,
  [int] $lastIndex,
  [System.Windows.Point] $uiPoint,
  [object] $context,
  [string] $allowedEnclosingRuntimeId
) {
  for ($index = 0; $index -le $lastIndex; $index += 1) {
    $pattern = PointerTextPattern $path[$index]
    if ($null -eq $pattern) { continue }
    try { $range = $pattern.RangeFromPoint($uiPoint) } catch { return $true }
    if ($null -eq $range -or (PointerRangeHasLink $range $context $allowedEnclosingRuntimeId)) { return $true }
  }
  return $false
}

function PointerAncestorPath([System.Windows.Automation.AutomationElement] $hit, [object] $context) {
  $path = New-Object System.Collections.Generic.List[object]
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $current = $hit
  for ($depth = 0; $depth -lt 32 -and $null -ne $current; $depth += 1) {
    if (-not (GridElementIsOwned $current $context.pid $context.hwnd)) { return $null }
    [void]$path.Add($current)
    if ((ElementIdentity $current) -eq [string]$context.root_identity) { return $path }
    try { $current = $walker.GetParent($current) } catch { return $null }
  }
  return $null
}

function PointerGridSurface([System.Windows.Automation.AutomationElement] $hit, [object] $context, [System.Windows.Point] $uiPoint) {
  $hitRole = NormalizeGridRole (RoleName $hit)
  if ((PointerActionable $hit) -and ($hitRole -notin @("dataitem", "cell", "gridcell", "edit", "text", "document"))) { return $null }
  $path = PointerAncestorPath $hit $context
  if ($null -eq $path) { return $null }
  for ($pathIndex = 0; $pathIndex -lt $path.Count; $pathIndex += 1) {
    $element = $path[$pathIndex]
    if (PasswordValue $element) { return $null }
    $role = NormalizeGridRole (RoleName $element)
    if ($role -notin @("dataitem", "cell", "gridcell")) { continue }
    # A hyperlink/button between a passive text leaf and the cell would make
    # a coordinate click a command, even when the cell itself exposes the
    # ordinary Invoke/SelectionItem patterns. Only the matched grid item may
    # carry those patterns; all earlier ancestors must remain passive.
    $ancestorActionable = $false
    for ($ancestorIndex = 0; $ancestorIndex -lt $pathIndex; $ancestorIndex += 1) {
      if (-not (PointerActionable $path[$ancestorIndex])) { continue }
      $ancestorRole = NormalizeGridRole (RoleName $path[$ancestorIndex])
      if ($ancestorRole -notin @("edit", "text", "document")) { $ancestorActionable = $true; break }
    }
    $gridItemPattern = $null
    $selectionPattern = $null
    try {
      $hasGridItem = $element.TryGetCurrentPattern([System.Windows.Automation.GridItemPattern]::Pattern, [ref]$gridItemPattern)
      $hasSelection = $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionPattern)
      if (-not $hasGridItem -or -not $hasSelection) { continue }
      $grid = ([System.Windows.Automation.GridItemPattern]$gridItemPattern).Current.ContainingGrid
      if ($null -eq $grid -or -not (GridElementIsOwned $grid $context.pid $context.hwnd)) { continue }
      [void](GridPatternFor $grid)
      [void](GridRawPath $grid $context)
      $bounds = GridPhysicalBounds $context $element
      if ($null -eq $bounds -or -not (GridPointInRect ([double]$context.point.x) ([double]$context.point.y) $bounds)) { continue }
      $primary = PointerIdentity $element $context
      if ($null -eq $primary) { continue }
      if ($ancestorActionable -or (PointerPathHasLink $path $pathIndex $uiPoint $context $primary.runtime_id)) { continue }
      $leaf = PointerIdentity $hit $context
      $container = PointerIdentity $grid $context
      if ($null -eq $leaf -or $null -eq $container) { continue }
      return [ordered]@{ kind = "grid"; primary = $primary; leaf = $leaf; container = $container }
    } catch { continue }
  }
  return $null
}

function PointerTextSurface([System.Windows.Automation.AutomationElement] $hit, [object] $context, [System.Windows.Point] $uiPoint) {
  $hitRole = NormalizeGridRole (RoleName $hit)
  if ($hitRole -notin @("edit", "custom", "document", "text")) { return $null }
  $path = PointerAncestorPath $hit $context
  if ($null -eq $path) { return $null }
  $document = $null
  $surface = $null
  $surfacePattern = $null
  foreach ($element in $path) {
    if (PasswordValue $element) { return $null }
    $role = NormalizeGridRole (RoleName $element)
    if ($role -eq "pane") { continue }
    $pattern = PointerTextPattern $element
    if ($null -eq $pattern) { continue }
    if ($null -eq $surface -and $role -in @("edit", "custom", "document", "text")) {
      $surface = $element
      $surfacePattern = $pattern
    }
    if ($role -eq "document" -and $null -eq $document) { $document = $element }
  }
  if ($null -eq $surface -or $null -eq $surfacePattern) { return $null }
  $surfaceRuntimeId = ElementIdentity $surface
  if ([string]::IsNullOrEmpty($surfaceRuntimeId)) { return $null }
  foreach ($element in $path) {
    if (PasswordValue $element) { return $null }
    if (-not (PointerActionable $element)) { continue }
    if ((ElementIdentity $element) -ne $surfaceRuntimeId) { return $null }
  }
  if (-not (PointerRangeIsPlainText $surfacePattern $uiPoint $context $surfaceRuntimeId)) { return $null }
  $primary = PointerIdentity $surface $context
  $leaf = PointerIdentity $hit $context
  $container = $null
  if ($null -ne $document) { $container = PointerIdentity $document $context }
  if ($null -eq $primary -or $null -eq $leaf -or ($null -ne $document -and $null -eq $container)) { return $null }
  $result = [ordered]@{ kind = "text"; primary = $primary; leaf = $leaf }
  if ($null -ne $container) { $result.container = $container }
  return $result
}

function PointerSurfaceRead([object] $request) {
  $processId = RequestPid $request
  $hwnd = RequestHwnd $request
  $point = GridPoint $request
  $prior = [IntPtr]::Zero
  try {
    $prior = [NativeWindowScope]::SetThreadDpiAwarenessContext([IntPtr](-4))
    if ($prior -eq [IntPtr]::Zero) { return ErrorReply "native_pointer_surface_dpi_unavailable" }
    $context = GridTarget $processId $hwnd $point $false
    [uint32]$hitOwner = 0
    if ([NativeWindowScope]::GetWindowThreadProcessId($context.hit_hwnd, [ref]$hitOwner) -eq 0 -or $hitOwner -ne [uint32]$processId) {
      return ErrorReply "native_pointer_surface_owner_changed"
    }
    $uiPoint = GridUiPoint $context
    $hit = [System.Windows.Automation.AutomationElement]::FromPoint($uiPoint)
    $hitOwned = $null -ne $hit -and (GridElementIsOwned $hit $processId $hwnd)
    if (-not $hitOwned) { return ErrorReply "native_pointer_surface_unavailable" }
    $surface = PointerGridSurface $hit $context $uiPoint
    if ($null -eq $surface) { $surface = PointerTextSurface $hit $context $uiPoint }
    if ($null -eq $surface) { return ErrorReply "native_pointer_surface_unverified" }
    $reply = [ordered]@{
      ok = $true; pid = $processId; window_id = $hwnd.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture)
      kind = $surface.kind; primary = $surface.primary; leaf = $surface.leaf
    }
    if ($surface.Contains("container")) { $reply.container = $surface.container }
    return $reply
  } finally {
    if ($prior -ne [IntPtr]::Zero) { [void][NativeWindowScope]::SetThreadDpiAwarenessContext($prior) }
  }
}

function GridElementIsOwned([System.Windows.Automation.AutomationElement] $element, [int] $processId, [IntPtr] $hwnd) {
  try {
    if ([int]$element.Current.ProcessId -ne $processId) { return $false }
    $native = [Int64]$element.Current.NativeWindowHandle
    if ($native -eq 0) { return $true }
    return [NativeWindowScope]::GetAncestor([IntPtr]$native, 2).ToInt64() -eq $hwnd.ToInt64()
  } catch {
    return $false
  }
}

function GridRawPath([System.Windows.Automation.AutomationElement] $grid, [object] $context) {
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $reverse = New-Object System.Collections.Generic.List[string]
  $current = $grid
  $reachedRoot = $false
  for ($depth = 0; $depth -lt 32 -and $null -ne $current; $depth += 1) {
    if (-not (GridElementIsOwned $current $context.pid $context.hwnd)) { throw "native_grid_owner_changed" }
    $identity = ElementIdentity $current
    if ([string]::IsNullOrEmpty($identity)) { throw "native_grid_identity_unavailable" }
    [void]$reverse.Add($identity)
    if ($identity -eq [string]$context.root_identity) { $reachedRoot = $true; break }
    try { $current = $walker.GetParent($current) } catch { throw "native_grid_path_unavailable" }
  }
  if (-not $reachedRoot) { throw "native_grid_outside_target" }
  $path = New-Object System.Collections.Generic.List[string]
  for ($index = $reverse.Count - 1; $index -ge 0; $index -= 1) { [void]$path.Add($reverse[$index]) }
  if ($path.Count -lt 2 -or $path.Count -gt 32) { throw "native_grid_path_unavailable" }
  return [object[]]$path.ToArray()
}

function GridChildByIdentity(
  [System.Windows.Automation.AutomationElement] $parent,
  [string] $identity,
  [object] $context
) {
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $matches = New-Object System.Collections.Generic.List[object]
  $child = $null
  try { $child = $walker.GetFirstChild($parent) } catch { throw "native_grid_path_unavailable" }
  $examined = 0
  while ($null -ne $child) {
    $examined++
    if ($examined -gt 96) { throw "native_grid_path_unbounded" }
    if (GridElementIsOwned $child $context.pid $context.hwnd) {
      if ((ElementIdentity $child) -eq $identity) { [void]$matches.Add($child) }
    }
    try { $child = $walker.GetNextSibling($child) } catch { throw "native_grid_path_unavailable" }
  }
  if ($matches.Count -ne 1) { throw "native_grid_path_unavailable" }
  return $matches[0]
}

function GridFindAnchoredGrid([object] $anchor, [object] $context) {
  $pathValue = $anchor.grid_path
  if ($null -eq $pathValue -or $pathValue -isnot [array] -or $pathValue.Count -lt 2 -or $pathValue.Count -gt 32) {
    throw "native_grid_anchor_invalid"
  }
  $path = @($pathValue | ForEach-Object { [string]$_ })
  if ($path[0] -ne [string]$context.root_identity -or $path[$path.Count - 1] -ne [string]$anchor.grid_runtime_id) {
    throw "native_grid_anchor_mismatch"
  }
  foreach ($identity in $path) {
    if ([string]::IsNullOrEmpty($identity) -or $identity.Length -gt 1024) { throw "native_grid_anchor_invalid" }
  }
  $current = $context.root
  for ($index = 1; $index -lt $path.Count; $index += 1) {
    $current = GridChildByIdentity $current $path[$index] $context
  }
  if ((ElementIdentity $current) -ne [string]$anchor.grid_runtime_id) { throw "native_grid_anchor_mismatch" }
  return $current
}

function GridItemNamesMatch([System.Windows.Automation.AutomationElement] $element, [object] $requested) {
  if ($null -ne $requested.name) {
    try { return [string]$element.Current.Name -ceq [string]$requested.name } catch { return $false }
  }
  return $true
}

function GridItemMatches(
  [System.Windows.Automation.AutomationElement] $element,
  [object] $requested,
  [object] $context
) {
  if ($null -eq $element -or -not (GridElementIsOwned $element $context.pid $context.hwnd)) { return $false }
  if (-not (GridRoleMatches (RoleName $element) $requested)) { return $false }
  $identity = ElementIdentity $element
  if ([string]::IsNullOrEmpty($identity) -or ([string]$requested.runtime_id -ne "" -and $identity -ne [string]$requested.runtime_id)) { return $false }
  if (-not (GridItemNamesMatch $element $requested)) { return $false }
  try {
    if (-not [bool]$element.Current.IsEnabled -or [bool]$element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)) { return $false }
  } catch { return $false }
  $bounds = GridPhysicalBounds $context $element
  if ($null -eq $bounds -or -not (GridPointInRect ([double]$context.point.x) ([double]$context.point.y) $bounds)) { return $false }
  if (-not (GridRectsMatch $bounds $requested.bounds 3.0)) { return $false }
  return $true
}

function GridItemPatternFor([System.Windows.Automation.AutomationElement] $element) {
  $pattern = $null
  if (-not $element.TryGetCurrentPattern([System.Windows.Automation.GridItemPattern]::Pattern, [ref]$pattern)) { throw "native_grid_item_pattern_unavailable" }
  return [System.Windows.Automation.GridItemPattern]$pattern
}

function GridPatternFor([System.Windows.Automation.AutomationElement] $element) {
  $pattern = $null
  if (-not $element.TryGetCurrentPattern([System.Windows.Automation.GridPattern]::Pattern, [ref]$pattern)) { throw "native_grid_pattern_unavailable" }
  return [System.Windows.Automation.GridPattern]$pattern
}

function GridAnchorRequest([object] $request) {
  if ($null -eq $request.anchor) { throw "native_grid_anchor_invalid" }
  $anchor = $request.anchor
  $item = GridItemRequest $anchor.selected_item $true
  $gridRuntimeId = [string]$anchor.grid_runtime_id
  $row = 0
  $column = 0
  if (($gridRuntimeId.Length -eq 0 -or $gridRuntimeId.Length -gt 1024 -or
    -not [int]::TryParse([string]$anchor.row, [Globalization.NumberStyles]::Integer, [Globalization.CultureInfo]::InvariantCulture, [ref]$row) -or
    -not [int]::TryParse([string]$anchor.column, [Globalization.NumberStyles]::Integer, [Globalization.CultureInfo]::InvariantCulture, [ref]$column) -or
    $row -lt 0 -or $column -lt 0)) {
    throw "native_grid_anchor_invalid"
  }
  return [pscustomobject]@{ selected_item = $item; grid_runtime_id = $gridRuntimeId; grid_path = $anchor.grid_path; row = $row; column = $column }
}

function GridAnchorMatchesItem([object] $item, [object] $anchorItem) {
  if (([string]$item.runtime_id -ne "" -and [string]$item.runtime_id -ne [string]$anchorItem.runtime_id) -or
    [string]$item.normalized_role -cne [string]$anchorItem.normalized_role) { return $false }
  if ($null -ne $anchorItem.name -and [string]$item.name -cne [string]$anchorItem.name) { return $false }
  return GridRectsMatch $item.bounds $anchorItem.bounds 3.0
}

function GridItemOutput([System.Windows.Automation.AutomationElement] $element, [object] $context, [bool] $selected) {
  $name = ""
  try { $name = [string]$element.Current.Name } catch { }
  $result = [ordered]@{
    role = (RoleName $element)
    runtime_id = (ElementIdentity $element)
    bounds = (GridPhysicalBounds $context $element)
  }
  if (-not [string]::IsNullOrEmpty($name)) { $result.name = $name }
  if ($selected) { $result.selected = $true }
  return [pscustomobject]$result
}

function GridReadItemAnchor([object] $request) {
  $processId = RequestPid $request
  $hwnd = RequestHwnd $request
  $point = GridPoint $request
  $item = GridItemRequest $request.selected_item $false
  $prior = [NativeWindowScope]::SetThreadDpiAwarenessContext([IntPtr](-4))
  if ($prior -eq [IntPtr]::Zero) { return ErrorReply "native_grid_dpi_unavailable" }
  try {
    $context = GridTarget $processId $hwnd $point
    $uiPoint = GridUiPoint $context
    $hit = [System.Windows.Automation.AutomationElement]::FromPoint($uiPoint)
    if ($null -eq $hit -or -not (GridItemMatches $hit $item $context)) { return ErrorReply "native_grid_item_mismatch" }
    $gridItemPattern = GridItemPatternFor $hit
    $grid = $gridItemPattern.Current.ContainingGrid
    if ($null -eq $grid -or -not (GridElementIsOwned $grid $processId $hwnd)) { return ErrorReply "native_grid_owner_changed" }
    $gridIdentity = ElementIdentity $grid
    if ([string]::IsNullOrEmpty($gridIdentity)) { return ErrorReply "native_grid_identity_unavailable" }
    [void](GridPatternFor $grid)
    $row = [int]$gridItemPattern.Current.Row
    $column = [int]$gridItemPattern.Current.Column
    if ($row -lt 0 -or $column -lt 0 -or $row -gt 2147483646 -or $column -gt 2147483646) {
      return ErrorReply "native_grid_index_invalid"
    }
    $path = GridRawPath $grid $context
    $itemOutput = GridItemOutput $hit $context $false
    return [ordered]@{
      ok = $true
      pid = $processId
      window_id = $hwnd.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture)
      selected_item = $itemOutput
      anchor = [ordered]@{ grid_runtime_id = $gridIdentity; grid_path = $path; row = $row; column = $column }
    }
  } finally {
    [void][NativeWindowScope]::SetThreadDpiAwarenessContext($prior)
  }
}

function GridCaretWithin([object] $caret, [object] $rect) {
  $caretRight = [double]$caret.x + [double]$caret.width
  $caretBottom = [double]$caret.y + [double]$caret.height
  return ([double]$caret.x -ge [double]$rect.x -and $caretRight -le ([double]$rect.x + [double]$rect.width) -and
    [double]$caret.y -ge [double]$rect.y -and $caretBottom -le ([double]$rect.y + [double]$rect.height))
}

function GridCaretWithinEditor([object] $caret, [object] $rect) {
  $left = [double]$rect.x
  $top = [double]$rect.y
  $right = $left + [double]$rect.width
  $bottom = $top + [double]$rect.height
  $caretRight = [double]$caret.x + [double]$caret.width
  $caretBottom = [double]$caret.y + [double]$caret.height
  $centerX = [double]$caret.x + ([double]$caret.width / 2.0)
  $centerY = [double]$caret.y + ([double]$caret.height / 2.0)
  return ([double]$caret.x -ge $left -and [double]$caret.x -lt $right -and
    [double]$caret.y -ge $top -and [double]$caret.y -lt $bottom -and
    $centerX -ge $left -and $centerX -lt $right -and
    $centerY -ge $top -and $centerY -lt $bottom -and
    $caretRight -le ($right + 1.0) -and $caretBottom -le ($bottom + 1.0))
}

function GridEditorProviderAllowed([string] $role, [string] $className, [bool] $editable, [bool] $password, [bool] $verifiedChild) {
  if (-not $verifiedChild -or [string]::IsNullOrWhiteSpace($className) -or $password) { return $false }
  if ($role -ceq "Pane") {
    return [string]::Equals($className, "EXCEL6", [StringComparison]::OrdinalIgnoreCase)
  }
  if ($role -ceq "Edit") { return $editable }
  return $false
}

function GridElementIsWritableEdit([System.Windows.Automation.AutomationElement] $element) {
  if (PasswordValue $element) { return $false }
  $pattern = $null
  try {
    if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { return $false }
    return -not [bool]([System.Windows.Automation.ValuePattern]$pattern).Current.IsReadOnly
  } catch {
    return $false
  }
}

function GridNativeClassName([IntPtr] $hwnd) {
  if ($hwnd -eq [IntPtr]::Zero -or -not [NativeWindowScope]::IsWindow($hwnd)) { throw "native_grid_editor_class_unavailable" }
  $name = New-Object System.Text.StringBuilder 256
  $length = [NativeWindowScope]::GetClassName($hwnd, $name, $name.Capacity)
  if ($length -le 0) { throw "native_grid_editor_class_unavailable" }
  return $name.ToString()
}

function GridNativeFocus([object] $context, [IntPtr] $editorHwnd, [object] $cellBounds, [object] $editorBounds) {
  [uint32]$owner = 0
  $thread = [NativeWindowScope]::GetWindowThreadProcessId($context.hwnd, [ref]$owner)
  if ($thread -eq 0 -or $owner -ne [uint32]$context.pid) { throw "native_grid_owner_changed" }
  $state = New-Object 'NativeWindowScope+NativeGuiThreadInfo'
  $state.cbSize = [uint32][Runtime.InteropServices.Marshal]::SizeOf($state)
  if (-not [NativeWindowScope]::GetGUIThreadInfo($thread, [ref]$state)) { throw "native_grid_focus_unavailable" }
  if ($state.hwndActive.ToInt64() -ne $context.hwnd.ToInt64() -or
    $state.hwndFocus.ToInt64() -ne $editorHwnd.ToInt64() -or
    $state.hwndCaret.ToInt64() -ne $editorHwnd.ToInt64() -or
    (($state.flags -band 0x1e) -ne 0)) {
    throw "native_grid_focus_mismatch"
  }
  $caretWidth = [int]$state.rcCaret.Right - [int]$state.rcCaret.Left
  $caretHeight = [int]$state.rcCaret.Bottom - [int]$state.rcCaret.Top
  if ($caretWidth -lt 0 -or $caretHeight -le 0 -or $caretWidth -gt 4096 -or $caretHeight -gt 4096) { throw "native_grid_caret_unavailable" }
  $caretPoint = New-Object 'NativeWindowScope+NativeWindowPoint'
  $caretPoint.X = [int]$state.rcCaret.Left
  $caretPoint.Y = [int]$state.rcCaret.Top
  if (-not [NativeWindowScope]::ClientToScreen($editorHwnd, [ref]$caretPoint)) { throw "native_grid_caret_unavailable" }
  $caret = [pscustomobject]@{ x = [int]$caretPoint.X; y = [int]$caretPoint.Y; width = $caretWidth; height = $caretHeight }
  if (-not (GridCaretWithin $caret $cellBounds) -or -not (GridCaretWithinEditor $caret $editorBounds)) {
    throw "native_grid_caret_outside_edit_surface"
  }
  return [pscustomobject]@{
    focused = $true
    pid = $context.pid
    window_id = $context.hwnd.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture)
    runtime_id = ""
    role = ""
    caret = $caret
  }
}

function GridEditContextCore([int] $processId, [IntPtr] $hwnd, [object] $point, [object] $requestedItem, [object] $anchor) {
  $context = GridTarget $processId $hwnd $point
  $gridRuntimeId = [string]$anchor.grid_runtime_id
  if ([string]::IsNullOrEmpty($gridRuntimeId) -or $gridRuntimeId.Length -gt 1024) { throw "native_grid_anchor_invalid" }
  if (-not (GridAnchorMatchesItem $requestedItem $anchor.selected_item)) { throw "native_grid_anchor_mismatch" }
  if ($anchor.grid_path -isnot [array] -or $anchor.grid_path.Count -lt 2 -or $anchor.grid_path.Count -gt 32 -or
    [string]$anchor.grid_path[0] -ne [string]$context.root_identity -or
    [string]$anchor.grid_path[$anchor.grid_path.Count - 1] -ne [string]$anchor.grid_runtime_id) {
    throw "native_grid_anchor_mismatch"
  }
  $grid = GridFindAnchoredGrid $anchor $context
  $gridPattern = GridPatternFor $grid
  $item = $null
  try { $item = $gridPattern.GetItem([int]$anchor.row, [int]$anchor.column) } catch { throw "native_grid_item_unavailable" }
  if ($null -eq $item -or -not (GridElementIsOwned $item $processId $hwnd)) { throw "native_grid_owner_changed" }
  if (-not (GridItemMatches $item $anchor.selected_item $context)) { throw "native_grid_item_changed" }
  $gridItemPattern = GridItemPatternFor $item
  if ((ElementIdentity $gridItemPattern.Current.ContainingGrid) -ne [string]$anchor.grid_runtime_id) { throw "native_grid_anchor_mismatch" }
  $selectionPattern = $null
  if (-not $item.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionPattern)) {
    throw "native_grid_selection_unavailable"
  }
  if (-not [bool]([System.Windows.Automation.SelectionItemPattern]$selectionPattern).Current.IsSelected) {
    throw "native_grid_selection_changed"
  }
  $cellBounds = GridPhysicalBounds $context $item
  if ($null -eq $cellBounds -or -not (GridPointInRect ([double]$point.x) ([double]$point.y) $cellBounds)) { throw "native_grid_point_outside_cell" }
  if (-not (GridRectsMatch $cellBounds $anchor.selected_item.bounds 3.0)) { throw "native_grid_bounds_changed" }

  $uiPoint = GridUiPoint $context
  $pointElement = [System.Windows.Automation.AutomationElement]::FromPoint($uiPoint)
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $pointElement -or $null -eq $focused -or
    -not (GridElementIsOwned $pointElement $processId $hwnd) -or
    -not (GridElementIsOwned $focused $processId $hwnd)) { throw "native_grid_focus_unavailable" }
  $pointIdentity = ElementIdentity $pointElement
  $focusIdentity = ElementIdentity $focused
  if ([string]::IsNullOrEmpty($pointIdentity) -or $pointIdentity -ne $focusIdentity) { throw "native_grid_focus_mismatch" }
  try {
    if ([bool]$pointElement.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsOffscreenProperty) -or
      -not [bool]$pointElement.Current.IsEnabled) { throw "native_grid_editor_unavailable" }
  } catch { throw "native_grid_editor_unavailable" }
  $editorRole = RoleName $pointElement
  if ($editorRole -eq "Unknown") { throw "native_grid_editor_unavailable" }
  $editorBounds = GridPhysicalBounds $context $pointElement
  if ($null -eq $editorBounds -or -not (GridPointInRect ([double]$point.x) ([double]$point.y) $editorBounds)) {
    throw "native_grid_point_outside_editor"
  }
  $editorHwndValue = [Int64]$pointElement.Current.NativeWindowHandle
  if ($editorHwndValue -eq 0 -or $editorHwndValue -eq $hwnd.ToInt64()) { throw "native_grid_child_window_unavailable" }
  $editorHwnd = [IntPtr]$editorHwndValue
  $editorRootHwnd = [NativeWindowScope]::GetAncestor($editorHwnd, 2)
  if ($context.hit_hwnd.ToInt64() -ne $editorHwnd.ToInt64() -or
    $editorRootHwnd.ToInt64() -ne $hwnd.ToInt64()) {
    throw "native_grid_hit_window_mismatch"
  }
  [uint32]$editorOwner = 0
  if ([NativeWindowScope]::GetWindowThreadProcessId($editorHwnd, [ref]$editorOwner) -eq 0 -or $editorOwner -ne [uint32]$processId) {
    throw "native_grid_owner_changed"
  }
  $uiAEditorHwnd = [Int64]$pointElement.Current.NativeWindowHandle
  if ($uiAEditorHwnd -ne $editorHwndValue) {
    throw "native_grid_editor_hwnd_mismatch"
  }
  $verifiedEditorChild = [NativeWindowScope]::IsWindow($editorHwnd) -and
    $editorHwndValue -ne $hwnd.ToInt64() -and
    $editorRootHwnd.ToInt64() -eq $hwnd.ToInt64() -and
    $editorOwner -eq [uint32]$processId -and
    $context.hit_hwnd.ToInt64() -eq $editorHwnd.ToInt64() -and
    $uiAEditorHwnd -eq $editorHwndValue
  $editorClassName = GridNativeClassName $editorHwnd
  $editorEditable = $editorRole -ceq "Edit" -and (GridElementIsWritableEdit $pointElement)
  if (-not (GridEditorProviderAllowed $editorRole $editorClassName $editorEditable (PasswordValue $pointElement) $verifiedEditorChild)) {
    throw "native_grid_editor_provider_unverified"
  }
  $nativeFocus = GridNativeFocus $context $editorHwnd $cellBounds $editorBounds
  $focusBounds = GridPhysicalBounds $context $focused
  return [pscustomobject]@{
    context = $context
    selected_item = (GridItemOutput $item $context $true)
    editor = [pscustomobject]@{
      role = $editorRole
      runtime_id = $pointIdentity
      class_name = $editorClassName
      bounds = $editorBounds
      hwnd = $editorHwnd.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture)
      caret = $nativeFocus.caret
    }
    focus = [pscustomobject]@{
      focused = $true
      pid = $processId
      window_id = $hwnd.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture)
      runtime_id = $focusIdentity
      role = (RoleName $focused)
      bounds = $focusBounds
    }
  }
}

function GridReadEditContext([object] $request) {
  $processId = RequestPid $request
  $hwnd = RequestHwnd $request
  $point = GridPoint $request
  $item = GridItemRequest $request.selected_item $false
  $anchor = GridAnchorRequest $request
  $prior = [NativeWindowScope]::SetThreadDpiAwarenessContext([IntPtr](-4))
  if ($prior -eq [IntPtr]::Zero) { return ErrorReply "native_grid_dpi_unavailable" }
  try {
    $fresh = GridEditContextCore $processId $hwnd $point $item $anchor
    return [ordered]@{
      ok = $true
      pid = $processId
      window_id = $hwnd.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture)
      selected_item = $fresh.selected_item
      editor = $fresh.editor
      focus = $fresh.focus
    }
  } finally {
    [void][NativeWindowScope]::SetThreadDpiAwarenessContext($prior)
  }
}

function GridExpectedMatches([object] $expected, [object] $fresh, [int] $processId, [IntPtr] $hwnd) {
  if ($null -eq $expected) { return $false }
  $selected = $expected.selected_item
  $editor = $expected.editor
  $focus = $expected.focus
  if ($null -eq $selected -or $null -eq $editor -or $null -eq $focus -or
    $selected.selected -ne $true -or $focus.focused -ne $true) { return $false }
  if ([string]$selected.runtime_id -cne [string]$fresh.selected_item.runtime_id -or
    (NormalizeGridRole ([string]$selected.role)) -cne (NormalizeGridRole ([string]$fresh.selected_item.role))) { return $false }
  if ($null -ne $selected.PSObject.Properties["name"] -and [string]$selected.name -cne [string]$fresh.selected_item.name) { return $false }
  if (-not (GridRectsMatch (GridRect $selected.bounds) $fresh.selected_item.bounds 1.0)) { return $false }
  if ([string]$editor.runtime_id -cne [string]$fresh.editor.runtime_id -or
    [string]$editor.role -cne [string]$fresh.editor.role -or
    [string]$focus.runtime_id -cne [string]$fresh.focus.runtime_id -or
    [string]$focus.role -cne [string]$fresh.focus.role -or
    [string]$focus.runtime_id -cne [string]$editor.runtime_id -or
    [string]$focus.role -cne [string]$editor.role) { return $false }
  $focusPid = 0
  if (-not [int]::TryParse([string]$focus.pid, [Globalization.NumberStyles]::Integer, [Globalization.CultureInfo]::InvariantCulture, [ref]$focusPid) -or
    $focusPid -ne $processId) { return $false }
  $focusHwnd = 0L
  if (-not [Int64]::TryParse([string]$focus.window_id, [Globalization.NumberStyles]::Integer, [Globalization.CultureInfo]::InvariantCulture, [ref]$focusHwnd) -or
    $focusHwnd -ne $hwnd.ToInt64()) { return $false }
  $expectedEditorHwnd = 0L
  if (-not [Int64]::TryParse([string]$editor.hwnd, [Globalization.NumberStyles]::Integer, [Globalization.CultureInfo]::InvariantCulture, [ref]$expectedEditorHwnd) -or
    $expectedEditorHwnd -le 0 -or $expectedEditorHwnd -ne [Int64]$fresh.editor.hwnd) { return $false }
  if (-not (GridRectsMatch (GridRect $editor.bounds) $fresh.editor.bounds 1.0)) { return $false }
  $expectedCaret = $editor.caret
  if ($null -eq $expectedCaret) { return $false }
  foreach ($field in @("x", "y", "width", "height")) {
    try { $expectedValue = GridNumber $expectedCaret.$field } catch { return $false }
    if ([double]$expectedValue -ne [double]$fresh.editor.caret.$field) { return $false }
  }
  if ([double]$expectedCaret.width -lt 0 -or [double]$expectedCaret.height -le 0) { return $false }
  return $true
}

function GridCommitEnter([object] $request) {
  $prior = [IntPtr]::Zero
  $sendInvocationStarted = $false
  try {
    $processId = RequestPid $request
    $hwnd = RequestHwnd $request
    $point = GridPoint $request
    $item = GridItemRequest $request.selected_item $false
    $anchor = GridAnchorRequest $request
    $prior = [NativeWindowScope]::SetThreadDpiAwarenessContext([IntPtr](-4))
    if ($prior -eq [IntPtr]::Zero) { return [ordered]@{ status = "refused"; code = "native_grid_dpi_unavailable" } }
    $fresh = GridEditContextCore $processId $hwnd $point $item $anchor
    if (-not (GridExpectedMatches $request.expected $fresh $processId $hwnd)) {
      return [ordered]@{ status = "refused"; code = "native_grid_commit_proof_mismatch" }
    }
    $cellBounds = $fresh.selected_item.bounds
    $editorBounds = $fresh.editor.bounds
    $caret = $fresh.editor.caret
    $editorHwnd = [IntPtr][Int64]$fresh.editor.hwnd
    $send = $null
    try {
      $sendInvocationStarted = $true
      $send = [NativeWindowScope]::SendEnterIfGridStillFocused(
        $processId,
        $hwnd,
        [int]$point.x,
        [int]$point.y,
        $editorHwnd,
        [double]$cellBounds.x,
        [double]$cellBounds.y,
        ([double]$cellBounds.x + [double]$cellBounds.width),
        ([double]$cellBounds.y + [double]$cellBounds.height),
        [double]$editorBounds.x,
        [double]$editorBounds.y,
        ([double]$editorBounds.x + [double]$editorBounds.width),
        ([double]$editorBounds.y + [double]$editorBounds.height),
        [int]$caret.x,
        [int]$caret.y,
        [int]$caret.width,
        [int]$caret.height
      )
    } catch {
      return [ordered]@{ status = "unknown"; code = "native_grid_commit_delivery_unknown" }
    }
    if ([int]$send.attempted -eq 0) { return [ordered]@{ status = "refused"; code = [string]$send.code } }
    if (-not [string]::IsNullOrEmpty([string]$send.code)) { return [ordered]@{ status = "unknown"; code = "native_grid_commit_delivery_unknown" } }
    $delivered = [int]$send.delivered
    if ($delivered -eq 0) { return [ordered]@{ status = "refused"; code = "native_grid_commit_not_queued" } }
    if ($delivered -lt 2) { return [ordered]@{ status = "partial"; code = "native_grid_commit_partial" } }
    if ($delivered -eq 2) { return [ordered]@{ status = "dispatched" } }
    return [ordered]@{ status = "unknown"; code = "native_grid_commit_delivery_unknown" }
  } catch {
    if ($sendInvocationStarted) { return [ordered]@{ status = "unknown"; code = "native_grid_commit_delivery_unknown" } }
    $code = [string]$_.Exception.Message
    if ([string]::IsNullOrEmpty($code) -or $code.Length -gt 96 -or $code -notmatch "^[a-z0-9_]+$") { $code = "native_grid_commit_refused" }
    return [ordered]@{ status = "refused"; code = $code }
  } finally {
    if ($prior -ne [IntPtr]::Zero) {
      try { [void][NativeWindowScope]::SetThreadDpiAwarenessContext($prior) } catch { }
    }
  }
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
using System.Text;
public static class NativeWindowScope {
  [StructLayout(LayoutKind.Sequential)]
  public struct NativeWindowPoint { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct NativeWindowRect { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct NativeGuiThreadInfo {
    public uint cbSize;
    public uint flags;
    public IntPtr hwndActive;
    public IntPtr hwndFocus;
    public IntPtr hwndCapture;
    public IntPtr hwndMenuOwner;
    public IntPtr hwndMoveSize;
    public IntPtr hwndCaret;
    public NativeWindowRect rcCaret;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct NativeKeyboardInput {
    public ushort virtualKey;
    public ushort scanCode;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Explicit, Size = 32)]
  public struct NativeInputUnion {
    [FieldOffset(0)] public NativeKeyboardInput keyboard;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct NativeInput {
    public uint type;
    public NativeInputUnion data;
  }
  public struct NativeSendResult {
    public int attempted;
    public uint delivered;
    public string code;
  }
  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int GetClassName(IntPtr hwnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hwnd, out NativeWindowRect rect);
  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(NativeWindowPoint point);
  [DllImport("user32.dll")]
  public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")]
  public static extern bool GetGUIThreadInfo(uint threadId, ref NativeGuiThreadInfo info);
  [DllImport("user32.dll")]
  public static extern bool ClientToScreen(IntPtr hwnd, ref NativeWindowPoint point);
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int virtualKey);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint count, [In] NativeInput[] inputs, int inputSize);

  private static bool Contains(double left, double top, double right, double bottom, int x, int y) {
    return x >= left && y >= top && x < right && y < bottom;
  }
  private static bool SameCaret(IntPtr caretHwnd, NativeWindowRect caret, int x, int y, int width, int height) {
    if (caretHwnd == IntPtr.Zero || caret.Bottom <= caret.Top || caret.Right < caret.Left) return false;
    NativeWindowPoint origin = new NativeWindowPoint();
    origin.X = caret.Left;
    origin.Y = caret.Top;
    if (!ClientToScreen(caretHwnd, ref origin)) return false;
    return origin.X == x && origin.Y == y && (caret.Right - caret.Left) == width && (caret.Bottom - caret.Top) == height;
  }
  private static bool ModifiersHeld() {
    int[] keys = new int[] { 0x10, 0x11, 0x12, 0x0d, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 };
    foreach (int key in keys) if (GetAsyncKeyState(key) < 0) return true;
    return false;
  }
  private static bool NativeGridStateMatches(
    int processId, IntPtr hwnd, NativeWindowPoint point, IntPtr editorHwnd,
    double cellLeft, double cellTop, double cellRight, double cellBottom,
    double editorLeft, double editorTop, double editorRight, double editorBottom,
    int caretX, int caretY, int caretWidth, int caretHeight,
    out string code
  ) {
    code = "native_grid_commit_focus_changed";
    if (!IsWindow(hwnd) || !IsWindowVisible(hwnd) || IsIconic(hwnd) || GetAncestor(hwnd, 2).ToInt64() != hwnd.ToInt64()) {
      code = "native_grid_commit_target_unavailable";
      return false;
    }
    uint owner = 0;
    uint thread = GetWindowThreadProcessId(hwnd, out owner);
    NativeWindowRect targetRect;
    if (thread == 0 || owner != (uint)processId || !GetWindowRect(hwnd, out targetRect)
      || point.X < targetRect.Left || point.X >= targetRect.Right || point.Y < targetRect.Top || point.Y >= targetRect.Bottom
      || GetForegroundWindow().ToInt64() != hwnd.ToInt64()) {
      code = "native_grid_commit_target_changed";
      return false;
    }
    IntPtr pointHwnd = WindowFromPoint(point);
    uint editorOwner = 0;
    if (pointHwnd == IntPtr.Zero || pointHwnd.ToInt64() != editorHwnd.ToInt64()
      || editorHwnd == IntPtr.Zero || editorHwnd.ToInt64() == hwnd.ToInt64()
      || GetAncestor(editorHwnd, 2).ToInt64() != hwnd.ToInt64()
      || GetWindowThreadProcessId(editorHwnd, out editorOwner) == 0 || editorOwner != (uint)processId) {
      code = "native_grid_commit_hit_changed";
      return false;
    }
    if (!Contains(cellLeft, cellTop, cellRight, cellBottom, point.X, point.Y)
      || !Contains(editorLeft, editorTop, editorRight, editorBottom, point.X, point.Y)) {
      code = "native_grid_commit_point_changed";
      return false;
    }
    NativeGuiThreadInfo info = new NativeGuiThreadInfo();
    info.cbSize = (uint)Marshal.SizeOf(typeof(NativeGuiThreadInfo));
    if (!GetGUIThreadInfo(thread, ref info)
      || info.hwndActive.ToInt64() != hwnd.ToInt64()
      || info.hwndFocus.ToInt64() != editorHwnd.ToInt64()
      || info.hwndCaret.ToInt64() != editorHwnd.ToInt64()
      || (info.flags & 0x1e) != 0
      || !SameCaret(info.hwndCaret, info.rcCaret, caretX, caretY, caretWidth, caretHeight)) {
      code = "native_grid_commit_caret_changed";
      return false;
    }
    if (!ModifiersHeld()) return true;
    code = "native_grid_commit_modifier_held";
    return false;
  }
  public static NativeSendResult SendEnterIfGridStillFocused(
    int processId, IntPtr hwnd, int pointX, int pointY, IntPtr editorHwnd,
    double cellLeft, double cellTop, double cellRight, double cellBottom,
    double editorLeft, double editorTop, double editorRight, double editorBottom,
    int caretX, int caretY, int caretWidth, int caretHeight
  ) {
    NativeSendResult result = new NativeSendResult();
    result.attempted = 0;
    result.delivered = 0;
    result.code = "native_grid_commit_focus_changed";
    NativeWindowPoint point = new NativeWindowPoint();
    point.X = pointX;
    point.Y = pointY;
    string code;
    if (!NativeGridStateMatches(processId, hwnd, point, editorHwnd, cellLeft, cellTop, cellRight, cellBottom,
      editorLeft, editorTop, editorRight, editorBottom, caretX, caretY, caretWidth, caretHeight, out code)) {
      result.code = code;
      return result;
    }
    NativeInput[] inputs = new NativeInput[2];
    for (int index = 0; index < inputs.Length; index++) {
      inputs[index].type = 1;
      inputs[index].data.keyboard.virtualKey = 0x0d;
      inputs[index].data.keyboard.scanCode = 0;
      inputs[index].data.keyboard.flags = index == 0 ? 0u : 0x0002u;
      inputs[index].data.keyboard.time = 0;
      inputs[index].data.keyboard.extraInfo = UIntPtr.Zero;
    }
    // Repeat the synchronous foreground, point, caret, and modifier checks
    // after the last managed/UIA comparison and immediately before SendInput.
    if (!NativeGridStateMatches(processId, hwnd, point, editorHwnd, cellLeft, cellTop, cellRight, cellBottom,
      editorLeft, editorTop, editorRight, editorBottom, caretX, caretY, caretWidth, caretHeight, out code)) {
      result.code = code;
      return result;
    }
    result.attempted = 1;
    try {
      result.delivered = SendInput(2, inputs, Marshal.SizeOf(typeof(NativeInput)));
      result.code = "";
    } catch {
      result.code = "native_grid_commit_delivery_unknown";
    }
    return result;
  }
}
"@
    $request = $raw | ConvertFrom-Json
    if ($null -eq $request -or [string]::IsNullOrEmpty([string]$request.op)) {
      $reply = ErrorReply "native_uia_invalid_request"
    } elseif ([string]$request.op -eq "observe") {
      $reply = Observe $request
    } elseif ([string]$request.op -eq "focus") {
      $reply = Focus $request
    } elseif ([string]$request.op -eq "grid_item_anchor") {
      $reply = GridReadItemAnchor $request
    } elseif ([string]$request.op -eq "grid_edit_context") {
      $reply = GridReadEditContext $request
    } elseif ([string]$request.op -eq "grid_commit_enter") {
      $reply = GridCommitEnter $request
    } elseif ([string]$request.op -eq "pointer_surface") {
      $reply = PointerSurfaceRead $request
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
