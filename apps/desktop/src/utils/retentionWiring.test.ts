import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Wiring guards for Dashboard.tsx's retention call sites. Dashboard is far too
 * large to mount in a unit test, and the bugs here were all of the "one of six
 * copies drifted" kind - so these pin the shape of the call sites themselves.
 */

const src = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');

/** The text of the argument list of every `sweepRetention(` CALL in Dashboard. */
function sweepCallArgs(): string[] {
    const out: string[] = [];
    const re = /\bsweepRetention\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        // skip the import line
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        if (/^\s*import\b/.test(src.slice(lineStart, m.index))) continue;
        let depth = 1;
        let i = m.index + m[0].length;
        for (; i < src.length && depth > 0; i++) {
            if (src[i] === '(') depth++;
            else if (src[i] === ')') depth--;
        }
        out.push(src.slice(m.index + m[0].length, i - 1));
    }
    return out;
}

describe('Dashboard retention call sites', () => {
    const calls = sweepCallArgs();

    it('meta: found the sweep call sites', () => {
        // 2 sweeps + purge channels + per-conversation + per-type + 2 dry-run counters
        expect(calls.length).toBeGreaterThanOrEqual(7);
    });

    it('EVERY sweepRetention call passes a pinned-ids argument (pin = save forever)', () => {
        // The purge-now flows used to call sweepRetention(state, policy) with no
        // fourth argument and so deleted pinned / server-saved messages.
        for (const args of calls) {
            expect(args, args.slice(0, 120)).toMatch(/pinned/);
        }
    });

    it('nobody re-implements the override chain inline any more', () => {
        // The per-server / per-conversation override JSON is parsed in ONE place.
        expect(src).not.toMatch(/JSON\.parse\(raw\) as \{ messageRetention\?: string; attachmentRetention\?: string \}/);
        expect(src).not.toMatch(/as ConvRetentionOverride/);
        expect(src).not.toMatch(/messageRetention:\s+perServer\.messageRetention\s+as any/);
    });

    it('manual "Purge" / "Clear all" also remove the cached attachment bytes of what they delete', () => {
        const clearAt = src.indexOf('const handleClearAllMessages = useCallback');
        const purgeAt = src.indexOf('const handlePurgeConversation = useCallback');
        expect(clearAt).toBeGreaterThan(0);
        expect(src.slice(clearAt, purgeAt)).toContain('dropAttachmentBlobsOf(');
        expect(src.slice(purgeAt, purgeAt + 1600)).toContain('dropAttachmentBlobsOf(');
    });

    it('opening Server Options does not write a per-server override (only a user change does)', () => {
        const modal = readFileSync(join(__dirname, '..', 'components', 'server', 'ServerMemberOptionsModal.tsx'), 'utf8');
        const effectAt = modal.indexOf('secureLocalStore.setItem(\n                retentionStorageKey');
        expect(effectAt).toBeGreaterThan(0);
        // the guard sits in the same effect, before the write
        const effectStart = modal.lastIndexOf('useEffect(() => {', effectAt);
        expect(modal.slice(effectStart, effectAt)).toContain('if (!retentionDirtyRef.current) return;');
        // and every state write goes through the dirty-marking wrapper
        expect(modal).not.toMatch(/\bsetRetention\((?!next\))/);
    });

    it('the channel history fetchers filter incoming rows through retention before folding', () => {
        const refresh = src.slice(src.indexOf('const refreshChannelHistory = useCallback'));
        const refreshBody = refresh.slice(0, refresh.indexOf('const channelKeyEnsureInFlightRef'));
        expect(refreshBody).toContain('splitExpiredIncoming(');
        expect(refreshBody.indexOf('splitExpiredIncoming(')).toBeLessThan(refreshBody.indexOf('foldChannelHistory('));
        // and the key request is decided from the FILTERED page
        expect(refreshBody).toContain('pageNeedsKeyRequest(sorted, purgedIds)');

        const older = src.slice(src.indexOf('const loadOlderChannelMessages = useCallback'));
        const olderBody = older.slice(0, older.indexOf('const refreshChannelHistory'));
        expect(olderBody).toContain('splitExpiredIncoming(');
    });
});
