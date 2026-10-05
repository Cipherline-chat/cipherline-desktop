/**
 * Key-change detection at DIRECTORY-FETCH time.
 *
 * Two things are pinned here and they are equally load-bearing:
 *
 *   1. The DETECTION — a directory response that contradicts a pinned device
 *      raises, one that describes an unseen device does not. Every "does not
 *      raise" case carries a positive control in the same test, because a
 *      detector that never fires passes a negative assertion trivially.
 *
 *   2. The DURABILITY DECISION — a directory-sourced warning is SESSION-ONLY
 *      and must never reach `senderWarningStore`. `does not persist …` below
 *      fails the moment anyone wires `raiseWarning` into this producer, which
 *      is the reversal that matters: the durable table refuses new entries at
 *      its cap rather than evicting, so server-mintable durable entries would
 *      let a hostile server block real, envelope-sourced warnings from ever
 *      being stored — and would write that noise into the user's backup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { secureLocalStore } from './secureLocalStore';
import { KvCrypto } from '../../electron/kv-crypto';
import {
    observeDirectory, noteResolved, _reset, MAX_RAISES_PER_RESPONSE,
    type DirectoryWarning,
} from './directoryKeyWatch';
import * as deviceDirectory from './deviceDirectory';
import { recordFirstSeen, markVerified, getStoredPub } from './keyVerification';
import { raiseWarning, snapshotWarnings } from './senderWarningStore';

const TEST_KEY_B64 = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');

const ME = '11111111-1111-4111-8111-111111111111';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAROL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const BOB_DEVICE = 'bob-device-1';
const PINNED_PUB = 'pub-the-one-bob-pinned-with';
const SERVED_PUB = 'pub-the-one-the-directory-now-serves';

/** Renderer's view of the main process, backed by the REAL KvCrypto — the same
 *  arrangement `senderWarningStore.test.ts` uses, for the same reason. */
