import { describe, it, expect } from 'vitest';
import { encode, decode, chunkSnapshot, MAX_PAYLOAD_BYTES, MAX_APPEND_POINTS, type AnnotMsg, type WireStroke } from './annotationCodec';

const ROOM = 'room-abc';
const TRACK = 'alice|screen_share';
const rt = (m: AnnotMsg) => decode(encode(m), ROOM);
const fromJson = (o: unknown) => decode(new TextEncoder().encode(JSON.stringify(o)), ROOM);

describe('round trips', () => {
    it.each<AnnotMsg>([
        { t: 'stroke.begin', room: ROOM, track: TRACK, id: 's1', tool: 'laser', color: '#25E0C8', width: 4, p: { x: 0.1, y: 0.2 } },
        { t: 'stroke.append', room: ROOM, track: TRACK, id: 's1', pts: [{ x: 0.3, y: 0.4 }, { x: 1, y: 0 }] },
        { t: 'stroke.end', room: ROOM, track: TRACK, id: 's1' },
        { t: 'grant.request', room: ROOM, track: TRACK },
        { t: 'grant.deny', room: ROOM, track: TRACK, identity: 'bob' },
        { t: 'grant.grant', room: ROOM, track: TRACK, identity: 'bob' },
        { t: 'grant.revoke', room: ROOM, track: TRACK, identity: 'bob' },
        { t: 'grant.list', room: ROOM, track: TRACK, identities: ['bob', 'carol'] },
        { t: 'snapshot.request', room: ROOM, track: TRACK },
    ])('%j', (m) => {
        expect(rt(m)).toEqual(m);
    });
});

describe('binding — a packet cannot cross rooms', () => {
    it('rejects a message bound to another room', () => {
        const m: AnnotMsg = { t: 'grant.request', room: 'other-room', track: TRACK };
        expect(decode(encode(m), ROOM)).toBeNull();
    });
    it('rejects a track key that is not identity|source', () => {
        expect(fromJson({ t: 'grant.request', room: ROOM, track: 'nopipe' })).toBeNull();
    });
});

describe('rejections — every malformed shape is dropped silently', () => {
    it.each([
        ['unknown type', { t: 'stroke.explode', room: ROOM, track: TRACK, id: 's1' }],
        ['array root', [1, 2]],
        // Laser-only: the retired message types and the retired tool are all
        // just unknown shapes now, so an older peer's pen, undo and clear are
        // dropped exactly like garbage would be - which is what we want, since
        // there is no permanent mark here to draw, erase or clear.
        ['retired type: clear', { t: 'clear', room: ROOM, track: TRACK }],
        ['retired type: stroke.undo', { t: 'stroke.undo', room: ROOM, track: TRACK, id: 's1' }],
        ['begin: the retired pen tool', { t: 'stroke.begin', room: ROOM, track: TRACK, id: 's1', tool: 'pen', color: '#000000', width: 4, p: { x: 0, y: 0 } }],
        ['begin: no tool at all', { t: 'stroke.begin', room: ROOM, track: TRACK, id: 's1', color: '#000000', width: 4, p: { x: 0, y: 0 } }],
        ['snapshot: a pen stroke inside a snapshot', { t: 'snapshot', room: ROOM, track: TRACK, seq: 1, part: 0, of: 1, strokes: [{ id: 'a', by: 'bob', tool: 'pen', color: '#000000', width: 1, points: [{ x: 0, y: 0 }], done: true }] }],
        ['begin: bad colour', { t: 'stroke.begin', room: ROOM, track: TRACK, id: 's1', tool: 'laser', color: 'red', width: 4, p: { x: 0, y: 0 } }],
        ['begin: width 0', { t: 'stroke.begin', room: ROOM, track: TRACK, id: 's1', tool: 'laser', color: '#000000', width: 0, p: { x: 0, y: 0 } }],
        ['begin: point outside frame', { t: 'stroke.begin', room: ROOM, track: TRACK, id: 's1', tool: 'laser', color: '#000000', width: 4, p: { x: 1.2, y: 0 } }],
        ['begin: NaN point', { t: 'stroke.begin', room: ROOM, track: TRACK, id: 's1', tool: 'laser', color: '#000000', width: 4, p: { x: NaN, y: 0 } }],
        ['begin: id with spaces', { t: 'stroke.begin', room: ROOM, track: TRACK, id: 'bad id', tool: 'laser', color: '#000000', width: 4, p: { x: 0, y: 0 } }],
        ['append: empty', { t: 'stroke.append', room: ROOM, track: TRACK, id: 's1', pts: [] }],
        ['append: too many points', { t: 'stroke.append', room: ROOM, track: TRACK, id: 's1', pts: Array.from({ length: MAX_APPEND_POINTS + 1 }, () => ({ x: 0, y: 0 })) }],
        ['append: string coordinate', { t: 'stroke.append', room: ROOM, track: TRACK, id: 's1', pts: [{ x: '0.5', y: 0 }] }],
        ['grant: wildcard identity (no room-wide grants, ever)', { t: 'grant.grant', room: ROOM, track: TRACK, identity: '*' }],
        ['grant: empty identity', { t: 'grant.grant', room: ROOM, track: TRACK, identity: '' }],
        ['grant.list: contains wildcard', { t: 'grant.list', room: ROOM, track: TRACK, identities: ['bob', '*'] }],
        ['grant.list: duplicates', { t: 'grant.list', room: ROOM, track: TRACK, identities: ['bob', 'bob'] }],
        ['snapshot: part >= of', { t: 'snapshot', room: ROOM, track: TRACK, seq: 1, part: 1, of: 1, strokes: [] }],
        ['snapshot: identities on a non-first part', { t: 'snapshot', room: ROOM, track: TRACK, seq: 1, part: 1, of: 2, strokes: [], identities: ['bob'] }],
        ['snapshot: stroke missing by', { t: 'snapshot', room: ROOM, track: TRACK, seq: 1, part: 0, of: 1, strokes: [{ id: 'a', tool: 'laser', color: '#000000', width: 1, points: [{ x: 0, y: 0 }], done: true }] }],
        ['snapshot: stroke with extra field', { t: 'snapshot', room: ROOM, track: TRACK, seq: 1, part: 0, of: 1, strokes: [{ id: 'a', by: 'bob', tool: 'laser', color: '#000000', width: 1, points: [{ x: 0, y: 0 }], done: true, extra: 1 }] }],
    ])('%s', (_label, payload) => {
        expect(fromJson(payload)).toBeNull();
    });

    it('rejects non-JSON and empty payloads', () => {
        expect(decode(new TextEncoder().encode('{not json'), ROOM)).toBeNull();
        expect(decode(new Uint8Array(0), ROOM)).toBeNull();
    });

    it('rejects an oversize payload before parsing', () => {
        expect(decode(new Uint8Array(MAX_PAYLOAD_BYTES + 1), ROOM)).toBeNull();
    });

    it('encode refuses to produce an oversize packet', () => {
        const huge: AnnotMsg = { t: 'grant.list', room: ROOM, track: TRACK, identities: Array.from({ length: 64 }, (_, i) => 'x'.repeat(100) + i) };
        expect(() => encode(huge)).toThrow(/chunk/);
    });
});

