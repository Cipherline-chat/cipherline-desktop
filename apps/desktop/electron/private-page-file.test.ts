import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writePrivatePage } from './private-page-file';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('private temp pages (E-8)', () => {
    it('writes into a fresh private directory, not a predictable name in the shared temp dir', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-test-'));
        made.push(root);
        // A planted file at the OLD predictable name is never used or overwritten.
        const planted = path.join(root, `cipherline-installer-${process.pid}.html`);
        fs.writeFileSync(planted, '<script>evil()</script>');
        const a = writePrivatePage('cl-splash', '<p>a</p>', { tmpdir: () => root });
        const b = writePrivatePage('cl-splash', '<p>b</p>', { tmpdir: () => root });
        expect(a.filePath).not.toBe(b.filePath);
        expect(path.dirname(a.filePath)).not.toBe(root);
        expect(fs.readFileSync(a.filePath, 'utf8')).toBe('<p>a</p>');
        expect(fs.readFileSync(planted, 'utf8')).toBe('<script>evil()</script>');
        if (process.platform !== 'win32') {
            expect(fs.statSync(path.dirname(a.filePath)).mode & 0o777).toBe(0o700);
            expect(fs.statSync(a.filePath).mode & 0o777).toBe(0o600);
        }
        a.cleanup(); a.cleanup();
        expect(fs.existsSync(path.dirname(a.filePath))).toBe(false);
        b.cleanup();
    });

    it('never writes through a pre-existing file (exclusive create)', () => {
        let wrote: unknown = null;
        const fakeFs = {
            mkdtempSync: () => '/x/cl-1',
            chmodSync: () => undefined,
            rmSync: () => undefined,
            writeFileSync: (_p: unknown, _d: unknown, opts: unknown) => { wrote = opts; },
        } as unknown as typeof fs;
        writePrivatePage('cl', 'x', { fs: fakeFs, tmpdir: () => '/x' });
        expect(wrote).toMatchObject({ flag: 'wx', mode: 0o600 });
    });

    it('main.ts and the annotation overlay no longer write pages to a predictable temp path', () => {
        const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
        const overlay = fs.readFileSync(path.join(__dirname, 'annotation-overlay.ts'), 'utf8');
        expect(main).not.toMatch(/cipherline-installer-\$\{process\.pid\}/);
        expect(overlay).not.toMatch(/cipherline-annot-overlay-\$\{process\.pid\}/);
        expect(main).toContain("writePrivatePage('cl-splash', html)");
        expect(overlay).toContain('writePrivatePage(`cl-annot-${++pageSeq}`, OVERLAY_HTML)');
    });
});
