import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SidebarConference and the picker cannot be mounted under vitest, so (like
 * shareFpsSurround.wiring.test.ts) this reads the source to pin the WIRING of
 * the fg_* diagnostics on share_fps / share_background.
 * The decisions are tested where they live (shareFgDiag.test.ts).
 */
const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
const SC = src('SidebarConference.tsx');
const GUARD = src('call/ShareBoostGuard.tsx');
const TOAST = src('../contexts/ToastContext.tsx');

const count = (hay: string, needle: string | RegExp) =>
    typeof needle === 'string' ? hay.split(needle).length - 1 : (hay.match(needle)?.length ?? 0);

/** The top-level keys of the object literal logged for `kind`, from the source. */
function loggedKeysIn(text: string, kind: string): string[] {
    const start = text.indexOf(`logCallEvent('${kind}', {`);
    expect(start, kind).toBeGreaterThan(-1);
    const open = text.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) { end = i; break; }
    }
    // Top-level `key:` / shorthand keys: split on commas outside brackets/parens.
    const body = text.slice(open + 1, end);
    const keys: string[] = [];
    let level = 0;
    let token = '';
    const flush = () => {
        const m = /^\s*(?:\/\/[^\n]*\n\s*)*([A-Za-z_][A-Za-z0-9_]*)\s*(?::|$)/.exec(token);
        if (m) keys.push(m[1]);
        token = '';
    };
    for (const ch of body) {
        if ('([{'.includes(ch)) level++;
        else if (')]}'.includes(ch)) level--;
        if (ch === ',' && level === 0) flush();
        else token += ch;
    }
    flush();
    return keys;
}
const loggedKeys = (kind: string) => loggedKeysIn(SC, kind);

describe('share_fps / share_background carry what had the screen, inside the log\'s 11 keys', () => {
    it('share_fps: fg_state, fg_exe, fg_cover from the sampler\'s fg - and at most 11 keys', () => {
        const keys = loggedKeys('share_fps');
        expect(keys).toEqual(expect.arrayContaining(['fg_state', 'fg_exe', 'fg_cover', 'src_fps', 'enc_fps', 'sent_fps', 'target', 'focus']));
        expect(keys.length).toBeLessThanOrEqual(11);
        expect(SC).toContain('fg_state: fgLog.fg_state, fg_exe: fgLog.fg_exe, fg_cover: fgLog.fg_cover,');
        expect(SC).toContain('const fgLog = foregroundLogFields(fg);');
        expect(SC).toContain('report: (d, fg) => {');
    });

    it('share_background: fg_state, fg_exe, fg_cover from the probe\'s fg - and at most 11 keys', () => {
        const keys = loggedKeys('share_background');
        expect(keys).toEqual(expect.arrayContaining(['cause', 'verdict', 'fg_state', 'fg_exe', 'fg_cover', 'capture_before', 'sent_before', 'capture_after', 'sent_after', 'grab_ms', 'interval_ms']));
        expect(keys.length).toBeLessThanOrEqual(11);
        expect(SC).toContain('fg_state: fgLog.fg_state,');
        expect(SC).toContain('const fgLog = foregroundLogFields(r.fg ?? null);');
    });

    it('positive control: the key reader sees an overlong literal, nested commas and comments included', () => {
        const long = "logCallEvent('x', { a: 1, b: 2, c: f(1, 2), d: r ? { x: 1, y: 2 } : '', e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11, l: 12 })";
        const keys = loggedKeysIn(long, 'x');
        expect(keys).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']);
        expect(keys.length).toBeGreaterThan(11);
        expect(loggedKeysIn("logCallEvent('y', {\n  // a note\n  p: 1, q,\n})", 'y')).toEqual(['p', 'q']);
    });

    it('the sampler and the probe are each handed the same foreground reader, keyed by the share\'s source id', () => {
        expect(count(SC, 'getForeground: () => fetchForegroundDiag(share.sourceId),')).toBe(2);
    });

    it('the removed "share the game window instead" hint leaves nothing behind', () => {
        expect(SC).not.toMatch(/FullscreenHint|accountHintSeenStore|pickerPreset|share_hint|onForeground/);
        expect(src('ScreenSharePickerModal.tsx')).not.toMatch(/preselectExe|findWindowSourceByExe|initialTab/);
    });
});

describe('the toast action (still used by other toasts)', () => {
    it('supports ONE optional action that dismisses the toast and runs the callback', () => {
        expect(TOAST).toContain('action?: { label: string; onClick: () => void };');
        expect(TOAST).toMatch(/dismiss\(t\.id\);\s*try \{ run\(\); \}/);
    });
});

describe('share_power is logged where the Room lives', () => {
    it('ShareBoostGuard subscribes to main\'s share:power report, narrows it, logs it, and unsubscribes', () => {
        expect(GUARD).toContain('api.onSharePower?.((raw) => {');
        expect(GUARD).toContain('parseSharePowerReport(raw)');
        expect(GUARD).toContain("logCallEvent('share_power', {");
        expect(GUARD).toContain('offPower?.()');
    });
});
