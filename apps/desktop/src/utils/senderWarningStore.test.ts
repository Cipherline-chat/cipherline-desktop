/**
 * The warning LIFETIME suite.
 *
 * The threshold — which verdicts are warnable at all — is `senderTrust.ts`'s
 * job and is covered by `senderTrust.test.ts`. Nothing here changes it. What
 * this file pins down is how long a warning that HAS been raised survives, and
 * the answer is: until the user explicitly resolves it, across restarts and
 * across a backup restore.
 *
 * The central test is `survives a restart`, and it is positive-controlled
 * against `legacySession()` — a harness that reproduces exactly what
 * `Dashboard.tsx` did before this change (state only, nothing written to disk)
 * and demonstrably loses the warning. Without that control the persistence
 * test would pass just as happily against a store that was never wired up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secureLocalStore } from './secureLocalStore';
import { KvCrypto } from '../../electron/kv-crypto';
import {
    loadWarnings, raiseWarning, resolveWarning, snapshotWarnings, mergeWarnings,
    warnKey, MAX_WARNINGS, type WarningRecord,
} from './senderWarningStore';
import { markVerified, recordFirstSeen } from './keyVerification';
import { collectIncludedKv, applyIncludedKv, classifyKvKey } from '../services/backupRegistry';
import type { SenderVerdict } from './senderTrust';

const TEST_KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAROL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const OLD_PUB = 'pub-the-one-we-pinned';
const NEW_PUB = 'pub-the-one-that-showed-up-instead';
const DEVICE = 'device-1';

type KeyStatus = 'ok' | 'locked';

/** Renderer's view of the main process, backed by the REAL KvCrypto — same
 *  arrangement secureLocalStore.test.ts uses, for the same reason. */
function setMasterKey(status: KeyStatus) {
    const keyBytes = status === 'ok' ? Buffer.from(TEST_KEY_B64, 'base64') : null;
    const kv = new KvCrypto({ status: () => status, keyBytes: () => keyBytes });
    (globalThis as any).window.electronAPI = {
        getLocalMasterKeyStatus: vi.fn(async () => ({ status })),
        secureKvOpen: vi.fn(async (r: any) => kv.open(r)),
        secureKvSeal: vi.fn(async (r: any) => kv.seal(r)),
    };
}

async function wipeDb(): Promise<void> {
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('cipherline');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
    });
}

/** Quit and relaunch: drop every in-memory singleton and re-read from disk. */
async function relaunch(status: KeyStatus = 'ok'): Promise<void> {
    secureLocalStore._resetForTest();
    setMasterKey(status);
    await secureLocalStore.hydrate();
}

async function signIn(userId: string): Promise<void> {
    secureLocalStore.setItem('cipherline_user_id', userId);
    await secureLocalStore.whenAccountReady();
}

async function signOut(): Promise<void> {
    secureLocalStore.removeItem('cipherline_user_id');
    await secureLocalStore.flushNow();
}

/**
 * The Dashboard's warning lifecycle, reduced to the three points that matter.
 * `persist: false` reproduces the pre-change behaviour so every persistence
 * assertion below has a control that proves it is actually testing something.
 */
function session(myUserId: string, persist = true) {
    let warnings: Record<string, SenderVerdict> = {};
    return {
        get warnings() { return warnings; },
        /** Mirrors pinAndDetect's warnable branch. */
        raise(them: string, verdict: SenderVerdict, pub: string, device?: string) {
            warnings = { ...warnings, [them]: verdict };
            if (persist) raiseWarning(myUserId, them, verdict, pub, device);
        },
        /**
         * Mirrors pinAndDetect's NON-warnable branch: pin, and deliberately do
         * NOT touch the warning. A later message consistent with the new pin is
         * the attacker's own key being used consistently.
         */
        benign(them: string, pub: string, device?: string) {
            recordFirstSeen(myUserId, them, pub, device);
        },
        /** Mirrors clearSenderWarning — verify / acknowledge / dismiss. */
        resolve(them: string) {
            const next = { ...warnings };
            delete next[them];
            warnings = next;
            if (persist) resolveWarning(myUserId, them);
        },
        /** Mirrors the boot rehydrate effect. */
        rehydrate() {
            warnings = persist ? { ...loadWarnings(myUserId), ...warnings } : { ...warnings };
        },
        /** Mirrors unmount. */
        teardown() { warnings = {}; },
    };
}

beforeEach(async () => {
    await wipeDb();
    secureLocalStore._resetForTest();
    setMasterKey('ok');
});

afterEach(() => { vi.restoreAllMocks(); });

// ─────────────────────────────────────────────────────────────────────────────

