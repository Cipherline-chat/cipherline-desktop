# win-helper Windows verification scripts

`win-helper.exe` is Windows-only, so these run on a real (ideally disposable) Windows machine. They passed on a GitHub-hosted
`windows-latest` VM; to reuse them, copy this folder into a throwaway workflow job.

    cd apps/desktop-host/win-helper && cargo build --release        # -> target\release\cl-win-helper.exe
    powershell -File ci\build-fixture.ps1 -OutDir %TEMP%\fx          # tiny window / windowless / "javaw" programs
    powershell -File ci\smoke.ps1 -Helper target\release\cl-win-helper.exe -Fixtures %TEMP%\fx

    # Real WinHelperClient + Authenticode parity (old Get-AuthenticodeSignature path vs `win-helper verify`), from apps/desktop:
    #   HELPER=<exe> FIXTURES=<fx dir> PARITY_DIR=<dir of files named cipherline-installer.exe, cipherline-installer-flipped.exe,
    #   notepad.exe, helper-unsigned.exe> OLD_VERIFY=<authenticode-verify.ts from origin/main, saved to a file>
    #   npx tsx ..\desktop-host\win-helper\ci\ts-checks.ts

`smoke.ps1` drives `serve` / `media` / `music-state` / `verify` / the GPU registry key. Windows PowerShell 5.1 writes a UTF-8 BOM into a
redirected stdin; the script primes the pipe to swallow that (the app's Node never sends one).
