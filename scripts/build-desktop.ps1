<#
  Stages the whole desktop app under build/app/ and, with -Installer, builds the NSIS
  installer from it.

  The staged folder is self-contained: a machine that has never seen Node, Python,
  Tesseract or Poppler can run it, because every one of them is copied in.

    app/
      server.mjs            the Express API, bundled from server.ts by esbuild
      dist/                 the built React UI
      backend/              the Python OCR engine, quality checks and diagnostics
      engines/tessdata/     the Tamil + English LSTM models the engine reads
      engines/tesseract/    the Tesseract 5 CLI and its DLLs
      python/               the embedded Python runtime (scripts/prepare-python.ps1)
      bin/                  Poppler (pdftoppm/pdfinfo) for PDF rasterization
      public/samples/       the sample pages the picker offers

  The engine finds its own copies without configuration: backend/tamil_ocr_engine.py
  treats the parent of backend/ as the app root and looks for engines/tessdata and
  engines/tesseract there. electron/main.js then points PYTHON_BIN, TESSERACT_CMD,
  PDFTOPPM_BIN and PDFINFO_BIN at the staged copies, so nothing can silently fall back
  to a system install (which would hide a bundling mistake until it reached a user).

  Prerequisites:
    npm install
    powershell -ExecutionPolicy Bypass -File scripts\prepare-python.ps1

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1
    powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1 -Installer
#>
[CmdletBinding()]
param(
  # Where Tesseract and Poppler are taken from on THIS build machine.
  [string] $TesseractDir = 'C:\Program Files\Tesseract-OCR',
  [string] $PopplerBin   = 'C:\poppler-24.08.0\Library\bin',
  [string] $PythonDir,
  # Also run electron-builder to produce the installer.
  [switch] $Installer,
  # The training tools (lstmtraining, text2image, ...) are ~63 MB and never run here.
  [switch] $IncludeTesseractTrainingTools
)

$ErrorActionPreference = 'Stop'
$root  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$build = Join-Path $root 'build'
$stage = Join-Path $build 'app'
if (-not $PythonDir) { $PythonDir = Join-Path $build 'python' }
$PythonDir = [System.IO.Path]::GetFullPath($PythonDir)

function Copy-Tree($From, $To, [string[]] $ExcludeDirs = @()) {
  if (-not (Test-Path $From)) { throw "missing source: $From" }
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  $roboArgs = @($From, $To, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
  foreach ($d in $ExcludeDirs) { $roboArgs += @('/XD', (Join-Path $From $d)) }
  robocopy @roboArgs | Out-Null
  # robocopy reports 0-7 for success (1 means "files copied"); 8 and up is a failure.
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE) copying $From" }
}

function Get-TreeSize($Path) {
  if (-not (Test-Path $Path)) { return 0 }
  $item = Get-Item $Path
  if (-not $item.PSIsContainer) { return $item.Length }
  return (Get-ChildItem $Path -Recurse -File | Measure-Object -Property Length -Sum).Sum
}

Write-Host '=== 1/7  Building the UI ==='
# npm and esbuild write progress to stderr, which Windows PowerShell would turn into a
# terminating error under 'Stop'. Judge them by exit code instead.
$ErrorActionPreference = 'Continue'
Push-Location $root
try {
  npm run build 2>&1 | Select-Object -Last 2
  $uiExit = $LASTEXITCODE
} finally { Pop-Location }

