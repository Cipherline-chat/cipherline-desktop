import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * escapeOwnership — guards the whole point of utils/escapeStack.ts.
 *
 * "Esc backs out of what you're doing" only works if exactly ONE thing reacts
 * to a given Escape press: the topmost layer on the shared stack. Before that
 * stack existed, ~24 separate keydown listeners across ~26 files each decided
 * for themselves whether to react to Escape, so a single press could close a
 * dialog AND cancel an edit AND fire the global close-panel keybind — see
 * escapeStack.ts's own doc comment and the commit that introduced it.
 *
 * This test source-scans apps/desktop/src for anything that still compares a
 * keyboard event's key against Escape OUTSIDE escapeStack.ts, and fails with
 * the offending file(s) named. A small, explicit ALLOWLIST covers the
 * genuinely-justified exceptions (each with a one-line reason) — anything not
 * on it is a regression: either a new surface bypassing the stack, or an old
 * one that slipped back to a raw listener.
 *
 * Positive-controlled (see the sweep's own verification): temporarily adding
 * a fake `if (e.key === 'Escape')` listener to an arbitrary file makes this
 * test fail, naming that file; removing it makes it pass again.
 */

// Relative to apps/desktop/src, forward-slash form (matches how paths are
// built below regardless of OS path separator).
const ALLOWLIST: Record<string, string> = {
    'utils/escapeStack.ts':
        'the infrastructure itself — the ONE place allowed to look at the raw key',

    'components/KeybindSettings.tsx':
        'the combo-capture window listener explicitly SKIPS Escape (`if (e.key '
        + "=== 'Escape') return;`) and defers entirely to its own useEscape "
        + 'layer just below, which is what actually decides cancel-vs-bindable-'
        + 'combo — see that file\'s comments for why the decision has to live '
        + 'in one place',

    'components/VoiceVideoSettings.tsx':
        'same shape as KeybindSettings\'s recorder: the PTT combo-capture '
        + "window listener skips Escape (`if (e.key === 'Escape') return;`) and "
        + 'defers to its own useEscape layer, which always cancels (Escape is '
        + 'never itself a bindable PTT key here)',

    'components/server/ChannelMessageSearch.tsx':
        'deliberate exception — a persistent, always-mounted inline search '
        + '(not a layer that opens/closes), so Escape-to-clear is scoped by DOM '
        + 'focus via ordinary bubble-phase onKeyDown. That composes correctly '
        + "with escapeStack as-is: the stack's capture-phase listener consumes "
        + 'the press before it can bubble here whenever a real layer is open, '
        + 'so an open layer always wins even if this field still has focus. '
        + 'See the comment directly above the field in that file.',
};

// Matches an actual Escape-key COMPARISON — `.key === 'Escape'`,
// `.key !== "Escape"`, `keyCode === 27`, or a `case 'Escape':` — not just any
// occurrence of the word "Escape" (which would also catch, e.g.,
// useKeybinds.ts's UNRELATED lowercase combo-string encoding, or plain prose
// in a comment).
const ESCAPE_KEY_CHECK_RE =
    /\.key\s*[=!]==?\s*['"]Escape['"]|keyCode\s*===?\s*27\b|case\s+['"]Escape['"]/;

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (name !== 'node_modules') walk(p, out);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
            out.push(p);
        }
    }
    return out;
}

describe('escapeOwnership — every Escape-key check outside escapeStack.ts is allowlisted', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcRoot = join(here, '..'); // apps/desktop/src

    it('finds no un-allowlisted raw Escape handling', () => {
        const offenders: string[] = [];
        for (const file of walk(srcRoot)) {
            const rel = relative(srcRoot, file).split(sep).join('/');
            if (rel in ALLOWLIST) continue;
            const text = readFileSync(file, 'utf8');
            if (ESCAPE_KEY_CHECK_RE.test(text)) offenders.push(rel);
        }
        expect(
            offenders,
            'raw Escape handling found outside escapeStack.ts and the allowlist above — '
            + 'migrate it to useEscape(handler, active) (see hooks/useEscape.ts and '
            + 'components/primitives/ConfirmDialog.tsx for the pattern), or add a '
            + 'justified, one-line-reasoned entry to ALLOWLIST if it genuinely cannot '
            + 'go through the shared stack.',
        ).toEqual([]);
    });

    it('every allowlist entry still exists and still matches — a stale entry hides a real regression', () => {
        const stale: string[] = [];
        for (const rel of Object.keys(ALLOWLIST)) {
            const abs = join(srcRoot, ...rel.split('/'));
            let text: string;
            try {
                text = readFileSync(abs, 'utf8');
            } catch {
                stale.push(`${rel} (file no longer exists)`);
                continue;
            }
            if (!ESCAPE_KEY_CHECK_RE.test(text)) {
                stale.push(`${rel} (no longer contains an Escape-key check — remove it from ALLOWLIST)`);
            }
        }
        expect(stale).toEqual([]);
    });
});
