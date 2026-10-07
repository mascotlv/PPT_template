$projectRoot = Split-Path -Parent $PSScriptRoot
$env:COREPACK_HOME = Join-Path $projectRoot '.cache\corepack'
$env:npm_config_cache = Join-Path $projectRoot '.cache\npm'
$env:TEMP = Join-Path $projectRoot '.cache\tmp'
$env:TMP = $env:TEMP
$env:NEXT_TELEMETRY_DISABLED = '1'
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
& corepack.cmd pnpm @args
exit $LASTEXITCODE
