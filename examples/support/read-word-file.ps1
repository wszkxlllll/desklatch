param([Parameter(Mandatory = $true)][string]$FilePath)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false, $true)
Add-Type -AssemblyName System.IO.Compression

# Read the bytes produced by Word. The shared read handle also works while the
# disposable output is still open in its authoring application.
$stream = [IO.File]::Open($FilePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose() }
    $stream.Position = 0
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
    try {
        $entry = $zip.GetEntry('word/document.xml')
        if (!$entry -or $entry.Length -gt 4194304) { throw 'Expected a small Word document with main document XML.' }
        $entryStream = $entry.Open()
        try {
            $settings = [Xml.XmlReaderSettings]::new()
            $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
            $settings.MaxCharactersInDocument = 4194304
            $reader = [Xml.XmlReader]::Create($entryStream, $settings)
            try {
                $xml = [Xml.XmlDocument]::new()
                $xml.XmlResolver = $null
                $xml.Load($reader)
            } finally { $reader.Dispose() }
        } finally { $entryStream.Dispose() }
        $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
        $ns.AddNamespace('w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')
        $paragraphs = @($xml.SelectNodes('/w:document/w:body//w:p', $ns) | ForEach-Object {
            ($_.SelectNodes('.//w:t', $ns) | ForEach-Object { $_.InnerText }) -join ''
        })
        ConvertTo-Json -Compress -InputObject @{sha256 = $digest; paragraphs = $paragraphs}
    } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
