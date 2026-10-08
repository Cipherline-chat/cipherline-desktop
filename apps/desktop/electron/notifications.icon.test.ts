import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as zlib from 'zlib';

// What showNotification hands the OS: every `new Notification(opts)` is recorded.
const constructed: Array<Record<string, unknown>> = [];
const decoded: Buffer[] = [];
let decodeReturnsEmpty = false;

vi.mock('electron', () => {
    class FakeNotification {
        static isSupported() { return true; }
        constructor(public opts: Record<string, unknown>) { constructed.push(opts); }
        on() { return this; }
        show() {}
        close() {}
    }
    return {
        Notification: FakeNotification,
        BrowserWindow: class {},
        ipcMain: { handle: () => {} },
        nativeImage: {
            createFromBuffer: (b: Buffer) => {
                decoded.push(b);
                return { isEmpty: () => decodeReturnsEmpty, __fromBuffer: true };
            },
        },
    };
});

const { showNotification, resolveNotificationIcon } = await import('./notifications');

function makePng(width: number, height: number): Buffer {
    const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 4 + 1) * height))),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
const goodIcon = 'data:image/png;base64,' + makePng(96, 96).toString('base64');

const fakeWin = { isDestroyed: () => false } as unknown as Parameters<typeof showNotification>[0];
const base = { id: 'notif_c1', title: 'Sam', body: 'hi', conv_id: 'c1' };

beforeEach(() => {
    constructed.length = 0;
    decoded.length = 0;
    decodeReturnsEmpty = false;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('notif:show icon handling (main process)', () => {
    it('positive control: a valid avatar becomes a nativeImage icon', () => {
        showNotification(fakeWin, { ...base, iconDataUrl: goodIcon });
        expect(constructed).toHaveLength(1);
        expect((constructed[0].icon as { __fromBuffer?: boolean }).__fromBuffer).toBe(true);
        expect(decoded).toHaveLength(1);
    });

    it('no avatar → the generic app icon path, exactly as before', () => {
        showNotification(fakeWin, { ...base });
        expect(typeof constructed[0].icon).toBe('string');
        expect(String(constructed[0].icon)).toMatch(/icon\.png$/);
        expect(decoded).toHaveLength(0);
    });

    it('an invalid avatar never reaches the image decoder and falls back to the app icon', () => {
        for (const bad of ['file:///etc/passwd', 'data:image/svg+xml;base64,PHN2Zz4=', 'x'.repeat(300_000), 12, { evil: true }]) {
            showNotification(fakeWin, { ...base, iconDataUrl: bad as unknown as string });
        }
        expect(decoded).toHaveLength(0);
        for (const c of constructed) expect(typeof c.icon).toBe('string');
    });

    it('an image Electron cannot decode falls back to the app icon', () => {
        decodeReturnsEmpty = true;
        expect(typeof resolveNotificationIcon(goodIcon)).toBe('string');
        expect(decoded).toHaveLength(1);
    });

    it('the rest of the toast is unchanged by the icon', () => {
        showNotification(fakeWin, { ...base, hasReply: true, iconDataUrl: goodIcon });
        expect(constructed[0]).toMatchObject({ title: 'Sam', body: 'hi', silent: true, hasReply: true });
    });
});
