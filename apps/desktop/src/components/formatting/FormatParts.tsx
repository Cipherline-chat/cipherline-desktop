/**
 * The interactive leaves of formatted message text (FormattedText.tsx):
 * spoilers, code blocks and masked links. Kept in their own module so
 * FormattedText.tsx exports only its render function (React Fast Refresh).
 * See FormattedText.tsx for the security shape these follow.
 */
import React, { useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { ClConfirm, useClTooltip } from '../cl';
import { highlight } from '../../utils/formatting/highlight';
import { maskedLinkCheck } from '../../utils/formatting/linkSafety';
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

/** Longest destination shown in the hover tip / dialog before it is cut with an ellipsis. */
const SHOWN_URL_MAX = 300;
const shortUrl = (u: string) => (u.length > SHOWN_URL_MAX ? `${u.slice(0, SHOWN_URL_MAX)}…` : u);

export function MaskedLink({ url, labelText, children }: { url: string; labelText: string; children: React.ReactNode }) {
    const [asking, setAsking] = useState(false);
    const tip = useClTooltip(shortUrl(url), { wide: true });
    const check = useMemo(() => maskedLinkCheck(labelText, url), [labelText, url]);
    const warn = check.deceptive || check.punycode;
    const ask = (e: React.SyntheticEvent) => { e.stopPropagation(); e.preventDefault(); setAsking(true); };
    const open = () => {
        setAsking(false);
        const r = openExternalLink(url);
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
                onClick={ask}
                onKeyDown={(e) => { if (e.key === 'Enter') ask(e); }}
            >
                {children}
            </span>
            {tip.tooltip}
            {asking && (
                <ClConfirm
                    open
                    onClose={() => setAsking(false)}
                    onConfirm={open}
                    danger={warn}
                    title={warn ? "This link isn't what it says" : 'Open this link?'}
                    confirmLabel={warn ? 'Open anyway' : 'Open link'}
                    message={
                        check.deceptive && check.labelHost ? (
                            <>The text says <b>{check.labelHost}</b>, but the link opens <b>{check.targetHost || 'an address that can’t be read'}</b>.</>
                        ) : check.punycode ? (
                            <>This address uses look-alike characters: <b>{check.targetHost}</b>.</>
                        ) : (
                            <>This link opens <b>{check.targetHost}</b> in your browser.</>
                        )
                    }
                >
                    <div className="cl-fmt-dest" data-dest="">{shortUrl(url)}</div>
                </ClConfirm>
            )}
        </>
    );
}
