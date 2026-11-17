import { describe, it, expect } from 'vitest';
import {
    MUTE_MS, PROMPT_MIN_GAP_MS, PROMPTED_SESSIONS_MAX, SUPPRESSED_KEEP_DAYS, SUPPRESSED_MAX_ENTRIES, UNCLEAN_LEDGER_FILE, UncleanLedgerStore,
    decidePrompt, emptyLedger, judgeUncleanExit, parseLedger, suppressedCounts, withDismissed, withPrompted, withReviewed, withSuppressed,
    type LedgerFs,
} from './unclean-exit-ledger';
import type { ClassifyEnv, DeadSession } from './unclean-exit-classify';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const H = 3600_000;
const DAY = 24 * H;
const FILE = `/ud/${UNCLEAN_LEDGER_FILE}`;

function memFs(initial: Record<string, string> = {}) {
    const files = { ...initial };
    const fs: LedgerFs & { files: Record<string, string>; failWrites: boolean } = {
        files, failWrites: false,
        readFileSync: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
        writeFileSync: (p, d) => { if (fs.failWrites) throw new Error('EROFS'); files[p] = d; },
        renameSync: (a, b) => { files[b] = files[a]; delete files[a]; },
    };
    return fs;
}

describe('decidePrompt — rate limits', () => {
    it('first ever: prompts', () => {
        expect(decidePrompt(emptyLedger(), NOW - H, NOW)).toEqual({ prompt: true, why: 'ok' });
    });
    it('at most one prompt per 24 h', () => {
        const l = withPrompted(emptyLedger(), NOW - 5 * DAY, NOW - 23 * H);
        expect(decidePrompt(l, NOW - H, NOW)).toEqual({ prompt: false, why: 'rate_limited' });
        expect(decidePrompt(l, NOW - H, NOW - 23 * H + PROMPT_MIN_GAP_MS).prompt).toBe(true);
    });
    it('never twice for the same dead session, even a week later', () => {
        const l = withPrompted(emptyLedger(), 12345678900000, NOW - 8 * DAY);
        expect(decidePrompt(l, 12345678900000, NOW)).toEqual({ prompt: false, why: 'same_session' });
        expect(decidePrompt(l, 12345678900001, NOW).prompt).toBe(true);
    });
    it('an unknown session id is never "the same session"', () => {
        const l = withPrompted(emptyLedger(), null, NOW - 2 * DAY);
        expect(l.promptedSessions).toEqual([]);
        expect(decidePrompt(l, null, NOW).prompt).toBe(true);
    });
    it('one dismissal does not mute; the second in a row mutes for 7 days', () => {
        let l = withDismissed(emptyLedger(), NOW);
        expect(l.mutedUntil).toBeNull();
        expect(decidePrompt(l, 1, NOW + DAY).prompt).toBe(true);
        l = withDismissed(l, NOW + DAY);
        expect(l.mutedUntil).toBe(NOW + DAY + MUTE_MS);
        expect(decidePrompt(l, 2, NOW + 3 * DAY)).toEqual({ prompt: false, why: 'muted' });
        expect(decidePrompt(l, 2, NOW + DAY + MUTE_MS).prompt).toBe(true);
    });
    it('"Review" resets the dismissal streak', () => {
        const l = withReviewed(withDismissed(emptyLedger(), NOW));
        expect(withDismissed(l, NOW + DAY).mutedUntil).toBeNull();
    });
    it('bad clock: a mute or last-prompt in the FUTURE never silences a prompt', () => {
        expect(decidePrompt({ ...emptyLedger(), mutedUntil: NOW + 400 * DAY }, 1, NOW).prompt).toBe(true);
        expect(decidePrompt({ ...emptyLedger(), lastPromptAt: NOW + 5 * DAY }, 1, NOW).prompt).toBe(true);
    });
    it('promptedSessions is capped', () => {
        let l = emptyLedger();
        for (let i = 0; i < PROMPTED_SESSIONS_MAX + 5; i++) l = withPrompted(l, 1_000_000_000_000 + i, NOW);
        expect(l.promptedSessions).toHaveLength(PROMPTED_SESSIONS_MAX);
        expect(l.promptedSessions.at(-1)).toBe(1_000_000_000_000 + PROMPTED_SESSIONS_MAX + 4);
    });
});

