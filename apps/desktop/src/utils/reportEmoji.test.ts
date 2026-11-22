import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.fn();
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => post(...a) } }));

const {
    REPORT_PERSONAL_EMOJI_MAX, REPORT_PERSONAL_EMOJI_MAX_BYTES, collectPersonalEmojiEvidence, reportEmojiTokens,
    reportableEmojiTokens, uploadReportPersonalEmoji,
} = await import('./reportEmoji');
const { personalEmojiIdFromBytes } = await import('./personalEmoji/token');

const SRV = '0f1e2d3c-4b5a-4968-8776-655443322110';
const png = (n: number, len = 16) => { const b = new Uint8Array(len); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); b[8] = n; b[9] = n >> 8; return b; };
async function fixture(n: number, len?: number) { const bytes = png(n, len); return { bytes, id: await personalEmojiIdFromBytes(bytes) }; }
const storeOf = (m: Map<string, Uint8Array>) => ({ read: vi.fn(async (id: string) => m.get(id) ?? null) });

beforeEach(() => { post.mockReset(); });

describe('reportEmojiTokens', () => {
    it('finds server and personal tokens, de-duplicated, ids lowercased; mentions and junk ids are not emoji', async () => {
        const p = await fixture(1);
        const text = `a <:clown:${SRV.toUpperCase()}> b <:mine:${p.id}> <:clown:${SRV}> <@${SRV}> <:x:not-an-id> <:y:p_12>`;
        expect(reportEmojiTokens(text)).toEqual([
            { name: 'clown', id: SRV, source: 'server' },
            { name: 'mine', id: p.id, source: 'personal' },
        ]);
        expect(reportEmojiTokens('no emoji here')).toEqual([]);
        expect(reportEmojiTokens(null)).toEqual([]);
    });

    it('reportable = in the text being sent AND in the reported message (nothing else rides along)', async () => {
        const p = await fixture(1);
        const other = await fixture(2);
        const message = `hi <:mine:${p.id}> <:clown:${SRV}>`;
        // The reporter edited the server emoji out and typed one the message never had.
        const sent = `hi <:mine:${p.id}> <:extra:${other.id}>`;
        expect(reportableEmojiTokens(sent, message).map(t => t.id)).toEqual([p.id]);
        expect(reportableEmojiTokens(message, '')).toEqual([]);
    });
});

describe('collectPersonalEmojiEvidence', () => {
    it('includes the images this device holds whose bytes hash to the id; server tokens are skipped', async () => {
        const a = await fixture(1);
        const store = storeOf(new Map([[a.id, a.bytes]]));
        const out = await collectPersonalEmojiEvidence(reportEmojiTokens(`<:a:${a.id}> <:s:${SRV}>`), store);
        expect(out.included).toEqual([{ id: a.id, name: 'a', mime: 'image/png', bytes: a.bytes }]);
        expect(out.missing).toEqual([]);
        expect(store.read).toHaveBeenCalledTimes(1);
    });

    it('an emoji not on this device, or whose stored bytes do not match its id, is listed missing (name only)', async () => {
        const a = await fixture(1);
        const b = await fixture(2);
        const store = storeOf(new Map([[b.id, png(99)]])); // b's slot holds other bytes
        const out = await collectPersonalEmojiEvidence(reportEmojiTokens(`<:a:${a.id}><:b:${b.id}>`), store);
        expect(out.included).toEqual([]);
        expect(out.missing.map(m => [m.name, m.reason])).toEqual([['a', 'not_on_device'], ['b', 'not_on_device']]);
    });

    it(`caps the count at ${REPORT_PERSONAL_EMOJI_MAX} and refuses an oversized image`, async () => {
        const many = await Promise.all(Array.from({ length: REPORT_PERSONAL_EMOJI_MAX + 2 }, (_, i) => fixture(i + 1)));
        const big = await fixture(500, REPORT_PERSONAL_EMOJI_MAX_BYTES + 1);
        const m = new Map(many.map(f => [f.id, f.bytes] as const));
        m.set(big.id, big.bytes);
        const tokens = reportEmojiTokens([`<:big:${big.id}>`, ...many.map((f, i) => `<:e${i}:${f.id}>`)].join(' '));
        const out = await collectPersonalEmojiEvidence(tokens, storeOf(m));
        expect(out.included).toHaveLength(REPORT_PERSONAL_EMOJI_MAX);
        expect(out.missing.find(x => x.name === 'big')?.reason).toBe('too_large');
        expect(out.missing.filter(x => x.reason === 'over_limit')).toHaveLength(2);
    });

    it('a store that throws reads as "not on this device", never as a crash', async () => {
        const a = await fixture(1);
        const out = await collectPersonalEmojiEvidence(reportEmojiTokens(`<:a:${a.id}>`), { read: async () => { throw new Error('locked'); } });
        expect(out.missing[0].reason).toBe('not_on_device');
    });
});

describe('uploadReportPersonalEmoji', () => {
    it('posts the bytes to the report\'s emoji route with the token in the query, typed by the sniffed mime', async () => {
        post.mockResolvedValue({ data: {} });
        const a = await fixture(1);
        const ok = await uploadReportPersonalEmoji({ reportId: 'r/1', emoji: { id: a.id, name: 'mine', mime: 'image/png', bytes: a.bytes }, token: 'tok' });
        expect(ok).toBe(true);
        const [url, body, opts] = post.mock.calls[0] as [string, Blob, { headers: Record<string, string> }];
        expect(url).toMatch(new RegExp(`/reports/r%2F1/emoji\\?emoji_id=${a.id}&emoji_name=mine$`));
        expect(body).toBeInstanceOf(Blob);
        expect(body.size).toBe(a.bytes.length);
        expect(opts.headers['Content-Type']).toBe('image/png');
        expect(opts.headers.Authorization).toBe('Bearer tok');
    });

    it('resolves false (never throws) when the upload fails', async () => {
        const a = await fixture(1);
        post.mockImplementation(() => Promise.reject(Object.assign(new Error('503'), { response: { status: 503 } })));
        const ok = await uploadReportPersonalEmoji({ reportId: 'r', emoji: { id: a.id, name: 'm', mime: 'image/png', bytes: a.bytes }, token: 't' });
        expect(ok).toBe(false);
    });
});
