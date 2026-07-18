param(
  [Parameter(Mandatory = $true)]
  [string]$IconSource,
  [Parameter(Mandatory = $true)]
  [string]$ShareSource
)

Add-Type -AssemblyName System.Drawing

$publicDir = Join-Path $PSScriptRoot "..\client\public"
New-Item -ItemType Directory -Path $publicDir -Force | Out-Null

function New-ResizedPng {
  param(
    [string]$Source,
    [string]$Destination,
    [int]$Width,
    [int]$Height,
    [scriptblock]$AfterDraw
  )

  $sourceImage = [System.Drawing.Image]::FromFile($Source)
  $bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bitmap.SetResolution(96, 96)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.DrawImage($sourceImage, 0, 0, $Width, $Height)

  if ($AfterDraw) {
    & $AfterDraw $graphics
  }

  $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
  $sourceImage.Dispose()
}

New-ResizedPng -Source $IconSource -Destination (Join-Path $publicDir "app-icon-512.png") -Width 512 -Height 512
New-ResizedPng -Source $IconSource -Destination (Join-Path $publicDir "icon-192.png") -Width 192 -Height 192
New-ResizedPng -Source $IconSource -Destination (Join-Path $publicDir "apple-touch-icon.png") -Width 180 -Height 180
New-ResizedPng -Source $IconSource -Destination (Join-Path $publicDir "favicon-32.png") -Width 32 -Height 32

$decorateShareImage = {
  param($graphics)

  $fontFamily = $null
  foreach ($candidate in @("Yu Gothic UI", "Yu Gothic", "Meiryo")) {
    try {
      $fontFamily = New-Object System.Drawing.FontFamily($candidate)
      break
    } catch {
      # Try the next installed Japanese font.
    }
  }
  if (-not $fontFamily) {
    $fontFamily = [System.Drawing.FontFamily]::GenericSansSerif
  }

  $titleFormat = New-Object System.Drawing.StringFormat
  $titleFormat.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
  $title = -join @(
    [char]0x304A, [char]0x3048, [char]0x304B,
    [char]0x304D, [char]0x3042, [char]0x3066
  )

  $shadowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $shadowPath.AddString(
    $title,
    $fontFamily,
    [int][System.Drawing.FontStyle]::Bold,
    70,
    (New-Object System.Drawing.PointF(67, 181)),
    $titleFormat
  )
  $shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(205, 255, 107, 74))
  $graphics.FillPath($shadowBrush, $shadowPath)

  $titlePath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $titlePath.AddString(
    $title,
    $fontFamily,
    [int][System.Drawing.FontStyle]::Bold,
    70,
    (New-Object System.Drawing.PointF(58, 172)),
    $titleFormat
  )
  $outlinePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(245, 255, 255, 255), 9)
  $outlinePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $titleBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 43, 36, 28))
  $graphics.DrawPath($outlinePen, $titlePath)
  $graphics.FillPath($titleBrush, $titlePath)

  $paperBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(225, 255, 248, 232))
  $paperPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, 43, 36, 28), 3)
  $graphics.FillRectangle($paperBrush, 64, 276, 368, 104)
  $graphics.DrawRectangle($paperPen, 64, 276, 368, 104)

  $subtitleFont = New-Object System.Drawing.Font($fontFamily, 25, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $subtitleBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 43, 36, 28))
  $subtitleLine1 = -join @(
    [char]0x63CF, [char]0x3044, [char]0x3066, [char]0x3001,
    [char]0x5F53, [char]0x3066, [char]0x3066, [char]0x3001
  )
  $subtitleLine2 = -join @(
    [char]0x307F, [char]0x3093, [char]0x306A, [char]0x3067,
    [char]0x7B11, [char]0x304A, [char]0x3046, [char]0xFF01
  )
  $subtitle = $subtitleLine1 + [Environment]::NewLine + $subtitleLine2
  $graphics.DrawString($subtitle, $subtitleFont, $subtitleBrush, 84, 295)

  $subtitleBrush.Dispose()
  $subtitleFont.Dispose()
  $paperPen.Dispose()
  $paperBrush.Dispose()
  $titleBrush.Dispose()
  $outlinePen.Dispose()
  $titlePath.Dispose()
  $shadowBrush.Dispose()
  $shadowPath.Dispose()
  $titleFormat.Dispose()
  if ($fontFamily -ne [System.Drawing.FontFamily]::GenericSansSerif) {
    $fontFamily.Dispose()
  }
}

New-ResizedPng -Source $ShareSource -Destination (Join-Path $publicDir "og-image.png") -Width 1200 -Height 630 -AfterDraw $decorateShareImage

Get-ChildItem $publicDir -File | Select-Object Name, Length
