# scripts/pack.ps1 - produce a clean, shippable text2UI.zip that NEVER includes
# secrets (.env) or local artifacts (node_modules, dist, bff/data).
#
# WHY THIS EXISTS: .gitignore does NOT govern manual zips, so .env has repeatedly
# shipped inside text2UI.zip. This script stages only safe files, then zips them,
# and aborts loudly if a secret slips through.
#
# USAGE (from the project root):
#   powershell -ExecutionPolicy Bypass -File scripts\pack.ps1

$ErrorActionPreference = "Stop"

$root   = Split-Path -Parent $PSScriptRoot
$stage  = Join-Path $env:TEMP ("text2UI_pack_" + [Guid]::NewGuid().ToString("N"))
$outZip = Join-Path $root "text2UI.zip"

# Directories excluded by full path; files excluded by name/pattern.
$excludeDirs = @("node_modules", "dist", ".git", "bff\data") | ForEach-Object { Join-Path $root $_ }

Write-Host "Staging clean copy at $stage ..."
robocopy $root $stage /E /XD @excludeDirs /XF .env .env.local .env.* *.log /NFL /NDL /NJH /NJS /NP | Out-Null
# robocopy success codes are 0-7; 8 or higher is a real failure.
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)" }

# Keep the template even though .env.* was excluded above.
Copy-Item (Join-Path $root ".env.example") (Join-Path $stage ".env.example") -Force -ErrorAction SilentlyContinue

# Hard guard: never package a real secret.
if (Test-Path (Join-Path $stage ".env")) {
    Remove-Item $stage -Recurse -Force
    throw "ABORT: .env present in staging copy. Packaging would leak the key."
}

if (Test-Path $outZip) { Remove-Item $outZip -Force }
Write-Host "Compressing to $outZip ..."
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $outZip -Force
Remove-Item $stage -Recurse -Force

# Post-check: scan the finished zip for any .env entry (should find none).
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($outZip)
$leaks = $zip.Entries | Where-Object {
    $_.FullName -match '(^|/)\.env($|\.)' -and $_.FullName -notmatch '\.env\.example$'
}
$zip.Dispose()
if ($leaks) {
    $leaks | ForEach-Object { Write-Host ("LEAK: " + $_.FullName) -ForegroundColor Red }
    throw "ABORT: secret-looking entries found in $outZip"
}

Write-Host "Done. Created $outZip (verified: no .env inside)" -ForegroundColor Green
