import React from 'react';
import {
    Pin, PinOff, X, Paperclip, CornerUpLeft,
    FileText, Music, Archive, File, Flag, Ticket,
} from 'lucide-react';
import { EncryptedAvatar } from './EncryptedAvatar';
import { useAuth } from '../contexts/AuthContext';
import ClButton from './ClButton';
import { useEscape } from '../hooks/useEscape';
import { mentionsToDisplayText } from '../utils/mentionTokens';
import { messageTextMatches } from '../utils/messagePreviewText';
import KlipyGifEmbed from './KlipyGifEmbed';

// ── URL helpers (mirrors ChatPane) ────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp)(\?[^#]*)?(?:#.*)?$/i;

function extractUrls(text: string): string[] {
    return text.match(URL_REGEX) ?? [];
}

function extractYouTubeId(url: string): string | null {
    const patterns = [
        /[?&]v=([a-zA-Z0-9_-]{11})/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})/,
        /\/embed\/([a-zA-Z0-9_-]{11})/,
        /\/shorts\/([a-zA-Z0-9_-]{11})/,
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
    }
    return null;
}

function isDirectImageUrl(url: string): boolean {
    try { return IMAGE_EXT_RE.test(new URL(url).pathname); }
    catch { return false; }
}

// ── File-type icon helper ─────────────────────────────────────────────────────

