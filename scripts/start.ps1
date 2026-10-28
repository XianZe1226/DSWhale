param([switch]$Bili)
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$DSWhaleRoot = Split-Path -Parent $PSScriptRoot
$DSWhalePython = Join-Path $DSWhaleRoot '.runtime/venv/Scripts/python.exe'
if (-not (Test-Path $DSWhalePython)) { throw 'Run Install.cmd first.' }
$DSWhaleArguments = @((Join-Path $DSWhaleRoot 'scripts/launch.py'))
if ($Bili) { $DSWhaleArguments += '--bili' }
& $DSWhalePython @DSWhaleArguments
exit $LASTEXITCODE
