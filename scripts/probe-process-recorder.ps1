param([int]$ParentId,[string]$StopFile,[int]$Seconds=900)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
function Emit($value){[Console]::WriteLine(($value|ConvertTo-Json -Compress -Depth 5))}
$started=Get-Date
try {
  while(((Get-Date)-$started).TotalSeconds -lt $Seconds){
    if((Test-Path -LiteralPath $StopFile) -or !(Get-Process -Id $ParentId -ErrorAction SilentlyContinue)){break}
    $stamp=(Get-Date).ToUniversalTime().ToString('o')
    $all=@(Get-CimInstance Win32_Process -ErrorAction Stop)
    $tracked=@{}
    foreach($p in $all){if($p.Name -eq 'MobileWork.exe'){$tracked[[int]$p.ProcessId]=$p}}
    do{$added=$false;foreach($p in $all){if(!$tracked.ContainsKey([int]$p.ProcessId) -and $tracked.ContainsKey([int]$p.ParentProcessId)){$tracked[[int]$p.ProcessId]=$p;$added=$true}}}while($added)
    $rows=@()
    foreach($c in @(Get-NetTCPConnection -ErrorAction Stop)){
      if(!$tracked.ContainsKey([int]$c.OwningProcess) -or $c.RemotePort -eq 0){continue}
      $p=$tracked[[int]$c.OwningProcess];$role='child'
      if($p.Name -eq 'MobileWork.exe'){$role=if($p.CommandLine -match 'network\.mojom\.NetworkService'){'NetworkService'}elseif($p.CommandLine -match '--type=renderer'){'renderer'}elseif($p.CommandLine -match '--type='){'utility'}else{'main'}}
      $rows+=@{pid=[int]$p.ProcessId;role=$role;state=[string]$c.State;localAddress=$c.LocalAddress;localPort=[int]$c.LocalPort;remoteAddress=$c.RemoteAddress;remotePort=[int]$c.RemotePort}
    }
    Emit @{kind='sample';at=$stamp;processCount=$tracked.Count;connections=$rows}
    Start-Sleep -Seconds 1
  }
  Emit @{kind='stopped';at=(Get-Date).ToUniversalTime().ToString('o')}
}catch{Emit @{kind='error';code='process_sample_unavailable'};exit 2}
