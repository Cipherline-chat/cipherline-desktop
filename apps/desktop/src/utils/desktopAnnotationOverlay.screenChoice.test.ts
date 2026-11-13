import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * "Which screen are you sharing?" asked as rarely as can be proven safe (Linux / Wayland). A stroke on the WRONG monitor is worse
 * than none, so every reuse below is conditioned on proof it is the same share; see utils/screenChoiceMemory.ts.
 */
const A = { x: 0, y: 0, width: 1920, height: 1080 };
const B = { x: 1920, y: 0, width: 1920, height: 1080 };
const CHOICE = {
    displays: [{ id: 1, ...A, primary: true }, { id: 2, ...B, primary: false }],
    candidates: [1, 2],
};
const ASK = { ok: false, reason: 'needs_choice', displays: 2, choice: CHOICE };
const FRAME = { width: 1920, height: 1080 };

const setup = async (store = new Map<string, string>()) => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.doMock('./secureLocalStore', () => ({
        default: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => { store.set(k, v); },
            removeItem: (k: string) => { store.delete(k); },
        },
    }));
    let resolveShow: ((r: unknown) => void) | null = null;
    const api = {
        annotationOverlayShow: vi.fn(() => new Promise<unknown>(r => { resolveShow = r; })),
        annotationOverlayHide: vi.fn(async () => {}),
        annotationOverlayPush: vi.fn(),
    };
    vi.stubGlobal('window', { electronAPI: api });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('MessageChannel', undefined);
    const mod = await import('./desktopAnnotationOverlay');
    const { annotationStore, trackKey } = await import('./annotationStore');
    const mem = await import('./screenChoiceMemory');
    const key = trackKey('me', 'screen_share');
    const settle = async () => { await vi.advanceTimersByTimeAsync(20); };
    const reply = (r: unknown) => resolveShow?.(r);
    const stroke = () => annotationStore.beginStroke(key, 'peer', { x: 0.1, y: 0.1 });
    return { mod, mem, api, key, settle, reply, stroke, store };
};
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.doUnmock('./secureLocalStore'); });

describe('silently restored grant (native path): reuse the last answer', () => {
    it('POSITIVE CONTROL: stored answer bound to the offered token goes to main as `remembered`, with no question', async () => {
        const store = new Map<string, string>();
        const t = await setup(store);
        store.set(t.mem.SCREEN_CHOICE_KEY, JSON.stringify({ layout: [A, B], chosen: B, grant: t.mem.grantFingerprint('tok-1') }));
        const facts = { stream: null, silentGrant: t.mem.grantFingerprint('tok-1'), nextGrant: t.mem.grantFingerprint('tok-2') };
        const release = t.mod.attachDesktopAnnotationOverlay('me', 'screen:0:0', () => FRAME, () => facts);
        t.stroke(); await t.settle();
        expect(t.api.annotationOverlayShow).toHaveBeenCalledWith('screen:0:0', FRAME, undefined, { remembered: { layout: [A, B], chosen: B } });
        t.reply({ ok: true, how: 'wl-layer-remembered', captured: true }); await t.settle();
        expect(t.mod.getOverlayStatus()).toEqual({ kind: 'idle' });
        // the portal rotated the token: the answer is re-bound so the NEXT share is silent too
        expect(JSON.parse(store.get(t.mem.SCREEN_CHOICE_KEY)!).grant).toBe(t.mem.grantFingerprint('tok-2'));
        release();
    });

    it('chooser was shown (not silent): nothing is reused, the question is asked, and the last pick is PRESELECTED', async () => {
        const store = new Map<string, string>();
        const t = await setup(store);
        store.set(t.mem.SCREEN_CHOICE_KEY, JSON.stringify({ layout: [A, B], chosen: B, grant: t.mem.grantFingerprint('tok-1') }));
        const facts = { stream: null, silentGrant: null, nextGrant: t.mem.grantFingerprint('tok-2') };
        const release = t.mod.attachDesktopAnnotationOverlay('me', 'screen:0:0', () => FRAME, () => facts);
        t.stroke(); await t.settle();
        expect(t.api.annotationOverlayShow).toHaveBeenCalledWith('screen:0:0', FRAME);
        t.reply(ASK); await t.settle();
        expect(t.mod.getOverlayStatus()).toEqual({ kind: 'choose', choice: CHOICE, preselect: 2 });
        release();
    });

    it('layout changed since the answer: still asked, nothing preselected', async () => {
        const store = new Map<string, string>();
        const t = await setup(store);
        store.set(t.mem.SCREEN_CHOICE_KEY, JSON.stringify({ layout: [A, { ...B, x: 2500 }], chosen: B, grant: null }));
        const release = t.mod.attachDesktopAnnotationOverlay('me', 'screen:0:0', () => FRAME, () => ({ stream: null, silentGrant: null, nextGrant: null }));
        t.stroke(); await t.settle();
        t.reply(ASK); await t.settle();
        expect(t.mod.getOverlayStatus()).toEqual({ kind: 'choose', choice: CHOICE });
        release();
    });
});

