import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    createCaptureConsent, describePrompt, sanitizeLabel, isCaptureSourceId,
    GRANT_TTL_MS, AUDIO_AFTER_VIDEO_MS, PRESENCE_WINDOW_MS, CONTINUATION_MS, DECLINE_COOLDOWN_MS, MAX_OUTSTANDING_PER_SENDER,
    type ConsentPrompt,
} from './capture-consent';

const WIN = 1;       // the main window's webContents id
const OTHER = 2;     // some other webContents
const SCREEN = { id: 'screen:0:0', name: 'Screen 1' };
const WINDOW = { id: 'window:1234:0', name: 'Game - Fullscreen' };

function setup(opts: { answer?: boolean | (() => Promise<boolean>) } = {}) {
    let t = 1_000_000;
    let seq = 0;
    const prompts: ConsentPrompt[] = [];
    const confirm = vi.fn(async (p: ConsentPrompt) => {
        prompts.push(p);
        const a = opts.answer ?? false;
        return typeof a === 'function' ? a() : a;
    });
    const c = createCaptureConsent({ confirm, now: () => t, newToken: () => `tok-${++seq}-${'x'.repeat(32)}` });
    return {
        c, confirm, prompts,
        advance: (ms: number) => { t += ms; },
        /** A real click happened in the main window just now. */
        click: () => c.notePresence(WIN),
    };
}
const mint = (c: ReturnType<typeof createCaptureConsent>, sender: number, sourceId: string, audio = false) => {
    const r = c.mint(sender, sourceId, audio);
    if (!r.ok) throw new Error('mint failed');
    return r;
};

describe('the normal flow adds no prompt (our share button -> our picker -> share)', () => {
    it('a grant minted right after a real click is spent silently on the video capture', async () => {
        const { c, confirm, click } = setup();
        click();
        const g = mint(c, WIN, SCREEN.id);
        expect(g.trusted).toBe(true);
        const d = await c.authorizeVideo(WIN, g.token, SCREEN, false);
        expect(d).toEqual({ allowed: true, via: 'grant', grant: 'valid' });
        expect(confirm).not.toHaveBeenCalled();
    });

    it('screen share with audio: the SAME grant also covers the native audio start, silently', async () => {
        const { c, confirm, click, advance } = setup();
        click();
        const g = mint(c, WIN, SCREEN.id, true);
        expect((await c.authorizeVideo(WIN, g.token, SCREEN, false)).allowed).toBe(true);
        advance(5_000);
        const a = c.authorizeAudio(WIN, g.token, sid => sid.startsWith('screen:'));
        expect(a).toEqual({ allowed: true, via: 'grant', grant: 'valid' });
        expect(confirm).not.toHaveBeenCalled();
    });

    it('window share with audio is bound to the window the grant was minted for', async () => {
        const { c, confirm, click } = setup();
        click();
        const g = mint(c, WIN, WINDOW.id, true);
        await c.authorizeVideo(WIN, g.token, WINDOW, false);
        const pidOf = (sid: string) => sid === WINDOW.id; // main's addon mapping stand-in
        expect((c.authorizeAudio(WIN, g.token, pidOf)).allowed).toBe(true);
        expect(confirm).not.toHaveBeenCalled();
    });

    it('a global-shortcut start (quick-share keybind) counts as presence even with no click in the window', async () => {
        const { c, confirm } = setup();
        c.notePresence(null); // main-originated: the OS delivered the key press
        const g = mint(c, WIN, SCREEN.id, true);
        expect(g.trusted).toBe(true);
        expect((await c.authorizeVideo(WIN, g.token, SCREEN, false)).via).toBe('grant');
        expect(confirm).not.toHaveBeenCalled();
    });

    it('re-share / change source mid-call: every pick mints its own grant and each passes silently', async () => {
        const { c, confirm, click, advance } = setup();
        for (const src of [SCREEN, WINDOW, SCREEN]) {
            advance(60_000);
            click();
            const g = mint(c, WIN, src.id, true);
            expect((await c.authorizeVideo(WIN, g.token, src, false)).via).toBe('grant');
            expect((c.authorizeAudio(WIN, g.token, sid => sid === src.id)).via).toBe('grant');
        }
        expect(confirm).not.toHaveBeenCalled();
    });

    it('an automatic republish of the share the user was just sharing (encoder stall) needs no new click', async () => {
        const { c, confirm, click, advance } = setup();
        click();
        const first = mint(c, WIN, SCREEN.id);
        await c.authorizeVideo(WIN, first.token, SCREEN, false);
        advance(PRESENCE_WINDOW_MS + 30_000); // user is not touching anything
        const again = mint(c, WIN, SCREEN.id);
        expect(again.trusted).toBe(true);
        expect((await c.authorizeVideo(WIN, again.token, SCREEN, false)).via).toBe('grant');
        expect(confirm).not.toHaveBeenCalled();
    });

    it('presence expires: the same mint just past the window is untrusted', () => {
        const { c, click, advance } = setup();
        click();
        advance(PRESENCE_WINDOW_MS);
        expect(mint(c, WIN, SCREEN.id).trusted).toBe(true);
        advance(1);
        expect(mint(c, WIN, SCREEN.id).trusted).toBe(false);
    });
});

