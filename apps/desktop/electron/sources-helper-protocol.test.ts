import { describe, it, expect } from 'vitest';
import {
    isSourcesHelperArgv, SOURCES_HELPER_FLAG, parseHelperRequest, parseHelperMessage, parseListedSource,
    tokenMatches, createLineSplitter, encodeLine, MAX_SOURCES, MAX_NAME_CHARS, MAX_THUMBNAIL_CHARS,
} from './sources-helper-protocol';

const SRC = { id: 'screen:0:0', name: 'Screen 1', display_id: '', thumbnailDataUrl: 'data:image/jpeg;base64,AAAA' };

describe('isSourcesHelperArgv', () => {
    it('packaged and unpackaged argv shapes', () => {
        expect(isSourcesHelperArgv(['Cipherline.exe', SOURCES_HELPER_FLAG])).toBe(true);
        expect(isSourcesHelperArgv(['electron', '/app', SOURCES_HELPER_FLAG])).toBe(true);
    });
    it('the normal app (and look-alikes) are not the helper', () => {
        expect(isSourcesHelperArgv(['Cipherline.exe'])).toBe(false);
        expect(isSourcesHelperArgv(['Cipherline.exe', 'cipherline://invite/x'])).toBe(false);
        expect(isSourcesHelperArgv(['Cipherline.exe', `${SOURCES_HELPER_FLAG}=1`])).toBe(false);
        expect(isSourcesHelperArgv(['Cipherline.exe', '--cipherline-desktop-sources'])).toBe(false);
    });
});

describe('parseHelperRequest (child side)', () => {
    it('accepts a real request and de-duplicates types', () => {
        expect(parseHelperRequest(JSON.stringify({ id: 3, types: ['screen', 'screen'], thumbnailSize: { width: 320, height: 200 } })))
            .toEqual({ id: 3, types: ['screen'], thumbnailSize: { width: 320, height: 200 } });
        expect(parseHelperRequest(JSON.stringify({ id: 0, types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } }))?.types)
            .toEqual(['window', 'screen']);
    });
    it.each([
        ['not JSON', 'x'],
        ['no id', JSON.stringify({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })],
        ['negative id', JSON.stringify({ id: -1, types: ['screen'], thumbnailSize: { width: 0, height: 0 } })],
        ['unknown type', JSON.stringify({ id: 1, types: ['tab'], thumbnailSize: { width: 0, height: 0 } })],
        ['no types', JSON.stringify({ id: 1, types: [], thumbnailSize: { width: 0, height: 0 } })],
        ['huge thumbnail', JSON.stringify({ id: 1, types: ['screen'], thumbnailSize: { width: 99999, height: 1 } })],
        ['fractional size', JSON.stringify({ id: 1, types: ['screen'], thumbnailSize: { width: 1.5, height: 1 } })],
        ['string size', JSON.stringify({ id: 1, types: ['screen'], thumbnailSize: { width: '320', height: 200 } })],
    ])('refuses %s', (_l, line) => {
        expect(parseHelperRequest(line)).toBeNull();
    });
});

describe('parseListedSource (parent side, per entry)', () => {
    it('accepts screen/window sources with and without previews', () => {
        expect(parseListedSource(SRC)).toEqual(SRC);
        expect(parseListedSource({ ...SRC, id: 'window:132456:0', thumbnailDataUrl: '' })).not.toBeNull();
        expect(parseListedSource({ ...SRC, display_id: '2779098405' })).not.toBeNull();
        // NativeImage-empty preview, exactly as thumbnailJpegDataUrl emits it.
        expect(parseListedSource({ ...SRC, thumbnailDataUrl: 'data:image/png;base64,' })).not.toBeNull();
    });
    it.each([
        ['web-contents id', { ...SRC, id: 'web-contents-media-stream://1:2' }],
        ['id with junk', { ...SRC, id: 'screen:0:0;rm' }],
        ['non-string name', { ...SRC, name: 5 }],
        ['overlong name', { ...SRC, name: 'x'.repeat(MAX_NAME_CHARS + 1) }],
        ['display id not numeric', { ...SRC, display_id: 'abc' }],
        ['remote preview URL', { ...SRC, thumbnailDataUrl: 'https://evil.example/x.jpg' }],
        ['svg preview', { ...SRC, thumbnailDataUrl: 'data:image/svg+xml;base64,AAAA' }],
        ['preview with script chars', { ...SRC, thumbnailDataUrl: 'data:image/jpeg;base64,AA"><script>' }],
        ['oversized preview', { ...SRC, thumbnailDataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(MAX_THUMBNAIL_CHARS) }],
        ['missing display_id', { id: SRC.id, name: SRC.name, thumbnailDataUrl: '' }],
    ])('refuses %s', (_l, v) => {
        expect(parseListedSource(v)).toBeNull();
    });
});

