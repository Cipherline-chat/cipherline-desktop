import { describe, it, expect, vi } from 'vitest';
import type { ServerStorageStatus, ServerStorageAudience, ServerStorageGraceState } from '@cipherline/shared';
import {
    buildStorageBannerModel,
    graceUrgency,
    daysLeftLabel,
    cancelServerStorageNotice,
    countOwnedServersOverFreeStorage,
    isOverFreeStorage,
    pruneSummaryText,
    recordNoticeDismissal,
    parseDismissedNoticeIds,
    storageNoticeDismissedKey,
    type StorageBannerAction,
} from './serverStorageGrace';

const MB = 1024 * 1024;
const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const DAY = 86_400_000;

function status(over: Partial<ServerStorageStatus> = {}): ServerStorageStatus {
    return {
        server_id: 'srv-1',
        audience: 'owner',
        state: 'ok',
        usage_bytes: 48 * MB,
        limit_bytes: 25 * MB,
        target_bytes: 25 * MB,
        pro_ends_at: null,
        grace_started_at: null,
        grace_deadline: null,
        days_left: null,
        transfer: null,
        prune_summary: null,
        resolved_reason: null,
        resolved_at: null,
        pruned_at: null,
        notice_id: null,
        dismissible: false,
        ...over,
    };
}

function grace(days: number, over: Partial<ServerStorageStatus> = {}): ServerStorageStatus {
    const deadline = new Date(NOW + days * DAY).toISOString();
    return status({
        state: 'grace',
        days_left: days,
        grace_deadline: deadline,
        grace_started_at: new Date(NOW - (60 - days) * DAY).toISOString(),
        notice_id: `grace:${deadline}`,
        transfer: { pro_member_count: 2, pro_member_ids: ['u-a', 'u-b'] },
        ...over,
    });
}

const pruned = (over: Partial<ServerStorageStatus> = {}) => status({
    state: 'pruned',
    pruned_at: '2026-10-10T09:00:00.000Z',
    notice_id: 'pruned:2026-10-10T09:00:00.000Z',
    dismissible: true,
    usage_bytes: 24 * MB,
    prune_summary: {
        emojis_deleted: 14, emoji_bytes: 6 * MB, saves_removed: 37, save_bytes: 18 * MB, pinned_removed: 3,
        messages_deleted: 20, messages_released: 17, files_deleted: 9, file_bytes: 12 * MB,
        usage_before_bytes: 48 * MB, usage_after_bytes: 24 * MB, limit_bytes: 25 * MB,
        started_at: '2026-10-10T08:59:00.000Z', completed_at: '2026-10-10T09:00:00.000Z',
    },
    ...over,
});

const resolved = (reason: ServerStorageStatus['resolved_reason'], over: Partial<ServerStorageStatus> = {}) => status({
    state: 'resolved',
    resolved_reason: reason,
    resolved_at: '2026-10-11T00:00:00.000Z',
    notice_id: 'resolved:2026-10-11T00:00:00.000Z',
    dismissible: true,
    ...over,
});

const pending = (over: Partial<ServerStorageStatus> = {}) => status({
    state: 'pending',
    pro_ends_at: '2026-10-30T00:00:00.000Z',
    notice_id: 'pending:2026-10-30T00:00:00.000Z',
    transfer: { pro_member_count: 0, pro_member_ids: [] },
    ...over,
});

const build = (s: ServerStorageStatus | null, dismissed: string[] = []) =>
    buildStorageBannerModel(s, 'Gamers', { nowMs: NOW, locale: 'en-US', dismissedIds: dismissed });

describe('graceUrgency — calm above 14 days, amber 14..4, red at 3 or fewer', () => {
    it.each([
        [60, 'calm'], [30, 'calm'], [15, 'calm'],
        [14, 'amber'], [7, 'amber'], [4, 'amber'],
        [3, 'red'], [1, 'red'], [0, 'red'],
    ] as const)('%i days -> %s', (d, tone) => {
        expect(graceUrgency(d)).toBe(tone);
    });
});

