/**
 * Renders Discord-style formatted message text (utils/formatting/markdown.ts)
 * as React elements.
 *
 * Security shape: the parser returns plain objects and this file maps each node
 * kind to a fixed element — there is no HTML pass-through and no
 * `dangerouslySetInnerHTML`. Every run of ordinary text is handed back to the
 * caller's `renderLeaf`, which is where mentions, custom emoji, `#channel`
 * links, invite links and bare-URL linkify already live (ChatPane's
 * renderTextWithMentions), so all of those keep working inside and around
 * formatting without being re-implemented here.
 *
 * Links:
 *  - a bare URL / `<url>` is the caller's linkify (opened through the
 *    validated utils/openExternalLink path, as before);
 *  - a masked link `[label](https://…)` shows its real destination on hover
 *    and opens through the same leaving-Cipherline gate, with its label: an
 *    untrusted destination asks first, and a label naming a different site
 *    (utils/formatting/linkSafety.ts) ALWAYS asks, with the mismatch spelled
 *    out. Text inside a label is never itself linkified.
 *
 * Spoilers are blurred and inert (no focusable mention / link inside them is
 * reachable) until clicked or activated with Enter / Space.
 *
 * Headings are structure, not size: weight, colour and spacing change, the
 * font size never does — see styles/formatting.css. The only size control is
 * the sender's explicit text size: the whole message (`size` field) or a span
 * (`[small]` / `[large]`), allowlisted and capped at 1.5x.
 */
import React from 'react';
import { closeDanglingFence, isPlainParse, parseMessage, type BlockNode, type InlineNode, type ListBlock } from '../../utils/formatting/markdown';
import { previewSource, truncateBlocks, PREVIEW_BUDGET, type PreviewBudget } from '../../utils/formatting/truncate';
import { CodeBlock, MaskedLink, Spoiler } from './FormatParts';
import { sizeScaleFor, spanFontSize } from '../../utils/formatting/messageSize';
import '../../styles/formatting.css';

export interface LeafContext {
    /** True inside a masked link's label: render text only, never another link. */
    inLink: boolean;
}

export type RenderLeaf = (text: string, key: string, ctx: LeafContext) => React.ReactNode;

export interface FormatOptions {
    renderLeaf: RenderLeaf;
    /** What code shows for its raw text (ChatPane: mention tokens as `@name`). Default: unchanged. */
    codeText?: (raw: string) => string;
    /** The text is a cut-down preview: close a ``` fence its cut left open. */
    truncated?: boolean;
}

// ── Tree → elements ──────────────────────────────────────────────────────────

/** A label's text as a person reads it (for the "does it name another site" check). */
function nodesText(nodes: readonly InlineNode[]): string {
    let s = '';
    for (const n of nodes) {
        if (n.t === 'text' || n.t === 'code' || n.t === 'codeBlock') s += n.v;
        else s += nodesText(n.c);
    }
    return s;
}

function renderInline(nodes: readonly InlineNode[], o: FormatOptions, key: string, inLink: boolean): React.ReactNode[] {
    const codeText = o.codeText ?? ((s: string) => s);
    return nodes.map((n, i) => {
        const k = `${key}.${i}`;
        switch (n.t) {
            case 'text': return <React.Fragment key={k}>{o.renderLeaf(n.v, k, { inLink })}</React.Fragment>;
            case 'strong': return <strong key={k} className="cl-fmt-b">{renderInline(n.c, o, k, inLink)}</strong>;
            case 'em': return <em key={k} className="cl-fmt-i">{renderInline(n.c, o, k, inLink)}</em>;
            case 'u': return <u key={k} className="cl-fmt-u">{renderInline(n.c, o, k, inLink)}</u>;
            case 'strike': return <s key={k} className="cl-fmt-s">{renderInline(n.c, o, k, inLink)}</s>;
            case 'spoiler': return <Spoiler key={k}>{renderInline(n.c, o, k, inLink)}</Spoiler>;
            case 'size': {
                // Absolute size for the span (allowlisted, capped scale): relative to the
                // message's own size (--cl-msg-scale, the per-message field) so it lands on
                // exactly 15px x scale; the inner span re-sets the scale for code inside it.
                const sc = sizeScaleFor(n.size);
                return (
                    <span key={k} className="cl-fmt-size" data-size={n.size} style={{ fontSize: spanFontSize(n.size) }}>
                        <span style={{ ['--cl-msg-scale' as string]: String(sc) }}>{renderInline(n.c, o, k, inLink)}</span>
                    </span>
                );
            }
            case 'code': return <code key={k} className="cl-fmt-code">{codeText(n.v)}</code>;
            case 'codeBlock': return <CodeBlock key={k} lang={n.lang} code={codeText(n.v)} clipped={n.clipped} />;
            case 'link':
                if (n.kind === 'angle') return <React.Fragment key={k}>{o.renderLeaf(n.url, k, { inLink })}</React.Fragment>;
                return (
                    <MaskedLink key={k} url={n.url} labelText={nodesText(n.c)}>
                        {renderInline(n.c, o, k, true)}
                    </MaskedLink>
                );
        }
    });
}

