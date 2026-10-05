import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    OwnStatusSync, decideOnConnect, readServerOwnState, ownPrefsBus,
    type OwnChoice, type PendingLocalChange, type ServerOwnState, type OwnStatusDeps,
} from './ownStatusSync';

/**
 * The desktop's own status across devices (the 2026-09-29 follow-up to the
 * presence rework): the server's CHOSEN status is the truth. The reported
 * bug — "DND set on the phone is overwritten when the desktop launches" —
 * came from the desktop PATCHing its locally saved status on every connect.
 *
 * Drives the real controller the hook (useUserStatus) wires up, with the
 * network and UI replaced by recorders — no renderer in this repo's vitest.
 */

const ME = (o: Record<string, unknown> = {}) => ({
    user_id: 'u1', status: 'online', chosen_status: 'online', custom_status_text: null,
    custom_status_emoji: null, current_game: null, show_mobile_presence: true, ...o,
});

function harness(opts: {
    local?: OwnChoice;
    me?: unknown | (() => unknown);
    patchOk?: boolean | (() => boolean);
    pending?: PendingLocalChange | null;
    game?: string | null;
} = {}) {
    let local: OwnChoice = opts.local ?? { status: 'online', text: '', emoji: '' };
    let game: string | null = opts.game ?? null;
    let stored: PendingLocalChange | null = opts.pending ?? null;
    const patches: Array<{ choice: OwnChoice; game: string | null }> = [];
    const applied: OwnChoice[] = [];
    let me: unknown = opts.me ?? ME();
    let patchOk = opts.patchOk ?? true;
    const sync = new OwnStatusSync({
        fetchMe: vi.fn(async () => {
            const v = typeof me === 'function' ? (me as () => unknown)() : me;
            if (v instanceof Error) throw v;
            return v;
        }),
        patchStatus: vi.fn(async (choice: OwnChoice, g: string | null) => {
            patches.push({ choice, game: g });
            return typeof patchOk === 'function' ? patchOk() : patchOk;
        }),
        apply: (c: OwnChoice) => { applied.push(c); local = c; },
        getLocal: () => local,
        getGame: () => game,
        loadPending: () => stored,
        savePending: (p) => { stored = p; },
        retryMs: 10,
    });
    return {
        sync, patches, applied,
        get local() { return local; },
        get stored() { return stored; },
        setLocal(c: OwnChoice) { local = c; },
        setGame(g: string | null) { game = g; },
        setMe(v: unknown) { me = v; },
        setPatchOk(v: boolean) { patchOk = v; },
    };
}

afterEach(() => { vi.useRealTimers(); });

describe('on connect: adopt the server\'s choice, send nothing', () => {
    it('THE BUG: DND chosen on the phone survives the desktop launching with a saved "online"', async () => {
        const h = harness({ local: { status: 'online', text: '', emoji: '' }, me: ME({ status: 'dnd', chosen_status: 'dnd' }) });
        const kind = await h.sync.onConnected();
        expect(kind).toBe('adopt');
        expect(h.local.status).toBe('dnd');           // the desktop now shows DND
        expect(h.patches).toEqual([]);                // ...and did not overwrite it
    });

    it('adopts the custom status too (it is part of the choice)', async () => {
        const h = harness({ me: ME({ chosen_status: 'away', custom_status_text: 'lunch', custom_status_emoji: '🍜' }) });
        await h.sync.onConnected();
        expect(h.applied).toEqual([{ status: 'away', text: 'lunch', emoji: '🍜' }]);
        expect(h.patches).toEqual([]);
    });

    it('a reconnect does the same — no re-announce', async () => {
        const h = harness({ me: ME({ chosen_status: 'online' }) });
        await h.sync.onConnected();
        await h.sync.onConnected();
        await h.sync.onConnected();
        expect(h.patches).toEqual([]);
    });

    it('appear offline chosen elsewhere is adopted, not undone', async () => {
        const h = harness({ me: ME({ chosen_status: 'offline' }) });
        await h.sync.onConnected();
        expect(h.local.status).toBe('offline');
        expect(h.patches).toEqual([]);
    });
});

describe('an explicit change on this device is the only thing that sends', () => {
    it('sends it', async () => {
        const h = harness();
        await h.sync.onConnected();
        h.setLocal({ status: 'dnd', text: '', emoji: '' });
        await h.sync.changeLocally({ status: 'dnd', text: '', emoji: '' });
        expect(h.patches).toEqual([{ choice: { status: 'dnd', text: '', emoji: '' }, game: null }]);
    });

    it('a change made while /auth/me is in flight wins over the (older) read', async () => {
        let release!: (v: unknown) => void;
        const h = harness({ me: () => new Promise(r => { release = r; }) });
        const connecting = h.sync.onConnected();
        h.setLocal({ status: 'away', text: '', emoji: '' });
        await h.sync.changeLocally({ status: 'away', text: '', emoji: '' });
        release(ME({ chosen_status: 'online' }));
        await connecting;
        expect(h.local.status).toBe('away');
        expect(h.applied).toEqual([]);
    });
});

