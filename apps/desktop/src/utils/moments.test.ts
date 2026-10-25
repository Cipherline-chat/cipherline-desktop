import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    MOMENTS, MOMENT_RARITY, MAX_MOMENT_MS, IDLE_KEY_MS, MOMENT_INVITE_EVENT, MOMENT_EVENT,
    READ_MIN_MS, HOLD_MIN_MS, readMs, stillMs, momentPhases, momentStyleVars, momentStays, momentRoll, momentRollIn,
    momentDue, claimMoment, momentCount, ledgerId, isOwnTag, quietEnough, announcement, isMomentId, mentionMoment, requestMoment,
    isWishTime, voiceJoinMoment, clockMoments, isAccountAnniversary, COFFEE_AFTER_MS,
    selfReact, SELF_REACT_WINDOW_MS, isSecondGeneral, noteServerLeft, serverRejoined, __resetLeftServers, REJOIN_WINDOW_MS,
    type MomentId, type MomentPolicy, type MomentDef,
} from './moments';
import { EGG_LEDGER_KEY, parseLedger, type EggStore } from './easterEggs';

/** The retired easter-eggs switch's key: a stale '0' left on a device must be ignored. */
const LEGACY_EGGS_KEY = 'cipherline_easter_eggs';

const memStore = (init: Record<string, string> = {}): EggStore & { map: Map<string, string> } => {
    const map = new Map(Object.entries(init));
    return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
};
const IDS = Object.keys(MOMENTS) as MomentId[];
const T0 = new Date('2026-10-20T12:00:00').getTime();
const DAY = 86_400_000;
const def = (id: MomentId): MomentDef => MOMENTS[id];
const policy = (id: MomentId): MomentPolicy => MOMENT_RARITY[id];

describe('registry: the contract every moment signs', () => {
    it.each(IDS)('%s has copy, and its announcement is headline + line', (id) => {
        const d = def(id);
        expect(d.headline.trim()).not.toBe('');
        expect(d.line.trim()).not.toBe('');
        expect(d.shown.trim()).not.toBe('');
        expect(announcement(id)).toBe(`${d.headline} ${d.line}`);
    });
    it.each(IDS)('%s copy obeys doctrine rule 4 (no "sealed")', (id) => {
        const d = def(id);
        expect(`${d.headline} ${d.line} ${d.shown}`).not.toMatch(/\bseal(ed|s|ing)?\b/i);
    });
    it('isMomentId', () => {
        expect(isMomentId('self-friend')).toBe(true);
        expect(isMomentId('first-ban')).toBe(true);
        expect(isMomentId('delete-snatch')).toBe(false); // retired 2026-10-20 (owner)
        expect(isMomentId('toString')).toBe(false);
        expect(isMomentId(42)).toBe(false);
    });
});

