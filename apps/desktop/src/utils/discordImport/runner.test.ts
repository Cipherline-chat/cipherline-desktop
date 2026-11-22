import { describe, it, expect, vi } from 'vitest';
import { ImportAborted, newRunState, runStructureImport, type RunInput, type RunnerDeps } from './runner';
import type { GuildSnapshot } from './types';

const b64 = (s: string) => btoa(s);

const snapshot = (over: Partial<GuildSnapshot> = {}): GuildSnapshot => ({
    guild: { id: '1', name: 'Pixel Farm', description: 'About', hasIcon: true, hasBanner: true },
    body: { name: 'Pixel Farm', roles: [], channels: [] },
    emojis: [
        { id: 'e1', name: 'party_parrot', animated: true },
        { id: 'e2', name: 'Tractor', animated: false },
        { id: 'e3', name: 'tractor', animated: false }, // collides after lower-casing
    ],
    counts: { roles: 0, categories: 0, channels: 0, emojis: 3 },
    notMapped: [],
    ...over,
});
const input = (over: Partial<RunInput> = {}): RunInput => ({
    snapshot: snapshot(), serverName: 'Pixel Farm', description: 'About', includeImages: true, includeEmojis: true, ...over,
});

function mkDeps(over: Partial<RunnerDeps> = {}) {
    const log: string[] = [];
    let up = 0;
    const deps: RunnerDeps = {
        fetchImage: vi.fn(async (r) => { log.push(`fetch:${r.kind}${r.emojiId ? ':' + r.emojiId : ''}`); return { ok: true as const, mime: 'image/png', dataB64: b64('PNGDATA') }; }),
        prepareImage: vi.fn(async (blob) => ({ blob, mime: 'image/jpeg' })),
        upload: vi.fn(async (_b, _m, o) => { log.push(`upload${o?.serverId ? ':emoji' : ''}`); up++; return { attachmentId: `att-${up}`, keyB64: `key-${up}`, nonceB64: `non-${up}` }; }),
        importGuild: vi.fn(async (r) => { log.push('import'); void r; return { server_id: 'srv-1', name: 'Pixel Farm' }; }),
        listEmojiNames: vi.fn(async () => []),
        createEmoji: vi.fn(async (_s, b) => { log.push(`emoji:${b.name}`); }),
        sleep: vi.fn(async () => undefined),
        ...over,
    };
    return { deps, log };
}
const run = (deps: RunnerDeps, inp = input(), state = newRunState(), signal = new AbortController().signal) =>
    runStructureImport(deps, inp, state, () => undefined, signal);