describe('a capture WITHOUT a valid grant goes to the native dialog (default: deny)', () => {
    it('no token at all: asks, naming the source from MAIN\'s list, and denies on "Don\'t allow"', async () => {
        const { c, confirm, prompts } = setup({ answer: false });
        const d = await c.authorizeVideo(WIN, undefined, SCREEN, false);
        expect(d).toEqual({ allowed: false, why: 'declined', grant: 'missing' });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(prompts[0]).toEqual({ kind: 'screen', name: 'Screen 1', withAudio: false });
    });

    it('no token, user allows: that one capture goes ahead (via the dialog)', async () => {
        const { c } = setup({ answer: true });
        expect(await c.authorizeVideo(WIN, undefined, WINDOW, false)).toEqual({ allowed: true, via: 'dialog', grant: 'missing' });
    });

    it('a dialog that errors or never says "Allow" is a denial', async () => {
        const boom = setup({ answer: async () => { throw new Error('dialog crashed'); } });
        expect((await boom.c.authorizeVideo(WIN, undefined, SCREEN, false)).allowed).toBe(false);
        const odd = setup({ answer: (async () => 'yes') as unknown as () => Promise<boolean> });
        expect((await odd.c.authorizeVideo(WIN, undefined, SCREEN, false)).allowed).toBe(false); // only a literal true allows
    });

    it('a REPLAYED token: the second use is not honoured silently', async () => {
        const { c, confirm, click } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id);
        expect((await c.authorizeVideo(WIN, g.token, SCREEN, false)).via).toBe('grant');
        const replay = await c.authorizeVideo(WIN, g.token, SCREEN, false);
        expect(replay).toEqual({ allowed: false, why: 'declined', grant: 'used' });
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('an EXPIRED token is not honoured silently (30 s)', async () => {
        const { c, confirm, click, advance } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id);
        advance(GRANT_TTL_MS + 1);
        const d = await c.authorizeVideo(WIN, g.token, SCREEN, false);
        expect(d).toMatchObject({ allowed: false, grant: 'expired' });
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('still valid at exactly the TTL', async () => {
        const { c, confirm, click, advance } = setup();
        click();
        const g = mint(c, WIN, SCREEN.id);
        advance(GRANT_TTL_MS);
        expect((await c.authorizeVideo(WIN, g.token, SCREEN, false)).via).toBe('grant');
        expect(confirm).not.toHaveBeenCalled();
    });

    it('a MISMATCHED source (grant for the screen, capture of a window) is not honoured silently', async () => {
        const { c, confirm, click } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id);
        const d = await c.authorizeVideo(WIN, g.token, WINDOW, false);
        expect(d).toMatchObject({ allowed: false, grant: 'source' });
        expect(confirm).toHaveBeenCalledTimes(1);
        // ...and the grant for the screen was not burned by the mismatch.
        expect((await c.authorizeVideo(WIN, g.token, SCREEN, false)).via).toBe('grant');
    });

    it('another webContents cannot spend the main window\'s grant', async () => {
        const { c, confirm, click } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id);
        expect(await c.authorizeVideo(OTHER, g.token, SCREEN, false)).toMatchObject({ allowed: false, grant: 'sender' });
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('a guessed / garbage token is unknown', async () => {
        const { c } = setup({ answer: false });
        for (const bad of ['tok-1-nope', '', 'A'.repeat(32), 42, {}, ['x']]) {
            const d = await c.authorizeVideo(WIN, bad, SCREEN, false);
            expect(d.allowed).toBe(false);
            expect(['missing', 'unknown']).toContain(d.grant);
        }
    });

    it('audio escalation: a grant minted without audio cannot authorise a capture that asks for audio', async () => {
        const { c, click } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id, false);
        expect(await c.authorizeVideo(WIN, g.token, SCREEN, true)).toMatchObject({ allowed: false, grant: 'audio' });
    });

    it('a grant minted with NO real input behind it (renderer-only) is untrusted: the dialog decides', async () => {
        const { c, confirm } = setup({ answer: false });
        const g = mint(c, WIN, SCREEN.id); // no click(): hostile script minting for itself
        expect(g.trusted).toBe(false);
        expect(await c.authorizeVideo(WIN, g.token, SCREEN, false)).toMatchObject({ allowed: false, why: 'declined', grant: 'valid' });
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('control: synthetic activity cannot make presence - only notePresence does, and only for that sender', () => {
        const { c, click } = setup();
        click(); // main window clicked
        expect(mint(c, OTHER, SCREEN.id).trusted).toBe(false);
        expect(mint(c, WIN, SCREEN.id).trusted).toBe(true);
    });
});

describe('an untrusted but legitimate share asks once, and the answer covers its audio', () => {
    it('allow on the video capture means the audio start of the same grant is silent', async () => {
        const { c, confirm, prompts } = setup({ answer: true });
        const g = mint(c, WIN, SCREEN.id, true); // no recent input (e.g. input events unavailable)
        const v = await c.authorizeVideo(WIN, g.token, SCREEN, false);
        expect(v).toEqual({ allowed: true, via: 'dialog', grant: 'valid' });
        expect(prompts[0]).toEqual({ kind: 'screen', name: 'Screen 1', withAudio: true });
        const a = c.authorizeAudio(WIN, g.token, sid => sid.startsWith('screen:'));
        expect(a).toEqual({ allowed: true, via: 'grant', grant: 'valid' });
        expect(confirm).toHaveBeenCalledTimes(1);
    });
});

describe('audio start: never a dialog, still guarded', () => {
    const screenAudio = (sid: string) => sid.startsWith('screen:');

    it('is single-use per grant', async () => {
        const { c, click } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id, true);
        await c.authorizeVideo(WIN, g.token, SCREEN, false);
        expect(c.authorizeAudio(WIN, g.token, screenAudio).allowed).toBe(true);
        expect(c.authorizeAudio(WIN, g.token, screenAudio)).toMatchObject({ allowed: false, why: 'no_grant', grant: 'unknown' });
    });

    it('may follow the video by up to 2 minutes, not longer - and a late start is refused WITHOUT a dialog', async () => {
        const ok = setup({ answer: false });
        ok.click();
        const g1 = mint(ok.c, WIN, SCREEN.id, true);
        await ok.c.authorizeVideo(WIN, g1.token, SCREEN, false);
        ok.advance(AUDIO_AFTER_VIDEO_MS);
        expect(ok.c.authorizeAudio(WIN, g1.token, screenAudio).via).toBe('grant');

        const late = setup({ answer: false });
        late.click();
        const g2 = mint(late.c, WIN, SCREEN.id, true);
        await late.c.authorizeVideo(WIN, g2.token, SCREEN, false);
        late.advance(AUDIO_AFTER_VIDEO_MS + 1);
        expect(late.c.authorizeAudio(WIN, g2.token, screenAudio)).toMatchObject({ allowed: false, why: 'no_grant', grant: 'expired' });
        expect(late.confirm).not.toHaveBeenCalled();
    });

    it('a grant minted without audio cannot start audio (no dialog)', async () => {
        const { c, confirm, click } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id, false);
        await c.authorizeVideo(WIN, g.token, SCREEN, false);
        expect(c.authorizeAudio(WIN, g.token, () => true)).toMatchObject({ allowed: false, why: 'no_grant', grant: 'audio' });
        expect(confirm).not.toHaveBeenCalled();
    });

    it('is bound to the source: a screen grant does not start audio for a window process (no dialog)', async () => {
        const { c, confirm, click } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id, true);
        await c.authorizeVideo(WIN, g.token, SCREEN, false);
        expect(c.authorizeAudio(WIN, g.token, sid => sid === WINDOW.id)).toMatchObject({ allowed: false, why: 'no_grant', grant: 'source' });
        expect(confirm).not.toHaveBeenCalled();
    });

    it('with no grant at all it is refused silently - the old "wants to share your computer\'s audio" dialog is gone', () => {
        const { c, confirm, prompts } = setup({ answer: true });
        expect(c.authorizeAudio(WIN, undefined, () => true)).toEqual({ allowed: false, why: 'no_grant', grant: 'missing' });
        expect(confirm).not.toHaveBeenCalled();
        expect(prompts).toEqual([]);
    });

    it('another webContents cannot start audio on the main window\'s grant', async () => {
        const { c, click } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id, true);
        await c.authorizeVideo(WIN, g.token, SCREEN, false);
        expect(c.authorizeAudio(OTHER, g.token, () => true)).toMatchObject({ allowed: false, why: 'no_grant', grant: 'sender' });
    });
});

