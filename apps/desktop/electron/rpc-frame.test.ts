import { describe, it, expect } from 'vitest';
import {
    RpcFrameDecoder, RpcFrameError, encodeFrame, MAX_FRAME_BYTES, HEADER_BYTES,
    OP_HANDSHAKE, OP_FRAME, OP_PING,
} from './rpc-frame';

const raw = (op: number, body: Buffer) => {
    const h = Buffer.alloc(HEADER_BYTES);
    h.writeUInt32LE(op, 0);
    h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body]);
};

describe('rpc-frame codec', () => {
    it('encodes little-endian opcode + length + JSON', () => {
        const f = encodeFrame(OP_FRAME, { cmd: 'X' });
        expect(f.readUInt32LE(0)).toBe(1);
        expect(f.readUInt32LE(4)).toBe(f.length - 8);
        expect(JSON.parse(f.subarray(8).toString())).toEqual({ cmd: 'X' });
    });

    it('round-trips one frame', () => {
        const d = new RpcFrameDecoder();
        expect(d.push(encodeFrame(OP_HANDSHAKE, { v: 1, client_id: '1' }))).toEqual([{ op: 0, data: { v: 1, client_id: '1' } }]);
    });

    it('reassembles a frame split at every byte boundary (partial reads)', () => {
        const whole = encodeFrame(OP_FRAME, { cmd: 'SET_ACTIVITY', args: { activity: { details: 'Ranked • Round 3' } } });
        for (let cut = 1; cut < whole.length; cut++) {
            const d = new RpcFrameDecoder();
            expect(d.push(whole.subarray(0, cut))).toEqual([]);
            expect(d.pending).toBe(cut);
            const out = d.push(whole.subarray(cut));
            expect(out).toHaveLength(1);
            expect(out[0].data).toMatchObject({ cmd: 'SET_ACTIVITY' });
            expect(d.pending).toBe(0);
        }
    });

    it('splits concatenated frames, in order, and keeps a trailing partial', () => {
        const a = encodeFrame(OP_PING, { n: 1 });
        const b = encodeFrame(OP_FRAME, { n: 2 });
        const c = encodeFrame(OP_FRAME, { n: 3 });
        const d = new RpcFrameDecoder();
        const out = d.push(Buffer.concat([a, b, c.subarray(0, 5)]));
        expect(out.map(f => f.data)).toEqual([{ n: 1 }, { n: 2 }]);
        expect(d.push(c.subarray(5)).map(f => f.data)).toEqual([{ n: 3 }]);
    });

    it('empty body decodes as null', () => {
        expect(new RpcFrameDecoder().push(raw(OP_PING, Buffer.alloc(0)))).toEqual([{ op: 3, data: null }]);
    });

    it('rejects an oversize frame from its HEADER alone (never buffers toward it)', () => {
        const h = Buffer.alloc(8);
        h.writeUInt32LE(OP_FRAME, 0);
        h.writeUInt32LE(MAX_FRAME_BYTES + 1, 4);
        const d = new RpcFrameDecoder();
        expect(() => d.push(h)).toThrow(RpcFrameError);
        try { new RpcFrameDecoder().push(h); } catch (e) { expect((e as RpcFrameError).reason).toBe('oversize'); }
    });

    it('positive control: a frame of exactly MAX_FRAME_BYTES is accepted', () => {
        const filler = 'x'.repeat(MAX_FRAME_BYTES - '{"p":""}'.length);
        const body = Buffer.from(JSON.stringify({ p: filler }));
        expect(body.length).toBe(MAX_FRAME_BYTES);
        expect(new RpcFrameDecoder().push(raw(OP_FRAME, body))).toHaveLength(1);
    });

    it.each([5, 6, 99, 0xffffffff])('rejects unknown opcode %i', (op) => {
        expect(() => new RpcFrameDecoder().push(raw(op, Buffer.from('{}')))).toThrow(/unknown opcode/);
    });

    it.each([
        ['not JSON', '{nope'],
        ['trailing garbage', '{"a":1}x'],
        ['a JSON array', '[1,2]'],
        ['a JSON string', '"hi"'],
        ['a JSON number', '42'],
    ])('rejects %s', (_n, text) => {
        expect(() => new RpcFrameDecoder().push(raw(OP_FRAME, Buffer.from(text)))).toThrow(RpcFrameError);
    });

    it('rejects invalid UTF-8', () => {
        expect(() => new RpcFrameDecoder().push(raw(OP_FRAME, Buffer.from([0x7b, 0xff, 0x7d])))).toThrow(/UTF-8/);
    });

    it('a failed decoder stays failed (the stream cannot be resynchronised)', () => {
        const d = new RpcFrameDecoder();
        expect(() => d.push(raw(9, Buffer.from('{}')))).toThrow();
        expect(() => d.push(encodeFrame(OP_FRAME, {}))).toThrow();
    });
});
