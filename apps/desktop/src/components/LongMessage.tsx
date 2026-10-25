import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Copy, Check, FileText, Maximize2, X } from 'lucide-react';
import { ClModal } from './cl';
import { ClButton } from './ClButton';
import { DialogHeader, DialogFooter } from './dialog/DialogFrame';
import { useToast } from '../contexts/ToastContext';
import { writeToClipboard } from '../utils/clipboard';
import { mentionsToDisplayText } from '../utils/mentionTokens';
import { useShallowStable } from '../hooks/useShallowStable';
import {
    collapsedPreview, longMessageExpansion, longMessageLabel, longMessageStats,
    type LongMessageStats, type TextSpan,
} from '../utils/longMessage';
import '../styles/long-message.css';

/**
 * A text message past LONG_MESSAGE_THRESHOLD characters, collapsed.
 *
 *   collapsed  a ~700-character preview (utils/longMessage.collapsedPreview)
 *              with a fade-out, and a footer: "Long message · 12,345
 *              characters · ~3 min read" + Expand + Open full screen.
 *   expanded   the whole message inline, footer button becomes Collapse.
 *              Remembered per message for the session (longMessageExpansion).
 *   reader     the whole message in a near-full-window dialog (below).
 *
 * `renderText` is ChatPane's own message renderer (mentions, custom emoji,
 * links, #channel pills), so all three views format identically. The full text
 * is rendered ONLY when expanded or when the reader is open: a feed of
 * collapsed 100k-character messages costs ~700 characters each.
 */

export interface LongMessageBodyProps {
    /** Message id: the key the per-session expand state is stored under. */
    id: string;
    text: string;
    /** ChatPane's message renderer for a piece of text. */
    renderText: (text: string) => React.ReactNode;
    /**
     * Everything `renderText` reads besides its argument (user id, emoji
     * resolver, roster maps, ...). While these are shallow-equal the rendered
     * tree is reused, so hovering a row does not rebuild 100k characters of
     * nodes. Leaving something out shows it stale; extra, unstable entries only
     * cost speed.
     */
    renderDeps: readonly unknown[];
    /** Spans the collapsed cut must not land inside (e.g. `#channel` links). */
    protectedSpans?: readonly TextSpan[];
    senderName: string;
    timestamp: string;
    /** Show an "edited" mark in the footer (the row header carries it otherwise). */
    edited?: boolean;
}

export const LongMessageBody: React.FC<LongMessageBodyProps> = ({
    id, text, renderText, renderDeps, protectedSpans, senderName, timestamp, edited,
}) => {
    const [open, setOpen] = useState(() => longMessageExpansion.has(id));
    const [reader, setReader] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const bodyId = useId();

    const stats = useMemo(() => longMessageStats(text), [text]);
    // protectedSpans derive from `text`, so `text` is the only real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const { preview } = useMemo(() => collapsedPreview(text, undefined, protectedSpans), [text]);

    // `renderText` is a fresh closure every row render; `depsKey` is what it reads, so
    // the (possibly huge) tree is rebuilt only when one of those really changes.
    const depsKey = useShallowStable(renderDeps);
    /* eslint-disable react-hooks/exhaustive-deps -- renderText intentionally omitted: see depsKey */
    const previewNodes = useMemo(() => (open ? null : renderText(preview)), [open, preview, depsKey]);
    const fullNodes = useMemo(() => (open ? renderText(text) : null), [open, text, depsKey]);
    /* eslint-enable react-hooks/exhaustive-deps */

    const toggle = useCallback(() => {
        const next = !open;
        longMessageExpansion.set(id, next);
        setOpen(next);
        if (!next) {
            // The collapse button is at the foot of the (tall) expanded message;
            // once it shrinks, bring the message back into view if it is now above.
            requestAnimationFrame(() => rootRef.current?.scrollIntoView?.({ block: 'nearest' }));
        }
    }, [open, id]);

    return (
        <div ref={rootRef} className="lm" data-long-message data-state={open ? 'expanded' : 'collapsed'}>
            <div id={bodyId} className={open ? 'lm-text' : 'lm-text lm-text--clipped'}>
                {open ? fullNodes : previewNodes}
            </div>
            <div className="lm-foot" role="group" aria-label="Long message">
                <span className="lm-meta">
                    {longMessageLabel(stats)}
                    {edited ? ' · edited' : ''}
                </span>
                <button
                    type="button"
                    className="lm-btn"
                    aria-expanded={open}
                    aria-controls={bodyId}
                    onClick={(e) => { e.stopPropagation(); toggle(); }}
                >
                    <ChevronDown className="lm-chev" size={13} aria-hidden="true" />
                    {open ? 'Collapse' : 'Expand'}
                </button>
                <button
                    type="button"
                    className="lm-btn"
                    aria-haspopup="dialog"
                    onClick={(e) => { e.stopPropagation(); setReader(true); }}
                >
                    <Maximize2 size={12} aria-hidden="true" />
                    Open full screen
                </button>
            </div>
            <LongMessageReader
                open={reader}
                onClose={() => setReader(false)}
                text={text}
                renderText={renderText}
                renderDeps={renderDeps}
                senderName={senderName}
                timestamp={timestamp}
                stats={stats}
            />
        </div>
    );
};

