# scripts/apply-hosts.ps1 — put docs/ctrls-hosts into the SYSTEM hosts file.
#
#   npm run hosts:apply        (from an ELEVATED PowerShell)
#
# Why this script exists: the entries live in the repo so they are versioned and
# shared, but a file in a repo resolves nothing. The OS reads exactly one file —
# C:\Windows\System32\drivers\etc\hosts — so something has to copy them across.
#
# Idempotent: an entry already present is skipped, so running it twice cannot
# produce duplicate lines (duplicates are worse than missing ones — most
# resolvers take the first match, so a stale duplicate silently wins).

$ErrorActionPreference = "Stop"
$hostsPath = Join-Path $env:WINDIR "System32\drivers\etc\hosts"
$source = Join-Path $PSScriptRoot "..\docs\ctrls-hosts"

if (-not (Test-Path $source)) { Write-Error "missing $source"; exit 1 }

# Elevation check up front: without it Add-Content fails with a bare access
# denied, which reads like the entries were written when they were not.
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([Security.Principal.WindowsPrincipal] $id).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  $root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  Write-Host "Not running as Administrator." -ForegroundColor Yellow
  Write-Host "The hosts file is system-owned, so this needs an elevated shell:"
  Write-Host "  1. Start menu -> type 'PowerShell' -> Run as administrator"
  Write-Host "  2. cd '$root'"
  Write-Host "  3. npm run hosts:apply"
  exit 1
}

# Only real entries — comments and blank lines carry nothing to resolve.
$entries = Get-Content $source | Where-Object { $_ -match '^\s*\d{1,3}(\.\d{1,3}){3}\s+\S' }

# Every hostname already mapped by an ACTIVE line in the system file.
$mapped = New-Object System.Collections.Generic.HashSet[string]
foreach ($line in (Get-Content $hostsPath -ErrorAction SilentlyContinue)) {
  if ($line -match '^\s*#') { continue }
  $tok = ($line -split '\s+') | Where-Object { $_ }
  if ($tok.Count -lt 2) { continue }
  foreach ($n in $tok[1..($tok.Count - 1)]) { [void]$mapped.Add($n.ToLower()) }
}

$toAdd = @(); $skipped = 0
foreach ($line in $entries) {
  $tok = ($line -split '\s+') | Where-Object { $_ }
  $names = $tok[1..($tok.Count - 1)]
  $have = $false
  foreach ($n in $names) { if ($mapped.Contains($n.ToLower())) { $have = $true; break } }
  if ($have) {
    $skipped++
    Write-Host "  skip  $($names -join ', ')  (already mapped)"
  } else {
    $toAdd += $line.Trim()
    Write-Host "  add   $($names -join ', ')" -ForegroundColor Green
  }
}

if ($toAdd.Count -gt 0) {
  Add-Content -Path $hostsPath -Value (@("", "# --- text2UI: docs/ctrls-hosts ---") + $toAdd)
  ipconfig /flushdns | Out-Null
  Write-Host ""
  Write-Host "$($toAdd.Count) line(s) added, $skipped already present. DNS cache flushed." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "Nothing to do - all $skipped line(s) already present." -ForegroundColor Green
}
Write-Host "Try: https://flowopsuat.ctrls.in"
