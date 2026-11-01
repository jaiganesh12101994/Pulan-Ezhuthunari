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
    pip           the installer, so the app can add a package at run time
    claude-agent-sdk
                  the Claude subscription transport, and the Claude Code CLI it ships

  claude-agent-sdk is by far the largest thing here: a 149 MB wheel that unpacks to a
  ~320 MB `_bundled/claude.exe`. It is what makes the installer ~590 MB rather than
  ~230 MB, and it is bundled because the Claude subscription cannot work without it - it
  is the transport the app talks to Claude Code through, not an optional extra - and
  because fetching it at run time meant a 360 MB download on first use. Pass
  -WithoutClaudeSdk for the smaller build; the sign-in panel can then install it on
  demand instead.

  pip is worth having even with the SDK bundled: it is what lets that panel add or repair
  the package, and it is the only way the app can install anything into itself at all,
  since the embeddable distribution ships neither pip nor ensurepip to bootstrap it from.

  Torch, transformers and friends are deliberately absent: the Surya / Chandra /
  gnana70 engines in backend/tamil_ocr_engine.py are Tesseract pipelines with their own
  preprocessing, so no model weights or ML frameworks are involved.

  Run once (or again to pick up new package versions):
      powershell -ExecutionPolicy Bypass -File scripts\prepare-python.ps1
#>
[CmdletBinding()]
param(
  [string] $PythonVersion = '3.11.9',
  [string] $Target,
  # Leave the Claude Agent SDK out: a ~360 MB smaller installer, with the sign-in panel
  # installing it on demand instead.
  [switch] $WithoutClaudeSdk
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

# 4. pip itself. Even with the Claude Agent SDK bundled, pip is what lets the sign-in
#    panel add or repair it, and the embeddable distribution ships neither pip nor
#    ensurepip to bootstrap it from, so it comes from the system pip like the packages
#    above; --upgrade keeps a re-run from warning about the script directory the previous
#    run left behind.
python -m pip install --target $sitePackages --only-binary=:all: --upgrade `
  --no-warn-script-location pip
$pipSelfExit = $LASTEXITCODE

# 5. The Claude subscription. The Agent SDK is the transport the app talks to Claude Code
#    through, and its wheel carries the Claude Code CLI - the 320 MB that makes this the
#    biggest thing in the installer. Both halves have to be here for the engine to work
#    out of the box, which is the reason it is bundled rather than fetched on first use.
if (-not $WithoutClaudeSdk) {
  python -m pip install --target $sitePackages --only-binary=:all: `
    --no-warn-script-location claude-agent-sdk
  $sdkExit = $LASTEXITCODE
}

# 6. Prove it works before anything is packaged around it.
$py = Join-Path $Target 'python.exe'
& $py -c "import PIL, numpy, cv2, pytesseract, docx; print('  Pillow', PIL.__version__, '| numpy', numpy.__version__, '| OpenCV', cv2.__version__, '| pytesseract', pytesseract.__version__, '| python-docx ok')"
$probeExit = $LASTEXITCODE
& $py -m pip --version
$pipProbeExit = $LASTEXITCODE
if (-not $WithoutClaudeSdk) {
  # Exits non-zero when the CLI is missing, because an SDK without it cannot sign in.
  & $py -c "import claude_agent_sdk, importlib.metadata as m, os, sys; d = os.path.dirname(claude_agent_sdk.__file__); p = os.path.join(d, '_bundled', 'claude.exe'); ok = os.path.isfile(p); print('  claude-agent-sdk', m.version('claude-agent-sdk'), '| claude.exe', (str(round(os.path.getsize(p) / 1048576, 1)) + ' MB') if ok else 'MISSING'); sys.exit(0 if ok else 1)"
  $sdkProbeExit = $LASTEXITCODE
}
$ErrorActionPreference = 'Stop'

if ($pipExit -ne 0) { throw "pip failed with exit code $pipExit" }
if ($pipSelfExit -ne 0) { throw "installing pip into the runtime failed with exit code $pipSelfExit" }
if ($probeExit -ne 0) { throw 'the embedded Python cannot import the OCR dependencies' }
if ($pipProbeExit -ne 0) { throw 'the embedded Python has no pip, so the in-app install button could not work' }
if (-not $WithoutClaudeSdk) {
  if ($sdkExit -ne 0) { throw "installing claude-agent-sdk failed with exit code $sdkExit" }
  if ($sdkProbeExit -ne 0) { throw 'the embedded Python has no usable claude-agent-sdk, or no bundled Claude Code CLI with it' }
}

$size = (Get-ChildItem $Target -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("Python runtime ready: {0} MB" -f [math]::Round($size / 1MB, 1))