Write-Host '=== 2/7  Staging folder ==='
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Write-Host '=== 3/7  Bundling the API server ==='
# One file, so the packaged app needs no node_modules at all. Vite stays external and is
# only imported by the dev branch, which a production server never reaches.
#
# The banner matters: Express and its dependencies are CommonJS and call require() for
# built-ins like 'path'. ESM output has no require, so esbuild would leave a shim that
# throws "Dynamic require of \"path\" is not supported" at startup. createRequire gives
# those bundled modules a real one, while the file itself stays ESM so that
# import.meta.url - which server.ts and agentClient.ts use to find their own folder -
# keeps working.
$banner = "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);"
Push-Location $root
try {
  npx esbuild server.ts --bundle --platform=node --format=esm --target=node20 `
    --outfile="$stage\server.mjs" --external:vite --log-level=warning "--banner:js=$banner"
  $bundleExit = $LASTEXITCODE
} finally { Pop-Location }
$ErrorActionPreference = 'Stop'

if ($uiExit -ne 0) { throw "vite build failed ($uiExit)" }
if ($bundleExit -ne 0) { throw "esbuild failed ($bundleExit)" }

Write-Host '=== 4/7  UI, Python engine and models ==='
Copy-Tree (Join-Path $root 'dist')            (Join-Path $stage 'dist')
Copy-Tree (Join-Path $root 'backend')         (Join-Path $stage 'backend') @('__pycache__', 'tests')
Copy-Tree (Join-Path $root 'public\samples')  (Join-Path $stage 'public\samples')
Copy-Tree (Join-Path $root 'engines\tessdata') (Join-Path $stage 'engines\tessdata')
# The engine puts these on sys.path when they exist, and they are small.
Copy-Tree (Join-Path $root 'engines\ocr_tamil') (Join-Path $stage 'engines\ocr_tamil') @('__pycache__')
if ((Get-TreeSize (Join-Path $root 'engines\surya_chandra')) -gt 0) {
  Copy-Tree (Join-Path $root 'engines\surya_chandra') (Join-Path $stage 'engines\surya_chandra')
}

Write-Host '=== 5/7  Python runtime ==='
if (-not (Test-Path (Join-Path $PythonDir 'python.exe'))) {
  throw "no embedded Python at $PythonDir - run scripts\prepare-python.ps1 first"
}
Copy-Tree $PythonDir (Join-Path $stage 'python')

Write-Host '=== 6/7  Tesseract and Poppler ==='
if (-not (Test-Path (Join-Path $TesseractDir 'tesseract.exe'))) {
  throw "tesseract.exe not found in $TesseractDir"
}
$tessOut = Join-Path $stage 'engines\tesseract'
New-Item -ItemType Directory -Force -Path $tessOut | Out-Null
Copy-Item (Join-Path $TesseractDir 'tesseract.exe') $tessOut
# Every DLL that sits beside it. Choosing them individually would be guesswork, and the
# guess would only fail on a machine that has no Tesseract of its own to borrow from.
Copy-Item (Join-Path $TesseractDir '*.dll') $tessOut
if ($IncludeTesseractTrainingTools) { Copy-Item (Join-Path $TesseractDir '*.exe') $tessOut }

if (-not (Test-Path (Join-Path $PopplerBin 'pdftoppm.exe'))) {
  throw "pdftoppm.exe not found in $PopplerBin"
}
$popOut = Join-Path $stage 'bin'
New-Item -ItemType Directory -Force -Path $popOut | Out-Null
Copy-Item (Join-Path $PopplerBin 'pdftoppm.exe') $popOut
Copy-Item (Join-Path $PopplerBin 'pdfinfo.exe') $popOut
Copy-Item (Join-Path $PopplerBin '*.dll') $popOut

Write-Host '=== 7/7  Result ==='
foreach ($part in @('server.mjs', 'dist', 'backend', 'python', 'bin', 'public\samples', 'engines\tessdata', 'engines\tesseract')) {
  Write-Host ("  {0,-20} {1,8} MB" -f $part, [math]::Round((Get-TreeSize (Join-Path $stage $part)) / 1MB, 1))
}
Write-Host ("  {0,-20} {1,8} MB" -f 'TOTAL', [math]::Round((Get-TreeSize $stage) / 1MB, 1))
Write-Host "Staged at $stage"

if ($Installer) {
  Write-Host '=== Building the installer ==='
  # Same stderr caveat as above: electron-builder narrates its progress on stderr.
  $ErrorActionPreference = 'Continue'
  Push-Location $root
  try {
    npx electron-builder --win nsis 2>&1 | Select-Object -Last 20
    $builderExit = $LASTEXITCODE
  } finally { Pop-Location }
  $ErrorActionPreference = 'Stop'
  if ($builderExit -ne 0) { throw "electron-builder failed ($builderExit)" }

  $installer = Get-ChildItem (Join-Path $build 'installer') -Filter '*.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike 'Uninstall*' } | Select-Object -First 1
  if ($installer) {
    Write-Host ("Installer: {0} ({1} MB)" -f $installer.FullName, [math]::Round($installer.Length / 1MB, 1))
  } else {
    throw 'electron-builder reported success but produced no installer'
  }
}