describe('pacing: paced for someone who did not expect it (owner, 2026-10-20)', () => {
    it('readMs: 1.2 s + 60 ms a character, never under 2.5 s', () => {
        expect(readMs('Hi.')).toBe(READ_MIN_MS);
        expect(readMs('x'.repeat(40))).toBe(1200 + 40 * 60);
        expect(readMs(' padded ')).toBe(readMs('padded'));
        expect(readMs('…’')).toBe(READ_MIN_MS); // code points, not UTF-16 units
    });
    it.each(IDS)('%s: notice beat, slow main, enough reading time, a ≥1 s settled hold, a gentle exit', (id) => {
        const t = def(id).timeline;
        expect(t.notice).toBeGreaterThanOrEqual(400);
        expect(t.notice).toBeLessThanOrEqual(600);
        expect(t.main).toBeGreaterThanOrEqual(1200);
        expect(t.read).toBeGreaterThanOrEqual(readMs(def(id).shown));
        expect(t.hold).toBeGreaterThanOrEqual(HOLD_MIN_MS);
        expect(t.exit).toBeGreaterThanOrEqual(500);
        expect(t.exit).toBeLessThanOrEqual(700);
    });
    it.each(IDS)('%s: durationMs is exactly its timeline, under the 9 s ceiling', (id) => {
        const t = def(id).timeline;
        expect(def(id).durationMs).toBe(t.notice + t.main + t.read + t.hold + t.exit);
        expect(def(id).durationMs).toBeLessThanOrEqual(MAX_MOMENT_MS);
        expect(MAX_MOMENT_MS).toBe(9000);
    });
    it.each(IDS)('%s: phases are ordered and the CSS variables carry the same numbers', (id) => {
        const p = momentPhases(id);
        expect(p.main).toBeLessThan(p.read);
        expect(p.read).toBeLessThan(p.hold);
        expect(p.hold).toBeLessThan(p.exit);
        expect(p.exit).toBeLessThan(p.end);
        expect(p.end).toBe(def(id).durationMs);
        const v = momentStyleVars(id);
        expect(v['--mo-main']).toBe(`${p.main}ms`);
        expect(v['--mo-read']).toBe(`${p.read}ms`);
        expect(v['--mo-hold']).toBe(`${p.hold}ms`);
        expect(v['--mo-exit']).toBe(momentStays(id) ? '86400s' : `${p.exit}ms`);
        expect(v['--mo-exit-dur']).toBe(`${def(id).timeline.exit}ms`);
    });
    it.each(IDS)('%s: the reduced-motion card stays up long enough to read both lines, plus the hold', (id) => {
        const d = def(id);
        expect(stillMs(id)).toBe(readMs(`${d.headline} ${d.line}`) + HOLD_MIN_MS);
        expect(stillMs(id)).toBeGreaterThanOrEqual(READ_MIN_MS + HOLD_MIN_MS);
    });
    it('only the echo waits on its button; nothing passive can ever wait', () => {
        expect(IDS.filter(momentStays)).toEqual(['echo-everyone']);
        for (const id of IDS) if (def(id).mode === 'passive') expect(momentStays(id)).toBe(false);
    });
    it.each(IDS)('%s: its stylesheet hangs the view off the host\'s phases (no private exit clock)', (id) => {
        const views = readFileSync(join(__dirname, '..', 'components', 'moments', 'views', 'index.ts'), 'utf8');
        const comp = new RegExp(`'${id}': (\\w+),`).exec(views)![1];
        const view = readFileSync(join(__dirname, '..', 'components', 'moments', 'views', `${comp}.tsx`), 'utf8');
        expect(view).toMatch(/className="mo-[a-z]+ mo-view"/);   // the shared exit (var(--mo-exit))
        expect(view).not.toMatch(/--mo-dur/);                     // no hard-coded length of its own
        expect(view).toMatch(/data-read/);                        // the punchline is marked
    });
});

