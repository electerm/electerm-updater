param([string]$Kind, [string]$Payload, [string]$Target, [int]$AppProcess, [switch]$Elevated)
$ErrorActionPreference = 'Stop'
$jobDir = Split-Path -Parent $MyInvocation.MyCommand.Path
function Get-ChildPath($Parent, $Name) {
  $root = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $path = [IO.Path]::GetFullPath((Join-Path $Parent $Name))
  if (!$path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw "Invalid path: $path" }
  return $path
}
try {
  if ((Split-Path -Leaf $jobDir) -notlike 'electerm-update-*' -or
      !$Payload.StartsWith(($jobDir + '\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Invalid updater staging directory'
  }
  if ($AppProcess -gt 0 -and (Get-Process -Id $AppProcess -ErrorAction SilentlyContinue)) {
    Wait-Process -Id $AppProcess -Timeout 120
  }
  if ($Kind -eq 'exe') {
    $p = Start-Process -FilePath $Payload -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "Installer exited with code $($p.ExitCode)" }
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
          if (Test-Path -LiteralPath $dest) { Move-Item -LiteralPath $dest -Destination $backup }
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
    if ($item.Name -ne 'install.log') {
      Remove-Item -LiteralPath (Get-ChildPath $jobDir $item.Name) -Force -Recurse
    }
  }
} catch {
  $message = "Electerm update failed: $($_.Exception.Message)"
  [Console]::Error.WriteLine($message)
  Add-Type -AssemblyName System.Windows.Forms
  [Windows.Forms.MessageBox]::Show($message, 'Electerm updater') | Out-Null
  exit 1
}
