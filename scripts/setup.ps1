$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$DSWhaleRoot = Split-Path -Parent $PSScriptRoot
$DSWhaleUv = Join-Path $DSWhaleRoot '.runtime/tools/uv'
$env:PATH = "$DSWhaleUv;$env:PATH"
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    New-Item -ItemType Directory -Force $DSWhaleUv | Out-Null
    $DSWhaleScript = Join-Path $DSWhaleUv 'install.ps1'
    Invoke-WebRequest -UseBasicParsing 'https://astral.sh/uv/0.13.5/install.ps1' -OutFile $DSWhaleScript
    $env:UV_UNMANAGED_INSTALL = $DSWhaleUv
    & powershell -NoProfile -ExecutionPolicy Bypass -File $DSWhaleScript
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& uv run --no-project --python 3.12 --with filelock (Join-Path $DSWhaleRoot 'scripts/bootstrap.py')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