describe('rarity: once in a while, not every time (owner, 2026-10-20)', () => {
    it('the policy table, exactly', () => {
        expect(MOMENT_RARITY).toEqual({
            'self-friend':    { firstAlways: true, chance: 1 / 4, cooldownMs: 7 * DAY },
            'note-to-self':   { maxTimes: 1 },
            'echo-everyone':  { cooldownMs: 30 * DAY },
            'self-ping':      { chance: 1 / 3, cooldownMs: 7 * DAY },
            'wish':           { cooldownMs: 7 * DAY },
            'empty-party':    { cooldownMs: 14 * DAY },
            'volume-ceiling': { cooldownMs: 30 * DAY },
            'friends-100':    { maxTimes: 1 },
            'servers-10':     { maxTimes: 1 },
            'coffee':         { cooldownMs: 30 * DAY },
            'new-year':       { oncePerDay: true },
            'anniversary':    { oncePerDay: true },
            'self-fan':       { cooldownMs: 30 * DAY },
            'double-general': { cooldownMs: 30 * DAY },
            'revolving-door': { cooldownMs: 30 * DAY },
            'first-ban':      { maxTimes: 1 },
            'first-message':  { maxTimes: 1 },
            'first-call':     { maxTimes: 1 },
            'first-server':   { maxTimes: 1 },
            'call-100':       { maxTimes: 1 },
            'pi-day':         { oncePerDay: true },
            'leap-day':       { oncePerDay: true },
            'nye-call':       { oncePerDay: true },
        });
    });
    it.each(IDS)('%s is rate-limited: once ever, or at least a week apart, or once a (calendar) day', (id) => {
        const p = policy(id);
        expect(p.maxTimes === 1 || (p.cooldownMs ?? 0) >= 7 * DAY || p.oncePerDay === true).toBe(true);
    });
    it.each(IDS)('%s plays, then refuses an immediate repeat, and a once-ever one never comes back', (id) => {
        const s = memStore();
        expect(claimMoment(s, id, T0)).toBe(true);
        expect(claimMoment(s, id, T0 + 1000)).toBe(false);
        if (policy(id).maxTimes === 1) expect(claimMoment(s, id, T0 + 400 * DAY)).toBe(false);
    });
    it.each(IDS.filter(id => policy(id).cooldownMs))('%s: refused one minute before its cooldown, due at it', (id) => {
        const cd = policy(id).cooldownMs!;
        const ledger = { [ledgerId(id)]: { count: 1, last: T0 } };
        expect(momentDue(ledger, id, T0 + cd - 60_000)).toBe(false);
        expect(momentDue(ledger, id, T0 + cd)).toBe(true);
    });
    it('a calendar moment is once per LOCAL day (so: once a year on its date)', () => {
        const late = new Date('2026-10-20T23:50:00').getTime();
        const ledger = { [ledgerId('new-year')]: { count: 1, last: late } };
        expect(momentDue(ledger, 'new-year', new Date('2026-10-20T23:59:00').getTime())).toBe(false);
        expect(momentDue(ledger, 'new-year', new Date('2026-10-21T00:01:00').getTime())).toBe(true);
    });

    describe('the die (deterministic rng)', () => {
        const always = () => 0;
        const never = () => 0.999;
        it('no chance in the policy → always plays, whatever the rng', () => {
            for (const id of IDS.filter(i => policy(i).chance === undefined)) expect(momentRoll({}, id, never)).toBe(true);
        });
        it('self-ping: 1 in 3 — plays under 1/3, not at or over it', () => {
            expect(momentRoll({}, 'self-ping', () => 0.33)).toBe(true);
            expect(momentRoll({}, 'self-ping', () => 1 / 3)).toBe(false);
            expect(momentRoll({}, 'self-ping', never)).toBe(false);
        });
        it('self-ping has no free first play', () => {
            expect(momentRoll({}, 'self-ping', never)).toBe(false);
        });
        it('self-friend: the first time always plays; after that 1 in 4', () => {
            expect(momentRoll({}, 'self-friend', never)).toBe(true);
            const played = { [ledgerId('self-friend')]: { count: 1, last: T0 } };
            expect(momentRoll(played, 'self-friend', never)).toBe(false);
            expect(momentRoll(played, 'self-friend', () => 0.24)).toBe(true);
            expect(momentRoll(played, 'self-friend', () => 0.25)).toBe(false);
            expect(momentRoll(played, 'self-friend', always)).toBe(true);
        });
        it('a miss records nothing (the cooldown never starts on a miss)', () => {
            const s = memStore();
            expect(momentRollIn(s, 'self-ping', never)).toBe(false);
            expect(s.map.size).toBe(0);
            expect(claimMoment(s, 'self-ping', T0)).toBe(true);
        });
        it('an unreadable store rolls like a first play', () => {
            const s: EggStore = { getItem: () => { throw new Error('locked'); }, setItem: () => {} };
            expect(momentRollIn(s, 'self-friend', never)).toBe(true);
            expect(momentRollIn(s, 'self-ping', never)).toBe(false);
        });
        it('over many rolls, the rate is what the table says (seeded)', () => {
            let seed = 42;
            const lcg = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
            const played = { [ledgerId('self-friend')]: { count: 3, last: 0 } };
            let ping = 0, friend = 0;
            for (let i = 0; i < 6000; i++) { if (momentRoll({}, 'self-ping', lcg)) ping++; if (momentRoll(played, 'self-friend', lcg)) friend++; }
            expect(ping / 6000).toBeGreaterThan(0.30);
            expect(ping / 6000).toBeLessThan(0.37);
            expect(friend / 6000).toBeGreaterThan(0.22);
            expect(friend / 6000).toBeLessThan(0.28);
        });
    });
});

