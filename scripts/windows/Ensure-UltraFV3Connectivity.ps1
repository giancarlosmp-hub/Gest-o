#Requires -RunAsAdministrator
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$UltraFV3RestExecutable = "C:\UltraFV3Rest\UltraFV3Rest.exe",
  [string]$StateLog = "$env:ProgramData\Gest-o\ultrafv3-connectivity.log"
)
$ErrorActionPreference = "Stop"
$directory = Split-Path -Parent $StateLog
New-Item -ItemType Directory -Force -Path $directory | Out-Null

$service = Get-Service -Name "Tailscale" -ErrorAction Stop
Set-Service -Name "Tailscale" -StartupType Automatic
if ($service.Status -ne "Running") { Start-Service -Name "Tailscale" }
$peerState = if ((Get-Command tailscale.exe -ErrorAction SilentlyContinue) -and
  ((& tailscale.exe status --json 2>$null | ConvertFrom-Json).BackendState -eq "Running")) { "connected" } else { "disconnected" }

$processName = [IO.Path]::GetFileNameWithoutExtension($UltraFV3RestExecutable)
$rest = Get-Process -Name $processName -ErrorAction SilentlyContinue
if (-not $rest) {
  if (-not (Test-Path -LiteralPath $UltraFV3RestExecutable -PathType Leaf)) { throw "UltraFV3Rest executable is absent" }
  Start-Process -FilePath $UltraFV3RestExecutable -WorkingDirectory (Split-Path -Parent $UltraFV3RestExecutable)
  $restState = "started"
} else { $restState = "already_running" }

# Sanitized local state only: no peer IP, URL, token, arguments, payload, or credentials.
"{0} tailscaleService=running peer={1} ultraFV3Rest={2}" -f (Get-Date).ToUniversalTime().ToString("o"), $peerState, $restState |
  Add-Content -LiteralPath $StateLog -Encoding UTF8
