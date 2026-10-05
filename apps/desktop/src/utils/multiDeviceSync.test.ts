import { describe, it, expect } from 'vitest';
import { applyPinOp, applyPinOps, localPinOp, ownPinOps, type PinState } from './pinSync';
import {
    applyGifOp,
    dedupeKlipyRefs,
    localGifOp,
    sameKlipyGifIds,
    KLIPY_REF_FILENAME,
    type GifEntry,
    type GifLibraryState,
} from './gifLibrarySync';

/**
 * Multi-device audit (2026-10-03) — the personal state that follows a user
 * between their own devices: pins and saved GIFs. Two simulated devices apply
 * the same streams in different orders and must agree; a local action must
 * always take effect on the device that made it; and nobody but the user may
 * write into it.
 */

const ME = 'user-me';
const BOB = 'user-bob';

describe('ownPinOps — only MY devices may pin/unpin for me', () => {
    const pin = (sender: string | null, conv: string, extra: Record<string, unknown> = {}) => ({
        conversation_id: conv,
        sender_user_id: sender,
        content: { type: 'pin', conversation_id: conv, target_id: 'msg-1', action: 'add', at: 5_000, ...extra },
    });

    it('accepts a pin op from one of my own devices', () => {
        expect(ownPinOps({ c1: [pin(ME, 'c1')] }, ME)).toEqual([
            { container_id: 'c1', target_id: 'msg-1', action: 'add', at: 5_000 },
        ]);
    });

    it('REJECTS a pin op the other person in the DM sent (could unpin mine, or pin at a far-future time and win forever)', () => {
        expect(ownPinOps({ c1: [pin(BOB, 'c1', { action: 'remove', at: 9e15 })] }, ME)).toEqual([]);
    });

    it('positive control: the old pull loop took every pin content regardless of sender', () => {
        const oldLoop = (batch: Record<string, ReturnType<typeof pin>[]>) =>
            Object.values(batch).flat().filter(m => m.content?.type === 'pin');
        expect(oldLoop({ c1: [pin(BOB, 'c1')] })).toHaveLength(1);
    });

    it('rejects a pin op that names a different conversation than the one it travelled in', () => {
        expect(ownPinOps({ c1: [pin(ME, 'c1', { conversation_id: 'c-other' })] }, ME)).toEqual([]);
    });

    it('rejects malformed ops and an unknown signed-in user', () => {
        expect(ownPinOps({ c1: [pin(ME, 'c1', { action: 'toggle' })] }, ME)).toEqual([]);
        expect(ownPinOps({ c1: [pin(ME, 'c1', { at: Number.NaN })] }, ME)).toEqual([]);
        expect(ownPinOps({ c1: [pin(ME, 'c1', { target_id: '' })] }, ME)).toEqual([]);
        expect(ownPinOps({ c1: [pin(ME, 'c1')] }, null)).toEqual([]);
    });
});

describe('local pin ops beat a ledger written by a device whose clock runs ahead', () => {
    it('an unpin on the device with the SLOW clock still unpins', () => {
        // The Mac (clock +60 s) pinned; the Windows PC's clock reads 30 s
        // "earlier" than that pin when the user unpins there.
        const fromMac = { container_id: 'c1', target_id: 'm1', action: 'add' as const, at: 100_000 };
        let win: PinState = applyPinOp({ pins: {}, ledger: {} }, fromMac);
        const unpin = localPinOp('c1', 'm1', 'remove', 70_000, win.ledger);
        win = applyPinOp(win, unpin);
        expect(win.pins.c1 ?? []).toEqual([]);
        expect(unpin.at).toBe(100_001);
    });

    it('positive control: stamped with the raw clock, the user\'s own unpin was silently ignored', () => {
        const fromMac = { container_id: 'c1', target_id: 'm1', action: 'add' as const, at: 100_000 };
        const win = applyPinOp({ pins: {}, ledger: {} }, fromMac);
        const after = applyPinOp(win, localPinOp('c1', 'm1', 'remove', 70_000));
        expect(after.pins.c1).toEqual(['m1']);
    });

    it('the op that reaches the Mac converges both devices (either order)', () => {
        const pinOp = { container_id: 'c1', target_id: 'm1', action: 'add' as const, at: 100_000 };
        const win0 = applyPinOp({ pins: {}, ledger: {} }, pinOp);
        const unpin = localPinOp('c1', 'm1', 'remove', 70_000, win0.ledger);
        const a = applyPinOps({ pins: {}, ledger: {} }, [pinOp, unpin]);
        const b = applyPinOps({ pins: {}, ledger: {} }, [unpin, pinOp]);
        expect(a.pins).toEqual(b.pins);
        expect(a.pins.c1 ?? []).toEqual([]);
    });

    it('without a ledger entry the raw clock is used, as before', () => {
        expect(localPinOp('c1', 'm1', 'add', 42, {}).at).toBe(42);
    });
});