describe('the ledger', () => {
    it('claims, records under moment:<id>, then honours the cooldown', () => {
        const s = memStore();
        expect(claimMoment(s, 'self-friend', T0)).toBe(true);
        expect(parseLedger(s.map.get(EGG_LEDGER_KEY)!)[ledgerId('self-friend')]).toEqual({ count: 1, last: T0 });
        expect(claimMoment(s, 'self-friend', T0 + DAY)).toBe(false);
        expect(claimMoment(s, 'self-friend', T0 + 7 * DAY)).toBe(true);
        expect(momentCount(s, 'self-friend')).toBe(2);
    });
    it('ignores a stale retired easter-eggs switch (owner: eggs are part of the app, no toggle)', () => {
        const s = memStore({ [LEGACY_EGGS_KEY]: '0' });
        expect(claimMoment(s, 'self-friend', T0)).toBe(true);
    });
    it('an unreadable store refuses (better a skipped joke than a repeated once-ever one)', () => {
        const s: EggStore = { getItem: () => { throw new Error('locked'); }, setItem: () => {} };
        expect(claimMoment(s, 'self-friend', T0)).toBe(false);
    });
    it('a failed write still plays', () => {
        const s: EggStore = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
        expect(claimMoment(s, 'self-friend', T0)).toBe(true);
    });
    it('shares the eggs ledger without clobbering an egg entry', () => {
        const s = memStore({ [EGG_LEDGER_KEY]: JSON.stringify({ konami: { count: 3, last: 1 } }) });
        claimMoment(s, 'self-friend', T0);
        expect(parseLedger(s.map.get(EGG_LEDGER_KEY)!).konami).toEqual({ count: 3, last: 1 });
    });
});

describe('requestMoment', () => {
    // vitest runs this file in node: stand a plain EventTarget in for window.
    const catchOne = (fn: () => void) => {
        const got: unknown[] = [];
        const g = globalThis as { window?: unknown };
        const had = 'window' in g;
        const prev = g.window;
        const w = new EventTarget();
        g.window = w;
        w.addEventListener(MOMENT_EVENT, (e: Event) => got.push((e as CustomEvent).detail));
        try { fn(); } finally { if (had) g.window = prev; else delete g.window; }
        return got;
    };
    it('carries the id, and a server id only when one is given', () => {
        expect(catchOne(() => requestMoment('self-ping'))).toEqual([{ id: 'self-ping' }]);
        expect(catchOne(() => requestMoment('echo-everyone', { serverId: 's1' }))).toEqual([{ id: 'echo-everyone', serverId: 's1' }]);
        expect(catchOne(() => requestMoment('echo-everyone', { serverId: '' }))).toEqual([{ id: 'echo-everyone' }]);
    });
});

describe('isOwnTag', () => {
    const me = { username: 'Dawson', discriminator: 42 };
    it('matches your exact tag', () => { expect(isOwnTag({ username: 'Dawson', discriminator: 42 }, me)).toBe(true); });
    it('a different discriminator is someone else', () => { expect(isOwnTag({ username: 'Dawson', discriminator: 43 }, me)).toBe(false); });
    it('case differs → someone else (the server matches exactly; never block a real person)', () => {
        expect(isOwnTag({ username: 'dawson', discriminator: 42 }, me)).toBe(false);
    });
    it('unknown profile → never', () => {
        expect(isOwnTag({ username: 'Dawson', discriminator: 42 }, null)).toBe(false);
        expect(isOwnTag({ username: 'Dawson', discriminator: 42 }, { username: 'Dawson', discriminator: null })).toBe(false);
        expect(isOwnTag(null, me)).toBe(false);
    });
});

describe('quietEnough (ambient moments)', () => {
    it('needs visible, no call and no recent keystroke', () => {
        expect(quietEnough({ hidden: false, inCall: false, sinceKeyMs: IDLE_KEY_MS })).toBe(true);
        expect(quietEnough({ hidden: true, inCall: false, sinceKeyMs: Infinity })).toBe(false);
        expect(quietEnough({ hidden: false, inCall: true, sinceKeyMs: Infinity })).toBe(false);
        expect(quietEnough({ hidden: false, inCall: false, sinceKeyMs: IDLE_KEY_MS - 1 })).toBe(false);
    });
});

