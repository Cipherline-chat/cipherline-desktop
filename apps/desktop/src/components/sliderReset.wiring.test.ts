/**
 * Wiring: every slider that has a default carries it, so double-click puts it
 * back. This is a source-level guard (the behaviour itself is in
 * ClSlider.reset.test.ts) whose job is to notice a NEW slider that was added
 * without one, and to keep each default tied to the constant the setting
 * actually starts from rather than a number retyped at the call site.
 *
 * Adding a slider? Give it `resetValue={<the setting's default constant>}`. If it
 * genuinely has no default, add it to NO_DEFAULT below with the reason.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_VOICE_SETTINGS } from '../hooks/useVoiceSettings';
import { DEFAULT_PER_USER_VOLUME } from '../utils/volumeLimits';
import { DEFAULT_SOUND_PREFS } from '../utils/notificationSounds';

const SRC = path.resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.tsx$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
    }
    return out;
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join('/');
const files = walk(SRC);
/** Source without comments, so prose that mentions `<input type="range">` is not code. */
const code = (f: string) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (r: string) => fs.readFileSync(path.join(SRC, r), 'utf8');

/** The opening tag of every `<name ...>` in `src`, balanced over {} and quotes. */
function openingTags(src: string, name: string): string[] {
    const tags: string[] = [];
    const re = new RegExp(`<${name}(?=[\\s/>])`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        let i = m.index + m[0].length;
        let depth = 0;
        let quote: string | null = null;
        for (; i < src.length; i++) {
            const c = src[i];
            if (quote) { if (c === quote) quote = null; continue; }
            if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
            if (c === '{') depth++;
            else if (c === '}') depth--;
            else if (c === '>' && depth === 0) break;
        }
        tags.push(src.slice(m.index, i + 1));
    }
    return tags;
}

/** Sliders with no meaningful default, and why. Keyed by `file`. */
const NO_DEFAULT: Record<string, string> = {
    'components/cl/ClKitGallery.tsx': 'design-kit demo slider; it is not a setting',
};

