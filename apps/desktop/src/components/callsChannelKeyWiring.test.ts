import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guards for the call E2EE key gate — ALL call kinds.
 *
 * These pin *registration*, not logic — the class of bug where a piece is
 * built and unit-tested in isolation but never actually reaches the boot path.
 * The decision logic itself is covered by utils/callKeyGate.test.ts.
 *
 * Why source-scanning rather than rendering Dashboard: Dashboard.tsx is a
 * ~7.4k-line monolith with no test harness, so a render test would cost far
 * more than it pins. Same approach as services/backupRegistry's scan test.
 *
 * Each assertion below corresponds to a bug that actually shipped or was
 * one edit away:
 *
 *  1. Epoch 1 was minted ONLY by handleSelectChannel, so every call-join path
 *     (spawn huddle call / join existing / join legacy voice channel /
 *     moderator force-move) left the joiner on a permanent `waiting`. The fix
 *     hangs the bootstrap off activeCall.callsChannelId so a FIFTH join path
 *     added later is covered without anyone remembering to wire it.
 *
 *  2. The mount gate must keep failing CLOSED — a call may only mount
 *     CallPane through `callsChannelGate.kind === 'connect'`, which the gate's
 *     own tests prove never carries an empty key.
 *
 *  3. That gate must cover DM/group calls too. It did not until 2026-09-20:
 *     the mount check was qualified `call.callsChannelId && ...`, so a DM call
 *     whose `call_key` had lost the race mounted keyless and ran in PLAINTEXT
 *     to the SFU for its whole duration. The qualifier is the single character
 *     of this bug, which is exactly the kind of thing a source guard is for.
 */

const dashboard = readFileSync(
    join(__dirname, 'Dashboard.tsx'),
    'utf8',
);

describe('Calls-channel key bootstrap is driven from every join path', () => {
    it('extracts the bootstrap so the join paths and channel-open share one implementation', () => {
        expect(dashboard).toContain('const ensureChannelKeyBootstrap = useCallback');
        // handleSelectChannel must go through the shared function, not a copy.
        expect(dashboard).toContain('await ensureChannelKeyBootstrap(channel);');
    });

    it('drives the bootstrap off the active call rather than per-handler call sites', () => {
        const effect = dashboard.slice(
            dashboard.indexOf('const callKeyEnsuredForRef'),
        );
        expect(effect).toContain('void ensureChannelKeyBootstrap(');
        // Keyed on the call's channel — this is what makes all four (and any
        // future) join paths covered without touching their handlers.
        expect(effect).toMatch(/activeCall\?\.callsChannelId/);
        // serverChannels in the deps is load-bearing: force-move can land
        // before that server's channel list has, and the retry depends on it.
        expect(effect).toMatch(
            /\[activeCall\?\.id,\s*activeCall\?\.callsChannelId,\s*serverChannels,\s*ensureChannelKeyBootstrap\]/,
        );
    });

    it('has a setActiveCall site carrying callsChannelId for each known join path', () => {
        // Spawn, join-existing, legacy voice channel, force-move. If this count
        // changes, a join path was added or removed — confirm the ensure effect
        // still covers it (it should, being keyed on activeCall) and update.
        const sites = dashboard.match(/callsChannelId:/g) ?? [];
        expect(sites.length).toBe(4);
    });
});

describe('the CallPane mount gate stays fail-closed', () => {
    it('mounts only through the resolved gate, never on a raw status check', () => {
        expect(dashboard).toContain("if (callsChannelGate.kind !== 'connect') {");
        // The pre-fix gate read the hook directly. If that spelling comes back,
        // the mid-call hold (Problem 3) has been silently reverted.
        expect(dashboard).not.toContain("callsChannelKey.status !== 'ready'");
        // THE PLAINTEXT-CALL GUARD. Re-adding this qualifier lets a DM/group
        // call that lost the call_key race mount with an empty key again.
        expect(dashboard).not.toContain("call.callsChannelId && callsChannelGate.kind");
        expect(dashboard).not.toContain('call.callsChannelId && !effectiveE2eeKeyB64');
    });

    it('keeps the defensive empty-key refusal, for every call kind', () => {
        expect(dashboard).toContain('if (!effectiveE2eeKeyB64) {');
        // The key handed to CallPane comes from the gate, never straight off
        // the call object — `call.e2ee_key_b64` is exactly the value that is
        // empty while the call_key is still in flight.
        expect(dashboard).toContain('const effectiveE2eeKeyB64 = callsChannelGate.keyB64;');
    });

    it('re-renders when a call_key lands, so a late key is not lost', () => {
        // The key store is a REF, so writing to it renders nothing. That is
        // how a late call_key used to be dropped on the floor: it arrived
        // after CallPane was already mounted keyless and nothing re-evaluated.
        // Every writer must go through recordCallKey, which bumps the epoch.
        expect(dashboard).toContain('const recordCallKey = useCallback(');
        expect(dashboard).toContain('setCallKeyEpoch(n => n + 1);');
        // No writer may bypass it. The only direct writes left are the read
        // and the write inside recordCallKey itself.
        // `=` not followed by another `=`, so the guard's own
        // `if (store[id] === key) return;` comparison isn't counted as a write.
        const directWrites = dashboard.match(/callKeyStoreRef\.current\[[^\]]+\]\s*=(?!=)/g) ?? [];
        expect(directWrites.length).toBe(1);
    });

    it('only treats a ready key as usable when it was derived for THIS channel', () => {
        // React state lags its input by a render, so on the pass where the call
        // moves to another Calls channel (force-move, or hopping calls)
        // useCallsChannelKey still reports the PREVIOUS channel's ready key.
        // Dropping this check reintroduces a one-commit window where CallPane
        // mounts into channel B's room under channel A's key.
        expect(dashboard).toContain(
            "callsChannelKey.status === 'ready' && callsChannelKey.channelId === activeCallsChannelId",
        );
        // ...and the same binding is re-checked inside the gate itself.
        expect(dashboard).toContain('lastGoodChannelId:');
        expect(dashboard).toContain('keyChannelId:');
    });

    it('never offers a plaintext fallback or a join-anyway escape', () => {
        // Renamed from CallsChannelKeyNotice.tsx (2026-09-08): the old
        // full-width banner was replaced by a compact in-call indicator, but
        // the security wording guard applies just the same — see
        // CallEncryptionIndicator.tsx's own header comment for the mode
        // breakdown ('loading' / 'stalled' render pre-mount, standalone, with
        // their own leave affordance; 'connected' / 'degraded' render inside
        // SidebarConference for every call type).
        const notice = readFileSync(
            join(__dirname, 'server', 'CallEncryptionIndicator.tsx'),
            'utf8',
        );
        expect(notice.toLowerCase()).not.toContain('join anyway');
        expect(notice.toLowerCase()).not.toContain('connect anyway');
        expect(notice.toLowerCase()).not.toContain('continue without');
    });
});
