<#
  Builds the Python runtime that ships inside the desktop app.

  A machine that installs Pulan Tamil OCR is not expected to have Python, so the engine
  runs on a Python 3.11 *embeddable* distribution placed next to it, with only the
  packages the OCR code actually imports:

    Pillow        image loading, cropping, the pure-Pillow preprocessing fallbacks
    numpy         array maths used by the quality checks and the deskew
    OpenCV        ink binarisation and deskew (headless: no GUI libraries needed)
    pytesseract   the Tesseract CLI wrapper the engine drives
    python-docx   DOCX export (it needs lxml, which pip pulls in)

  Torch, transformers and friends are deliberately absent: the Surya / Chandra /
  gnana70 engines in backend/tamil_ocr_engine.py are Tesseract pipelines with their own
  preprocessing, so no model weights or ML frameworks are involved.

  Run once (or again to pick up new package versions):
      powershell -ExecutionPolicy Bypass -File scripts\prepare-python.ps1
#>
[CmdletBinding()]
param(
  [string] $PythonVersion = '3.11.9',
  [string] $Target
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
# Resolved here rather than in the param block: PowerShell 5.1 does not fill
# $PSScriptRoot until the script body runs.
if (-not $Target) { $Target = Join-Path $root 'build\python' }
$Target = [System.IO.Path]::GetFullPath($Target)

Write-Host "Preparing embedded Python $PythonVersion -> $Target"

if (Test-Path $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Target | Out-Null

# 1. The embeddable distribution (no installer, no registry entries)
$zip = Join-Path $env:TEMP "python-$PythonVersion-embed-amd64.zip"
if (-not (Test-Path $zip)) {
  $url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
  Write-Host "  downloading $url"
  Invoke-WebRequest $url -OutFile $zip -UseBasicParsing -TimeoutSec 600
}
Expand-Archive -Path $zip -DestinationPath $Target -Force
Write-Host "  extracted $((Get-ChildItem $Target -File).Count) files"

# 2. Let it see site-packages. The embeddable build ships a ._pth file that replaces
#    sys.path entirely, so without this line `import PIL` would fail no matter what
#    pip installed.
$pth = Get-ChildItem $Target -Filter 'python*._pth' | Select-Object -First 1
@(
  'python311.zip'
  '.'
  'Lib\site-packages'
  'import site'
) | Set-Content -Path $pth.FullName -Encoding ascii
Write-Host "  site-packages enabled in $($pth.Name)"

# 3. The packages. --target installs the wheels straight into the embedded runtime;
#    --only-binary keeps pip from trying to compile anything.
$sitePackages = Join-Path $Target 'Lib\site-packages'
# pip reports dependency conflicts with the *system* Python on stderr. Windows
# PowerShell turns native-command stderr into a terminating error under 'Stop', which
# would abort a build that actually succeeded, so relax it for these two calls and judge
# them by their exit code instead.
$ErrorActionPreference = 'Continue'
python -m pip install --target $sitePackages --only-binary=:all: --no-warn-script-location `
  pillow numpy opencv-python-headless pytesseract python-docx
$pipExit = $LASTEXITCODE

# 4. Prove it works before anything is packaged around it.
$py = Join-Path $Target 'python.exe'
& $py -c "import PIL, numpy, cv2, pytesseract, docx; print('  Pillow', PIL.__version__, '| numpy', numpy.__version__, '| OpenCV', cv2.__version__, '| pytesseract', pytesseract.__version__, '| python-docx ok')"
$probeExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'

if ($pipExit -ne 0) { throw "pip failed with exit code $pipExit" }
if ($probeExit -ne 0) { throw 'the embedded Python cannot import the OCR dependencies' }

$size = (Get-ChildItem $Target -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("Python runtime ready: {0} MB" -f [math]::Round($size / 1MB, 1))