describe('parseHelperMessage (parent side)', () => {
    it('hello', () => {
        expect(parseHelperMessage(JSON.stringify({ kind: 'hello', token: 'ab', pid: 42, disabledFeatures: 'DirectXCapturer' })))
            .toEqual({ kind: 'hello', token: 'ab', pid: 42, disabledFeatures: 'DirectXCapturer' });
        expect(parseHelperMessage(JSON.stringify({ kind: 'hello', token: 1, pid: 42 }))).toBeNull();
    });
    it('a result drops bad entries and counts them; never coerces them', () => {
        const m = parseHelperMessage(JSON.stringify({ kind: 'result', id: 7, ok: true, ms: 12, sources: [SRC, { ...SRC, id: 'bogus' }] }));
        expect(m).toEqual({ kind: 'result', id: 7, ok: true, ms: 12, dropped: 1, sources: [SRC] });
    });
    it('an error result', () => {
        expect(parseHelperMessage(JSON.stringify({ kind: 'result', id: 7, ok: false, error: 'Failed to get sources.' })))
            .toEqual({ kind: 'result', id: 7, ok: false, error: 'Failed to get sources.' });
    });
    it.each([
        ['not JSON', '{'],
        ['unknown kind', JSON.stringify({ kind: 'exec', cmd: 'x' })],
        ['result without id', JSON.stringify({ kind: 'result', ok: true, sources: [] })],
        ['too many sources', JSON.stringify({ kind: 'result', id: 1, ok: true, sources: new Array(MAX_SOURCES + 1).fill(SRC) })],
        ['ok not boolean', JSON.stringify({ kind: 'result', id: 1, ok: 'yes', sources: [] })],
    ])('refuses %s', (_l, line) => {
        expect(parseHelperMessage(line)).toBeNull();
    });
});

describe('tokenMatches', () => {
    it('exact match only', () => {
        expect(tokenMatches('abcd', 'abcd')).toBe(true);
        expect(tokenMatches('abcd', 'abce')).toBe(false);
        expect(tokenMatches('abcd', 'abc')).toBe(false);
        expect(tokenMatches('', '')).toBe(false);
    });
});

describe('createLineSplitter', () => {
    it('reassembles lines split across chunks and skips blank ones', () => {
        const lines: string[] = [];
        const split = createLineSplitter(l => lines.push(l), () => { throw new Error('overflow'); });
        split(encodeLine({ a: 1 }).slice(0, 3));
        split(encodeLine({ a: 1 }).slice(3) + '\n' + encodeLine({ b: 2 }) + '{"c"');
        split(':3}\n');
        expect(lines.map(l => JSON.parse(l))).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    });
    it('overflow stops it for good (a complete line or an unterminated one)', () => {
        let overflows = 0;
        const lines: string[] = [];
        const split = createLineSplitter(l => lines.push(l), () => overflows++, 10);
        split('0123456789AB\nok\n');
        split('later\n');
        expect(overflows).toBe(1);
        expect(lines).toEqual([]);
        let o2 = 0;
        const s2 = createLineSplitter(() => undefined, () => o2++, 10);
        s2('0123456789ABCDEF');
        expect(o2).toBe(1);
        // Positive control: exactly at the limit is fine.
        const ok: string[] = [];
        createLineSplitter(l => ok.push(l), () => { throw new Error('overflow'); }, 10)('0123456789\n');
        expect(ok).toEqual(['0123456789']);
    });
});
