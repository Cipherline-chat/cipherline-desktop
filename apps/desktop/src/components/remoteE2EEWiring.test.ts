import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guards for the per-remote-participant encryption warning.
 *
 * The decision logic lives in utils/remoteE2EEWatch.ts and is unit-tested
 * there. These pin *registration and presentation* — the class of bug where a
 * correct module is built, unit-tested, and never actually reaches the UI, or
 * reaches it wearing the wrong colour.
 *
 * Source-scanning rather than rendering, for the documented reason: there is
 * no @testing-library in this workspace, Dashboard.tsx is a ~7.4k-line
 * monolith and SidebarConference.tsx ~4.4k, so a render harness would cost
 * far more than it pins. Same approach as callsChannelKeyWiring.test.ts.
 *
 * The bug being guarded against is one that actually shipped: livekit-client
 * enables decryption PER REMOTE PARTICIPANT from the SFU-reported track
 * encryption, so a peer on a build older than 1.0.13 sends media the server
 * can read — while every padlock in the app, derived from LOCAL key state
 * alone, stayed green.
 */

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

const callPane = read('CallPane.tsx');
const dashboard = read('Dashboard.tsx');
const sidebar = read('SidebarConference.tsx');
const huddleButton = read('server/HuddleButton.tsx');
const indicator = read('server/CallEncryptionIndicator.tsx');
const watcher = read('RemoteE2EEWatcher.tsx');

describe('the watcher actually reaches the call', () => {
    it('CallPane mounts RemoteE2EEWatcher', () => {
        expect(callPane).toContain("import { RemoteE2EEWatcher } from './RemoteE2EEWatcher'");
        expect(callPane).toContain('<RemoteE2EEWatcher');
    });

    it('mounts it UNCONDITIONALLY — a keyless call is exactly when it matters most', () => {
        // Guards against "optimising" the watcher behind `e2eeKeyB64 &&`, which
        // would blind the one case where the local side is already known-bad.
        const at = callPane.indexOf('<RemoteE2EEWatcher');
        expect(at).toBeGreaterThan(-1);
        const preceding = callPane.slice(Math.max(0, at - 400), at);
        expect(preceding).not.toMatch(/e2eeKeyB64\s*&&\s*$/);
        expect(preceding).not.toMatch(/expectEncrypted\s*&&\s*$/);
    });

    it('reports both down to the call UI and up to Dashboard', () => {
        // Down: the in-call pill. Up: the channel-row padlock. Losing either
        // leaves one surface lying.
        expect(callPane).toContain('setRemoteEncryption(snapshot)');
        expect(callPane).toContain('onRemoteEncryptionChange?.(snapshot)');
        expect(callPane).toContain('unencryptedIdentities={remoteEncryption.unencryptedIdentities}');
    });

    it('is an observer — it never disconnects or fails the call', () => {
        // The whole point: remote plaintext is an interop fact, not a local
        // regression. Refusing would make calling an un-updated contact
        // impossible. See the module docstring.
        expect(watcher).not.toContain('disconnect(');
        expect(watcher).not.toContain('onFailure');
        expect(watcher).not.toContain('setE2EEEnabled');
    });
});

describe('Dashboard downgrades the channel-row padlock', () => {
    it("derives 'mixed' rather than reporting only local key state", () => {
        expect(dashboard).toContain("const [unencryptedPeersForCallId, setUnencryptedPeersForCallId] = useState<string | null>(null)");
        expect(dashboard).toContain("onRemoteEncryptionChange={(snapshot) => setUnencryptedPeersForCallId(snapshot.anyUnencrypted ? call.id : null)}");
        expect(dashboard).toContain("? (callHasUnencryptedPeers ? 'mixed' : 'connected')");
    });

    it("never yields 'connected' while a peer is unencrypted", () => {
        // The precise regression: `callsChannelGate.kind === 'connect'` used to
        // map straight to 'connected'. If that bare mapping comes back, this
        // fails.
        expect(dashboard).not.toMatch(/callsChannelGate\.kind === 'connect' \? 'connected'/);
    });

    it('scopes the warning to a CALL ID so it cannot outlive or precede its cause', () => {
        // A boolean would need an effect to clear it on call end, and would
        // still show the previous call's warning during the window where a new
        // call has mounted but its watcher has not yet reported. Comparing ids
        // is self-expiring: a stale id simply never matches.
        expect(dashboard).toContain("const callHasUnencryptedPeers = !!activeCall && unencryptedPeersForCallId === activeCall.id");
        expect(dashboard).not.toContain('setCallHasUnencryptedPeers');
    });
});

describe('the warning is presented as a warning, not a padlock', () => {
    it("HuddleButton renders 'mixed' with a distinct glyph, never a Lock", () => {
        const at = huddleButton.indexOf("encryptionState === 'mixed'");
        expect(at).toBeGreaterThan(-1);
        const block = huddleButton.slice(at, at + 700);
        expect(block).toContain('ShieldAlert');
        // A tinted padlock still reads as "encrypted" at 9px — that is the
        // overstatement this whole change exists to remove.
        expect(block).not.toContain('<Lock');
    });

    it('the mixed indicator names people rather than counting them', () => {
        expect(indicator).toContain("mode === 'mixed'");
        expect(indicator).toContain('unencryptedNames');
        // "Someone" is only the no-names fallback, never the normal rendering.
        expect(indicator).toContain('Someone in this call is');
        expect(indicator).toContain('names[0]');
    });

    it('the mixed indicator never claims the call is encrypted', () => {
        const at = indicator.indexOf("if (mode === 'mixed')");
        const block = indicator.slice(at, indicator.indexOf("if (mode === 'connected'"));
        expect(block).not.toMatch(/>\s*Encrypted\s*</);
        expect(block).toContain('not encrypted');
    });
});

describe("'mixed' outranks 'degraded' in the in-call pill", () => {
    it('renders the mixed warning in preference to the amber key-drift notice', () => {
        // 'degraded' still says "Encrypted" (correctly — the call is). Showing
        // it over 'mixed' would show the milder state over the worse one.
        expect(sidebar).toContain('{unencryptedNames.length > 0 ? (');
        expect(sidebar).toContain('<CallEncryptionIndicator mode="mixed" unencryptedNames={unencryptedNames} />');
        const at = sidebar.indexOf('unencryptedNames.length > 0 ?');
        const degradedAt = sidebar.indexOf("encryptionIndicatorMode === 'degraded'", at);
        expect(degradedAt).toBeGreaterThan(at);
    });

    it('resolves identities to display names before showing them to a human', () => {
        expect(sidebar).toContain("p.name || 'Unknown'");
        expect(sidebar).toContain('const unencryptedNames = React.useMemo');
    });
});
