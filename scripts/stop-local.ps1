param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][int]$KeepProcessId
)
$ErrorActionPreference = 'Stop'
$projectPath = (Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd('\').Replace('/', '\').ToLowerInvariant() + '\'
$processes = @(Get-CimInstance Win32_Process)
$protected = [System.Collections.Generic.HashSet[int]]::new()
$cursor = $PID
while ($cursor -gt 0 -and $protected.Add($cursor)) {
    $entry = $processes | Where-Object ProcessId -eq $cursor | Select-Object -First 1
    if (-not $entry) { break }
    $cursor = [int]$entry.ParentProcessId
}
[void]$protected.Add($KeepProcessId)
$targets = [System.Collections.Generic.HashSet[int]]::new()
foreach ($entry in $processes) {
    $line = ([string]$entry.CommandLine).Replace('/', '\').ToLowerInvariant()
    if ($entry.Name -in @('node.exe', 'postgres.exe', 'pg_ctl.exe', 'initdb.exe') -and $line.Contains($projectPath) -and -not $protected.Contains([int]$entry.ProcessId)) {
        [void]$targets.Add([int]$entry.ProcessId)
    }
}
# Launchers invoked with relative paths are identified by project-owned locks.
foreach ($file in @('local-start.lock.json', 'frontend-build.lock.json')) {
    $lockPath = Join-Path $ProjectRoot ('.runtime\' + $file)
    if (Test-Path -LiteralPath $lockPath) {
        $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
        $entry = $processes | Where-Object ProcessId -eq $lock.pid | Select-Object -First 1
        if ($entry.Name -eq 'node.exe' -and $entry.CommandLine -match '(local-start|frontend-build)\.mjs' -and -not $protected.Contains([int]$entry.ProcessId)) {
            [void]$targets.Add([int]$entry.ProcessId)
        }
    }
}
do {
    $added = $false
    foreach ($entry in $processes) {
        if ($targets.Contains([int]$entry.ParentProcessId) -and -not $protected.Contains([int]$entry.ProcessId)) {
            if ($targets.Add([int]$entry.ProcessId)) { $added = $true }
        }
    }
} while ($added)
foreach ($targetId in $targets) {
    # Recheck creation time so a recycled PID cannot stop an unrelated process.
    $original = $processes | Where-Object ProcessId -eq $targetId | Select-Object -First 1
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $targetId"
    if ($current -and $current.CreationDate -eq $original.CreationDate) {
        Stop-Process -Id $targetId -Force -ErrorAction SilentlyContinue
    }
}
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$creationDates = @{}
foreach ($entry in $processes) { $creationDates[[int]$entry.ProcessId] = $entry.CreationDate }
do {
    $remaining = @(Get-CimInstance Win32_Process | Where-Object { $targets.Contains([int]$_.ProcessId) -and $_.CreationDate -eq $creationDates[[int]$_.ProcessId] })
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
if ($remaining.Count -gt 0) { throw 'Project processes did not stop; rebuild aborted.' }
Write-Output "Stopped $($targets.Count) project processes."