describe('transition: older servers and servers with no real choice yet', () => {
    it('an older server (no chosen_status) → re-announce exactly as before', async () => {
        const h = harness({ local: { status: 'dnd', text: 'x', emoji: '' }, me: { user_id: 'u1', status: 'offline' } });
        expect(await h.sync.onConnected()).toBe('reannounce');
        expect(h.patches).toEqual([{ choice: { status: 'dnd', text: 'x', emoji: '' }, game: null }]);
    });

    it('chosen_status null (nothing real stored) → seed it from this device, once', async () => {
        const h = harness({ local: { status: 'offline', text: '', emoji: '' }, me: ME({ chosen_status: null }) });
        expect(await h.sync.onConnected()).toBe('seed');
        expect(h.patches.map(p => p.choice.status)).toEqual(['offline']);
        expect(h.applied).toEqual([]); // never adopts the server's derived guess
    });

    it('/auth/me unreachable → sends nothing, retries once', async () => {
        vi.useFakeTimers();
        const h = harness({ me: new Error('offline') });
        expect(await h.sync.onConnected()).toBe('none');
        expect(h.patches).toEqual([]);
        h.setMe(ME({ chosen_status: 'dnd' }));
        await vi.advanceTimersByTimeAsync(20);
        expect(h.local.status).toBe('dnd');
        expect(h.patches).toEqual([]);
    });
});

describe('a change made while offline', () => {
    it('is kept (persisted) when the PATCH fails', async () => {
        const h = harness();
        await h.sync.onConnected();
        h.setPatchOk(false);
        h.setLocal({ status: 'dnd', text: '', emoji: '' });
        await h.sync.changeLocally({ status: 'dnd', text: '', emoji: '' });
        expect(h.stored).toMatchObject({ status: 'dnd', base: { status: 'online' } });
    });

    it('server unchanged since → the local change is SENT on reconnect (not lost)', async () => {
        const h = harness();
        await h.sync.onConnected();
        h.setPatchOk(false);
        h.setLocal({ status: 'dnd', text: '', emoji: '' });
        await h.sync.changeLocally({ status: 'dnd', text: '', emoji: '' });
        h.setPatchOk(true);
        h.setMe(ME({ chosen_status: 'online' })); // still what we last knew
        expect(await h.sync.onConnected()).toBe('send-pending');
        expect(h.patches.at(-1)!.choice.status).toBe('dnd');
        expect(h.stored).toBeNull();
        expect(h.local.status).toBe('dnd');
    });

    it('another device ALSO changed it meanwhile → the server wins, the local change is dropped', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const h = harness();
        await h.sync.onConnected();
        h.setPatchOk(false);
        h.setLocal({ status: 'dnd', text: '', emoji: '' });
        await h.sync.changeLocally({ status: 'dnd', text: '', emoji: '' });
        const sent = h.patches.length;
        h.setPatchOk(true);
        h.setMe(ME({ chosen_status: 'away' })); // the phone picked away
        expect(await h.sync.onConnected()).toBe('adopt');
        expect(h.local.status).toBe('away');
        expect(h.patches.length).toBe(sent);
        expect(h.stored).toBeNull();
        expect(info).toHaveBeenCalled();
    });

    it('survives an app restart: a persisted pending change is settled on the first connect', async () => {
        const pending: PendingLocalChange = {
            status: 'offline', text: '', emoji: '', base: { status: 'online', text: '', emoji: '' },
        };
        const h = harness({ local: { status: 'offline', text: '', emoji: '' }, pending, me: ME({ chosen_status: 'online' }) });
        expect(await h.sync.onConnected()).toBe('send-pending');
        expect(h.patches.map(p => p.choice.status)).toEqual(['offline']);
    });

    it('decision table', () => {
        const base = { status: 'online' as const, text: '', emoji: '' };
        const pend: PendingLocalChange = { status: 'dnd', text: '', emoji: '', base };
        const srv = (chosen: string | null) => readServerOwnState(ME({ chosen_status: chosen })) as ServerOwnState;
        expect(decideOnConnect('unsupported', pend).kind).toBe('reannounce');
        expect(decideOnConnect('unavailable', pend).kind).toBe('none');
        expect(decideOnConnect(srv(null), pend).kind).toBe('seed');
        expect(decideOnConnect(srv('online'), pend).kind).toBe('send-pending');
        expect(decideOnConnect(srv('dnd'), pend)).toMatchObject({ kind: 'adopt', conflict: false });
        expect(decideOnConnect(srv('away'), pend)).toMatchObject({ kind: 'adopt', conflict: true });
        expect(decideOnConnect(srv('away'), null)).toMatchObject({ kind: 'adopt', conflict: false });
    });
});

