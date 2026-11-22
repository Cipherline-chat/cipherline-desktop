/**
 * Message fonts: the optional, allowlisted `font` field on text / edit content
 * (packages/shared MESSAGE_FONTS) — reading it, writing it, validating it, and
 * applying an edit's font on every edit path (DM and channel).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MESSAGE_FONTS, isMessageFont } from '@cipherline/shared';
import { messageFontOf, fontField, fontStackFor, withEditFont, FONT_OPTIONS } from './messageFont';
import { contentProblem } from '../contentValidation';
import { editedContent, applyChannelEditDelete } from '../channelHistoryMerge';
import { applyIncomingDmMessages } from '../dmInbound';

describe('the font allowlist', () => {
    it('shared ids and the picker agree, plus the default', () => {
        expect([...MESSAGE_FONTS]).toEqual(['serif', 'mono', 'hand', 'typewriter', 'marker', 'readable']);
        expect(FONT_OPTIONS.map(o => o.id)).toEqual([null, ...MESSAGE_FONTS]);
        // Seven distinct looks, labels unique.
        expect(new Set(FONT_OPTIONS.map(o => o.label)).size).toBe(7);
        expect(isMessageFont('serif')).toBe(true);
        expect(isMessageFont('comic-sans')).toBe(false);
        expect(isMessageFont(1)).toBe(false);
    });

    it('stacks are local faces only (no url(), no remote font)', () => {
        for (const o of FONT_OPTIONS) {
            expect(o.stack).not.toMatch(/url\(|@import|https?:/i);
        }
    });
});

describe('reading a message font (sender-controlled)', () => {
    it('known ids only; anything else is the default', () => {
        expect(messageFontOf({ type: 'text', text: 'x', font: 'mono' })).toBe('mono');
        expect(messageFontOf({ type: 'text', text: 'x', font: 'wingdings' })).toBeNull();
        expect(messageFontOf({ type: 'text', text: 'x', font: { evil: 1 } })).toBeNull();
        expect(messageFontOf({ type: 'text', text: 'x' })).toBeNull();
        expect(messageFontOf(null)).toBeNull();
        expect(fontStackFor('serif')).toContain('Georgia');
        expect(fontStackFor(null)).toBeUndefined();
    });
});

describe('writing it', () => {
    it('the default adds NO field, so old clients see an unchanged message', () => {
        expect(fontField(null)).toEqual({});
        expect(fontField('marker')).toEqual({ font: 'marker' });
        expect(fontField('fun' as never)).toEqual({});
        expect(fontField('bogus' as never)).toEqual({});
    });
});

describe('validation on receive (contentValidation)', () => {
    it('accepts an absent, known or unknown short font; refuses a non-string or huge one', () => {
        expect(contentProblem({ type: 'text', text: 'hi' })).toBeNull();
        expect(contentProblem({ type: 'text', text: 'hi', font: 'serif' })).toBeNull();
        // A future font from a newer client degrades to the default — not an error.
        expect(contentProblem({ type: 'text', text: 'hi', font: 'cursive' })).toBeNull();
        expect(contentProblem({ type: 'text', text: 'hi', font: 7 })).toMatch(/font/);
        expect(contentProblem({ type: 'text', text: 'hi', font: 'x'.repeat(100) })).toMatch(/font/);
        expect(contentProblem({ type: 'edit', target_id: 't', text: 'hi', font: ['mono'] })).toMatch(/font/);
        expect(contentProblem({ type: 'edit', target_id: 't', text: 'hi', font: 'mono' })).toBeNull();
    });
});

describe('edits carry the font', () => {
    it('withEditFont replaces, clears, and never writes an unknown id', () => {
        expect(withEditFont({ type: 'text', text: 'a', font: 'mono' }, 'serif')).toEqual({ type: 'text', text: 'a', font: 'serif' });
        expect(withEditFont({ type: 'text', text: 'a', font: 'mono' }, undefined)).toEqual({ type: 'text', text: 'a' });
        expect(withEditFont({ type: 'text', text: 'a' }, 'javascript:')).toEqual({ type: 'text', text: 'a' });
    });

    it('channel edits (editedContent / applyChannelEditDelete)', () => {
        expect(editedContent({ type: 'text', text: 'old', font: 'mono' }, 'new', undefined, 'typewriter')).toEqual({ type: 'text', text: 'new', font: 'typewriter' });
        expect(editedContent({ type: 'text', text: 'old', font: 'mono' }, 'new')).toEqual({ type: 'text', text: 'new' });
        const thread = [{ id: 'm1', sender_user_id: 'u1', sender_device_id: 'd1', timestamp: '2026-11-16T00:00:00Z', content: { type: 'text', text: 'old' } }];
        const action = { id: 'e1', sender_user_id: 'u1', sender_device_id: 'd1', timestamp: '2026-11-16T00:01:00Z', content: { type: 'edit', target_id: 'm1', text: 'new', font: 'serif' } };
        const next = applyChannelEditDelete(thread as never, action as never);
        expect((next[0] as { content: unknown }).content).toEqual({ type: 'text', text: 'new', font: 'serif' });
    });

    it('DM edits (applyIncomingDmMessages)', () => {
        const threads = { c1: [{ id: 'm1', sender_user_id: 'u1', sender_device_id: 'd1', content: { type: 'text', text: 'old', font: 'serif' } }] };
        const incoming = { c1: [{ id: 'e1', sender_user_id: 'u1', sender_device_id: 'd1', content: { type: 'edit', target_id: 'm1', text: 'new', font: 'mono' } }] };
        const out = applyIncomingDmMessages(threads as never, incoming as never) as unknown as Record<string, { content: unknown }[]>;
        expect(out.c1[0].content).toEqual({ type: 'text', text: 'new', font: 'mono' });
        const incoming2 = { c1: [{ id: 'e2', sender_user_id: 'u1', sender_device_id: 'd1', content: { type: 'edit', target_id: 'm1', text: 'plain again' } }] };
        const out2 = applyIncomingDmMessages(out as never, incoming2 as never) as unknown as Record<string, { content: unknown }[]>;
        expect(out2.c1[0].content).toEqual({ type: 'text', text: 'plain again' });
    });
});

describe('bundled faces (no remote font, ever)', () => {
    const desktop = join(__dirname, '..', '..', '..');
    // formatting.css (per-message fonts) + readability.css (the Settings > Accessibility font choice).
    const css = readFileSync(join(desktop, 'src', 'styles', 'formatting.css'), 'utf8')
        + readFileSync(join(desktop, 'src', 'styles', 'readability.css'), 'utf8');
    const faces = [...css.matchAll(/@font-face\{[^}]*\}/g)].map(m => m[0]);
    const fontDir = join(desktop, 'src', 'assets', 'fonts');
    const files = readdirSync(fontDir).filter(f => f.endsWith('.woff2'));

    it('every stack names a bundled face (or a brand / system font) and nothing remote', () => {
        for (const o of FONT_OPTIONS.filter(o => o.id && !['mono'].includes(o.id))) {
            const fam = /'(Cipherline [^']+)'/.exec(o.stack)?.[1];
            expect(fam, o.label).toBeDefined();
            expect(faces.some(f => f.includes(`font-family:'${fam}'`)), fam).toBe(true);
        }
    });

    it('each @font-face is a local woff2 with font-display:swap and a latin unicode-range', () => {
        expect(faces.length).toBe(files.length);
        for (const f of faces) {
            expect(f).toMatch(/src:url\('\.\.\/assets\/fonts\/[a-z0-9-]+\.woff2'\) format\('woff2'\)/);
            expect(f).toContain('font-display:swap');
            expect(f).toContain('unicode-range:U+0000-00FF');
            expect(f).not.toMatch(/url\(['"]?(?:https?:)?\/\//);
        }
        const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
        expect(code).not.toMatch(/@import/);
        expect(code).not.toMatch(/url\(['"]?(?:https?:)?\/\//);
    });

    it('the files exist, are real woff2, and stay under the 400 KB budget', () => {
        let total = 0;
        for (const f of files) {
            const p = join(fontDir, f);
            const head = readFileSync(p).subarray(0, 4).toString('latin1');
            expect(head, f).toBe('wOF2');
            expect(faces.some(x => x.includes(`/${f}'`)), f).toBe(true);
            total += statSync(p).size;
        }
        // Message fonts keep their 400 KB budget; the two Accessibility faces (Lexend, OpenDyslexic) have their own.
        const a11yFaces = files.filter(f => /^(lexend|opendyslexic)-/.test(f));
        const a11yTotal = a11yFaces.reduce((n, f) => n + statSync(join(fontDir, f)).size, 0);
        expect(a11yFaces.length).toBe(4);
        expect(a11yTotal).toBeLessThan(300 * 1024);
        expect(total - a11yTotal).toBeLessThan(400 * 1024);
    });

    it('every bundled face is credited in LICENSES.md and ships its licence text', () => {
        const lic = readFileSync(join(desktop, 'LICENSES.md'), 'utf8');
        for (const name of ['Lora', 'Caveat', 'Atkinson Hyperlegible', 'Special Elite', 'Permanent Marker', 'Lexend', 'OpenDyslexic']) expect(lic, name).toContain(name);
        const shipped = readdirSync(join(desktop, 'public', 'licenses', 'fonts'));
        expect(shipped.sort()).toEqual(['AtkinsonHyperlegible-OFL.license', 'Caveat-OFL.license', 'Lexend-OFL.license', 'Lora-OFL.license', 'OpenDyslexic-OFL.license', 'PermanentMarker-Apache-2.0.license', 'SpecialElite-Apache-2.0.license']);
    });

    it('code stays monospace and unadjusted whatever the message font', () => {
        // Size is calibrated per face only (size-adjust in @font-face), never on the message.
        expect(css).not.toMatch(/\[data-msg-font[^\]]*\][^{]*\{[^}]*font-size\s*:/);
        expect(css).toMatch(/font-family:'Cipherline Caveat';[^}]*size-adjust:115%/);
        expect(css).toMatch(/font-family:'Cipherline Permanent Marker';[^}]*size-adjust:88%/);
        expect(css).toMatch(/\.cl-fmt-code\{\s*font-family:var\(--cl-font-mono\)/);
    });
});
