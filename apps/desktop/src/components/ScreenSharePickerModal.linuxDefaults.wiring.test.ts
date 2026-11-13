import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const picker = readFileSync(join(__dirname, 'ScreenSharePickerModal.tsx'), 'utf8');
const bar = readFileSync(join(__dirname, 'call', 'ControlBar.tsx'), 'utf8');

describe('Linux share defaults are wired into the picker and the call bar', () => {
    it('the picker caps the offered rate on the Chromium path and clamps what it hands to the share', () => {
        expect(picker).toMatch(/useChromiumFpsCap\(\)/);
        expect(picker).toMatch(/const maxFps: 60 \| 90 = chromiumCap/);
        expect(picker).not.toMatch(/frameRate: clampShareFps\(frameRate/);
    });
    it('an untouched default may be fitted; an explicit pick is only warned about', () => {
        expect(picker).toMatch(/qualityTouchedRef\.current\) return;/);
        expect(picker).toMatch(/overBudget && softwarePlan\.suggested && qualityTouchedRef\.current/);
        expect(picker).toMatch(/data-testid="share-software-note"/);
    });
    it('every control and preset marks the quality as chosen', () => {
        expect(picker).not.toMatch(/setResolution=\{setResolution\}/);
        expect(picker).not.toMatch(/setFrameRate=\{setFrameRate\}/);
        expect(picker).toMatch(/pickResolution\(PRESETS\[key\]\.resolution\)/);
    });
    it('the in-call quality panel offers the same cap', () => {
        expect(bar).toMatch(/useChromiumFpsCap\(\)/);
        expect(bar).toMatch(/chromiumCap === null \|\| fps <= chromiumCap/);
    });
});
