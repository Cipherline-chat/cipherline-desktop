import { describe, it, expect } from 'vitest';
import { helperArgv, isNativeShareEncoderEnabled, parseHelperEvent, helperExitReason, RESTORE_TOKEN_RE } from './native-share-encoder';

describe('native share encoder (main side, flag-gated)', () => {
    it('is off by default and only on for exactly "1"', () => {
        expect(isNativeShareEncoderEnabled({})).toBe(false);
        expect(isNativeShareEncoderEnabled({ CIPHERLINE_NATIVE_SHARE_ENCODER: 'yes' })).toBe(false);
        expect(isNativeShareEncoderEnabled({ CIPHERLINE_NATIVE_SHARE_ENCODER: '1' })).toBe(true);
    });
    it('builds argv', () => {
        expect(helperArgv({ helperPath: 'x', backend: 'vaapi', width: 1920, height: 1080, fps: 90, bitrateBps: 2e7 }).join(' '))
            .toBe('--serve --backend vaapi --width 1920 --height 1080 --fps 90 --bitrate 20000000');
    });
    it('NEGATIVE: rejects non-integer / non-positive geometry (no argv injection)', () => {
        expect(() => helperArgv({ helperPath: 'x', backend: 'vaapi', width: 0, height: 1080, fps: 90, bitrateBps: 1 })).toThrow();
        expect(() => helperArgv({ helperPath: 'x', backend: 'vaapi', width: 1920.5, height: 1080, fps: 90, bitrateBps: 1 })).toThrow();
    });
});

describe('capture mode argv', () => {
    const base = { helperPath: 'x', backend: 'nvenc' as const, width: 3440, height: 1440, fps: 90, bitrateBps: 3e7 };
    it('builds a --capture command line', () => {
        expect(helperArgv({ ...base, capture: { source: 'any', persist: true } }).join(' '))
            .toBe('--capture --backend nvenc --width 3440 --height 1440 --fps 90 --bitrate 30000000 --source any --persist');
    });
    it('a restore token is announced as --restore-stdin and NEVER put in argv', () => {
        const argv = helperArgv({ ...base, capture: { source: 'monitor', persist: false, restoreToken: 'abc-123_DEF' } });
        expect(argv).toContain('--restore-stdin');
        expect(argv.join(' ')).not.toContain('abc-123_DEF');
    });
    it('NEGATIVE: a restore token with shell/newline/stdin-injection characters is rejected', () => {
        for (const bad of ['a b', 'a\nSTOP', 'x;rm -rf /', '', 'a'.repeat(513)]) {
            if (bad === '') continue;
            expect(() => helperArgv({ ...base, capture: { source: 'any', persist: true, restoreToken: bad } })).toThrow();
        }
        expect(RESTORE_TOKEN_RE.test('ok-token_1.2:3/4=+')).toBe(true);
    });
});

describe('helper exit reasons', () => {
    it('maps every documented exit code to a stable reason', () => {
        expect(helperExitReason(12)).toBe('portal_denied');
        expect(helperExitReason(16)).toBe('session_limit');
        expect(helperExitReason(17)).toBe('driver_too_old');
        expect(helperExitReason(5)).toBe('source_ended');
        expect(helperExitReason(null)).toBe('killed');
        expect(helperExitReason(99)).toBe('helper_exit_99');
    });
});

describe('parseHelperEvent (stderr -> renderer allowlist)', () => {
    it('parses a stats event and clamps numbers', () => {
        const e = parseHelperEvent('{"event":"stats","encoder":"nvenc","w":3440,"h":1440,"fps":90,"in_fps":91,"dropped":2,"idle_repeats":0,"enc_ms_p50":3.3,"enc_ms_p95":4.1,"enc_ms_max":4.4,"kbps":30000,"eff_fps":90}');
        expect(e).toMatchObject({ event: 'stats', encoder: 'nvenc', w: 3440, fps: 90, encMsP95: 4.1 });
    });
    it('carries the stream position only when it is a well-formed in-range integer pair', () => {
        const base = '"event":"portal","width":1920,"height":1080,"source_type":1,"cursor":"embedded","restore_token":"t"';
        expect(parseHelperEvent(`{${base},"has_pos":1,"x":1920,"y":0,"start_ms":240}`)).toMatchObject({ position: { x: 1920, y: 0 }, startMs: 240 });
        expect(parseHelperEvent(`{${base},"has_pos":1,"x":-1920,"y":-5}`)).toMatchObject({ position: { x: -1920, y: -5 } });
        // the portal said nothing: no position, and (0,0) must not be read as one
        expect(parseHelperEvent(`{${base},"has_pos":0,"x":0,"y":0}`)).not.toHaveProperty('position');
        expect(parseHelperEvent(`{${base}}`)).not.toHaveProperty('position');
        // junk: out of range, fractional, wrong type
        for (const bad of ['"x":999999,"y":0', '"x":1.5,"y":0', '"x":"7","y":0', '"x":null,"y":0']) {
            expect(parseHelperEvent(`{${base},"has_pos":1,${bad}}`)).not.toHaveProperty('position');
        }
        expect(parseHelperEvent(`{${base},"start_ms":-4}`)).toMatchObject({ startMs: 0 });
    });
    it('keeps the portal restore token only if it is well-formed', () => {
        expect(parseHelperEvent('{"event":"portal","width":3440,"height":1440,"source_type":1,"cursor":"embedded","restore_token":"tok_1"}')).toMatchObject({ restoreToken: 'tok_1' });
        expect(parseHelperEvent('{"event":"portal","restore_token":"bad token\\nSTOP"}')).toMatchObject({ restoreToken: '' });
    });
    it('parses the lighter-copy events; a low_failed line is NOT the fatal {"error"} kind (the share goes on)', () => {
        expect(parseHelperEvent('{"event":"low","state":"on","reason":"","w":1280,"h":720}')).toEqual({ event: 'low', state: 'on', reason: '', w: 1280, h: 720 });
        expect(parseHelperEvent('{"event":"low","state":"off","reason":"resize","w":0,"h":0}')).toMatchObject({ state: 'off', reason: 'resize' });
        expect(parseHelperEvent('{"event":"low_failed","code":"low_session_limit","message":"NVENC: out of sessions"}')).toEqual({ event: 'low_failed', code: 'low_session_limit', message: 'NVENC: out of sessions' });
        expect(parseHelperEvent('{"event":"stats","low":1,"low_fps":30,"low_kbps":2800}')).toMatchObject({ low: true, lowFps: 30, lowKbps: 2800 });
    });
    it('turns an {"error"} line into an error event', () => {
        expect(parseHelperEvent('{"error":"portal Start: refused","code":"portal_denied"}')).toEqual({ event: 'error', message: 'portal Start: refused', code: 'portal_denied' });
    });
    it('NEGATIVE: non-JSON, arrays, unknown events, oversized lines and control characters never pass through', () => {
        expect(parseHelperEvent('not json')).toBeNull();
        expect(parseHelperEvent('[1,2]')).toBeNull();
        expect(parseHelperEvent('{"event":"rm-rf"}')).toBeNull();
        expect(parseHelperEvent('{"event":"ended","reason":"' + 'x'.repeat(3000) + '"}')).toBeNull();
        expect(parseHelperEvent('{"event":"ended","reason":"a\\u0000b\\u001bc"}')).toEqual({ event: 'ended', reason: 'a b c' });
        expect(parseHelperEvent('{"event":"stats","fps":"90","w":1e99}')).toMatchObject({ fps: 0, w: 65536 });
    });
});