describe('turning audio on in the middle of a share (the "Enable audio" button) - the owner\'s case', () => {
    const screenAudio = (sid: string) => sid.startsWith('screen:');

    async function shareWithoutAudio() {
        const h = setup({ answer: false });
        h.click();
        const g = mint(h.c, WIN, SCREEN.id, false);
        await h.c.authorizeVideo(WIN, g.token, SCREEN, false);
        return h;
    }

    it('click "Enable audio" an hour into the share: a fresh grant starts system audio with NO dialog', async () => {
        const { c, confirm, click, advance } = await shareWithoutAudio();
        advance(60 * 60 * 1000);
        click();                                  // the click on the audio button
        const g = mint(c, WIN, SCREEN.id, true);  // what applyAudioOnlyChange now does first
        expect(g.trusted).toBe(true);
        expect(c.authorizeAudio(WIN, g.token, screenAudio)).toEqual({ allowed: true, via: 'grant', grant: 'valid' });
        expect(confirm).not.toHaveBeenCalled();
    });

    it('works again on every later toggle (off, on, off, on) - each press mints its own grant', async () => {
        const { c, confirm, click, advance } = await shareWithoutAudio();
        for (let i = 0; i < 4; i++) {
            advance(45_000);
            click();
            const g = mint(c, WIN, SCREEN.id, true);
            expect(c.authorizeAudio(WIN, g.token, screenAudio).allowed).toBe(true);
        }
        expect(confirm).not.toHaveBeenCalled();
    });

    it('control (the bug): re-using the share-start grant for the toggle is refused - which is what used to pop the dialog', async () => {
        const { c, confirm, click, advance } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id, true);
        await c.authorizeVideo(WIN, g.token, SCREEN, false);
        expect(c.authorizeAudio(WIN, g.token, screenAudio).allowed).toBe(true); // the share's own audio
        advance(5 * 60_000);
        click();
        // the toggle presented the SPENT grant: unknown to main now. It is refused, and no dialog is shown.
        expect(c.authorizeAudio(WIN, g.token, screenAudio)).toMatchObject({ allowed: false, why: 'no_grant' });
        expect(confirm).not.toHaveBeenCalled();
    });

    it('protection kept: with no real input behind the grant, audio is refused silently (a script cannot do it on its own)', async () => {
        const { c, confirm, advance } = await shareWithoutAudio();
        advance(PRESENCE_WINDOW_MS + CONTINUATION_MS + 1); // no click for a long while, no recent capture
        const g = mint(c, WIN, SCREEN.id, true);
        expect(g.trusted).toBe(false);
        expect(c.authorizeAudio(WIN, g.token, screenAudio)).toMatchObject({ allowed: false, why: 'untrusted' });
        expect(confirm).not.toHaveBeenCalled();
    });

    it('protection kept: no audio without a live share - a click alone does not start system audio', () => {
        const { c, confirm, click } = setup({ answer: true });
        click();
        const g = mint(c, WIN, SCREEN.id, true); // a real click, but no share was ever started
        expect(c.authorizeAudio(WIN, g.token, screenAudio)).toMatchObject({ allowed: false, why: 'no_share' });
        expect(confirm).not.toHaveBeenCalled();
    });

    it('protection kept: once the share ends, audio cannot be started again until a new share is authorized', async () => {
        const { c, confirm, click } = await shareWithoutAudio();
        expect(c._isShareLive(WIN)).toBe(true);
        c.endShare(WIN);                          // the renderer reports the share gone
        expect(c._isShareLive(WIN)).toBe(false);
        click();
        const g = mint(c, WIN, SCREEN.id, true);
        expect(c.authorizeAudio(WIN, g.token, screenAudio)).toMatchObject({ allowed: false, why: 'no_share' });
        // a NEW share from the picker makes audio available again
        click();
        const g2 = mint(c, WIN, SCREEN.id, true);
        await c.authorizeVideo(WIN, g2.token, SCREEN, false);
        click();
        const g3 = mint(c, WIN, SCREEN.id, true);
        expect(c.authorizeAudio(WIN, g3.token, screenAudio).allowed).toBe(true);
        expect(confirm).not.toHaveBeenCalled();
    });

    it('protection kept: the live share is for ONE source - audio for a different source is refused', async () => {
        const { c, click } = await shareWithoutAudio(); // sharing SCREEN
        click();
        const g = mint(c, WIN, WINDOW.id, true);
        expect(c.authorizeAudio(WIN, g.token, sid => sid === WINDOW.id)).toMatchObject({ allowed: false, why: 'no_share' });
    });

    it('protection kept: a closed / reloaded window forgets its share', async () => {
        const { c, click } = await shareWithoutAudio();
        c.forgetSender(WIN);
        click();
        const g = mint(c, WIN, SCREEN.id, true);
        expect(c.authorizeAudio(WIN, g.token, screenAudio)).toMatchObject({ allowed: false, why: 'no_share' });
    });

    it('protection kept: another webContents never inherits the main window\'s live share', async () => {
        const { c } = await shareWithoutAudio();
        c.notePresence(OTHER);
        const g = mint(c, OTHER, SCREEN.id, true);
        expect(c.authorizeAudio(OTHER, g.token, screenAudio)).toMatchObject({ allowed: false, why: 'no_share' });
    });

    it('a share confirmed in the video dialog (untrusted grant) still gets its audio, silently', async () => {
        const { c, confirm } = setup({ answer: true });
        const g = mint(c, WIN, SCREEN.id, true); // no click: the dialog decides the video
        expect((await c.authorizeVideo(WIN, g.token, SCREEN, false)).via).toBe('dialog');
        expect(c.authorizeAudio(WIN, g.token, screenAudio).allowed).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(1); // the video one only
    });
});

