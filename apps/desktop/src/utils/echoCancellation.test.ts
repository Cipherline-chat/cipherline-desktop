/**
 * Echo cancellation (Settings -> Voice & Video): the setting, its default, and
 * the guarantee that EVERY place that opens or re-opens the mic carries it.
 *
 * Behaviour of the live toggle itself (restart on the same sender, mute kept,
 * LiveKit's stored constraints kept in step, loop guard…) is in
 * micDeviceSync.test.ts; the constraint builder is in audioInput.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// secureLocalStore is a synchronous facade over AES-GCM IndexedDB hydrated at
// app boot; swap in a plain map so these cases exercise the settings logic.
vi.mock('./secureLocalStore', () => {
    const mem = new Map<string, string>();
    return {
        default: {
            getItem: (k: string) => mem.get(k) ?? null,
            setItem: (k: string, v: string) => { mem.set(k, v); },
            removeItem: (k: string) => { mem.delete(k); },
        },
    };
});

import secureLocalStore from './secureLocalStore';
import { DEFAULT_VOICE_SETTINGS, VOICE_SETTINGS_STORAGE_KEY, loadVoiceSettings } from '../hooks/useVoiceSettings';
import { classifyKvKey } from '../services/backupRegistry';
import { buildSettingsSnapshot } from './diagnostics/settingsSnapshot';
import { CALL_EVENT_KINDS } from './callEventLog';
import { voiceChainNeedsProcessor } from './voiceChain';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), 'utf8');

/** Source with comments removed, so prose that mentions a value cannot trip a scan. */
function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
    }
    return out;
}

describe('the setting and its default', () => {
    it('echoCancellation defaults to OFF', () => {
        expect(DEFAULT_VOICE_SETTINGS.echoCancellation).toBe(false);
    });

    it('nothing stored → OFF', () => {
        expect(loadVoiceSettings().echoCancellation).toBe(false);
    });

    it('settings saved before this existed (no field) → OFF, and everything else is kept', () => {
        secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ noiseSuppression: false, micVolume: 130 }));
        const s = loadVoiceSettings();
        expect(s.echoCancellation).toBe(false);
        expect(s.noiseSuppression).toBe(false);
        expect(s.micVolume).toBe(130);
    });

    it('an explicit OFF is honoured and survives a reload', () => {
        secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, echoCancellation: false }));
        expect(loadVoiceSettings().echoCancellation).toBe(false);
    });

    it('an explicit ON is honoured too: a user who has saved settings keeps their choice, the new default never overrides it', () => {
        secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, noiseSuppression: false, echoCancellation: true }));
        const s = loadVoiceSettings();
        expect(s.echoCancellation).toBe(true);
        expect(s.noiseSuppression).toBe(false);
    });

    it('a corrupt (non-boolean) saved value falls back to the default (OFF) rather than a truthy/falsy accident', () => {
        for (const bad of ['false', 'true', 0, 1, null, {}]) {
            secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ echoCancellation: bad }));
            expect(loadVoiceSettings().echoCancellation).toBe(false);
        }
    });
});

describe('independence from the voice chain', () => {
    it('echo cancellation is a capture flag, not a processor stage: it neither attaches nor needs the voice processor', () => {
        const off = { ...DEFAULT_VOICE_SETTINGS, noiseSuppression: false, voiceGate: false, eqEnabled: false, volumeNormalization: false, micVolume: 100 };
        const withEc = { ...off, echoCancellation: true };
        const withoutEc = { ...off, echoCancellation: false };
        expect(voiceChainNeedsProcessor(withEc)).toBe(false);
        expect(voiceChainNeedsProcessor(withoutEc)).toBe(false);
        // control: a real stage does.
        expect(voiceChainNeedsProcessor({ ...off, noiseSuppression: true })).toBe(true);
    });
});

