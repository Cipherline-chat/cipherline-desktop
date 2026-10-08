import { describe, it, expect, beforeEach } from 'vitest';
import {
    refreshDesktopSources, cancelDesktopSourceRefresh,
    mergeNames, mergePreviews, storeNames, storePreviews, getCachedSources, prefetchDesktopSources, clearDesktopSourceCache,
    markPickerRequested, pickerRequestedAt, PREFETCH_FRESH_MS, PICKER_CLICK_WINDOW_MS, EMPTY_THUMB,
    __resetDesktopSourceCacheForTests, type DesktopSourceTile,
} from './desktopSourceCache';

const t = (id: string, thumb = ''): DesktopSourceTile => ({ id, name: `n-${id}`, thumbnailDataUrl: thumb });

beforeEach(() => __resetDesktopSourceCacheForTests());

describe('merging fresh lists with the cached grid', () => {
    it('names decide which sources exist and their order; a still-present source keeps its old preview', () => {
        const prev = [t('a', 'data:image/jpeg;base64,A'), t('b', 'data:image/jpeg;base64,B')];
        const out = mergeNames(prev, [t('c'), t('a')]);
        expect(out.map(s => s.id)).toEqual(['c', 'a']);
        expect(out[0].thumbnailDataUrl).toBe('');
        expect(out[1].thumbnailDataUrl).toBe('data:image/jpeg;base64,A');
    });

    it('fresh previews replace old ones; an empty fresh preview keeps an older real one', () => {
        const prev = [t('a', 'data:image/jpeg;base64,A'), t('b', 'data:image/jpeg;base64,B')];
        const out = mergePreviews(prev, [t('a', 'data:image/jpeg;base64,A2'), t('b', EMPTY_THUMB), t('c', EMPTY_THUMB)]);
        expect(out.map(s => s.thumbnailDataUrl)).toEqual(['data:image/jpeg;base64,A2', 'data:image/jpeg;base64,B', EMPTY_THUMB]);
    });

    it('a source the preview pass no longer returns is dropped', () => {
        expect(mergePreviews([t('a', 'x'), t('b', 'y')], [t('a', 'data:image/jpeg;base64,Q')]).map(s => s.id)).toEqual(['a']);
    });

    it('store/clear (sign-out drops the pictures of the screen)', () => {
        storePreviews('screen', [t('a', 'data:image/jpeg;base64,A')]);
        storeNames('window', [t('w')]);
        expect(getCachedSources('screen')).toHaveLength(1);
        clearDesktopSourceCache();
        expect(getCachedSources('screen')).toBeUndefined();
        expect(getCachedSources('window')).toBeUndefined();
    });
});

describe('prefetchDesktopSources (hover warm-up)', () => {
    it('names then previews, one warm-up at a time per tab, skipped while fresh', async () => {
        const calls: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const get = async (types: Array<'screen' | 'window'>, opts?: { thumbnails?: boolean }) => {
            calls.push(`${types.join()}:${opts?.thumbnails === false ? 'names' : 'thumbs'}`);
            if (opts?.thumbnails !== false) await gate;
            return [t('s1', opts?.thumbnails === false ? '' : 'data:image/jpeg;base64,S')];
        };
        const p1 = prefetchDesktopSources('screen', get, 1000);
        const p2 = prefetchDesktopSources('screen', get, 1000);
        await new Promise(r => setTimeout(r, 0));
        expect(calls).toEqual(['screen:names', 'screen:thumbs']); // the second joined the first
        expect(getCachedSources('screen')?.[0].thumbnailDataUrl).toBe(''); // names already usable
        release();
        await p1;
        await p2;
        expect(calls).toEqual(['screen:names', 'screen:thumbs']);
        expect(getCachedSources('screen')?.[0].thumbnailDataUrl).toBe('data:image/jpeg;base64,S');
        await prefetchDesktopSources('screen', get, Date.now() + PREFETCH_FRESH_MS - 1000);
        expect(calls).toHaveLength(2);
        await prefetchDesktopSources('screen', get, Date.now() + PREFETCH_FRESH_MS + 1000);
        expect(calls).toHaveLength(4);
    });

    it('never throws, and without a bridge does nothing', async () => {
        await expect(prefetchDesktopSources('screen', async () => { throw new Error('no'); })).resolves.toBeUndefined();
        await expect(prefetchDesktopSources('screen', undefined)).resolves.toBeUndefined();
        expect(getCachedSources('screen')).toBeUndefined();
    });
});

describe('picker click timing', () => {
    it('is idempotent (StrictMode-safe) and expires', () => {
        markPickerRequested(100);
        expect(pickerRequestedAt(150)).toBe(100);
        expect(pickerRequestedAt(160)).toBe(100);
        expect(pickerRequestedAt(100 + PICKER_CLICK_WINDOW_MS + 1)).toBeNull();
        expect(pickerRequestedAt(50)).toBeNull();
    });
});

describe('refreshDesktopSources — one run per tab, shared by the click warm-up and the picker', () => {
    function recorder() {
        const calls: string[] = [];
        const gates: Array<() => void> = [];
        const get = (types: Array<'screen' | 'window'>, opts?: { thumbnails?: boolean }) => {
            const names = opts?.thumbnails === false;
            calls.push(`${types.join()}:${names ? 'names' : 'thumbs'}`);
            return new Promise<DesktopSourceTile[]>(r => gates.push(() => r([t('s1', names ? '' : 'data:image/jpeg;base64,S')])));
        };
        return { calls, gates, get };
    }
    const tick = () => new Promise(r => setTimeout(r, 0));

    it('the picker joins the click\'s run: ONE names call and ONE previews call, never a names call queued behind previews', async () => {
        const f = recorder();
        const clickRun = refreshDesktopSources('screen', f.get);   // at click, before the modal mounts
        const pickerRun = refreshDesktopSources('screen', f.get);  // the modal's own refresh
        expect(pickerRun).toBe(clickRun);
        f.gates[0]();
        expect((await pickerRun.names)[0].id).toBe('s1');
        await tick();
        f.gates[1]();
        expect((await pickerRun.previews)[0].thumbnailDataUrl).toBe('data:image/jpeg;base64,S');
        expect(f.calls).toEqual(['screen:names', 'screen:thumbs']);
    });

    it('after a run finishes, the next refresh is a new run (fresh list)', async () => {
        const f = recorder();
        const a = refreshDesktopSources('screen', f.get);
        f.gates[0](); await a.names; await tick(); f.gates[1](); await a.previews;
        const b = refreshDesktopSources('screen', f.get);
        expect(b).not.toBe(a);
        expect(f.calls).toHaveLength(3);
    });

    it('closing the picker before the names return means no preview capture is started', async () => {
        const f = recorder();
        const run = refreshDesktopSources('screen', f.get);
        cancelDesktopSourceRefresh('screen');
        f.gates[0]();
        await run.names;
        await expect(run.previews).rejects.toThrow(/cancelled/);
        expect(f.calls).toEqual(['screen:names']);
        // Positive control: an uncancelled run does capture previews (test above).
    });

    it('sign-out during a run: its late answers do not refill the cache', async () => {
        const f = recorder();
        const run = refreshDesktopSources('screen', f.get);
        clearDesktopSourceCache();
        f.gates[0]();
        await run.names;
        await tick();
        f.gates[1]();
        await run.previews;
        expect(getCachedSources('screen')).toBeUndefined();
    });
});