describe('portal position (native path)', () => {
    it('is handed to main so identical monitors need no question', async () => {
        const t = await setup();
        const release = t.mod.attachDesktopAnnotationOverlay('me', 'screen:0:0', () => FRAME, () => ({ stream: B, silentGrant: null, nextGrant: null }));
        t.stroke(); await t.settle();
        expect(t.api.annotationOverlayShow).toHaveBeenCalledWith('screen:0:0', FRAME, undefined, { stream: B });
        release();
    });
});

describe('never twice per share', () => {
    const answered = async () => {
        const t = await setup();
        let release = t.mod.attachDesktopAnnotationOverlay('me', 'screen:0:0', () => FRAME);
        t.stroke(); await t.settle();
        t.reply(ASK); await t.settle();
        t.mod.answerScreenChoice(2); await t.settle();
        t.reply({ ok: true, how: 'wl-layer-chosen', captured: true }); await t.settle();
        return { t, release: () => release(), reattach: (frame = FRAME) => { release = t.mod.attachDesktopAnnotationOverlay('me', 'screen:0:0', () => frame); } };
    };

    it('POSITIVE CONTROL: an internal restart (released and re-attached, same source, same aspect, even re-scaled) re-uses the answer', async () => {
        const { t, release, reattach } = await answered();
        release();                                  // quality change / keep-alive / fallback: the attachment is re-made
        await vi.advanceTimersByTimeAsync(2000);
        reattach({ width: 1280, height: 720 });     // a lighter copy re-sizes the frame, never re-shapes it
        t.api.annotationOverlayShow.mockClear();
        t.stroke(); await t.settle();
        expect(t.api.annotationOverlayShow).toHaveBeenCalledTimes(1);
        expect(t.api.annotationOverlayShow).toHaveBeenCalledWith('screen:0:0', { width: 1280, height: 720 }, undefined, { remembered: { layout: [A, B], chosen: B } });
        expect(t.mod.getOverlayStatus()).toEqual({ kind: 'idle' });
    });

    it('a NEW share (the sharer picked a source) starts clean and is asked', async () => {
        const { t, release, reattach } = await answered();
        release();
        t.mod.forgetScreenAnswer();
        reattach();
        t.api.annotationOverlayShow.mockClear();
        t.stroke(); await t.settle();
        expect(t.api.annotationOverlayShow).toHaveBeenCalledWith('screen:0:0', FRAME);
    });

    it('a restart long after the share went away is a new share: not carried', async () => {
        const { t, release, reattach } = await answered();
        release();
        await vi.advanceTimersByTimeAsync(t.mod.RESTART_CARRY_MS + 1000);
        reattach();
        t.api.annotationOverlayShow.mockClear();
        t.stroke(); await t.settle();
        expect(t.api.annotationOverlayShow).toHaveBeenCalledWith('screen:0:0', FRAME);
    });

    it('a different aspect (a different shape of screen) is not carried', async () => {
        const { t, release, reattach } = await answered();
        release();
        reattach({ width: 1080, height: 1920 });
        t.api.annotationOverlayShow.mockClear();
        t.stroke(); await t.settle();
        expect(t.api.annotationOverlayShow).toHaveBeenCalledWith('screen:0:0', { width: 1080, height: 1920 });
    });

    it('declining is carried across a restart too (no second question)', async () => {
        const t = await setup();
        const first = t.mod.attachDesktopAnnotationOverlay('me', 'screen:0:0', () => FRAME);
        t.stroke(); await t.settle();
        t.reply(ASK); await t.settle();
        t.mod.answerScreenChoice(null);
        first();
        const again = t.mod.attachDesktopAnnotationOverlay('me', 'screen:0:0', () => FRAME);
        t.api.annotationOverlayShow.mockClear();
        t.stroke(); await vi.advanceTimersByTimeAsync(t.mod.REFUSED_RETRY_MS * 3);
        expect(t.api.annotationOverlayShow).not.toHaveBeenCalled();
        expect(t.mod.getOverlayStatus()).toEqual({ kind: 'off', reason: 'declined' });
        again();
    });

    it('a pick persists device-locally, bound to the NEXT grant token (and only that)', async () => {
        const t = await setup();
        const facts = { stream: null, silentGrant: null, nextGrant: t.mem.grantFingerprint('tok-9') };
        const release = t.mod.attachDesktopAnnotationOverlay('me', 'screen:0:0', () => FRAME, () => facts);
        t.stroke(); await t.settle();
        t.reply(ASK); await t.settle();
        t.mod.answerScreenChoice(2);
        expect(t.mem.loadRememberedScreen()).toEqual({ layout: [A, B], chosen: B, grant: t.mem.grantFingerprint('tok-9') });
        release();
    });
});
