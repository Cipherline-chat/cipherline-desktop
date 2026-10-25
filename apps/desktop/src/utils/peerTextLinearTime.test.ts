/**
 * Received message text is chosen by the sender, and the scans below run on it
 * with no click (notification body, conversation-list line, every render of
 * the row). An unbounded token regex made `'<:a:'.repeat(n)` quadratic: about
 * 20 s per pass at 100k characters. These tests hold every such scan to a
 * linear budget on worst-case input, and pin the linear scanner to the regex
 * grammar it replaces so the speed-up changed no output.
 */
import { describe, it, expect } from 'vitest';
import {
    MENTION_TOKEN_RE,
    findMentionTokens,
    mentionTokenMatcher,
    mentionsToPlainText,
    mentionsToDisplayText,
    extractMentionsFromText,
    messageTextMentionsRole,
    messageTextMentionsUser,
} from './mentionTokens';
import { EMOJI_TOKEN_RE, isEmojiOnly, countEmojis } from './emojiText';
import { findChannelRefSpans, isInsideCode, type ChannelRef } from './channelRefs';
import { messageTextMatches, searchExcerpt, displayPreviewOf, clipForPreview, PREVIEW_SCAN_MAX } from './messagePreviewText';
import { tokenMapsFromWireText } from './composerWireText';
import { collapsedPreview } from './longMessage';
import { matchesKeyword } from './mentionKeywords';
import { contentProblem, MAX_RECEIVED_TEXT_LENGTH } from './contentValidation';
import { MAX_TEXT_MESSAGE_LENGTH } from '../constants';

const N = 200_000;
const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);

/** Adversarial shapes: unclosed token heads at every few characters. */
const PAYLOADS: Record<string, string> = {
    'unclosed emoji <:a:': fill('<:a:'),
    'unclosed user <@u:a:': fill('<@u:a:'),
    'unclosed role <@r:a:': fill('<@r:a:'),
    'no colon <@u:x': fill('<@u:x'),
    'bare <:': fill('<:'),
    'max id then no >': fill(`<:${'a'.repeat(63)}:`),
    'max label then no >': fill(`<@u:${'a'.repeat(63)}:${'b'.repeat(127)}`),
    'valid tokens': fill('<@u:11111111-2222-3333-4444-555555555555:dawson> <:party:abc> @everyone '),
    'channel refs': fill(' #a'),
    'backticks + refs': fill(' `#a` ```x``` #a\n'),
    'at signs': fill('@@everyon@her'),
};

/** Best of five, so scheduler noise on a loaded box (the full suite runs files in parallel) does not fail it; a quadratic scan is seconds, not tens of ms. */
function bestMs(fn: () => unknown): number {
    let best = Infinity;
    for (let k = 0; k < 5; k++) {
        const t = performance.now();
        fn();
        best = Math.min(best, performance.now() - t);
    }
    return best;
}

const BUDGET_MS = 50;
const refs: ChannelRef[] = [{ id: 'c1', name: 'a' }, { id: 'c2', name: 'general chat' }];

describe('every scan of received text is linear (200k worst-case input, < 50 ms a pass)', () => {
    const scans: Record<string, (t: string) => unknown> = {
        findMentionTokens: t => findMentionTokens(t),
        'findMentionTokens(emoji)': t => findMentionTokens(t, 'emoji'),
        mentionsToPlainText: t => mentionsToPlainText(t, () => undefined),
        mentionsToDisplayText: t => mentionsToDisplayText(t),
        extractMentionsFromText: t => extractMentionsFromText(t),
        messageTextMentionsRole: t => messageTextMentionsRole(t, new Set(['zzz'])),
        messageTextMentionsUser: t => messageTextMentionsUser(t, 'zzz'),
        isEmojiOnly: t => isEmojiOnly(t),
        countEmojis: t => countEmojis(t),
        findChannelRefSpans: t => findChannelRefSpans(t, refs),
        messageTextMatches: t => messageTextMatches(t, 'needle'),
        searchExcerpt: t => searchExcerpt(t, 'needle'),
        displayPreviewOf: t => displayPreviewOf({ text: t }),
        tokenMapsFromWireText: t => tokenMapsFromWireText(t),
        collapsedPreview: t => collapsedPreview(t),
        matchesKeyword: t => matchesKeyword(t, ['needle', 'a']),
    };
    for (const [payloadName, payload] of Object.entries(PAYLOADS)) {
        it(payloadName, () => {
            for (const [scanName, scan] of Object.entries(scans)) {
                scan(payload); // warm the JIT / regex tier-up
                const ms = bestMs(() => scan(payload));
                expect({ scan: scanName, ms: ms < BUDGET_MS ? 'ok' : ms.toFixed(1) }).toEqual({ scan: scanName, ms: 'ok' });
            }
        });
    }
});

