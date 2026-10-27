$ErrorActionPreference = 'Stop'
$consoleRoot = $PSScriptRoot
$env:OPENWORK_ELECTRON_REMOTE_DEBUG_PORT = '9223'
$consoleVersion = (Get-Content (Join-Path $consoleRoot 'package.json') -Raw | ConvertFrom-Json).version
$existing = $null
try {
    $existing = Invoke-RestMethod -Uri 'http://127.0.0.1:17866/api/state' -TimeoutSec 2 -NoProxy
    if ($existing.version -eq $consoleVersion -and $existing.catalog.Count -eq 44) { Write-Output 'http://127.0.0.1:17866'; exit 0 }
} catch {}
if ($null -ne $existing) {
    if ($existing.version -eq $consoleVersion -and $existing.catalog.Count -eq 44) { Write-Output 'http://127.0.0.1:17866'; exit 0 }
    throw 'Port 17866 already hosts another console version. Restart it when idle before upgrading.'
}
$nodePath = (Get-Command node.exe).Source
Start-Process -FilePath $nodePath -ArgumentList 'server.mjs' -WorkingDirectory $consoleRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $consoleRoot 'data/server.stdout.log') -RedirectStandardError (Join-Path $consoleRoot 'data/server.stderr.log') | Out-Null
for ($checkIndex = 0; $checkIndex -lt 30; $checkIndex++) {
    Start-Sleep -Milliseconds 100
    try {
        $started = Invoke-RestMethod -Uri 'http://127.0.0.1:17866/api/state' -TimeoutSec 1 -NoProxy
        if ($started.version -eq $consoleVersion -and $started.catalog.Count -eq 44) { Write-Output 'http://127.0.0.1:17866'; exit 0 }
    } catch {}
}
throw 'Local console did not become ready. Check data/server.stderr.log and port 17866.'
