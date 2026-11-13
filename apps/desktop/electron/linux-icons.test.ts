import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A single 1024x1024 linux.icon installs only to hicolor/1024x1024, a folder the
 * hicolor theme (0.17) does not list, so the desktop finds no icon at all (the 1.0.24
 * staging .deb). desktopName is what the window's Wayland app id comes from;
 * unset, it is "desktop.desktop" and no window matches cipherline.desktop.
 */
const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const dir = resolve(root, pkg.build.linux.icon);

describe('Linux icons', () => {
    it('the window matches the installed desktop file', () => {
        expect(pkg.desktopName).toBe(`${pkg.build.linux.executableName}.desktop`);
    });

    it('ships every size the theme looks in, each really that size, and none it does not list', () => {
        const files = readdirSync(dir).sort();
        for (const n of [16, 24, 32, 48, 64, 128, 256, 512]) {
            const f = `${n}x${n}.png`;
            expect(files).toContain(f);
            const head = readFileSync(resolve(dir, f)).subarray(0, 26);
            expect([head.readUInt32BE(16), head.readUInt32BE(20)]).toEqual([n, n]);
            expect(head[25]).toBe(6); // RGBA: the corners stay transparent
        }
        expect(files).not.toContain('1024x1024.png');
    });
});