// ── the scanner finds exactly what the (bounded) regex grammar finds ─────────

function regexMatches(text: string, re: RegExp): Array<[number, string]> {
    const r = new RegExp(re.source, 'g');
    const out: Array<[number, string]> = [];
    let m: RegExpExecArray | null;
    while ((m = r.exec(text)) !== null) out.push([m.index, m[0]]);
    return out;
}
const scanMatches = (text: string, kind: 'all' | 'emoji' = 'all') =>
    findMentionTokens(text, kind).map(m => [m.index, m[0]] as [number, string]);

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('findMentionTokens matches MENTION_TOKEN_RE / EMOJI_TOKEN_RE exactly', () => {
    it('real tokens', () => {
        const t = 'hi <@u:11111111-2222-3333-4444-555555555555:dawson> and <@r:r1:Mods Team> '
            + '<:party:e1> @everyone @here <@x:y:z> <:a:> <::b> trailing <@u:a';
        expect(scanMatches(t)).toEqual(regexMatches(t, MENTION_TOKEN_RE));
        expect(scanMatches(t, 'emoji')).toEqual(regexMatches(t, EMOJI_TOKEN_RE));
        expect(scanMatches(t).map(m => m[1])).toEqual([
            '<@u:11111111-2222-3333-4444-555555555555:dawson>', '<@r:r1:Mods Team>', '<:party:e1>', '@everyone', '@here',
        ]);
    });

    it('at the length bounds', () => {
        for (const idLen of [0, 1, 63, 64, 65]) {
            for (const labelLen of [0, 1, 127, 128, 129]) {
                const t = `x<@u:${'i'.repeat(idLen)}:${'l'.repeat(labelLen)}>y<:${'n'.repeat(idLen)}:${'d'.repeat(labelLen)}>`;
                expect(scanMatches(t)).toEqual(regexMatches(t, MENTION_TOKEN_RE));
                expect(scanMatches(t, 'emoji')).toEqual(regexMatches(t, EMOJI_TOKEN_RE));
            }
        }
    });

    it('random strings over the grammar alphabet (5000 cases)', () => {
        const next = rng(42);
        const alphabet = ['<', '@', 'u', 'r', ':', '>', 'a', ' ', '\n', 'e', '<@u:', '<:', '@everyone', '@here', 'x'.repeat(70)];
        for (let c = 0; c < 5000; c++) {
            let t = '';
            const len = Math.floor(next() * 40);
            for (let k = 0; k < len; k++) t += alphabet[Math.floor(next() * alphabet.length)];
            expect(scanMatches(t)).toEqual(regexMatches(t, MENTION_TOKEN_RE));
            expect(scanMatches(t, 'emoji')).toEqual(regexMatches(t, EMOJI_TOKEN_RE));
        }
    });

    it('mentionTokenMatcher walks the same matches as a global RegExp and resets at the end', () => {
        const t = 'a <@u:1:x> b <:e:2> @here';
        const m = mentionTokenMatcher();
        const seen: string[] = [];
        let x;
        while ((x = m.exec(t)) !== null) seen.push(x[0]);
        expect(seen).toEqual(['<@u:1:x>', '<:e:2>', '@here']);
        expect(m.exec(t)?.[0]).toBe('<@u:1:x>'); // a fresh walk
    });
});

