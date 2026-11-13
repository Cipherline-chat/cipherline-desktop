import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SC = fs.readFileSync(path.resolve(__dirname, 'SidebarConference.tsx'), 'utf8');
const KA = fs.readFileSync(path.resolve(__dirname, '../utils/shareKeepAlive.ts'), 'utf8');
const statsBlock = () => SC.slice(SC.indexOf('const onStatsForOverload'), SC.indexOf('const onEncoderSample'));

describe('wiring: the share keep-alive', () => {
    it('is fed the same stats report as the other watches, after them, and only on Windows plain display captures', () => {
        const b = statsBlock();
        expect(b).toContain('keepAliveGate.observe(at, stats)');
        expect(b.indexOf('keepAliveGate.observe(')).toBeGreaterThan(b.indexOf('starve.observe('));
        for (const needle of ['keepAlivePlatformOk(window.electronAPI?.platform)', '!cropPipelineRef.current', '!hdrPipelineRef.current', '!blocked', 'keepAliveDisabled(']) expect(b).toContain(needle);
    });
    it('the sender is put back on the capture BEFORE a retune changes the capture constraints', () => {
        const retune = SC.slice(SC.indexOf('retune: async (resolution, frameRate) =>'));
        const stopAt = retune.indexOf('await stopKeepAliveRef.current();');
        expect(stopAt).toBeGreaterThan(-1);
        expect(stopAt).toBeLessThan(retune.indexOf('retuneScreenShareInPlace('));
    });
    it('is stopped when the sampling effect ends (a republish, a swap, the share ending)', () => {
        expect(SC).toMatch(/React\.useEffect\(\(\) => \(\) => \{ void stopKeepAliveRef\.current\(\); \}, \[ssTrackSid, currentShare\]\);/);
    });
    it('the sharer is told only for a fullscreen-class program in front, once per share', () => {
        const b = statsBlock();
        expect(b).toContain('starveNotice(fg ?? null, true)');
        expect(b).toContain("claimShareOnce('capture_starved', shareRef)");
    });
    it('the keep-alive module never touches the capture constraints (that would change the frame size under the encoder)', () => {
        const code = KA.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        expect(code).not.toMatch(/applyConstraints/);
        expect(code).not.toMatch(/setParameters/);
        expect(code).not.toMatch(/publishTrack|unpublishTrack/);
    });
});
