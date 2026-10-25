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
        const a = await c.authorizeAudio(WIN, g.token, sid => sid.startsWith('screen:'), { kind: 'audio-system' });
        expect(a).toEqual({ allowed: true, via: 'grant', grant: 'valid' });
        expect(confirm).not.toHaveBeenCalled();
    });

    it('window share with audio is bound to the window the grant was minted for', async () => {
        const { c, confirm, click } = setup();
        click();
        const g = mint(c, WIN, WINDOW.id, true);
        await c.authorizeVideo(WIN, g.token, WINDOW, false);
        const pidOf = (sid: string) => sid === WINDOW.id; // main's addon mapping stand-in
        expect((await c.authorizeAudio(WIN, g.token, pidOf, { kind: 'audio-app', name: WINDOW.name })).allowed).toBe(true);
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
            expect((await c.authorizeAudio(WIN, g.token, sid => sid === src.id, { kind: 'audio-app', name: src.name })).via).toBe('grant');
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
        const a = await c.authorizeAudio(WIN, g.token, sid => sid.startsWith('screen:'), { kind: 'audio-system' });
        expect(a).toEqual({ allowed: true, via: 'grant', grant: 'valid' });
        expect(confirm).toHaveBeenCalledTimes(1);
    });
});

describe('audio start', () => {
    it('is single-use per grant', async () => {
        const { c, click } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id, true);
        await c.authorizeVideo(WIN, g.token, SCREEN, false);
        const m = (sid: string) => sid.startsWith('screen:');
        expect((await c.authorizeAudio(WIN, g.token, m, { kind: 'audio-system' })).via).toBe('grant');
        expect(await c.authorizeAudio(WIN, g.token, m, { kind: 'audio-system' })).toMatchObject({ allowed: false, grant: 'unknown' });
    });

    it('may follow the video by up to 2 minutes, not longer', async () => {
        const m = (sid: string) => sid.startsWith('screen:');
        const ok = setup({ answer: false });
        ok.click();
        const g1 = mint(ok.c, WIN, SCREEN.id, true);
        await ok.c.authorizeVideo(WIN, g1.token, SCREEN, false);
        ok.advance(AUDIO_AFTER_VIDEO_MS);
        expect((await ok.c.authorizeAudio(WIN, g1.token, m, { kind: 'audio-system' })).via).toBe('grant');

        const late = setup({ answer: false });
        late.click();
        const g2 = mint(late.c, WIN, SCREEN.id, true);
        await late.c.authorizeVideo(WIN, g2.token, SCREEN, false);
        late.advance(AUDIO_AFTER_VIDEO_MS + 1);
        expect(await late.c.authorizeAudio(WIN, g2.token, m, { kind: 'audio-system' })).toMatchObject({ allowed: false, grant: 'expired' });
        expect(late.confirm).toHaveBeenCalledTimes(1);
    });

    it('a grant minted without audio cannot start audio', async () => {
        const { c, confirm, click } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id, false);
        await c.authorizeVideo(WIN, g.token, SCREEN, false);
        const d = await c.authorizeAudio(WIN, g.token, () => true, { kind: 'audio-system' });
        expect(d).toMatchObject({ allowed: false, grant: 'audio' });
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('is bound to the source: a screen grant does not start audio for a window process', async () => {
        const { c, confirm, click } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id, true);
        await c.authorizeVideo(WIN, g.token, SCREEN, false);
        const d = await c.authorizeAudio(WIN, g.token, sid => sid === WINDOW.id, { kind: 'audio-app', name: 'Some app' });
        expect(d).toMatchObject({ allowed: false, grant: 'source' });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm.mock.calls[0][0]).toEqual({ kind: 'audio-app', name: 'Some app' });
    });

    it('with no grant at all, whole-system audio asks (and names what it is)', async () => {
        const { c, prompts } = setup({ answer: false });
        const d = await c.authorizeAudio(WIN, undefined, () => true, { kind: 'audio-system' });
        expect(d).toEqual({ allowed: false, why: 'declined', grant: 'missing' });
        expect(prompts).toEqual([{ kind: 'audio-system' }]);
    });

    it('another webContents cannot start audio on the main window\'s grant', async () => {
        const { c, click } = setup({ answer: false });
        click();
        const g = mint(c, WIN, SCREEN.id, true);
        await c.authorizeVideo(WIN, g.token, SCREEN, false);
        expect(await c.authorizeAudio(OTHER, g.token, () => true, { kind: 'audio-system' })).toMatchObject({ allowed: false, grant: 'sender' });
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
        expect(describePrompt({ kind: 'audio-app', name: 'Spotify' }).message).toBe('Cipherline wants to share audio from: Spotify');
        expect(describePrompt({ kind: 'audio-system' }).message).toContain('your computer');
        expect(describePrompt({ kind: 'screen', name: 'S', withAudio: true }).detail).toContain('Audio will be shared too');
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
        const start = h.indexOf('audioCaptureAddon.startCapture(');
        expect(shape).toBeGreaterThan(-1);
        expect(consent).toBeGreaterThan(shape);
        expect(start).toBeGreaterThan(consent);
        // "exclude" (whole-system audio) is only ever our own pid.
        expect(h).toContain("mode === 'exclude' ? pid === process.pid");
        expect(h).toContain("mode === 'exclude' ? { kind: 'audio-system' }");
    });

    it('real input is observed in the browser process, not reported by the renderer', () => {
        expect(main).toContain("mainWindow.webContents.on('input-event'");
        expect(main).toContain('captureConsent.notePresence(mainContentsId)');
        // Both main-originated shortcut paths record presence before notifying the renderer.
        // (both go through noteGlobalShortcutPress, which notes presence first - quick-share.wiring.test.ts)
        expect(main).toMatch(/function noteGlobalShortcutPress\(actionId: string\): void \{\s*captureConsent\.notePresence\(null\);/);
        expect(main).toMatch(/globalShortcut\.register\(accelerator, \(\) => \{\s*noteGlobalShortcutPress\(actionId\);/);
        expect(main).toMatch(/syncKdeGlobalShortcuts\(map, \(actionId\) => \{\s*noteGlobalShortcutPress\(actionId\);/);
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
        // (the 4th: a fresh grant after a failed HDR capture attempt spent the first one's video half)
        expect(sc.match(/await mintShareGrant\(options\);/g)).toHaveLength(4);
        expect(sc).toContain('resolveDesktopSource(pending.sourceId, pending.audio, pending.grantToken ?? undefined)');
        expect(sc).toContain('startWindowAudioCapture(rootPid, wasapiMode, grantTokenFor(shareGrantRef.current, sourceId))');
        // every parked pending share carries the grant
        expect(sc.match(/pendingScreenShareRef\.current = pendingShare\(/g)).toHaveLength(4);
        expect(sc).not.toMatch(/pendingScreenShareRef\.current = \{ \.\.\.options/);
    });
});