describe('the restart — the defect this exists to close', () => {
    it('survives a restart: raised, torn down, rehydrated, still present', async () => {
        await relaunch();
        await signIn(USER_A);

        const first = session(USER_A);
        first.raise(BOB, 'key_changed', NEW_PUB, DEVICE);
        expect(first.warnings[BOB]).toBe('key_changed');
        await secureLocalStore.flushNow();
        first.teardown();

        await relaunch();
        await signIn(USER_A);
        const second = session(USER_A);
        second.rehydrate();

        expect(second.warnings[BOB]).toBe('key_changed');
    });

    it('POSITIVE CONTROL — the pre-change, state-only version loses it', async () => {
        await relaunch();
        await signIn(USER_A);

        const first = session(USER_A, /* persist */ false);
        first.raise(BOB, 'key_changed', NEW_PUB, DEVICE);
        expect(first.warnings[BOB]).toBe('key_changed');
        await secureLocalStore.flushNow();
        first.teardown();

        await relaunch();
        await signIn(USER_A);
        const second = session(USER_A, false);
        second.rehydrate();

        // The alarm turned itself off. This is what shipped before.
        expect(second.warnings[BOB]).toBeUndefined();
    });

    it('a warning raised in-session wins over the stored snapshot', async () => {
        await relaunch();
        await signIn(USER_A);
        raiseWarning(USER_A, BOB, 'key_changed', NEW_PUB, DEVICE);

        const s = session(USER_A);
        // Escalated this session by a fresh envelope, before the rehydrate lands.
        s.raise(BOB, 'unattributed', 'pub-forged');
        s.rehydrate();
        expect(s.warnings[BOB]).toBe('unattributed');
    });
});

describe('what does NOT resolve a warning', () => {
    it('a later message consistent with the NEW pin does not clear it', async () => {
        await relaunch();
        await signIn(USER_A);

        const s = session(USER_A);
        s.raise(BOB, 'key_changed', NEW_PUB, DEVICE);
        // The attacker keeps using the same key. Consistency is not safety.
        s.benign(BOB, NEW_PUB, 'device-attacker');
        s.benign(BOB, NEW_PUB, 'device-attacker');
        await secureLocalStore.flushNow();

        await relaunch();
        await signIn(USER_A);
        expect(loadWarnings(USER_A)[BOB]).toBe('key_changed');
    });

    it('TOFU-pinning the offending key does not retire the warning', async () => {
        await relaunch();
        await signIn(USER_A);
        raiseWarning(USER_A, BOB, 'key_changed', NEW_PUB, DEVICE);
        // `recordFirstSeen` pins but never vouches — verified stays false.
        recordFirstSeen(USER_A, BOB, NEW_PUB, 'device-attacker');

        expect(loadWarnings(USER_A)[BOB]).toBe('key_changed');
    });

    it('re-raising the same verdict keeps the original raised-at', async () => {
        await relaunch();
        await signIn(USER_A);
        raiseWarning(USER_A, BOB, 'key_changed', NEW_PUB, DEVICE);
        const first = snapshotWarnings(USER_A)[BOB].at;
        raiseWarning(USER_A, BOB, 'unattributed', 'pub-forged');
        expect(snapshotWarnings(USER_A)[BOB].at).toBe(first);
        expect(snapshotWarnings(USER_A)[BOB].verdict).toBe('unattributed');
    });
});

describe('what DOES resolve a warning', () => {
    it('explicit resolution clears it, and it stays cleared across a restart', async () => {
        await relaunch();
        await signIn(USER_A);

        const s = session(USER_A);
        s.raise(BOB, 'key_changed', NEW_PUB, DEVICE);
        s.resolve(BOB);
        expect(s.warnings[BOB]).toBeUndefined();
        await secureLocalStore.flushNow();

        await relaunch();
        await signIn(USER_A);
        const second = session(USER_A);
        second.rehydrate();
        expect(second.warnings[BOB]).toBeUndefined();
    });

    it('verifying the OFFENDING key out of band retires it at load', async () => {
        await relaunch();
        await signIn(USER_A);
        raiseWarning(USER_A, BOB, 'key_changed', NEW_PUB, DEVICE);
        // The safety number for the new key checked out — the strongest
        // resolution there is, and the one that must survive a restore where
        // only the pins came back.
        markVerified(USER_A, BOB, NEW_PUB, 'device-attacker');

        expect(loadWarnings(USER_A)[BOB]).toBeUndefined();
        // …and the record is compacted, not merely filtered on read.
        expect(snapshotWarnings(USER_A)[BOB]).toBeUndefined();
    });

    it('verifying a DIFFERENT key of the same contact does not retire it', async () => {
        await relaunch();
        await signIn(USER_A);
        raiseWarning(USER_A, BOB, 'unrecognized_verified', 'pub-forged', undefined);
        markVerified(USER_A, BOB, OLD_PUB, DEVICE);

        expect(loadWarnings(USER_A)[BOB]).toBe('unrecognized_verified');
    });
});

