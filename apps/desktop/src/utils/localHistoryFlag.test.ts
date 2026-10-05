import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { secureLocalStore } from './secureLocalStore';
import * as messageStore from './messageStore';
import { hasLocalHistory, markLocalHistory, probeLocalHistory, localHistoryKey } from './localHistoryFlag';
import { KvCrypto } from '../../electron/kv-crypto';

/**
 * The reported bug, end to end:
 *
 *   "If you sign out of an account on your PC then sign into another one, then
 *    go sign back into the original account, it says that no message history
 *    exists and it wants me to sync or restore backup. But if I start fresh all
 *    my history is still there as it should be."
 *
 * Severity is data-integrity, not cosmetic: the false "no history" state is the
 * one that offers RESTORE FROM BACKUP, so a user who accepts writes an older
 * vault over local data that was never missing.
 *
 * These run against the REAL store — real `KvCrypto` in place of the main
 * process, real IndexedDB (fake-indexeddb), real AES-GCM — because the bug was
 * in the interaction between the store's account-switch teardown and its
 * rebind, and a mocked store answers neither half.
 */

const TEST_KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

function setMasterKey(status: 'ok' | 'locked' = 'ok') {
    const keyBytes = status === 'ok' ? Buffer.from(TEST_KEY_B64, 'base64') : null;
    const kv = new KvCrypto({ status: () => status, keyBytes: () => keyBytes });
    (globalThis as any).window.electronAPI = {
        getLocalMasterKeyStatus: vi.fn(async () => ({ status })),
        secureKvOpen: vi.fn(async (recs: any) => kv.open(recs)),
        secureKvSeal: vi.fn(async (recs: any) => kv.seal(recs)),
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

function installFakeLocalStorage() {
    const m = new Map<string, string>();
    (globalThis as any).localStorage = {
        get length() { return m.size; },
        key: (i: number) => [...m.keys()][i] ?? null,
        getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
        setItem: (k: string, v: string) => { m.set(k, String(v)); },
        removeItem: (k: string) => { m.delete(k); },
        clear: () => m.clear(),
    };
}

beforeEach(async () => {
    await wipeDb();
    installFakeLocalStorage();
    secureLocalStore._resetForTest();
    messageStore._resetForTest();
    setMasterKey('ok');
});
afterEach(() => { delete (globalThis as any).localStorage; });

const msg = (id: string) => ({ id, content: { type: 'text', text: id } });

/** `AuthContext.login()`: writes the session pointers, then WAITS for the
 *  account's records before the app is allowed to render. */
async function login(userId: string) {
    secureLocalStore.setItem('cipherline_token', 'tok');
    secureLocalStore.setItem('cipherline_user_id', userId);
    secureLocalStore.setItem('cipherline_device_id', 'dev');
    await secureLocalStore.whenAccountReady();
}

/** `AuthContext.logout()`: synchronous, fire-and-forget teardown. The user then
 *  sits on the auth screen typing a password, so the teardown always lands. */
async function signOut() {
    secureLocalStore.removeItem('cipherline_token');
    secureLocalStore.removeItem('cipherline_user_id');
    secureLocalStore.removeItem('cipherline_device_id');
    await secureLocalStore.whenAccountReady();
    await new Promise(r => setTimeout(r, 10));
}

/** Everything a first sign-in leaves behind for an account with history. */
async function seedAccountWithHistory(userId: string, threadId: string) {
    // AuthScreen marks the account BEFORE login() binds it — this ordering is
    // the reason the record lands master-tier, which is half the bug.
    markLocalHistory(userId);
    await login(userId);
    messageStore.saveAll('dm', userId, { [threadId]: [msg(`${threadId}-1`)] });
    await secureLocalStore.flushNow();
}

describe('local history flag — the in-session account switch', () => {
    /**
     * THE CENTRAL REGRESSION. A signs in with history, signs out, B signs in,
     * A signs back in — and A's history must still be found.
     *
     * Fails on the unfixed code at the `probeLocalHistory` assertion: the probe
     * reported 'none', which routes the sign-in to the "No history on this
     * device" screen and its restore-from-backup offer.
     */
    it('A -> B -> A: A is still recognised as having history', async () => {
        await secureLocalStore.hydrate();
        await seedAccountWithHistory(USER_A, 'conv-a');
        await signOut();

        await seedAccountWithHistory(USER_B, 'conv-b');
        await signOut();

        // finishExistingAccountLogin runs HERE — before login().
        expect(await probeLocalHistory(USER_A)).toBe('has');

        // ...and the history itself is genuinely still there.
        await login(USER_A);
        expect(await messageStore.hasAny('dm', USER_A)).toBe(true);
        expect(await messageStore.loadAll('dm', USER_A)).toEqual({ 'conv-a': [msg('conv-a-1')] });
    });

    /** The control the reporter observed working: "if I start fresh all my
     *  history is still there". A restart must keep behaving that way. */
    it('cold start after a sign-out still recognises the account', async () => {
        await secureLocalStore.hydrate();
        await seedAccountWithHistory(USER_A, 'conv-a');
        await signOut();
        await secureLocalStore.flushNow();

        secureLocalStore._resetForTest();
        setMasterKey('ok');
        await secureLocalStore.hydrate();

        expect(await probeLocalHistory(USER_A)).toBe('has');
    });

    /**
     * The switch must not become a leak in the other direction either: while B
     * is signed in, A's marker and A's history must be invisible.
     */
    it('does not leak A\'s history state into B\'s session', async () => {
        await secureLocalStore.hydrate();
        await seedAccountWithHistory(USER_A, 'conv-a');
        await signOut();
        await login(USER_B);

        expect(hasLocalHistory(USER_A)).toBe(false);
        expect(secureLocalStore.keysWithPrefix(`cipherline_msgs_${USER_A}_`)).toEqual([]);
    });

    /** Do NOT fix this by never offering the prompt. A genuinely new account on
     *  this device must still get the sync/restore offer. */
    it('a genuinely empty account still reports \'none\'', async () => {
        await secureLocalStore.hydrate();
        await seedAccountWithHistory(USER_A, 'conv-a');
        await signOut();

        expect(await probeLocalHistory(USER_B)).toBe('none');
        expect(await messageStore.hasAny('dm', USER_B)).toBe(false);
    });

    /**
     * Requirement 2: "not ready yet" must never render as "no history". A
     * locked keystore is the sharpest case — every read returns null, and the
     * user's data is most certainly still on disk.
     */
    it('a locked keystore reports \'unreadable\', never \'none\'', async () => {
        await secureLocalStore.hydrate();
        await seedAccountWithHistory(USER_A, 'conv-a');
        await signOut();
        await secureLocalStore.flushNow();

        secureLocalStore._resetForTest();
        setMasterKey('locked');
        await secureLocalStore.hydrate();
        expect(secureLocalStore.isLocked()).toBe(true);

        expect(await probeLocalHistory(USER_A)).toBe('unreadable');
    });

    it('reports \'unreadable\' when the account cannot be bound', async () => {
        await secureLocalStore.hydrate();
        await seedAccountWithHistory(USER_A, 'conv-a');
        await signOut();

        // The account flips to B while the probe for A is still awaiting its
        // rebind — the exact case `isAccountReady`'s re-check exists for.
        const probe = probeLocalHistory(USER_A);
        secureLocalStore.setItem('cipherline_user_id', USER_B);
        expect(await probe).toBe('unreadable');
    });
});

describe('secureLocalStore — records NAMED for an account survive a switch', () => {
    /**
     * The root cause, isolated.
     *
     * `ownerFor()` consults `activeUserId`, so a key written while NO account is
     * bound is sealed MASTER-TIER even though its name carries a userId. Every
     * key AuthScreen writes before `login()` is in that state: `cl_hx_<uid>`,
     * `cipherline_onboarded_v2_<uid>`, `cipherline_storage_policy_<uid>`,
     * `cl_referral_welcome_<uid>`.
     *
     * The switch teardown evicts by key NAME; the rebind used to reload by
     * stored OWNER. Those are not the same predicate, so every such record was
     * dropped on sign-out and never restored by an in-session sign-in — only a
     * full `hydrate()` (app restart) brought it back. That asymmetry is what
     * made `cl_hx_` vanish, and it is fixed at the store rather than per-key so
     * the other three are covered by the same change.
     */
    const namedKeys = (uid: string) => [
        localHistoryKey(uid),
        `cipherline_onboarded_v2_${uid}`,
        `cipherline_storage_policy_${uid}`,
        `cl_referral_welcome_${uid}`,
        // The referrer's tag for the post-signup friend-request offer — written by
        // AuthScreen before login() binds the account, like the four above.
        `cl_referrer_${uid}`,
    ];

    it('a master-tier record named for an account is restored on re-entry', async () => {
        await secureLocalStore.hydrate();
        // Written with NO account bound — master-tier, per-account NAME.
        for (const k of namedKeys(USER_A)) secureLocalStore.setItem(k, 'v');
        await login(USER_A);
        await secureLocalStore.flushNow();
        await signOut();

        // Evicted, correctly — it is not B's business.
        for (const k of namedKeys(USER_A)) expect(secureLocalStore.getItem(k)).toBeNull();

        await login(USER_B);
        for (const k of namedKeys(USER_A)) expect(secureLocalStore.getItem(k)).toBeNull();
        await signOut();

        await login(USER_A);
        for (const k of namedKeys(USER_A)) expect(secureLocalStore.getItem(k)).toBe('v');
    });

    it('per-account-tier records keep working exactly as before', async () => {
        await secureLocalStore.hydrate();
        await login(USER_A);
        // Written WITH the account bound — sealed under HKDF(master, A).
        secureLocalStore.setItem(`cipherline_home_pins_${USER_A}`, '["p"]');
        await secureLocalStore.flushNow();
        await signOut();

        await login(USER_B);
        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_A}`)).toBeNull();
        await signOut();

        await login(USER_A);
        expect(secureLocalStore.getItem(`cipherline_home_pins_${USER_A}`)).toBe('["p"]');
    });

    /**
     * The rebind must restore records named for the account being ENTERED and
     * no others — the widened filter is `keyIsNamedFor(k, nextId)`, not "every
     * master-tier record".
     *
     * (Known, pre-existing and unchanged by this fix: master-tier records
     * written in a session where no account was ever bound stay in the map,
     * exactly as `hydrate()` loads every master-tier record at boot. Not
     * reachable in the app — `markLocalHistory` only ever names the account
     * currently signing in — and not something this change widened.)
     */
    it('restores only the entering account\'s named records, not another\'s', async () => {
        await secureLocalStore.hydrate();
        for (const k of namedKeys(USER_A)) secureLocalStore.setItem(k, 'a');
        await login(USER_A);
        await secureLocalStore.flushNow();
        await signOut();

        for (const k of namedKeys(USER_B)) secureLocalStore.setItem(k, 'b');
        await login(USER_B);
        await secureLocalStore.flushNow();
        await signOut();

        await login(USER_B);
        for (const k of namedKeys(USER_B)) expect(secureLocalStore.getItem(k)).toBe('b');
        for (const k of namedKeys(USER_A)) expect(secureLocalStore.getItem(k)).toBeNull();
    });
});
