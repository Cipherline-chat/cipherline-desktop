import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    createAppAudio, authorizeAppStart, HANDLE_TTL_MS, SHARE_GAP_MS, MAX_APPS, MAX_HANDLES_PER_SENDER, LIST_MIN_INTERVAL_MS,
} from './app-audio';
import { createCaptureConsent, GRANT_TTL_MS } from './capture-consent';

const apps = (...names: string[]) => names.map(n => ({ key: `${n}-bin|${n}`, name: n, binary: `${n}-bin`, streams: 1 }));

function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('app-audio: handles', () => {
    it('turns the addon list into opaque handles; the addon key never reaches the caller', () => {
        const c = clock();
        const aa = createAppAudio({ now: c.now });
        const listed = aa.list(1, () => apps('Firefox', 'Spotify'));
        expect(listed.map(a => a.name)).toEqual(['Firefox', 'Spotify']);
        for (const a of listed) {
            expect(a.handle).toMatch(/^aa_[A-Za-z0-9_-]{20,}$/);
            expect(JSON.stringify(a)).not.toContain('-bin|');   // the key
        }
        expect(new Set(listed.map(a => a.handle)).size).toBe(2);
    });

    it('resolves only a handle THIS window was given; a made-up, replayed-from-another-window or non-string handle is nothing', () => {
        const aa = createAppAudio();
        const [a] = aa.list(1, () => apps('Firefox'));
        expect(aa.resolve(1, a.handle)).toBe('Firefox-bin|Firefox');
        expect(aa.resolve(2, a.handle)).toBeNull();            // another webContents
        expect(aa.resolve(1, 'aa_forged')).toBeNull();
        expect(aa.resolve(1, 'Firefox-bin|Firefox')).toBeNull(); // the raw key is not a handle
        expect(aa.resolve(1, 1234)).toBeNull();                 // a pid is not a handle
        expect(aa.resolve(1, undefined)).toBeNull();
        expect(aa.resolve(1, '')).toBeNull();
    });

    it('keeps the same handle for the same app across lists, so a re-list does not invalidate the chosen one', () => {
        const c = clock();
        const aa = createAppAudio({ now: c.now });
        const [first] = aa.list(1, () => apps('Firefox'));
        c.advance(LIST_MIN_INTERVAL_MS + 1);
        const again = aa.list(1, () => apps('Firefox', 'Spotify'));
        expect(again.find(a => a.name === 'Firefox')!.handle).toBe(first.handle);
    });

    it('a handle for an app that went quiet stays good until it expires, then is gone', () => {
        const c = clock();
        const aa = createAppAudio({ now: c.now });
        const [fx] = aa.list(1, () => apps('Firefox'));
        c.advance(LIST_MIN_INTERVAL_MS + 1);
        aa.list(1, () => apps('Spotify'));                      // Firefox no longer listed
        expect(aa.resolve(1, fx.handle)).not.toBeNull();
        c.advance(HANDLE_TTL_MS + 1);
        expect(aa.resolve(1, fx.handle)).toBeNull();
    });

    it('a handle that started a capture lives with the share, then SHARE_GAP_MS after it ends (a republish), then is gone', () => {
        const c = clock();
        const aa = createAppAudio({ now: c.now });
        const [a] = aa.list(1, () => apps('Firefox'));
        aa.markStarted(1, a.handle);
        c.advance(HANDLE_TTL_MS * 3);                           // far past the unstarted TTL: the share is still on
        expect(aa.resolve(1, a.handle)).not.toBeNull();
        aa.endShare(1);
        c.advance(SHARE_GAP_MS - 1_000);
        expect(aa.resolve(1, a.handle)).not.toBeNull();         // the republish restarts audio from the same choice
        c.advance(2_000);
        expect(aa.resolve(1, a.handle)).toBeNull();
    });

    it('listing again does not stretch a handle whose share has ended', () => {
        const c = clock();
        const aa = createAppAudio({ now: c.now });
        const [a] = aa.list(1, () => apps('Firefox'));
        aa.markStarted(1, a.handle);
        aa.endShare(1);
        c.advance(SHARE_GAP_MS - 5_000);
        aa.list(1, () => apps('Firefox'));
        c.advance(10_000);
        expect(aa.resolve(1, a.handle)).toBeNull();
    });

    it('forgetSender drops everything that window held', () => {
        const aa = createAppAudio();
        const [a] = aa.list(1, () => apps('Firefox'));
        aa.markStarted(1, a.handle);
        aa.forgetSender(1);
        expect(aa.resolve(1, a.handle)).toBeNull();
        expect(aa._size()).toBe(0);
    });

    it('two lists inside LIST_MIN_INTERVAL_MS share one enumeration', () => {
        const c = clock();
        const aa = createAppAudio({ now: c.now });
        let calls = 0;
        const fetch = () => { calls++; return apps('Firefox'); };
        aa.list(1, fetch); aa.list(1, fetch);
        expect(calls).toBe(1);
        c.advance(LIST_MIN_INTERVAL_MS + 1);
        aa.list(1, fetch);
        expect(calls).toBe(2);
        aa.list(2, fetch);                                     // another window asks for itself
        expect(calls).toBe(3);
    });

    it('accepts only well-formed addon output: junk entries, empty names, duplicates and a huge list are dropped, names are cleaned', () => {
        const aa = createAppAudio();
        const many = Array.from({ length: MAX_APPS + 20 }, (_, i) => ({ key: `k${i}`, name: `App ${i}`, binary: 'b', streams: 1 }));
        const listed = aa.list(1, () => [
            null, 42, 'x', {}, { key: 'a', name: '' }, { key: 5, name: 'n' }, { key: 'x'.repeat(2000), name: 'long key' },
            { key: 'dup', name: 'One' }, { key: 'dup', name: 'Two' },
            { key: 'ctl', name: 'Evil\u202e\nname\u0000' },
            ...many,
        ]);
        expect(listed.length).toBe(MAX_APPS);
        expect(listed.filter(a => a.name === 'One')).toHaveLength(1);
        expect(listed.some(a => a.name === 'Two')).toBe(false);
        const evil = listed.find(a => a.name.startsWith('Evil'))!;
        expect([...evil.name].every(ch => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 0x202e)).toBe(true);
        expect(createAppAudio().list(1, () => 'not an array')).toEqual([]);
        expect(createAppAudio().list(1, () => undefined)).toEqual([]);
    });

    it('bounds the handles one window can hold, dropping the oldest unstarted first and never a started one', () => {
        const c = clock();
        const aa = createAppAudio({ now: c.now });
        const [keep] = aa.list(1, () => apps('Keeper'));
        aa.markStarted(1, keep.handle);
        for (let i = 0; i < MAX_HANDLES_PER_SENDER + 10; i++) {
            c.advance(LIST_MIN_INTERVAL_MS + 1);
            aa.list(1, () => [{ key: `k${i}`, name: `App ${i}`, binary: '', streams: 1 }]);
        }
        expect(aa._size()).toBeLessThanOrEqual(MAX_HANDLES_PER_SENDER);
        expect(aa.resolve(1, keep.handle)).not.toBeNull();
    });
});

