$ErrorActionPreference = 'Stop'
$consoleRoot = $PSScriptRoot
try {
    $existing = Invoke-RestMethod -Uri 'http://127.0.0.1:17866/api/state' -TimeoutSec 2 -NoProxy
    if ($existing.version -eq '0.0.12' -and $existing.catalog.Count -eq 44) { Write-Output 'http://127.0.0.1:17866'; exit 0 }
} catch {}
$nodePath = (Get-Command node.exe).Source
Start-Process -FilePath $nodePath -ArgumentList 'server.mjs' -WorkingDirectory $consoleRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $consoleRoot 'data/server.stdout.log') -RedirectStandardError (Join-Path $consoleRoot 'data/server.stderr.log') | Out-Null
for ($checkIndex = 0; $checkIndex -lt 30; $checkIndex++) {
    Start-Sleep -Milliseconds 100
    try {
        $started = Invoke-RestMethod -Uri 'http://127.0.0.1:17866/api/state' -TimeoutSec 1 -NoProxy
        if ($started.version -eq '0.0.12' -and $started.catalog.Count -eq 44) { Write-Output 'http://127.0.0.1:17866'; exit 0 }
    } catch {}
}
throw 'Local console did not become ready. Check data/server.stderr.log and port 17866.'
