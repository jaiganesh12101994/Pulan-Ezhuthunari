<#
  Smoke-tests the staged app the way an installed copy runs: the server is started with
  the bundled Python, Tesseract and Poppler, and with PATH reduced to the Windows system
  directories so no system install of any of them can be found.

  That last part is the point. On the build machine a system Tesseract and Python exist,
  and they would quietly satisfy the engine, hiding a bundling mistake until a user hit
  it. Stripping PATH makes the test fail here instead.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\test-packaged.ps1
#>
[CmdletBinding()]
param(
  [int] $Port = 3199,
  [string] $NodeExe = (Join-Path $env:ProgramFiles 'nodejs\node.exe')
)

$ErrorActionPreference = 'Stop'
$root  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stage = Join-Path $root 'build\app'
if (-not (Test-Path (Join-Path $stage 'server.mjs'))) { throw 'run scripts\build-desktop.ps1 first' }

if (-not (Test-Path $NodeExe)) {
  $found = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($found) { $NodeExe = $found } else { throw "node.exe not found at $NodeExe" }
}
Write-Host "node: $NodeExe"

# State that a real install writes outside the program folder
$stateRoot = Join-Path $root 'build\test-state'
$tempDir   = Join-Path $stateRoot 'temp'
$diagDir   = Join-Path $stateRoot 'diagnostics'
Remove-Item -LiteralPath $stateRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tempDir, $diagDir | Out-Null

# Everything the app needs, pointed at the staged copies
$env:NODE_ENV            = 'production'
$env:PORT                = "$Port"
$env:PYTHON_BIN          = Join-Path $stage 'python\python.exe'
$env:TESSERACT_CMD       = Join-Path $stage 'engines\tesseract\tesseract.exe'
$env:PDFTOPPM_BIN        = Join-Path $stage 'bin\pdftoppm.exe'
$env:PDFINFO_BIN         = Join-Path $stage 'bin\pdfinfo.exe'
$env:PULAN_TEMP_DIR      = $tempDir
$env:PULAN_DIAGNOSTICS_DIR = $diagDir
Remove-Item Env:\TESSDATA_PREFIX -ErrorAction SilentlyContinue
# The isolation: no G:\NodeJS, no C:\Python3, no C:\poppler-*
$env:PATH = 'C:\Windows\system32;C:\Windows'

Write-Host '--- what the app can see on PATH ---'
foreach ($b in @('python', 'tesseract', 'pdftoppm', 'node')) {
  $c = Get-Command $b -ErrorAction SilentlyContinue
  Write-Host ("  {0,-10} {1}" -f $b, $(if ($c) { $c.Source } else { 'not on PATH (good)' }))
}

$outLog = Join-Path $stateRoot 'server.out.log'
$errLog = Join-Path $stateRoot 'server.err.log'
$proc = Start-Process -FilePath $NodeExe -ArgumentList "`"$stage\server.mjs`"" `
  -WorkingDirectory $stage -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog

try {
  Write-Host '--- waiting for the server ---'
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) { throw "the server exited early ($($proc.ExitCode)): $(Get-Content $errLog -Raw)" }
    try {
      $null = Invoke-WebRequest "http://127.0.0.1:$Port/api/samples" -UseBasicParsing -TimeoutSec 3
      $ready = $true; break
    } catch { }
  }
  if (-not $ready) { throw "the server did not answer on port $Port" }
  Write-Host "  up after $([math]::Round(($i + 1) * 0.5, 1))s"

  Write-Host '--- which Tesseract did it find? (must be the bundled one) ---'
  $status = Invoke-RestMethod "http://127.0.0.1:$Port/api/engines/status" -TimeoutSec 120
  Write-Host "  available : $($status.tesseract.available)"
  Write-Host "  path      : $($status.tesseract.path)"
  Write-Host "  version   : $($status.tesseract.version)"
  $expected = (Join-Path $stage 'engines\tesseract\tesseract.exe')
  if ($status.tesseract.path -ne $expected) {
    throw "the app used $($status.tesseract.path) instead of the bundled $expected"
  }
  Write-Host '  -> bundled Tesseract, no system install involved'

  Write-Host '--- OCR through the bundled stack ---'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $body = @{ image = '/samples/tamil_sentence_1.png'; engine = 'tesseract'; language = 'tam+eng' } | ConvertTo-Json
  $ocr = Invoke-RestMethod "http://127.0.0.1:$Port/api/ocr" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 300
  $sw.Stop()
  if ($ocr.error) { throw "OCR failed: $($ocr.error)" }
  $firstLine = ($ocr.text -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
  Write-Host "  took      : $([math]::Round($sw.Elapsed.TotalSeconds, 1))s"
  Write-Host "  characters: $($ocr.text.Length)"
  Write-Host "  first line: $firstLine"
  if ($ocr.text.Length -lt 50) { throw 'the OCR result is too short to be real' }

  Write-Host '--- diagnostics written to the configured folder ---'
  Write-Host "  $((Get-ChildItem $diagDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count) files in $diagDir"

  Write-Host 'PASS - the staged app runs with no system Python, Tesseract or Poppler'
} finally {
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
