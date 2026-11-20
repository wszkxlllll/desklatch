param([Parameter(Mandatory = $true)][string]$FilePath)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false, $true)
Add-Type -AssemblyName System.IO.Compression

function Read-PackageXml($zip, [string]$name, [int]$limit) {
    $entry = $zip.GetEntry($name)
    if (!$entry -or $entry.Length -gt $limit) { throw "Missing or oversized Office package part: $name" }
    $partStream = $entry.Open()
    try {
        $settings = [Xml.XmlReaderSettings]::new()
        $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
        $settings.MaxCharactersInDocument = $limit
        $reader = [Xml.XmlReader]::Create($partStream, $settings)
        try {
            $xml = [Xml.XmlDocument]::new()
            $xml.XmlResolver = $null
            $xml.Load($reader)
            return ,$xml
        } finally { $reader.Dispose() }
    } finally { $partStream.Dispose() }
}

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
        $types = Read-PackageXml $zip '[Content_Types].xml' 1048576
        $rels = Read-PackageXml $zip '_rels/.rels' 1048576
        $main = @($rels.GetElementsByTagName('Relationship', 'http://schemas.openxmlformats.org/package/2006/relationships') |
            Where-Object { $_.GetAttribute('Type') -in @(
                'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
                'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument'
            ) })
        if ($main.Count -ne 1 -or $main[0].GetAttribute('TargetMode') -eq 'External') { throw 'Expected one internal Office document relationship.' }
        $partUri = [Uri]::new([Uri]'https://package.invalid/', $main[0].GetAttribute('Target'))
        if ($partUri.GetLeftPart([UriPartial]::Authority) -ne 'https://package.invalid' -or $partUri.Query -or $partUri.Fragment) { throw 'Invalid document part path.' }
        $part = [Uri]::UnescapeDataString($partUri.AbsolutePath).TrimStart('/')
        $typeNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types'
        $override = @($types.GetElementsByTagName('Override', $typeNamespace) | Where-Object { $_.GetAttribute('PartName') -ceq ('/' + $part) })
        $declared = if ($override.Count -eq 1) { $override[0].GetAttribute('ContentType') } else {
            $extension = [IO.Path]::GetExtension($part).TrimStart('.')
            ($types.GetElementsByTagName('Default', $typeNamespace) | Where-Object { $_.GetAttribute('Extension') -eq $extension } | Select-Object -First 1).ContentType
        }
        if ($declared -ne 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') { throw 'Main document content type is missing or invalid.' }
        $xml = Read-PackageXml $zip $part 4194304
        if ($xml.DocumentElement.LocalName -ne 'document' -or $xml.DocumentElement.NamespaceURI -notin @(
            'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
            'http://purl.oclc.org/ooxml/wordprocessingml/main'
        )) { throw 'Expected a WordprocessingML document.' }
        $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
        $ns.AddNamespace('w', $xml.DocumentElement.NamespaceURI)
        $paragraphs = @($xml.SelectNodes('/w:document/w:body//w:p', $ns) | ForEach-Object {
            ($_.SelectNodes('.//w:t | .//w:tab | .//w:br | .//w:cr', $ns) | ForEach-Object {
                if ($_.LocalName -eq 't') { $_.InnerText } elseif ($_.LocalName -eq 'tab') { "`t" } else { "`n" }
            }) -join ''
        })
        ConvertTo-Json -Compress -InputObject @{sha256 = $digest; paragraphs = $paragraphs}
    } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
