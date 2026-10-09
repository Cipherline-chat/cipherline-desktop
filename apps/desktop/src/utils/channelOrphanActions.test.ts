import { describe, it, expect } from 'vitest';
import { findOrphanActions, addOrphans, readyOrphans, applyOrphans, actionTargetId, MAX_ORPHANS_PER_CHANNEL } from './channelOrphanActions';
import { foldChannelHistory, type ChannelRow } from './channelHistoryMerge';

const at = (s: number) => new Date(Date.parse('2026-10-01T00:00:00Z') + s * 1000).toISOString();
const msg = (id: string, s: number, text = id): ChannelRow => ({ id, timestamp: at(s), content: { type: 'text', text }, sender_user_id: 'u1' });
const edit = (id: string, s: number, target: string, text: string): ChannelRow => ({ id, timestamp: at(s), content: { type: 'edit', target_id: target, text }, sender_user_id: 'u1' });
const del = (id: string, s: number, target: string): ChannelRow => ({ id, timestamp: at(s), content: { type: 'delete', target_id: target }, sender_user_id: 'u1' });
const react = (id: string, s: number, target: string, emoji: string, action: 'add' | 'remove', who = 'u2'): ChannelRow =>
    ({ id, timestamp: at(s), content: { type: 'reaction', target_id: target, emoji, action }, sender_user_id: who });

/** One ingest step, as Dashboard.ingestChannelRows composes it. */
function ingest(cache: ChannelRow[], pending: ChannelRow[], incoming: ChannelRow[]) {
    const next = addOrphans(pending, findOrphanActions(cache, incoming));
    const { ready, waiting } = readyOrphans(next, [...cache, ...incoming]);
    return { cache: applyOrphans(foldChannelHistory(cache, incoming), ready), pending: waiting };
}

describe('orphan actions — edits/deletes/reactions that arrive before their target', () => {
    it('actionTargetId recognises only the three action types', () => {
        expect(actionTargetId(edit('e', 1, 't', 'x'))).toBe('t');
        expect(actionTargetId(msg('m', 1))).toBeNull();
        expect(actionTargetId({ id: 'x', timestamp: at(1), content: { type: 'system', target_id: 't' } })).toBeNull();
    });

    it('an action whose target is cached, or arrives in the same batch, is NOT an orphan', () => {
        expect(findOrphanActions([msg('t', 1)], [edit('e', 2, 't', 'x')])).toEqual([]);
        expect(findOrphanActions([], [msg('t', 1), edit('e', 2, 't', 'x')])).toEqual([]);
        // target matched by client_msg_id (own instantly-sent row)
        const own: ChannelRow = { id: 'local', timestamp: at(1), content: { type: 'text', text: 'a', client_msg_id: 'c1' } };
        expect(findOrphanActions([own], [edit('e', 2, 'c1', 'x')])).toEqual([]);
    });

    it('edit in the newest page, target loaded by a later (older) page → edited text', () => {
        let s = ingest([msg('n1', 100)], [], [edit('e1', 101, 'old', 'edited')]);
        expect(s.pending.map(p => p.id)).toEqual(['e1']);
        s = ingest(s.cache, s.pending, [msg('old', 5, 'original')]);
        expect(s.cache.find(m => m.id === 'old')?.content.text).toBe('edited');
        expect(s.cache.find(m => m.id === 'old')?.edited).toBe(true);
        expect(s.pending).toEqual([]);
    });

    it('control: the plain fold alone drops the edit and shows the original text', () => {
        const a = foldChannelHistory([msg('n1', 100)], [edit('e1', 101, 'old', 'edited')]);
        const b = foldChannelHistory(a, [msg('old', 5, 'original')]);
        expect(b.find(m => m.id === 'old')?.content.text).toBe('original');
    });

    it('a delete for an unloaded message removes it when it arrives (it must not come back)', () => {
        let s = ingest([], [], [del('d1', 200, 'gone')]);
        s = ingest(s.cache, s.pending, [msg('gone', 3), msg('kept', 4)]);
        expect(s.cache.map(m => m.id)).toEqual(['kept']);
    });

    it('reactions replay in order (add then remove nets to nothing; add stays)', () => {
        let s = ingest([], [], [react('r1', 50, 't', '👍', 'add'), react('r2', 51, 't', '👍', 'remove'), react('r3', 52, 't', '🎉', 'add')]);
        s = ingest(s.cache, s.pending, [msg('t', 1)]);
        expect(s.cache[0].reactions).toEqual({ '🎉': ['u2'] });
    });

    it('later edits win: two orphan edits apply oldest-first', () => {
        let s = ingest([], [], [edit('e2', 30, 't', 'second'), edit('e1', 20, 't', 'first')]);
        s = ingest(s.cache, s.pending, [msg('t', 1)]);
        expect(s.cache[0].content.text).toBe('second');
    });

    it('a pending action is applied exactly once (no re-application on a later ingest)', () => {
        let s = ingest([], [], [edit('e1', 20, 't', 'from orphan')]);
        s = ingest(s.cache, s.pending, [msg('t', 1)]);
        // a newer live edit lands normally afterwards …
        s = { cache: foldChannelHistory(s.cache, [edit('e9', 90, 't', 'newest')]), pending: s.pending };
        // … and another ingest must not resurrect the old orphan's text
        s = ingest(s.cache, s.pending, [msg('x', 95)]);
        expect(s.cache.find(m => m.id === 't')?.content.text).toBe('newest');
    });

    it('addOrphans dedupes by id and keeps the newest MAX_ORPHANS_PER_CHANNEL', () => {
        const many = Array.from({ length: MAX_ORPHANS_PER_CHANNEL + 10 }, (_, i) => edit(`e${i}`, i, `t${i}`, 'x'));
        const kept = addOrphans([], many);
        expect(kept).toHaveLength(MAX_ORPHANS_PER_CHANNEL);
        expect(kept[0].id).toBe('e10');
        expect(addOrphans(kept, [many[many.length - 1]])).toHaveLength(MAX_ORPHANS_PER_CHANNEL);
    });
});