describe('suppressed counters', () => {
    it('counts by class over the kept window', () => {
        let l = emptyLedger();
        l = withSuppressed(l, 'installer_replaced', NOW - DAY);
        l = withSuppressed(l, 'installer_replaced', NOW - H);
        l = withSuppressed(l, 'os_restart', NOW - H);
        expect(suppressedCounts(l, NOW)).toEqual({ installer_replaced: 2, os_restart: 1 });
    });
    it('null when nothing was suppressed', () => { expect(suppressedCounts(emptyLedger(), NOW)).toBeNull(); });
    it('entries older than the window drop out', () => {
        const l = withSuppressed(emptyLedger(), 'os_restart', NOW - (SUPPRESSED_KEEP_DAYS + 1) * DAY);
        expect(suppressedCounts(l, NOW)).toBeNull();
        expect(withSuppressed(l, 'os_restart', NOW).suppressed).toHaveLength(1);
    });
    it('is capped', () => {
        let l = emptyLedger();
        for (let i = 0; i < SUPPRESSED_MAX_ENTRIES + 10; i++) l = withSuppressed(l, 'external_kill_suspected', NOW - i);
        expect(l.suppressed).toHaveLength(SUPPRESSED_MAX_ENTRIES);
    });
});

describe('parseLedger / store', () => {
    it('garbage, wrong version, oversized -> empty', () => {
        for (const t of [null, '', 'not json', '{"v":2}', '[]', 'x'.repeat(9000)]) expect(parseLedger(t)).toEqual(emptyLedger());
    });
    it('drops malformed fields individually', () => {
        const l = parseLedger(JSON.stringify({
            v: 1, lastPromptAt: 'x', promptedSessions: [1, 'a', -1, null, 5], dismissals: -3, mutedUntil: NaN,
            suppressed: [{ at: 5, cls: 'os_restart' }, { at: 5, cls: 'real_candidate' }, { at: 'x', cls: 'os_restart' }, 7],
        }));
        expect(l).toEqual({ v: 1, lastPromptAt: null, promptedSessions: [1, 5], dismissals: 0, mutedUntil: null, suppressed: [{ at: 5, cls: 'os_restart' }] });
    });
    it('round-trips through the file, atomically, with owner-only mode', () => {
        const fs = memFs();
        const s = new UncleanLedgerStore(fs, FILE, true);
        s.update(l => withSuppressed(l, 'installer_replaced', NOW));
        expect(Object.keys(fs.files)).toEqual([FILE]);
        expect(new UncleanLedgerStore(fs, FILE, true).load().suppressed).toEqual([{ at: NOW, cls: 'installer_replaced' }]);
    });
    it('the file holds only numbers and class names (no ids, paths, names)', () => {
        const fs = memFs();
        const s = new UncleanLedgerStore(fs, () => FILE, true);
        s.update(l => withSuppressed(withPrompted(l, NOW - H, NOW), 'os_restart', NOW));
        expect(fs.files[FILE]).toMatch(/^[\d{}\[\]":,a-z_.-]*$/i);
    });
    it('a failing disk never throws and the in-memory verdict still stands', () => {
        const fs = memFs(); fs.failWrites = true;
        const s = new UncleanLedgerStore(fs, FILE, true);
        expect(() => s.update(l => withSuppressed(l, 'os_restart', NOW))).not.toThrow();
        expect(s.load()).toEqual(emptyLedger());
    });
    it('disabled (smoke test / dev): zero fs access', () => {
        const calls: string[] = [];
        const fs: LedgerFs = {
            readFileSync: () => { calls.push('r'); return ''; }, writeFileSync: () => { calls.push('w'); }, renameSync: () => { calls.push('m'); },
        };
        const s = new UncleanLedgerStore(fs, FILE, false);
        s.load(); s.update(l => withSuppressed(l, 'os_restart', NOW));
        expect(calls).toEqual([]);
    });
});

describe('judgeUncleanExit — classification + ledger together', () => {
    const START = NOW - 40 * 60_000, SEEN = NOW - 30 * 60_000;
    const idle = { window_visible: false, in_call: false, sharing: false, camera_live: false };
    const dead = (o: Partial<DeadSession> = {}): DeadSession => ({ startedAt: START, lastSeenAt: SEEN, appVersion: '0.1.0', hung: false, state: idle, rows: [], ...o });
    const env = (o: Partial<ClassifyEnv> = {}): ClassifyEnv => ({ now: NOW, exeChangedAt: START - 9 * DAY, bootTime: START - 9 * DAY, currentVersion: '0.1.0', ...o });
    const fresh = () => new UncleanLedgerStore(memFs(), FILE, true);

    it('a suppressed class is counted, dropped, and does NOT use up the prompt slot', () => {
        const s = fresh();
        expect(judgeUncleanExit(s, dead(), env({ exeChangedAt: SEEN + 60_000 }))).toMatchObject({ action: 'suppress', cls: 'installer_replaced' });
        expect(judgeUncleanExit(s, dead({ startedAt: START - 1 }), env({ bootTime: NOW - 60_000 }))).toMatchObject({ action: 'suppress', cls: 'os_restart' });
        expect(judgeUncleanExit(s, dead({ startedAt: START - 2 }), env())).toMatchObject({ action: 'suppress', cls: 'external_kill_suspected' });
        const l = s.load();
        expect(suppressedCounts(l, NOW)).toEqual({ installer_replaced: 1, os_restart: 1, external_kill_suspected: 1 });
        expect(l.lastPromptAt).toBeNull();
    });
    it('a real candidate prompts once, then a second one inside 24 h is kept quietly (seen)', () => {
        const s = fresh();
        const real1 = dead({ state: { ...idle, in_call: true } });
        expect(judgeUncleanExit(s, real1, env())).toMatchObject({ action: 'keep', seen: false, reason: 'call_active' });
        const real2 = dead({ startedAt: START - 1, state: { ...idle, sharing: true } });
        expect(judgeUncleanExit(s, real2, env({ now: NOW + H }))).toMatchObject({ action: 'keep', seen: true, why: 'rate_limited' });
        expect(judgeUncleanExit(s, real2, env({ now: NOW + 25 * H }))).toMatchObject({ action: 'keep', seen: false });
    });
    it('the same dead session (re-reported) never prompts twice', () => {
        const s = fresh();
        const real = dead({ state: { ...idle, in_call: true } });
        judgeUncleanExit(s, real, env());
        expect(judgeUncleanExit(s, real, env({ now: NOW + 10 * DAY }))).toMatchObject({ action: 'keep', seen: true, why: 'same_session' });
    });
    it('hung-exit prompts like any real candidate, and obeys the mute', () => {
        const s = fresh();
        s.update(l => withDismissed(withDismissed(l, NOW - DAY), NOW - H));
        expect(judgeUncleanExit(s, dead({ hung: true }), env())).toMatchObject({ action: 'keep', seen: true, why: 'muted' });
    });
    it('a nonsense dead start is a real candidate that prompts (and has no session id to remember)', () => {
        const s = fresh();
        expect(judgeUncleanExit(s, dead({ startedAt: NOW + 10 * DAY }), env())).toMatchObject({ action: 'keep', seen: false, reason: 'bad_dead_session_time' });
        expect(s.load().promptedSessions).toEqual([]);
    });
});
