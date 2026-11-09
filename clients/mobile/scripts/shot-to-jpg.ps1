# Converts a PNG screenshot into a JPEG under 500 KB.
#
# Evidence screenshots are stored as JPEG (spec: "Capturas de evidência são
# JPEG abaixo de 500 KB"). `adb exec-out screencap` and CDP only produce PNG,
# and a 1080x2400 PNG is 700 KB+, so every capture goes through here before it
# is cited anywhere.
#
# Quality is lowered in steps until the file fits, so a busy screen degrades
# instead of being rejected. The image is never resized or cropped: the value of
# the evidence is the whole screen, not a fragment of it.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File shot-to-jpg.ps1 <src.png> <dst.jpg>
param(
    [Parameter(Mandatory = $true)][string]$Src,
    [Parameter(Mandatory = $true)][string]$Dst
)

Add-Type -AssemblyName System.Drawing

$limit = 500 * 1024
$img = [System.Drawing.Image]::FromFile((Resolve-Path $Src))
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.MimeType -eq 'image/jpeg' }

$q = 82
try {
    while ($true) {
        $ps = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $ps.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
            [System.Drawing.Imaging.Encoder]::Quality, [long]$q)
        $ms = New-Object System.IO.MemoryStream
        $img.Save($ms, $codec, $ps)

        if ($ms.Length -le $limit -or $q -le 40) {
            [System.IO.File]::WriteAllBytes($Dst, $ms.ToArray())
            "{0} q={1} {2} KB" -f $Dst, $q, [int]($ms.Length / 1024)
            $ms.Dispose(); $ps.Dispose()
            break
        }
        $ms.Dispose(); $ps.Dispose()
        $q -= 8
    }
}
finally {
    $img.Dispose()
}