describe('per-account isolation', () => {
    it("account A never sees account B's warnings", async () => {
        await relaunch();
        await signIn(USER_A);
        raiseWarning(USER_A, BOB, 'key_changed', NEW_PUB, DEVICE);
        await secureLocalStore.flushNow();
        await signOut();

        await signIn(USER_B);
        expect(loadWarnings(USER_B)).toEqual({});
        raiseWarning(USER_B, CAROL, 'unattributed', 'pub-forged');
        await secureLocalStore.flushNow();
        await signOut();

        await relaunch();
        await signIn(USER_A);
        expect(loadWarnings(USER_A)).toEqual({ [BOB]: 'key_changed' });
        await signOut();
        await signIn(USER_B);
        expect(loadWarnings(USER_B)).toEqual({ [CAROL]: 'unattributed' });
    });

    it('the key sits in the per-account tier, so it is HKDF-scoped', () => {
        // ownerFor() routes on a `_{uid}` boundary; get this wrong and the
        // record encrypts under the master key and leaks across accounts.
        expect(warnKey(USER_A).endsWith(`_${USER_A}`)).toBe(true);
    });
});

describe('the cold-namespace hazard', () => {
    it('reads empty between the sign-in click and whenAccountReady()', async () => {
        await relaunch();
        await signIn(USER_A);
        raiseWarning(USER_A, BOB, 'key_changed', NEW_PUB, DEVICE);
        await secureLocalStore.flushNow();
        await signOut();

        await relaunch();
        secureLocalStore.setItem('cipherline_user_id', USER_A);   // the click
        expect(secureLocalStore.isAccountReady(USER_A)).toBe(false);
        // This is the window a rehydrate must NOT read in — it would conclude
        // "no warnings", which is the silence the whole change exists to stop.
        expect(loadWarnings(USER_A)).toEqual({});

        await secureLocalStore.whenAccountReady();
        expect(secureLocalStore.isAccountReady(USER_A)).toBe(true);
        expect(loadWarnings(USER_A)[BOB]).toBe('key_changed');
    });
});

describe('degradation', () => {
    it('a locked keystore neither throws nor writes', async () => {
        await relaunch('locked');
        expect(secureLocalStore.isLocked()).toBe(true);

        expect(() => raiseWarning(USER_A, BOB, 'key_changed', NEW_PUB, DEVICE)).not.toThrow();
        expect(() => resolveWarning(USER_A, BOB)).not.toThrow();
        expect(loadWarnings(USER_A)).toEqual({});
    });

    it('an unreadable record reads empty and is LEFT ON DISK', async () => {
        await relaunch();
        await signIn(USER_A);
        secureLocalStore.setItem(warnKey(USER_A), 'not json at all');

        expect(loadWarnings(USER_A)).toEqual({});
        // Not cleared: a later build (or a support path) can still recover it,
        // and clearing would be this module destroying the only copy of an
        // alarm it could not read.
        expect(secureLocalStore.getItem(warnKey(USER_A))).toBe('not json at all');
    });

    it('an entry with an unrecognised verdict is KEPT, coerced to the strongest', async () => {
        await relaunch();
        await signIn(USER_A);
        secureLocalStore.setItem(warnKey(USER_A), JSON.stringify({
            v: 1, warnings: { [BOB]: { verdict: 'some_future_verdict', pub: NEW_PUB, at: 1 } },
        }));
        // Fail toward showing the warning: we know something was flagged even
        // though this build cannot name it.
        expect(loadWarnings(USER_A)[BOB]).toBe('unattributed');
    });

    it('an entry with a known BENIGN verdict is dropped, not rendered', async () => {
        await relaunch();
        await signIn(USER_A);
        secureLocalStore.setItem(warnKey(USER_A), JSON.stringify({
            v: 1, warnings: {
                [BOB]: { verdict: 'first_contact', pub: OLD_PUB, at: 1 },
                [CAROL]: { verdict: 'ok', pub: OLD_PUB, at: 1 },
            },
        }));
        // These are not alarms and never get written here. Coercing them up
        // would be inventing a warning, which is the opposite error.
        expect(loadWarnings(USER_A)).toEqual({});
    });

    it('raiseWarning refuses a non-warnable verdict outright', async () => {
        await relaunch();
        await signIn(USER_A);
        raiseWarning(USER_A, BOB, 'first_contact' as SenderVerdict, OLD_PUB, DEVICE);
        expect(loadWarnings(USER_A)).toEqual({});
    });
});

