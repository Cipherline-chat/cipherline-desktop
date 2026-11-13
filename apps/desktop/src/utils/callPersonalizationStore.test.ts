import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BATCH_WINDOW_MS, CACHE_TTL_MS, MAX_IDS_PER_REQUEST, __setPersonalizationClockForTests,
    bindCallPersonalizationTransport, clearCallPersonalization, freshCallPersonalization, getCallPersonalization,
    readCallPersonalizationStrict, requestCallPersonalization, sanitizeEntry, saveOwnCallPersonalization,
    SAVE_MIN_GAP_MS, SAVE_SETTLE_MS, setOwnCallPersonalization,
} from './callPersonalizationStore';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let clock = 1_000_000;
const flushPromises = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('callPersonalizationStore', () => {
    const read = vi.fn(async (ids: string[]) => {
        const out: Record<string, unknown> = {};
        for (const id of ids) if (id === uid(1)) out[id] = { ring_color: '#25e0c8', entrance_sound: 'bubble-pop', theme: { primary: '#112233', accent: '#aabbcc' } };
        return out;
    });
    const save = vi.fn(async (p: { ring_color?: string | null; entrance_sound?: string | null }) => ({ ring_color: p.ring_color ?? null, entrance_sound: p.entrance_sound ?? null }));

    beforeEach(() => {
        vi.useFakeTimers();
        clock = 1_000_000;
        __setPersonalizationClockForTests(() => clock);
        read.mockClear(); save.mockClear();
        bindCallPersonalizationTransport({ read: read as never, save: save as never });
    });
    afterEach(() => {
        bindCallPersonalizationTransport(null);
        __setPersonalizationClockForTests(null);
        vi.useRealTimers();
    });

    it('batches requests made in the same window into ONE read and caches them', async () => {
        requestCallPersonalization([uid(1), uid(2)]);
        requestCallPersonalization([uid(2), uid(3)]);
        expect(read).not.toHaveBeenCalled();
        vi.advanceTimersByTime(BATCH_WINDOW_MS + 1);
        await flushPromises();
        expect(read).toHaveBeenCalledTimes(1);
        expect(read.mock.calls[0][0].sort()).toEqual([uid(1), uid(2), uid(3)]);
        expect(getCallPersonalization(uid(1)).ring_color).toBe('#25e0c8');
        expect(getCallPersonalization(uid(1)).theme?.primary).toBe('#112233');
        expect(getCallPersonalization(uid(2))).toEqual({ ring_color: null, entrance_sound: null, theme: null });
    });

    it('does not re-read a fresh id, but does once the cache is stale', async () => {
        requestCallPersonalization([uid(1)]);
        vi.advanceTimersByTime(BATCH_WINDOW_MS + 1); await flushPromises();
        requestCallPersonalization([uid(1)]);
        vi.advanceTimersByTime(BATCH_WINDOW_MS + 1); await flushPromises();
        expect(read).toHaveBeenCalledTimes(1);
        clock += CACHE_TTL_MS + 1;
        requestCallPersonalization([uid(1)]);
        vi.advanceTimersByTime(BATCH_WINDOW_MS + 1); await flushPromises();
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('ignores malformed ids and splits big batches at 50', async () => {
        requestCallPersonalization(['nope', '', '../x']);
        vi.advanceTimersByTime(BATCH_WINDOW_MS + 1); await flushPromises();
        expect(read).not.toHaveBeenCalled();
        requestCallPersonalization(Array.from({ length: MAX_IDS_PER_REQUEST + 5 }, (_, i) => uid(100 + i)));
        vi.advanceTimersByTime(BATCH_WINDOW_MS + 1); await flushPromises();
        expect(read).toHaveBeenCalledTimes(2);
        expect(read.mock.calls[0][0].length).toBe(MAX_IDS_PER_REQUEST);
    });

    it('a failed read keeps defaults and throws nothing', async () => {
        read.mockRejectedValueOnce(new Error('boom'));
        requestCallPersonalization([uid(7)]);
        vi.advanceTimersByTime(BATCH_WINDOW_MS + 1); await flushPromises();
        expect(getCallPersonalization(uid(7)).ring_color).toBeNull();
    });

    it('freshCallPersonalization re-reads when older than 30 s (a joiner may have just changed their sound)', async () => {
        await freshCallPersonalization(uid(1));
        expect(read).toHaveBeenCalledTimes(1);
        await freshCallPersonalization(uid(1));
        expect(read).toHaveBeenCalledTimes(1);
        clock += 31_000;
        const p = await freshCallPersonalization(uid(1));
        expect(read).toHaveBeenCalledTimes(2);
        expect(p.entrance_sound).toBe('bubble-pop');
    });

    it('sanitizeEntry drops anything the renderer should not trust', () => {
        expect(sanitizeEntry({ ring_color: 'red', entrance_sound: 'airhorn', theme: { primary: 'x' } })).toEqual({ ring_color: null, entrance_sound: null, theme: null });
        expect(sanitizeEntry(null)).toEqual({ ring_color: null, entrance_sound: null, theme: null });
        expect(sanitizeEntry({ ring_color: '#25e0c8', entrance_sound: 'sonar-ping' })).toMatchObject({ ring_color: '#25e0c8', entrance_sound: 'sonar-ping' });
    });

    describe('saving', () => {
        // The real clock under fake timers: the spacing is worked out from it.
        beforeEach(() => { __setPersonalizationClockForTests(() => Date.now()); });
        const settle = () => vi.advanceTimersByTimeAsync(SAVE_MIN_GAP_MS + SAVE_SETTLE_MS);

        it('is optimistic and rolls back (and rethrows) on failure', async () => {
            const a = saveOwnCallPersonalization(uid(9), { ring_color: '#ffc94d' });
            expect(getCallPersonalization(uid(9)).ring_color).toBe('#ffc94d');
            await settle();
            await a;
            save.mockRejectedValueOnce(new Error('403'));
            const b = expect(saveOwnCallPersonalization(uid(9), { ring_color: '#ff6b5e' })).rejects.toThrow();
            expect(getCallPersonalization(uid(9)).ring_color).toBe('#ff6b5e');
            await settle();
            await b;
            expect(getCallPersonalization(uid(9)).ring_color).toBe('#ffc94d');
        });

        it('swapping through the styles shows each at once and sends only the last', async () => {
            const hexes = ['#ffc94d', '#ff6b5e', '#25e0c8', '#b9a3ff', '#7fc7ff', '#4ade80', '#ffffff', '#ff9ad5'];
            const all: Promise<void>[] = [];
            for (const ring_color of hexes) {
                all.push(saveOwnCallPersonalization(uid(9), { ring_color }));
                expect(getCallPersonalization(uid(9)).ring_color).toBe(ring_color);
                await vi.advanceTimersByTimeAsync(100);
            }
            await settle();
            await Promise.all(all);
            expect(save).toHaveBeenCalledTimes(1);
            expect(save).toHaveBeenCalledWith({ ring_color: '#ff9ad5' });
        });

        it('never reaches the server limit (5 per 10 s), however the clicks are spaced', async () => {
            const sentAt: number[] = [];
            const plain = save.getMockImplementation()!;
            save.mockImplementation(async (p) => { sentAt.push(Date.now()); return plain(p); });
            for (const gap of [600, 900, 1_300, 2_000, 2_600]) {
                for (let i = 0; i < 12; i++) {
                    void saveOwnCallPersonalization(uid(9), { ring_color: `#ffc9${(i + 16).toString(16)}` });
                    await vi.advanceTimersByTimeAsync(gap);
                }
            }
            await settle();
            expect(sentAt.length).toBeGreaterThan(5);
            for (let i = 5; i < sentAt.length; i++) expect(sentAt[i] - sentAt[i - 5]).toBeGreaterThan(10_000);
            save.mockImplementation(plain);
        });

        it('a different setting picked in the same burst is merged, not lost', async () => {
            const a = saveOwnCallPersonalization(uid(9), { ring_color: '#ffc94d' });
            const b = saveOwnCallPersonalization(uid(9), { entrance_sound: 'tide-chime' });
            await settle();
            await Promise.all([a, b]);
            expect(save).toHaveBeenCalledTimes(1);
            expect(save).toHaveBeenCalledWith({ ring_color: '#ffc94d', entrance_sound: 'tide-chime' });
        });

        it('signing out drops an unsent save', async () => {
            const a = expect(saveOwnCallPersonalization(uid(9), { ring_color: '#ffc94d' })).rejects.toThrow('offline');
            bindCallPersonalizationTransport(null);
            await a;
            await settle();
            expect(save).not.toHaveBeenCalled();
        });
    });

    it('signing out (unbinding) clears everyone', async () => {
        setOwnCallPersonalization(uid(9), { entrance_sound: 'tide-chime' });
        bindCallPersonalizationTransport(null);
        expect(getCallPersonalization(uid(9)).entrance_sound).toBeNull();
        clearCallPersonalization();
    });

    it('readCallPersonalizationStrict rejects on a failed read or an unbound transport (freshCallPersonalization hides both as "no sound")', async () => {
        read.mockRejectedValueOnce(new Error('429'));
        await expect(readCallPersonalizationStrict(uid(1), 0)).rejects.toThrow();
        // the lenient reader swallows the same failure and reports defaults
        read.mockRejectedValueOnce(new Error('429'));
        expect((await freshCallPersonalization(uid(1), 0)).entrance_sound).toBeNull();
        bindCallPersonalizationTransport(null);
        await expect(readCallPersonalizationStrict(uid(1))).rejects.toThrow();
        bindCallPersonalizationTransport({ read: read as never, save: save as never });
        expect((await readCallPersonalizationStrict(uid(1), 0)).entrance_sound).toBe('bubble-pop');
    });
});