describe('dialog fatigue', () => {
    it('one prompt at a time: a second request while one is open is dropped, not queued', async () => {
        let release!: (v: boolean) => void;
        const { c, confirm } = setup({ answer: () => new Promise<boolean>(r => { release = r; }) });
        const first = c.authorizeVideo(WIN, undefined, SCREEN, false);
        const second = await c.authorizeVideo(WIN, undefined, WINDOW, false);
        expect(second).toMatchObject({ allowed: false, why: 'busy' });
        release(true);
        expect((await first).allowed).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('"Don\'t allow" silences further prompts for 30 s; then asking resumes', async () => {
        const { c, confirm, advance } = setup({ answer: false });
        await c.authorizeVideo(WIN, undefined, SCREEN, false);
        for (let i = 0; i < 5; i++) {
            expect(await c.authorizeVideo(WIN, undefined, SCREEN, false)).toMatchObject({ allowed: false, why: 'cooldown' });
        }
        expect(confirm).toHaveBeenCalledTimes(1);
        advance(DECLINE_COOLDOWN_MS + 1);
        await c.authorizeVideo(WIN, undefined, SCREEN, false);
        expect(confirm).toHaveBeenCalledTimes(2);
    });

    it('a spent-but-declined grant cannot be retried', async () => {
        const { c, click } = setup({ answer: false });
        const g = mint(c, WIN, SCREEN.id); // untrusted
        click();
        await c.authorizeVideo(WIN, g.token, SCREEN, false); // declined
        expect(await c.authorizeVideo(WIN, g.token, SCREEN, false)).toMatchObject({ allowed: false, grant: 'used' });
    });
});

describe('continuation (automatic republish) is narrow', () => {
    it('only for the same source, only within 2 minutes of the last allowed capture, and per sender', async () => {
        const { c, click, advance } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id);
        await c.authorizeVideo(WIN, g.token, SCREEN, false);
        advance(PRESENCE_WINDOW_MS + 1);
        expect(mint(c, WIN, WINDOW.id).trusted).toBe(false);   // a different source
        expect(mint(c, OTHER, SCREEN.id).trusted).toBe(false); // a different webContents
        expect(mint(c, WIN, SCREEN.id).trusted).toBe(true);    // same source, soon after
        advance(CONTINUATION_MS);
        expect(mint(c, WIN, SCREEN.id).trusted).toBe(false);   // too long ago
    });

    it('a DENIED capture does not open the continuation window', async () => {
        const { c, advance } = setup({ answer: false });
        await c.authorizeVideo(WIN, undefined, SCREEN, false);
        advance(PRESENCE_WINDOW_MS + 1);
        expect(mint(c, WIN, SCREEN.id).trusted).toBe(false);
    });
});

describe('a live share restarts on the capture it has (Wayland: no new capture, so no resolve step)', () => {
    // Linux Wayland: a codec drift / encoder stall / hardware-encoder rule republishes the share on a
    // clone of the capture that is already running, because a new capture is the desktop's chooser.
    // That path never calls authorizeVideo, so nothing renews the consent the share's native audio
    // rides on. continueLive is that renewal - for the live source only.
    async function liveShareWithAudio(opts: { audio: boolean } = { audio: true }) {
        const s = setup({ answer: false });
        s.click();
        const g = mint(s.c, WIN, WINDOW.id, opts.audio);
        expect((await s.c.authorizeVideo(WIN, g.token, WINDOW, false)).allowed).toBe(true);
        return { ...s, g };
    }

    it('hours later, with no click, the same live source continues and its native audio starts - no dialog', async () => {
        const { c, confirm, advance } = await liveShareWithAudio();
        advance(3 * 60 * 60_000); // the CONTINUATION_MS window is long gone
        const plain = mint(c, WIN, WINDOW.id, true);
        expect(plain.trusted).toBe(false); // the old route: a restart's own mint cannot be trusted
        const r = c.continueLive(WIN, WINDOW.id, true);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.audio).toBe(true);
        const a = c.authorizeAudio(WIN, r.token, sid => sid === WINDOW.id);
        expect(a).toEqual({ allowed: true, via: 'grant', grant: 'valid' });
        expect(confirm).not.toHaveBeenCalled();
    });

    it('the continued grant survives the share flag flipping off during the republish (its video half is spent)', async () => {
        const { c, confirm, advance } = await liveShareWithAudio();
        advance(10 * 60_000);
        const r = c.continueLive(WIN, WINDOW.id, true);
        if (!r.ok) throw new Error('continue failed');
        c.endShare(WIN); // share:set-active(false) fires while the old publication is torn down
        const a = c.authorizeAudio(WIN, r.token, sid => sid === WINDOW.id);
        expect(a.allowed).toBe(true);
        expect(confirm).not.toHaveBeenCalled();
    });

    it('a NEW source is not continued: it needs a new consent (mint + authorizeVideo, i.e. the dialog without a click)', async () => {
        const { c, advance } = await liveShareWithAudio();
        advance(PRESENCE_WINDOW_MS + 1);
        expect(c.continueLive(WIN, SCREEN.id, true)).toEqual({ ok: false, reason: 'no_share' });
        // and the ordinary path for it still asks: untrusted grant -> the native dialog (declined here)
        const g = mint(c, WIN, SCREEN.id, false);
        expect(g.trusted).toBe(false);
        const d = await c.authorizeVideo(WIN, g.token, SCREEN, false);
        expect(d.allowed).toBe(false);
    });

    it('nothing continues without a live share: not before one, not after it ended', async () => {
        const { c } = setup({ answer: false });
        expect(c.continueLive(WIN, SCREEN.id, false)).toEqual({ ok: false, reason: 'no_share' });
        const s = await liveShareWithAudio();
        s.c.endShare(WIN);
        expect(s.c.continueLive(WIN, WINDOW.id, true)).toEqual({ ok: false, reason: 'no_share' });
    });

    it('a Change source that is cancelled leaves the running share continuable: the new source was ADDED, not swapped in', async () => {
        const { c, click, advance } = await liveShareWithAudio();
        advance(PRESENCE_WINDOW_MS + 1);
        click();
        // the new capture's consent is recorded when it starts (Wayland: before the chooser is answered)...
        const g = mint(c, WIN, SCREEN.id, false);
        expect((await c.authorizeVideo(WIN, g.token, SCREEN, false)).allowed).toBe(true);
        // ...then the chooser is closed and the old share carries on; much later it restarts by itself
        advance(30 * 60_000);
        const r = c.continueLive(WIN, WINDOW.id, true);
        expect(r.ok).toBe(true);
        if (r.ok) expect(c.authorizeAudio(WIN, r.token, sid => sid === WINDOW.id).allowed).toBe(true);
    });

    it('but only until the share ends: endShare drops every source the sender had', async () => {
        const { c, click } = await liveShareWithAudio();
        click();
        const g = mint(c, WIN, SCREEN.id, false);
        await c.authorizeVideo(WIN, g.token, SCREEN, false);
        c.endShare(WIN);
        expect(c.continueLive(WIN, WINDOW.id, true)).toEqual({ ok: false, reason: 'no_share' });
        expect(c.continueLive(WIN, SCREEN.id, false)).toEqual({ ok: false, reason: 'no_share' });
        expect(c._isShareLive(WIN)).toBe(false);
    });

    it('the sources a sender can hold are bounded', async () => {
        const { c, click } = await liveShareWithAudio();
        for (let i = 0; i < 8; i++) {
            click();
            const id = `screen:portal-n${i}:0`;
            const g = mint(c, WIN, id, false);
            await c.authorizeVideo(WIN, g.token, { id, name: 'Screen or window' }, false);
        }
        expect(c.continueLive(WIN, 'screen:portal-n7:0', false).ok).toBe(true);   // the newest is there
        expect(c.continueLive(WIN, WINDOW.id, false).ok).toBe(false);             // the oldest fell off
    });

    it('another webContents never continues the main window\'s share', async () => {
        const { c } = await liveShareWithAudio();
        expect(c.continueLive(OTHER, WINDOW.id, true)).toEqual({ ok: false, reason: 'no_share' });
    });

    it('a restart cannot add audio to a silent share: the continued grant carries none (until a real click)', async () => {
        const { c, click, advance } = await liveShareWithAudio({ audio: false });
        advance(PRESENCE_WINDOW_MS + 1);
        const r = c.continueLive(WIN, WINDOW.id, true);
        if (!r.ok) throw new Error('continue failed');
        expect(r.audio).toBe(false);
        expect(c.authorizeAudio(WIN, r.token, sid => sid === WINDOW.id)).toEqual({ allowed: false, why: 'no_grant', grant: 'audio' });
        // the user turning it on right now (a real click) is allowed through the same call
        click();
        const r2 = c.continueLive(WIN, WINDOW.id, true);
        if (!r2.ok) throw new Error('continue failed');
        expect(r2.audio).toBe(true);
        expect(c.authorizeAudio(WIN, r2.token, sid => sid === WINDOW.id).allowed).toBe(true);
    });

    it('a share the user turned audio on for keeps it across restarts (the toggle recorded it)', async () => {
        const { c, click, advance } = await liveShareWithAudio({ audio: false });
        advance(PRESENCE_WINDOW_MS + 1);
        click();
        const on = mint(c, WIN, WINDOW.id, true); // "Enable audio" mid-share
        expect(c.authorizeAudio(WIN, on.token, sid => sid === WINDOW.id).allowed).toBe(true);
        advance(60 * 60_000);
        const r = c.continueLive(WIN, WINDOW.id, true);
        if (!r.ok) throw new Error('continue failed');
        expect(r.audio).toBe(true);
    });

    it('a continued grant is single-use for audio, bound to the sender and to the source', async () => {
        const { c, advance } = await liveShareWithAudio();
        advance(5 * 60_000);
        const r = c.continueLive(WIN, WINDOW.id, true);
        if (!r.ok) throw new Error('continue failed');
        expect(c.authorizeAudio(OTHER, r.token, () => true).allowed).toBe(false);
        expect(c.authorizeAudio(WIN, r.token, sid => sid === SCREEN.id).allowed).toBe(false); // another source's process
        const r2 = c.continueLive(WIN, WINDOW.id, true);
        if (!r2.ok) throw new Error('continue failed');
        expect(c.authorizeAudio(WIN, r2.token, sid => sid === WINDOW.id).allowed).toBe(true);
        expect(c.authorizeAudio(WIN, r2.token, sid => sid === WINDOW.id).allowed).toBe(false); // spent
    });

    it('rejects malformed requests without touching anything', async () => {
        const { c } = await liveShareWithAudio();
        expect(c.continueLive(WIN, 'not-a-source', true)).toEqual({ ok: false, reason: 'bad_request' });
        expect(c.continueLive(WIN, WINDOW.id, 'yes')).toEqual({ ok: false, reason: 'bad_request' });
        expect(c.continueLive(1.5, WINDOW.id, true)).toEqual({ ok: false, reason: 'bad_request' });
    });

    it('is wired: its own IPC, keyed by the sender, and exposed by the bridge', () => {
        const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
        const preload = readFileSync(join(__dirname, 'preload.ts'), 'utf8');
        expect(main).toContain("ipcMain.handle('capture:continue-grant'");
        expect(main).toContain('captureConsent.continueLive(event.sender.id, sourceId, audio)');
        expect(preload).toContain("ipcRenderer.invoke('capture:continue-grant', sourceId, audio)");
        // no IPC lets the renderer name a source that is not the live one: the check is main's
        expect(main.slice(main.indexOf("ipcMain.handle('capture:continue-grant'"), main.indexOf("ipcMain.handle('desktop-capturer-resolve'")))
            .not.toContain('cachedDesktopSources');
    });
});

