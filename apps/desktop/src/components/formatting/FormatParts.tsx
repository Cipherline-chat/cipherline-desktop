/**
 * The interactive leaves of formatted message text (FormattedText.tsx):
 * spoilers, code blocks and masked links. Kept in their own module so
 * FormattedText.tsx exports only its render function (React Fast Refresh).
 * See FormattedText.tsx for the security shape these follow.
 */
import React, { useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useClTooltip } from '../cl';
import { highlight } from '../../utils/formatting/highlight';
import { openExternalLink } from '../../utils/openExternalLink';
import { writeToClipboard } from '../../utils/clipboard';

export function Spoiler({ children }: { children: React.ReactNode }) {
    const [shown, setShown] = useState(false);
    if (shown) return <span className="cl-fmt-spoiler" data-revealed="">{children}</span>;
    const reveal = (e: React.SyntheticEvent) => { e.stopPropagation(); e.preventDefault(); setShown(true); };
    return (
        <span
            className="cl-fmt-spoiler"
            role="button"
            tabIndex={0}
            aria-label="Spoiler, hidden. Activate to reveal."
            title="Spoiler: click to reveal"
            onClick={reveal}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') reveal(e); }}
        >
            <span className="cl-fmt-spoiler-inner" aria-hidden="true" inert>{children}</span>
        </span>
    );
}

export function CodeBlock({ lang, code, clipped }: { lang: string | null; code: string; clipped?: boolean }) {
    const segs = useMemo(() => highlight(code, lang), [code, lang]);
    const [copied, setCopied] = useState(false);
    const copy = (e: React.MouseEvent) => {
        e.stopPropagation();
        writeToClipboard(code).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
        }, () => { /* the button just doesn't flip; the code is still selectable */ });
    };
    return (
        <div className={clipped ? 'cl-fmt-pre cl-fmt-pre--clipped' : 'cl-fmt-pre'} data-lang={lang ?? undefined} data-clipped={clipped ? '' : undefined}>
            <div className="cl-fmt-pre-head">
                <span className="cl-fmt-pre-lang">{lang ?? 'code'}</span>
                {/* A collapsed preview holds only the first lines: copy from the full view. */}
                {!clipped && <button type="button" className="cl-fmt-pre-copy" onClick={copy} aria-label={copied ? 'Copied' : 'Copy code'} title={copied ? 'Copied' : 'Copy code'}>
                    {copied ? <Check size={13} strokeWidth={2.4} /> : <Copy size={13} strokeWidth={2.2} />}
                </button>}
            </div>
            <pre><code>{segs.map((s, i) => (s.kind ? <span key={i} className={`cl-hl-${s.kind}`}>{s.text}</span> : <React.Fragment key={i}>{s.text}</React.Fragment>))}</code></pre>
        </div>
    );
}

/** Longest destination shown in the hover tip before it is cut with an ellipsis. */
const SHOWN_URL_MAX = 300;
const shortUrl = (u: string) => (u.length > SHOWN_URL_MAX ? `${u.slice(0, SHOWN_URL_MAX)}…` : u);

/**
 * A masked `[label](url)` link. The hover tip shows the real destination; a
 * click goes through openExternalLink with the label, so the shared
 * "You're leaving Cipherline" dialog shows the full URL and, when the label
 * names a different site (utils/formatting/linkSafety.ts), says so — even for
 * a trusted destination. (This used to raise its own ClConfirm; the shared
 * dialog replaced it so every external link asks the same way.)
 */
export function MaskedLink({ url, labelText, children }: { url: string; labelText: string; children: React.ReactNode }) {
    const tip = useClTooltip(shortUrl(url), { wide: true });
    const open = (e: React.SyntheticEvent) => {
        e.stopPropagation();
        e.preventDefault();
        const r = openExternalLink(url, { label: labelText });
        if (!r.ok) console.warn(`[FormattedText] refused to open link (${r.reason})`);
    };
    return (
        <>
            <span
                {...tip.anchorProps}
                role="link"
                tabIndex={0}
                className="cl-fmt-link"
                data-href={url}
                aria-describedby={tip.describedBy}
                onClick={open}
                onKeyDown={(e) => { if (e.key === 'Enter') open(e); }}
            >
                {children}
            </span>
            {tip.tooltip}
        </>
    );
}
