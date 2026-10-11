# Runs Coco Voice and restarts it if it crashes. Used by the autostart task.
# Logs: %USERPROFILE%\.coco-voice\server.log (rotated at 10 MB on each start, 3 old copies kept)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$data = Join-Path $env:USERPROFILE '.coco-voice'
Set-Location $here
New-Item -ItemType Directory -Force $data | Out-Null
$log = Join-Path $data 'server.log'
while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 10MB) {
    foreach ($n in 2, 1) { if (Test-Path "$log.$n") { Move-Item -Force "$log.$n" "$log.$($n + 1)" } }
    Move-Item -Force $log "$log.1"
  }
  node server.js *>> $log
  Start-Sleep -Seconds 5
}