describe('app-audio: authorizeAppStart', () => {
    function rig(opts: { platform?: string; viaPortal?: boolean } = {}) {
        const c = clock();
        const consent = createCaptureConsent({ confirm: async () => false, now: c.now, newToken: (() => { let n = 0; return () => `tok${++n}`; })() });
        const appAudio = createAppAudio({ now: c.now });
        const deps = { platform: opts.platform ?? 'linux', viaPortal: opts.viaPortal ?? true, appAudio, consent };
        /** A real click, a grant for a portal window with audio on, and the video half spent: a live window share. */
        const liveWindowShare = async (sender = 1, sourceId = 'window:77:0') => {
            consent.notePresence(sender);
            const minted = consent.mint(sender, sourceId, true);
            if (!minted.ok) throw new Error('mint');
            const v = await consent.authorizeVideo(sender, minted.token, { id: sourceId, name: 'Some window' }, false);
            expect(v.allowed).toBe(true);
            return minted.token;
        };
        const freshGrant = (sender = 1, sourceId = 'window:77:0') => {
            consent.notePresence(sender);
            const minted = consent.mint(sender, sourceId, true);
            if (!minted.ok) throw new Error('mint');
            return minted.token;
        };
        return { c, consent, appAudio, deps, liveWindowShare, freshGrant };
    }

    it('starts for a handle main issued, with the share grant of a live window share, and returns the key for the addon', async () => {
        const r = rig();
        const [a] = r.appAudio.list(1, () => apps('Firefox'));
        const token = await r.liveWindowShare();
        expect(authorizeAppStart(r.deps, 1, a.handle, token)).toEqual({ ok: true, key: 'Firefox-bin|Firefox' });
    });

    it('refuses a handle main did not issue - before it touches the grant, so a forged handle cannot burn the real one', async () => {
        const r = rig();
        const [a] = r.appAudio.list(1, () => apps('Firefox'));
        const token = await r.liveWindowShare();
        expect(authorizeAppStart(r.deps, 1, 'aa_forged', token)).toEqual({ ok: false, why: 'bad_handle' });
        expect(authorizeAppStart(r.deps, 1, 4242, token)).toEqual({ ok: false, why: 'bad_handle' });         // a pid
        expect(authorizeAppStart(r.deps, 1, 'Firefox-bin|Firefox', token)).toEqual({ ok: false, why: 'bad_handle' }); // a key
        expect(authorizeAppStart(r.deps, 2, a.handle, token)).toEqual({ ok: false, why: 'bad_handle' });    // another window
        // ...and the grant was not spent by any of that:
        expect(authorizeAppStart(r.deps, 1, a.handle, token).ok).toBe(true);
    });

    it('needs the share grant: none, a spent one, another window\'s, a screen grant and an expired one all refuse', async () => {
        const r = rig();
        const [a] = r.appAudio.list(1, () => apps('Firefox'));
        expect(authorizeAppStart(r.deps, 1, a.handle, undefined)).toMatchObject({ ok: false, why: 'consent', detail: 'no_grant' });
        const token = await r.liveWindowShare();
        expect(authorizeAppStart(r.deps, 1, a.handle, token).ok).toBe(true);
        expect(authorizeAppStart(r.deps, 1, a.handle, token)).toMatchObject({ ok: false, why: 'consent' });  // single use

        const other = rig();
        const [b] = other.appAudio.list(1, () => apps('Firefox'));
        const t2 = await other.liveWindowShare(1);
        expect(authorizeAppStart(other.deps, 2, b.handle, t2)).toMatchObject({ ok: false });                // sender-bound

        const scr = rig();
        const [c1] = scr.appAudio.list(1, () => apps('Firefox'));
        scr.consent.notePresence(1);
        const m = scr.consent.mint(1, 'screen:0:0', true);
        if (!m.ok) throw new Error('mint');
        await scr.consent.authorizeVideo(1, m.token, { id: 'screen:0:0', name: 'Screen' }, false);
        expect(authorizeAppStart(scr.deps, 1, c1.handle, m.token)).toMatchObject({ ok: false, why: 'consent', detail: 'no_grant' }); // a screen grant does not match a window source

        const old = rig();
        const [d] = old.appAudio.list(1, () => apps('Firefox'));
        const t3 = old.freshGrant();
        old.c.advance(GRANT_TTL_MS + 60_000);
        expect(authorizeAppStart(old.deps, 1, d.handle, t3)).toMatchObject({ ok: false, why: 'consent' });
    });

    it('needs an UNTRUSTED grant to stay refused: no real input behind the mint means no silent audio', async () => {
        const r = rig();
        const [a] = r.appAudio.list(1, () => apps('Firefox'));
        r.c.advance(60_000);                                   // any earlier input is stale
        const m = r.consent.mint(1, 'window:77:0', true);
        if (!m.ok) throw new Error('mint');
        const v = await r.consent.authorizeVideo(1, m.token, { id: 'window:77:0', name: 'w' }, false); // declined dialog
        expect(v.allowed).toBe(false);
        expect(authorizeAppStart(r.deps, 1, a.handle, m.token)).toMatchObject({ ok: false, why: 'consent' });
    });

    it('is Linux-portal only: X11, other platforms and "not through the portal" refuse without looking at anything else', async () => {
        const r = rig({ viaPortal: false });
        const [a] = r.appAudio.list(1, () => apps('Firefox'));
        const token = await r.liveWindowShare();
        expect(authorizeAppStart(r.deps, 1, a.handle, token)).toEqual({ ok: false, why: 'unsupported' });
        for (const platform of ['win32', 'darwin']) {
            const w = rig({ platform });
            const [b] = w.appAudio.list(1, () => apps('Firefox'));
            expect(authorizeAppStart(w.deps, 1, b.handle, await w.liveWindowShare())).toEqual({ ok: false, why: 'unsupported' });
        }
    });

    it('a handle that started a capture can restart it (a republish mints a new grant) until the share is over', async () => {
        const r = rig();
        const [a] = r.appAudio.list(1, () => apps('Firefox'));
        expect(authorizeAppStart(r.deps, 1, a.handle, await r.liveWindowShare()).ok).toBe(true);
        // the share republishes: it ends for an instant, then a fresh grant restarts the audio
        r.consent.endShare(1); r.appAudio.endShare(1);
        r.c.advance(5_000);
        const t2 = await r.liveWindowShare();
        expect(authorizeAppStart(r.deps, 1, a.handle, t2).ok).toBe(true);
        // the share really ends and stays ended
        r.consent.endShare(1); r.appAudio.endShare(1);
        r.c.advance(SHARE_GAP_MS + 1_000);
        expect(authorizeAppStart(r.deps, 1, a.handle, r.freshGrant())).toEqual({ ok: false, why: 'bad_handle' });
    });
});

