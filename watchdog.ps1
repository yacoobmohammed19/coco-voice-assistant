# Coco watchdog: runs every 5 minutes (scheduled task "CocoVoiceWatchdog") and makes sure Coco is alive.
# - Startup task stopped (or never ran)?  -> start it.
# - Server not answering twice in a row (crashed or frozen)? -> kill it; start.ps1 brings it straight back.
# - Alerts by ntfy push when it had to step in (Telegram may be the thing that's down).
# Log: %USERPROFILE%\.coco-voice\watchdog.log
$ErrorActionPreference = 'SilentlyContinue'
$data  = Join-Path $env:USERPROFILE '.coco-voice'
$log   = Join-Path $data 'watchdog.log'
$state = Join-Path $data 'watchdog-fails.txt'
function Log($m) { Add-Content -Path $log -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $m) -Encoding utf8 }
function Push($title, $msg) {
  try {
    $cfg = Get-Content (Join-Path $data 'config.json') -Raw | ConvertFrom-Json
    if (-not $cfg.ntfyTopic) { return }
    $server = if ($cfg.ntfyServer) { $cfg.ntfyServer } else { 'https://ntfy.sh' }
    Invoke-RestMethod -Method Post -Uri "$server/$($cfg.ntfyTopic)" -Body $msg -Headers @{ Title = $title; Priority = 'high' } -TimeoutSec 10 | Out-Null
  } catch {}
}

# Keep the log small.
if ((Test-Path $log) -and (Get-Item $log).Length -gt 512KB) { Get-Content $log -Tail 500 | Set-Content $log -Encoding utf8 }

# 1. Is the startup loop (start.ps1) running at all?
$loop = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'coco-voice\\start\.ps1' }
if (-not $loop) {
  Log 'start.ps1 loop not running: starting the CocoVoice task'
  Start-ScheduledTask -TaskName 'CocoVoice'
  Push 'Coco restarted' 'Coco was not running, so the watchdog started it again.'
  Set-Content $state 0
  exit
}

# 2. Does the server answer?
$ok = $false
try { $r = Invoke-RestMethod 'http://127.0.0.1:8787/health' -TimeoutSec 15; $ok = [bool]$r.ok } catch {}
if ($ok) {
  if ((Get-Content $state) -ne '0') { Set-Content $state 0 }
  exit
}
$fails = [int](Get-Content $state) + 1
Set-Content $state $fails
Log "health check failed ($fails in a row)"
if ($fails -ge 2) {
  # Frozen or half-dead: kill whatever holds the port (and its children); start.ps1 restarts it in ~5s.
  $owner = (Get-NetTCPConnection -LocalPort 8787 -State Listen).OwningProcess | Select-Object -First 1
  if ($owner) { & taskkill.exe /PID $owner /T /F | Out-Null; Log "killed unresponsive server (pid $owner)" }
  else { Log 'nothing listening on 8787; start.ps1 should be restarting it' }
  Push 'Coco restarted' 'Coco stopped responding, so the watchdog restarted it.'
  Set-Content $state 0
}