// ── full-screen reader ───────────────────────────────────────────────────────

interface LongMessageReaderProps {
    open: boolean;
    onClose: () => void;
    text: string;
    renderText: (text: string) => React.ReactNode;
    renderDeps: readonly unknown[];
    senderName: string;
    timestamp: string;
    stats: LongMessageStats;
}

/** Events from the reader's portal bubble through the React tree into the
 *  message row it was opened from (click toggles save, focus pins the hover
 *  bar, ...). The row must see none of them. */
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export const LongMessageReader: React.FC<LongMessageReaderProps> = ({
    open, onClose, text, renderText, renderDeps, senderName, timestamp, stats,
}) => (
    <div
        style={{ display: 'contents' }}
        onClick={stop} onMouseDown={stop} onMouseUp={stop} onContextMenu={stop}
        onFocus={stop} onBlur={stop} onKeyDown={stop} onKeyUp={stop} onDoubleClick={stop}
    >
        <ClModal
            open={open}
            onClose={onClose}
            width="none"
            label={`Message from ${senderName}`}
            cardClassName="dlg-card lm-reader"
        >
            <ReaderContents
                onClose={onClose} text={text} renderText={renderText} renderDeps={renderDeps}
                senderName={senderName} timestamp={timestamp} stats={stats}
            />
        </ClModal>
    </div>
);

const ReaderContents: React.FC<Omit<LongMessageReaderProps, 'open'>> = ({
    onClose, text, renderText, renderDeps, senderName, timestamp, stats,
}) => {
    const toast = useToast();
    const scrollRef = useRef<HTMLDivElement>(null);
    const [ready, setReady] = useState(false);
    const [copied, setCopied] = useState(false);

    // Paint the dialog first, THEN build the (possibly 100k-character) tree, so
    // opening feels instant and only the text area waits.
    useEffect(() => {
        let t: ReturnType<typeof setTimeout> | undefined;
        const r = requestAnimationFrame(() => { t = setTimeout(() => setReady(true), 0); });
        return () => { cancelAnimationFrame(r); if (t) clearTimeout(t); };
    }, []);

    // Land focus on the text so arrow keys / PageDown / Space scroll it.
    useEffect(() => {
        const t = setTimeout(() => scrollRef.current?.focus({ preventScroll: true }), 80);
        return () => clearTimeout(t);
    }, []);

    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 1600);
        return () => clearTimeout(t);
    }, [copied]);

    const depsKey = useShallowStable(renderDeps);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- renderText intentionally omitted: see depsKey
    const nodes = useMemo(() => (ready ? renderText(text) : null), [ready, text, depsKey]);

    const copy = () => {
        writeToClipboard(mentionsToDisplayText(text)).then(
            () => setCopied(true),
            () => toast.push({ kind: 'error', message: 'Could not copy. Try selecting the text and copying it manually.' }),
        );
    };

    return (
        <>
            <DialogHeader
                icon={<FileText size={18} />}
                title={senderName}
                subtitle={`${timestamp} · ${longMessageLabel(stats).replace('Long message · ', '')}`}
                trailing={
                    <button type="button" className="lm-close" aria-label="Close full message" onClick={onClose}>
                        <X size={16} aria-hidden="true" />
                    </button>
                }
            />
            <div
                ref={scrollRef}
                className="lm-reader-scroll"
                tabIndex={0}
                role="region"
                aria-label="Full message text"
                aria-busy={!ready}
            >
                <div className="lm-reader-text">
                    {ready ? nodes : <span className="lm-reader-wait">Preparing the full message…</span>}
                </div>
            </div>
            <DialogFooter hint={<span aria-live="polite">{copied ? 'Copied to clipboard' : 'Press Esc to close'}</span>}>
                <ClButton variant="ghost" size="sm" onClick={copy}>
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy text'}
                </ClButton>
                <ClButton size="sm" onClick={onClose}>Close</ClButton>
            </DialogFooter>
        </>
    );
};

export default LongMessageBody;