describe('runStructureImport', () => {
    it('order: images -> one server call (with icon+banner) -> emojis', async () => {
        const { deps, log } = mkDeps();
        const r = await run(deps);
        expect(log).toEqual(['fetch:icon', 'upload', 'fetch:banner', 'upload', 'import',
            'fetch:emoji:e1', 'upload:emoji', 'emoji:party_parrot',
            'fetch:emoji:e2', 'upload:emoji', 'emoji:tractor',
            'fetch:emoji:e3', 'upload:emoji', 'emoji:tractor_2']);
        const req = (deps.importGuild as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(req).toMatchObject({ name: 'Pixel Farm', description: 'About', icon_attachment: 'att-1', banner_attachment: 'att-2' });
        expect(r).toMatchObject({ serverId: 'srv-1', iconDone: true, bannerDone: true, emojisAdded: 3, cancelled: false });
    });

    it('images off: nothing fetched for them and no icon/banner fields sent', async () => {
        const { deps, log } = mkDeps();
        await run(deps, input({ includeImages: false, includeEmojis: false }));
        expect(log).toEqual(['import']);
        expect((deps.importGuild as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty('icon_attachment');
    });

    it('a failed icon never blocks the server; it is reported', async () => {
        const { deps } = mkDeps({
            fetchImage: vi.fn(async (r) => r.kind === 'icon' ? { ok: false as const, message: 'not found' } : { ok: true as const, mime: 'image/png', dataB64: b64('x') }),
        });
        const r = await run(deps, input({ includeEmojis: false }));
        expect(r.iconDone).toBe(false);
        expect(r.bannerDone).toBe(true);
        expect(r.notes.join(' ')).toMatch(/icon could not be copied/);
        expect(r.serverId).toBe('srv-1');
    });

    it('server create fails -> retry re-uses the uploaded images (no second upload)', async () => {
        const { deps } = mkDeps();
        (deps.importGuild as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
        const state = newRunState();
        await expect(run(deps, input({ includeEmojis: false }), state)).rejects.toThrow('boom');
        expect(deps.upload).toHaveBeenCalledTimes(2);
        const r = await run(deps, input({ includeEmojis: false }), state);
        expect(deps.upload).toHaveBeenCalledTimes(2); // not re-uploaded
        expect(r.serverId).toBe('srv-1');
        expect((deps.importGuild as ReturnType<typeof vi.fn>).mock.calls[1][0]).toMatchObject({ icon_attachment: 'att-1', banner_attachment: 'att-2' });
    });

    it('retry after the server exists NEVER creates another one, and does not re-upload finished emojis', async () => {
        const { deps } = mkDeps();
        const state = newRunState();
        (deps.createEmoji as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(undefined);
        const first = await run(deps, input(), state);
        expect(first.emojisAdded).toBe(2);
        expect(first.emojisSkipped).toHaveLength(1);
        const again = await run(deps, input(), state);
        expect(deps.importGuild).toHaveBeenCalledTimes(1);
        expect(again.emojisAdded).toBe(3);
        expect(deps.createEmoji).toHaveBeenCalledTimes(4); // 3 first run + only the one that failed
    });

    it('emojis already on the server by name (answer lost last time) count as done', async () => {
        const { deps } = mkDeps({ listEmojiNames: vi.fn(async () => ['party_parrot']) });
        const r = await run(deps, input({ snapshot: snapshot({ emojis: [{ id: 'e1', name: 'party_parrot', animated: true }] }) }));
        expect(deps.createEmoji).not.toHaveBeenCalled();
        expect(r.emojisAdded).toBe(1);
    });

    it('a 429 waits Retry-After and retries the same emoji', async () => {
        const { deps } = mkDeps();
        const e429 = { response: { status: 429, headers: { 'retry-after': '4' } } };
        (deps.createEmoji as ReturnType<typeof vi.fn>).mockRejectedValueOnce(e429);
        const r = await run(deps, input({ snapshot: snapshot({ emojis: [{ id: 'e1', name: 'party_parrot', animated: true }] }) }));
        expect(deps.sleep).toHaveBeenCalledWith(4000);
        expect(r.emojisAdded).toBe(1);
    });

    it('emojis are paced under the import path\'s 90/min bucket (700 ms gap, ~86/min); 200 emojis ~2.3 min of gaps instead of ~10.3', async () => {
        const many = Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, name: `emoji_${i}`, animated: false }));
        const { deps } = mkDeps();
        await run(deps, input({ snapshot: snapshot({ emojis: many }) }));
        const gaps = (deps.sleep as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[0] === 700);
        expect(gaps).toHaveLength(11);
        expect(60_000 / 700).toBeLessThan(90); // stays under importEmoji
    });

    it('an older API\'s 429 on the interactive bucket is waited out (retry-after), not fatal', async () => {
        const { deps } = mkDeps();
        (deps.createEmoji as ReturnType<typeof vi.fn>).mockRejectedValueOnce({ response: { status: 429, headers: { 'retry-after': '30' }, data: {} } });
        const r = await run(deps);
        expect(r.emojisAdded).toBe(3);
    });

    it('server out of storage: remaining emojis are skipped with the reason, the server stays', async () => {
        const { deps } = mkDeps();
        (deps.createEmoji as ReturnType<typeof vi.fn>).mockRejectedValueOnce({ response: { data: { code: 'SERVER_STORAGE_QUOTA_EXCEEDED' } } });
        const r = await run(deps);
        // whichever code the copy helper recognises, nothing throws and the report is complete
        expect(r.emojisAdded + r.emojisSkipped.length).toBe(3);
        expect(r.serverId).toBe('srv-1');
    });

    it('an image over the cap, or a failed fetch, is skipped and reported', async () => {
        const { deps } = mkDeps({
            fetchImage: vi.fn(async (r) => r.emojiId === 'e1'
                ? { ok: false as const, message: 'Image is too large.' }
                : { ok: true as const, mime: 'image/png', dataB64: b64('x') }),
        });
        const r = await run(deps);
        expect(r.emojisSkipped).toEqual([{ name: 'party_parrot', reason: 'Image is too large.' }]);
        expect(r.emojisAdded).toBe(2);
    });

    it('cancel during emojis stops further work and KEEPS the server (never deletes)', async () => {
        const ctl = new AbortController();
        const { deps } = mkDeps();
        (deps.createEmoji as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { ctl.abort(); });
        const r = await run(deps, input(), newRunState(), ctl.signal);
        expect(r.cancelled).toBe(true);
        expect(r.serverId).toBe('srv-1');
        expect(deps.createEmoji).toHaveBeenCalledTimes(1);
    });

    it('cancel before the server exists throws ImportAborted and creates nothing', async () => {
        const ctl = new AbortController();
        ctl.abort();
        const { deps } = mkDeps();
        await expect(run(deps, input(), newRunState(), ctl.signal)).rejects.toBeInstanceOf(ImportAborted);
        expect(deps.importGuild).not.toHaveBeenCalled();
    });

    it('progress reports images, server, emojis in order', async () => {
        const { deps } = mkDeps();
        const steps: string[] = [];
        await runStructureImport(deps, input(), newRunState(), p => { if (steps[steps.length - 1] !== p.step) steps.push(p.step); }, new AbortController().signal);
        expect(steps).toEqual(['images', 'server', 'emojis', 'done']);
    });

    it('people (D5b): members and bans go with the ONE server call, and the report says what was saved', async () => {
        const { deps } = mkDeps({
            importGuild: vi.fn(async () => ({ server_id: 'srv-1', name: 'Pixel Farm', member_grants: { status: 'saved' as const, people: 3, roles: 4, overrides: 1, nicknames: 1, bans: 1 } })),
        });
        const members = [{ id: '900000000000000001', ref: 1, roles: [2, 3], nick: 'Sammy' }, { id: '900000000000000002', ref: 2, roles: [2] }];
        const bans = [{ id: '900000000000000066', reason: 'Spam' }];
        const r = await run(deps, input({ includeImages: false, includeEmojis: false, snapshot: snapshot({ members, bans }) }));
        const req = (deps.importGuild as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(req.members).toEqual(members);
        expect(req.bans).toEqual(bans);
        expect(req.guild).toEqual({ name: 'Pixel Farm', roles: [], channels: [] }); // the body never carries people
        expect(r.people).toMatchObject({ status: 'saved', people: 3 });
        expect(r.notes.join(' ')).toMatch(/Saved for 3 people \(4 roles, 1 channel permission, 1 nickname, 1 ban\)/);
    });

    it('an older API that refuses the people fields: the server is still built, without them, and the report says so', async () => {
        const calls: unknown[] = [];
        const { deps } = mkDeps({
            importGuild: vi.fn(async (r) => {
                calls.push({ ...r });
                if ('members' in r) throw { response: { status: 400, data: { message: ['property members should not exist'] } } };
                return { server_id: 'srv-1', name: 'Pixel Farm' };
            }),
        });
        const r = await run(deps, input({ includeImages: false, includeEmojis: false, snapshot: snapshot({ members: [{ id: '900000000000000001', ref: 1, roles: [2] }] }) }));
        expect(calls).toHaveLength(2);
        expect(r.serverId).toBe('srv-1');
        expect(r.notes.join(' ')).toMatch(/could not be carried over/);
    });

    it('any OTHER 400 is not retried without the people', async () => {
        const { deps } = mkDeps({
            importGuild: vi.fn(async () => { throw { response: { status: 400, data: { message: ['name must be plain text'] } } }; }),
        });
        await expect(run(deps, input({ includeImages: false, includeEmojis: false, snapshot: snapshot({ members: [{ id: '900000000000000001', ref: 1, roles: [2] }] }) })))
            .rejects.toMatchObject({ response: { status: 400 } });
        expect(deps.importGuild).toHaveBeenCalledTimes(1);
    });
});

describe('runStructureImport: stickers', () => {
    const quiet = { includeImages: false, includeEmojis: false };
    const STICKERS = [
        { id: '800000000000000060', name: 'wave_hello', description: 'Hi!', tags: ['wave'], animated: false },
        { id: '800000000000000061', name: 'party', tags: [], animated: true },
    ];
    const withStickers = () => snapshot({ stickers: STICKERS });

    it('each guild sticker is fetched by id and created as a server sticker (import route), paced under importSticker; the map is kept for the history import', async () => {
        const made: unknown[] = [];
        const { deps } = mkDeps({
            createSticker: vi.fn(async (_sid, s) => { made.push({ name: s.name, description: s.description, tags: s.tags, bytes: s.bytes.length }); return { sticker_id: `stk-${made.length}`, name: s.name }; }),
        });
        const state = newRunState();
        const r = await run(deps, input({ ...quiet, snapshot: withStickers() }), state);
        expect((deps.fetchImage as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])).toEqual([{ kind: 'sticker', stickerId: '800000000000000060' }, { kind: 'sticker', stickerId: '800000000000000061' }]);
        expect(made).toEqual([{ name: 'wave_hello', description: 'Hi!', tags: ['wave'], bytes: 7 }, { name: 'party', description: undefined, tags: undefined, bytes: 7 }]);
        expect(deps.sleep).toHaveBeenCalledWith(1050);
        expect(r.stickersAdded).toBe(2);
        expect(state.stickerRefs).toEqual({ '800000000000000060': { id: 'stk-1', name: 'wave_hello' }, '800000000000000061': { id: 'stk-2', name: 'party' } });
    });

    it('a retry never creates a sticker twice; out of storage stops the rest with the reason', async () => {
        const { deps } = mkDeps({ createSticker: vi.fn(async (_sid, s) => ({ sticker_id: `stk-${s.name}`, name: s.name })) });
        const state = newRunState();
        await run(deps, input({ ...quiet, snapshot: withStickers() }), state);
        await run(deps, input({ ...quiet, snapshot: withStickers() }), state);
        expect(deps.createSticker).toHaveBeenCalledTimes(2);

        const q = mkDeps({ createSticker: vi.fn(async () => { throw { response: { status: 413, data: { code: 'STORAGE_QUOTA_EXCEEDED' } } }; }) });
        const r = await run(q.deps, input({ ...quiet, snapshot: withStickers() }));
        expect(r.stickersAdded).toBe(0);
        expect(r.notes.join(' ')).toMatch(/2 stickers not copied/);
    });

    it('stickers off, or an older host: nothing fetched (the host case is reported)', async () => {
        const off = mkDeps({ createSticker: vi.fn() });
        await run(off.deps, input({ ...quiet, includeStickers: false, snapshot: withStickers() }));
        expect(off.deps.fetchImage).not.toHaveBeenCalled();
        const old = mkDeps();
        const r = await run(old.deps, input({ ...quiet, snapshot: withStickers() }));
        expect(old.deps.fetchImage).not.toHaveBeenCalled();
        expect(r.notes.join(' ')).toMatch(/2 stickers could not be copied by this version/);
    });
});

describe('runStructureImport: final mapping pass', () => {
    const quiet = { includeImages: false, includeEmojis: false };
    const roles = [{ id: 0, name: '@everyone' }, { id: 1, name: 'Farmhand' }, { id: 2, name: 'Moderator' }, { id: 3, name: 'Owner' }];
    const withIcons = (over: Partial<GuildSnapshot> = {}) => snapshot({ body: { name: 'Pixel Farm', roles, channels: [] }, roleIcons: [2, 3], ...over });
    const refs = { 'r:0': 'role-0', 'r:1': 'role-1', 'r:2': 'role-2', 'r:3': 'role-3' };

    it('role icon pictures: fetched by role number and set on the role the server created, paced under the roleIcon bucket', async () => {
        const set: string[] = [];
        const { deps } = mkDeps({
            importGuild: vi.fn(async () => ({ server_id: 'srv-1', name: 'Pixel Farm', role_refs: refs })),
            setRoleIcon: vi.fn(async (sid, rid, blob, mime) => { set.push(`${sid}/${rid}/${mime}/${blob.size}`); }),
        });
        const r = await run(deps, input({ ...quiet, snapshot: withIcons() }));
        expect((deps.fetchImage as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])).toEqual([{ kind: 'role_icon', role: 2 }, { kind: 'role_icon', role: 3 }]);
        expect(set).toEqual(['srv-1/role-2/image/png/7', 'srv-1/role-3/image/png/7']);
        expect(deps.sleep).toHaveBeenCalledWith(2100);
        expect(r.roleIconsAdded).toBe(2);
    });

    it('a 429 waits retry-after and retries the same role; another failure is reported, the import goes on', async () => {
        let n = 0;
        const { deps } = mkDeps({
            importGuild: vi.fn(async () => ({ server_id: 'srv-1', name: 'Pixel Farm', role_refs: refs })),
            setRoleIcon: vi.fn(async (_s, rid) => {
                n++;
                if (n === 1) throw { response: { status: 429, headers: { 'retry-after': '2' }, data: {} } };
                if (rid === 'role-3') throw { response: { status: 403, data: { message: 'Missing Manage Roles' } } };
            }),
        });
        const r = await run(deps, input({ ...quiet, snapshot: withIcons() }));
        expect(deps.setRoleIcon).toHaveBeenCalledTimes(3);
        expect(r.roleIconsAdded).toBe(1);
        expect(r.notes.join(' ')).toMatch(/The icon of “Owner” could not be copied \(Missing Manage Roles\)/);
        expect(r.serverId).toBe('srv-1');
    });

    it('a retry does not upload a role icon twice', async () => {
        const { deps } = mkDeps({
            importGuild: vi.fn(async () => ({ server_id: 'srv-1', name: 'Pixel Farm', role_refs: refs })),
            setRoleIcon: vi.fn(async () => undefined),
        });
        const state = newRunState();
        await run(deps, input({ ...quiet, snapshot: withIcons() }), state);
        await run(deps, input({ ...quiet, snapshot: withIcons() }), state);
        expect(deps.setRoleIcon).toHaveBeenCalledTimes(2);
        expect(deps.importGuild).toHaveBeenCalledTimes(1);
    });

    it('an older host without setRoleIcon: reported, nothing fetched', async () => {
        const { deps } = mkDeps({ importGuild: vi.fn(async () => ({ server_id: 'srv-1', name: 'Pixel Farm', role_refs: refs })) });
        const r = await run(deps, input({ ...quiet, snapshot: withIcons() }));
        expect(deps.fetchImage).not.toHaveBeenCalled();
        expect(r.notes.join(' ')).toMatch(/2 role icon pictures could not be copied/);
    });

    it('slowmode / age-restricted not set (API database without the columns): one note, only when the guild had any', async () => {
        const chans = { name: 'Pixel Farm', roles: [], channels: [{ id: 1, nsfw: true }, { id: 2, rate_limit_per_user: 30 }, { id: 3 }] };
        const { deps } = mkDeps({ importGuild: vi.fn(async () => ({ server_id: 'srv-1', name: 'Pixel Farm', channel_settings: 'unavailable' as const })) });
        const r = await run(deps, input({ ...quiet, snapshot: snapshot({ body: chans }) }));
        expect(r.notes.join(' ')).toMatch(/Slowmode and age-restricted settings of 2 channels could not be set/);
        const ok = mkDeps({ importGuild: vi.fn(async () => ({ server_id: 'srv-1', name: 'Pixel Farm', channel_settings: 'applied' as const })) });
        const r2 = await run(ok.deps, input({ ...quiet, snapshot: snapshot({ body: chans }) }));
        expect(r2.notes.join(' ')).not.toMatch(/Slowmode/);
    });

    it('member since: join days go with the members; the report counts them', async () => {
        const members = [{ id: '900000000000000001', ref: 1, roles: [2], joined_at: '2019-04-02' }, { id: '900000000000000002', ref: 2, roles: [], joined_at: '2020-01-01' }];
        const { deps } = mkDeps({
            importGuild: vi.fn(async () => ({ server_id: 'srv-1', name: 'Pixel Farm', member_grants: { status: 'saved' as const, people: 2, roles: 1, overrides: 0, nicknames: 0, bans: 0, member_since: 2 } })),
        });
        const r = await run(deps, input({ ...quiet, snapshot: snapshot({ members }) }));
        expect((deps.importGuild as ReturnType<typeof vi.fn>).mock.calls[0][0].members).toEqual(members);
        expect(r.notes.join(' ')).toMatch(/Saved for 2 people \(1 role, 2 “member since” dates\)/);
    });

    it('an API with the people fields but not the join day: retried with the roles kept and only the days dropped', async () => {
        const calls: Array<{ members?: unknown[] }> = [];
        const { deps } = mkDeps({
            importGuild: vi.fn(async (r) => {
                calls.push(structuredClone(r));
                if (r.members?.some((m: object) => 'joined_at' in m)) throw { response: { status: 400, data: { message: ['members.0.property joined_at should not exist'] } } };
                return { server_id: 'srv-1', name: 'Pixel Farm' };
            }),
        });
        const members = [{ id: '900000000000000001', ref: 1, roles: [2], nick: 'Sammy', joined_at: '2019-04-02' }];
        const r = await run(deps, input({ ...quiet, snapshot: snapshot({ members }) }));
        expect(calls).toHaveLength(2);
        expect(calls[1].members).toEqual([{ id: '900000000000000001', ref: 1, roles: [2], nick: 'Sammy' }]);
        expect(r.notes.join(' ')).toMatch(/“Member since” dates could not be carried over/);
        expect(r.serverId).toBe('srv-1');
    });
});