describe('slider default wiring', () => {
    it('no raw <input type="range"> anywhere (use ClSlider so reset, hint and physics come with it)', () => {
        const offenders = files.filter(f => /type=["']range["']/.test(code(f))).map(rel);
        expect(offenders).toEqual([]);
    });

    it('every <ClSlider>/<ResetSlider> declares a resetValue, unless listed in NO_DEFAULT', () => {
        const missing: string[] = [];
        let seen = 0;
        for (const f of files) {
            const r = rel(f);
            if (r === 'components/ClSlider.tsx' || r === 'components/ResetSlider.tsx') continue;
            const src = fs.readFileSync(f, 'utf8');
            for (const name of ['ClSlider', 'ResetSlider']) {
                for (const tag of openingTags(src, name)) {
                    seen++;
                    if (!/\bresetValue=/.test(tag) && !(r in NO_DEFAULT)) missing.push(`${r}: ${tag.replace(/\s+/g, ' ').slice(0, 90)}`);
                }
            }
        }
        // Guards the scanner itself: if it stops finding sliders this must not pass vacuously.
        expect(seen).toBeGreaterThanOrEqual(13);
        expect(missing).toEqual([]);
    });

    it('NO_DEFAULT entries are still real sliders (a stale exemption would hide a future one)', () => {
        for (const r of Object.keys(NO_DEFAULT)) {
            expect(openingTags(read(r), 'ClSlider').length).toBeGreaterThan(0);
        }
    });

    it('each default comes from the constant the setting starts from', () => {
        const expectations: [file: string, pattern: RegExp, min: number][] = [
            // Input / output volume: Settings -> Voice & Video
            ['components/VoiceVideoSettings.tsx', /resetValue=\{DEFAULT_VOICE_SETTINGS\.micVolume\}/g, 1],
            ['components/VoiceVideoSettings.tsx', /resetValue=\{DEFAULT_VOICE_SETTINGS\.speakerVolume\}/g, 1],
            ['components/VoiceVideoSettings.tsx', /resetValue=\{DEFAULT_VOICE_SETTINGS\.camera(Brightness|Contrast|Saturation)\}/g, 3],
            // ...and the per-device profile editors
            ['components/settings/AudioDeviceList.tsx', /resetValue=\{DEFAULT_VOICE_SETTINGS\.micVolume\}/g, 1],
            ['components/settings/AudioDeviceList.tsx', /resetValue=\{DEFAULT_VOICE_SETTINGS\.speakerVolume\}/g, 1],
            ['components/settings/AudioDeviceList.tsx', /resetValue=\{DEFAULT_VOICE_SETTINGS\.voiceGateThreshold\}/g, 1],
            // Call-bar right-click menus (Mic Volume / Output Volume)
            ['components/call/ControlBar.tsx', /DEFAULT_VOICE_SETTINGS\.(mic|speaker)Volume,/g, 2],
            ['components/call/ControlBar.tsx', /resetValue=\{resetValue\}/g, 1],
            // Per-participant mic + screen-share audio
            ['components/call/PopoverMenu.tsx', /resetValue=\{DEFAULT_PER_USER_VOLUME\}/g, 2],
            // Notification sounds
            ['components/NotificationsTab.tsx', /resetValue=\{Math\.round\(DEFAULT_PREFS\.master_volume \* 100\)\}/g, 1],
            ['components/NotificationsTab.tsx', /resetValue=\{Math\.round\(DEFAULT_SOUND_PREFS\[cat\]\.volume \* 100\)\}/g, 1],
            ['components/NotificationsTab.tsx', /resetValue=\{Math\.round\(DEFAULT_PREFS\.sound_groups\.app\.volume \* 100\)\}/g, 1],
            // Other
            ['components/cl/ClImageCropper.tsx', /resetValue=\{IDENTITY_CROP\.scale\}/g, 1],
        ];
        for (const [file, pattern, min] of expectations) {
            const n = (read(file).match(pattern) ?? []).length;
            expect(n, `${file} ${pattern}`).toBeGreaterThanOrEqual(min);
        }
    });

    it('custom (non-ClSlider) sliders reset too: gate threshold and every EQ band', () => {
        const vv = read('components/VoiceVideoSettings.tsx');
        expect(vv).toMatch(/onDoubleClick=\{\(\) => \{ if \(!disabled\) onChange\(GATE_DEFAULT_THRESHOLD\); \}\}/);
        expect(vv).toMatch(/const GATE_DEFAULT_THRESHOLD = DEFAULT_VOICE_SETTINGS\.voiceGateThreshold;/);
        expect(vv).toMatch(/onDoubleClick=\{\(\) => onChange\(EQ_BAND_DEFAULT_GAIN\)\}/);
        expect(vv).toMatch(/const EQ_BAND_DEFAULT_GAIN = DEFAULT_VOICE_SETTINGS\.eqBands\[0\];/);
        // both custom sliders show the same hint as ClSlider
        expect((vv.match(/useSliderResetHint\(/g) ?? []).length).toBe(2);
    });

    it('every role="slider" in the app is accounted for', () => {
        const KNOWN: Record<string, string> = {
            'components/ClSlider.tsx': 'the shared slider: resetValue',
            'components/settings/ui/ColourPicker.tsx':
                'the color picker (2D saturation/brightness area + hue): a color is chosen, not tuned from a default; the hex field and swatches are its reset',
            'components/settings/ui/HueSlider.tsx':
                'the hue slider: double-click calls onReset when given (a cosmetic color resets to Match theme); in the color picker a color is chosen, not tuned (hex + swatches are its reset)',
            'components/VoiceVideoSettings.tsx': 'gate threshold + EQ band: own onDoubleClick (asserted above)',
            'components/onboarding/steps/StorageStep.tsx':
                'retention-window handles on a discrete ladder; there is no single default (the preset chips above them are the reset)',
        };
        const found = files.filter(f => /\srole=["']slider["']/.test(code(f))).map(rel);
        const unknown = found.filter(r => !(r in KNOWN));
        expect(unknown, 'a new role="slider" needs a default + double-click reset (or an entry in KNOWN with the reason)').toEqual([]);
    });

    it('the hint is wired into ClSlider itself', () => {
        expect(read('components/sliderReset.ts')).toContain("export const SLIDER_RESET_HINT = 'Double-click to reset'");
        expect(read('components/ClSlider.tsx')).toMatch(/useSliderResetHint\(canReset\)/);
    });

    it('the constants those defaults point at are the documented ones', () => {
        expect(DEFAULT_VOICE_SETTINGS.micVolume).toBe(100);
        expect(DEFAULT_VOICE_SETTINGS.speakerVolume).toBe(100);
        expect(DEFAULT_VOICE_SETTINGS.voiceGateThreshold).toBe(-45);
        expect([DEFAULT_VOICE_SETTINGS.cameraBrightness, DEFAULT_VOICE_SETTINGS.cameraContrast, DEFAULT_VOICE_SETTINGS.cameraSaturation]).toEqual([100, 100, 100]);
        expect(DEFAULT_VOICE_SETTINGS.eqBands).toEqual([0, 0, 0, 0, 0]);
        expect(DEFAULT_PER_USER_VOLUME).toBe(1);
        // the three primary per-sound sliders start at 100%
        for (const cat of ['message', 'mention', 'call'] as const) expect(DEFAULT_SOUND_PREFS[cat].volume).toBe(1);
    });
});