describe('mint validation and bookkeeping', () => {
    it.each([
        ['not a source id', 'abc', true],
        ['a path', '../../etc/passwd', true],
        ['wrong prefix', 'camera:0:0', true],
        ['empty', '', true],
        ['too long', 'screen:' + 'a'.repeat(200), true],
        ['non-string', 5, true],
        ['audio not a boolean', 'screen:0:0', 'yes'],
    ])('rejects %s', (_n, sourceId, audio) => {
        const { c } = setup();
        expect(c.mint(WIN, sourceId, audio)).toEqual({ ok: false, reason: 'bad_request' });
        expect(c._outstanding()).toBe(0);
    });
    it('accepts the id shapes Electron produces', () => {
        for (const id of ['screen:0:0', 'screen:1:0', 'window:132456:0', 'window:-4:2']) expect(isCaptureSourceId(id), id).toBe(true);
    });

    it('tokens are long, unique and not derived from the request', () => {
        const c = createCaptureConsent({ confirm: async () => false });
        const seen = new Set<string>();
        for (let i = 0; i < 50; i++) {
            const r = c.mint(WIN, SCREEN.id, false);
            expect(r.ok && r.token.length >= 32).toBe(true);
            if (r.ok) seen.add(r.token);
        }
        expect(seen.size).toBe(50);
    });

    it('a webContents cannot hoard grants: past the cap the oldest is dropped', async () => {
        const { c, click, advance } = setup({ answer: false });
        click();
        const tokens: string[] = [];
        for (let i = 0; i < MAX_OUTSTANDING_PER_SENDER + 1; i++) { tokens.push(mint(c, WIN, SCREEN.id).token); advance(1); }
        expect(c._outstanding()).toBe(MAX_OUTSTANDING_PER_SENDER);
        expect(await c.authorizeVideo(WIN, tokens[0], SCREEN, false)).toMatchObject({ allowed: false, grant: 'unknown' });
        expect((await c.authorizeVideo(WIN, tokens[tokens.length - 1], SCREEN, false)).via).toBe('grant');
    });

    it('expired grants are swept', () => {
        const { c, click, advance } = setup();
        click();
        mint(c, WIN, SCREEN.id);
        advance(AUDIO_AFTER_VIDEO_MS + GRANT_TTL_MS + 5_000);
        mint(c, WIN, SCREEN.id); // triggers the sweep
        expect(c._outstanding()).toBe(1);
    });

    it('forgetSender drops its grants, presence and continuation', async () => {
        const { c, click } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id);
        await c.authorizeVideo(WIN, g.token, SCREEN, false);
        const g2 = mint(c, WIN, SCREEN.id);
        c.forgetSender(WIN);
        expect(c._outstanding()).toBe(0);
        expect(await c.authorizeVideo(WIN, g2.token, SCREEN, false)).toMatchObject({ allowed: false, grant: 'unknown' });
    });
});