describe('backup classification', () => {
    it('adds no new persisted key: the setting lives inside the already-classified voice-settings record', () => {
        expect(classifyKvKey(VOICE_SETTINGS_STORAGE_KEY, 'u1')).not.toBe('unknown');
        // …and that record is exported to the vault whole, so the new field rides along.
        expect(read('utils', 'crypto.ts')).toMatch(/voiceSettings:\s*parseOr<any>\(secureLocalStore\.getItem\('cipherline_voice_settings'\)/);
        expect(read('hooks', 'useVoiceSettings.ts')).not.toMatch(/setItem\(\s*'cipherline_[a-z_]*echo/);
    });

    it('NEGATIVE CONTROL: a separate, unregistered key for it would have been caught as unclassified', () => {
        expect(classifyKvKey('cipherline_echo_cancellation', 'u1')).toBe('unknown');
    });
});

describe('every capture path carries the setting (no hard-coded echoCancellation)', () => {
    const files = walk(srcRoot).map(f => ({ rel: relative(srcRoot, f).split('\\').join('/'), text: stripComments(readFileSync(f, 'utf8')) }));
    const CONSTANTS_MODULE = 'utils/audioInput.ts';

    it('POSITIVE CONTROL: the scan sees the one literal that is allowed to exist, in the constants module', () => {
        const hits = files.filter(f => /echoCancellation\s*:\s*(true|false)\b/.test(f.text)).map(f => f.rel);
        expect(hits).toContain(CONSTANTS_MODULE);
    });

    it('no source file outside the constants module spells echoCancellation: true/false', () => {
        const offenders = files
            .filter(f => f.rel !== CONSTANTS_MODULE && /echoCancellation\s*:\s*(true|false)\b/.test(f.text))
            .map(f => f.rel);
        expect(offenders).toEqual([]);
    });

    it('MIC_CAPTURE_CONSTRAINTS (the old frozen echoCancellation:false object) is gone', () => {
        expect(files.filter(f => /\bMIC_CAPTURE_CONSTRAINTS\b/.test(f.text)).map(f => f.rel)).toEqual([]);
    });

    it('every mic getUserMedia({audio}) goes through micCaptureConstraints', () => {
        const sites = files.filter(f => /getUserMedia\(\s*\{\s*audio/.test(f.text));
        // micPrewarm, the Settings mic test…
        expect(sites.map(f => f.rel).sort()).toEqual(['components/VoiceVideoSettings.tsx', 'utils/micPrewarm.ts']);
        for (const f of sites) expect(f.text, f.rel).toMatch(/micCaptureConstraints\(/);
    });

    it('join: CallPane builds audioCaptureDefaults from the setting, frozen like the device id', () => {
        const t = read('components', 'CallPane.tsx');
        expect(t).toMatch(/\[initialEchoCancellation\] = useState\(\(\) => resolveEchoCancellation\(voice\?\.settings\.echoCancellation\)\)/);
        expect(t).toMatch(/\.\.\.micCaptureConstraints\(initialEchoCancellation\)/);
    });

    it('join-time warm-up: Dashboard passes the live setting to prewarmMic', () => {
        const t = read('components', 'Dashboard.tsx');
        expect(t).toMatch(/prewarmMic\(resolveMicDeviceId\(micDeviceIdRef\.current\), echoCancellationRef\.current\)/);
        expect(t).toMatch(/echoCancellationRef\.current = resolveEchoCancellation\(voice\.settings\.echoCancellation\)/);
    });

    it('re-opens (default-follow, device recovery) read the CURRENT value through a lazy captureConstraints', () => {
        const t = read('components', 'SidebarConference.tsx');
        expect(t).toMatch(/captureConstraints: \(\) => micCaptureConstraints\(echoCancellationRef\.current\)/);
        expect(t).not.toMatch(/captureConstraints:\s*micCaptureConstraints\(/); // a frozen snapshot would be the bug
    });

    it('live toggle: the Room defaults are updated and the follower re-applies, with no unpublish', () => {
        const t = read('components', 'SidebarConference.tsx');
        expect(t).toMatch(/setRoomEchoCancellation\(room, echoCancellation\);\s*\n\s*void micSyncRef\.current\?\.applyCapture\(\);\s*\n\s*\}, \[room, echoCancellation\]\)/);
        // The toggle effect must not unpublish / stop the mic.
        const effect = t.slice(t.indexOf('setRoomEchoCancellation(room, echoCancellation)'), t.indexOf('[room, echoCancellation]'));
        expect(effect.length).toBeGreaterThan(20);
        expect(effect).not.toMatch(/unpublish|setMicrophoneEnabled|stopTrack/i);
    });

    it('a new mic publication and every livekit-initiated restart re-check the flags', () => {
        const t = read('components', 'SidebarConference.tsx');
        const watchdog = t.slice(t.indexOf('const onRestarted = () => {'));
        expect(watchdog.slice(0, watchdog.indexOf('};'))).toMatch(/micSyncRef\.current\?\.applyCapture\(\)/);
        expect(watchdog.slice(watchdog.indexOf('};'), watchdog.indexOf('let recovered'))).toMatch(/micSyncRef\.current\?\.applyCapture\(\)/);
    });

    it('the Settings mic test opens with the setting and re-opens when it is toggled', () => {
        const t = read('components', 'VoiceVideoSettings.tsx');
        expect(t).toMatch(/\.\.\.micCaptureConstraints\(resolveEchoCancellation\(settingsRef\.current\.echoCancellation\)\)/);
        expect(t).toMatch(/startMicStream\(settingsRef\.current\.micDeviceId\);\s*\n\s*\/\/ eslint-disable-next-line react-hooks\/exhaustive-deps\s*\n\s*\}, \[echoCancellationSetting\]\)/);
    });

    it('the native screen-share audio track still advertises no processing, via the constants module', () => {
        const t = read('components', 'SidebarConference.tsx');
        expect(t).toMatch(/\.\.\.origGetSettings\(\),\s*\n\s*\.\.\.UNPROCESSED_TRACK_SETTINGS,/);
    });
});

describe('the Settings row', () => {
    const t = read('components', 'VoiceVideoSettings.tsx');

    it('is labelled "Echo cancellation" with the agreed hint, wired to the setter', () => {
        // A settings Row: the "speakers only" line is on the page (note) AND in
        // the row's info tip ("i" next to the label). Owner copy 2026-10-20.
        expect(t).toContain('label="Echo cancellation"');
        expect(t).toContain("const ECHO_NOTE = 'Only recommended when using speakers — leave it off with headphones.';");
        expect(t).toContain('note={ECHO_NOTE}');
        expect(t).toMatch(/info=\{`Stops people hearing themselves when your mic picks up your speakers\. \$\{ECHO_NOTE\} Off by default\./);
        expect(t).toMatch(/<ClToggle checked=\{echoCancellationSetting\} onChange=\{voice\.setEchoCancellation\} aria-label="Echo cancellation" \/>/);
    });

    it('the hook exposes setEchoCancellation (returned and in the memo deps)', () => {
        const h = read('hooks', 'useVoiceSettings.ts');
        expect(h.match(/setEchoCancellation/g)!.length).toBeGreaterThanOrEqual(3);
    });
});

describe('diagnostics', () => {
    it('the settings snapshot carries echo_cancellation (on and off), and omits it when unknown', () => {
        expect(buildSettingsSnapshot({ voice: { echoCancellation: true } }).call).toMatchObject({ echo_cancellation: true });
        expect(buildSettingsSnapshot({ voice: { echoCancellation: false } }).call).toMatchObject({ echo_cancellation: false });
        expect(buildSettingsSnapshot({ voice: {} }).call).not.toHaveProperty('echo_cancellation');
    });

    it('the report preview has a human label for it', () => {
        expect(read('components', 'diagnostics', 'ReportPreview.tsx')).toContain("echo_cancellation: 'Echo cancellation'");
    });

    it('mic_echo_cancellation is a published call-event kind', () => {
        expect(CALL_EVENT_KINDS as readonly string[]).toContain('mic_echo_cancellation');
    });
});