// ── the one-pass code-state scan agrees with isInsideCode on every prefix ────

function referenceSpans(text: string, rs: readonly ChannelRef[]) {
    const byLength = [...rs].sort((a, b) => b.name.length - a.name.length);
    const spans: Array<{ start: number; end: number; id: string }> = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '#') continue;
        if (i > 0 && !/\s/.test(text[i - 1])) continue;
        for (const ref of byLength) {
            if (!text.startsWith(ref.name, i + 1)) continue;
            const end = i + 1 + ref.name.length;
            if (end < text.length && !/[\s<>@'"!?.,;:)\]}]/.test(text[end])) continue;
            if (isInsideCode(text.slice(0, i))) break;
            spans.push({ start: i, end, id: ref.id });
            i = end - 1;
            break;
        }
    }
    return spans;
}

describe('findChannelRefSpans code detection matches isInsideCode', () => {
    it('random texts with fences, backticks and newlines (5000 cases)', () => {
        const next = rng(7);
        const alphabet = [' #a', ' #general chat', '`', '```', '\n', 'x', ' ', '#a', '````'];
        for (let c = 0; c < 5000; c++) {
            let t = '';
            const len = Math.floor(next() * 30);
            for (let k = 0; k < len; k++) t += alphabet[Math.floor(next() * alphabet.length)];
            const got = findChannelRefSpans(t, refs).map(s => ({ start: s.start, end: s.end, id: s.ref.id }));
            expect(got).toEqual(referenceSpans(t, refs));
        }
    });
});

// ── wrong-typed text never throws ────────────────────────────────────────────

describe('non-string text from a malformed message never throws', () => {
    const bad: unknown[] = [42, true, {}, { a: 1 }, ['x'], null, undefined];
    it.each(bad.map(v => [JSON.stringify(v) ?? 'undefined', v]))('%s', (_label, v) => {
        const t = v as string;
        expect(mentionsToPlainText(t, () => undefined)).toBe('');
        expect(() => mentionsToDisplayText(t)).not.toThrow();
        expect(extractMentionsFromText(t)).toEqual([]);
        expect(messageTextMentionsRole(t, new Set(['r']))).toBe(false);
        expect(messageTextMentionsUser(t, 'u')).toBe(false);
        expect(isEmojiOnly(t)).toBe(false);
        expect(countEmojis(t)).toBe(0);
        expect(findMentionTokens(t)).toEqual([]);
        expect(matchesKeyword(t, ['x'])).toBeNull();
        expect(clipForPreview(v)).toBe('');
        expect(displayPreviewOf({ text: v })).toBeUndefined();
    });
});

describe('clipForPreview', () => {
    it('keeps short text and cuts long text without splitting a surrogate pair', () => {
        expect(clipForPreview('hello')).toBe('hello');
        const long = 'a'.repeat(PREVIEW_SCAN_MAX - 1) + '😀' + 'b'.repeat(10);
        const out = clipForPreview(long);
        expect(out.length).toBe(PREVIEW_SCAN_MAX - 1);
        expect(clipForPreview('x'.repeat(PREVIEW_SCAN_MAX + 5)).length).toBe(PREVIEW_SCAN_MAX);
    });
});

describe('received text has a hard length cap', () => {
    it('text / edit over MAX_RECEIVED_TEXT_LENGTH is refused at the content boundary; at the cap it passes', () => {
        const at = 'x'.repeat(MAX_RECEIVED_TEXT_LENGTH);
        expect(contentProblem({ type: 'text', text: at })).toBeNull();
        expect(contentProblem({ type: 'text', text: at + 'x' })).not.toBeNull();
        expect(contentProblem({ type: 'edit', target_id: 't', text: at + 'x' })).not.toBeNull();
        // The composer's own cap is well inside it.
        expect(MAX_RECEIVED_TEXT_LENGTH).toBeGreaterThanOrEqual(MAX_TEXT_MESSAGE_LENGTH * 2);
    });
});