describe('game updates never smuggle a stale status out', () => {
    it('a game detected at launch waits for the adopt, then goes out WITH the adopted status', async () => {
        let release!: (v: unknown) => void;
        const h = harness({ me: () => new Promise(r => { release = r; }) });
        const connecting = h.sync.onConnected();
        h.setGame('Chess');
        await h.sync.ambientChange();
        expect(h.patches).toEqual([]); // held back: the local 'online' is stale
        release(ME({ chosen_status: 'dnd' }));
        await connecting;
        expect(h.patches).toEqual([{ choice: { status: 'dnd', text: '', emoji: '' }, game: 'Chess' }]);
    });

    it('a game left on the server by a session that ended uncleanly is cleared', async () => {
        const h = harness({ me: ME({ chosen_status: 'dnd', current_game: 'Chess' }) });
        await h.sync.onConnected();
        expect(h.patches).toEqual([{ choice: { status: 'dnd', text: '', emoji: '' }, game: null }]);
    });

    it('once synced, a game change sends the current (server-held) status', async () => {
        const h = harness({ me: ME({ chosen_status: 'away' }) });
        await h.sync.onConnected();
        h.setGame('Chess');
        await h.sync.ambientChange();
        expect(h.patches).toEqual([{ choice: { status: 'away', text: '', emoji: '' }, game: 'Chess' }]);
    });
});

describe('presence:self — a change made on another device while this one runs', () => {
    it('is adopted, without sending anything', async () => {
        const h = harness();
        await h.sync.onConnected();
        h.sync.onSelfEvent({ status: 'dnd', custom_status_text: 'focus', custom_status_emoji: null, show_mobile_presence: true });
        expect(h.local).toEqual({ status: 'dnd', text: 'focus', emoji: '' });
        expect(h.patches).toEqual([]);
    });

    it('while our own PATCH is in flight it is held, then the server is re-read', async () => {
        let finish!: (ok: boolean) => void;
        const h = harness();
        await h.sync.onConnected();
        (h.sync as unknown as { deps: OwnStatusDeps }).deps.patchStatus = vi.fn(() => new Promise<boolean>(r => { finish = r; }));
        h.setLocal({ status: 'away', text: '', emoji: '' });
        const changing = h.sync.changeLocally({ status: 'away', text: '', emoji: '' });
        h.sync.onSelfEvent({ status: 'dnd' }); // an older echo, or another device
        expect(h.local.status).toBe('away');
        h.setMe(ME({ chosen_status: 'away' }));
        finish(true);
        await changing;
        await new Promise(r => setTimeout(r, 0));
        expect(h.local.status).toBe('away'); // the server's final word
    });

    it('junk is ignored', async () => {
        const h = harness();
        await h.sync.onConnected();
        h.sync.onSelfEvent({ status: 'hacked' });
        h.sync.onSelfEvent(null);
        expect(h.applied).toEqual([]);
    });
});

describe('"show when I\'m on mobile" follows the server', () => {
    it('from /auth/me on connect and from presence:self', async () => {
        const seen: boolean[] = [];
        const off = ownPrefsBus.subscribe(p => seen.push(p.showMobilePresence));
        const h = harness({ me: ME({ show_mobile_presence: false }) });
        await h.sync.onConnected();
        h.sync.onSelfEvent({ status: 'online', show_mobile_presence: true });
        off();
        expect(seen).toEqual([false, true]);
    });
});

describe('wiring (source-level: this repo\'s vitest cannot render hooks)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const hook = readFileSync(join(here, '../hooks/useUserStatus.ts'), 'utf8');
    const realtime = readFileSync(join(here, '../hooks/useRealtime.ts'), 'utf8');

    it('a (re)connect runs the sync — and nothing re-sends the local status on its own any more', () => {
        expect(hook).toMatch(/if \(wsConnectCount < 1\) return;[^]*?syncRef\.current\?\.onConnected\(\)/);
        expect(hook).not.toMatch(/pushStatus\(initialStatus/);
        expect(hook).not.toMatch(/pushStatus\(announceable\(\)/);
    });

    it('game changes go through the sync (held until the adopt), not straight to PATCH', () => {
        expect(hook).not.toMatch(/pushStatus\(myStatusRef\.current, undefined, undefined, (null|name|game\.name)\)/);
        expect(hook).toMatch(/syncRef\.current\.ambientChange\(\)/);
    });

    it('presence:self frames reach the sync', () => {
        expect(realtime).toMatch(/msg\.event === 'presence:self'[^]*?selfPresenceBus\.emit\(msg\.data\)/);
        expect(hook).toMatch(/selfPresenceBus\.subscribe\(data => \{ syncRef\.current\?\.onSelfEvent\(data\); \}\)/);
    });
});
