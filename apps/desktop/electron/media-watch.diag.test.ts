import { describe, it, expect } from 'vitest';
import { describeRead, describeWatch } from './media-watch';
import { DETAIL_RE } from './freeze-monitor';
import type { MediaReadResult, NowPlaying } from './media-session';

const song = (o: Partial<NowPlaying> = {}): NowPlaying => ({
    kind: 'listening', source: 'spotify', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine',
    durationMs: 330_000, positionMs: 0, art: null, player: 'Spotify', ...o,
});

describe('media diagnostics are content-free', () => {
    const reads: MediaReadResult[] = [
        { supported: true, playing: song(), issue: null },
        { supported: true, playing: song({ kind: 'watching', source: 'youtube', title: 'Secret Video', artist: 'Some Channel', player: 'Chrome' }), issue: null },
        { supported: true, playing: null, issue: null },
        { supported: true, playing: null, issue: { kind: 'helper_failed' } },
        { supported: true, playing: null, issue: { kind: 'win_unavailable' } },
        { supported: true, playing: null, issue: { kind: 'excluded', why: 'browser', player: 'Chrome' } },
        { supported: true, playing: null, issue: { kind: 'excluded', why: 'watching', player: 'VLC' } },
        { supported: false, reason: 'no_powershell' },
    ];
    it('every line passes the Performance log pattern and names no title, artist, source or player', () => {
        for (const r of reads) {
            const line = describeRead(r);
            expect(DETAIL_RE.test(line), line).toBe(true);
            expect(line).not.toMatch(/Teardrop|Massive|Secret|Channel|spotify|youtube|chrome|vlc/i);
        }
    });
    it('says what happened', () => {
        expect(reads.map(describeRead)).toEqual([
            'supported=1 playing=listening issue=none',
            'supported=1 playing=watching issue=none',
            'supported=1 playing=none issue=none',
            'supported=1 playing=none issue=helper_failed',
            'supported=1 playing=none issue=win_unavailable',
            'supported=1 playing=none issue=excluded_browser',
            'supported=1 playing=none issue=excluded_watching',
            'supported=0 reason=no_powershell',
        ]);
    });
    it('the schedule line carries only the two switches', () => {
        expect(describeWatch({ includeBrowser: true, includeWatching: false })).toBe('on browser=1 watching=0');
        expect(describeWatch(null)).toBe('off');
        expect(DETAIL_RE.test(describeWatch({ includeBrowser: false, includeWatching: true }))).toBe(true);
    });
});
