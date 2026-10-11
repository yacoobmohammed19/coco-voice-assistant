# Registers a per-user scheduled task so Coco Voice starts when you log in (no admin needed).
# Remove with:  Unregister-ScheduledTask -TaskName CocoVoice -Confirm:$false
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$here\start.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -StartWhenAvailable
Register-ScheduledTask -TaskName 'CocoVoice' -Action $action -Trigger $trigger -Settings $settings -Description 'Coco Voice assistant bridge (127.0.0.1:8787)' -Force | Out-Null
Start-ScheduledTask -TaskName 'CocoVoice'
Write-Host 'CocoVoice task registered and started.'