describe('storage bound', () => {
    // 30s, not the default 5s. This one writes MAX_WARNINGS entries through the
    // real encrypted store — measured at 372ms on an idle box, which is only
    // ~13x under the budget. That sounds safe and is not: this dev box
    // routinely sits at load 15-22 with several suites running, and a
    // CPU-bound test slows more than 13x there. It was observed timing out
    // under exactly those conditions. Same class as the rnnoise files and the
    // tooltip sweeps — a TIMEOUT, never an assertion, passing instantly in
    // isolation, which reads exactly like a real regression and is not one.
    it('caps the table, refusing NEW entries rather than evicting existing ones', async () => {
        await relaunch();
        await signIn(USER_A);

        raiseWarning(USER_A, BOB, 'key_changed', NEW_PUB, DEVICE);
        for (let i = 0; i < MAX_WARNINGS + 50; i++) {
            raiseWarning(USER_A, `flood-${i}`, 'unattributed', `pub-${i}`);
        }
        const stored = snapshotWarnings(USER_A);
        expect(Object.keys(stored).length).toBe(MAX_WARNINGS);
        // The whole point of refuse-new over LRU: a hostile server can mint
        // envelopes claiming arbitrary sender ids, so an eviction policy would
        // let it push a real, targeted warning out by flooding.
        expect(stored[BOB]?.verdict).toBe('key_changed');

        // An existing contact can still be UPDATED at the cap.
        raiseWarning(USER_A, BOB, 'unattributed', 'pub-forged');
        expect(snapshotWarnings(USER_A)[BOB].verdict).toBe('unattributed');
        expect(Object.keys(snapshotWarnings(USER_A)).length).toBe(MAX_WARNINGS);
    }, 30_000);

    it('clips an over-long pub off the wire instead of storing it whole', async () => {
        await relaunch();
        await signIn(USER_A);
        // `sp` is attacker-chosen and nothing upstream length-checks it.
        raiseWarning(USER_A, BOB, 'key_changed', 'x'.repeat(100_000), DEVICE);

        const rec = snapshotWarnings(USER_A)[BOB];
        expect(rec.pub.length).toBeLessThanOrEqual(512);
        // Truncated, not dropped — the alarm still stands.
        expect(loadWarnings(USER_A)[BOB]).toBe('key_changed');
        expect(secureLocalStore.getItem(warnKey(USER_A))!.length).toBeLessThan(2000);
    });

    it('enforces the cap on READ too, so a restored record cannot bypass it', async () => {
        await relaunch();
        await signIn(USER_A);
        // applyIncludedKv writes a vault's record verbatim; the write-side cap
        // never sees it.
        const oversized: Record<string, unknown> = {};
        for (let i = 0; i < MAX_WARNINGS * 4; i++) {
            oversized[`planted-${i}`] = { verdict: 'unattributed', pub: 'p', at: 1 };
        }
        secureLocalStore.setItem(warnKey(USER_A), JSON.stringify({ v: 1, warnings: oversized }));

        expect(Object.keys(loadWarnings(USER_A)).length).toBe(MAX_WARNINGS);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('backup round trip', () => {
    it('is classified as included — the pins alone would restore only the reassuring half', () => {
        expect(classifyKvKey(warnKey(USER_A), USER_A)).toBe('include');
        // Sanity: the pins it must stay consistent with are included too.
        expect(classifyKvKey(`kv_verify_v2_${USER_A}_${BOB}`, USER_A)).toBe('include');
    });

    it('raised -> backed up -> restored onto a fresh device -> still present AND still dismissible', async () => {
        await relaunch();
        await signIn(USER_A);
        raiseWarning(USER_A, BOB, 'key_changed', NEW_PUB, DEVICE);
        recordFirstSeen(USER_A, BOB, OLD_PUB, DEVICE);    // the pin it contradicts
        const vault = collectIncludedKv(secureLocalStore, USER_A);
        expect(Object.keys(vault)).toContain('kv_warn_v1_{uid}');
        await secureLocalStore.flushNow();

        // A brand-new install of the same account: nothing local at all.
        await wipeDb();
        await relaunch();
        await signIn(USER_A);
        expect(loadWarnings(USER_A)).toEqual({});

        const local = snapshotWarnings(USER_A);
        applyIncludedKv(secureLocalStore, vault, USER_A);
        mergeWarnings(USER_A, local);

        expect(loadWarnings(USER_A)[BOB]).toBe('key_changed');
        // A warning that survives a restore and cannot be cleared would be a
        // worse bug than the one being fixed.
        resolveWarning(USER_A, BOB);
        expect(loadWarnings(USER_A)[BOB]).toBeUndefined();
    });

    it('POSITIVE CONTROL — a restore that skips the key restores the pins and drops the alarm', async () => {
        await relaunch();
        await signIn(USER_A);
        raiseWarning(USER_A, BOB, 'key_changed', NEW_PUB, DEVICE);
        markVerified(USER_A, BOB, OLD_PUB, DEVICE);
        const vault = collectIncludedKv(secureLocalStore, USER_A);
        await secureLocalStore.flushNow();

        await wipeDb();
        await relaunch();
        await signIn(USER_A);
        const withoutWarnings = Object.fromEntries(
            Object.entries(vault).filter(([k]) => !k.startsWith('kv_warn_v1_')),
        );
        applyIncludedKv(secureLocalStore, withoutWarnings, USER_A);

        // Bob comes back looking verified, with no record that his key ever
        // changed. Exactly the security regression the `include` rule prevents.
        expect(loadWarnings(USER_A)).toEqual({});
        expect(secureLocalStore.getItem(`kv_verify_v2_${USER_A}_${BOB}`)).toContain(OLD_PUB);
    });

    it('restore UNIONS: an alarm raised since the backup is not dropped by it', async () => {
        await relaunch();
        await signIn(USER_A);
        raiseWarning(USER_A, BOB, 'key_changed', NEW_PUB, DEVICE);
        const vault = collectIncludedKv(secureLocalStore, USER_A);   // knows about BOB only

        // Later, on this device, a second contact goes bad.
        raiseWarning(USER_A, CAROL, 'unattributed', 'pub-forged');

        const local = snapshotWarnings(USER_A);
        applyIncludedKv(secureLocalStore, vault, USER_A);             // would drop CAROL
        mergeWarnings(USER_A, local);

        const after = loadWarnings(USER_A);
        expect(after[BOB]).toBe('key_changed');
        expect(after[CAROL]).toBe('unattributed');
    });

    it('a restored warning whose key the user has since verified retires itself', async () => {
        await relaunch();
        await signIn(USER_A);
        raiseWarning(USER_A, BOB, 'key_changed', NEW_PUB, DEVICE);
        const stale: Record<string, WarningRecord> =
            JSON.parse(JSON.stringify(snapshotWarnings(USER_A)));
        resolveWarning(USER_A, BOB);
        // The resolution was a genuine out-of-band verification of that key.
        markVerified(USER_A, BOB, NEW_PUB, 'device-2');

        // An old backup carrying the already-resolved warning comes back.
        mergeWarnings(USER_A, stale);
        expect(snapshotWarnings(USER_A)[BOB]).toBeDefined();
        // …and loadWarnings recognises the pins as the stronger, later evidence.
        expect(loadWarnings(USER_A)[BOB]).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * A module can be perfectly correct and simply never called — this repo has a
 * documented history of exactly that ("modules tested in isolation but never
 * registered at boot"). Everything above runs against a harness that mirrors
 * Dashboard.tsx; this checks the real file agrees.
 */
describe('Dashboard wiring', () => {
    const dashboard = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'Dashboard.tsx'),
        'utf8',
    );

    it('imports and calls all three entry points', () => {
        expect(dashboard).toMatch(/from '\.\.\/utils\/senderWarningStore'/);
        expect(dashboard).toMatch(/raiseWarning\(/);
        expect(dashboard).toMatch(/resolveWarning\(/);
        expect(dashboard).toMatch(/loadWarnings\(/);
    });

    it('gates the rehydrate on whenAccountReady()', () => {
        // Per-account records are cold until this resolves; reading early
        // returns empty, which reads as "no warnings".
        const rehydrate = dashboard.slice(
            dashboard.indexOf('could not restore sender warnings') - 2000,
            dashboard.indexOf('could not restore sender warnings'),
        );
        expect(rehydrate).toMatch(/await secureLocalStore\.whenAccountReady\(\)/);
        expect(rehydrate).toMatch(/isAccountReady\(userId\)/);
    });

    it('has no effect that mirrors senderWarnings state back to storage', () => {
        // The shape that wiped pins and ignored-games: an effect keyed on the
        // state, firing once on mount with the empty initial value. All writes
        // here are write-through at the raise/resolve points instead.
        expect(dashboard).not.toMatch(/\[senderWarnings, userId\]/);
    });
});
