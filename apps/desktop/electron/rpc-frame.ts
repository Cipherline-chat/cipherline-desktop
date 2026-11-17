/**
 * Local Rich Presence IPC — the frame codec (pure, no I/O).
 *
 * The local Rich Presence transport that games and launchers speak (the
 * "discord-ipc-N" named pipe / unix socket; see ./rpc-ipc-server.ts) is a
 * stream of frames:
 *
 *     opcode : uint32 little-endian
 *     length : uint32 little-endian   (bytes of JSON that follow)
 *     body   : `length` bytes of UTF-8 JSON
 *
 * Opcodes: HANDSHAKE 0, FRAME 1, CLOSE 2, PING 3, PONG 4.
 *
 * Hardening (the peer is any local process that can open the socket):
 *   - a frame whose declared length exceeds MAX_FRAME_BYTES is rejected from
 *     its header alone (we never buffer toward it) and the caller drops the
 *     connection;
 *   - an unknown opcode is an error, not a skip;
 *   - the body must be strict JSON whose top level is an object (or null for
 *     PING/PONG/CLOSE bodies some clients send empty) — anything else is an
 *     error;
 *   - the decoder never holds more than one header + one max-size body.
 */

export const OP_HANDSHAKE = 0;
export const OP_FRAME = 1;
export const OP_CLOSE = 2;
export const OP_PING = 3;
export const OP_PONG = 4;

export type RpcOpcode = 0 | 1 | 2 | 3 | 4;

/** 64 KiB of JSON per frame. Real SET_ACTIVITY frames are well under 2 KiB. */
export const MAX_FRAME_BYTES = 64 * 1024;
export const HEADER_BYTES = 8;

export interface RpcFrame {
    op: RpcOpcode;
    /** Parsed JSON body: a plain object, or null for an empty body. */
    data: Record<string, unknown> | null;
}

export class RpcFrameError extends Error {
    constructor(readonly reason: 'oversize' | 'bad_opcode' | 'bad_json' | 'bad_shape', message: string) {
        super(message);
        this.name = 'RpcFrameError';
    }
}

const isOpcode = (n: number): n is RpcOpcode => n === 0 || n === 1 || n === 2 || n === 3 || n === 4;

/** Encode one frame. `data` is JSON-serialised; null encodes as `null`. */
export function encodeFrame(op: RpcOpcode, data: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(data ?? null), 'utf8');
    const out = Buffer.alloc(HEADER_BYTES + body.length);
    out.writeUInt32LE(op, 0);
    out.writeUInt32LE(body.length, 4);
    body.copy(out, HEADER_BYTES);
    return out;
}

function parseBody(op: RpcOpcode, body: Buffer): Record<string, unknown> | null {
    if (body.length === 0) return null;
    let text: string;
    try {
        // fatal: invalid UTF-8 is malformed input, not something to coerce.
        text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
        throw new RpcFrameError('bad_json', 'frame body is not valid UTF-8');
    }
    let v: unknown;
    try {
        v = JSON.parse(text);
    } catch {
        throw new RpcFrameError('bad_json', 'frame body is not valid JSON');
    }
    if (v === null) return null;
    if (typeof v !== 'object' || Array.isArray(v)) {
        throw new RpcFrameError('bad_shape', `opcode ${op} body must be a JSON object`);
    }
    return v as Record<string, unknown>;
}

/**
 * Streaming decoder: feed it whatever the socket delivers (partial frames,
 * several frames at once) and it returns every complete frame, in order.
 * Throws RpcFrameError on the first malformed frame; the caller must then
 * drop the connection (the stream cannot be resynchronised).
 */
export class RpcFrameDecoder {
    private buf: Buffer = Buffer.alloc(0);
    private failed = false;

    push(chunk: Buffer): RpcFrame[] {
        if (this.failed) throw new RpcFrameError('bad_shape', 'decoder already failed');
        this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
        const out: RpcFrame[] = [];
        try {
            for (;;) {
                if (this.buf.length < HEADER_BYTES) break;
                const op = this.buf.readUInt32LE(0);
                const len = this.buf.readUInt32LE(4);
                if (!isOpcode(op)) throw new RpcFrameError('bad_opcode', `unknown opcode ${op}`);
                if (len > MAX_FRAME_BYTES) throw new RpcFrameError('oversize', `frame of ${len} bytes exceeds ${MAX_FRAME_BYTES}`);
                if (this.buf.length < HEADER_BYTES + len) break;
                const body = this.buf.subarray(HEADER_BYTES, HEADER_BYTES + len);
                out.push({ op, data: parseBody(op, body) });
                this.buf = this.buf.subarray(HEADER_BYTES + len);
            }
        } catch (e) {
            this.failed = true;
            this.buf = Buffer.alloc(0);
            throw e;
        }
        // Detach a small remainder from the (possibly large) chunk it was cut from.
        if (this.buf.length > 0 && this.buf.byteOffset !== 0) this.buf = Buffer.from(this.buf);
        return out;
    }

    /** Bytes held waiting for the rest of a frame (bounded by one frame). */
    get pending(): number {
        return this.buf.length;
    }
}
