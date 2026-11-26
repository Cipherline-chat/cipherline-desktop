# Drives win-helper.exe the way the Electron app does (electron/win-helper.ts: `serve`; media-session.ts: `media`; music-detect.ts:
# `music-state`; hybrid-gpu via serve). PowerShell is fine HERE (CI only): it is the APP that must not use it. Windows PowerShell 5.1.
#   powershell -File smoke.ps1 -Helper <win-helper.exe> -Fixtures <dir made by build-fixture.ps1>
param([Parameter(Mandatory)][string]$Helper, [Parameter(Mandatory)][string]$Fixtures)
$ErrorActionPreference = 'Stop'
$script:fails = 0
function Check([string]$name, [bool]$ok, $detail = '') {
    if ($ok) { Write-Host "PASS  $name" } else { Write-Host "FAIL  $name  $detail"; $script:fails++ }
}
function Start-Helper([string]$mode) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $Helper; $psi.Arguments = $mode
    $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $p = [Diagnostics.Process]::Start($psi)
    # .NET Framework has no StandardInputEncoding: write raw UTF-8 bytes (no BOM) straight to the pipe.
    $p | Add-Member -NotePropertyName Writer -NotePropertyValue $p.StandardInput.BaseStream
    $p
}
function Send($h, [string]$text) {
    $b = (New-Object Text.UTF8Encoding($false)).GetBytes($text)
    $h.Writer.Write($b, 0, $b.Length); $h.Writer.Flush()
}
$script:nextId = 1
$script:ms = @{}
function Ask($h, [string]$op, $params = @{}, [int]$timeoutMs = 5000) {
    $id = $script:nextId++
    # Hand-built JSON line (what electron/win-helper.ts sends): no serializer quirks between PowerShell versions.
    $json = '{"id":' + $id + ',"op":"' + $op + '"'
    foreach ($k in $params.Keys) {
        $v = $params[$k]
        if ($v -is [string]) { $json += ',"' + $k + '":"' + $v.Replace('\', '\\').Replace('"', '\"') + '"' } else { $json += ',"' + $k + '":' + $v }
    }
    $json += '}'
    $o = @{ id = $id }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Send $h ($json + "`n")
    if ($h.Pending) { $t = $h.Pending; $h.Pending = $null } else { $t = $h.StandardOutput.ReadLineAsync() }
    if (-not $t.Wait($timeoutMs)) { throw "no reply to $op within $timeoutMs ms" }
    $script:ms[$op] = [Math]::Max([int]$script:ms[$op], [int]$sw.ElapsedMilliseconds)
    $r = $t.Result | ConvertFrom-Json
    if ($r.id -ne $o.id) { throw "reply id $($r.id) != $($o.id) for $op; raw: $($t.Result) sent: $json" }
    $r
}
function Wait-Until([scriptblock]$cond, [int]$sec = 15) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 300 }
    $false
}
Add-Type -Namespace Nt -Name Proc -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("ntdll.dll")] public static extern int NtSuspendProcess(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("ntdll.dll")] public static extern int NtResumeProcess(System.IntPtr h);
'@

