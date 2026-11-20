function Get-DeskLatchNodePair {
    param([Parameter(Mandatory)][string]$Node)

    if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { return }
    $npm = Join-Path (Split-Path -Parent $Node) 'node_modules/npm/bin/npm-cli.js'
    if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) { return }
    $version = & $Node --version 2>$null
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v\d+\.\d+\.\d+$') { return }
    if ([version]$version.Substring(1) -lt [version]'22.19.0') { return }
    [pscustomobject]@{ Node = $Node; Npm = $npm; Version = $version }
}

function Get-DeskLatchVerifiedArchive {
    param([string]$InstallRoot, [string]$FileName, [string]$Url, [string]$Sha256)

    $downloads = Join-Path $InstallRoot 'cache/downloads'
    [IO.Directory]::CreateDirectory($downloads) | Out-Null
    $archive = Join-Path $downloads $FileName
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $Sha256) {
        $previousProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $archive -TimeoutSec 120 -ErrorAction Stop
        } finally {
            $ProgressPreference = $previousProgress
        }
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $Sha256) {
        throw 'The runtime archive did not match its official checksum. Retry the download.'
    }
    return $archive
}

function Resolve-DeskLatchNode {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [scriptblock]$Status
    )

    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $platform = switch ($architecture) {
        'AMD64' { 'win-x64' }
        'ARM64' { 'win-arm64' }
        default { throw 'DeskLatch requires Windows x64 or ARM64.' }
    }
    # The archive digests are from https://nodejs.org/en/blog/release/v24.22.3.
    $hash = @{
        'win-x64' = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'
        'win-arm64' = 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14'
    }[$platform]
    $release = 'v24.22.3'
    $distribution = "node-$release-$platform"
    $nodeRoot = Join-Path $InstallRoot 'runtime/node'
    $portable = Join-Path $nodeRoot "$distribution/node.exe"
    $pair = Get-DeskLatchNodePair -Node $portable
    if ($pair) { return $pair }

    # A release archive may be unpacked beside this installer by the packer.
    # Prefer it before consulting PATH or downloading into the selected root.
    $distributionNode = Join-Path (Split-Path -Parent $PSScriptRoot) 'node/node.exe'
    $pair = Get-DeskLatchNodePair -Node $distributionNode
    if ($pair) { return $pair }

    $installed = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($installed) {
        $pair = Get-DeskLatchNodePair -Node $installed.Source
        if ($pair) { return $pair }
    }

    [IO.Directory]::CreateDirectory($nodeRoot) | Out-Null
    if ($Status) { & $Status 'Preparing the portable Node.js archive' | Out-Null }
    $archive = Get-DeskLatchVerifiedArchive -InstallRoot $InstallRoot -FileName "$distribution.zip" `
        -Url "https://nodejs.org/dist/$release/$distribution.zip" -Sha256 $hash
    if ($Status) { & $Status 'Preparing the portable Node.js runtime' | Out-Null }
    Expand-Archive -LiteralPath $archive -DestinationPath $nodeRoot -Force -ErrorAction Stop
    $pair = Get-DeskLatchNodePair -Node $portable
    if (-not $pair) { throw 'Node.js or npm could not start from the selected installation folder.' }
    return $pair
}