describe('snapshot chunking', () => {
    const stroke = (id: string, n: number): WireStroke => ({
        id, by: 'alice', tool: 'laser', color: '#25E0C8', width: 4, done: true,
        points: Array.from({ length: n }, (_, i) => ({ x: (i % 100) / 100, y: ((i * 7) % 100) / 100 })),
    });

    it('a small state fits in one part, with identities', () => {
        const parts = chunkSnapshot(ROOM, TRACK, 7, [stroke('a', 3), stroke('b', 3)], ['bob']);
        expect(parts).toHaveLength(1);
        expect(parts[0]).toMatchObject({ part: 0, of: 1, identities: ['bob'] });
        expect(parts[0].strokes.map(s => s.id)).toEqual(['a', 'b']);
    });

    it('splits a large state into parts that each fit, never splitting a stroke, and reassembles losslessly', () => {
        const strokes = Array.from({ length: 40 }, (_, i) => stroke(`s${i}`, 60));
        const parts = chunkSnapshot(ROOM, TRACK, 7, strokes, ['bob', 'carol']);
        expect(parts.length).toBeGreaterThan(1);
        for (const p of parts) {
            expect(encode(p).byteLength).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
            expect(decode(encode(p), ROOM)).not.toBeNull();
            expect(p.of).toBe(parts.length);
        }
        expect(parts[0].identities).toEqual(['bob', 'carol']);
        expect(parts.slice(1).every(p => p.identities === undefined)).toBe(true);
        const back = parts.flatMap(p => p.strokes);
        expect(back).toEqual(strokes);
    });

    it('truncates a single stroke that could never fit on its own rather than dropping the snapshot', () => {
        const parts = chunkSnapshot(ROOM, TRACK, 1, [stroke('giant', 5000)], []);
        expect(parts).toHaveLength(1);
        expect(encode(parts[0]).byteLength).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
        expect(parts[0].strokes[0].points.length).toBeLessThan(5000);
        expect(parts[0].strokes[0].points.length).toBeGreaterThan(0);
    });

    it('an empty state still yields exactly one (empty) part so a late joiner gets an answer', () => {
        const parts = chunkSnapshot(ROOM, TRACK, 1, [], []);
        expect(parts).toHaveLength(1);
        expect(parts[0]).toMatchObject({ part: 0, of: 1, strokes: [], identities: [] });
    });
});
