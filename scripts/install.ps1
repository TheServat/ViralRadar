<#
.SYNOPSIS
  One-shot installer for Viral Radar on Windows.

.DESCRIPTION
  Installs dependencies, builds the dashboard, creates .env from the template
  if it is missing, and puts a shortcut on the desktop. Safe to run again: it
  changes nothing that is already correct, and it never overwrites an existing
  .env.

.PARAMETER Autostart
  Also register a scheduled task so the radar starts when you log in. Off by
  default: something that collects data in the background should be an explicit
  choice, not a side effect of installing.

.PARAMETER NoShortcut
  Skip creating the desktop shortcut.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Autostart
#>
param(
  [switch]$Autostart,
  [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Write-Step($text) { Write-Host "`n  $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  $([char]0x2713) $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  ! $text" -ForegroundColor Yellow }

Write-Host "`n  Viral Radar - installer" -ForegroundColor White
Write-Host "  $root`n" -ForegroundColor DarkGray

# ── Node ────────────────────────────────────────────────────────────────────
Write-Step 'Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  Write-Host "`n  Node.js is not installed, or not on PATH." -ForegroundColor Red
  Write-Host "  Install Node.js 24 or newer from https://nodejs.org and run this again.`n"
  exit 1
}

$version = (& node --version).TrimStart('v')
$major = [int]($version.Split('.')[0])
if ($major -lt 24) {
  # node:sqlite and native TypeScript execution both need 24; there is no
  # workaround worth offering, so say so plainly rather than failing later.
  Write-Host "`n  Node.js $version found, but 24 or newer is required." -ForegroundColor Red
  Write-Host "  Viral Radar uses Node's built-in SQLite and TypeScript support.`n"
  exit 1
}
Write-Ok "Node.js $version"

# ── Dependencies ────────────────────────────────────────────────────────────
Set-Location $root

Write-Step 'Installing dependencies'
# One workspace install covers both apps.
& npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
Write-Ok 'Dependencies installed'

# ── Configuration ───────────────────────────────────────────────────────────
Write-Step 'Checking configuration'
$envPath = Join-Path $root '.env'
if (Test-Path $envPath) {
  Write-Ok '.env already exists and was left alone'
} else {
  Copy-Item (Join-Path $root '.env.example') $envPath
  Write-Ok '.env created from the template'
  Write-Warn 'Open the Settings page after starting to add your API keys'
}

# ── Build ───────────────────────────────────────────────────────────────────
Write-Step 'Building the dashboard'
& npm run build
if ($LASTEXITCODE -ne 0) { throw 'dashboard build failed' }
Write-Ok 'Dashboard built'

# ── Shortcut ────────────────────────────────────────────────────────────────
if (-not $NoShortcut) {
  Write-Step 'Creating the desktop shortcut'
  $shell = New-Object -ComObject WScript.Shell
  $linkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Viral Radar.lnk'
  $link = $shell.CreateShortcut($linkPath)
  $link.TargetPath = Join-Path $root 'scripts\radar.cmd'
  $link.WorkingDirectory = $root
  $link.Description = 'What is exploding on the internet right now'
  $link.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,13"
  $link.Save()
  Write-Ok "Shortcut created: $linkPath"
}

# ── Autostart ───────────────────────────────────────────────────────────────
if ($Autostart) {
  Write-Step 'Registering autostart'
  $taskName = 'ViralRadar'
  $action = New-ScheduledTaskAction -Execute 'node.exe' `
    -Argument 'apps/api/src/main.ts serve' -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
  try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
      -Settings $settings -Description 'Viral Radar background collection' | Out-Null
    Write-Ok "Autostart registered as the scheduled task '$taskName'"
    Write-Warn "Remove it any time with: Unregister-ScheduledTask -TaskName $taskName"
  } catch {
    Write-Warn "Could not register autostart: $($_.Exception.Message)"
    Write-Warn 'Run this installer from an elevated PowerShell if you want autostart.'
  }
}

# ── Done ────────────────────────────────────────────────────────────────────
Write-Host "`n  Installed.`n" -ForegroundColor Green
Write-Host "  Start it:   double-click 'Viral Radar' on the desktop"
Write-Host "              or run: npm start"
Write-Host "  Dashboard:  http://127.0.0.1:7788"
Write-Host "  Check it:   npm run doctor`n"
Write-Host "  Growth needs two measurements, so give it about 40 minutes" -ForegroundColor DarkGray
Write-Host "  before judging the results.`n" -ForegroundColor DarkGray