Write-Host "helper: $Helper ($((Get-Item $Helper).Length) bytes)"
$started = @()
try {
    # serve: process snapshot, pid/name, exe path
    $h = Start-Helper 'serve'
    # Windows PowerShell's Process class writes a UTF-8 BOM into a redirected stdin as soon as it is created (the app's Node never
    # does). The helper reads that first line as bad JSON and answers id 0. Prime with a newline and swallow that artifact reply.
    Send $h "`n"
    $prime = $h.StandardOutput.ReadLineAsync()
    if ($prime.Wait(2000)) { Write-Host "      (primed: swallowed the BOM artifact reply $($prime.Result))" } else { Write-Host '      (primed: no BOM artifact)'; $h | Add-Member -NotePropertyName Pending -NotePropertyValue $prime }
    $me = (Get-Process -Id $PID)
    $r = Ask $h 'processes'
    $names = @($r.names | ForEach-Object { $_.ToLower() })
    Check 'serve: processes ok' ($r.ok -eq $true) ($r | ConvertTo-Json -Compress)
    Check 'serve: processes include this powershell' (($names -contains "$($me.ProcessName).exe".ToLower()) -or ($names -contains $me.ProcessName.ToLower())) "count=$($names.Count)"
    Check 'serve: processes include explorer or svchost' (($names -contains 'svchost.exe') -or ($names -contains 'explorer.exe')) "count=$($names.Count)"
    Write-Host "      process count: $($names.Count) (Get-Process: $((Get-Process).Count))"
    $r = Ask $h 'pid_name' @{ pid = $PID }
    Check 'serve: pid_name of this process' ($r.name -and $r.name.ToLower().Replace('.exe','') -eq $me.ProcessName.ToLower()) ($r | ConvertTo-Json -Compress)
    $r = Ask $h 'pid_name' @{ pid = 4294000 }
    Check 'serve: pid_name of an unused pid is null' (($r.ok -eq $true) -and ($null -eq $r.name))
    $r = Ask $h 'exe_path' @{ name = $me.ProcessName }
    Check 'serve: exe_path of this process' ($r.path -and ($r.path -ieq $me.Path)) "$($r.path) vs $($me.Path)"
    $r = Ask $h 'exe_path' @{ name = 'definitely-not-running' }
    Check 'serve: exe_path of nothing is null' (($r.ok -eq $true) -and ($null -eq $r.path))
    $r = Ask $h 'rm_rf'
    Check 'serve: unknown op refused' ($r.ok -eq $false)
    Check 'serve: still answering after a refusal' ((Ask $h 'minecraft').ok -eq $true)
    $r = Ask $h 'suspended' @{ name = '..\evil' }
    Check 'serve: bad process name refused' ($r.ok -eq $false)

    # window / suspended / minecraft with real processes
    Check 'minecraft: none open yet' ((Ask $h 'minecraft').running -eq $false)
    $win = Start-Process (Join-Path $Fixtures 'clwin.exe') -PassThru; $started += $win
    $mc = Start-Process (Join-Path $Fixtures 'javaw.exe') -ArgumentList '"Minecraft 1.21.4 CI"' -PassThru; $started += $mc
    $nw = Start-Process (Join-Path $Fixtures 'clnowin.exe') -ArgumentList '--nowin' -PassThru; $started += $nw
    $sp = Start-Process (Join-Path $Fixtures 'clsusp.exe') -ArgumentList '"CL suspend test"' -PassThru; $started += $sp
    $null = Wait-Until { $win.Refresh(); $win.MainWindowHandle -ne 0 } 15
    Write-Host "      fixture MainWindowHandle (Windows' own answer): $($win.MainWindowHandle)"
    $desktopOk = Wait-Until { $x = Ask $h 'window' @{ name = 'clwin' }; ($x.found -eq $true) -and ($x.window -eq $true) } 15
    Check 'window: visible titled window detected' $desktopOk
    $r = Ask $h 'window' @{ name = 'clnowin' }
    Check 'window: windowless process found, no window' (($r.found -eq $true) -and ($r.window -eq $false)) ($r | ConvertTo-Json -Compress)
    $r = Ask $h 'window' @{ name = 'definitely-not-running' }
    Check 'window: not running -> found false' ($r.found -eq $false)
    Check 'minecraft: javaw with a Minecraft-titled window detected' (Wait-Until { (Ask $h 'minecraft').running -eq $true } 15)
    $r = Ask $h 'suspended' @{ name = 'clwin' }
    Check 'suspended: a running process reads active' ($r.state -eq 'active') ($r | ConvertTo-Json -Compress)
    $r = Ask $h 'suspended' @{ name = 'definitely-not-running' }
    Check 'suspended: nothing running reads gone' ($r.state -eq 'gone')
    $null = [Nt.Proc]::NtSuspendProcess($sp.Handle)
    Check 'suspended: NtSuspendProcess -> suspended' (Wait-Until { (Ask $h 'suspended' @{ name = 'clsusp' }).state -eq 'suspended' } 10)
    $null = [Nt.Proc]::NtResumeProcess($sp.Handle)
    Check 'suspended: resumed -> active' (Wait-Until { (Ask $h 'suspended' @{ name = 'clsusp' }).state -eq 'active' } 10)
    $mc.Kill(); Start-Sleep -Milliseconds 500
    Check 'minecraft: closed -> false' (Wait-Until { (Ask $h 'minecraft').running -eq $false } 10)

    # registry: the one HKCU key
    $key = 'HKCU:\Software\Microsoft\DirectX\UserGpuPreferences'
    $before = if (Test-Path $key) { @((Get-Item $key).GetValueNames() | Sort-Object) } else { @() }
    $exe = 'C:\cl-ci-gpu-test\app.exe'
    Check 'gpu: no preference at first' ((Ask $h 'gpu_pref_has' @{ exe = $exe }).present -eq $false)
    Check 'gpu: set ok' ((Ask $h 'gpu_pref_set_high' @{ exe = $exe }).ok -eq $true)
    Check 'gpu: has -> true' ((Ask $h 'gpu_pref_has' @{ exe = $exe }).present -eq $true)
    $val = (Get-ItemProperty $key -Name $exe).$exe
    Check 'gpu: value is GpuPreference=2;' ($val -eq 'GpuPreference=2;') "got '$val'"
    Check 'gpu: relative path refused' ((Ask $h 'gpu_pref_set_high' @{ exe = 'app.exe' }).ok -eq $false)
    Remove-ItemProperty $key -Name $exe -ErrorAction SilentlyContinue
    $after = if (Test-Path $key) { @((Get-Item $key).GetValueNames() | Sort-Object) } else { @() }
    Check 'gpu: nothing else written, test value cleaned up' (($before -join '|') -eq ($after -join '|')) "before=$($before -join ',') after=$($after -join ',')"
    foreach ($op in $script:ms.Keys) { Write-Host "      slowest $op reply: $($script:ms[$op]) ms (the app gives up at 5000)" }
    Check 'serve: every reply under the app 5 s timeout' (($script:ms.Values | Measure-Object -Maximum).Maximum -lt 5000)
    $h.Writer.Close()
    Check 'serve: exits 0 when stdin closes' ($h.WaitForExit(5000) -and $h.ExitCode -eq 0) "exit=$($h.ExitCode)"

    # media (long-lived)
    $m = Start-Helper 'media'
    Send $m "a`n"
    $rd = $m.StandardOutput.ReadLineAsync()
    $got = $rd.Wait(15000)
    Check 'media: answers the first read with one JSON line' $got
    if ($got) {
        $j = $rd.Result | ConvertFrom-Json
        Write-Host "      media reply: ok=$($j.ok) sessions=$(@($j.sessions).Count) cur='$($j.cur)'"
        Check 'media: reply parses and has a boolean ok' ($j.ok -is [bool])
        Check 'media: no sessions on a runner' (@($j.sessions).Count -eq 0)
    }
    Send $m "r`n"; $rd2 = $m.StandardOutput.ReadLineAsync()
    Check 'media: answers a second read' ($rd2.Wait(15000))
    $m.Writer.Close()
    Check 'media: exits 0 when stdin closes' ($m.WaitForExit(8000) -and $m.ExitCode -eq 0) "exit=$($m.ExitCode)"
    $m2 = Start-Helper 'media'; Send $m2 "x`n"; Send $m2 "q`n"   # the BOM artifact line is read as a (harmless) request, then q
    Check 'media: q ends it' ($m2.WaitForExit(8000) -and $m2.ExitCode -eq 0)

    # music-state (one-shot)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $out = & $Helper music-state
    $code = $LASTEXITCODE
    Write-Host "      music-state: $out ($($sw.ElapsedMilliseconds) ms)"
    Check 'music-state: exit 0' ($code -eq 0)
    $mst = $out | ConvertFrom-Json
    Check 'music-state: sessions array, nothing playing' (($null -ne $mst.sessions -or $out -match '"sessions":\[\]') -and @($mst.sessions).Count -eq 0)

    # CLI edges the callers rely on (Windows PowerShell 5.1 turns native stderr into a terminating error under Stop)
    $ErrorActionPreference = 'Continue'
    & $Helper bogus 2>$null; Check 'unknown mode exits 64' ($LASTEXITCODE -eq 64)
    & $Helper verify 2>$null; Check 'verify with no file exits 64' ($LASTEXITCODE -eq 64)
    $o = & $Helper verify 'C:\definitely\not\here.exe'
    $jv = $o | ConvertFrom-Json
    Check 'verify of a missing file: exit 0, Status != 0 (a verdict, not a crash)' (($LASTEXITCODE -eq 0) -and ($jv.Status -ne 0)) $o
} finally {
    foreach ($p in $started) { try { if (-not $p.HasExited) { $p.Kill() } } catch {} }
    try { if ($h -and -not $h.HasExited) { $h.Kill() } } catch {}
}
if ($script:fails -gt 0) { Write-Host "`n$($script:fails) check(s) FAILED"; exit 1 }
Write-Host "`nall smoke checks passed"
