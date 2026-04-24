$ErrorActionPreference = "SilentlyContinue"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

foreach ($file in @("street-smart-server.pid", "ngrok.pid")) {
  $path = Join-Path $root $file
  if (Test-Path -LiteralPath $path) {
    $rawPid = Get-Content -LiteralPath $path | Select-Object -First 1
    if ($rawPid) {
      Stop-Process -Id ([int]$rawPid)
      Write-Host "Stopped PID $rawPid from $file"
    }
  }
}

Read-Host "Press Enter to close"