describe('dialog copy', () => {
    it('names the source and offers a clear choice', () => {
        expect(describePrompt({ kind: 'screen', name: 'Screen 1', withAudio: false }).message).toBe('Cipherline wants to share your screen: Screen 1');
        expect(describePrompt({ kind: 'window', name: 'Notes', withAudio: true }).message).toBe('Cipherline wants to share a window: Notes');
        expect(describePrompt({ kind: 'screen', name: 'S', withAudio: true }).detail).toContain('Audio will be shared too');
    });
    it('there is no dialog copy for audio any more (the owner turned it off on purpose)', () => {
        const source = readFileSync(join(__dirname, 'capture-consent.ts'), 'utf8');
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
        expect(code).not.toContain('audio-system');
        expect(code).not.toContain('audio-app');
        expect(code).not.toContain('share your computer');
        // the type admits only video prompts: this does not compile if an audio kind comes back
        const kinds: ConsentPrompt['kind'][] = ['screen', 'window'];
        expect(kinds).toHaveLength(2);
    });
    it('a hostile window title cannot forge dialog text (newlines, bidi overrides, length)', () => {
        const evil = 'Notes\n\nCipherline is safe. Click Allow‮';
        const m = describePrompt({ kind: 'window', name: evil, withAudio: false }).message;
        expect(m).not.toMatch(/[\n‮]/);
        expect(sanitizeLabel('x'.repeat(500)).length).toBe(120);
        expect(sanitizeLabel('')).toBe('Untitled');
        expect(sanitizeLabel(undefined)).toBe('Untitled');
    });
});

