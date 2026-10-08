import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    unsaveChannelMessage,
    unpinChannelMessage,
    classifyRemoveFailure,
    SAVE_REQUEST_TIMEOUT_MS,
    type ChannelSaveActionDeps,
} from './channelSaveActions';

// channelServerSaves (imported by the module under test) imports axios; the
// real one touches `location.href` at module load in this environment.
vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const API = 'https://api.example/v1';
const CH = 'chan-1';
const MSG = '11111111-2222-3333-4444-555555555555';   // a SERVER row id

/** In-memory stand-in for Dashboard's channelServerSaves / channelPinnedIds. */
function harness(initial: { saved: string[]; pinned: string[] }, respond: () => Promise<unknown>) {
    const state = { saved: { [CH]: [...initial.saved] } as Record<string, string[]>, pinned: { [CH]: [...initial.pinned] } as Record<string, string[]> };
    const calls: Array<{ url: string; config: { headers: Record<string, string>; timeout: number } }> = [];
    const notices: string[] = [];
    /** What the user sees right after the optimistic update, before the server answers. */
    let optimistic: { saved: string[]; pinned: string[] } | null = null;
    const deps: ChannelSaveActionDeps = {
        apiBase: API,
        token: 'tok',
        http: {
            delete: vi.fn(async (url: string, config: { headers: Record<string, string>; timeout: number }) => {
                calls.push({ url, config });
                optimistic = { saved: [...state.saved[CH]], pinned: [...state.pinned[CH]] };
                return respond();
            }),
        },
        updateSaved: (cid, f) => { state.saved[cid] = f(state.saved[cid]); },
        updatePinned: (cid, f) => { state.pinned[cid] = f(state.pinned[cid]); },
        notify: (m) => { notices.push(m); },
    };
    return { deps, state, calls, notices, optimistic: () => optimistic };
}

const ok = () => Promise.resolve({ data: { ok: true } });
const httpError = (status: number, code?: string) => () =>
    Promise.reject(Object.assign(new Error(`HTTP ${status}`), { response: { status, data: code ? { code } : {} } }));

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });

describe('Remove from server (unsave)', () => {
    it('DELETEs /channels/:cid/saves/:mid with the message id, auth and a timeout', async () => {
        const h = harness({ saved: [MSG], pinned: [] }, ok);
        expect(await unsaveChannelMessage(h.deps, CH, MSG)).toBe('ok');
        expect(h.calls).toEqual([{
            url: `${API}/channels/${CH}/saves/${MSG}`,
            config: { headers: { Authorization: 'Bearer tok' }, timeout: SAVE_REQUEST_TIMEOUT_MS },
        }]);
        expect(h.state.saved[CH]).toEqual([]);
    });

    it('is optimistic: the save is gone before the server answers', async () => {
        const h = harness({ saved: [MSG, 'other'], pinned: [] }, ok);
        await unsaveChannelMessage(h.deps, CH, MSG);
        expect(h.optimistic()).toEqual({ saved: ['other'], pinned: [] });
    });

    it('POSITIVE CONTROL: a real failure (500) rolls the save back and tells the user', async () => {
        const h = harness({ saved: [MSG], pinned: [] }, httpError(500));
        expect(await unsaveChannelMessage(h.deps, CH, MSG)).toBe('failed');
        expect(h.state.saved[CH]).toEqual([MSG]);
        expect(h.notices).toHaveLength(1);
    });

    it('a 404 (the server has no save) KEEPS the removal — it used to roll back, so the icon could never be cleared', async () => {
        const h = harness({ saved: [MSG], pinned: [] }, httpError(404));
        expect(await unsaveChannelMessage(h.deps, CH, MSG)).toBe('already-gone');
        expect(h.state.saved[CH]).toEqual([]);
        expect(h.notices).toEqual([]);
    });

    it('a timeout (request hung) rolls back rather than leaving the optimistic state up forever', async () => {
        const h = harness({ saved: [MSG], pinned: [] }, () => Promise.reject(Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED' })));
        expect(await unsaveChannelMessage(h.deps, CH, MSG)).toBe('failed');
        expect(h.state.saved[CH]).toEqual([MSG]);
    });

    it('409 MESSAGE_PINNED (pinned meanwhile): rolls back, shows it pinned, says "unpin first"', async () => {
        const h = harness({ saved: [MSG], pinned: [] }, httpError(409, 'MESSAGE_PINNED'));
        expect(await unsaveChannelMessage(h.deps, CH, MSG)).toBe('pinned');
        expect(h.state.saved[CH]).toEqual([MSG]);
        expect(h.state.pinned[CH]).toEqual([MSG]);
        expect(h.notices[0]).toMatch(/pinned.*Unpin it first/i);
    });

    it('403 (no SAVE_MESSAGES): rolls back and says so', async () => {
        const h = harness({ saved: [MSG], pinned: [] }, httpError(403));
        expect(await unsaveChannelMessage(h.deps, CH, MSG)).toBe('forbidden');
        expect(h.state.saved[CH]).toEqual([MSG]);
        expect(h.notices[0]).toMatch(/permission/i);
    });
});

describe('Unpin (server channel)', () => {
    it('DELETEs /channels/:cid/pins/:mid and KEEPS the save (owner rule: unpin keeps the save)', async () => {
        const h = harness({ saved: [MSG], pinned: [MSG] }, ok);
        expect(await unpinChannelMessage(h.deps, CH, MSG)).toBe('ok');
        expect(h.calls[0].url).toBe(`${API}/channels/${CH}/pins/${MSG}`);
        expect(h.calls[0].config.headers).toEqual({ Authorization: 'Bearer tok' });
        expect(h.optimistic()).toEqual({ saved: [MSG], pinned: [] });
        expect(h.state).toEqual({ saved: { [CH]: [MSG] }, pinned: { [CH]: [] } });
    });

    it('POSITIVE CONTROL: a 500 rolls the pin back and tells the user', async () => {
        const h = harness({ saved: [MSG], pinned: [MSG] }, httpError(500));
        expect(await unpinChannelMessage(h.deps, CH, MSG)).toBe('failed');
        expect(h.state.pinned[CH]).toEqual([MSG]);
        expect(h.notices).toHaveLength(1);
    });

    it('a 404 ("Message is not pinned") keeps it unpinned instead of resurrecting the pin', async () => {
        const h = harness({ saved: [MSG], pinned: [MSG] }, httpError(404));
        expect(await unpinChannelMessage(h.deps, CH, MSG)).toBe('already-gone');
        expect(h.state.pinned[CH]).toEqual([]);
        expect(h.state.saved[CH]).toEqual([MSG]);
    });

    it('403 (no MANAGE_MESSAGES): rolls back and says so', async () => {
        const h = harness({ saved: [MSG], pinned: [MSG] }, httpError(403));
        expect(await unpinChannelMessage(h.deps, CH, MSG)).toBe('forbidden');
        expect(h.state.pinned[CH]).toEqual([MSG]);
        expect(h.notices[0]).toMatch(/permission/i);
    });
});

describe('classifyRemoveFailure', () => {
    it('maps the server answers', () => {
        expect(classifyRemoveFailure({ response: { status: 409, data: { code: 'MESSAGE_PINNED' } } })).toBe('pinned');
        expect(classifyRemoveFailure({ response: { status: 404, data: {} } })).toBe('already-gone');
        expect(classifyRemoveFailure({ response: { status: 403 } })).toBe('forbidden');
        expect(classifyRemoveFailure({ response: { status: 429 } })).toBe('failed');
        expect(classifyRemoveFailure(new Error('network'))).toBe('failed');
        expect(classifyRemoveFailure(undefined)).toBe('failed');
    });
});
