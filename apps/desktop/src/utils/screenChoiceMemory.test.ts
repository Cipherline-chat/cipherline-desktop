import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('./secureLocalStore', () => ({
    default: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    },
}));

import {
    SCREEN_CHOICE_KEY, grantFingerprint, loadRememberedScreen, saveRememberedScreen, buildShowHint, preselectFromMemory, overlayFactsFromPortal, sameLayout,
} from './screenChoiceMemory';
import { readPortalStream } from './nativeSharePipeline';

const A = { x: 0, y: 0, width: 1920, height: 1080 };
const B = { x: 1920, y: 0, width: 1920, height: 1080 };
const stored = { layout: [A, B], chosen: B, grant: grantFingerprint('tok-1') };
beforeEach(() => store.clear());

describe('grantFingerprint', () => {
    it('is stable, distinguishes tokens, and never contains the token', () => {
        expect(grantFingerprint('tok-1')).toBe(grantFingerprint('tok-1'));
        expect(grantFingerprint('tok-1')).not.toBe(grantFingerprint('tok-2'));
        expect(grantFingerprint('tok-1')).not.toContain('tok');
        expect(grantFingerprint(null)).toBeNull();
        expect(grantFingerprint('')).toBeNull();
    });
});

describe('persisted answer', () => {
    it('round-trips under the registered key and rejects junk', () => {
        saveRememberedScreen(stored);
        expect(store.has(SCREEN_CHOICE_KEY)).toBe(true);
        expect(loadRememberedScreen()).toEqual(stored);
        for (const bad of ['{', '[]', '{"layout":[],"chosen":{}}', JSON.stringify({ ...stored, chosen: { x: 1.5, y: 0, width: 1, height: 1 } }),
            JSON.stringify({ ...stored, layout: Array.from({ length: 20 }, () => A) })]) {
            store.set(SCREEN_CHOICE_KEY, bad);
            expect(loadRememberedScreen()).toBeNull();
        }
        store.set(SCREEN_CHOICE_KEY, JSON.stringify({ ...stored, grant: 'has spaces!' }));
        expect(loadRememberedScreen()?.grant).toBeNull();
    });
});

describe('buildShowHint', () => {
    const factsSilent = { stream: null, silentGrant: grantFingerprint('tok-1'), nextGrant: grantFingerprint('tok-2') };

    it('POSITIVE CONTROL: a silently restored grant bound to the answer reuses it; the same facts with the chooser shown do not', () => {
        expect(buildShowHint(factsSilent, null, stored)).toEqual({ remembered: { layout: [A, B], chosen: B } });
        expect(buildShowHint({ ...factsSilent, silentGrant: null }, null, stored)).toBeUndefined();   // chooser was shown: ask (preselect only)
    });
    it('a grant that is not the one the answer was given for is not reused', () => {
        expect(buildShowHint({ ...factsSilent, silentGrant: grantFingerprint('other') }, null, stored)).toBeUndefined();
        expect(buildShowHint({ ...factsSilent, silentGrant: grantFingerprint('tok-1') }, null, { ...stored, grant: null })).toBeUndefined();
        expect(buildShowHint(null, null, stored)).toBeUndefined();             // Chromium path: no facts, no cross-share reuse
    });
    it('an answer carried over an internal restart is sent without any grant', () => {
        expect(buildShowHint(null, { layout: [A, B], chosen: A }, null)).toEqual({ remembered: { layout: [A, B], chosen: A } });
    });
    it('the portal position rides along', () => {
        expect(buildShowHint({ stream: B, silentGrant: null, nextGrant: null }, null, null)).toEqual({ stream: B });
    });
});

describe('preselectFromMemory (chooser shown: highlight, never decide)', () => {
    const choice = { displays: [{ id: 5, ...A }, { id: 6, ...B }], candidates: [5, 6] };
    it('POSITIVE CONTROL: same layout -> the display last picked', () => {
        expect(preselectFromMemory(stored, choice)).toBe(6);
    });
    it('layout changed, not a candidate, or nothing stored -> nothing preselected', () => {
        expect(preselectFromMemory(stored, { ...choice, displays: [{ id: 5, ...A }, { id: 6, ...B, x: 2000 }] })).toBeNull();
        expect(preselectFromMemory(stored, { ...choice, candidates: [5] })).toBeNull();
        expect(preselectFromMemory(null, choice)).toBeNull();
        expect(sameLayout([A], [A, B])).toBe(false);
    });
});

describe('the portal event -> facts', () => {
    const ev = { event: 'portal', width: 1920, height: 1080, sourceType: 1, position: { x: 1920, y: 0 }, startMs: 120, restoreToken: 'tok-2' };
    it('a monitor stream with position and size gives its rectangle', () => {
        expect(readPortalStream(ev, 'tok-1')?.rect).toEqual(B);
    });
    it('no position, a window stream, or junk numbers give no rectangle', () => {
        expect(readPortalStream({ ...ev, position: undefined }, null)?.rect).toBeNull();
        expect(readPortalStream({ ...ev, sourceType: 2 }, null)?.rect).toBeNull();
        expect(readPortalStream({ ...ev, position: { x: 1.5, y: 0 } }, null)?.rect).toBeNull();
        expect(readPortalStream({ ...ev, width: 0 }, null)?.rect).toBeNull();
        expect(readPortalStream({ ...ev, position: { x: 9e9, y: 0 } }, null)?.rect).toBeNull();
        expect(readPortalStream(null, 'x')).toBeNull();
    });
    it('"restored silently" needs a token offered AND a Start faster than a person (never on a missing or long Start)', () => {
        expect(readPortalStream(ev, 'tok-1')?.restoredSilently).toBe(true);
        expect(readPortalStream(ev, null)?.restoredSilently).toBe(false);          // chooser was asked for
        expect(readPortalStream({ ...ev, startMs: 4000 }, 'tok-1')?.restoredSilently).toBe(false);   // a person clicked
        expect(readPortalStream({ ...ev, startMs: 0 }, 'tok-1')?.restoredSilently).toBe(false);      // not reported
    });
    it('facts carry fingerprints, not tokens', () => {
        const f = overlayFactsFromPortal(readPortalStream(ev, 'tok-1'));
        expect(f).toEqual({ stream: B, silentGrant: grantFingerprint('tok-1'), nextGrant: grantFingerprint('tok-2') });
        expect(overlayFactsFromPortal(null)).toBeNull();
    });
});
