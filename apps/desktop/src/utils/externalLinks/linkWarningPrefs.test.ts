/**
 * "Warn before opening links" / "Still warn about suspicious links": stored
 * per account in the real encrypted store, and gating each warning type in
 * openExternalLink — while the real-click requirement never turns off.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { secureLocalStore } from '../secureLocalStore';
import { openExternalLink } from '../openExternalLink';
import { cancelLeave, getLeaveSnapshot, registerLeaveHost } from './leaveGate';
import { setUserGestureProbeForTests } from './shellOpen';
import {
    DEFAULT_LINK_WARNING_PREFS, LINK_WARNING_PREFS_KEY_PREFIX, getLinkWarningPrefs, setLinkWarningPrefs, subscribeLinkWarningPrefs,
} from './linkWarningPrefs';
import { restartStore, signIn, wipeStoreDb } from './testStore.testkit';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

let openExternal: ReturnType<typeof vi.fn>;
let unregister: () => void;
beforeEach(async () => {
    await wipeStoreDb();
    await restartStore();
    openExternal = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.openExternal = openExternal;
    setUserGestureProbeForTests(() => true);
    unregister = registerLeaveHost();
});
afterEach(() => {
    const p = getLeaveSnapshot();
    if (p) cancelLeave(p.id);
    unregister();
    setUserGestureProbeForTests(null);
    vi.restoreAllMocks();
});

/** What a click on `url` does now: 'dialog' | 'opened' | a refusal reason. */
function clickOutcome(url: string, label?: string): string {
    openExternal.mockClear();
    const r = openExternalLink(url, label ? { label } : {});
    const pending = getLeaveSnapshot();
    if (pending) { cancelLeave(pending.id); return 'dialog'; }
    if (!r.ok) return r.reason;
    return openExternal.mock.calls.length === 1 ? 'opened' : 'nothing';
}

const PLAIN = 'https://example.com/page';
const MASKED: [string, string] = ['https://paypa1.example/login', 'paypal.com'];
const IDN = 'https://аpple.com/';
const USERINFO = 'https://cipherline.chat@evil.example/';
const MAIL_SPOOF = 'mailto:billing@аpple.com';
const MAIL_PLAIN = 'mailto:hi@example.org';

describe('link warning prefs — storage', () => {
    it('defaults to warn ON + suspicious ON (signed out, fresh account, unreadable value)', async () => {
        expect(getLinkWarningPrefs()).toEqual(DEFAULT_LINK_WARNING_PREFS);
        expect(setLinkWarningPrefs({ warn: false })).toBe(false); // signed out: nowhere to store it
        await signIn(ALICE);
        expect(getLinkWarningPrefs()).toEqual({ warn: true, warnSuspicious: true });
        secureLocalStore.setItem(`${LINK_WARNING_PREFS_KEY_PREFIX}${ALICE}`, '{not json');
        expect(getLinkWarningPrefs()).toEqual({ warn: true, warnSuspicious: true });
        secureLocalStore.setItem(`${LINK_WARNING_PREFS_KEY_PREFIX}${ALICE}`, JSON.stringify({ warn: 'no', warnSuspicious: 0 }));
        expect(getLinkWarningPrefs()).toEqual({ warn: true, warnSuspicious: true }); // only an explicit false turns one off
    });

    it('per account, survives a restart, never written into a loading account', async () => {
        await signIn(ALICE);
        const fn = vi.fn();
        const off = subscribeLinkWarningPrefs(fn);
        expect(setLinkWarningPrefs({ warn: false, warnSuspicious: false })).toBe(true);
        off();
        expect(fn).toHaveBeenCalledTimes(1);
        await secureLocalStore.flushNow();
        await signIn(BOB);
        expect(getLinkWarningPrefs()).toEqual({ warn: true, warnSuspicious: true });
        secureLocalStore.setItem('cipherline_user_id', ALICE); // rebind not awaited
        expect(setLinkWarningPrefs({ warn: true })).toBe(false);
        await secureLocalStore.whenAccountReady();
        expect(getLinkWarningPrefs()).toEqual({ warn: false, warnSuspicious: false });
        await restartStore();
        await secureLocalStore.whenAccountReady();
        expect(getLinkWarningPrefs()).toEqual({ warn: false, warnSuspicious: false });
    });
});

describe('link warning prefs — what each setting does to each warning type', () => {
    beforeEach(async () => { await signIn(ALICE); });

    it('warn ON (default): every untrusted link asks; cipherline.chat opens directly', () => {
        for (const u of [PLAIN, IDN, USERINFO, MAIL_SPOOF, MAIL_PLAIN]) expect(clickOutcome(u)).toBe('dialog');
        expect(clickOutcome(...MASKED)).toBe('dialog');
        expect(clickOutcome('https://cipherline.chat/x')).toBe('opened');
    });

    it('warn OFF, suspicious ON: ordinary links open straight away; mismatch, look-alike and user@host still ask', () => {
        setLinkWarningPrefs({ warn: false });
        expect(clickOutcome(PLAIN)).toBe('opened');
        expect(clickOutcome(MAIL_PLAIN)).toBe('opened');
        expect(clickOutcome('https://www.münchen.de/')).toBe('opened'); // honest IDN is not suspicious
        expect(clickOutcome(...MASKED)).toBe('dialog');
        expect(clickOutcome('https://cipherline.chat/x', 'paypal.com')).toBe('dialog'); // mismatch to a trusted site
        expect(clickOutcome(IDN)).toBe('dialog');
        expect(clickOutcome(USERINFO)).toBe('dialog');
        expect(clickOutcome(MAIL_SPOOF)).toBe('dialog');
    });

    it('both OFF ("never warn"): no dialog at all, for any kind of link', () => {
        setLinkWarningPrefs({ warn: false, warnSuspicious: false });
        for (const u of [PLAIN, IDN, USERINFO, MAIL_SPOOF, MAIL_PLAIN, 'https://cipherline.chat/x']) expect(clickOutcome(u)).toBe('opened');
        expect(clickOutcome(...MASKED)).toBe('opened');
        expect(clickOutcome('https://cipherline.chat/x', 'paypal.com')).toBe('opened');
    });

    it('suspicious OFF does nothing while warn is ON', () => {
        setLinkWarningPrefs({ warnSuspicious: false });
        expect(clickOutcome(PLAIN)).toBe('dialog');
        expect(clickOutcome(...MASKED)).toBe('dialog');
    });

    it('the click requirement holds with warnings off: no gesture = refused (control: with one it opens)', () => {
        setLinkWarningPrefs({ warn: false, warnSuspicious: false });
        expect(clickOutcome(PLAIN)).toBe('opened');            // control
        setUserGestureProbeForTests(null);                     // the real check: no browser event here
        for (const u of [PLAIN, 'https://cipherline.chat/x', MAIL_PLAIN]) expect(clickOutcome(u)).toBe('no-user-gesture');
        expect(clickOutcome(...MASKED)).toBe('no-user-gesture');
        expect(openExternal).not.toHaveBeenCalled();
        setUserGestureProbeForTests(() => false);
        expect(clickOutcome(PLAIN)).toBe('no-user-gesture');
    });

    it('bad schemes are still refused with warnings off', () => {
        setLinkWarningPrefs({ warn: false, warnSuspicious: false });
        expect(clickOutcome('http://example.com/')).toBe('disallowed-scheme');
        expect(clickOutcome('javascript:alert(1)')).toBe('disallowed-scheme');
    });
});
