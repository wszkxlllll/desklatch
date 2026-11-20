function Resolve-DeskLatchPython {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [scriptblock]$Status
    )

    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $package = switch ($architecture) {
        'AMD64' { 'python' }
        'ARM64' { 'pythonarm64' }
        default { throw 'The OCR installer requires Windows x64 or ARM64.' }
    }
    # CPython's Windows NuGet distribution includes venv and ensurepip.
    $release = '3.13.17'
    $digest = @{
        'python' = 'dce409744b088f94c6e37ba41f8100c384c27e029e843237364c602d30d475e5'
        'pythonarm64' = 'aaa8c60c0adffde214ebd13e19bd79289aedb6452b4883eb08a59592c008456b'
    }[$package]
    $directory = Join-Path $InstallRoot "runtime/$package-$release"
    $python = Join-Path $directory 'tools/python.exe'
    if (-not (Test-Path -LiteralPath $python -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $directory 'tools/Lib/ensurepip/__init__.py') -PathType Leaf)) {
        if ($Status) { & $Status 'Preparing the portable Python runtime for OCR' | Out-Null }
        $archive = Get-DeskLatchVerifiedArchive -InstallRoot $InstallRoot -FileName "$package.$release.zip" `
            -Url "https://api.nuget.org/v3-flatcontainer/$package/$release/$package.$release.nupkg" -Sha256 $digest
        Expand-Archive -LiteralPath $archive -DestinationPath $directory -Force -ErrorAction Stop
    }
    & $python -I -c 'import venv, ensurepip' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The portable Python installation could not start its local OCR environment.' }
    return $python
}
