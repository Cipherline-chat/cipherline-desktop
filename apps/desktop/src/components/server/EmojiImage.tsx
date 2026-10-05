/**
 * EmojiImage — renders one custom server emoji from its inline key material.
 *
 * Same shape as ServerIcon: the key/nonce travel with the emoji's own list
 * entry (server_emojis row — see docs/custom-emoji-design.md), not fetched
 * via GET /attachments/:id/key, so this always passes an inline key into
 * useEncryptedAvatar rather than relying on its server-fallback lookup.
 */

import React from 'react';
import { Smile, Ghost } from 'lucide-react';
import { useEncryptedAvatar } from '../../hooks/useEncryptedAvatar';
import { useClTooltip } from '../cl/useClTooltip';

interface PlaceholderProps {
    className?: string;
    style?: React.CSSProperties;
}

/**
 * The "still loading" look, shared by two callers: EmojiImage itself (while
 * ITS OWN decrypt is in flight) and ChatPane's message renderer (while the
 * server's emoji LIST hasn't loaded yet, so it can't even tell whether a
 * token resolves — see renderTextWithMentions/renderJumboContent's
 * `emojisLoading` param). One definition means both places read as the same
 * seamless placeholder→image transition instead of two different-looking
 * "loading" treatments. A gentle pulse (not a spinner) so a line of chat
 * text doesn't read as jumpy while several tokens resolve at once.
 */
export const EmojiPlaceholder: React.FC<PlaceholderProps> = ({ className, style }) => (
    <div
        className={`inline-flex items-center justify-center bg-cl-raise/40 rounded animate-pulse ${className ?? ''}`}
        style={style}
    >
        <Smile size={14} className="text-cl-faint/60" />
    </div>
);

export interface MissingEmojiPlaceholderProps {
    /** The token's shortcode (the `name` half of `<:name:id>`) — kept
     *  visible in the tooltip/label so a user staring at an unfamiliar icon
     *  can still tell which emoji is missing. */
    label: string;
    /** True when this render site has no server to check the token against
     *  at all (ChatPane's `emojiServerId` is null — a DM or group chat).
     *  The custom-emoji picker never offers server emojis outside a server
     *  channel, so authoring one from a DM composer isn't possible through
     *  this client today — but the encrypted text is immutable and this
     *  function can't rule out every path a token could arrive by, so it
     *  can't honestly claim "deleted" there. Softens the wording to
     *  "unavailable" instead of "no longer available" in that case. */
    noServerContext?: boolean;
    className?: string;
    style?: React.CSSProperties;
}

/**
 * The "this custom emoji doesn't resolve" look — replaces the old raw
 * `:shortcode:` mono-text fallback (which rendered enormous on the jumbo
 * standalone-emoji path, since it just inherited that path's oversized
 * font-size like any other text). A small, deliberately muted glyph instead:
 * reads as a normal end-state, not an error. Hoverable/focusable via the kit
 * tooltip primitive (`cl/useClTooltip`) for the "why does this look like
 * this" explanation, and carries its own `role="img"`/`aria-label` so it
 * still has a text alternative for a screen reader that never focuses it.
 */
export const MissingEmojiPlaceholder: React.FC<MissingEmojiPlaceholderProps> = ({
    label,
    noServerContext,
    className,
    style,
}) => {
    const tipText = noServerContext
        ? `:${label}: — emoji unavailable here`
        : `:${label}: — emoji no longer available`;
    const { anchorProps, tooltip, describedBy } = useClTooltip(tipText);
    const { ref: tipRef, ...tipHandlers } = anchorProps;

    return (
        <span
            ref={tipRef as React.Ref<HTMLSpanElement>}
            {...tipHandlers}
            role="img"
            aria-label={tipText}
            aria-describedby={describedBy}
            tabIndex={0}
            className={`inline-flex items-center justify-center bg-cl-raise/40 rounded text-cl-faint/70 cursor-default ${className ?? ''}`}
            style={{ lineHeight: 1, ...style }}
        >
            <Ghost style={{ width: '70%', height: '70%' }} strokeWidth={2} aria-hidden="true" />
            {tooltip}
        </span>
    );
};

interface Props {
    name: string;
    attachmentId: string;
    keyB64: string;
    nonceB64: string;
    token: string | null;
    /** Wrapper classes — size and any margin/inline styling. */
    className?: string;
    /** Inline sizing (e.g. em-relative height/width/vertical-align for an
     *  inline-message render). Merged onto the element's own object-fit style. */
    style?: React.CSSProperties;
}

export const EmojiImage: React.FC<Props> = ({ name, attachmentId, keyB64, nonceB64, token, className, style }) => {
    const url = useEncryptedAvatar(attachmentId, token, { keyB64, nonceB64 });

    if (url) {
        return (
            <img
                src={url}
                alt={`:${name}:`}
                title={`:${name}:`}
                className={`object-contain ${className ?? ''}`}
                style={style}
            />
        );
    }

    return <EmojiPlaceholder className={className} style={style} />;
};

export default EmojiImage;
