import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
};
vi.mock('./secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const { COACH_WINDOW_DAYS, coachMayShow, isWithinCoachWindow, pickSaveCoachTarget, saveCoachCopy } = await import('./saveCoachMark');
const { readNudgeState, updateNudgeState, writeNudgeState, nudges, __resetNudgeBusForTests } = await import('./firstWeekNudgeStore');
const { DAY_MS, defaultNudgeState } = await import('./firstWeekNudges');
const { MESSAGE_RETENTION_LABELS } = await import('../hooks/useRetentionPolicy');

const ME = 'me';
const THEM = 'them';
const NOW = Date.UTC(2026, 9, 6, 15);
const text = (id: string, from: string, type = 'text') => ({ id, sender_user_id: from, content: { type } });
const base = {
    isOneToOneDm: true, retention: '1wk' as const, myUserId: ME,
    messages: [text('a', THEM)], isSaved: () => false,
};

beforeEach(() => { mem.clear(); __resetNudgeBusForTests(); });

describe('which message the coach mark points at', () => {
    it('the newest message from the OTHER person', () => {
        expect(pickSaveCoachTarget({ ...base, messages: [text('a', THEM), text('b', ME), text('c', THEM), text('d', ME)] })).toBe('c');
    });
    it('only text-like messages (text, invite, GIF) — not calls, reactions or system rows', () => {
        expect(pickSaveCoachTarget({ ...base, messages: [text('a', THEM, 'text'), text('b', THEM, 'call_key'), text('c', THEM, 'system'), text('d', THEM, 'reaction')] })).toBe('a');
        expect(pickSaveCoachTarget({ ...base, messages: [text('a', THEM, 'klipy_gif')] })).toBe('a');
        expect(pickSaveCoachTarget({ ...base, messages: [text('a', THEM, 'server_invite')] })).toBe('a');
        expect(pickSaveCoachTarget({ ...base, messages: [text('a', THEM, 'call_key')] })).toBeNull();
    });
    it('nothing to teach when messages already keep forever', () => {
        expect(pickSaveCoachTarget({ ...base, retention: 'never' })).toBeNull();
    });
    it.each(['1wk', '1mo', '3mo', '6mo', '1y'] as const)('auto-deleting retention %s qualifies', (r) => {
        expect(pickSaveCoachTarget({ ...base, retention: r })).toBe('a');
    });
    it('not for groups, channels or your own chat', () => {
        expect(pickSaveCoachTarget({ ...base, isOneToOneDm: false })).toBeNull();
    });
    it('skips what is already saved; nothing when all are', () => {
        expect(pickSaveCoachTarget({ ...base, messages: [text('a', THEM), text('b', THEM)], isSaved: id => id === 'b' })).toBe('a');
        expect(pickSaveCoachTarget({ ...base, isSaved: () => true })).toBeNull();
    });
    it('only your own messages / unknown senders / no id / signed out -> nothing', () => {
        expect(pickSaveCoachTarget({ ...base, messages: [text('a', ME)] })).toBeNull();
        expect(pickSaveCoachTarget({ ...base, messages: [{ id: 'a', content: { type: 'text' } }] })).toBeNull();
        expect(pickSaveCoachTarget({ ...base, messages: [{ sender_user_id: THEM, content: { type: 'text' } }] })).toBeNull();
        expect(pickSaveCoachTarget({ ...base, myUserId: null })).toBeNull();
        expect(pickSaveCoachTarget({ ...base, messages: [] })).toBeNull();
    });
});

describe('who may see it, and only once', () => {
    const gate = { done: false, off: false, createdAt: NOW - 2 * DAY_MS, now: NOW, windowActive: true };

    it('a new account that has not been taught: yes', () => {
        expect(coachMayShow(gate)).toBe(true);
    });
    it('one time per account: once done, never', () => {
        expect(coachMayShow({ ...gate, done: true })).toBe(false);
    });
    it('the flag survives a restart (it is persisted, per account)', () => {
        expect(readNudgeState('u1').coachSaveDone).toBe(false);
        updateNudgeState('u1', s => ({ ...s, coachSaveDone: true }));
        expect(readNudgeState('u1').coachSaveDone).toBe(true);
        expect(coachMayShow({ ...gate, done: readNudgeState('u1').coachSaveDone })).toBe(false);
        // …and is per account.
        expect(readNudgeState('u2').coachSaveDone).toBe(false);
    });
    it('marking it taught keeps the rest of the state (the off switch, counters)', () => {
        writeNudgeState('u1', { ...defaultNudgeState(), off: true, sentMessage: true });
        updateNudgeState('u1', s => ({ ...s, coachSaveDone: true }));
        expect(readNudgeState('u1')).toMatchObject({ off: true, sentMessage: true, coachSaveDone: true });
    });
    it('"Don\'t show these" covers the coach mark too', () => {
        expect(coachMayShow({ ...gate, off: true })).toBe(false);
    });
    it('not while the window is in the background', () => {
        expect(coachMayShow({ ...gate, windowActive: false })).toBe(false);
    });
    it('only for fairly new accounts; an old account that just updated is never interrupted', () => {
        expect(isWithinCoachWindow(NOW - (COACH_WINDOW_DAYS * DAY_MS - 1000), NOW)).toBe(true);
        expect(isWithinCoachWindow(NOW - COACH_WINDOW_DAYS * DAY_MS, NOW)).toBe(false);
        expect(isWithinCoachWindow(NOW - 365 * DAY_MS, NOW)).toBe(false);
        expect(coachMayShow({ ...gate, createdAt: null })).toBe(false);
        expect(coachMayShow({ ...gate, createdAt: 'garbage' })).toBe(false);
    });
});

describe('copy', () => {
    it('says when messages in this chat delete themselves, using the Storage settings\' own labels', () => {
        for (const r of ['1wk', '1mo', '3mo', '6mo', '1y'] as const) {
            expect(saveCoachCopy(r).body).toContain(MESSAGE_RETENTION_LABELS[r].toLowerCase());
        }
        expect(saveCoachCopy('1wk').body).toBe('Messages in this chat delete themselves after 1 week. Save the ones you want to keep and they stay.');
    });
    it('names the real controls', () => {
        const c = saveCoachCopy('1wk');
        expect(c.save).toBe('Save this message');
        expect(c.hint).toMatch(/save icon/i);
        expect(c.hint).toMatch(/right-click/i);
    });
});

describe('nudges.notify (the hook other features call)', () => {
    it('is a harmless no-op with nothing listening', () => {
        expect(() => nudges.notify({ kind: 'friend_joined', username: 'sam' })).not.toThrow();
    });
    it('delivers to subscribers, isolates a throwing one, and unsubscribes', () => {
        const got: string[] = [];
        const off1 = nudges.subscribe(() => { throw new Error('boom'); });
        const off2 = nudges.subscribe(e => got.push(e.kind));
        nudges.notify({ kind: 'invite_sent' });
        nudges.notify({ kind: 'friend_joined', username: 'sam', userId: 'u2' });
        expect(got).toEqual(['invite_sent', 'friend_joined']);
        off1(); off2();
        nudges.notify({ kind: 'message_sent' });
        expect(got).toHaveLength(2);
    });
});

// ── Wiring: the pieces are mounted where the behaviour needs them ────────────
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

describe('wiring', () => {
    it('the coach mark writes its one-shot flag the moment it shows, and anchors to the row id ChatPane renders', () => {
        const c = read('components/SaveCoachMark.tsx');
        expect(c).toMatch(/updateNudgeState\(userId, s => \(s\.coachSaveDone \? s : \{ \.\.\.s, coachSaveDone: true \}\)\)/);
        expect(c).toContain('document.getElementById(`msg-${targetId}`)');
        expect(read('components/ChatPane.tsx')).toContain('id={`msg-${msg.id}`}');
    });
    it('ChatPane mounts it for one-to-one DMs only, with the chat\'s own retention', () => {
        const chat = read('components/ChatPane.tsx');
        expect(chat).toContain('<SaveCoachMark');
        expect(chat).toContain("isOneToOneDm={!activeChannel && activeChat.type === 'dm' && !isSelfChat}");
        expect(chat).toContain('retention={resolveChatMessageRetention(retention.policy, convType, channelMessageRetention)}');
        expect(chat).toContain('onSave={(id) => retention.saveMessage(id)}');
    });
    it('the coach mark is accessible: live region, Escape through the shared stack, never steals focus', () => {
        const c = read('components/SaveCoachMark.tsx');
        expect(c).toContain('role="status"');
        expect(c).toContain('aria-live="polite"');
        expect(c).toContain('useEscape(');
        expect(c).not.toMatch(/\.focus\(\)|autoFocus/);
    });
});
