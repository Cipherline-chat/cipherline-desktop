import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShareFpsNote, SHARE_FPS_90_NOTE } from './ShareFpsNote';

const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
const html = (fps: number) => renderToStaticMarkup(React.createElement(ShareFpsNote, { frameRate: fps }));

describe('90 fps notice is a calm informational note, shown only at 90', () => {
    it('renders only for 90 fps', () => {
        expect(html(90)).toContain('data-testid="share-fps-note"');
        for (const fps of [60, 30, 15]) expect(html(fps)).toBe('');
    });

    it('carries the tightened copy', () => {
        expect(SHARE_FPS_90_NOTE).toBe('90 fps depends on your PC and upload speed — some setups will land nearer 60.');
        expect(html(90)).toContain(SHARE_FPS_90_NOTE);
    });

    it('uses the shared info style: a note, not amber/warning, no hard-coded colours', () => {
        const out = html(90);
        expect(out).toContain('role="note"');
        expect(out).toContain('text-cl-lume');
        expect(out).toContain('text-cl-muted');
        expect(out).not.toMatch(/amber|yellow|orange|warning|danger|flash/i);
        expect(out).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
        expect(out).toContain('max-w-full'); // never wider than its column
    });

    it('ClNote itself has no warning palette', () => {
        // Code only - the doc comment names "amber" to say what this is NOT.
        const note = src('cl/ClNote.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(note).not.toMatch(/amber|yellow|AlertTriangle|rgba?\(|#[0-9a-fA-F]{6}/);
    });

    it('picker and call bar both use the shared component; the old amber copy is gone', () => {
        const picker = src('ScreenSharePickerModal.tsx');
        const bar = src('call/ControlBar.tsx');
        expect(picker).toContain('<ShareFpsNote frameRate={frameRate}');
        expect(bar).toContain('<ShareFpsNote frameRate={qFps}');
        for (const s of [picker, bar]) {
            expect(s).not.toContain('Up to 90 fps.');
            expect(s).not.toContain('land closer to 60');
            expect(s).not.toContain('depends on your hardware and network speed');
        }
    });
});