describe('mentionMoment (structural mention facts, on send)', () => {
    const me = 'u-me';
    it('@everyone / @here into a server that is only you → the echo', () => {
        expect(mentionMoment([{ type: 'everyone' }], { me, othersInServer: 0 })).toBe('echo-everyone');
        expect(mentionMoment([{ type: 'here' }], { me, othersInServer: 0 })).toBe('echo-everyone');
    });
    it('anyone else in the server → nothing (a real ping)', () => {
        expect(mentionMoment([{ type: 'everyone' }], { me, othersInServer: 1 })).toBeNull();
    });
    it('roster unknown (not loaded / not a server) → nothing', () => {
        expect(mentionMoment([{ type: 'everyone' }], { me, othersInServer: null })).toBeNull();
    });
    it('no @everyone → nothing', () => {
        expect(mentionMoment([{ type: 'role', id: 'r1' }], { me, othersInServer: 0 })).toBeNull();
        expect(mentionMoment([], { me, othersInServer: 0 })).toBeNull();
    });
    it('a mention of your own user id → self-ping (server, DM or group)', () => {
        expect(mentionMoment([{ type: 'user', id: me }], { me, othersInServer: null })).toBe('self-ping');
        expect(mentionMoment([{ type: 'user', id: me }], { me, othersInServer: 4 })).toBe('self-ping');
    });
    it('someone else mentioned, or no idea who you are → nothing', () => {
        expect(mentionMoment([{ type: 'user', id: 'u-mira' }], { me, othersInServer: null })).toBeNull();
        expect(mentionMoment([{ type: 'user', id: me }], { me: null, othersInServer: null })).toBeNull();
    });
    it('both at once: the echo wins (one moment per send)', () => {
        expect(mentionMoment([{ type: 'user', id: me }, { type: 'everyone' }], { me, othersInServer: 0 })).toBe('echo-everyone');
    });
    it("the echo's button fires the event Dashboard listens for", () => {
        expect(MOMENTS['echo-everyone'].action.event).toBe(MOMENT_INVITE_EVENT);
    });
});

describe('voiceJoinMoment (clock + roster presence)', () => {
    const at = (hm: string) => new Date(`2026-10-20T${hm}:30`);
    const me = 'u-me';
    const roster = (others: string[]) => [{ user_id: me, status: 'online' }, ...others.map((st, i) => ({ user_id: `u${i}`, status: st }))];
    it('isWishTime: 11:11 and 23:11 only', () => {
        expect(isWishTime(at('11:11'))).toBe(true);
        expect(isWishTime(at('23:11'))).toBe(true);
        expect(isWishTime(at('11:10'))).toBe(false);
        expect(isWishTime(at('11:12'))).toBe(false);
        expect(isWishTime(at('01:11'))).toBe(false);
        expect(isWishTime(at('12:11'))).toBe(false);
    });
    it('11:11 → the wish (it outranks an empty server)', () => {
        expect(voiceJoinMoment(at('11:11'), roster(['offline']), me)).toBe('wish');
    });
    it('nobody else online → the empty party (offline / invisible both count as away)', () => {
        expect(voiceJoinMoment(at('15:00'), roster(['offline', 'invisible']), me)).toBe('empty-party');
        expect(voiceJoinMoment(at('15:00'), roster([]), me)).toBe('empty-party');
    });
    it('anyone else online, idle or busy → nothing', () => {
        for (const st of ['online', 'idle', 'dnd']) expect(voiceJoinMoment(at('15:00'), roster(['offline', st]), me)).toBeNull();
    });
    it('roster not loaded / unknown user → nothing', () => {
        expect(voiceJoinMoment(at('15:00'), null, me)).toBeNull();
        expect(voiceJoinMoment(at('15:00'), [], me)).toBeNull();
        expect(voiceJoinMoment(at('15:00'), roster(['offline']), null)).toBeNull();
    });
});

