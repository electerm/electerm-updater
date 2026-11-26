param([string]$JobDir)
$ErrorActionPreference = 'Stop'
# Start in the caller's Windows session, outside Node's kill-on-exit job.
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = 0
$result = ([wmiclass]'Win32_Process').Create($env:ELECTERM_INSTALL_COMMAND, $JobDir, $startup)
if ($result.ReturnValue -ne 0) { throw "Cannot start installer (WMI $($result.ReturnValue))" }
$helper = [Diagnostics.Process]::GetProcessById($result.ProcessId)
$helper.WaitForExit()
exit $helper.ExitCode
