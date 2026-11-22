/**
 * The avatar, name and "Not on Cipherline yet" card of an IMPORTED author
 * (Discord import phase 2; plan B6.2 rules 5 and 6). Rendered only for a row
 * `importedAuthorView` verified against the server's import mark.
 *
 * The avatar is an ordinary end-to-end-encrypted attachment in the channel:
 * its key lives inside the message content, so it is downloaded and decrypted
 * here exactly like a chat image (never through the avatar-class path, whose
 * key the server holds). When the file is gone (unsaved imported files are
 * swept after 14 days, D24) the initial on a stable colour is shown instead.
 *
 * Never a link to a profile, never mentionable: clicking opens a small card.
 * The claim button is phase 3; the card leaves a slot for it.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ImportedAvatar } from '@cipherline/shared';
import { API_BASE } from '../../../constants';
import { downloadEncryptedAttachment } from '../../../utils/attachmentDownload';
import { decryptBlob, importKeyFromBase64 } from '../../../utils/crypto';
import { importedHue, importedInitials } from '../../../utils/importedAuthor';
import { useEscape } from '../../../hooks/useEscape';
import { useDismissOnOutsideClick } from '../../../hooks/useDismissOnOutsideClick';

/** One download per avatar file for the life of the window (rows re-render a lot). */
const avatarUrls = new Map<string, Promise<string | null>>();

function loadAvatar(a: ImportedAvatar, token: string): Promise<string | null> {
    const have = avatarUrls.get(a.attachment_id);
    if (have) return have;
    const p = (async () => {
        try {
            const enc = await downloadEncryptedAttachment(a.attachment_id, token, API_BASE, { downloadTimeoutMs: 20_000 });
            const key = await importKeyFromBase64(a.file_key_b64);
            const blob = await decryptBlob(enc, key, a.file_nonce_b64, a.mime);
            return URL.createObjectURL(blob);
        } catch {
            return null;
        }
    })();
    avatarUrls.set(a.attachment_id, p);
    return p;
}

/** For tests. */
export function _resetImportedAvatarCache(): void { avatarUrls.clear(); }

export function ImportedAuthorAvatar({ authorRef, name, avatar, token, size = 40, className = '', onClick }: {
    authorRef: string;
    name: string;
    avatar: ImportedAvatar | null;
    token: string | null;
    size?: number;
    className?: string;
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        setUrl(null);
        if (avatar && token) void loadAvatar(avatar, token).then(u => { if (live) setUrl(u); });
        return () => { live = false; };
    }, [avatar?.attachment_id, token]); // eslint-disable-line react-hooks/exhaustive-deps
    const hue = importedHue(authorRef);
    const inner = url
        ? <img src={url} alt="" className="w-full h-full object-cover rounded-full" draggable={false} />
        : (
            <span
                aria-hidden="true"
                className="w-full h-full rounded-full flex items-center justify-center font-semibold select-none"
                // A theme token tinted per author (hue from the opaque ref): no colour literals.
                style={{ background: 'var(--cl-lume)', filter: `hue-rotate(${hue}deg)`, color: 'var(--cl-abyss)', fontSize: Math.round(size * 0.42) }}
            >
                {importedInitials(name)}
            </span>
        );
    if (!onClick) {
        return <span className={`inline-flex shrink-0 rounded-full overflow-hidden ${className}`} style={{ width: size, height: size }}>{inner}</span>;
    }
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={`About ${name}`}
            data-imported-author-avatar
            className={`inline-flex shrink-0 rounded-full overflow-hidden p-0 border-0 bg-transparent cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cl-glow)] ${className}`}
            style={{ width: size, height: size }}
        >
            {inner}
        </button>
    );
}

export interface UnclaimedCardTarget {
    authorRef: string;
    name: string;
    username: string | null;
    avatar: ImportedAvatar | null;
    authorKind: 'user' | 'webhook' | 'app';
    x: number;
    y: number;
}

const CARD_W = 300;

/**
 * "Not on Cipherline yet." A small, keyboard-reachable card anchored at the
 * click. Escape or a click outside closes it; focus moves into it on open and
 * back to the trigger on close (the caller restores it).
 */
export function UnclaimedAuthorCard({ target, token, onClose, claimSlot }: {
    target: UnclaimedCardTarget;
    token: string | null;
    onClose: () => void;
    /** Phase 3: "Is this you? Claim with Discord". Absent in phase 2. */
    claimSlot?: React.ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ left: number; top: number }>({ left: target.x, top: target.y });
    useEscape(() => onClose(), true);
    useDismissOnOutsideClick(ref, true, onClose);
    useLayoutEffect(() => {
        const el = ref.current;
        const place = () => {
            const h = el?.offsetHeight ?? 180;
            const vw = window.innerWidth; const vh = window.innerHeight;
            setPos({
                left: Math.max(8, Math.min(target.x + 8, vw - CARD_W - 8)),
                top: Math.max(8, Math.min(target.y + 8, vh - h - 8)),
            });
        };
        place();
        el?.focus();
        // The claim slot (phase 3) changes height as it loads ("Checking…" ->
        // "Is this you?" / "These are yours"): keep the card inside the window.
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(place);
        ro.observe(el);
        return () => ro.disconnect();
    }, [target.x, target.y]);
    const isPerson = target.authorKind === 'user';
    return createPortal(
        <div
            ref={ref}
            role="dialog"
            aria-modal="false"
            aria-labelledby="imported-author-card-title"
            tabIndex={-1}
            data-imported-author-card
            className="fixed z-[1000] rounded-xl border shadow-2xl p-4 outline-none"
            style={{ left: pos.left, top: pos.top, width: CARD_W, background: 'var(--cl-surface)', borderColor: 'var(--cl-border)', color: 'var(--cl-text)' }}
        >
            <div className="flex items-center gap-3">
                <ImportedAuthorAvatar authorRef={target.authorRef} name={target.name} avatar={target.avatar} token={token} size={48} />
                <div className="min-w-0">
                    <div className="text-[15px] font-semibold truncate" style={{ color: 'var(--cl-bright)' }}>{target.name}</div>
                    {target.username && <div className="text-[12px] truncate" style={{ color: 'var(--cl-faint)' }}>@{target.username}</div>}
                </div>
            </div>
            <h2 id="imported-author-card-title" className="mt-3 text-[13px] font-semibold" style={{ color: 'var(--cl-bright)' }}>
                {isPerson ? 'Not on Cipherline yet' : 'An app, not a person'}
            </h2>
            <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--cl-muted)' }}>
                {isPerson
                    ? 'These messages were copied over when this server moved to Cipherline. This person has no Cipherline account linked to them, so they can\'t be messaged, mentioned or added here.'
                    : 'These messages were posted by a bot or webhook on the old server and copied over when this server moved to Cipherline.'}
            </p>
            {claimSlot}
            <div className="mt-3 flex justify-end">
                <button
                    type="button"
                    onClick={onClose}
                    className="text-[12.5px] px-3 py-1.5 rounded-md border focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--cl-glow)]"
                    style={{ borderColor: 'var(--cl-border)', color: 'var(--cl-text)' }}
                >
                    Close
                </button>
            </div>
        </div>,
        document.body,
    );
}