const klipyRef = (id: string, slug: string, addedAt: number): GifEntry => ({
    id,
    source: 'klipy',
    fileName: KLIPY_REF_FILENAME,
    mimeType: 'image/gif',
    addedAt,
    klipy: { slug, media: { url: `https://static.klipy.com/${slug}.gif`, width: 200, height: 150, mime: 'image/gif' } },
} as GifEntry);
const localGif = (id: string, addedAt: number): GifEntry => ({
    id, source: 'local', fileName: `${id}.enc`, mimeType: 'image/gif', addedAt,
} as GifEntry);

describe('saved GIFs — a removal always takes effect on the device that made it', () => {
    it('removing on the slow-clock device still removes (no broken tile left behind)', () => {
        const state: GifLibraryState = { entries: [localGif('g1', 100_000)], ledger: { g1: 100_000 } };
        const after = applyGifOp(state, localGifOp('g1', 'remove', 70_000, undefined, state.ledger));
        expect(after.entries).toEqual([]);
        expect(after.ledger.g1).toBe(100_001);
    });
    it('positive control: the raw clock lost to the ledger and the entry stayed', () => {
        const state: GifLibraryState = { entries: [localGif('g1', 100_000)], ledger: { g1: 100_000 } };
        expect(applyGifOp(state, localGifOp('g1', 'remove', 70_000)).entries).toHaveLength(1);
    });
});

describe('KLIPY favorites saved on two devices are ONE favorite to the user', () => {
    const fromWin = klipyRef('id-win', 'dancing-cat', 2_000);
    const fromMac = klipyRef('id-mac', 'dancing-cat', 1_000);
    const other = klipyRef('id-x', 'waving-dog', 1_500);

    it('the picker shows one tile per slug', () => {
        expect(dedupeKlipyRefs([fromWin, other, fromMac, localGif('g1', 1)]).map(e => e.id)).toEqual(['id-win', 'id-x', 'g1']);
    });

    it('removing it removes every synced copy (the heart turns off, and it stays off everywhere)', () => {
        expect(sameKlipyGifIds([fromWin, other, fromMac], 'id-mac').sort()).toEqual(['id-mac', 'id-win']);
        expect(sameKlipyGifIds([localGif('g1', 1)], 'g1')).toEqual(['g1']);
        expect(sameKlipyGifIds([localGif('g1', 1)], 'nope')).toEqual([]);
    });

    it('two devices that each apply the full removal converge on an empty set for that slug', () => {
        const start: GifLibraryState = { entries: [fromWin, fromMac, other], ledger: { 'id-win': 2_000, 'id-mac': 1_000, 'id-x': 1_500 } };
        const ids = sameKlipyGifIds(start.entries, 'id-win');
        let s = start;
        for (const id of ids) s = applyGifOp(s, localGifOp(id, 'remove', 3_000, undefined, s.ledger));
        expect(s.entries.map(e => e.id)).toEqual(['id-x']);
    });
});
