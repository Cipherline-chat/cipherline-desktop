import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guard for the crash-recovery "Rejoin call?" flow in
 * Dashboard.tsx (the pure rules are tested in utils/callRejoinPolicy.test.ts;
 * Dashboard has no render harness, so the wiring properties are pinned by
 * text scan, like callsChannelKeyWiring.test.ts / dmCallKeyWiring.test.ts).
 *
 * Each case names a way this feature fails SILENTLY if someone "tidies" it:
 * the record erased before it is read, the check aborted by a token refresh,
 * the offer read before the account's records exist, or — the one with a
 * safety consequence — the app re-entering a call (opening the mic) without
 * the user choosing to.
 */
const dashboard = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');

function bodyAfter(marker: string, len: number): string {
    const i = dashboard.indexOf(marker);
    expect(i, `marker not found: ${marker}`).toBeGreaterThan(-1);
    return dashboard.slice(i, i + len);
}

describe('crash-recovery rejoin wiring (Dashboard)', () => {
    it('only clears the record on a call → no-call transition it actually witnessed', () => {
        // Without hadRejoinCallRef the "no call" state at STARTUP would delete
        // the very record the startup check is about to read.
        const persist = bodyAfter('const hadRejoinCallRef', 1800);
        expect(persist).toMatch(/if \(!activeCall\) \{\s*if \(hadRejoinCallRef\.current\) \{/);
        expect(persist).toMatch(/hadRejoinCallRef\.current = true;/);
    });

    it('keeps the record fresh with a heartbeat and tears the interval down', () => {
        const persist = bodyAfter('const hadRejoinCallRef', 2200);
        expect(persist).toMatch(/setInterval\(write, REJOIN_HEARTBEAT_MS\)/);
        expect(persist).toMatch(/clearInterval\(timer\)/);
    });

    it('waits for the account’s records before reading, and never lets a token refresh abort the check', () => {
        const startup = bodyAfter('// (2) Startup check', 3800);
        // Per-account records are cold right after sign-in until this resolves.
        const ready = startup.indexOf('secureLocalStore.whenAccountReady()');
        const load = startup.indexOf('loadRejoinDescriptor(userId)');
        expect(ready).toBeGreaterThan(-1);
        expect(load).toBeGreaterThan(ready);
        // The abort trap: a per-effect `cancelled` flag keyed on `token` kills the
        // in-flight check on the first refresh while the started-once guard stops
        // it ever re-running. Liveness is an unmount-only ref instead.
        expect(startup).not.toMatch(/(?:let|const)\s+cancelled\b|if \(cancelled\)|!cancelled/);
        expect(startup).toContain('rejoinAliveRef.current');
        // The status request must use the latest token, not the closure's.
        expect(startup).toContain('rejoinTokenRef.current');
        expect(startup).not.toMatch(/Bearer \$\{token\}/);
    });

    it('only offers once the server confirms the call is still active, and never on a bare failure', () => {
        const startup = bodyAfter('// (2) Startup check', 3800);
        expect(startup).toMatch(/\/calls\/\$\{d\.sessionId\}\/status/);
        expect(startup).toContain('decideRejoinOffer(status');
        // A user who already joined something by hand is not nagged.
        expect(startup).toMatch(/activeCallRef\.current\) return/);
    });

    it('NEVER rejoins on its own — acceptRejoin is reachable only from the banner’s Rejoin button', () => {
        // Calls are never auto-resumed: the user may have crashed because
        // something was wrong, or wanted out, and an automatic re-entry would
        // open the mic in a room they believed they had left.
        const direct = dashboard.match(/\bacceptRejoin\(/g) ?? [];
        expect(direct).toHaveLength(0);
        expect(dashboard).toMatch(/onRejoin=\{acceptRejoin\}/);
        // …and every start path for a rejoin is inside acceptRejoin itself.
        const accept = bodyAfter('const acceptRejoin = useCallback', 2600);
        expect(accept).toContain('if (!d || !token || !deviceId || rejoinBusy) return;');
    });

    it('drops the prompt when a call starts, by adjusting state in render (not an effect that could repaint it)', () => {
        expect(dashboard).toContain('if (activeCall && rejoinOffer) setRejoinOffer(null);');
    });

    it('persists NO LiveKit token anywhere in the rejoin path', () => {
        const region = bodyAfter('// ── Crash-recovery: "Rejoin call?"', 7600);
        // The descriptor builder is handed the call object, and the store only
        // ever sees what buildRejoinDescriptor returns — assert no token field
        // is read in the persistence half.
        const persist = region.slice(0, region.indexOf('// (2) Startup check'));
        expect(persist).not.toMatch(/livekit_token/);
    });
});
