param(
  [int]$Port = 5173,
  [switch]$NoPause,
  [switch]$SkipServerCheck
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$localUrl = "http://localhost:$Port"
$ngrokPidPath = Join-Path $root "ngrok.pid"
$ngrokUrlPath = Join-Path $root "ngrok-url.txt"
$ngrokLog = Join-Path $root "ngrok.log"
$ngrokErr = Join-Path $root "ngrok.err.log"
$envPath = Join-Path $root ".env.local"

function Pause-IfNeeded {
  if (-not $NoPause) {
    Read-Host "Press Enter to close"
  }
}

function Stop-ExistingProcess($pidPath) {
  if (-not (Test-Path -LiteralPath $pidPath)) { return }
  $rawPid = Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $rawPid) { return }
  try {
    Stop-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue
  } catch {}
}

function Read-EnvValue($name) {
  if (-not (Test-Path -LiteralPath $envPath)) { return $null }
  $escapedName = [regex]::Escape($name)
  $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match "^\s*$escapedName\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace "^\s*$escapedName\s*=", "").Trim().Trim('"').Trim("'")
}

function Find-Ngrok {
  $command = Get-Command ngrok -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  if ($env:LOCALAPPDATA) {
    $wingetPath = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe\ngrok.exe"
    if (Test-Path -LiteralPath $wingetPath) { return $wingetPath }
  }

  return $null
}

function Test-LocalServer {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$localUrl/api/config" -TimeoutSec 3 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Wait-ForNgrokUrl {
  for ($i = 0; $i -lt 25; $i += 1) {
    Start-Sleep -Seconds 1
    try {
      $json = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 3
      $url = $json.tunnels | Where-Object { $_.public_url -like "https://*" } | Select-Object -First 1 -ExpandProperty public_url
      if ($url) { return $url }
    } catch {}
  }
  return $null
}

Set-Location -LiteralPath $root

Write-Host ""
Write-Host "Starting Street Smart ngrok tunnel..." -ForegroundColor Cyan

if (-not $SkipServerCheck -and -not (Test-LocalServer)) {
  Write-Host "Street Smart is not responding on $localUrl." -ForegroundColor Red
  Write-Host "Start the main server first with Start-StreetSmart.bat or npm start, then run this script again."
  Pause-IfNeeded
  exit 1
}

$ngrok = Find-Ngrok
if (-not $ngrok) {
  Write-Host "ngrok was not found on PATH." -ForegroundColor Red
  Pause-IfNeeded
  exit 1
}

$token = Read-EnvValue "NGROK_AUTHTOKEN"
if (-not $token) {
  Write-Host "NGROK_AUTHTOKEN was not found in .env.local." -ForegroundColor Red
  Pause-IfNeeded
  exit 1
}

& $ngrok config add-authtoken $token | Out-Null
Stop-ExistingProcess $ngrokPidPath

$ngrokProcess = Start-Process -FilePath $ngrok -ArgumentList "http", "$Port", "--log=stdout" -WorkingDirectory $root -RedirectStandardOutput $ngrokLog -RedirectStandardError $ngrokErr -PassThru
$ngrokProcess.Id | Set-Content -LiteralPath $ngrokPidPath

$publicUrl = Wait-ForNgrokUrl
if ($publicUrl) {
  $publicUrl | Set-Content -LiteralPath $ngrokUrlPath
  Write-Host "Phone URL: $publicUrl" -ForegroundColor Green
  Write-Host "Saved to: $ngrokUrlPath"
} else {
  Write-Host "ngrok started, but no public URL was reported yet." -ForegroundColor Yellow
  Write-Host "Check: $ngrokErr"
}

Write-Host ""
Write-Host "This tunnel forwards to $localUrl. Keep the main server running while using it."
Pause-IfNeeded
