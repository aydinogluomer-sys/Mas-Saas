#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  MAS Nakit Radar - mevcut PostgreSQL 16 kumesini (C:\MAS\pgdata16) otomatik baslayan bir
  Windows hizmeti (MAS-PostgreSQL16, NT AUTHORITY\NetworkService) olarak kaydeder.

.DESCRIPTION
  Sahip bu scripti BIR KEZ, yonetici olarak calistirir (docs/ops/postgres-service.md):
    PowerShell'e sag tik -> "Yonetici olarak calistir", sonra
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\install-postgres-service.ps1 -WhatIf
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\install-postgres-service.ps1

  NEDEN: kume bugun oturum acilisinda calisan bir zamanlanmis gorevden (MAS-PostgreSQL16-Oturum-
  Baslat) baslar - sahibin oturumuna baglidir, oturum kapaninca durur, cokerse yeniden baslamaz ve
  gece 03:00 yedegi oturum acik degilse veritabani bulamaz. Hizmet makine acilisinda, oturumdan
  bagimsiz, en az yetkili hesapla (NetworkService) baslar ve hata durumunda yeniden baslatilir.

  BU SCRIPT ASLA: yeni kume yaratmaz; veriyi silmez ya da tasimaz; postgresql.conf / pg_hba.conf
  dosyalarini degistirmez; hicbir rolun parolasina dokunmaz ve hicbir parola okumaz/yazdirmaz;
  guvenlik duvari kurali eklemez; Docker'a dokunmaz.

  Her adim once durumu OLCER ve zaten dogruysa hicbir sey yapmaz. Basarili bir kurulumdan sonra
  yeniden calistirmak yalniz hizmeti dogrular ve "ZATEN KURULU" yazar.

  CIKIS KODLARI:
    0  tamam (ya da zaten kurulu / -WhatIf provasi)
    10 yonetici degil
    11 PostgreSQL 16 ikili dosyalari eksik ya da surum 16 degil
    12 veri dizini yok / PostgreSQL 16 kumesi degil
    13 yapilandirma yalniz-loopback ya da yalniz-scram-sha-256 degil (ya da dogrulanamiyor)
    14 port baska bir surece ait
    15 ayni adla FARKLI yapilandirilmis bir hizmet zaten var
    16 elle baslatilmis ornek durdurulamadi
    17 hizmet baslatilamadi ya da dogrulama basarisiz
    18 ACL dogrulamasi basarisiz

  GERI ALMA (elle, veri etkilenmez):
    Stop-Service MAS-PostgreSQL16
    & C:\MAS\pgsql16\bin\pg_ctl.exe unregister -N MAS-PostgreSQL16
    ve oturum acilis gorevini yeniden kaydedin (docs/ops/postgres-service.md, "Geri alma").
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$PgRoot = 'C:\MAS\pgsql16',
  [string]$DataDir = 'C:\MAS\pgdata16',
  [string]$ServiceName = 'MAS-PostgreSQL16',
  [int]$Port = 5432,
  [string]$OwnerUser = '',
  [string]$LogonTaskName = 'MAS-PostgreSQL16-Oturum-Baslat',
  [string]$ReceiptDir = '',
  [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$NetworkServiceAccount = 'NT AUTHORITY\NetworkService'
$ExpectedSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-20')   # SYSTEM, Administrators, NetworkService
$LoopbackListen = @('localhost', '127.0.0.1', '::1')
$script:FallbackDisabled = $false
$script:ChangesMade = $false
$script:FallbackRemoved = $false

function Write-Info([string]$Message) { Write-Host "[MAS] $Message" }
function Write-Ok([string]$Message) { Write-Host "  TAMAM : $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "  UYARI : $Message" -ForegroundColor Yellow }
function Write-Step([string]$Message) { Write-Host ''; Write-Host "== $Message ==" -ForegroundColor Cyan }

function Stop-WithCode([int]$Code, [string]$Message) {
  Write-Host "  HATA  : $Message" -ForegroundColor Red
  Restore-Fallback
  Write-Host "Cikis kodu $Code. Ayrinti: docs/ops/postgres-service.md" -ForegroundColor Red
  exit $Code
}

# Yerel bir komutu calistirir; stdout+stderr metin satirlari olarak doner. PS 5.1'de stderr
# satirlari ErrorRecord'a sarilir ve $ErrorActionPreference='Stop' altinda scripti durdururdu;
# burada gecici olarak 'Continue' kullanilir ve karar YALNIZ cikis koduna gore verilir.
function Invoke-Native {
  param([Parameter(Mandatory = $true)][string]$FilePath, [string[]]$Arguments = @())
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  return [pscustomobject]@{ Code = $code; Output = $output }
}

function Get-FallbackTask {
  return Get-ScheduledTask -TaskName $LogonTaskName -ErrorAction SilentlyContinue
}

# Adim 3-6'dan herhangi biri duserse oturum acilis gorevi yeniden etkinlestirilir: sahip bir
# sonraki oturum acilisinda yine bir veritabanina kavusur.
function Restore-Fallback {
  if (-not $script:FallbackDisabled) { return }
  try {
    Enable-ScheduledTask -TaskName $LogonTaskName | Out-Null
    $script:FallbackDisabled = $false
    Write-Warn "oturum acilis gorevi '$LogonTaskName' yeniden ETKINLESTIRILDI (hizmet kurulamadi)."
  } catch {
    Write-Warn "oturum acilis gorevi '$LogonTaskName' yeniden etkinlestirilemedi: $($_.Exception.Message)"
  }
}

function Get-PgMajor([string]$Text) {
  if ($Text -match 'PostgreSQL\)?\s+(\d+)') { return [int]$Matches[1] }
  return -1
}

# postgresql.conf ve postgresql.auto.conf icinde bir ayarin ETKIN degeri: son atama kazanir
# (auto.conf sonra okunur, ALTER SYSTEM ile yazilan oradadir). Etkin bir include yonergesi varsa
# ayar dogrulanamaz -> $null ile birlikte IncludeFound=true doner ve cagiran reddeder.
function Get-ConfSetting {
  param([string[]]$Files, [string]$Name)
  $value = $null
  $includeFound = $false
  foreach ($file in $Files) {
    if (-not (Test-Path -LiteralPath $file)) { continue }
    foreach ($raw in Get-Content -LiteralPath $file) {
      $line = ($raw -replace '#.*$', '').Trim()
      if ($line -eq '') { continue }
      if ($line -match '^(include|include_if_exists|include_dir)\b') { $includeFound = $true; continue }
      if ($line -match ('^' + [regex]::Escape($Name) + '(?:\s*=\s*|\s+)(.+)$')) {
        $value = $Matches[1].Trim().Trim("'").Trim()
      }
    }
  }
  return [pscustomobject]@{ Value = $value; IncludeFound = $includeFound }
}

function Test-LoopbackHbaAddress([string]$Address, [string]$Mask) {
  if ($Mask -ne '') {
    return (($Address -eq '127.0.0.1' -and $Mask -eq '255.255.255.255') -or
            ($Address -eq '::1' -and $Mask -match '^(ffff:){7}ffff$'))
  }
  if ($Address -eq 'localhost') { return $true }
  if ($Address -match '^127\.\d{1,3}\.\d{1,3}\.\d{1,3}/(8|9|[12][0-9]|3[0-2])$') { return $true }
  return ($Address -eq '::1/128')
}

# pg_hba.conf: her etkin satir yalniz loopback adrese ve yalniz scram-sha-256 (ya da reject)
# yontemine izin vermeli. 'trust' parolasiz giristir; 'md5'/'password' zayif ya da duz metindir.
function Get-HbaProblems([string]$HbaPath) {
  $problems = New-Object System.Collections.Generic.List[string]
  $lineNo = 0
  foreach ($raw in Get-Content -LiteralPath $HbaPath) {
    $lineNo++
    $line = ($raw -replace '#.*$', '').Trim()
    if ($line -eq '') { continue }
    $fields = @($line -split '\s+')
    $type = $fields[0].ToLowerInvariant()
    $method = ''
    if ($type -in @('include', 'include_if_exists', 'include_dir')) {
      $problems.Add("satir ${lineNo}: '$type' yonergesi var - etkin kurallar dogrulanamiyor")
      continue
    }
    if ($type -eq 'local') {
      if ($fields.Count -lt 4) { $problems.Add("satir ${lineNo}: eksik alan"); continue }
      $method = $fields[3]
    } elseif ($type -in @('host', 'hostssl', 'hostnossl', 'hostgssenc', 'hostnogssenc')) {
      if ($fields.Count -lt 5) { $problems.Add("satir ${lineNo}: eksik alan"); continue }
      $address = $fields[3]
      $mask = ''
      $methodIndex = 4
      if ($address -notmatch '/' -and $address -match '^[0-9a-fA-F:.]+$' -and $address -ne 'localhost') {
        $mask = $fields[4]
        $methodIndex = 5
        if ($fields.Count -le $methodIndex) { $problems.Add("satir ${lineNo}: eksik alan"); continue }
      }
      if (-not (Test-LoopbackHbaAddress $address $mask)) {
        $problems.Add("satir ${lineNo}: adres '$address' loopback degil - yalniz 127.0.0.1/32 ve ::1/128 kabul edilir")
      }
      $method = $fields[$methodIndex]
    } else {
      $problems.Add("satir ${lineNo}: taninmayan satir turu '$type'")
      continue
    }
    if ($method -notin @('scram-sha-256', 'reject')) {
      $problems.Add("satir ${lineNo}: yontem '$method' kabul edilmez - yalniz scram-sha-256 (ya da reject)")
    }
  }
  # Elemanlar boru hattina tek tek verilir; cagiran @(...) ile toplar (bos liste = 0 eleman).
  return $problems.ToArray()
}

function Get-Listeners {
  $out = @()
  foreach ($c in @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
    $exe = ''
    if ($null -ne $proc -and $null -ne $proc.ExecutablePath) { $exe = [string]$proc.ExecutablePath }
    $out += [pscustomobject]@{ Address = [string]$c.LocalAddress; Pid = [int]$c.OwningProcess; Exe = $exe }
  }
  return $out
}

function Test-NetworkServiceAccount([string]$StartName) {
  if ($StartName -in @('NT AUTHORITY\NetworkService', 'NT AUTHORITY\NETWORK SERVICE')) { return $true }
  try {
    $sid = (New-Object System.Security.Principal.NTAccount($StartName)).Translate([System.Security.Principal.SecurityIdentifier]).Value
    return ($sid -eq 'S-1-5-20')
  } catch {
    return $false
  }
}

function Get-PgServiceCim {
  return Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
}

# pg_ctl hizmet komut satirini ileri egik cizgilerle yazabilir (C:/MAS/pgdata16); karsilastirma
# ters egik cizgiye ve kucuk harfe normallestirilerek yapilir.
function Get-ServiceMismatches($Svc) {
  $problems = @()
  $pathName = ([string]$Svc.PathName).Replace('/', '\').ToLowerInvariant()
  if (-not $pathName.Contains($PgCtl.ToLowerInvariant())) { $problems += "PathName '$PgCtl' degil" }
  if (-not $pathName.Contains('runservice')) { $problems += 'PathName runservice icermiyor' }
  if (-not $pathName.Contains($ServiceName.ToLowerInvariant())) { $problems += "PathName -N $ServiceName icermiyor" }
  if (-not $pathName.Contains($DataDir.ToLowerInvariant())) { $problems += "PathName -D $DataDir icermiyor" }
  if (-not (Test-NetworkServiceAccount ([string]$Svc.StartName))) { $problems += "hesap '$($Svc.StartName)' NetworkService degil" }
  if ([string]$Svc.StartMode -ne 'Auto') { $problems += "baslangic turu '$($Svc.StartMode)' Auto degil" }
  return $problems
}

# Hizmeti ve dinleyicileri dogrular. Basarisizlikta Stop-WithCode 17.
function Confirm-Service {
  $ready = Invoke-Native -FilePath $PgIsready -Arguments @('-h', '127.0.0.1', '-p', "$Port", '-t', '30')
  if ($ready.Code -ne 0) {
    Stop-WithCode 17 "pg_isready 127.0.0.1:$Port cevap vermedi (exit $($ready.Code)): $($ready.Output -join ' ')"
  }
  Write-Ok "pg_isready 127.0.0.1:$Port -> baglanti kabul ediyor"

  $listeners = @(Get-Listeners)
  if ($listeners.Count -eq 0) { Stop-WithCode 17 "port $Port uzerinde dinleyici bulunamadi" }
  foreach ($l in $listeners) {
    if ($l.Address -notin @('127.0.0.1', '::1')) {
      Stop-WithCode 17 "port $Port $($l.Address) adresinde dinleniyor - yalniz 127.0.0.1 ve ::1 kabul edilir"
    }
    if ($l.Exe -eq '' -or $l.Exe.ToLowerInvariant() -ne $Postgres.ToLowerInvariant()) {
      Stop-WithCode 17 "port $Port dinleyicisi (PID $($l.Pid)) $Postgres degil: '$($l.Exe)'"
    }
  }
  Write-Ok ("dinleyiciler yalniz loopback: " + (($listeners | ForEach-Object { $_.Address } | Sort-Object -Unique) -join ', '))

  $svc = Get-PgServiceCim
  if ($null -eq $svc) { Stop-WithCode 17 "hizmet '$ServiceName' bulunamadi" }
  $mismatch = @(Get-ServiceMismatches $svc)
  if ($mismatch.Count -gt 0) { Stop-WithCode 17 ("hizmet yapilandirmasi beklenen degil: " + ($mismatch -join '; ')) }
  if ([string]$svc.State -ne 'Running') { Stop-WithCode 17 "hizmet durumu '$($svc.State)' (Running bekleniyordu)" }
  Write-Ok "hizmet '$ServiceName': Running, Auto, $($svc.StartName)"
  return $listeners
}

function Write-Receipt($Listeners, [string[]]$AclSids, [int]$PgMajor) {
  if ($ReceiptDir -eq '') {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $script:ReceiptDir = Join-Path $repoRoot 'logs'
  }
  if (-not (Test-Path -LiteralPath $ReceiptDir)) { New-Item -ItemType Directory -Path $ReceiptDir | Out-Null }
  $svc = Get-PgServiceCim
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $receipt = [ordered]@{
    receiptKind          = 'mas-postgres-service-install-v1'
    generatedAtUtc       = (Get-Date).ToUniversalTime().ToString('o')
    service              = $ServiceName
    account              = [string]$svc.StartName
    startMode            = [string]$svc.StartMode
    state                = [string]$svc.State
    pgBinDir             = $PgBin
    dataDir              = $DataDir
    pgMajor              = $PgMajor
    dataDirAclSids       = $AclSids
    pgIsready            = "127.0.0.1:$Port accepting"
    listenerAddresses    = @($Listeners | ForEach-Object { $_.Address } | Sort-Object -Unique)
    fallbackTaskRemoved  = $script:FallbackRemoved
    fallbackTaskName     = $LogonTaskName
    scriptSha256         = (Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash.ToLowerInvariant()
  }
  $path = Join-Path $ReceiptDir "postgres-service-install-$stamp.json"
  [IO.File]::WriteAllText($path, ($receipt | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok "makbuz: $path (parola ya da baglanti dizesi icermez)"
}

# ---------------------------------------------------------------------------------------------
Write-Info "PostgreSQL 16 Windows hizmeti kurulumu - $ServiceName"
if ($WhatIfPreference) { Write-Info 'PROVA (-WhatIf): degistiren adimlar YALNIZ listelenir, hicbiri uygulanmaz.' }

if ($ServiceName -notmatch '^[A-Za-z0-9._-]{1,64}$') { Stop-WithCode 15 "hizmet adi gecersiz: '$ServiceName'" }
if ($LogonTaskName -notmatch '^[A-Za-z0-9._-]{1,64}$') { Stop-WithCode 15 "gorev adi gecersiz: '$LogonTaskName'" }

$PgBin = Join-Path $PgRoot 'bin'
$PgCtl = Join-Path $PgBin 'pg_ctl.exe'
$Postgres = Join-Path $PgBin 'postgres.exe'
$PgIsready = Join-Path $PgBin 'pg_isready.exe'

# --- ADIM 0: on kosullar -----------------------------------------------------------------------
Write-Step 'ADIM 0/8 - on kosullar'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "  HATA  : Bu script YONETICI olarak calistirilmali. PowerShell'e sag tiklayip 'Yonetici olarak calistir' secin." -ForegroundColor Red
  exit 10
}
Write-Ok "yonetici olarak calisiyor ($($identity.Name))"

foreach ($exe in @($PgCtl, $Postgres, $PgIsready)) {
  if (-not (Test-Path -LiteralPath $exe)) { Stop-WithCode 11 "eksik: $exe" }
}
$ctlVersion = Invoke-Native -FilePath $PgCtl -Arguments @('--version')
$pgMajor = Get-PgMajor ($ctlVersion.Output -join ' ')
if ($ctlVersion.Code -ne 0 -or $pgMajor -ne 16) { Stop-WithCode 11 "pg_ctl surumu 16 degil: $($ctlVersion.Output -join ' ')" }
Write-Ok "ikili dosyalar: $PgBin (PostgreSQL $pgMajor)"

if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) {
  Stop-WithCode 12 "veri dizini yok: $DataDir - bu script kume OLUSTURMAZ."
}
$DataDir = (Resolve-Path -LiteralPath $DataDir).Path.TrimEnd('\')
$pgVersionFile = Join-Path $DataDir 'PG_VERSION'
$confFile = Join-Path $DataDir 'postgresql.conf'
$autoConfFile = Join-Path $DataDir 'postgresql.auto.conf'
$hbaFile = Join-Path $DataDir 'pg_hba.conf'
if (-not (Test-Path -LiteralPath $pgVersionFile) -or ((Get-Content -LiteralPath $pgVersionFile -TotalCount 1).Trim() -ne '16')) {
  Stop-WithCode 12 "$DataDir bir PostgreSQL 16 kumesi degil (PG_VERSION) - bu script kume OLUSTURMAZ."
}
if (-not (Test-Path -LiteralPath $confFile) -or -not (Test-Path -LiteralPath $hbaFile)) {
  Stop-WithCode 12 "postgresql.conf ya da pg_hba.conf eksik: $DataDir"
}
Write-Ok "veri dizini: $DataDir (PostgreSQL 16 kumesi)"

$listen = Get-ConfSetting -Files @($confFile, $autoConfFile) -Name 'listen_addresses'
$portSetting = Get-ConfSetting -Files @($confFile, $autoConfFile) -Name 'port'
if ($listen.IncludeFound -or $portSetting.IncludeFound) {
  Stop-WithCode 13 'postgresql.conf etkin bir include yonergesi iceriyor - dinleme ayarlari dogrulanamiyor.'
}
$listenValue = 'localhost'
if ($null -ne $listen.Value) { $listenValue = [string]$listen.Value }
$listenItems = @($listenValue -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
foreach ($item in $listenItems) {
  if ($item -notin $LoopbackListen) { Stop-WithCode 13 "listen_addresses '$listenValue' yalniz loopback degil (izinli: localhost, 127.0.0.1, ::1)." }
}
$confPort = 5432
if ($null -ne $portSetting.Value) { $confPort = [int]$portSetting.Value }
if ($confPort -ne $Port) { Stop-WithCode 13 "postgresql.conf port=$confPort, beklenen $Port." }
Write-Ok "listen_addresses='$listenValue', port=$confPort"

$hbaProblems = @(Get-HbaProblems $hbaFile)
if ($hbaProblems.Count -gt 0) {
  foreach ($p in $hbaProblems) { Write-Host "  pg_hba.conf: $p" -ForegroundColor Red }
  Stop-WithCode 13 "pg_hba.conf yalniz loopback + scram-sha-256 degil ('trust' parolasiz giristir ve reddedilir)."
}
Write-Ok 'pg_hba.conf: yalniz loopback adresler, yalniz scram-sha-256'

foreach ($l in @(Get-Listeners)) {
  if ($l.Exe -eq '' -or $l.Exe.ToLowerInvariant() -ne $Postgres.ToLowerInvariant()) {
    Stop-WithCode 14 "port $Port baska bir surece ait (PID $($l.Pid), '$($l.Exe)') - once onu kapatin."
  }
}
Write-Ok "port ${Port}: bos ya da bu kumenin postgres.exe surecinde"

if ($OwnerUser -eq '') {
  $console = (Get-CimInstance Win32_ComputerSystem).UserName
  if ($null -ne $console -and [string]$console -ne '') { $OwnerUser = [string]$console } else { $OwnerUser = $identity.Name }
}
try {
  $ownerSid = (New-Object System.Security.Principal.NTAccount($OwnerUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
} catch {
  Stop-WithCode 18 "sahip kullanici '$OwnerUser' bir SID'e cevrilemedi - -OwnerUser ile verin."
}
Write-Ok "veri dizinine tam yetki verilecek sahip: $OwnerUser ($ownerSid)"
$expectedAclSids = @($ExpectedSids + $ownerSid | Sort-Object -Unique)

# --- -VerifyOnly: yalniz dogrulama -------------------------------------------------------------
if ($VerifyOnly) {
  Write-Step 'DOGRULAMA (-VerifyOnly)'
  $null = Confirm-Service
  Write-Info 'DOGRULAMA TAMAM - hicbir degisiklik yapilmadi.'
  exit 0
}

# --- ADIM 1: mevcut hizmet ---------------------------------------------------------------------
Write-Step 'ADIM 1/8 - mevcut hizmet'
$existing = Get-PgServiceCim
if ($null -ne $existing) {
  $mismatch = @(Get-ServiceMismatches $existing)
  if ($mismatch.Count -gt 0) {
    Write-Host "  Elle kaldirmak icin (yonetici): Stop-Service $ServiceName; & '$PgCtl' unregister -N $ServiceName" -ForegroundColor Yellow
    Stop-WithCode 15 ("'$ServiceName' adinda FARKLI yapilandirilmis bir hizmet var: " + ($mismatch -join '; ') + '. Sessizce yeniden kaydedilmez.')
  }
  Write-Ok "hizmet zaten kayitli ve dogru yapilandirilmis (durum: $($existing.State))"
  if ([string]$existing.State -ne 'Running') {
    if ($PSCmdlet.ShouldProcess($ServiceName, 'Start-Service')) {
      try {
        Start-Service -Name $ServiceName
        (Get-Service -Name $ServiceName).WaitForStatus('Running', (New-TimeSpan -Seconds 60))
      } catch {
        Write-Host '  Son gunluk satirlari icin: Get-EventLog -LogName Application -Source PostgreSQL -Newest 20' -ForegroundColor Yellow
        Stop-WithCode 17 "kayitli hizmet 60 sn icinde Running olmadi: $($_.Exception.Message)"
      }
      $script:ChangesMade = $true
    }
  }
  if (-not $WhatIfPreference) {
    $listeners = Confirm-Service
    $task = Get-FallbackTask
    if ($null -ne $task -and $PSCmdlet.ShouldProcess($LogonTaskName, 'Unregister-ScheduledTask')) {
      Unregister-ScheduledTask -TaskName $LogonTaskName -Confirm:$false
      $script:FallbackRemoved = $true
      $script:ChangesMade = $true
      Write-Ok "oturum acilis gorevi '$LogonTaskName' kaldirildi"
    }
    if ($script:ChangesMade) { Write-Receipt $listeners $expectedAclSids $pgMajor }
    Write-Info 'ZATEN KURULU - hizmet calisiyor ve dogrulandi.'
  } else {
    Write-Info 'PROVA bitti - hicbir degisiklik yapilmadi.'
  }
  exit 0
}
Write-Ok 'kayitli hizmet yok - kurulacak'

# --- ADIM 2: oturum acilis gorevini devre disi birak --------------------------------------------
Write-Step "ADIM 2/8 - oturum acilis gorevi ($LogonTaskName)"
$task = Get-FallbackTask
if ($null -eq $task) {
  Write-Ok 'gorev yok - atlandi'
} elseif ([string]$task.State -eq 'Disabled') {
  Write-Ok 'gorev zaten devre disi'
} elseif ($PSCmdlet.ShouldProcess($LogonTaskName, 'Disable-ScheduledTask')) {
  Disable-ScheduledTask -TaskName $LogonTaskName | Out-Null
  $script:FallbackDisabled = $true
  Write-Ok 'gorev devre disi birakildi (ikinci bir postmaster baslatamaz)'
}

# --- ADIM 3: elle baslatilmis ornegi durdur -----------------------------------------------------
Write-Step 'ADIM 3/8 - calisan ornek'
$status = Invoke-Native -FilePath $PgCtl -Arguments @('status', '-D', $DataDir)
if ($status.Code -eq 0) {
  if ($PSCmdlet.ShouldProcess($DataDir, 'pg_ctl stop -m fast')) {
    $stop = Invoke-Native -FilePath $PgCtl -Arguments @('stop', '-D', $DataDir, '-m', 'fast', '-w', '-t', '120')
    if ($stop.Code -ne 0) { Stop-WithCode 16 "pg_ctl stop basarisiz (exit $($stop.Code)): $($stop.Output -join ' ')" }
    Write-Ok 'ornek hizli kapatma (-m fast) ile durduruldu; acik islemler geri alindi'
  }
} else {
  if (Test-Path -LiteralPath (Join-Path $DataDir 'postmaster.pid')) {
    Write-Warn 'postmaster.pid var ama calisan sunucu yok (eski kilit dosyasi) - SILINMEDI; PostgreSQL acilista kendisi degerlendirir.'
  }
  Write-Ok 'calisan ornek yok'
}

# --- ADIM 4: veri dizini ACL (yalniz SID ile) ---------------------------------------------------
Write-Step 'ADIM 4/8 - veri dizini erisim listesi'
$grants = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-20:(OI)(CI)F', "*${ownerSid}:(OI)(CI)F")
if ($PSCmdlet.ShouldProcess($DataDir, 'icacls /inheritance:r /grant:r SYSTEM, Administrators, NetworkService, sahip')) {
  $r1 = Invoke-Native -FilePath 'icacls.exe' -Arguments (@($DataDir, '/inheritance:r', '/grant:r') + $grants)
  if ($r1.Code -ne 0) { Stop-WithCode 18 "icacls /grant basarisiz: $($r1.Output -join ' ')" }
  # Users, Authenticated Users, Everyone, CREATOR OWNER - acik izinleri varsa kaldirilir.
  $r2 = Invoke-Native -FilePath 'icacls.exe' -Arguments @($DataDir, '/remove:g', '*S-1-5-32-545', '*S-1-5-11', '*S-1-1-0', '*S-1-3-0')
  if ($r2.Code -ne 0) { Stop-WithCode 18 "icacls /remove basarisiz: $($r2.Output -join ' ')" }
  # Alt dosya ve dizinler yalniz bu dort girdiyi miras alsin.
  $r3 = Invoke-Native -FilePath 'icacls.exe' -Arguments @((Join-Path $DataDir '*'), '/reset', '/T', '/C', '/Q')
  if ($r3.Code -ne 0) { Stop-WithCode 18 "icacls /reset basarisiz: $($r3.Output -join ' ')" }
  $r4 = Invoke-Native -FilePath 'icacls.exe' -Arguments @($PgRoot, '/grant', '*S-1-5-20:(OI)(CI)RX')
  if ($r4.Code -ne 0) { Stop-WithCode 18 "icacls $PgRoot NetworkService okuma/calistirma izni verilemedi: $($r4.Output -join ' ')" }
  $script:ChangesMade = $true

  $acl = Get-Acl -LiteralPath $DataDir
  if (-not $acl.AreAccessRulesProtected) { Stop-WithCode 18 "$DataDir hala ust dizinden miras aliyor." }
  $actualSids = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) |
    ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
  if (($actualSids -join ',') -ne ($expectedAclSids -join ',')) {
    Stop-WithCode 18 ("ACL beklenen SID kumesi degil. Beklenen: " + ($expectedAclSids -join ', ') + ' / Olculen: ' + ($actualSids -join ', '))
  }
  Write-Ok ("ACL: miras kapali, yalniz " + ($actualSids -join ', '))
}

# --- ADIM 5: hizmeti kaydet ve baslat -------------------------------------------------------------
Write-Step "ADIM 5/8 - hizmet kaydi ($ServiceName, $NetworkServiceAccount, otomatik)"
if ($PSCmdlet.ShouldProcess($ServiceName, "pg_ctl register -N $ServiceName -U `"$NetworkServiceAccount`" -S auto -D $DataDir")) {
  # NetworkService'in parolasi yoktur; register cagrisina parola VERILMEZ.
  $reg = Invoke-Native -FilePath $PgCtl -Arguments @('register', '-N', $ServiceName, '-U', $NetworkServiceAccount, '-S', 'auto', '-D', $DataDir)
  if ($reg.Code -ne 0) { Stop-WithCode 17 "pg_ctl register basarisiz (exit $($reg.Code)): $($reg.Output -join ' ')" }
  $script:ChangesMade = $true
  Write-Ok 'hizmet kaydedildi'
  $null = Invoke-Native -FilePath 'sc.exe' -Arguments @('description', $ServiceName, 'MAS Nakit Radar PostgreSQL 16 (yalniz 127.0.0.1:5432)')
  $failure = Invoke-Native -FilePath 'sc.exe' -Arguments @('failure', $ServiceName, 'reset=', '86400', 'actions=', 'restart/60000/restart/60000//0')
  if ($failure.Code -ne 0) { Write-Warn "hata durumunda yeniden baslatma ayarlanamadi: $($failure.Output -join ' ')" } else { Write-Ok 'hata durumunda 60 sn sonra yeniden baslatma' }
}
if ($PSCmdlet.ShouldProcess($ServiceName, 'Start-Service')) {
  try {
    Start-Service -Name $ServiceName
    (Get-Service -Name $ServiceName).WaitForStatus('Running', (New-TimeSpan -Seconds 60))
  } catch {
    Write-Host '  Son gunluk satirlari icin: Get-EventLog -LogName Application -Source PostgreSQL -Newest 20' -ForegroundColor Yellow
    Write-Host "  ve (logging_collector aciksa) $DataDir\log altindaki son dosya." -ForegroundColor Yellow
    Stop-WithCode 17 "hizmet 60 sn icinde Running olmadi: $($_.Exception.Message)"
  }
  Write-Ok 'hizmet calisiyor'
}

if ($WhatIfPreference) {
  # Kayit yapilmadigi icin dogrulanacak bir hizmet yok; kalan adimlar da listelenir.
  $null = $PSCmdlet.ShouldProcess($LogonTaskName, 'Unregister-ScheduledTask (dogrulama gectikten SONRA)')
  Write-Info 'PROVA bitti - hicbir degisiklik yapilmadi. Gercek kurulum icin -WhatIf olmadan calistirin.'
  exit 0
}

# --- ADIM 6: dogrula ----------------------------------------------------------------------------------
Write-Step 'ADIM 6/8 - dogrulama'
$listeners = Confirm-Service

# --- ADIM 7: oturum acilis gorevini kaldir (yalniz dogrulama gectikten sonra) ---------------------
Write-Step "ADIM 7/8 - oturum acilis gorevini kaldir ($LogonTaskName)"
if ($null -ne (Get-FallbackTask)) {
  if ($PSCmdlet.ShouldProcess($LogonTaskName, 'Unregister-ScheduledTask')) {
    Unregister-ScheduledTask -TaskName $LogonTaskName -Confirm:$false
    $script:FallbackDisabled = $false
    $script:FallbackRemoved = $true
    Write-Ok 'gorev kaldirildi - kume artik yalniz hizmetten baslar'
  }
} else {
  Write-Ok 'gorev yok - atlandi'
}

# --- ADIM 8: makbuz ------------------------------------------------------------------------------------
Write-Step 'ADIM 8/8 - makbuz'
Write-Receipt $listeners $expectedAclSids $pgMajor

Write-Info "KURULUM TAMAM - $ServiceName otomatik basliyor ve yalniz 127.0.0.1/::1:$Port dinliyor."
exit 0
