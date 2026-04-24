param(
  [switch]$NoPause
)

$ErrorActionPreference = "SilentlyContinue"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidPath = Join-Path $root "ngrok.pid"

if (Test-Path -LiteralPath $pidPath) {
  $rawPid = Get-Content -LiteralPath $pidPath | Select-Object -First 1
  if ($rawPid) {
    Stop-Process -Id ([int]$rawPid)
    Write-Host "Stopped ngrok PID $rawPid"
  } else {
    Write-Host "No ngrok PID found."
  }
} else {
  Write-Host "No ngrok.pid file found."
}

if (-not $NoPause) {
  Read-Host "Press Enter to close"
}