function renderList(list: ListBlock, o: FormatOptions, key: string): React.ReactNode {
    const items = list.items.map((it, i) => (
        <li key={`${key}.${i}`}>
            {renderInline(it.c, o, `${key}.${i}`, false)}
            {it.sub && renderList(it.sub, o, `${key}.${i}.s`)}
        </li>
    ));
    return list.ordered
        ? <ol key={key} className="cl-fmt-list" start={list.start}>{items}</ol>
        : <ul key={key} className="cl-fmt-list">{items}</ul>;
}

function renderBlocks(blocks: readonly BlockNode[], o: FormatOptions, key: string): React.ReactNode[] {
    return blocks.map((b, i) => {
        const k = `${key}.${i}`;
        switch (b.t) {
            case 'para':
                return <div key={k} className="cl-fmt-p">{renderInline(b.c, o, k, false)}{b.pad ? '\n' : null}</div>;
            case 'heading':
                // aria-level is offset so a message heading never outranks the app's own.
                return <div key={k} role="heading" aria-level={b.level + 2} className={`cl-fmt-h cl-fmt-h${b.level}`}>{renderInline(b.c, o, k, false)}</div>;
            case 'subtext':
                return <div key={k} className="cl-fmt-sub">{renderInline(b.c, o, k, false)}</div>;
            case 'quote':
                return <blockquote key={k} className="cl-fmt-quote">{renderBlocks(b.c, o, k)}</blockquote>;
            case 'list':
                return renderList(b, o, k);
        }
    });
}

/**
 * Formatted message text as React nodes. Plain text (the common case) comes
 * back as exactly `renderLeaf(text)` — no wrapper — so an unformatted message
 * renders the same DOM it always did.
 */
export function renderFormatted(text: string, o: FormatOptions): React.ReactNode {
    const src = o.truncated ? closeDanglingFence(text) : text;
    const blocks = parseMessage(src);
    if (blocks.length === 0) return o.renderLeaf(text, 'f', { inLink: false });
    // Escapes are already resolved in the text nodes (`2 \* 3` shows `2 * 3`).
    if (isPlainParse(blocks)) return o.renderLeaf(nodesText((blocks[0] as { c: InlineNode[] }).c), 'f', { inLink: false });
    return <div className="cl-fmt">{renderBlocks(blocks, o, 'f')}</div>;
}

/**
 * The collapsed preview of a long message: the first PREVIEW_BUDGET of it,
 * cut on the parsed tree (utils/formatting/truncate.ts) so it never shows an
 * open fence, a half-open spoiler or a broken list.
 */
export function renderFormattedPreview(text: string, o: FormatOptions, budget: PreviewBudget = PREVIEW_BUDGET): React.ReactNode {
    const { blocks } = truncateBlocks(parseMessage(previewSource(text)), budget);
    if (blocks.length === 0) return null;
    return <div className="cl-fmt" data-preview="">{renderBlocks(blocks, o, 'p')}</div>;
}
