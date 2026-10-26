$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$DSWhaleRoot = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw 'Install uv first: https://docs.astral.sh/uv/getting-started/installation/'
}
& uv run --no-project --python 3.12 (Join-Path $DSWhaleRoot 'scripts/bootstrap.py')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