describe('daysLeftLabel', () => {
    it('pluralises and handles the deadline itself', () => {
        expect(daysLeftLabel(30)).toBe('30 days left');
        expect(daysLeftLabel(1)).toBe('1 day left');
        expect(daysLeftLabel(0)).toBe('Trimming soon');
    });
});

describe('buildStorageBannerModel — state x audience matrix', () => {
    type Row = [ServerStorageGraceState, ServerStorageAudience, StorageBannerAction[] | null];
    const rows: Row[] = [
        ['ok', 'owner', null], ['ok', 'manager', null], ['ok', 'member', null],
        ['pending', 'owner', ['keep_pro', 'learn_more']],
        ['pending', 'manager', null],
        ['pending', 'member', null],
        ['grace', 'owner', ['transfer', 'resubscribe', 'manage_storage']],
        ['grace', 'manager', ['manage_storage', 'learn_more']],
        ['grace', 'member', ['learn_more']],
        ['pruned', 'owner', ['learn_more']],
        ['pruned', 'manager', ['learn_more']],
        ['pruned', 'member', ['learn_more']],
        ['resolved', 'owner', []],
        ['resolved', 'manager', []],
        ['resolved', 'member', null],
    ];
    const make = (state: ServerStorageGraceState, audience: ServerStorageAudience): ServerStorageStatus => {
        const s = state === 'ok' ? status() : state === 'pending' ? pending() : state === 'grace' ? grace(20)
            : state === 'pruned' ? pruned() : resolved('under_limit');
        return { ...s, audience };
    };
    it.each(rows)('%s / %s -> %j', (state, audience, actions) => {
        const m = build(make(state, audience));
        if (actions === null) expect(m).toBeNull();
        else expect(m?.actions).toEqual(actions);
    });

    it('no billing buttons ever reach a manager or a member', () => {
        for (const state of ['pending', 'grace', 'pruned', 'resolved'] as const) {
            for (const audience of ['manager', 'member'] as const) {
                const acts = build(make(state, audience))?.actions ?? [];
                expect(acts).not.toContain('keep_pro');
                expect(acts).not.toContain('resubscribe');
                expect(acts).not.toContain('transfer');
            }
        }
    });

    it('a member never gets more than "Learn more"', () => {
        for (const state of ['grace', 'pruned'] as const) {
            expect(build(make(state, 'member'))?.actions).toEqual(['learn_more']);
        }
    });

    it('renders nothing without a notice id (defensive: nothing to key a dismissal on)', () => {
        expect(build(grace(10, { notice_id: null }))).toBeNull();
        expect(build(null)).toBeNull();
    });
});

describe('owner grace banner — urgency and copy', () => {
    it.each([[30, 'calm'], [7, 'amber'], [1, 'red']] as const)('%i days left is %s', (d, tone) => {
        const m = build(grace(d))!;
        expect(m.tone).toBe(tone);
        expect(m.lead).toBe(`${d} day${d === 1 ? '' : 's'} left:`);
        expect(m.text).toBe(`Gamers will be trimmed to 25 MB on ${new Date(NOW + d * DAY).toLocaleDateString('en-US', { dateStyle: 'medium' })}. Oldest emojis are removed first, then the oldest saved messages.`);
        expect(m.dismissible).toBe(false);
    });

    it('falls back to the deadline when days_left is missing', () => {
        const m = build(grace(5, { days_left: null }))!;
        expect(m.lead).toBe('5 days left:');
        expect(m.tone).toBe('amber');
    });

    it('flags "No members have Pro yet" when nobody can take it over', () => {
        expect(build(grace(30, { transfer: { pro_member_count: 0, pro_member_ids: [] } }))!.noProMembers).toBe(true);
        expect(build(grace(30))!.noProMembers).toBe(false);
    });

    it('the manager version is informational and urgency-scaled too', () => {
        const m = build({ ...grace(2), audience: 'manager', transfer: null })!;
        expect(m.tone).toBe('red');
        expect(m.text).toContain('unless the owner moves it to a Pro member');
    });

    it('the member line is neutral and names the date', () => {
        const m = build({ ...grace(6), audience: 'member', usage_bytes: null, limit_bytes: null, transfer: null })!;
        expect(m.tone).toBe('neutral');
        expect(m.lead).toBe('');
        expect(m.text).toMatch(/^Gamers is over its storage limit\. On Oct 18, 2026, its oldest custom emojis and saved messages will be removed to bring it back to 25 MB\.$/);
    });
});