function FileTypeIcon({ mime, filename }: { mime?: string; filename?: string }) {
    const ext = filename?.split('.').pop()?.toLowerCase() ?? '';
    if (mime?.startsWith('audio/') || ['mp3', 'ogg', 'flac', 'wav', 'm4a'].includes(ext)) {
        return <Music className="w-4 h-4 shrink-0" />;
    }
    if (['pdf'].includes(ext) || mime === 'application/pdf') {
        return <FileText className="w-4 h-4 shrink-0" />;
    }
    if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) {
        return <Archive className="w-4 h-4 shrink-0" />;
    }
    if (['doc', 'docx', 'txt', 'md', 'csv', 'xlsx', 'xls', 'ppt', 'pptx'].includes(ext)) {
        return <FileText className="w-4 h-4 shrink-0" />;
    }
    return <File className="w-4 h-4 shrink-0" />;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface PinnedMessagesPanelProps {
    messages: any[];
    pinnedMsgIds: string[];
    objectUrls: Record<string, string>;
    searchQuery: string;
    onJumpTo: (msgId: string) => void;
    onUnpin: (msgId: string) => void;
    onClose: () => void;
    /** Whether the viewer is allowed to unpin from this list. Channel pins are
     *  shared server state gated on MANAGE_MESSAGES (mirrors ChatPane's Pin/
     *  Unpin hover button and context-menu entry); DM/group pins are a local
     *  bookmark with no permission concept, so the caller passes `true` there.
     *  Defaults to `true` for callers that predate this prop (there were
     *  none — every call site now passes it explicitly). */
    canUnpin?: boolean;
    deviceToUsername: Record<string, string>;
    userIdToUsername: Record<string, string>;
    deviceToAvatar?: Record<string, string>;
    userIdToAvatar?: Record<string, string>;
    myDeviceIds: Set<string>;
    token: string | null;
    isCallOverlay?: boolean;
    isInline?: boolean;
    /** True while the panel is being kept mounted purely to finish its exit
     *  animation — the caller (ChatPane) has already moved on and toggled
     *  its own open state back to false. Selects `.pinned-panel-exit`
     *  instead of `.pinned-panel-enter` (index.css) and, importantly, is
     *  the ONLY thing that changes: props like `messages`/`searchQuery`
     *  are frozen by the caller at the moment closing starts, so the list
     *  fades out showing exactly what the user was looking at rather than
     *  jumping to whatever the live props become once the parent considers
     *  the panel already closed. */
    closing?: boolean;
    /** Same report flow as the message context menu in ChatPane — hands the
     *  sender + a snippet of this pinned message's own (already
     *  client-decrypted) content to the report modal. Optional: when the
     *  caller doesn't wire it, the row simply omits the action rather than
     *  crashing (matches ChatPane's own `onReport` being optional). Hidden
     *  for the viewer's own pinned messages. */
    onReport?: (userId: string, username: string, snippet?: string) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

const PinnedMessagesPanel: React.FC<PinnedMessagesPanelProps> = ({
    messages,
    pinnedMsgIds,
    objectUrls,
    searchQuery,
    onJumpTo,
    onUnpin,
    onClose,
    canUnpin = true,
    deviceToUsername,
    userIdToUsername,
    deviceToAvatar,
    userIdToAvatar,
    myDeviceIds,
    token,
    isCallOverlay = false,
    onReport,
    closing = false,
}) => {
    const { user } = useAuth();
    // Escape backs out of this panel through the shared stack — previously
    // only wired for the call-overlay variant; extended to the inline side
    // panel too (TASK 2: side panels), since it is exactly the kind of
    // "thing you're in" a press should back out of. Not active while already
    // closing (the exit-animation clone) — a second onClose() there is a
    // harmless no-op at best and pointless at worst.
    useEscape(() => onClose(), !closing);

    // Build resolved list: most recently pinned first
    const resolvedPins = [...pinnedMsgIds].reverse().map(id => ({
        id,
        msg: messages.find((m: any) => m.id === id) ?? null,
    }));

    const filtered = resolvedPins.filter(({ msg }) => {
        if (!searchQuery.trim()) return true;
        const text = msg?.content?.text ?? msg?.content?.filename ?? '';
        return messageTextMatches(text, searchQuery);
    });

    return (
        <div className={`flex flex-col h-full w-full overflow-hidden ${closing ? 'pinned-panel-exit' : 'pinned-panel-enter'}`}>
            {/* Header — only shown inside the in-call overlay (where the user
                doesn't have a sidebar dropdown to toggle closed). In the
                normal right-hand panel the dropdown button above is the
                close affordance, so a second "Pinned Messages" bar would be
                redundant. */}
            {isCallOverlay && (
                <div className="flex items-center gap-2 px-4 py-3 bg-cl-surface border-b border-white/[0.06] shrink-0">
                    <Pin className="w-4 h-4 shrink-0" style={{ color: 'var(--cl-lume)' }} />
                    <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold leading-tight" style={{ color: 'var(--cl-text)' }}>Pinned Messages</p>
                        <p className="text-[11px] leading-tight mt-0.5" style={{ color: 'var(--cl-faint)' }}>Search via the bar above</p>
                    </div>
                    <ClButton
                        icon
                        size="sm"
                        variant="ghost"
                        onClick={onClose}
                        tooltip="Return to call"
                        className="ml-auto shrink-0"
                    >
                        <X className="w-4 h-4" />
                    </ClButton>
                </div>
            )}

            {/* List */}
            <div className="flex-1 overflow-y-auto divide-y divide-white/[0.04]">
                {filtered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center px-8">
                        <Pin className="w-10 h-10 mb-3" style={{ color: 'var(--cl-faint)' }} />
                        <h3 className="text-[15px] font-semibold" style={{ color: 'var(--cl-muted)' }}>
                            {searchQuery.trim() ? 'No results' : 'No pinned messages'}
                        </h3>
                        {!searchQuery.trim() && (
                            <p className="text-[12px] mt-1 max-w-[220px]" style={{ color: 'var(--cl-faint)' }}>
                                Pin an important message and it'll show up here for quick reference.
                            </p>
                        )}
                    </div>
                ) : (
                    filtered.map(({ id, msg }) => {
                        if (!msg) {
                            // Tombstone row
                            return (
                                <div key={id} className="px-4 py-3 flex items-center gap-3 group">
                                    <span className="text-[13px] italic flex-1" style={{ color: 'var(--cl-faint)' }}>
                                        Message no longer in local history
                                    </span>
                                    {canUnpin && (
                                        <ClButton
                                            icon
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => onUnpin(id)}
                                            tooltip="Unpin"
                                            className="dngr shrink-0"
                                        >
                                            <PinOff className="w-3.5 h-3.5" />
                                        </ClButton>
                                    )}
                                </div>
                            );
                        }

                        const isMe = myDeviceIds.has(msg.sender_device_id);
                        const senderName =
                            isMe ? (user?.username ?? 'You')
                            : deviceToUsername[msg.sender_device_id]
                            ?? (msg.sender_user_id ? userIdToUsername[msg.sender_user_id] : null)
                            ?? 'Unknown';

                        const avatarId: string | undefined =
                            isMe ? (user?.avatar_url ?? undefined)
                            : deviceToAvatar?.[msg.sender_device_id]
                            ?? (msg.sender_user_id ? userIdToAvatar?.[msg.sender_user_id] : undefined);

                        // Drive the deterministic colored fallback — for your
                        // own messages use your user_id, for others use whatever
                        // sender_user_id the envelope carries.
                        const senderUserId: string | null =
                            isMe ? (user?.user_id ?? null)
                            : (msg.sender_user_id ?? null);

                        const ts = msg.timestamp
                            ? new Date(msg.timestamp).toLocaleDateString([], {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                            })
                            : '';

                        // Attachment fields — field name is `mime` (not `mime_type`)
                        const filename = msg.content?.filename as string | undefined;
                        const mime = msg.content?.mime as string | undefined;
                        const objUrl = objectUrls[id];

                        // Text: detect embedded image / YouTube URLs
                        // De-tokenised for DISPLAY: a pinned message containing a
                        // mention used to render its raw wire token. URL
                        // extraction below still runs on this same value —
                        // mention tokens never contain a URL, so nothing is lost.
                        const textContent = msg.content?.type === 'text'
                            ? mentionsToDisplayText(msg.content.text as string)
                            : null;
                        const urls = textContent ? extractUrls(textContent) : [];
                        const firstYtId = urls.map(extractYouTubeId).find(Boolean) ?? null;
                        const firstImgUrl = !firstYtId ? urls.find(isDirectImageUrl) : null;

                        return (
                            <div key={id} className="group relative flex gap-3 py-3 px-4 hover:bg-white/[0.03] transition-colors">
                                {/* Avatar — userId drives the deterministic colored silhouette
                                    fallback when no picture is available. */}
                                <EncryptedAvatar
                                    attachmentId={avatarId}
                                    userId={senderUserId}
                                    token={token}
                                    className="w-8 h-8 shrink-0 mt-0.5 ring-1 ring-white/5"
                                    fallbackSize={18}
                                    disableClickProfile
                                />

                                {/* Content */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-baseline gap-2 mb-1">
                                        <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--cl-text)' }}>{senderName}</span>
                                        <span className="text-[11px] shrink-0" style={{ color: 'var(--cl-faint)' }}>{ts}</span>
                                    </div>

                                    {/* ── Text message ── */}
                                    {msg.content?.type === 'text' && (
                                        <>
                                            <p className="text-[13px] text-[var(--cl-muted)] leading-relaxed line-clamp-3 break-words">
                                                {textContent}
                                            </p>

                                            {/* YouTube embed */}
                                            {firstYtId && (
                                                <div className="mt-1.5 rounded-lg overflow-hidden w-full max-w-[220px]">
                                                    <img
                                                        src={`https://img.youtube.com/vi/${firstYtId}/mqdefault.jpg`}
                                                        alt="YouTube thumbnail"
                                                        className="w-full rounded-lg object-cover"
                                                        loading="lazy"
                                                    />
                                                    <p className="text-[11px] text-red-400 mt-0.5 font-medium">YouTube</p>
                                                </div>
                                            )}

                                            {/* Direct image URL */}
                                            {firstImgUrl && !firstYtId && (
                                                <img
                                                    src={firstImgUrl}
                                                    className="mt-1.5 max-h-24 rounded-lg object-cover"
                                                    alt="Embedded image"
                                                    loading="lazy"
                                                />
                                            )}
                                        </>
                                    )}

                                    {/* ── Attachment message ── */}
                                    {msg.content?.type === 'attachment' && (
                                        <>
                                            {mime?.startsWith('image/') ? (
                                                objUrl ? (
                                                    <img
                                                        src={objUrl}
                                                        className="max-h-32 max-w-full rounded-lg object-cover mt-1"
                                                        alt={filename ?? 'Image'}
                                                    />
                                                ) : (
                                                    <span className="flex items-center gap-1.5 text-[13px] text-[var(--cl-faint)] mt-0.5">
                                                        <Paperclip className="w-3.5 h-3.5 shrink-0" />
                                                        {filename ?? 'Image'}
                                                    </span>
                                                )
                                            ) : mime?.startsWith('video/') ? (
                                                objUrl ? (
                                                    <video
                                                        src={objUrl}
                                                        className="max-h-32 max-w-full rounded-lg mt-1"
                                                        controls
                                                        preload="metadata"
                                                    />
                                                ) : (
                                                    <span className="flex items-center gap-1.5 text-[13px] text-[var(--cl-faint)] mt-0.5">
                                                        <Paperclip className="w-3.5 h-3.5 shrink-0" />
                                                        {filename ?? 'Video'}
                                                    </span>
                                                )
                                            ) : (
                                                /* Other file types — show icon + filename */
                                                <span className="flex items-center gap-1.5 text-[13px] text-[var(--cl-faint)] mt-0.5">
                                                    <FileTypeIcon mime={mime} filename={filename} />
                                                    <span className="truncate">{filename ?? 'Attachment'}</span>
                                                </span>
                                            )}
                                        </>
                                    )}

                                    {/* ── Server invite ──
                                        Deliberately a compact one-line summary, not the full
                                        ServerInviteEmbed (icon + description + member count +
                                        Join button): that component fetches a live preview via
                                        useInvitePreview on mount, and firing one of those per
                                        pinned invite row would compete for the invite-preview
                                        endpoint's tight per-user throttle (5 req/min — see
                                        invites.controller.ts) every time this panel opens, for a
                                        row whose job is quick reference, not re-joining. "Jump to
                                        message" already lands on the full rich card with the real
                                        server name and a Join button. */}
                                    {msg.content?.type === 'server_invite' && (
                                        <span className="inline-flex items-center gap-1.5 text-[13px] text-[var(--cl-faint)] mt-0.5">
                                            <Ticket className="w-3.5 h-3.5 shrink-0" />
                                            Server invite
                                            {msg.content.code && (
                                                <span className="text-[11px] opacity-70 font-mono truncate" style={{ fontFamily: 'var(--cl-font-mono)' }}>
                                                    · {msg.content.code}
                                                </span>
                                            )}
                                        </span>
                                    )}

                                    {/* ── Fallback for every other ClientContent variant ──
                                        Only text/attachment/server_invite are ever reachable here
                                        today — ChatPane's Pin button is gated to exactly those
                                        three (see the isTextLike checks around its Pin action) —
                                        but nothing enforces that at this layer, and a message
                                        variant added later with no matching branch above would
                                        otherwise silently render as an empty row again (the exact
                                        bug this fixes for server_invite). An honest "can't preview
                                        this" beats a blank one. */}
                                    {/* ── KLIPY GIF — same opt-in / tap-to-load rules as in chat ── */}
                                    {msg.content?.type === 'klipy_gif' && (
                                        <div className="mt-1.5"><KlipyGifEmbed content={msg.content} /></div>
                                    )}

                                    {msg.content?.type !== 'text' &&
                                     msg.content?.type !== 'attachment' &&
                                     msg.content?.type !== 'server_invite' &&
                                     msg.content?.type !== 'klipy_gif' && (
                                        <span className="text-[13px] italic text-[var(--cl-faint)] mt-0.5">
                                            Unsupported message
                                        </span>
                                    )}
                                </div>

                                {/* Actions — hidden until the row is hovered/focused so a list
                                    of pins reads cleanly at rest (Discord does the same for its
                                    message action bar); focus-within keeps them reachable via
                                    keyboard/tooltip without hovering. Unpin was previously a
                                    solid 46px red disc with the same Pin icon as "pinned" itself
                                    — a lot of visual weight for a routine, reversible action, and
                                    ambiguous next to the header's identical Pin icon. Now a small
                                    ghost button (tints red only on hover, per the `dngr` utility)
                                    with PinOff so it actually reads as "remove the pin".
                                    Absolutely positioned (not `shrink-0` in the flex flow) so the
                                    text column gets the row's full width at rest instead of being
                                    squeezed by a reserved-but-invisible action-bar column — the
                                    icons still took layout width at opacity-0. `pointer-events-none`
                                    at rest keeps the (invisible) buttons from swallowing clicks
                                    meant for the text/links under them; Tab still reaches them
                                    because pointer-events doesn't gate keyboard focus, and
                                    `focus-within:opacity-100` shows them once a child is
                                    keyboard-focused. Small surface backdrop so the bar doesn't
                                    sit on top of the (already full-width) text unreadably. */}
                                <div className="absolute right-3 top-2.5 flex gap-1 items-start rounded-md bg-cl-surface/95 backdrop-blur-sm px-1 py-0.5 ring-1 ring-white/[0.06] opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto transition-opacity">
                                    <ClButton
                                        icon
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => onJumpTo(id)}
                                        tooltip="Jump to message"
                                    >
                                        <CornerUpLeft className="w-3.5 h-3.5" />
                                    </ClButton>
                                    {/* Never shown for the viewer's own pinned messages —
                                        reporting yourself is nonsense and the server also
                                        rejects self-reports (same gate as ChatPane's message
                                        menu). */}
                                    {onReport && !isMe && msg.sender_user_id && (
                                        <ClButton
                                            icon
                                            size="sm"
                                            variant="ghost"
                                            className="dngr"
                                            onClick={() => {
                                                const snippet = textContent
                                                    ?? (filename ? `[Attachment: ${filename}, sent ${ts}]` : undefined);
                                                onReport(msg.sender_user_id, senderName, snippet);
                                            }}
                                            tooltip="Report"
                                        >
                                            <Flag className="w-3.5 h-3.5" />
                                        </ClButton>
                                    )}
                                    {canUnpin && (
                                        <ClButton
                                            icon
                                            size="sm"
                                            variant="ghost"
                                            className="dngr"
                                            onClick={() => onUnpin(id)}
                                            tooltip="Unpin"
                                        >
                                            <PinOff className="w-3.5 h-3.5" />
                                        </ClButton>
                                    )}
                                </div>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};

export default PinnedMessagesPanel;
