import { execFile } from 'child_process';
import type { BusExec } from './keyring-probe';

/**
 * The real `BusExec`: one `busctl` child process per call, never a shell, a
 * fixed argv built by keyring-probe.ts (every dynamic piece is validated
 * there), a hard kill at the deadline. `busctl` ships with systemd; where it is
 * missing (no systemd, minimal container) the spawn fails, the probe says
 * `unknown` and the key store behaves as it always did.
 *
 * Linux only, and only ever reached from the keyring probe hook. No `electron`
 * import.
 */
export const busctlExec: BusExec = (args, timeoutMs) =>
    new Promise(resolve => {
        try {
            execFile(
                'busctl',
                [`--timeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`, ...args],
                { timeout: timeoutMs + 250, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' },
                (err, stdout) => resolve({ ok: !err, stdout: typeof stdout === 'string' ? stdout : '' }),
            );
        } catch {
            resolve({ ok: false, stdout: '' });
        }
    });
