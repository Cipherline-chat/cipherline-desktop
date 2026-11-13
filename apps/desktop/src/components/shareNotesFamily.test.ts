import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShareFpsDisclaimer, shareFpsLimit, SHARE_FPS_90_NOTE } from './ShareFpsNote';
import { ShareNotice } from './ShareNotice';
import { ClNote } from './cl/ClNote';

// ClButton pulls in clPhysics (window.matchMedia at import); the dismiss button's own look is not under test here.
vi.mock('./ClButton', () => ({ ClButton: (p: { children: React.ReactNode }) => React.createElement('button', null, p.children) }));

const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
const html = (frameRate: number, maxRefreshHz: number, captureCeiling = 0) =>
    renderToStaticMarkup(React.createElement(ShareFpsDisclaimer, { frameRate, maxRefreshHz, captureCeiling }));

describe('shareFpsLimit: which cap applies (behaviour unchanged by the restyle)', () => {
    it('nothing when the display is unknown, fast enough, or the rate is within it', () => {
        expect(shareFpsLimit(90, 0)).toBeNull();
        expect(shareFpsLimit(90, 144)).toBeNull();
        expect(shareFpsLimit(60, 60)).toBeNull();
        expect(shareFpsLimit(30, 60)).toBeNull();
    });
    it('refresh cap when the rate exceeds the display', () => {
        expect(shareFpsLimit(90, 60)).toBe('refresh-cap');
        expect(shareFpsLimit(60, 30)).toBe('refresh-cap');
    });
    it('capturer ceiling when it is the tighter limit (Wayland 60 on a 144 Hz monitor)', () => {
        expect(shareFpsLimit(90, 144, 60)).toBe('capture-cap');
        expect(shareFpsLimit(90, 0, 60)).toBe('capture-cap');
        expect(shareFpsLimit(60, 144, 60)).toBeNull();
    });
    it('a display at or under the ceiling wins: the display is what is named', () => {
        expect(shareFpsLimit(90, 60, 60)).toBe('refresh-cap');
        expect(shareFpsLimit(90, 30, 60)).toBe('refresh-cap');
        expect(shareFpsLimit(90, 75, 60)).toBe('capture-cap');
    });
});

describe('ShareFpsDisclaimer: which note shows, and in which tone', () => {
    it('90 fps on a fast display: the calm info note', () => {
        const out = html(90, 144);
        expect(out).toContain('data-testid="share-fps-note"');
        expect(out).toContain('data-tone="info"');
        expect(out).toContain(SHARE_FPS_90_NOTE);
    });
    it('60 / 30 / 15 fps on a fast display: nothing', () => {
        for (const fps of [60, 30, 15]) expect(html(fps, 144)).toBe('');
    });
    it('display refresh cap: warn tone, names the Hz and the resulting fps', () => {
        const out = html(90, 60);
        expect(out).toContain('data-testid="share-refresh-cap-note"');
        expect(out).toContain('data-tone="warn"');
        expect(out).toContain('Your display runs at 60 Hz, so this shares at about 60 fps.');
        expect(out).not.toContain('share-fps-note');
    });
    it('Wayland capture cap: warn tone, names the ceiling', () => {
        const out = html(90, 144, 60);
        expect(out).toContain('data-testid="share-capture-cap-note"');
        expect(out).toContain('data-tone="warn"');
        expect(out).toContain('Screen sharing is limited to 60 fps here.');
        expect(out).toContain('PipeWire');
    });
    it('a cap replaces the 90 note rather than stacking with it', () => {
        expect((html(90, 60).match(/role="note"/g) ?? []).length).toBe(1);
        expect((html(90, 144, 60).match(/role="note"/g) ?? []).length).toBe(1);
    });
});

describe('one note family: same box metrics, tokens only', () => {
    const info = renderToStaticMarkup(React.createElement(ClNote, { tone: 'info', children: 'x' }));
    const warn = renderToStaticMarkup(React.createElement(ClNote, { tone: 'warn', children: 'x' }));
    const box = (h: string) => /class="([^"]*)"/.exec(h)![1];
    const METRICS = ['flex', 'max-w-full', 'items-start', 'gap-2', 'rounded-lg', 'border', 'px-3', 'py-2'];

    it('info and warn share padding, radius, gap and alignment', () => {
        for (const c of METRICS) {
            expect(box(info).split(' ')).toContain(c);
            expect(box(warn).split(' ')).toContain(c);
        }
    });
    it('warn uses the Glow token, never a hard-coded colour', () => {
        expect(box(warn)).toContain('border-cl-glow/25');
        expect(warn).toContain('text-cl-glow');
        expect(warn).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|amber/i);
    });
    it('the text is a <div>, not a <p> (the kit modal\'s `.mcard p` margin/font rule beats Tailwind on a <p>)', () => {
        expect(info).not.toMatch(/<p[\s>]/);
        expect(warn).not.toMatch(/<p[\s>]/);
        const code = src('cl/ClNote.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(code).not.toContain('<p ');
    });
    it('an action (dismiss) makes the note span its column', () => {
        const out = renderToStaticMarkup(React.createElement(ClNote, { action: React.createElement('button'), children: 'x' }));
        expect(box(out).split(' ')).toContain('w-full');
        expect(box(out).split(' ')).not.toContain('w-fit');
    });
    it('ShareNotice maps the in-call notice tone onto the family and keeps a dismiss control', () => {
        for (const tone of ['info', 'warn'] as const) {
            const out = renderToStaticMarkup(React.createElement(ShareNotice, { tone, onDismiss: () => {}, children: 'HDR was turned off' }));
            expect(out).toContain(`data-tone="${tone}"`);
            expect(out).toContain('data-testid="share-notice"');
            expect(out).toContain('HDR was turned off');
            expect(out).toContain('✕');
        }
    });
});

describe('wiring: no hand-rolled share boxes left', () => {
    const picker = src('ScreenSharePickerModal.tsx');
    const conf = src('SidebarConference.tsx');
    it('picker and in-call notice no longer carry hard-coded amber/sky rgba boxes', () => {
        expect(picker).not.toMatch(/rgba\(234,\s?179,\s?8/);
        expect(conf).not.toMatch(/rgba\(234,\s?179,\s?8/);
        expect(conf).toContain('<ShareNotice tone={screenShareNotice.tone}');
    });
    it('picker disclaimers go through the shared family; macOS bypass note is a ClNote', () => {
        expect(picker).toContain('<ShareFpsDisclaimer');
        expect(picker).toContain('<ClNote className="mx-6 mt-3 shrink-0" data-testid="share-mac-bypass-note">');
    });
    it('no <p> in the picker\'s summary / chooser blocks (kit `.mcard p` trap)', () => {
        const summary = picker.slice(picker.indexOf('const QualitySummary'), picker.indexOf('// Linux: one combined request'));
        expect(summary.replace(/\/\/[^\n]*/g, '')).not.toMatch(/<p[\s>]/);
        const chooser = picker.slice(picker.indexOf('const LayoutChooser'), picker.indexOf('const QualityControls'));
        expect(chooser).not.toMatch(/<p[\s>]/);
    });
});