describe('wiring in main.ts / preload / renderer', () => {
    const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
    const main = src('main.ts');
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    it('the dialog is native, defaults to "Don\'t allow" and treats dismiss as deny', () => {
        const i = main.indexOf('const captureConsent = createCaptureConsent');
        const block = main.slice(i, i + 1400);
        expect(block).toContain(`buttons: ["Don't allow", 'Allow']`);
        expect(block).toContain('defaultId: 0');
        expect(block).toContain('cancelId: 0');
        expect(block).toContain('return response === 1;');
    });

    it('desktop-capturer-resolve consults the consent module before it answers getDisplayMedia', () => {
        const h = main.slice(main.indexOf("ipcMain.handle('desktop-capturer-resolve'"), main.indexOf('// ── Desktop annotation overlay'));
        const auth = h.indexOf('captureConsent.authorizeVideo(');
        const grant = h.indexOf('cb({ video:');
        expect(auth).toBeGreaterThan(-1);
        expect(grant).toBeGreaterThan(auth);
        expect(h).toContain('if (!decision.allowed)');
        // Only one place ever hands a source to Chromium.
        expect(strip(main).match(/\bcb\(\{ video:/g)).toHaveLength(1);
        expect(strip(main)).not.toMatch(/currentScreenshareCallback\(\{/);
    });

    it('a presented grant is keyed by the IPC sender, not by anything the renderer says', () => {
        expect(main).toContain('captureConsent.mint(event.sender.id, sourceId, audio)');
        expect(main).toContain('event.sender.id, grantToken, { id: match.id, name: match.name }');
        expect(main).toContain('event.sender.id, grantToken,\n      (sourceId) =>');
    });

    it('audio:start-window-capture: shape check, then consent, then the addon', () => {
        const h = main.slice(main.indexOf("ipcMain.handle('audio:start-window-capture'"), main.indexOf("ipcMain.handle('audio:stop-window-capture'"));
        const shape = h.indexOf('shapeOk');
        const consent = h.indexOf('captureConsent.authorizeAudio(');
        // No dialog on the audio path: nothing awaits a prompt, and the old prompt kinds are gone.
        expect(h).not.toContain('await captureConsent.authorizeAudio(');
        expect(h).not.toContain("kind: 'audio-");
        expect(h).not.toContain('approvedPidSourceId');
        const start = h.indexOf('audioCaptureAddon.startCapture(');
        expect(shape).toBeGreaterThan(-1);
        expect(consent).toBeGreaterThan(shape);
        expect(start).toBeGreaterThan(consent);
        // "exclude" (whole-system audio) is only ever our own pid.
        expect(h).toContain("mode === 'exclude' ? pid === process.pid");
    });

    it('the end of a share, a reload and a renderer crash all close the live share (and the last two stop the capture)', () => {
        expect(main).toMatch(/ipcMain\.handle\('share:set-active', \(event, active: unknown\) => \{[\s\S]*?if \(active === false\) captureConsent\.endShare\(event\.sender\.id\);/);
        expect(main).toMatch(/'did-navigate', \(\) => \{\s*captureConsent\.endShare\(mainContentsId\);[\s\S]*?audioCaptureAddon\?\.stopCapture\(\)/);
        expect(main).toMatch(/hdrShare\.stop\('renderer_gone'\);[\s\S]*?captureConsent\.endShare\(mainContentsId\);[\s\S]*?audioCaptureAddon\?\.stopCapture\(\)/);
        // a renderer saying "live" grants nothing: only the END is acted on
        expect(main).not.toMatch(/captureConsent\.(startShare|beginShare|markLive)/);
    });

    it('the audio toggle mints a fresh grant before it starts the native audio (the regression behind the dialog)', () => {
        const sc = readFileSync(join(__dirname, '..', 'src', 'components', 'SidebarConference.tsx'), 'utf8');
        const fn = sc.slice(sc.indexOf('const applyAudioOnlyChange = async ('), sc.indexOf('// The body of a share start.'));
        const mintAt = fn.indexOf('await mintShareGrant(options);');
        const startAt = fn.indexOf('await startNativeWindowAudio(nativeMode, options.sourceId, options.appAudio?.handle);');
        expect(mintAt).toBeGreaterThan(-1);
        expect(startAt).toBeGreaterThan(mintAt);
    });

    it('real input is observed in the browser process, not reported by the renderer', () => {
        expect(main).toContain("mainWindow.webContents.on('input-event'");
        expect(main).toContain('captureConsent.notePresence(mainContentsId)');
        // Both main-originated shortcut paths record presence before notifying the renderer.
        // (both go through noteGlobalShortcutPress, which notes presence first - quick-share.wiring.test.ts)
        expect(main).toMatch(/function noteGlobalShortcutPress\(actionId: string\): void \{\s*captureConsent\.notePresence\(null\);/);
        expect(main).toMatch(/globalShortcut\.register\(accelerator, \(\) => \{\s*noteGlobalShortcutPress\(actionId\);/);
        expect(main).toMatch(/new WaylandGlobalShortcuts\(\s*\(\) => dbusSessionBus\(\),\s*\(actionId\) => \{\s*noteGlobalShortcutPress\(actionId\);/);
        // No IPC channel lets the renderer claim presence.
        expect(strip(main)).not.toMatch(/ipcMain\.(handle|on)\('capture:(presence|user|input)/);
    });

    it('getDisplayMedia from a non-app frame is denied', () => {
        const h = main.slice(main.indexOf('session.defaultSession.setDisplayMediaRequestHandler'), main.indexOf("ipcMain.handle('capture:mint-grant'"));
        expect(h).toContain('isTrustedSenderUrl(request.frame?.url ?? request.securityOrigin, DEV_SERVER_URL, CIPHERLINE_PROD_PORT)');
        expect(h).toContain('(callback as (streams: unknown) => void)(null)');
    });

    it('the bridge threads the token through both capture calls', () => {
        const preload = src('preload.ts');
        expect(preload).toContain("ipcRenderer.invoke('capture:mint-grant', sourceId, audio)");
        expect(preload).toContain("ipcRenderer.invoke('desktop-capturer-resolve', sourceId, withAudio, grantToken)");
        expect(preload).toContain("ipcRenderer.invoke('audio:start-window-capture', pid, mode, grantToken)");
    });

    it('the renderer mints before each capture and presents the token (and adds no click)', () => {
        const sc = readFileSync(join(__dirname, '..', 'src', 'components', 'SidebarConference.tsx'), 'utf8');
        // (the 4th: a fresh grant after a failed HDR capture attempt spent the first one's video half;
        //  the 5th: the audio on/off toggle, which does not go through the republish;
        //  the 6th: opening a new source to prove it, before the live share is taken down;
        //  the 7th: acquireCaptureFirst, the Wayland portal's new source asked for before the live
        //  share is touched - a capture like any other, so it presents its own grant)
        expect(sc.match(/await mintShareGrant\(options\);/g)).toHaveLength(7);
        expect(sc).toContain('resolveDesktopSource(pending.sourceId, pending.audio, pending.grantToken ?? undefined)');
        expect(sc).toContain('startWindowAudioCapture(rootPid, wasapiMode, grantTokenFor(shareGrantRef.current, sourceId))');
        // every parked pending share carries the grant
        expect(sc.match(/pendingScreenShareRef\.current = pendingShare\(/g)).toHaveLength(6);
        expect(sc).not.toMatch(/pendingScreenShareRef\.current = \{ \.\.\.options/);
    });
});

describe('a NATIVE (portal) share binds its grant in main (reports bcde1655: every native share_audio start was refused)', () => {
    // The native path never calls authorizeVideo: before beginNativeShare, the grant stayed unspent and no share was live -> 'no_share'.
    const matchesScreen = (sid: string) => sid === SCREEN.id;
    it('POSITIVE CONTROL: without the native bind the audio start IS refused (the reported bug)', () => {
        const { c, click } = setup();
        click(); const g = mint(c, WIN, SCREEN.id, true);
        expect(c.authorizeAudio(WIN, g.token, matchesScreen)).toMatchObject({ allowed: false, why: 'no_share' });
    });
    it('a bound + committed native share lets exactly that grant start its audio, once', () => {
        const { c, click } = setup();
        click(); const g = mint(c, WIN, SCREEN.id, true);
        const n = c.beginNativeShare(WIN, g.token, SCREEN.id)!;
        expect(n).not.toBeNull();
        expect(c._isShareLive(WIN)).toBe(false);                 // begin spends and marks nothing
        expect(n.commit()).toBe(true);
        expect(c._isShareLive(WIN)).toBe(true);
        expect(c.authorizeAudio(WIN, g.token, matchesScreen)).toEqual({ allowed: true, via: 'grant', grant: 'valid' });
        expect(c.authorizeAudio(WIN, g.token, matchesScreen)).toMatchObject({ allowed: false });   // spent
    });
    it('the chooser may outlive the 30 s grant: commit (at the first frame) restarts the audio window from then', () => {
        const { c, click, advance } = setup();
        click(); const g = mint(c, WIN, SCREEN.id, true);
        const n = c.beginNativeShare(WIN, g.token, SCREEN.id)!;
        advance(GRANT_TTL_MS + 20_000);                          // a person reading the portal dialog
        expect(n.commit()).toBe(true);
        expect(c.authorizeAudio(WIN, g.token, matchesScreen)).toMatchObject({ allowed: true });
    });
    it('NEGATIVE: a forged, missing, other-sender, other-source, expired or untrusted grant gets no bind and audio stays refused', () => {
        const { c, click, advance } = setup();
        click(); const g = mint(c, WIN, SCREEN.id, true);
        expect(c.beginNativeShare(WIN, 'forged-token', SCREEN.id)).toBeNull();
        expect(c.beginNativeShare(WIN, undefined, SCREEN.id)).toBeNull();
        expect(c.beginNativeShare(OTHER, g.token, SCREEN.id)).toBeNull();            // another webContents' grant
        expect(c.beginNativeShare(WIN, g.token, 'screen:9:9')).toBeNull();           // minted for a different source
        expect(c.beginNativeShare(WIN, g.token, 'not a source')).toBeNull();
        expect(c._isShareLive(WIN)).toBe(false);
        expect(c.authorizeAudio(WIN, g.token, matchesScreen)).toMatchObject({ allowed: false, why: 'no_share' });
        advance(GRANT_TTL_MS + PRESENCE_WINDOW_MS);
        expect(c.beginNativeShare(WIN, g.token, SCREEN.id)).toBeNull();              // expired before the helper was even started
        const stale = mint(c, WIN, SCREEN.id, true);                                 // minted with no real click just before: untrusted
        expect(stale.trusted).toBe(false);
        expect(c.beginNativeShare(WIN, stale.token, SCREEN.id)).toBeNull();
    });
    it('NEGATIVE: a grant minted WITHOUT audio never gains audio from the native bind', () => {
        const { c, click } = setup();
        click(); const g = mint(c, WIN, SCREEN.id, false);
        c.beginNativeShare(WIN, g.token, SCREEN.id)!.commit();
        expect(c.authorizeAudio(WIN, g.token, matchesScreen)).toMatchObject({ allowed: false, why: 'no_grant', grant: 'audio' });
    });
    it('NEGATIVE: commit is single-use and does not resurrect a grant that was already spent elsewhere', () => {
        const { c, click } = setup();
        click(); const g = mint(c, WIN, SCREEN.id, true);
        const n = c.beginNativeShare(WIN, g.token, SCREEN.id)!;
        expect(n.commit()).toBe(true);
        expect(n.commit()).toBe(false);
        const n2 = c.beginNativeShare(WIN, g.token, SCREEN.id);
        expect(n2).toBeNull();                                   // video half used
    });
});
