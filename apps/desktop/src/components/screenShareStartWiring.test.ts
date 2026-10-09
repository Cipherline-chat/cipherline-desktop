/**
 * Source-wiring pins for the screen-share start path in SidebarConference —
 * the places only a full call render would exercise (same approach as
 * StopWatchingButton.test.ts). The behaviour itself is tested in
 * utils/screenShareStartState.test.ts, utils/shareStartBitrate.test.ts and
 * call/shareStartingButton.test.ts. Each pin has a control showing the
 * matcher can fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sc = readFileSync(resolve(__dirname, 'SidebarConference.tsx'), 'utf8');
const body = (name: string): string => {
    const i = sc.indexOf(`const ${name} = `);
    if (i < 0) return '';
    const j = sc.indexOf('\n    };\n', i);
    return sc.slice(i, j);
};

describe('share start wiring (SidebarConference)', () => {
    it('a confirmed source begins an attempt; a second one while starting is ignored', () => {
        const h = body('handleScreenShareSelect');
        expect(h).toMatch(/const attempt = tracker\.begin\(\);\s*if \(attempt === null\) \{[^}]*return;/);
        // settled in finally, so every path (throw included) releases the button
        expect(h).toMatch(/finally \{[\s\S]*tracker\.settle\(attempt, outcome, !!localParticipant\.isScreenShareEnabled\)/);
    });
    it('every other way in refuses while a start is running (toggle, picker, quick-share keybind)', () => {
        expect(body('toggleScreenshare')).toContain('if (shareStartRef.current?.starting) return;');
        expect(body('openScreenSharePicker')).toContain('if (shareStartRef.current?.starting) return;');
        const quick = sc.slice(sc.indexOf("'keybind:quick-screenshare'"), sc.indexOf("'keybind:quick-screenshare'") + 600);
        expect(quick).toContain('if (shareStartRef.current?.starting) return;');
    });
    it('the button ends its loading state the moment LiveKit has published, before audio/sender tuning', () => {
        const s = body('startScreenShareFrom');
        const pub = s.indexOf('await localParticipant.setScreenShareEnabled(true, {');
        const done = s.indexOf('onPublished();');
        const audio = s.indexOf('startNativeWindowAudio(nativeMode, options.sourceId)', done);
        expect(pub).toBeGreaterThan(0);
        expect(done).toBeGreaterThan(pub);
        expect(audio).toBeGreaterThan(done);
    });
    it('a capture/publish error goes to the share notice, not only the console', () => {
        const s = body('startScreenShareFrom');
        expect(s).toMatch(/\} catch \(err\) \{\s*pendingScreenShareRef\.current = null;\s*return reportShareStartError\(err\);/);
        expect(body('reportShareStartError')).toContain("setScreenShareNotice({ tone: 'warn', text: view.text });");
    });
    it('the share ceiling feeds the start bitrate before publishing', () => {
        const s = body('startScreenShareFrom');
        const set = s.indexOf('shareMaxBitrateRef.current = maxBitrate;');
        expect(set).toBeGreaterThan(0);
        expect(set).toBeLessThan(s.indexOf('await localParticipant.setScreenShareEnabled(true, {'));
        expect(sc).toMatch(/installShareStartBitrate\(\s*localParticipant as unknown as StartBitrateParticipant,\s*\(\) => shareMaxBitrateRef\.current,/);
    });
    it('ControlBar gets the starting flag', () => {
        expect(sc).toContain('screenShareStarting={shareStarting}');
    });
    it('control: the matchers fail on code that lacks the wiring', () => {
        expect(body('noSuchFunction')).toBe('');
        expect('const toggleScreenshare = () => { if (!lp) return; }').not.toContain('if (shareStartRef.current?.starting) return;');
        expect(/const attempt = tracker\.begin\(\);\s*if \(attempt === null\) \{[^}]*return;/.test('const attempt = tracker.begin();\nrun();')).toBe(false);
    });
});
