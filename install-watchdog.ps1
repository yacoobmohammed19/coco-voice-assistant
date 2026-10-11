# Registers the Coco watchdog: runs watchdog.ps1 every 5 minutes, fully hidden (via wscript, so no
# window flashes). Per-user, no admin needed.
# Remove with:  Unregister-ScheduledTask -TaskName CocoVoiceWatchdog -Confirm:$false
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $here 'watchdog-hidden.vbs'
Set-Content -Path $vbs -Encoding ascii -Value @"
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""$here\watchdog.ps1""", 0, False
"@
$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$every5   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$atLogon  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
Register-ScheduledTask -TaskName 'CocoVoiceWatchdog' -Action $action -Trigger @($every5, $atLogon) -Settings $settings -Description 'Keeps Coco Voice running: restarts it if it crashes, freezes or stops.' -Force | Out-Null
Write-Host 'CocoVoiceWatchdog registered (every 5 minutes).'
