param([string]$Kind, [string]$Payload, [string]$Target, [int]$AppProcess, [switch]$Elevated)
$ErrorActionPreference = 'Stop'
$jobDir = Split-Path -Parent $MyInvocation.MyCommand.Path
function Write-InstallLog($Message) {
  [IO.File]::AppendAllText((Join-Path $jobDir 'install.log'), "$Message`r`n")
}
function Get-ChildPath($Parent, $Name) {
  $root = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $path = [IO.Path]::GetFullPath((Join-Path $Parent $Name))
  if (!$path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw "Invalid path: $path" }
  return $path
}
function Move-InstalledEntry($Source, $Destination) {
  # The main process can exit before Chromium releases its DLLs.
  for ($attempt = 0; ; $attempt++) {
    try {
      Move-Item -LiteralPath $Source -Destination $Destination
      return
    } catch [IO.IOException] {
      if ($attempt -ge 40) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
}
try {
  if ((Split-Path -Leaf $jobDir) -notlike 'electerm-update-*' -or
      !$Payload.StartsWith(($jobDir + '\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Invalid updater staging directory'
  }
  if ($AppProcess -gt 0) {
    Write-InstallLog "Waiting for Electerm ($AppProcess)"
    $app = Get-Process -Id $AppProcess -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText((Join-Path $jobDir 'ready'), 'ready')
    if ($app -and !$app.WaitForExit(120000)) { throw 'Timed out waiting for Electerm to close' }
  }
  if ($Kind -eq 'exe') {
    Write-InstallLog "Installing $Payload"
    # NSIS supports /D as its final, unquoted argument, including spaces.
    $installDir = Split-Path -Parent $Target
    $p = Start-Process -FilePath $Payload -ArgumentList ("/S /D=" + $installDir) -PassThru
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { throw "Installer exited with code $($p.ExitCode)" }
    Write-InstallLog "Starting $Target"
    Start-Process -FilePath $Target -WorkingDirectory $installDir
  } elseif ($Kind -eq 'tar.gz') {
    $stage = Get-ChildPath $Target ('.electerm-update-' + [Guid]::NewGuid())
    try {
      [IO.Directory]::CreateDirectory($stage) | Out-Null
    } catch [UnauthorizedAccessException] {
      if ($Elevated) { throw }
      $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy Bypass', '-File',
        ('"' + $MyInvocation.MyCommand.Path + '"'), $Kind, ('"' + $Payload + '"'), ('"' + $Target + '"'), '0', '-Elevated')
      $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
      if ($p.ExitCode -ne 0) { throw 'Elevated installation failed' }
      Start-Process -FilePath (Get-ChildPath $Target 'electerm.exe') -WorkingDirectory $Target
      $stage = $null
    }
    if ($stage) {
      $fresh = Get-ChildPath $stage 'new'
      $backup = Get-ChildPath $stage 'old'
      [IO.Directory]::CreateDirectory($backup) | Out-Null
      Copy-Item -LiteralPath $Payload -Destination $fresh -Recurse -Force
      $installed = @()
      $lockPath = Get-ChildPath $Target '.electerm-update.lock'
      $lock = New-Object IO.FileStream($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
        [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose)
      try {
        foreach ($item in Get-ChildItem -LiteralPath $fresh -Force) {
          if ($item.Name -eq 'electerm') { throw 'Archive conflicts with portable profile' }
          $dest = Get-ChildPath $Target $item.Name
          if (Test-Path -LiteralPath $dest) { Move-InstalledEntry $dest $backup }
          Move-Item -LiteralPath $item.FullName -Destination $dest
          $installed += $item.Name
        }
      } catch {
        foreach ($name in $installed) {
          Move-Item -LiteralPath (Get-ChildPath $Target $name) -Destination $fresh
        }
        foreach ($old in Get-ChildItem -LiteralPath $backup -Force) {
          Move-Item -LiteralPath $old.FullName -Destination $Target
        }
        throw
      } finally {
        $lock.Dispose()
      }
      Remove-Item -LiteralPath $stage -Recurse -Force
      if (!$Elevated) {
        Start-Process -FilePath (Get-ChildPath $Target 'electerm.exe') -WorkingDirectory $Target
      }
    }
  } else { throw "Unsupported package: $Kind" }
  # PowerShell still owns install.log while it is running.
  if ($Elevated) { exit 0 }
  foreach ($item in Get-ChildItem -LiteralPath $jobDir -Force) {
    if ($item.Name -notin @('install.log', 'bootstrap.log')) {
      Remove-Item -LiteralPath (Get-ChildPath $jobDir $item.Name) -Force -Recurse
    }
  }
} catch {
  $detail = $_.Exception.Message
  $title = Get-Content -LiteralPath (Join-Path $jobDir 'title.txt') -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  $failed = Get-Content -LiteralPath (Join-Path $jobDir 'failure.txt') -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  $message = "$failed - $detail"
  Write-InstallLog $message
  # The caller is still open and displays startup failures itself.
  if ($AppProcess -gt 0 -and !(Test-Path -LiteralPath (Join-Path $jobDir 'ready'))) { exit 1 }
  Add-Type -AssemblyName System.Windows.Forms
  [Windows.Forms.MessageBox]::Show($message, $title) | Out-Null
  exit 1
}
