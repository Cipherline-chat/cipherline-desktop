/**
 * Reads the "What's new" notes out of apps/desktop/CHANGELOG.md.
 *
 * Runs at BUILD time (vite-plugin-whats-new.ts feeds the result to the app as
 * the module `virtual:whats-new`), so the dialog that greets you after an update
 * works offline and the renderer never parses markdown. This file is also
 * imported by vite.config.ts, so it must stay free of DOM and Node APIs.
 *
 * Each release section may carry a `### What's new` subsection: the short,
 * plain-English list people see on first launch after updating. It is separate
 * from `### Changes` (the full, public release notes) on purpose. Inside it:
 *
 *     ### What's new
 *
 *     - **Calls.** Moving someone to another call no longer looks like a kick.
 *     - One sentence, no jargon.
 *
 *     #### Optional group heading
 *     - Another one.
 *
 * A bullet may open with a bold lead (`**Title.**`), shown as the item's heading.
 * Inline markdown is flattened to plain text (the dialog renders text nodes
 * only, never HTML). Wrapped lines (a bullet continued on an indented line) are
 * joined. Anything else under the heading is ignored.
 *
 * Releases are keyed by exact version, pre-release suffix included
 * (`1.0.23`, `1.0.23-staging.7`); `## [Unreleased]` is returned separately so
 * a dev build can preview a draft, and a production build can leave it out.
 */

export interface NoteItem {
    /** The bold lead, when the bullet starts with one. */
    title: string | null;
    text: string;
}
export interface NoteGroup {
    title: string | null;
    items: NoteItem[];
}
export interface ReleaseNotes {
    version: string;
    /** ISO date from the heading, when it has one. */
    date: string | null;
    groups: NoteGroup[];
}
export interface WhatsNewData {
    releases: Record<string, ReleaseNotes>;
    /** The `## [Unreleased]` notes, if any. Dev builds only (see the plugin). */
    unreleased: ReleaseNotes | null;
}

export const EMPTY_WHATS_NEW: WhatsNewData = { releases: {}, unreleased: null };

const HEADING = /^## \[(Unreleased|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;
const WHATS_NEW_HEADING = /^###\s+What[’']?s new\s*$/i;
/** A hard cap per item so a pasted paragraph cannot blow up the dialog. */
export const MAX_ITEM_CHARS = 280;
export const MAX_ITEMS = 12;

/** `**Bold**`, `` `code` ``, `[text](url)`, `*em*`: down to the plain words. */
export function flattenInline(s: string): string {
    return s
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1$2')
        .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g, '$1$2')
        .replace(/\s+/g, ' ')
        .trim();
}

function toItem(raw: string): NoteItem | null {
    const body = raw.trim();
    if (!body) return null;
    const lead = /^\*\*([^*]+?)\*\*\s*(.*)$/.exec(body);
    let title: string | null = null;
    let rest = body;
    if (lead && lead[2].trim()) {
        title = flattenInline(lead[1]).replace(/[.:\s]+$/, '');
        rest = lead[2];
    }
    let text = flattenInline(rest);
    if (!text) return null;
    if (text.length > MAX_ITEM_CHARS) text = text.slice(0, MAX_ITEM_CHARS - 1).trimEnd() + '…';
    return { title: title || null, text };
}

/** The groups inside one `### What's new` block (lines after the heading). */
function parseBlock(lines: string[]): NoteGroup[] {
    const groups: NoteGroup[] = [];
    let current: NoteGroup | null = null;
    let pending: string | null = null;
    let count = 0;
    const flush = () => {
        if (pending === null) return;
        const item = toItem(pending);
        pending = null;
        if (!item || count >= MAX_ITEMS) return;
        if (!current) { current = { title: null, items: [] }; groups.push(current); }
        current.items.push(item);
        count++;
    };
    for (const line of lines) {
        const heading = /^####\s+(.+?)\s*$/.exec(line);
        if (heading) {
            flush();
            current = { title: flattenInline(heading[1]) || null, items: [] };
            groups.push(current);
            continue;
        }
        const bullet = /^[-*]\s+(.*)$/.exec(line);
        if (bullet) { flush(); pending = bullet[1]; continue; }
        if (pending !== null && /^\s{2,}\S/.test(line)) { pending += ' ' + line.trim(); continue; }
        flush();
    }
    flush();
    return groups.filter(g => g.items.length > 0);
}

/** Parses a whole CHANGELOG. Never throws; unparseable input gives the empty result. */
export function parseChangelog(text: string): WhatsNewData {
    const out: WhatsNewData = { releases: {}, unreleased: null };
    if (typeof text !== 'string' || !text) return out;
    const lines = text.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
        const h = HEADING.exec(lines[i]);
        if (!h) { i++; continue; }
        const [, version, date] = h;
        let end = i + 1;
        while (end < lines.length && !/^## /.test(lines[end])) end++;
        const section = lines.slice(i + 1, end);
        i = end;

        const at = section.findIndex(l => WHATS_NEW_HEADING.test(l.trim()));
        if (at < 0) continue;
        let stop = section.length;
        for (let j = at + 1; j < section.length; j++) {
            if (/^###\s/.test(section[j])) { stop = j; break; }
        }
        const groups = parseBlock(section.slice(at + 1, stop));
        if (groups.length === 0) continue;
        const notes: ReleaseNotes = { version, date: date ?? null, groups };
        if (version === 'Unreleased') out.unreleased = notes;
        else out.releases[version] = notes;
    }
    return out;
}

/** How many bullets a release's notes hold, across groups. */
export function countItems(n: ReleaseNotes | null | undefined): number {
    return n ? n.groups.reduce((a, g) => a + g.items.length, 0) : 0;
}