describe('clockMoments (New Year, anniversary, coffee)', () => {
    const day = (iso: string) => new Date(iso);
    it('New Year: Jan 1 local only', () => {
        expect(clockMoments(day('2027-01-01T09:00:00'), Date.now(), null)).toContain('new-year');
        expect(clockMoments(day('2026-12-31T23:59:00'), Date.now(), null)).not.toContain('new-year');
        expect(clockMoments(day('2027-01-02T00:01:00'), Date.now(), null)).not.toContain('new-year');
    });
    it('anniversary: same month/day, a later year', () => {
        expect(isAccountAnniversary(day('2027-03-14T10:00:00'), '2026-03-14T08:00:00')).toBe(true);
        expect(isAccountAnniversary(day('2026-03-14T10:00:00'), '2026-03-14T08:00:00')).toBe(false); // sign-up day itself
        expect(isAccountAnniversary(day('2027-03-15T10:00:00'), '2026-03-14T08:00:00')).toBe(false);
        expect(isAccountAnniversary(day('2027-03-14T10:00:00'), null)).toBe(false);
        expect(isAccountAnniversary(day('2027-03-14T10:00:00'), 'garbage')).toBe(false);
    });
    it('anniversary: Feb 29 sign-ups celebrate Feb 28 in common years', () => {
        expect(isAccountAnniversary(day('2029-02-28T10:00:00'), '2028-02-29T10:00:00')).toBe(true);
        expect(isAccountAnniversary(day('2032-02-29T10:00:00'), '2028-02-29T10:00:00')).toBe(true);
        expect(isAccountAnniversary(day('2032-02-28T10:00:00'), '2028-02-29T10:00:00')).toBe(false);
    });
    it('coffee: after 12 hours open, not before', () => {
        const now = day('2026-10-20T22:00:00');
        expect(clockMoments(now, now.getTime() - COFFEE_AFTER_MS, null)).toContain('coffee');
        expect(clockMoments(now, now.getTime() - COFFEE_AFTER_MS + 60_000, null)).not.toContain('coffee');
    });
    it('an ordinary day, freshly opened: nothing', () => {
        const now = day('2026-10-20T12:00:00');
        expect(clockMoments(now, now.getTime(), '2026-05-01T00:00:00')).toEqual([]);
    });
});

describe('selfReact', () => {
    it('the 10th reaction to your own messages inside 2 min fires, then starts over', () => {
        let r = { times: [] as number[], fire: false };
        for (let i = 0; i < 9; i++) { r = selfReact(r.times, i * 1000); expect(r.fire).toBe(false); }
        r = selfReact(r.times, 9000);
        expect(r).toEqual({ times: [], fire: true });
    });
    it('spread over more than 2 minutes: never', () => {
        let r = { times: [] as number[], fire: false };
        for (let i = 0; i < 20; i++) { r = selfReact(r.times, i * (SELF_REACT_WINDOW_MS / 8)); expect(r.fire).toBe(false); }
    });
});

describe('isSecondGeneral', () => {
    const made = { channel_id: 'c-new', name: 'general' };
    it('a new #general when one exists (any case / a leading #)', () => {
        expect(isSecondGeneral(made, [{ channel_id: 'c1', name: 'General' }, made])).toBe(true);
        expect(isSecondGeneral({ channel_id: 'c-new', name: ' General ' }, [{ channel_id: 'c1', name: '#general' }])).toBe(true);
    });
    it('the first #general, or another name: never', () => {
        expect(isSecondGeneral(made, [made, { channel_id: 'c1', name: 'memes' }])).toBe(false);
        expect(isSecondGeneral({ channel_id: 'x', name: 'memes' }, [{ channel_id: 'c1', name: 'memes' }])).toBe(false);
        expect(isSecondGeneral(made, undefined)).toBe(false);
    });
});

describe('leave → rejoin (revolving door)', () => {
    it('seen gone, then back inside a minute: once', () => {
        __resetLeftServers();
        noteServerLeft('s1', 0);
        expect(serverRejoined(['s1', 's2'], 100)).toBe(false);   // list not refreshed yet: still there, not "back"
        expect(serverRejoined(['s2'], 200)).toBe(false);          // gone
        expect(serverRejoined(['s1', 's2'], 30_000)).toBe(true);  // back
        expect(serverRejoined(['s1', 's2'], 30_100)).toBe(false); // consumed
    });
    it('back after more than a minute: never', () => {
        __resetLeftServers();
        noteServerLeft('s1', 0);
        serverRejoined([], 100);
        expect(serverRejoined(['s1'], REJOIN_WINDOW_MS + 1)).toBe(false);
    });
});