describe('main.ts and the preload wire it the way the rules above need', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const preload = readFileSync(join(__dirname, 'preload.ts'), 'utf8');
    const handler = (name: string) => {
        const at = main.indexOf(`ipcMain.handle('${name}'`);
        expect(at).toBeGreaterThan(-1);
        return main.slice(at, main.indexOf('\n  });', at));
    };

    it('the start goes through authorizeAppStart and passes the addon only the key main resolved, never the renderer\'s value', () => {
        const h = handler('audio:start-app-capture');
        expect(h).toContain('authorizeAppStart(');
        expect(h).toContain('event.sender.id, handle, grantToken');
        expect(h.indexOf('authorizeAppStart(')).toBeLessThan(h.indexOf('audioCaptureAddon.startCapture('));
        expect(h).toContain("audioCaptureAddon.startCapture(process.pid, 'app', makeAudioChunkSink('app'), decision.key)");
        // not a pid, a name or the handle itself
        expect(h).not.toMatch(/startCapture\([^)]*\bhandle\b/);
    });

    it('the list is Linux-portal only and never logs a name (a count, when it changes)', () => {
        const h = handler('audio:list-apps');
        expect(h).toContain("process.platform !== 'linux' || !captureViaPortal()");
        expect(h).toContain('appAudio.list(event.sender.id');
        const logs = h.match(/console\.(log|warn|error)\([^;]*;/g) ?? [];
        expect(logs.length).toBeGreaterThan(0);
        for (const l of logs) expect(l).not.toMatch(/\.name|\.binary|\.handle|apps\b(?!\.length)/);
    });

    it('handles end with the share and with the window, next to the grant', () => {
        expect(main).toContain('if (active === false) appAudio.endShare(event.sender.id);');
        expect(main).toMatch(/'did-navigate', \(\) => \{\s*captureConsent\.endShare\(mainContentsId\);\s*appAudio\.endShare\(mainContentsId\);/);
        expect(main).toMatch(/captureConsent\.endShare\(mainContentsId\);\s*appAudio\.endShare\(mainContentsId\);\s*try \{ audioCaptureAddon\?\.stopCapture\(\); \}/);
        expect(main).toContain('appAudio.forgetSender(mainContentsId);');
    });

    it('the pid route is unchanged: exclude is still only our own pid, include only picker-approved pids', () => {
        expect(main).toContain("const shapeOk = mode === 'exclude' ? pid === process.pid : capturedApprovedPids.has(pid);");
        expect(main).toContain("if (process.platform === 'linux' && captureViaPortal()) return null;");
    });

    it('the preload exposes exactly a list and a handle-based start (no pid parameter)', () => {
        expect(preload).toContain("listAudioApps: (): Promise<{ handle: string; name: string; binary: string }[]> =>");
        expect(preload).toContain("startAppAudioCapture: (handle: string, grantToken?: string): Promise<boolean> =>");
        expect(preload).toContain("ipcRenderer.invoke('audio:start-app-capture', handle, grantToken)");
    });
});
