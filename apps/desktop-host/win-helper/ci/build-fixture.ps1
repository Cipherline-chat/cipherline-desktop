# Compiles the tiny fixture program the smoke tests start: a WinForms window whose title is argv[0], or no window at all with --nowin.
# Copies of it under other names (clwin.exe, javaw.exe, clnowin.exe, clsusp.exe) stand in for a game, Minecraft Java, a windowless
# process and a suspended one. Windows PowerShell 5.1 / .NET Framework csc only: nothing to install.
param([Parameter(Mandatory)][string]$OutDir)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutDir | Out-Null
$src = Join-Path $OutDir 'fixture.cs'
@'
using System; using System.Windows.Forms; using System.Threading;
public static class P {
  [STAThread] public static void Main(string[] a) {
    if (a.Length > 0 && a[0] == "--nowin") { Thread.Sleep(600000); return; }
    var f = new Form(); f.Text = a.Length > 0 ? a[0] : "CL window test"; f.Width = 320; f.Height = 200; Application.Run(f);
  }
}
'@ | Set-Content -Encoding ASCII $src
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$base = Join-Path $OutDir 'fixture.exe'
& $csc /nologo /target:winexe /r:System.Windows.Forms.dll /r:System.Drawing.dll /out:$base $src
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $base)) { throw 'csc failed' }
foreach ($n in 'clwin','javaw','clnowin','clsusp') { Copy-Item $base (Join-Path $OutDir "$n.exe") -Force }
Write-Host "fixtures built in $OutDir"
