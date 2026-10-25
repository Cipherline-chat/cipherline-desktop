import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { whatsNewPlugin, WHATS_NEW_MODULE } from '../../vite-plugin-whats-new';
import type { WhatsNewData } from './changelogParse';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const changelog = `# Changelog

## [Unreleased]

### What's new

- Draft note.

## [1.2.3] - 2026-10-14

### What's new

- **Calls.** Built from the file.

### Changes

- Not included.
`;

/** Runs the plugin's load() the way Vite would, and parses the module it returns. */
function load(file: string, opts: { includeUnreleased?: boolean } = {}, command: 'build' | 'serve' = 'build'): { data: WhatsNewData; warnings: string[] } {
    const warnings: string[] = [];
    const plugin = whatsNewPlugin({ changelogPath: file, ...opts }) as unknown as {
        configResolved: (c: { command: string }) => void;
        resolveId: (id: string) => string | null;
        load: (this: { addWatchFile: (f: string) => void; warn: (m: string) => void }, id: string) => string | null;
    };
    plugin.configResolved({ command });
    const resolved = plugin.resolveId(WHATS_NEW_MODULE)!;
    const src = plugin.load.call({ addWatchFile: () => {}, warn: (m) => warnings.push(m) }, resolved)!;
    expect(src.startsWith('export default ')).toBe(true);
    return { data: JSON.parse(src.slice('export default '.length)) as WhatsNewData, warnings };
}
const write = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsnew-'));
    dirs.push(dir);
    const file = join(dir, 'CHANGELOG.md');
    writeFileSync(file, text);
    return file;
};

describe('vite-plugin-whats-new', () => {
    it('resolves only its own virtual module id', () => {
        const p = whatsNewPlugin() as unknown as { resolveId: (id: string) => string | null };
        expect(p.resolveId('virtual:whats-new')).toBe('\0virtual:whats-new');
        expect(p.resolveId('./other')).toBeNull();
    });

    it('bakes the CHANGELOG\'s What\'s new notes in at build time, and only those', () => {
        const { data } = load(write(changelog));
        expect(Object.keys(data.releases)).toEqual(['1.2.3']);
        expect(data.releases['1.2.3'].groups[0].items[0]).toEqual({ title: 'Calls', text: 'Built from the file.' });
        expect(JSON.stringify(data)).not.toContain('Not included');
    });

    it('leaves the [Unreleased] draft out of a production build, keeps it for dev', () => {
        expect(load(write(changelog), {}, 'build').data.unreleased).toBeNull();
        expect(load(write(changelog), {}, 'serve').data.unreleased?.groups[0].items[0].text).toBe('Draft note.');
        expect(load(write(changelog), { includeUnreleased: true }, 'build').data.unreleased).not.toBeNull();
    });

    it('warns and ships an empty set when the CHANGELOG is missing', () => {
        const { data, warnings } = load(join(tmpdir(), 'definitely-not-here', 'CHANGELOG.md'));
        expect(data).toEqual({ releases: {}, unreleased: null });
        expect(warnings.length).toBe(1);
    });

    it('a real production vite build bakes the notes into the bundle, and leaves the draft out', async () => {
        const file = write(changelog);
        const dir = dirs[dirs.length - 1];
        const entry = join(dir, 'entry.ts');
        writeFileSync(entry, "import notes from 'virtual:whats-new';\nexport const baked = notes;\n");
        const { build } = await import('vite');
        const out = await build({
            root: dir,
            configFile: false,
            logLevel: 'silent',
            plugins: [whatsNewPlugin({ changelogPath: file })],
            build: { write: false, minify: false, lib: { entry, formats: ['es'], fileName: 'out' } },
        });
        const outputs = (Array.isArray(out) ? out : [out]).flatMap(o => ('output' in o ? o.output : []));
        const code = outputs.map(o => ('code' in o ? o.code : '')).join('\n');
        expect(code).toContain('Built from the file.');      // the 1.2.3 What's new bullet
        expect(code).toContain('"1.2.3"');
        expect(code).not.toContain('Draft note.');           // [Unreleased] stays out of a build
        expect(code).not.toContain('Not included');          // and so does ### Changes
    }, 60_000);

    it('is wired into the app build and the test run', async () => {
        const { readFileSync } = await import('node:fs');
        const cfg = readFileSync(join(__dirname, '..', '..', 'vite.config.ts'), 'utf8');
        const vt = readFileSync(join(__dirname, '..', '..', 'vitest.config.ts'), 'utf8');
        expect(cfg).toMatch(/plugins:\s*\[[^\]]*whatsNewPlugin\(\)/);
        expect(vt).toMatch(/plugins:\s*\[whatsNewPlugin\(\)\]/);
    });
});
