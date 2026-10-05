import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const mem = new Map<string, string>();
let refuse = false;
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { if (refuse) throw new Error('locked'); mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
};
vi.mock('./secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const {
    ASK_CONFIRMATION_TOAST, decideNotificationAsk, hasAskedNotifications, markNotificationsAsked,
    notificationAskCopy, parseAskMarker,
} = await import('./notificationAsk');

beforeEach(() => { mem.clear(); refuse = false; });

describe('when to ask about notifications', () => {
    // prefEnabled × platform × alreadyAsked
    const cases: [string, boolean, string | undefined, boolean, 'enable' | 'prime' | null][] = [
        ['off, any platform -> offer to turn on',         false, 'windows', false, 'enable'],
        ['off on mac -> offer to turn on',                 false, 'mac',     false, 'enable'],
        ['on + mac -> prime the macOS sheet in context',   true,  'mac',     false, 'prime'],
        ['on + windows -> nothing to ask',                 true,  'windows', false, null],
        ['on + linux -> nothing to ask',                   true,  'linux',   false, null],
        ['on + unknown platform -> nothing to ask',        true,  undefined, false, null],
        ['already asked (off) -> never again',             false, 'windows', true,  null],
        ['already asked (mac) -> never again',             true,  'mac',     true,  null],
    ];
    it.each(cases)('%s', (_n, prefEnabled, platform, alreadyAsked, want) => {
        expect(decideNotificationAsk({ prefEnabled, platform, alreadyAsked })).toBe(want);
    });
});

describe('the ask is asked once per account on this device', () => {
    it('no marker -> not asked; marker (either answer) -> asked', () => {
        expect(hasAskedNotifications('u1')).toBe(false);
        markNotificationsAsked('u1', 'declined', 5);
        expect(hasAskedNotifications('u1')).toBe(true);
        expect(hasAskedNotifications('u2')).toBe(false); // per account
        expect(parseAskMarker(mem.get('cipherline_notif_ask_u1'))).toEqual({ v: 1, at: 5, outcome: 'declined' });
    });
    it('an unreadable store counts as asked (asking twice is the worse failure)', () => {
        const orig = fakeStore.getItem;
        fakeStore.getItem = () => { throw new Error('locked'); };
        try { expect(hasAskedNotifications('u1')).toBe(true); } finally { fakeStore.getItem = orig; }
    });
    it('a locked store does not throw on write', () => {
        refuse = true;
        expect(() => markNotificationsAsked('u1', 'accepted')).not.toThrow();
    });
    it('parseAskMarker rejects junk', () => {
        for (const raw of [null, '', '{nope', '{"v":2,"outcome":"accepted"}', '{"v":1,"outcome":"maybe"}']) {
            expect(parseAskMarker(raw)).toBeNull();
        }
    });
});

describe('copy', () => {
    it('names what they just did, and says what happens', () => {
        expect(notificationAskCopy('enable', 'friend_request_sent').title).toBe('Want a ping when they accept?');
        expect(notificationAskCopy('enable', 'invite_sent').title).toBe('Want a ping when they join?');
        expect(notificationAskCopy('prime', 'friend_request_sent').body).toMatch(/Mac will ask/);
        expect(notificationAskCopy('enable', 'invite_sent').accept).toBe('Turn on');
        expect(notificationAskCopy('prime', 'invite_sent').accept).toBe('Yes, ping me');
    });
    it('the confirmation toast opens no conversation', () => {
        expect(ASK_CONFIRMATION_TOAST.conv_id).toBe('');
    });
});

// ── Timing: nothing asks at launch ───────────────────────────────────────────
// The renderer has no jsdom, so "when does it ask?" is pinned the way the rest
// of this repo pins wiring: against the source. The ask can only be raised by
// the two bus events, never from a mount effect, a startup path, or main.
const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');
const read = (rel: string) => readFileSync(join(srcRoot, rel), 'utf8');
const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
    }
    return out;
};

describe('permission asks happen at the moment of need, never at launch', () => {
    const hook = read('hooks/useFirstWeekNudges.ts');

    it('a pending ask is created ONLY by the friend-request and invite events', () => {
        const sets = [...hook.matchAll(/pendingAskRef\.current = \{/g)];
        expect(sets).toHaveLength(1);
        const at = hook.indexOf('pendingAskRef.current = {');
        const caseBlock = hook.slice(hook.lastIndexOf("case 'friend_request_sent'", at), at);
        expect(caseBlock).toContain("case 'friend_request_sent':");
        expect(caseBlock).toContain("case 'invite_sent':");
    });

    it('the OS test toast (what makes macOS show its sheet) is raised only from accept()', () => {
        const occurrences = [...hook.matchAll(/notifShow/g)];
        expect(occurrences).toHaveLength(1);
        const accept = hook.slice(hook.indexOf('const accept = useCallback'), hook.indexOf('const dismiss = useCallback'));
        expect(accept).toContain('notifShow');
    });

    it('nothing at startup calls notifShow or Notification.requestPermission', () => {
        const offenders: string[] = [];
        for (const f of walk(srcRoot)) {
            const rel = relative(srcRoot, f);
            const txt = readFileSync(f, 'utf8');
            if (/Notification\.requestPermission|requestPermission\(/.test(txt)) offenders.push(`${rel}: requestPermission`);
        }
        expect(offenders).toEqual([]);
        // The only renderer callers of notifShow: the message dispatcher (reacting
        // to an incoming message) and the ask's accept().
        const callers = walk(srcRoot)
            .filter(f => /notifShow\??\./.test(readFileSync(f, 'utf8')) || /notifShow\?\.\(/.test(readFileSync(f, 'utf8')))
            .map(f => relative(srcRoot, f))
            .filter(r => r !== 'env.d.ts')
            .sort();
        expect(callers).toEqual(['hooks/useFirstWeekNudges.ts', 'hooks/useNotificationDispatch.ts']);
    });

    it('mic / camera: the ONLY direct getUserMedia call sites are the Voice & Video settings pane (user-opened) — joining a call goes through LiveKit', () => {
        const sites = walk(srcRoot)
            .filter(f => readFileSync(f, 'utf8').split('\n')
                .some(line => !/^\s*(\/\/|\*)/.test(line) && /navigator\.mediaDevices\.getUserMedia\(/.test(line)))
            .map(f => relative(srcRoot, f))
            .sort();
        expect(sites).toEqual(['components/VoiceVideoSettings.tsx']);
        // …and that pane is mounted only when the user navigates to it.
        expect(read('components/settings/SettingsScreen.tsx')).toContain("{pane === 'voice' && <VoiceVideoSettings");
        // No boot path touches it.
        for (const boot of ['App.tsx', 'main.tsx']) expect(read(boot)).not.toMatch(/getUserMedia|VoiceVideoSettings|askForMediaAccess/);
    });
});
