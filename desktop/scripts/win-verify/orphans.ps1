<#
.SYNOPSIS
  M4: leftover-process check after a slow, repeatedly-cancelled operator
  statusLine.

.DESCRIPTION
  Points CLAUDE_CONFIG_DIR at a temporary directory whose global settings.json
  configures a statusLine command that sleeps 300 seconds, then fires the
  built statusLine hook (desk-statusline.mjs) several times in a row with no
  wait in between -- simulating Claude Code cancelling one statusLine refresh
  and starting the next (its actual refreshInterval is 5s in a Deck tile, so
  a run outlasting that window is exactly the case installCancelHandlers is
  for). Each invocation gets SIGTERM'd almost immediately, mirroring Claude
  Code's own cancel-on-refresh behavior. After 1 minute, lists any process
  whose command line still points at the temp CLAUDE_CONFIG_DIR or at the
  sleep command, which would mean a killTree() gap left something running.

.PARAMETER Out
  Output directory for the report (default: sibling .\out\).

.EXAMPLE
  pwsh -File .\orphans.ps1
  powershell -File .\orphans.ps1 -Out C:\temp\win-verify-out
#>
param(
  [string]$Out = (Join-Path $PSScriptRoot 'out')
)

New-Item -ItemType Directory -Force -Path $Out | Out-Null

$repoRoot = Resolve-Path "$PSScriptRoot\..\..\.."
$desktop = Join-Path $repoRoot 'desktop'
$hook = Join-Path $desktop 'deck-plugin\hooks\desk-statusline.mjs'

if (-not (Test-Path $hook)) {
  Write-Error "Built hook not found at $hook. Run: cd desktop; npm run build:hook"
  exit 2
}

$home_ = Join-Path $Out ("orphans-home-" + [guid]::NewGuid().ToString('N').Substring(0,8))
$cfgDir = Join-Path $home_ 'cfg'
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null

# A statusLine that sleeps 300s: it outlives the 60s count below, so a real
# orphan is still there to be counted, and it is still running when the next
# refresh cancels it, well past the hook's own 4s CHAIN_TIMEOUT_MS, so this
# exercises killTree() rather than the timeout path. The marker
# (KORY-ORPHANS-MARKER) is a distinctive token in this process's own command
# line, used below to detect that it actually started before killing the
# parent hook -- Start-Sleep alone is too generic to tell apart from an
# unrelated sleep on a busy box.
$marker = 'KORY-ORPHANS-MARKER'
$sleepCmd = "powershell -NoProfile -NonInteractive -Command `"# $marker`n Start-Sleep -Seconds 300`""
@{ statusLine = @{ type = 'command'; command = $sleepCmd } } | ConvertTo-Json -Depth 5 |
  Set-Content -Path (Join-Path $cfgDir 'settings.json') -Encoding utf8

$payload = '{"hook_event_name":"Status","session_id":"win-verify-m4","model":{"id":"claude-3-5-haiku-20241022","display_name":"Haiku"},"context_window":{"context_window_size":200000,"used_percentage":1}}'

# Waiting for the marker (or a floor of 1.5s) before killing: a fixed 300ms
# kill risked cutting the hook down before bun had even spawned the chained
# sleep process, in which case there is nothing for killTree() to leave
# behind and a PASS would prove nothing about the actual cleanup path.
$observeTimeoutMs = 4000
$floorMs = 1500

Write-Host "Firing the hook 6 times in a row, killing each once the chained process is observed (or after ${floorMs}ms, whichever is later; rapid refresh simulation)..."
$before = Get-Process | Where-Object { $_.ProcessName -match 'bun|powershell|node' } | Select-Object -ExpandProperty Id

for ($i = 0; $i -lt 6; $i++) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'bun'
  $psi.Arguments = "`"$hook`""
  $psi.RedirectStandardInput = $true
  $psi.UseShellExecute = $false
  $psi.EnvironmentVariables['CLAUDE_CONFIG_DIR'] = $cfgDir
  $psi.EnvironmentVariables['HOME'] = $home_
  $psi.EnvironmentVariables['USERPROFILE'] = $home_
  $psi.EnvironmentVariables['CLAUDE_PEERS_DESK_SESSION'] = 'win-verify-m4-tile'
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.StandardInput.Write($payload)
  $p.StandardInput.Close()

  $start = Get-Date
  $observed = $false
  while (((Get-Date) - $start).TotalMilliseconds -lt $observeTimeoutMs) {
    $seen = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($marker) }
    if ($seen) { $observed = $true; break }
    Start-Sleep -Milliseconds 100
  }
  $elapsedMs = ((Get-Date) - $start).TotalMilliseconds
  if ($elapsedMs -lt $floorMs) { Start-Sleep -Milliseconds ($floorMs - $elapsedMs) }
  if (-not $observed) {
    Write-Warning "run $i`: chained process (marker $marker) never observed within ${observeTimeoutMs}ms -- killing anyway after the ${floorMs}ms floor, but this run may not exercise killTree()."
  }

  # SIGTERM has no POSIX signal on Windows; Claude Code's own cancel is a
  # TerminateProcess (see desk-statusline.ts's own comment on this gap on
  # win32) -- Stop-Process reproduces that same abrupt kill.
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
}

Write-Host "Waiting 60s before counting leftovers..."
Start-Sleep -Seconds 60

$after = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and ($_.CommandLine -match [regex]::Escape($home_) -or $_.CommandLine -match [regex]::Escape($marker))
}

$report = $after | Select-Object ProcessId, Name, CommandLine
$reportPath = Join-Path $Out ("orphans-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
$report | ConvertTo-Json -Depth 5 | Set-Content -Path $reportPath -Encoding utf8

Write-Host "`nLeftover processes referencing this run's temp dir or the sleep command:"
if ($report.Count -eq 0) {
  Write-Host "  none (PASS)"
} else {
  $report | Format-Table -AutoSize
  Write-Host "  $($report.Count) leftover process(es) (FAIL) -- see $reportPath"
}

# Kill what was counted so a FAIL run does not leave 300s sleepers behind.
foreach ($proc in $after) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item -Recurse -Force $home_ -ErrorAction SilentlyContinue
Write-Host "`nfull report: $reportPath"
