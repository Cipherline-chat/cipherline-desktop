import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guard for the DM/group call key store.
 *
 * The property being pinned: **a device that STARTS a DM/group call must
 * record the key it generated in `callKeyStoreRef`**, because nothing else
 * ever can.
 *
 * `GET /conversations/:id/devices` — the list a `call_key` message is
 * addressed to — deliberately excludes "the sender's exact current device"
 * (apps/api/src/conversations/conversations.service.ts). So the starting
 * device is never a recipient of its own key and can never learn it back off
 * the wire; `callKeyStoreRef` was populated ONLY from decrypted incoming
 * envelopes. Every later local join of a session this device started
 * therefore read `callKeyStoreRef.current[id] || ''` and got '' — both the
 * `joined: true` advisory-lock merge in `startGlobalCall` and the chat pane's
 * "Join Call" banner do exactly that — which mounts CallPane with no room
 * key: a DM call connected in PLAINTEXT while every peer that did receive the
 * key publishes GCM. A Calls-channel call cannot reach that state (its key is
 * derived from the channel Sender Key and the mount is gated on having it),
 * which is why this failure mode is DM/group-only.
 *
 * Same approach as callsChannelKeyWiring.test.ts / e2eeActivationWiring.test.ts:
 * Dashboard has no render harness, and "the generated key is written to the
 * store" is a registration property a text scan pins cheaply.
 */

const dashboard = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');

/** The body of a named arrow/function declaration in Dashboard, from its name to `len` chars on. */
const bodyAfter = (needle: string, len: number) => {
    const idx = dashboard.indexOf(needle);
    expect(idx, `${needle} not found in Dashboard.tsx`).toBeGreaterThan(-1);
    return dashboard.slice(idx, idx + len);
};

describe('DM/group call keys this device generated are recorded locally', () => {
    // The three writers now go through `recordCallKey` rather than assigning
    // into the ref directly. That indirection is not cosmetic: a bare ref
    // write renders nothing, which is how a `call_key` that arrived AFTER
    // CallPane had already mounted used to be lost — and, before the mount
    // gate covered DM calls, that meant the call ran in plaintext for its
    // whole duration. recordCallKey bumps an epoch so the gate re-runs.
    it('startGlobalCall records the session key it generated', () => {
        const body = bodyAfter('const startGlobalCall', 3000);
        expect(body).toMatch(/recordCallKeyRef\.current\(initRes\.data\.session_id,\s*sessionKey\)/);
    });

    it('startGlobalCall records it BEFORE setActiveCall, so no mount can race the write', () => {
        const body = bodyAfter('const startGlobalCall', 8000);
        const write = body.search(/recordCallKeyRef\.current\(initRes\.data\.session_id/);
        const mount = body.indexOf('setActiveCall({');
        expect(write).toBeGreaterThan(-1);
        expect(mount).toBeGreaterThan(-1);
        expect(write).toBeLessThan(mount);
    });

    it('the ChatPane start/rotate path records its key too (handleConvCallChange)', () => {
        const body = bodyAfter('const handleConvCallChange', 1200);
        expect(body).toMatch(/recordCallKeyRef\.current\(callData\.id,\s*callData\.e2ee_key_b64\)/);
    });

    it('a key is only ever recorded when it is non-empty (never clobber a real key with "")', () => {
        // '' is the sentinel every keyless read produces; writing it back would
        // turn "we have not learned this key yet" into "this call has no key".
        // Guarded twice now — at both call sites AND inside recordCallKey, which
        // is what makes a future fourth caller safe by default.
        expect(dashboard).toMatch(/if \(sessionKey\) recordCallKeyRef\.current\(initRes\.data\.session_id, sessionKey\)/);
        expect(dashboard).toMatch(/if \(callData\.e2ee_key_b64\) recordCallKeyRef\.current\(callData\.id, callData\.e2ee_key_b64\)/);
        const guard = bodyAfter('const recordCallKey = useCallback', 400);
        expect(guard).toContain('if (!callId || !keyB64) return;');
    });

    it('every writer goes through recordCallKey — the ref is never assigned directly', () => {
        // A direct assignment would skip the epoch bump and silently reinstate
        // the lost-late-key bug. `=` not followed by `=` so recordCallKey's own
        // `if (store[id] === key) return;` comparison is not counted.
        const direct = dashboard.match(/callKeyStoreRef\.current\[[^\]]+\]\s*=(?!=)/g) ?? [];
        expect(direct).toHaveLength(1); // the one inside recordCallKey itself
        const inside = bodyAfter('const recordCallKey = useCallback', 400);
        expect(inside).toMatch(/callKeyStoreRef\.current\[callId\]\s*=\s*keyB64;/);
    });

    it('the store is still never fed from a server response — only local generation or a decrypted envelope', () => {
        // The three callers: the decrypted `call_key` envelope, startGlobalCall's
        // own generated key, and ChatPane's via handleConvCallChange. Any fourth
        // needs the same scrutiny — a key handed over by the server would defeat
        // the entire point of distributing it through the E2EE message channel.
        const calls = dashboard.match(/recordCallKeyRef\.current\(/g) ?? [];
        expect(calls).toHaveLength(3);
        expect(dashboard).not.toMatch(/recordCallKeyRef\.current\([^,]+,\s*(res|initRes)\.data/);
    });
});
