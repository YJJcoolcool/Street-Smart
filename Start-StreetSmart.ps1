$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 5173
$localUrl = "http://localhost:$port"
$serverPidPath = Join-Path $root "street-smart-server.pid"
$ngrokPidPath = Join-Path $root "ngrok.pid"
$ngrokUrlPath = Join-Path $root "ngrok-url.txt"
$serverLog = Join-Path $root "street-smart-server.log"
$serverErr = Join-Path $root "street-smart-server.err.log"
$ngrokLog = Join-Path $root "ngrok.log"
$ngrokErr = Join-Path $root "ngrok.err.log"
$envPath = Join-Path $root ".env.local"

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
  $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace "^$name=", "").Trim().Trim('"').Trim("'")
}

function Find-Ngrok {
  $command = Get-Command ngrok -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $wingetPath = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe\ngrok.exe"
  if (Test-Path -LiteralPath $wingetPath) { return $wingetPath }

  return $null
}

function Wait-ForLocalServer {
  for ($i = 0; $i -lt 20; $i += 1) {
    Start-Sleep -Milliseconds 500
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$localUrl/api/config" -TimeoutSec 2 | Out-Null
      return $true
    } catch {}
  }
  return $false
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
Write-Host "Starting Street Smart..." -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js was not found on PATH. Install Node.js or start from a shell where node is available." -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}

Stop-ExistingProcess $serverPidPath
$server = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $root -RedirectStandardOutput $serverLog -RedirectStandardError $serverErr -PassThru
$server.Id | Set-Content -LiteralPath $serverPidPath

if (-not (Wait-ForLocalServer)) {
  Write-Host "Street Smart did not respond on $localUrl." -ForegroundColor Red
  Write-Host "Check: $serverErr"
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host "Local app: $localUrl" -ForegroundColor Green
Start-Process $localUrl

$ngrok = Find-Ngrok
$token = Read-EnvValue "NGROK_AUTHTOKEN"

if ($ngrok -and $token) {
  Write-Host "Starting ngrok tunnel..." -ForegroundColor Cyan
  & $ngrok config add-authtoken $token | Out-Null
  Stop-ExistingProcess $ngrokPidPath
  $ngrokProcess = Start-Process -FilePath $ngrok -ArgumentList "http", "$port", "--log=stdout" -WorkingDirectory $root -RedirectStandardOutput $ngrokLog -RedirectStandardError $ngrokErr -PassThru
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
} elseif (-not $ngrok) {
  Write-Host "ngrok was not found. Local app is running, but no phone URL was created." -ForegroundColor Yellow
} else {
  Write-Host "NGROK_AUTHTOKEN was not found in .env.local. Local app is running only." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Keep this window open while testing. Closing it will not stop the server automatically."
Write-Host "To stop later, run Stop-StreetSmart.bat if present, or stop the PIDs in street-smart-server.pid/ngrok.pid."
Read-Host "Press Enter to close this launcher window"