describe('owner pending heads-up', () => {
    it('names the end date, the usage and the 60 days', () => {
        const m = build(pending())!;
        expect(m.lead).toBe('Your Pro plan ends Oct 30, 2026.');
        expect(m.text).toBe("Gamers uses 48 MB of storage, more than the free 25 MB. After Pro ends you'll have 60 days to transfer ownership to a Pro member, or it'll be trimmed to 25 MB.");
        expect(m.dismissible).toBe(false);
    });
    it('stays grammatical without a date or usage', () => {
        const m = build(pending({ pro_ends_at: null, usage_bytes: null }))!;
        expect(m.lead).toBe('Your Pro plan is ending.');
        expect(m.text.startsWith('Gamers uses more than the free 25 MB of storage.')).toBe(true);
    });
});

describe('pruned summary', () => {
    it('owner/manager: counts from prune_summary', () => {
        const m = build(pruned())!;
        expect(m.text).toBe('We trimmed Gamers to 25 MB on Oct 10, 2026: removed 14 emojis and 37 saved messages.');
        expect(m.dismissible).toBe(true);
        expect(m.tone).toBe('neutral');
    });
    it('singulars, and either half alone', () => {
        const base = pruned().prune_summary!;
        expect(pruneSummaryText(pruned({ prune_summary: { ...base, emojis_deleted: 1, saves_removed: 1 } }))).toBe('removed 1 emoji and 1 saved message');
        expect(pruneSummaryText(pruned({ prune_summary: { ...base, emojis_deleted: 0 } }))).toBe('removed 37 saved messages');
        expect(pruneSummaryText(pruned({ prune_summary: { ...base, emojis_deleted: 0, saves_removed: 0 } }))).toBeNull();
    });
    it('without a summary it still says what happened', () => {
        expect(build(pruned({ prune_summary: null }))!.text).toBe('We trimmed Gamers to 25 MB on Oct 10, 2026.');
    });
    it('members get the neutral wording (their payload has no counts)', () => {
        const m = build(pruned({ audience: 'member', prune_summary: null, usage_bytes: null }))!;
        expect(m.text).toBe('Gamers was trimmed to 25 MB on Oct 10, 2026. Some of its oldest custom emojis and saved messages were removed.');
    });
});

describe('resolved', () => {
    it.each([
        ['owner_pro', 'owner', "you have Pro again, so nothing in Gamers will be removed."],
        ['owner_pro', 'manager', 'the owner of Gamers has Pro again, so nothing will be removed.'],
        ['transfer_pro', 'owner', 'Gamers now belongs to a member with Pro, so nothing will be removed.'],
        ['under_limit', 'owner', 'Gamers is back under 25 MB, so nothing will be removed.'],
    ] as const)('%s (%s)', (reason, audience, text) => {
        const m = build(resolved(reason, { audience }))!;
        expect(m.lead).toBe("You're all set:");
        expect(m.text).toBe(text);
        expect(m.tone).toBe('ok');
        expect(m.dismissible).toBe(true);
    });
});

