/**
 * Every read of message text in the app, classified (same idea as
 * services/backupRegistry's source scan).
 *
 * Message text carries formatting syntax (`**testing**`, `||secret||`,
 * fences, `[label](url)`), so anything that SHOWS it outside the rendered
 * message body must go through `toPlainText` (utils/messagePreviewText.ts).
 * This test finds every `content.text` / `content?.text` read in the source
 * and fails on one that is neither routed through toPlainText on that line
 * nor listed below with the reason it may read the raw text. A new preview
 * surface therefore can't quietly show `**testing**` in a notification.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');

/** Raw-text reads that are allowed, by file and a fragment of the line, and why. */
const RAW_TEXT_SITES: { file: string; line: string; why: string }[] = [
    // ── the message body itself ────────────────────────────────────────────
    { file: 'components/ChatPane.tsx', line: "const sourceText: string = typeof msg.content.text === 'string'", why: 'the rendered message body (FormattedText, after stripBareInviteLinks)' },
    { file: 'components/ChatPane.tsx', line: "const text: string = msg.content.text ?? '';", why: 'embed URLs, via embedUrlsOf (parses)' },
    { file: 'components/ChatPane.tsx', line: "const t = String(msg.content?.text ?? '').trim();", why: 'where the undelivered "!" sits; nothing shown' },
    { file: 'components/ChatPane.tsx', line: "const sysText  = (msg.content.text as string)", why: 'local system rows: app-authored text, not user formatting' },
    // ── kept raw on purpose ─────────────────────────────────────────────────
    { file: 'components/ChatPane.tsx', line: "const rawText = msg.content.text || '';", why: 'opening an EDIT: the composer shows the raw syntax' },
    { file: 'components/ChatPane.tsx', line: "? (msg.content?.text ?? '')", why: 'Report Message evidence: the exact text, as sent' },
    // ── decisions, never displayed ──────────────────────────────────────────
    { file: 'components/ChatPane.tsx', line: "const msgText = msg.content?.type === 'text' ? (msg.content.text ?? '') : '';", why: 'mention highlight test' },
    { file: 'components/ChatPane.tsx', line: "messageTextMatches(m.content.text, chatSearch)", why: 'search match; messageTextMatches strips formatting' },
    { file: 'components/Dashboard.tsx', line: "messageTextMentionsUser(m.content.text ?? '', userId)", why: 'mention detection' },
    { file: 'utils/notificationDecision.ts', line: "const text = content.type === 'text' ? (content.text ?? '') : '';", why: 'mention / keyword decision' },
    { file: 'components/PinnedMessagesPanel.tsx', line: "const text = msg?.content?.text ?? msg?.content?.filename ?? '';", why: 'search match; messageTextMatches strips formatting' },
    // ── handed to a surface that applies toPlainText itself ─────────────────
    { file: 'components/Dashboard.tsx', line: ": m.content.type === 'text' ? (m.content.text ?? '')", why: 'DM notification payload; useNotificationDispatch shows toPlainText(text)' },
    { file: 'components/Dashboard.tsx', line: "const textBody = content?.type === 'text' ? (content.text ?? '') : '';", why: 'channel notification payload; useNotificationDispatch shows toPlainText(text)' },
    { file: 'components/Dashboard.tsx', line: "text: typeof m.content?.text === 'string' ? m.content.text : '',", why: 'channel search rows; ChannelMessageSearch shows searchExcerpt (strips)' },
    { file: 'components/PinnedMessagesPanel.tsx', line: "embedUrlsOf(String(msg.content.text ?? ''))", why: 'thumbnail URL, via embedUrlsOf (parses)' },
    // ── data plumbing (edits / validation), not display ─────────────────────
    { file: 'components/Dashboard.tsx', line: 'withEditFont({ ...currentThread[targetIdx].content, text: m.content.text }', why: 'applying an edit' },
    { file: 'components/Dashboard.tsx', line: 'editedContent(thread[idx].content, content.text, content.channel_refs, content.font, content.size, content)', why: 'applying an edit' },
    { file: 'components/ChatPane.tsx', line: "previewText={cardDialog?.mode === 'restyle' ? mentionsToDisplayText(String(cardDialog.msg.content?.text ?? ''))", why: 'card editor preview: rendered through renderFormatted, like the row' },
    { file: 'utils/dmInbound.ts', line: 'withEditFont({ ...currentThread[i].content, text: m.content.text }', why: 'applying an edit' },
    { file: 'utils/contentValidation.ts', line: "if (content.type === 'text' && typeof content.text !== 'string')", why: 'validation' },
];

const READ_RE = /\bcontent\??\.text\b/;
/** Lines that route the text through the one plain-text function are fine wherever they are. */
const SAFE_RE = /toPlainText\(|displayPreviewOf\(/;

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
}

/** Each code line (comments dropped) that reads message text: `file`, line number, text. */
function reads(): { file: string; n: number; text: string }[] {
    const hits: { file: string; n: number; text: string }[] = [];
    for (const f of sourceFiles(ROOT)) {
        const file = relative(ROOT, f).split('\\').join('/');
        if (file.startsWith('utils/formatting/') || file === 'utils/messagePreviewText.ts') continue; // the plain-text implementation itself
        const lines = readFileSync(f, 'utf8').split('\n');
        lines.forEach((text, i) => {
            const code = text.replace(/\/\/.*$/, '');
            if (/^\s*\*/.test(code) || !READ_RE.test(code)) return;
            hits.push({ file, n: i + 1, text: code.trim() });
        });
    }
    return hits;
}

describe('every read of message text is plain-text-safe or classified', () => {
    const hits = reads();

    it('finds the reads (the scan is live)', () => {
        expect(hits.length).toBeGreaterThan(15);
        expect(hits.some(h => h.file === 'components/Dashboard.tsx' && SAFE_RE.test(h.text))).toBe(true);
    });

    it('none is unclassified', () => {
        const unclassified = hits.filter(h => !SAFE_RE.test(h.text)
            && !RAW_TEXT_SITES.some(s => s.file === h.file && h.text.includes(s.line)));
        expect(unclassified.map(h => `${h.file}:${h.n}  ${h.text}`),
            'Route it through toPlainText() (utils/messagePreviewText.ts) or add it to RAW_TEXT_SITES with the reason it may stay raw.').toEqual([]);
    });

    it('no classified entry is stale', () => {
        const stale = RAW_TEXT_SITES.filter(s => !hits.some(h => h.file === s.file && h.text.includes(s.line)));
        expect(stale.map(s => `${s.file}: ${s.line}`)).toEqual([]);
    });

    it('the preview surfaces themselves use toPlainText', () => {
        const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
        expect(read('components/Dashboard.tsx')).toContain("text={toPlainText(lastMsg.content.text, { tokens: 'keep' })}");
        expect(read('hooks/useNotificationDispatch.ts')).toContain('const displayText = toPlainText(text);');
        expect(read('components/PinnedMessagesPanel.tsx')).toContain('? toPlainText(msg.content.text)');
        const chat = read('components/ChatPane.tsx');
        expect(chat).toContain("replyQuoteLine(replyTarget?.content, c => previewSnippet(toPlainText(c.text)))");
        expect(chat).toContain('const replyText   = previewSnippet(toPlainText(replyTarget?.content?.text))');
        // Search excerpts and matching strip too.
        expect(read('utils/messagePreviewText.ts')).toMatch(/const shown = mentionsToDisplayText\(stripFormatting\(text\)\);/);
        // Shared links come from the parse (no URL out of a spoiler).
        expect(read('components/SharedContentModal.tsx')).toContain('for (const url of sharedLinksOf(c.text))');
    });
});