function setMasterKey() {
    const keyBytes = Buffer.from(TEST_KEY_B64, 'base64');
    const kv = new KvCrypto({ status: () => 'ok', keyBytes: () => keyBytes });
    // Double cast rather than `any`: the declared `ElectronAPI` has 130+ members
    // and this harness only needs the three the KV store actually calls.
    const g = globalThis as unknown as { window?: Record<string, unknown> };
    g.window = g.window ?? {};
    g.window.electronAPI = {
        getLocalMasterKeyStatus: vi.fn(async () => ({ status: 'ok' as const })),
        secureKvOpen: vi.fn(async (r: Parameters<KvCrypto['open']>[0]) => kv.open(r)),
        secureKvSeal: vi.fn(async (r: Parameters<KvCrypto['seal']>[0]) => kv.seal(r)),
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

/** Collects what the producer reports, in order. */
function collector() {
    const raised: DirectoryWarning[] = [];
    return {
        raised,
        get userIds() { return raised.map(w => w.userId); },
        onWarn: (w: DirectoryWarning) => { raised.push(w); },
    };
}

/** A `GET /conversations/:id/devices` row (spelled `identity_pub_b64`). */
const convRow = (user_id: string, device_id: string, identity_pub_b64: string) =>
    ({ user_id, device_id, identity_pub_b64 });

/** A `GET /keys/identity_keys?user_id=` row — no `user_id` of its own, and the
 *  other spelling of the key field. Both quirks are real and both are why the
 *  `fullUserId` argument exists. */
const idKeyRow = (device_id: string, identity_key_pub_b64: string) =>
    ({ device_id, identity_key_pub_b64 });

describe('directoryKeyWatch — key-change detection at fetch time', () => {
    beforeEach(async () => {
        await wipeDb();
        secureLocalStore._resetForTest();
        setMasterKey();
        await secureLocalStore.hydrate();
        secureLocalStore.setItem('cipherline_user_id', ME);
        await secureLocalStore.whenAccountReady();
        _reset();
        deviceDirectory._reset();
    });

    afterEach(() => {
        _reset();
        deviceDirectory._reset();
    });

    // ── Detection ───────────────────────────────────────────────────────────

    it('raises key_changed when a directory response contradicts a PINNED device', () => {
        recordFirstSeen(ME, BOB, PINNED_PUB, BOB_DEVICE);

        const c = collector();
        observeDirectory([convRow(BOB, BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });

        expect(c.raised).toEqual([{ userId: BOB, verdict: 'key_changed' }]);
    });

    it('does NOT raise for an UNSEEN device — a reinstall mints a new device id', () => {
        recordFirstSeen(ME, BOB, PINNED_PUB, BOB_DEVICE);

        const c = collector();
        // Same contact, same (different) key, but a device id we have never
        // pinned. That is a NEW device by RC-7's definition, not a change.
        observeDirectory([convRow(BOB, 'bob-device-2', SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });
        expect(c.raised).toEqual([]);

        // POSITIVE CONTROL: the identical call against the pinned device id
        // does raise, so the silence above is the rule and not a dead detector.
        observeDirectory([convRow(BOB, BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });
        expect(c.userIds).toEqual([BOB]);
    });

    it('does NOT raise when the directory agrees with the pin', () => {
        recordFirstSeen(ME, BOB, PINNED_PUB, BOB_DEVICE);

        const c = collector();
        observeDirectory([convRow(BOB, BOB_DEVICE, PINNED_PUB)], { myUserId: ME, onWarn: c.onWarn });
        expect(c.raised).toEqual([]);

        observeDirectory([convRow(BOB, BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });
        expect(c.userIds).toEqual([BOB]);
    });

    it('never pins — a directory row must not seed the trust anchor', () => {
        // The hazard: if this producer called `recordFirstSeen` the way
        // `pinAndDetect` does on a benign verdict, the server could pin a key
        // of its choosing for a device the user has never heard from, and the
        // next genuine envelope would then read `ok` against it.
        const c = collector();
        observeDirectory([convRow(BOB, BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });

        expect(c.raised).toEqual([]);
        expect(getStoredPub(ME, BOB, BOB_DEVICE)).toBeNull();

        // POSITIVE CONTROL: `recordFirstSeen` on the same inputs DOES pin, so
        // the null above is this module declining to, not a broken store.
        recordFirstSeen(ME, BOB, SERVED_PUB, BOB_DEVICE);
        expect(getStoredPub(ME, BOB, BOB_DEVICE)).toBe(SERVED_PUB);
    });

    it('skips rows for my own account', () => {
        recordFirstSeen(ME, ME, PINNED_PUB, 'my-other-device');

        const c = collector();
        observeDirectory([convRow(ME, 'my-other-device', SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });
        expect(c.raised).toEqual([]);

        // POSITIVE CONTROL: identical shape under a contact's id raises.
        recordFirstSeen(ME, BOB, PINNED_PUB, BOB_DEVICE);
        observeDirectory([convRow(BOB, BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });
        expect(c.userIds).toEqual([BOB]);
    });

    it('takes the user id from the query string for /keys/identity_keys rows', () => {
        recordFirstSeen(ME, BOB, PINNED_PUB, BOB_DEVICE);

        const c = collector();
        // Without `fullUserId` the row is unattributable and must be skipped
        // rather than guessed at.
        observeDirectory([idKeyRow(BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });
        expect(c.raised).toEqual([]);

        observeDirectory([idKeyRow(BOB_DEVICE, SERVED_PUB)], {
            myUserId: ME, fullUserId: BOB, onWarn: c.onWarn,
        });
        expect(c.raised).toEqual([{ userId: BOB, verdict: 'key_changed' }]);
    });

    it('raises at most once per contact per response, and caps the per-response fan-out', () => {
        const contacts: string[] = [];
        for (let i = 0; i < MAX_RAISES_PER_RESPONSE + 5; i++) {
            const uid = `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`;
            contacts.push(uid);
            recordFirstSeen(ME, uid, PINNED_PUB, BOB_DEVICE);
        }
        // Two rows per contact: the second must not produce a second warning,
        // because `senderWarnings` is keyed by user id and cannot say anything
        // new about the same contact.
        const rows = contacts.flatMap(uid => [
            convRow(uid, BOB_DEVICE, SERVED_PUB),
            convRow(uid, BOB_DEVICE, `${SERVED_PUB}-again`),
        ]);

        const c = collector();
        observeDirectory(rows, { myUserId: ME, onWarn: c.onWarn });

        expect(c.raised.length).toBe(MAX_RAISES_PER_RESPONSE);
        expect(new Set(c.userIds).size).toBe(MAX_RAISES_PER_RESPONSE);
    });

    it('ignores rows missing a device id, a key, or a user', () => {
        recordFirstSeen(ME, BOB, PINNED_PUB, BOB_DEVICE);

        const c = collector();
        observeDirectory([
            { user_id: BOB, device_id: null, identity_pub_b64: SERVED_PUB },
            { user_id: BOB, device_id: BOB_DEVICE, identity_pub_b64: null },
            { user_id: null, device_id: BOB_DEVICE, identity_pub_b64: SERVED_PUB },
        ], { myUserId: ME, onWarn: c.onWarn });
        expect(c.raised).toEqual([]);

        observeDirectory([convRow(BOB, BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });
        expect(c.userIds).toEqual([BOB]);
    });

    // ── The modal-resolve loop ──────────────────────────────────────────────

    describe('the modal-resolve loop', () => {
        it('does not immediately re-raise the contradiction the user just answered', () => {
            recordFirstSeen(ME, BOB, PINNED_PUB, BOB_DEVICE);

            const c = collector();
            const response = [convRow(BOB, BOB_DEVICE, SERVED_PUB)];

            // Chat open raises it.
            observeDirectory(response, { myUserId: ME, onWarn: c.onWarn });
            expect(c.userIds).toEqual([BOB]);

            // The user opens SafetyVerificationModal and DISMISSES — the one
            // resolution that deliberately does NOT re-pin, so the
            // contradiction is still standing and every later fetch would
            // re-raise it forever without this.
            noteResolved(BOB);

            // The modal's own `GET /keys/identity_keys` lands, then chat open,
            // then a send. None of them may re-raise.
            observeDirectory([idKeyRow(BOB_DEVICE, SERVED_PUB)], {
                myUserId: ME, fullUserId: BOB, onWarn: c.onWarn,
            });
            observeDirectory(response, { myUserId: ME, onWarn: c.onWarn });
            observeDirectory(response, { myUserId: ME, onWarn: c.onWarn });
            expect(c.userIds).toEqual([BOB]);
        });

        it('DOES raise again when a DIFFERENT key later appears for the same contact', () => {
            recordFirstSeen(ME, BOB, PINNED_PUB, BOB_DEVICE);
            const c = collector();

            observeDirectory([convRow(BOB, BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });
            noteResolved(BOB);
            observeDirectory([convRow(BOB, BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });
            expect(c.userIds).toEqual([BOB]);

            // A third key is a NEW fact. Suppression is keyed on (contact, key)
            // precisely so this is not silenced — which is the property a
            // "the modal is open" flag could not express at all.
            observeDirectory([convRow(BOB, BOB_DEVICE, 'pub-a-third-one')], { myUserId: ME, onWarn: c.onWarn });
            expect(c.userIds).toEqual([BOB, BOB]);
        });

        it('suppresses per contact, so a concurrent fetch for someone else is untouched', () => {
            recordFirstSeen(ME, BOB, PINNED_PUB, BOB_DEVICE);
            recordFirstSeen(ME, CAROL, PINNED_PUB, BOB_DEVICE);
            const c = collector();

            observeDirectory([
                convRow(BOB, BOB_DEVICE, SERVED_PUB),
                convRow(CAROL, BOB_DEVICE, SERVED_PUB),
            ], { myUserId: ME, onWarn: c.onWarn });
            expect(new Set(c.userIds)).toEqual(new Set([BOB, CAROL]));

            // Resolving Bob's must say nothing about Carol's.
            noteResolved(BOB);
            c.raised.length = 0;
            observeDirectory([
                convRow(BOB, BOB_DEVICE, SERVED_PUB),
                convRow(CAROL, BOB_DEVICE, SERVED_PUB),
            ], { myUserId: ME, onWarn: c.onWarn });
            expect(c.userIds).toEqual([CAROL]);
        });

        it('also suppresses the pub carried by the DURABLE record, when they differ', () => {
            // An envelope-sourced warning and a directory-sourced one for the
            // same contact can name different keys. `clearSenderWarning` passes
            // the durable record's pub in so one click answers both.
            recordFirstSeen(ME, BOB, PINNED_PUB, BOB_DEVICE);
            const envelopePub = 'pub-off-the-forged-envelope';
            const c = collector();

            noteResolved(BOB, envelopePub);
            observeDirectory([convRow(BOB, BOB_DEVICE, envelopePub)], { myUserId: ME, onWarn: c.onWarn });
            expect(c.raised).toEqual([]);

            observeDirectory([convRow(BOB, BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });
            expect(c.userIds).toEqual([BOB]);
        });

        it('verify and acknowledge need no ledger entry at all — both re-pin', () => {
            recordFirstSeen(ME, BOB, PINNED_PUB, BOB_DEVICE);
            const c = collector();

            observeDirectory([convRow(BOB, BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });
            expect(c.userIds).toEqual([BOB]);

            // The safety-number comparison the modal performs. Deliberately NOT
            // calling noteResolved: this asserts the claim in the ledger's
            // doc comment, that the re-pin alone ends the contradiction.
            _reset();
            markVerified(ME, BOB, SERVED_PUB, BOB_DEVICE);

            c.raised.length = 0;
            observeDirectory([convRow(BOB, BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });
            expect(c.raised).toEqual([]);
        });

        it('_reset drops the ledger, so one account cannot silence another', () => {
            recordFirstSeen(ME, BOB, PINNED_PUB, BOB_DEVICE);
            const c = collector();
            observeDirectory([convRow(BOB, BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });
            noteResolved(BOB);
            observeDirectory([convRow(BOB, BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });
            expect(c.userIds).toEqual([BOB]);

            _reset();
            observeDirectory([convRow(BOB, BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });
            expect(c.userIds).toEqual([BOB, BOB]);
        });
    });

    // ── The durability decision ─────────────────────────────────────────────

    describe('durability — directory-sourced warnings are session-only', () => {
        it('does not persist anything to senderWarningStore', () => {
            recordFirstSeen(ME, BOB, PINNED_PUB, BOB_DEVICE);
            const c = collector();

            observeDirectory([convRow(BOB, BOB_DEVICE, SERVED_PUB)], { myUserId: ME, onWarn: c.onWarn });

            // The warning WAS raised for the session…
            expect(c.userIds).toEqual([BOB]);
            // …and nothing reached the durable table.
            expect(snapshotWarnings(ME)).toEqual({});

            // POSITIVE CONTROL: the durable table is writable right now, so the
            // empty snapshot above is this producer declining to write, not a
            // store that silently drops everything.
            raiseWarning(ME, CAROL, 'key_changed', SERVED_PUB, BOB_DEVICE);
            expect(Object.keys(snapshotWarnings(ME))).toEqual([CAROL]);
        });

        it('leaves the full durable cap available to envelope-sourced warnings', () => {
            // The attack this closes: the durable cap REFUSES new entries
            // rather than evicting, so if a hostile server could mint durable
            // entries it could fill the table from a directory response and
            // block every later, genuine, envelope-sourced warning from ever
            // being stored. A flood of directory contradictions must therefore
            // consume zero durable slots.
            const flooded: string[] = [];
            for (let i = 0; i < MAX_RAISES_PER_RESPONSE; i++) {
                const uid = `eeeeeeee-eeee-4eee-8eee-${String(i).padStart(12, '0')}`;
                flooded.push(uid);
                recordFirstSeen(ME, uid, PINNED_PUB, BOB_DEVICE);
            }
            const c = collector();
            observeDirectory(
                flooded.map(uid => convRow(uid, BOB_DEVICE, SERVED_PUB)),
                { myUserId: ME, onWarn: c.onWarn },
            );
            expect(c.raised.length).toBe(MAX_RAISES_PER_RESPONSE);
            expect(snapshotWarnings(ME)).toEqual({});
        });
    });

    // ── The interceptor seam ────────────────────────────────────────────────

    describe('installDirectoryCapture observer', () => {
        function fakeAxios() {
            const handlers: ((res: unknown) => unknown)[] = [];
            return {
                handlers,
                host: {
                    interceptors: {
                        response: {
                            use: (fn: (res: unknown) => unknown) => { handlers.push(fn); return 0; },
                            eject: () => { /* no-op */ },
                        },
                    },
                },
            };
        }

        it('observes both the conversation-scoped and the full-user response', () => {
            recordFirstSeen(ME, BOB, PINNED_PUB, BOB_DEVICE);
            recordFirstSeen(ME, CAROL, PINNED_PUB, BOB_DEVICE);
            const seen: { entries: unknown; uid: string | null }[] = [];
            const ax = fakeAxios();
            deviceDirectory.installDirectoryCapture(ax.host, (entries, uid) => {
                seen.push({ entries, uid });
            });

            ax.handlers[0]({
                config: { url: 'http://h/v1/conversations/abc/devices' },
                data: [convRow(BOB, BOB_DEVICE, SERVED_PUB)],
            });
            ax.handlers[0]({
                config: { url: `http://h/v1/keys/identity_keys?user_id=${CAROL}` },
                data: [idKeyRow(BOB_DEVICE, SERVED_PUB)],
            });

            expect(seen.map(s => s.uid)).toEqual([null, CAROL]);
        });

        it('is not called for a non-directory response, and an observer throw never breaks one', () => {
            const calls: number[] = [];
            const ax = fakeAxios();
            deviceDirectory.installDirectoryCapture(ax.host, () => {
                calls.push(1);
                throw new Error('observer exploded');
            });

            const unrelated = { config: { url: 'http://h/v1/messages' }, data: [convRow(BOB, BOB_DEVICE, SERVED_PUB)] };
            expect(ax.handlers[0](unrelated)).toBe(unrelated);
            expect(calls).toEqual([]);

            const directory = {
                config: { url: 'http://h/v1/conversations/abc/devices' },
                data: [convRow(BOB, BOB_DEVICE, SERVED_PUB)],
            };
            // Returned unchanged despite the throw, and the cache warm that
            // ran before the observer still took effect.
            expect(ax.handlers[0](directory)).toBe(directory);
            expect(calls).toEqual([1]);
            expect(deviceDirectory.status(BOB, SERVED_PUB, BOB_DEVICE)).toBe('match');
        });
    });
});