describe('dismissal', () => {
    it('hides a dismissed dismissible notice, by notice_id only', () => {
        const p = pruned();
        expect(build(p, [p.notice_id!])).toBeNull();
        expect(build(p, ['pruned:some-other-trim'])).not.toBeNull();
    });
    it('can never hide a running countdown or heads-up, even if its id is in the list', () => {
        const g = grace(2);
        expect(build(g, [g.notice_id!])).not.toBeNull();
        const pe = pending();
        expect(build(pe, [pe.notice_id!])).not.toBeNull();
    });
    it('a NEW grace (new notice id) is not hidden by an old dismissal', () => {
        const old = resolved('owner_pro');
        expect(build(resolved('owner_pro', { notice_id: 'resolved:2027-01-01T00:00:00.000Z' }), [old.notice_id!])).not.toBeNull();
    });
    it('the persisted list round-trips, dedupes, and is capped', () => {
        let ids: string[] = [];
        for (let i = 0; i < 60; i++) ids = recordNoticeDismissal(ids, `n${i}`);
        ids = recordNoticeDismissal(ids, 'n59');
        expect(ids).toHaveLength(50);
        expect(ids.at(-1)).toBe('n59');
        expect(parseDismissedNoticeIds(JSON.stringify(ids))).toEqual(ids);
        expect(parseDismissedNoticeIds('{not json')).toEqual([]);
        expect(storageNoticeDismissedKey('u1')).toBe('cipherline_storage_notice_dismissed_u1');
    });
});

describe('billing cancel confirmation line', () => {
    it('nothing when no owned server is over 25 MB', () => {
        expect(cancelServerStorageNotice(0)).toBeNull();
        expect(cancelServerStorageNotice(Number.NaN)).toBeNull();
    });
    it('singular and plural', () => {
        expect(cancelServerStorageNotice(1)).toBe("1 of your servers uses more than 25 MB. After Pro ends you'll have 60 days to transfer it to a Pro member before it's trimmed.");
        expect(cancelServerStorageNotice(3)).toBe("3 of your servers use more than 25 MB. After Pro ends you'll have 60 days to transfer them to a Pro member before they're trimmed.");
    });
    it('over = usage strictly above 25 MB', () => {
        expect(isOverFreeStorage(status({ usage_bytes: 25 * MB }))).toBe(false);
        expect(isOverFreeStorage(status({ usage_bytes: 25 * MB + 1 }))).toBe(true);
        expect(isOverFreeStorage(status({ usage_bytes: null }))).toBe(false);
        expect(isOverFreeStorage(null)).toBe(false);
    });

    it('fetches the status of OWNED servers only, and counts the ones over 25 MB', async () => {
        const getStatus = vi.fn(async (id: string) => status({
            server_id: id,
            usage_bytes: id === 'own-big' || id === 'own-big2' ? 40 * MB : 3 * MB,
        }));
        const progress: number[] = [];
        const n = await countOwnedServersOverFreeStorage({
            servers: [
                { server_id: 'own-big', owner_user_id: 'me' },
                { server_id: 'theirs', owner_user_id: 'someone' },
                { server_id: 'own-small', owner_user_id: 'me' },
                { server_id: 'own-big2', owner_user_id: 'me' },
            ],
            userId: 'me',
            getStatus,
            onProgress: c => progress.push(c),
        });
        expect(n).toBe(2);
        expect(getStatus.mock.calls.map(c => c[0])).toEqual(['own-big', 'own-small', 'own-big2']);
        expect(progress).toEqual([1, 2]);
    });

    it('a failed lookup counts as "not over" and does not stop the rest; cancellation stops early', async () => {
        let cancelled = false;
        const getStatus = vi.fn(async (id: string) => {
            if (id === 'a') throw new Error('429');
            cancelled = id === 'b';
            return status({ server_id: id, usage_bytes: 40 * MB });
        });
        const n = await countOwnedServersOverFreeStorage({
            servers: ['a', 'b', 'c'].map(id => ({ server_id: id, owner_user_id: 'me' })),
            userId: 'me', getStatus, isCancelled: () => cancelled,
        });
        expect(n).toBe(1);
        expect(getStatus).toHaveBeenCalledTimes(2);
    });
});
