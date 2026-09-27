<#
.SYNOPSIS
  M5: sample CPU usage of bun/node/powershell processes over a fixed window,
  to compare the cost of N tiles with and without an operator statusLine (and,
  once available, with the "Afficher le modele et le remplissage du contexte"
  setting disabled).

.DESCRIPTION
  Run this AFTER the Deck is already open with N tiles live and stable (not
  during startup), for the configuration you want to measure. It samples
  Get-Counter for '% Processor Time' on every bun.exe / node.exe / claude.exe
  / powershell.exe / pwsh.exe process once a second for -Seconds seconds
  (default 300 = 5 minutes), then prints per-process-name average and peak,
  and total. Run it once per configuration (with operator statusLine, without,
  setting disabled) and compare the three JSON reports it writes under -Out.

.PARAMETER Seconds
  Sampling window length (default 300).

.PARAMETER Label
  Free-text label for this run, embedded in the report filename and content
  (e.g. "8-tiles-with-statusline"). Required so the three runs don't overwrite
  each other.

.PARAMETER Out
  Output directory for the report (default: sibling .\out\).

.EXAMPLE
  pwsh -File .\cpu-sample.ps1 -Label "8-tiles-with-statusline" -Seconds 300
  pwsh -File .\cpu-sample.ps1 -Label "8-tiles-without-statusline" -Seconds 300
  pwsh -File .\cpu-sample.ps1 -Label "8-tiles-feature-disabled" -Seconds 300
#>
param(
  [int]$Seconds = 300,
  [Parameter(Mandatory = $true)][string]$Label,
  [string]$Out = (Join-Path $PSScriptRoot 'out')
)

New-Item -ItemType Directory -Force -Path $Out | Out-Null

$names = 'bun', 'node', 'claude', 'powershell', 'pwsh'
$samples = @{}
$missingTicks = @{}
foreach ($n in $names) { $samples[$n] = @(); $missingTicks[$n] = 0 }

Write-Host "Sampling for $Seconds s, label '$Label'. Leave the Deck alone (idle tiles, no typing) for a clean reading."
$deadline = (Get-Date).AddSeconds($Seconds)
$tick = 0
while ((Get-Date) -lt $deadline) {
  $tick++
  foreach ($n in $names) {
    $procs = Get-Process -Name $n -ErrorAction SilentlyContinue
    if (-not $procs) { continue }
    # Get-Process's own CPU property is cumulative seconds, not instantaneous
    # load; Get-Counter gives the instantaneous per-process % (may exceed
    # 100% on a multi-core box for a single process, which is expected).
    foreach ($p in $procs) {
      try {
        $counterPath = "\Process($($p.ProcessName)*)\% Processor Time"
        $c = (Get-Counter -Counter $counterPath -ErrorAction Stop).CounterSamples |
          Where-Object { $_.InstanceName -notmatch '_total|idle' }
        $sum = ($c | Measure-Object -Property CookedValue -Sum).Sum
        $samples[$n] += $sum
      } catch {
        # Counter unavailable this tick (process exited between Get-Process and
        # Get-Counter, or the perf-counter DB is stale): record the tick as
        # missing rather than silently treating it as 0%, which would understate
        # avgPct, and surface it so a run with many misses is not read as clean.
        Write-Warning "tick $tick`: '% Processor Time' counter unavailable for $($p.ProcessName) (pid $($p.Id))"
        $missingTicks[$n] += 1
      }
    }
  }
  Start-Sleep -Seconds 1
}

$report = @{}
foreach ($n in $names) {
  $vals = $samples[$n]
  if ($vals.Count -eq 0) { $report[$n] = @{ present = $false }; continue }
  $report[$n] = @{
    present      = $true
    samples      = $vals.Count
    missingTicks = $missingTicks[$n]
    avgPct       = [math]::Round(($vals | Measure-Object -Average).Average, 1)
    maxPct       = [math]::Round(($vals | Measure-Object -Maximum).Maximum, 1)
  }
}

$reportPath = Join-Path $Out ("cpu-sample-$Label-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
@{ label = $Label; seconds = $Seconds; perProcessName = $report } | ConvertTo-Json -Depth 5 |
  Set-Content -Path $reportPath -Encoding utf8

Write-Host "`n--- $Label ---"
foreach ($n in $names) {
  $r = $report[$n]
  if ($r.present) {
    Write-Host ("  {0,-12} avg={1,6}% max={2,6}% ({3} samples, {4} missing ticks)" -f $n, $r.avgPct, $r.maxPct, $r.samples, $r.missingTicks)
  } else {
    Write-Host ("  {0,-12} not running" -f $n)
  }
}
Write-Host "`nfull report: $reportPath"
Write-Host "Record the '--- $Label ---' block above (or the JSON) in the Resultats section."
