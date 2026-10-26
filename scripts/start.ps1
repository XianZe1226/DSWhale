$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$DSWhaleRoot = Split-Path -Parent $PSScriptRoot
$DSWhalePython = Join-Path $DSWhaleRoot '.runtime/venv/Scripts/python.exe'
if (-not (Test-Path $DSWhalePython)) { throw 'Run scripts/setup.ps1 first.' }
$env:ASTRBOT_ROOT = Join-Path $DSWhaleRoot '.runtime/astrbot'
Push-Location $env:ASTRBOT_ROOT
try {
    & $DSWhalePython -m astrbot.cli run
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
