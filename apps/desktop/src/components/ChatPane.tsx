import secureLocalStore from '../utils/secureLocalStore';
import { attachmentToDeleteWithMessage } from '../utils/attachmentOnDelete';
import { openExternalLink } from '../utils/openExternalLink';
import { freeTierTooLargeDetail } from '../utils/uploadLimitCopy';
import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { playIco } from '../utils/clPhysics';
import {
    ENCRYPTING_POOL, uploadLabel,
    DRAFT_ERASED_POOL, DRAFT_ERASED_AT, DRAFT_MIN_CHARS, pickRotating,
} from '../utils/eggPools';
import { MascotEmpty } from './MascotEmpty';
import { MemoRow } from './MemoRow';
import { useShallowStable } from '../hooks/useShallowStable';
import { useLiveCallbacks } from '../hooks/useLiveCallbacks';
import { mergeIfChanged, setIfChanged } from '../utils/renderMemo';
import { formatHourMinute, formatNumericDate, formatWeekdayShortMonthDay, formatWeekdayLongMonthDay, formatLongMonthDayYear } from '../utils/messageTimeFormat';
import { ClButton } from './ClButton';
import { ClCheckbox } from './cl';
import { createPortal } from 'react-dom';
import { useMessagePagination, MESSAGE_PAGE_SIZE } from '../hooks/useMessagePagination';
import { acquireDecryptedMedia, peekDecryptedMedia, putDecryptedMediaBlob, releaseDecryptedMedia } from '../utils/decryptedMediaCache';
import { backgroundCacheEncryptedAttachment } from '../utils/attachmentBackgroundCache';
import { peekRemoteImage, acquireRemoteImage, releaseRemoteImage, loadRemoteImage, rememberRemoteImageSize, type RemoteImage } from '../utils/remoteImageCache';
import { useKeepMountedForExit } from '../hooks/useKeepMountedForExit';
import { useEscape } from '../hooks/useEscape';
import type { RetentionHook, MessageRetention, AttachmentRetention } from '../hooks/useRetentionPolicy';
import { messageRetentionMs, attachmentRetentionMs, UNSAVE_EXPIRY_MS, getEffectiveMessageRetention, getEffectiveAttachmentRetention, resolveChatMessageRetention, resolveChatAttachmentRetention } from '../hooks/useRetentionPolicy';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { useOpenProfile } from '../contexts/ProfileOpenContext';
import { scheduleProfilePrefetch } from '../utils/profileCache';
import { useToast } from '../contexts/ToastContext';
import { useSubscription } from '../contexts/SubscriptionContext';
import { generateAesGcmKey, encryptBlob, decryptBlob, exportKeyToBase64, importKeyFromBase64, generateCallKey } from '../utils/crypto';
import { getEncryptedAttachment, putEncryptedAttachment, hasEncryptedAttachment, deleteEncryptedAttachment } from '../utils/attachmentCache';
import { downloadEncryptedAttachment, AttachmentDownloadError, describeDownloadError, isAttachmentGone } from '../utils/attachmentDownload';
import { getRemovedAttachmentIds, markAttachmentRemoved } from '../utils/removedAttachmentTracker';
import { PrioritySemaphore } from '../utils/avatarWarmQueue';
import { trackActivity } from '../utils/freezeLog';
import type { ClientContent, KlipyGifRef } from '@cipherline/shared';
import { Permissions, parseKlipyGifRef, isKlipyMediaUrl } from '@cipherline/shared';
import { MENTION_TOKEN_RE, extractMentionsFromText, parseMentionToken, mentionsToDisplayText } from '../utils/mentionTokens';
import { displayTextOf, messageTextMatches } from '../utils/messagePreviewText';
import { UNDECRYPTABLE_KIND, placeholderText } from '../utils/dmInbound';
import { parseSafetyNumberContent } from '../utils/contentValidation';
import { lastReadableMessageId, readReceiptToSend } from '../utils/readReceipt';
import { isSelfDm, chatAffordances } from '../utils/selfConversation';
import { useWindowFocus } from '../hooks/useWindowFocus';
import { EMOJI_RE, EMOJI_TOKEN_RE, isEmojiOnly, countEmojis } from '../utils/emojiText';
import { buildWireText, buildEmojiWireText, tokenMapsFromWireText } from '../utils/composerWireText';
import { rankMentionCandidates, describeMentionUserRow } from '../utils/mentionSuggestions';
import { SafetyVerificationModal } from './SafetyVerificationModal';
import { deriveContactTrust } from '../utils/contactTrust';
import { contactTrustDevices } from '../utils/contactBadgeDevices';
import { TrustBadge } from './TrustBadge';
import type { SenderVerdict } from '../utils/senderTrust';
import { UnverifiedDeviceBanner } from './UnverifiedDeviceBanner';
import { encryptAndAddress } from '../utils/encryptAndAddress';
import { classifySubmit, decideViewportAction, correctedScrollTop } from '../utils/feedScrollDecision';
import { isUnconfirmedSend, sendFailureReason, type SendPatch } from '../utils/pendingSend';
import { assignRowKeys, createEntranceTracker, createRevealGate, messageRowKey, type EntranceTracker, type RevealGate } from '../utils/messageEntrance';
import { deliveryQueue, withRateLimitRetry } from '../utils/deliveryQueue';
import { recipientBundles, recipientBundleKey, type RecipientDevice } from '../utils/recipientBundles';
import { clampFutureTimestamp } from '../utils/retentionSweeper';
import { GroupSettingsModal } from './GroupSettingsModal';
import FileViewer from './FileViewer';
// The light wrapper — the picker itself (emoji-mart + dataset) loads on demand.
import EmojiPickerPopover from './emojiPickerLazy';
import { searchEmoji } from './emojiSearch';
import type { EmojiSelection } from './EmojiPicker';
import { useServerEmojis, type ServerEmoji } from '../hooks/useServerEmojis';
import { isMyReaction } from './reactionOwnership';
import { EmojiImage, EmojiPlaceholder, MissingEmojiPlaceholder } from './server/EmojiImage';
import { resolveEmojiGlyphState } from './server/emojiGlyphState';
import { decideReactionAnim, type ReactionAnimKind, type ReactionSnapshot } from './reactionAnim';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { useContextMenu } from '../hooks/useContextMenu';
import { ChannelTopicDialog } from './server/ChannelTopicDialog';
import { ChannelIconRenderer } from './server/ChannelIconPicker';
import { ServerInviteEmbed } from './server/ServerInviteEmbed';
import { SafetyNumberEmbed } from './SafetyNumberEmbed';
import type { EmojiSuggestion } from './EmojiPicker';
import { SuggestionMenu, type SuggestionMenuItem } from './composer/SuggestionMenu';
import { nextSuggestionIndex, resolveCustomEmojiHint } from './composer/suggestionNav';
import GifPicker from './GifPicker';
import KlipyGifEmbed, { KlipyLinkEmbed } from './KlipyGifEmbed';
import { useGifFavorite } from '../hooks/useGifFavorite';
import { addKlipyFavorite, findKlipyFavorite, loadFavorites, removeFavorite } from '../utils/gifStorage';
import { ImageLightbox } from './ImageLightbox';
import { GifPlayer } from './GifPlayer';
import PinnedMessagesPanel from './PinnedMessagesPanel';
import SaveCoachMark from './SaveCoachMark';
import { nudges } from '../utils/firstWeekNudgeStore';
import { isImageUrl, isGifUrl, shouldAutoLoadImage } from '../utils/imageHosts';
import { acquireAutoLoadSlot } from '../utils/autoLoadLimiter';
import { usePrivacySettings } from '../hooks/usePrivacySettings';

import { API_BASE, MAX_TEXT_MESSAGE_LENGTH } from '../constants';

import {
    PhoneCall, Video, MoreVertical, Paperclip, Smile, Send,
    Edit2, Reply, Trash2, SmilePlus, Lock, Clock, Phone,
    User, Users, UserPlus, UserMinus, Ban, X, CornerUpLeft, Save, ChevronDown,
    Link as LinkIcon, Bookmark, Pin, Archive,
    Settings, Bell, BellDot, BellOff, LogOut, Hash,
    AlertTriangle, RotateCcw, Image as ImageIcon,
    Play, FileText, Flag, HelpCircle, Copy, Download,
} from "lucide-react";
import type { FriendStatusEntry } from '../hooks/useUserStatus';
import { EncryptedAvatar } from './EncryptedAvatar';
import { preloadAvatars } from '../hooks/useEncryptedAvatar';
import { peekRoster, refreshRoster, type Roster } from '../utils/serverRosterCache';
import {
    rememberIdentities,
    rememberUserAvatarId,
    rememberUserName,
    snapshotDeviceAvatarIds,
    snapshotDeviceNames,
    snapshotUserAvatarIds,
    snapshotUserNames,
} from '../utils/peerIdentityCache';
import { MsgBarBtn } from './primitives/MsgBarBtn';
// Aliased: this module already declares its own local `ConfirmDialog` for the
// block/remove-friend flows. The shared primitive is what the message-delete
// confirmation uses, and renaming the local one is somebody else's refactor.
import { ConfirmDialog as SharedConfirmDialog } from './primitives/ConfirmDialog';
import {
    shouldConfirmMessageDelete,
    buildDeleteConfirmCopy,
    type DeleteActivation,
    type DeleteConfirmCopy,
} from '../utils/messageDeleteConfirm';
import { findLastEditableOwnMessage, shouldOpenEditorOnArrowUp } from '../utils/editLastMessage';
import { buildAttachmentInitiateBody } from '../utils/attachmentInitiate';
import { writeToClipboard } from '../utils/clipboard';
import {
    canPinMessage,
    serverSaveAction,
    type ServerSaveAction,
    canReplyToMessage,
    canReactToMessage,
    canEditMessage,
    canDeleteMessage,
    isTextLikeMessageType,
} from '../utils/messageMenuGating';
import type { ContextMenuItem } from './primitives/ContextMenu';

// ── Large-file chunk encryption ───────────────────────────────────────────────
// Files that don't have a disk path (getPathForFile returns '') can't use the
// Node.js stream path. For small-to-medium files WebCrypto's encryptBlob works
// fine, but above ~2 GB the V8 heap limit causes a NotReadableError. The chunk
// path reads 16 MB at a time via file.slice().arrayBuffer() so the heap never
// holds more than one chunk at a time.

/** Files larger than this threshold use chunk-based IPC encryption instead of
 *  in-renderer WebCrypto when no disk path is available. */
const LARGE_FILE_THRESHOLD = 1.5 * 1024 * 1024 * 1024; // 1.5 GB
const CHUNK_ENCRYPT_SIZE   = 16  * 1024 * 1024;          // 16 MB per round-trip

/**
 * Stream-encrypt `file` through the main process in CHUNK_ENCRYPT_SIZE slices.
 * The renderer never holds more than one 16 MB plaintext + ciphertext chunk in
 * its heap at once — safe for arbitrarily large files.
 *
 * @param onProgress Called after each chunk with (bytesProcessed, totalBytes).
 * @returns Same shape as encryptFileToTemp: a temp path + key material.
 */
async function chunkEncryptFile(
    file: File,
    onProgress: (encrypted: number, total: number) => void,
): Promise<{ tempPath: string; keyB64: string; ivB64: string; encryptedSize: number }> {
    const { sessionId } = await window.electronAPI!.chunkEncryptBegin();
    try {
        let offset = 0;
        while (offset < file.size) {
            const end   = Math.min(offset + CHUNK_ENCRYPT_SIZE, file.size);
            const chunk = await file.slice(offset, end).arrayBuffer();
            await window.electronAPI!.chunkEncryptWrite(sessionId, new Uint8Array(chunk));
            offset = end;
            onProgress(offset, file.size);
        }
        return await window.electronAPI!.chunkEncryptEnd(sessionId);
    } catch (err) {
        await window.electronAPI!.chunkEncryptAbort(sessionId).catch(() => {});
        throw err;
    }
}

// ── URL embed helpers ─────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

/** Matches a Cipherline server invite URL and captures the invite code. */
const INVITE_URL_RE = /^https?:\/\/cipherline\.chat\/invite\/([A-Za-z0-9_-]+)$/i;
function extractInviteCode(url: string): string | null {
    const m = url.match(INVITE_URL_RE);
    return m ? m[1] : null;
}

/** Compact human-readable file size for staged-attachment chips (e.g. "2.4 MB"). */
function formatStagedSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = bytes / 1024;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
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

// isImageUrl / isGifUrl live in utils/imageHosts.ts (pure + unit-tested
// there) — kept out of this file so the detection logic doesn't require
// pulling in ChatPane's whole component tree to test.

/** Open a URL found in message text — validated, deduplicated with
 *  SharedContentModal's identical copy. See utils/openExternalLink.ts. */
function openUrl(url: string) {
    const result = openExternalLink(url);
    if (!result.ok) {
        console.warn(`[ChatPane] refused to open link (${result.reason}):`, url);
    }
}

// EMOJI_RE / EMOJI_TOKEN_RE / isEmojiOnly / countEmojis live in
// ../utils/emojiText (unit-tested there). EMOJI_RE now matches skin-toned,
// flag and keycap emoji as one glyph, so those emoji-only messages go jumbo.

/**
 * Wraps each emoji in the segment with a slightly larger inline span so emojis
 * stand out in mixed text (plain text stays at the parent font size).
 */
function renderSegmentWithEmojis(segment: string, keyPrefix: string): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    let lastIndex = 0;
    const re = new RegExp(EMOJI_RE.source, 'gu');
    let m: RegExpExecArray | null;
    while ((m = re.exec(segment)) !== null) {
        if (m.index > lastIndex) {
            nodes.push(segment.slice(lastIndex, m.index));
        }
        nodes.push(
            <span key={`${keyPrefix}-e-${m.index}`} style={{ fontSize: '1.25em', lineHeight: 1, display: 'inline-block' }}>
                {m[0]}
            </span>
        );
        lastIndex = m.index + m[0].length;
    }
    if (lastIndex < segment.length) {
        nodes.push(segment.slice(lastIndex));
    }
    return nodes;
}

/** Render a message body string with clickable inline hyperlinks and sized emojis.
 *  @param onInviteClick  When provided, Cipherline invite URLs call this with the
 *                        extracted code instead of opening the system browser. */
function renderTextWithLinks(text: string, onInviteClick?: (code: string) => void): React.ReactNode[] {
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    const regex = new RegExp(URL_REGEX.source, 'g');
    let match: RegExpExecArray | null;
    let segIdx = 0;
    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            const segment = text.slice(lastIndex, match.index);
            parts.push(...renderSegmentWithEmojis(segment, `seg-${segIdx++}`));
        }
        const url = match[0];
        const inviteCode = onInviteClick ? extractInviteCode(url) : null;
        const handleClick = (e: React.MouseEvent | React.KeyboardEvent) => {
            e.stopPropagation();
            if (inviteCode && onInviteClick) {
                onInviteClick(inviteCode);
            } else {
                openUrl(url);
            }
        };
        parts.push(
            <span
                key={`link-${match.index}`}
                role="link"
                tabIndex={0}
                onClick={handleClick}
                onKeyDown={(e) => { if (e.key === 'Enter') handleClick(e); }}
                className="text-[#25E0C8] hover:underline underline-offset-2 break-all cursor-pointer"
            >
                {url}
            </span>
        );
        lastIndex = match.index + url.length;
    }
    if (lastIndex < text.length) {
        parts.push(...renderSegmentWithEmojis(text.slice(lastIndex), `seg-${segIdx++}`));
    }
    return parts;
}

// ── Mention / custom-emoji token regex ───────────────────────────────────────
// Matches:  <@u:USER_ID:username>  |  <@r:ROLE_ID:rolename>  |  @everyone  |
//           @here  |  <:name:EMOJI_ID>  (custom server emoji — see
//           docs/custom-emoji-design.md; shares this pipeline rather than a
//           separate one because it's the same "structured inline token in
//           otherwise-plain encrypted text" shape mentions already solved).
// MENTION_TOKEN_RE + parseMentionToken now live in ../utils/mentionTokens —
// the conversation-list preview (Dashboard.tsx) needs the exact same token
// grammar for its own plain-text resolution and must not duplicate the regex.


/**
 * A picked emoji-mart selection, reduced to what it's actually for — the wire
 * token to insert. Native (`.native` present) → the glyph itself, unchanged
 * from before custom emojis existed. Custom (`.src` present, `.native`
 * absent — see EmojiSelection) → the `<:name:id>` token this whole pipeline
 * parses back out. Used directly for reactions (no draft/edit step, so the
 * wire form IS the display form); the compose-box insertion sites use a
 * friendlier `:name:` display form instead — see emojiTokenMapRef below.
 */
function emojiSelectionToToken(emoji: EmojiSelection): string | null {
    if (emoji.native) return emoji.native;
    if (emoji.id && emoji.name && emoji.src) return `<:${emoji.name}:${emoji.id}>`;
    return null;
}

/**
 * The `:query` autocomplete's result list, with this server's custom emojis
 * merged in. Custom matches sort ahead of native ones on an equal-quality
 * match (exact/prefix) — see docs/custom-emoji-design.md: ":part" should
 * offer ":partyblob:" before ":party_popper:" since it's the server's own
 * emoji, not an arbitrary tie-break. Native-only `searchEmoji` is untouched
 * (EmojiPicker.tsx has no knowledge of per-server data); the merge lives
 * here because ChatPane is the one place that already resolved it.
 */
/** Reaction-pill glyph size. Deliberately larger than the pill's 13px text:
 *  the emoji is the content and the count is an annotation, so tying them to
 *  one font-size (which `1em` did) is what made reactions read as small. */
const REACTION_GLYPH_PX = 18;

/**
 * Renders one reaction's glyph — a plain string reaction key (native glyph,
 * unchanged) or a custom-emoji token (`<:name:id>`, parsed the same way the
 * message-text renderer does).
 *
 * Two callers with different needs: the reaction pill passes an explicit
 * `sizePx` so the emoji can be bigger than the count next to it, while the
 * "who reacted" tooltip passes nothing and keeps the original `1em`
 * inheritance from its own font-size. Sizing is applied identically across
 * the resolved / loading / unavailable branches so the pill never resizes as
 * an emoji resolves or fails.
 */
function renderReactionGlyph(
    emoji: string,
    resolveEmoji: ((id: string) => ServerEmoji | undefined) | undefined,
    authToken: string | null,
    /** See renderTextWithMentions's own param of the same name. */
    emojisLoading?: boolean,
    /** See renderTextWithMentions's own param of the same name. */
    noServerContext?: boolean,
    /** Explicit glyph size in px. Omit to keep the original `1em`, which
     *  inherits the caller's font-size (what the tooltip relies on). */
    sizePx?: number,
): React.ReactNode {
    const parsed = parseMentionToken(emoji);
    const size = sizePx ?? '1em';
    if (parsed?.kind !== 'emoji') {
        // A native emoji is TEXT; a custom one is an <img> with an explicit
        // width/height. Those two used to produce structurally DIFFERENT boxes
        // here — the image got an exact sizePx square that the grid cell
        // centred perfectly, while this branch got an auto-height `display:
        // block` span shifted down by a hand-tuned 8% constant. So whether a
        // reaction looked centred depended on which KIND of emoji it was, which
        // is why some pills looked right and others sat high.
        //
        // A single magic offset cannot be right anyway: every emoji glyph
        // places its ink differently inside the em box, so a constant matched
        // by eye against one emoji is wrong for the next. Give this branch the
        // same explicit square the image branch gets and centre the text inside
        // it with flexbox. Both kinds now occupy an identical box, so any
        // residual optical difference is the font's own and is at least
        // CONSISTENT across every reaction.
        //
        // `sizePx` absent = the "who reacted" tooltip, which keeps its original
        // inherited rendering untouched.
        return (
            <span
                style={
                    sizePx
                        ? {
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: sizePx,
                            height: sizePx,
                            fontSize: sizePx,
                            lineHeight: 1,
                        }
                        : { lineHeight: 1 }
                }
            >
                {emoji}
            </span>
        );
    }
    const found = resolveEmoji?.(parsed.id ?? '');
    const state = resolveEmojiGlyphState(found, emojisLoading);
    const glyphBox = { height: size, width: size };
    if (state === 'loading') return <EmojiPlaceholder className="inline-block" style={glyphBox} />;
    if (state === 'unavailable') {
        return (
            <MissingEmojiPlaceholder
                label={parsed.label}
                noServerContext={noServerContext}
                className="inline-block"
                style={glyphBox}
            />
        );
    }
    return (
        <EmojiImage
            name={found!.name}
            serverId={found!.server_id}
            attachmentId={found!.attachment_id}
            keyB64={found!.key_b64}
            nonceB64={found!.nonce_b64}
            token={authToken}
            className="inline-block"
            style={glyphBox}
        />
    );
}

/**
 * Reactions the local user just clicked, as `${messageId}:${emoji}` → time.
 *
 * Why this exists: a pill is keyed by its emoji, so reacting with an emoji
 * nobody has used yet MOUNTS a brand-new pill rather than updating one. The
 * animation trigger is a diff against the previous render, and on mount there
 * is no previous render — so the most common case, "I just added a reaction",
 * animated nothing at all. Relaxing the not-on-mount rule generally is not an
 * option: that rule is what stops every reaction in the channel replaying its
 * animation on every scroll and channel switch.
 *
 * A local click is the one signal that distinguishes "this pill appeared
 * because I acted" from "this pill appeared because the list rendered". The
 * marker is consumed on read and time-bounded, so a click whose pill never
 * arrives (send failed, user navigated away) cannot animate something later.
 */
const recentLocalReactionToggles = new Map<string, number>();
// Generous on purpose: handleReact does NO optimistic update — it dispatches
// to the server and the pill only appears when the echo comes back. That
// round-trip is a poll-then-ACK on a DM and a WS fan-out on a channel, so it
// can easily exceed a snappy UI timeout. Too short and the mark expires before
// the pill it was meant for ever mounts. The mark is consumed on read, so a
// wide window costs nothing but lets a slow network still animate.
const LOCAL_REACTION_ANIM_WINDOW_MS = 15000;

function markLocalReactionToggle(key: string): void {
    // Bounded cleanup — entries are normally consumed on the very next render,
    // so this only ever sweeps clicks whose pill never mounted.
    if (recentLocalReactionToggles.size > 50) {
        const cutoff = Date.now() - LOCAL_REACTION_ANIM_WINDOW_MS;
        for (const [k, t] of recentLocalReactionToggles) {
            if (t < cutoff) recentLocalReactionToggles.delete(k);
        }
    }
    recentLocalReactionToggles.set(key, Date.now());
}

/**
 * Keys whose animation was ALREADY played locally, so the server echo that
 * follows must not replay it. Same consume-on-read, time-bounded shape as the
 * marker above.
 */
const locallyAnimated = new Map<string, number>();
const LOCAL_ANIM_SUPPRESS_MS = 4000;

function markLocallyAnimated(key: string): void {
    if (locallyAnimated.size > 50) {
        const cutoff = Date.now() - LOCAL_ANIM_SUPPRESS_MS;
        for (const [k, t] of locallyAnimated) if (t < cutoff) locallyAnimated.delete(k);
    }
    locallyAnimated.set(key, Date.now());
}

function consumeLocallyAnimated(key: string): boolean {
    const at = locallyAnimated.get(key);
    if (at === undefined) return false;
    locallyAnimated.delete(key);
    return Date.now() - at < LOCAL_ANIM_SUPPRESS_MS;
}

/** True if the local user clicked this reaction just now. Consumes the mark. */
function consumeLocalReactionToggle(key: string): boolean {
    const at = recentLocalReactionToggles.get(key);
    if (at === undefined) return false;
    recentLocalReactionToggles.delete(key);
    return Date.now() - at < LOCAL_REACTION_ANIM_WINDOW_MS;
}

/**
 * Has this exact reaction been rendered before, and was its message already on
 * screen when it appeared?
 *
 * A reaction with an emoji nobody has used yet MOUNTS a new pill. Mount alone
 * must never animate — that would replay every reaction in the channel on each
 * scroll and channel switch — but a REMOTE reaction arriving on a message you
 * are looking at is exactly a mount, and it is the case the local-click marker
 * cannot cover, because no click happened on this machine.
 *
 * Two records tell those apart:
 *  - `seenReactionKeys` — a key we have rendered before is a re-mount (scroll,
 *    pagination, channel re-entry), never an arrival.
 *  - `messageFirstSeen` — the first time we render ANY pill for a message.
 *    Pills that mount in that same commit are the message's existing
 *    reactions, not new ones, so an arrival must be meaningfully LATER than
 *    that first sighting. The age threshold is what separates "these came with
 *    the message" from "this one landed while I was watching"; a few
 *    milliseconds covers one render batch.
 */
const seenReactionKeys = new Set<string>();
const messageFirstSeen = new Map<string, number>();
const REACTION_ARRIVAL_MIN_AGE_MS = 250;

function noteReactionRenderAndShouldAnimateArrival(msgId: string, animKey: string): boolean {
    // Bounded: a long session in a busy server would otherwise grow these
    // without limit. Oldest-first eviction is fine — evicting a key only risks
    // one extra animation if that exact reaction is re-rendered much later.
    if (messageFirstSeen.size > 500) {
        const oldest = [...messageFirstSeen.entries()].sort((a, b) => a[1] - b[1]).slice(0, 250);
        for (const [k] of oldest) messageFirstSeen.delete(k);
    }
    if (seenReactionKeys.size > 4000) seenReactionKeys.clear();

    const now = Date.now();
    const first = messageFirstSeen.get(msgId);
    if (first === undefined) {
        // First time this message has rendered any reaction at all — these are
        // its existing reactions arriving with it, not new ones.
        messageFirstSeen.set(msgId, now);
        seenReactionKeys.add(animKey);
        return false;
    }
    if (seenReactionKeys.has(animKey)) return false;  // re-mount, not an arrival
    seenReactionKeys.add(animKey);
    return now - first > REACTION_ARRIVAL_MIN_AGE_MS;
}

/**
 * Whether reaction animations should be suppressed for accessibility.
 *
 * Queried per call rather than captured once at module load. The constant
 * form looked cheaper but had two real failure modes: it froze whatever
 * matchMedia happened to report at import time (including before the window
 * had settled), and toggling the OS setting could not take effect without a
 * full reload. matchMedia is a cheap synchronous lookup; a reaction click is
 * not a hot path.
 *
 * It also logs ONCE when it first suppresses something. A silent no-op here
 * is indistinguishable from a broken animation, and this gate is easy to trip
 * without realising: on Windows, Settings -> Accessibility -> Visual effects
 * -> "Animation effects" off, or the classic "Adjust for best performance"
 * option, both make Chromium report prefers-reduced-motion: reduce, which
 * silently disables EVERY motion affordance in the app, not just this one.
 */
/** Opt-in reaction-animation tracing. Off by default; enable in DevTools with
 *  `localStorage.setItem('cl_rxn_debug','1')` and reload. Kept because this
 *  path failed silently once and the logs are the fastest way back in. */
const rxnDebugOn = (): boolean => {
    try { return localStorage.getItem('cl_rxn_debug') === '1'; } catch { return false; }
};
const rxnLog = (...a: unknown[]) => { if (rxnDebugOn()) console.log('[rxn-anim]', ...a); };

let reducedMotionNoticeLogged = false;
function reactionAnimReduced(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced && !reducedMotionNoticeLogged) {
        reducedMotionNoticeLogged = true;
        console.info(
            '[Cipherline] Animations are suppressed because this system reports '
            + 'prefers-reduced-motion: reduce. On Windows this is Settings > Accessibility > '
            + 'Visual effects > Animation effects, or "Adjust for best performance".',
        );
    }
    return reduced;
}

/**
 * Web Animations API "pop" for a reaction pill — deliberately NOT a CSS
 * `@keyframes` class (every other one-off animation in this file toggles a
 * class defined in index.css) so this stays entirely component-scoped: no
 * global stylesheet edit needed. `el.animate()` only ever touches `transform`
 * and `opacity`, both compositor-only, so it never triggers layout even
 * though a message can carry many reaction pills across many rows — no
 * reflow, and cheap enough to fire on every remote reaction event in a busy
 * channel. No-ops under reduced motion (see reactionAnimReduced).
 */
function popReactionPill(el: HTMLElement | null, kind: ReactionAnimKind): void {
    if (!el) { rxnLog('SKIP: no element for', kind); return; }
    if (reactionAnimReduced()) { rxnLog('SKIP: reduced motion'); return; }
    if (typeof el.animate !== 'function') { rxnLog('SKIP: el.animate unavailable'); return; }
    rxnLog('PLAY', kind, 'on', el.tagName, el.getBoundingClientRect().width + 'px wide');
    const keyframes: Keyframe[] = kind === 'remove'
        // Your own reaction coming off — a quick settle, not a pop.
        ? [
            { transform: 'scale(1)', offset: 0 },
            { transform: 'scale(0.88)', offset: 0.4 },
            { transform: 'scale(1)', offset: 1 },
        ]
        : kind === 'bump'
        // Someone else piling on a reaction you already have — a smaller
        // nudge than your own fresh add, since it's not your action.
        ? [
            { transform: 'scale(1)', offset: 0 },
            { transform: 'scale(1.14)', offset: 0.45 },
            { transform: 'scale(1)', offset: 1 },
        ]
        // Your own fresh add — the biggest, most satisfying pop of the three.
        : [
            { transform: 'scale(0.7)', opacity: 0.7, offset: 0 },
            { transform: 'scale(1.24)', opacity: 1, offset: 0.55 },
            { transform: 'scale(1)', opacity: 1, offset: 1 },
        ];
    el.animate(keyframes, { duration: kind === 'remove' ? 180 : 260, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
}

interface ReactionPillProps {
    emoji: string;
    /** `${messageId}:${emoji}` — identifies this exact reaction for the
     *  local-click animation marker. */
    animKey: string;
    /** The owning message id, for the arrival check (see
     *  noteReactionRenderAndShouldAnimateArrival). */
    msgId: string;
    count: number;
    hasMine: boolean;
    canReact: boolean;
    resolveEmoji: ((id: string) => ServerEmoji | undefined) | undefined;
    token: string | null;
    emojisLoading?: boolean;
    noServerContext?: boolean;
    onClick: () => void;
    onHoverStart: (rect: DOMRect) => void;
    onHoverEnd: () => void;
    onContextMenuShow: (rect: DOMRect) => void;
}

/**
 * One reaction pill under a message. A real component (not the inline arrow
 * function this used to be, nested in the reactions `.map()`) specifically
 * so it can hold the per-reaction ref/effect that drives the pop animation —
 * hooks can't live in a plain callback passed to `.map()`.
 *
 * The animation trigger is a `count`/`hasMine` diff against the PREVIOUS
 * render, kept in a ref keyed to this component instance (itself keyed by
 * `msg.id`+`emoji` at the call site, so a reordered message list or an
 * unrelated re-render can't retrigger it — React preserves this instance,
 * and its ref, only for that exact reaction). The ref starts `null` and the
 * first effect run only seeds it — deliberately never animates on mount, or
 * every reaction on every message would replay its animation on every
 * channel switch and every scroll-triggered re-render.
 */
export function ReactionPill({
    emoji, animKey, msgId, count, hasMine, canReact, resolveEmoji, token, emojisLoading, noServerContext,
    onClick, onHoverStart, onHoverEnd, onContextMenuShow,
}: ReactionPillProps): React.ReactElement {
    const btnRef = useRef<HTMLButtonElement | null>(null);
    const prevRef = useRef<ReactionSnapshot | null>(null);

    useEffect(() => {
        const prev = prevRef.current;
        rxnLog('effect', animKey, 'prev=', prev, 'next=', { count, hasMine });
        if (prev === null) {
            // First render of this pill. Mount alone must never animate (that
            // would replay on every scroll / channel switch) — EXCEPT when the
            // local user just clicked this exact reaction, which is precisely
            // how a first-of-its-kind reaction appears. See
            // recentLocalReactionToggles.
            const marked = consumeLocalReactionToggle(animKey);
            // Always record the render, even when the local marker wins, so the
            // key is never treated as a fresh arrival on a later re-mount.
            const arrived = noteReactionRenderAndShouldAnimateArrival(msgId, animKey);
            rxnLog('mount path, local-click marker =', marked, 'remote arrival =', arrived);
            if (marked) popReactionPill(btnRef.current, 'add');
            // Someone ELSE reacted with an emoji nobody had used yet, on a
            // message already on screen. 'bump' rather than 'add' — 'add' is
            // the bigger, more satisfying pop reserved for your own action.
            else if (arrived) popReactionPill(btnRef.current, 'bump');
        } else {
            const kind = decideReactionAnim(prev, { count, hasMine });
            const alreadyPlayed = kind ? consumeLocallyAnimated(animKey) : false;
            rxnLog('diff path, kind =', kind, 'alreadyPlayedLocally =', alreadyPlayed);
            // A remote 'bump' is never suppressed — it is someone else's action
            // and cannot have been played by our own click.
            if (kind && (kind === 'bump' || !alreadyPlayed)) popReactionPill(btnRef.current, kind);
        }
        prevRef.current = { count, hasMine };
    }, [count, hasMine, animKey]);

    return (
        <span
            style={{ display: 'inline-flex' }}
            onMouseEnter={(e) => onHoverStart(e.currentTarget.getBoundingClientRect())}
            onMouseLeave={onHoverEnd}
            onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onContextMenuShow(e.currentTarget.getBoundingClientRect());
            }}
        >
            {/* Plain button, NOT a ClButton — the kit button's fixed-size
                cap turns the chip into a giant capsule around the emoji.
                Compact pill: emoji + count, lume when it's yours. Nudged up
                from the original h-6/text-[12px] ("a little bigger", not a
                redesign — still well short of dominating the message row). */}
            <button
                ref={btnRef}
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    // Animate NOW, not when the server echo lands.
                    //
                    // handleReact performs no optimistic state update — it just
                    // dispatches and waits — so nothing about this pill changes
                    // for a full network round-trip. Driving the animation only
                    // off that echo made it hostage to latency and, for a
                    // removal that empties the reaction, impossible: the pill
                    // unmounts, so there is no element left to animate. Playing
                    // it here gives instant feedback and is the ONLY point at
                    // which a disappearing pill still exists to animate.
                    //
                    // `hasMine` is this click's direction: if it is mine, this
                    // click removes it.
                    popReactionPill(btnRef.current, hasMine ? 'remove' : 'add');
                    markLocallyAnimated(animKey);
                    onClick();
                }}
                disabled={!canReact}
                /* Two EQUAL halves, each with its content centred in it: the
                   emoji owns the left half, the count the right. `grid-cols-2`
                   is `repeat(2, minmax(0,1fr))`, so the split is exact and does
                   not drift with the glyph's or the number's intrinsic width.
                   The previous `inline-flex items-center gap-1` centred neither:
                   flex sized each child to its own content and let the gap fall
                   between them, so a 20px glyph next to a 1-character count sat
                   visibly left of centre, and shifted again at 2+ digits.
                   `place-items-center` handles the vertical axis at the same
                   time — the glyph is 20px in a 32px pill, and `items-center`
                   alone still left the text emoji riding its own baseline. */
                className={`grid grid-cols-2 place-items-center rounded-full border px-0.5 h-7 min-w-[48px] text-[12.5px] font-semibold leading-none transition-colors ${canReact ? 'cursor-pointer' : 'cursor-default'} ${
                    hasMine
                        ? 'bg-cl-lume/15 border-cl-lume/30 text-cl-lume'
                        : 'bg-white/[0.04] border-cl-border/40 text-cl-muted hover:border-cl-lume/30 hover:bg-white/[0.07]'
                }`}
            >
                {/* Each half gets its own centring box. The glyph branch can be
                    an <img>, a skeleton, or a text emoji, and a bare text emoji
                    would otherwise sit on its baseline rather than on the
                    pill's centre line. */}
                <span className="flex items-center justify-center leading-none">
                    {renderReactionGlyph(emoji, resolveEmoji, token, emojisLoading, noServerContext, REACTION_GLYPH_PX)}
                </span>
                <span className="flex items-center justify-center tabular-nums leading-none">{count}</span>
            </button>
        </span>
    );
}

function searchEmojiWithCustom(query: string, customEmojis: ServerEmoji[], limit = 8): EmojiSuggestion[] {
    const q = query.toLowerCase();
    const customMatches: EmojiSuggestion[] = customEmojis
        .filter(e => e.name.includes(q))
        .sort((a, b) => {
            // Prefix matches first, then alphabetical — same tiering shape
            // searchEmoji itself uses for the native dataset.
            const aPrefix = a.name.startsWith(q) ? 0 : 1;
            const bPrefix = b.name.startsWith(q) ? 0 : 1;
            return aPrefix - bPrefix || a.name.localeCompare(b.name);
        })
        .slice(0, limit)
        .map(e => ({
            id: e.emoji_id,
            native: '',
            name: e.name,
            custom: { attachmentId: e.attachment_id, keyB64: e.key_b64, nonceB64: e.nonce_b64 },
        }));
    if (customMatches.length >= limit) return customMatches;
    const native = searchEmoji(query, limit - customMatches.length);
    return [...customMatches, ...native];
}

/**
 * Renders message text with @mention tokens as colored pills,
 * URLs as hyperlinks, and emojis at a slightly larger size.
 */
function renderTextWithMentions(
    text: string,
    myUserId: string | null,
    memberRoleColors: Record<string, string | null> | undefined,
    onInviteClick?: (code: string) => void,
    /** Resolves a custom-emoji token's id to its key material. Undefined in
     *  contexts with no server (DMs/groups never carry this token anyway). */
    resolveEmoji?: (id: string) => ServerEmoji | undefined,
    authToken?: string | null,
    /** True while this channel's server emoji LIST is still loading. An
     *  unresolved token during this window means "don't know yet," not
     *  "doesn't exist" — shows a pulsing placeholder instead of jumping
     *  straight to the literal `:name:` fallback, which used to flash for
     *  every custom emoji on first paint before the list arrived. */
    emojisLoading?: boolean,
    /** True when this channel has no server to check custom-emoji tokens
     *  against (DMs/groups — see ChatPane's `emojiServerId`). Softens the
     *  "unavailable" wording since "no longer available" would assert a
     *  deletion this function can't actually confirm there. */
    noServerContext?: boolean,
    /** Whether a `user`-kind mention's id is a real, currently-resolvable
     *  person (e.g. present in ChatPane's `userIdToUsername`) — gates
     *  clickability. Undefined/omitted → nothing is clickable. `@everyone`
     *  / `@here` / role mentions never consult this; they are never people. */
    isUserKnown?: (userId: string) => boolean,
    /** Fires when a clickable user mention is activated (click, or Enter/
     *  Space while focused). Caller is responsible for opening the profile
     *  (and for `e.stopPropagation()` if it needs that — this function
     *  already stops propagation on the pill itself before calling this). */
    onMentionClick?: (userId: string, e: React.MouseEvent | React.KeyboardEvent) => void,
): React.ReactNode[] {
    // Split on mention tokens first, then process each segment further for URLs
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    const tokenRe = new RegExp(MENTION_TOKEN_RE.source, 'g');
    let m: RegExpExecArray | null;
    let segIdx = 0;

    while ((m = tokenRe.exec(text)) !== null) {
        // Text before this mention — process for URLs/emojis
        if (m.index > lastIndex) {
            parts.push(...renderTextWithLinks(text.slice(lastIndex, m.index), onInviteClick));
        }
        const parsed = parseMentionToken(m[0]);
        if (parsed && parsed.kind === 'emoji') {
            const found = resolveEmoji?.(parsed.id ?? '');
            const state = resolveEmojiGlyphState(found, emojisLoading);
            parts.push(
                state === 'resolved' ? (
                    <EmojiImage
                        key={`emoji-${segIdx++}-${m.index}`}
                        name={found!.name}
                        serverId={found!.server_id}
                        attachmentId={found!.attachment_id}
                        keyB64={found!.key_b64}
                        nonceB64={found!.nonce_b64}
                        token={authToken ?? null}
                        className="inline-block align-[-0.3em]"
                        style={{ height: '1.375em', width: '1.375em' }}
                    />
                ) : state === 'loading' ? (
                    // The list hasn't loaded yet — don't know if this
                    // resolves or not. Pulsing placeholder instead of
                    // jumping straight to the "unavailable" glyph below, which
                    // used to flash on every custom emoji at first paint.
                    <EmojiPlaceholder
                        key={`emoji-loading-${segIdx++}-${m.index}`}
                        className="inline-block align-[-0.3em]"
                        style={{ height: '1.375em', width: '1.375em' }}
                    />
                ) : (
                    // List HAS loaded and this id genuinely isn't in it —
                    // deleted emoji, or a token from a server this viewer
                    // isn't in. The encrypted text is immutable, so old
                    // messages keep the token forever. Small hoverable
                    // placeholder instead of the raw ":name:" text — see
                    // MissingEmojiPlaceholder.
                    <MissingEmojiPlaceholder
                        key={`emoji-fallback-${segIdx++}-${m.index}`}
                        label={parsed.label}
                        noServerContext={noServerContext}
                        className="inline-block align-[-0.3em]"
                        style={{ height: '1.375em', width: '1.375em' }}
                    />
                )
            );
        } else if (parsed) {
            const isSelf = parsed.kind === 'user' && parsed.id === myUserId;
            const isSpecial = parsed.kind === 'everyone' || parsed.kind === 'here';
            const roleColor = parsed.kind === 'role' && memberRoleColors?.[parsed.id ?? ''];
            // Only a real, currently-resolvable user mention is clickable —
            // never @everyone/@here (not people) and never a user id we
            // can't actually resolve (unknown / departed — nothing to open).
            const clickable = parsed.kind === 'user' && !!parsed.id
                && !!isUserKnown?.(parsed.id) && !!onMentionClick;
            // Pill style
            let pillClass = '';
            let pillStyle: React.CSSProperties = {};
            if (isSelf) {
                // Own mention — amber highlight
                pillClass = 'bg-cl-glow/25 text-cl-glow hover:bg-cl-glow/35';
            } else if (isSpecial) {
                pillClass = 'bg-cl-lume/20 text-cl-lume hover:bg-cl-lume/30';
            } else if (roleColor) {
                pillStyle = { background: `${roleColor}33`, color: roleColor };
                pillClass = 'hover:opacity-90';
            } else {
                pillClass = 'bg-cl-lume/15 text-cl-lume/90 hover:bg-cl-lume/25';
            }
            const activate = (e: React.MouseEvent | React.KeyboardEvent) => {
                e.stopPropagation();
                onMentionClick!(parsed.id!, e);
            };
            parts.push(
                <span
                    key={`mention-${segIdx++}-${m.index}`}
                    className={`inline-flex items-center rounded px-1 py-0.5 text-[0.9em] font-semibold transition-colors select-none ${clickable ? 'cursor-pointer hover:underline' : 'cursor-default'} ${pillClass}`}
                    style={pillStyle}
                    {...(clickable ? {
                        role: 'button' as const,
                        tabIndex: 0,
                        'aria-label': `View ${parsed.label}'s profile`,
                        onClick: activate,
                        onKeyDown: (e: React.KeyboardEvent) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                activate(e);
                            }
                        },
                    } : {})}
                >
                    @{parsed.label}
                </span>
            );
        } else {
            // Unrecognised token — render as plain text
            parts.push(<span key={`raw-${segIdx++}`}>{m[0]}</span>);
        }
        lastIndex = m.index + m[0].length;
    }

    // Remaining text after last mention
    if (lastIndex < text.length) {
        parts.push(...renderTextWithLinks(text.slice(lastIndex), onInviteClick));
    }

    return parts;
}

/**
 * Renders an emoji-only message (native glyphs and/or custom-emoji tokens,
 * per isEmojiOnly above) for the jumbo size treatment. Deliberately NOT
 * `renderTextWithMentions` at a bigger font-size: that path wraps every
 * native emoji at a fixed 1.375em (renderSegmentWithEmojis) — stacked on top
 * of an already-huge jumbo container font-size, custom tokens sized to match
 * would read as visibly bigger than the native glyphs sitting right next to
 * them. Here, native glyphs pass through as plain text (inheriting the
 * container's font-size directly, exactly like the pre-custom-emoji jumbo
 * path always has) and only custom tokens get an explicit `1em` image —
 * matched to that same inherited size, not a fixed em-multiple of it.
 */
function renderJumboContent(
    text: string,
    resolveEmoji: ((id: string) => ServerEmoji | undefined) | undefined,
    authToken: string | null,
    /** See renderTextWithMentions's own param of the same name. */
    emojisLoading?: boolean,
    /** See renderTextWithMentions's own param of the same name. */
    noServerContext?: boolean,
): React.ReactNode[] {
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    const re = new RegExp(EMOJI_TOKEN_RE.source, 'g');
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(text)) !== null) {
        if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index));
        const parsed = parseMentionToken(m[0]);
        const found = parsed?.kind === 'emoji' ? resolveEmoji?.(parsed.id ?? '') : undefined;
        const state = resolveEmojiGlyphState(found, emojisLoading);
        parts.push(
            state === 'resolved' ? (
                <EmojiImage
                    key={`jumbo-emoji-${i++}`}
                    name={found!.name}
                    serverId={found!.server_id}
                    attachmentId={found!.attachment_id}
                    keyB64={found!.key_b64}
                    nonceB64={found!.nonce_b64}
                    token={authToken}
                    className="inline-block align-[-0.15em]"
                    style={{ height: '1em', width: '1em' }}
                />
            ) : state === 'loading' ? (
                <EmojiPlaceholder
                    key={`jumbo-emoji-loading-${i++}`}
                    className="inline-block align-[-0.15em]"
                    style={{ height: '1em', width: '1em' }}
                />
            ) : (
                // Sized in `em`, exactly like the resolved and loading
                // branches above, so it takes the same box a real emoji
                // would have taken at this jumbo tier. An earlier version
                // pinned this to 20px out of a fear of reproducing the
                // original bug — but that bug was the raw ":name:" TEXT
                // inheriting the jumbo font-size, which made a long
                // shortcode sprawl across the message. A square 1em glyph
                // has no such failure mode: it is the emoji's own footprint,
                // which is the whole point of a placeholder. Pinning it left
                // a conspicuously tiny icon where a large emoji belonged.
                <MissingEmojiPlaceholder
                    key={`jumbo-emoji-fallback-${i++}`}
                    label={parsed?.label ?? '?'}
                    noServerContext={noServerContext}
                    className="inline-block align-[-0.15em]"
                    style={{ height: '1em', width: '1em' }}
                />
            )
        );
        lastIndex = m.index + m[0].length;
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex));
    return parts;
}

/**
 * Returns true if `text` mentions the given user ID or contains @everyone / @here.
 * Used by Dashboard to detect mention-worthy incoming messages.
 */
export function messageTextMentionsUser(text: string, userId: string): boolean {
    if (text.includes('@everyone') || text.includes('@here')) return true;
    return text.includes(`<@u:${userId}:`);
}

/**
 * Returns true if `text` contains a role-mention token (`<@r:ROLE_ID:…>`)
 * for any role ID in `myRoleIds`.  Used alongside `messageTextMentionsUser`
 * to highlight messages where the viewer was pinged via one of their roles.
 * Exported so Dashboard can reuse it for channel-message notification routing.
 */
export function messageTextMentionsRole(text: string, myRoleIds: Set<string>): boolean {
    if (myRoleIds.size === 0) return false;
    const re = /<@r:([^:>]+):[^>]+>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        if (myRoleIds.has(m[1])) return true;
    }
    return false;
}

// extractMentionsFromText now lives in ../utils/mentionTokens, next to the parser it walks.

/** YouTube embed or generic link card shown below a message. */
/** Renders a direct image/GIF link inline, with a save button for GIFs.
 *
 *  Images are fetched through the Electron main process (net.fetch) so that
 *  CORS restrictions and hotlink-protection headers on third-party hosts never
 *  block either display or save.  The blob URL created on load is reused for
 *  saving, so there is only one network round-trip per image.
 */
const ImageLinkEmbed: React.FC<{ url: string }> = ({ url }) => {
    const isGif = isGifUrl(url);
    // Seeded from the session image cache (utils/remoteImageCache): an image
    // already fetched this session shows on the first paint of a remount, at
    // its remembered size — no refetch, no skeleton, no layout jump.
    const [entry, setEntry]         = useState<RemoteImage | null>(() => peekRemoteImage(url));
    const blobUrl = entry?.url ?? null;
    const blobObj = entry?.blob ?? null;
    const [errored, setErrored]     = useState(false);
    const { saved, busy: saving, toggle: toggleFavorite } = useGifFavorite(
        isGif ? blobObj : null,
        url.split('/').pop()?.split('?')[0] || 'image.gif',
    );
    const [lightboxOpen, setLightboxOpen] = useState(false);
    // Privacy: do NOT auto-fetch remote URLs from message bodies by default —
    // that would leak a zero-click read-receipt + IP to whoever sent the
    // link. `imageAutoLoad` narrows this per the user's setting: 'known'
    // (default) auto-loads only a curated set of third-party CDNs that
    // aren't the sender and so can't exploit that leak (see utils/
    // imageHosts.ts); 'always'/'never' are the two blunt ends. A click
    // always loads immediately regardless of the setting.
    // Already in memory (fetched earlier this session, by auto-load or a
    // click) → no new request can happen, so nothing to decide.
    const [shouldLoad, setShouldLoad] = useState(() => !!peekRemoteImage(url));
    // Tracks whether the current `shouldLoad=true` came from auto-load
    // (subject to the concurrency limiter below) or a user click (never
    // queued — they're waiting on it right now).
    const autoTriggeredRef = useRef(false);
    const { settings: privacySettings } = usePrivacySettings();

    const hostname = useMemo(() => {
        try { return new URL(url).hostname; } catch { return ''; }
    }, [url]);

    // Decide once per url/setting whether this embed should auto-load.
    useEffect(() => {
        if (shouldLoad || errored) return;
        const eligible = shouldAutoLoadImage(privacySettings.imageAutoLoad, hostname);
        if (eligible) {
            autoTriggeredRef.current = true;
            setShouldLoad(true);
        }
        // Only re-evaluate when the URL or the setting changes — `shouldLoad`/
        // `errored` are read, not depended on, to avoid re-arming after a
        // user later flips the setting back while this embed is mounted.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, hostname, privacySettings.imageAutoLoad]);

    // Fetch (after the user opts in, or after an eligible auto-load) via
    // main process to bypass CORS/hotlink. Auto-triggered fetches go
    // through a small concurrency limiter so a busy channel can't fire
    // dozens of simultaneous main-process fetches at once; a manual click
    // always runs immediately.
    useEffect(() => {
        if (!shouldLoad) return;
        let cancelled = false;
        let held = false;
        let release: (() => void) | null = null;
        // A hold that arrives after unmount is handed straight back.
        const take = (e: RemoteImage) => {
            if (cancelled) { releaseRemoteImage(url); return; }
            held = true;
            setEntry(e);
        };
        (async () => {
            try {
                const hit = acquireRemoteImage(url);
                if (hit) { take(hit); return; }
                if (autoTriggeredRef.current) {
                    release = await acquireAutoLoadSlot();
                    if (cancelled) return;
                }
                take(await loadRemoteImage(url, (u) => window.electronAPI!.fetchBinary(u)));
            } catch (err) {
                if (!cancelled) {
                    console.warn('[ImageLinkEmbed] Failed to load image:', url, err);
                    setErrored(true);
                }
            } finally {
                release?.();
            }
        })();
        return () => {
            cancelled = true;
            // The cache owns the URL now; it is revoked when evicted.
            if (held) releaseRemoteImage(url);
        };
    }, [url, shouldLoad]);
    // Reserve the image's real box once its size is known (320×300 cap,
    // same as the CSS limits below), so a remount doesn't jump.
    const box = entry?.width && entry?.height
        ? (() => { const k = Math.min(1, 320 / entry.width!, 300 / entry.height!); return { width: Math.round(entry.width! * k), height: Math.round(entry.height! * k) }; })()
        : null;
    const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
        const img = e.currentTarget;
        if (img.naturalWidth && img.naturalHeight) rememberRemoteImageSize(url, img.naturalWidth, img.naturalHeight);
    };

    const handleSave = (e: React.MouseEvent) => {
        e.stopPropagation();
        void toggleFavorite();
    };

    if (errored) return null;

    return (
        <div className="mt-2 img-link-wrap" style={{ position: 'relative', display: 'inline-block', maxWidth: 320 }}>
            {/* Privacy: click-to-load placeholder — no network request until the
                user opts in, so a linked image can't beacon their IP on render. */}
            {!shouldLoad && !blobUrl && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setShouldLoad(true); }}
                    title={(() => { try { return new URL(url).hostname; } catch { return url; } })()}
                    style={{ width: 200, height: 120, borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'rgba(255,255,255,0.6)' }}
                >
                    <ImageIcon className="w-5 h-5 text-white/40" />
                    <span style={{ fontSize: 12 }}>Load image</span>
                    <span style={{ fontSize: 10, opacity: 0.6, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {(() => { try { return new URL(url).hostname; } catch { return ''; } })()}
                    </span>
                </button>
            )}
            {/* Skeleton while fetching */}
            {shouldLoad && !blobUrl && (
                <div style={{ width: 200, height: 120, borderRadius: 10, background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Clock className="w-5 h-5 text-white/30 animate-pulse" />
                </div>
            )}
            {blobUrl && (isGif ? (
                <GifPlayer
                    src={blobUrl}
                    imgStyle={{ maxWidth: '100%', maxHeight: 300, borderRadius: 10, display: 'block', ...(box ?? {}) }}
                    onClick={(e) => { e.stopPropagation(); setLightboxOpen(true); }}
                    onLoadImg={onImgLoad}
                />
            ) : (
                <img
                    src={blobUrl}
                    alt=""
                    draggable={false}
                    decoding="async"
                    width={box?.width}
                    height={box?.height}
                    onLoad={onImgLoad}
                    style={{ maxWidth: '100%', maxHeight: 300, borderRadius: 10, display: 'block', cursor: 'zoom-in', ...(box ?? {}) }}
                    onClick={(e) => { e.stopPropagation(); setLightboxOpen(true); }}
                />
            ))}
            {lightboxOpen && blobUrl && (
                <ImageLightbox
                    src={blobUrl}
                    externalUrl={url}
                    filename={url.split('/').pop()?.split('?')[0] || 'image'}
                    onClose={() => setLightboxOpen(false)}
                />
            )}
            {/* Save button — GIFs only, revealed on hover. Plain <button>, not
                ClButton — ClButton's `style` prop lands on the outer wrapper
                span, not the inner .cap that actually renders, so shrinking
                below the kit's default 46px silently failed. Sizing/position/
                hover-reveal now live in .img-gif-save-btn (index.css). */}
            {isGif && blobUrl && (
                <button
                    type="button"
                    onClick={handleSave}
                    title={saved ? 'Remove from favorites' : 'Favorite GIF'}
                    aria-label={saved ? 'Remove from favorites' : 'Favorite GIF'}
                    className={`img-gif-save-btn${saved ? ' saved' : ''}${saving ? ' saving' : ''}`}
                >
                    <Bookmark
                        className="w-4 h-4"
                        style={{ color: saved ? '#fff' : '#e5e7eb', fill: saved ? '#fff' : 'none' }}
                    />
                </button>
            )}
        </div>
    );
};

const MessageEmbed: React.FC<{ url: string }> = ({ url }) => {
    const ytId = extractYouTubeId(url);

    if (ytId) {
        // aspect-ratio gives correct 16:9 height without the padding-top % trick.
        // width:100% resolves against the definite parent width (content column
        // now uses flex-1); maxWidth caps the player at 400px on wide layouts.
        return (
            <div
                className="mt-2 overflow-hidden rounded-xl bg-black"
                style={{
                    width: '100%',
                    maxWidth: '400px',
                    aspectRatio: '16 / 9',
                    boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
                }}
            >
                <iframe
                    style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                    // origin= is YouTube's documented way for embedders to declare their parent origin;
                    // without it, the player falls back to a referer-based probe that fails when our
                    // page-level Referrer-Policy is 'no-referrer' (privacy default). Passing origin
                    // explicitly lets the player accept the embed regardless of referer header policy.
                    src={`https://www.youtube-nocookie.com/embed/${ytId}?origin=${encodeURIComponent(window.location.origin)}`}
                    // Send a referrer that contains only scheme+host (no path) to YouTube. Overrides
                    // the page-level 'no-referrer' for just this iframe; without this the embed
                    // rejects with "Video player configuration error" / error 153 in packaged builds.
                    referrerPolicy="strict-origin-when-cross-origin"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    title="YouTube video"
                    loading="lazy"
                />
            </div>
        );
    }

    // Direct image/GIF link — render inline instead of a link card.
    if (isImageUrl(url)) {
        // KLIPY media links follow KLIPY's rules (opt-in, direct load, no stored bytes).
        if (isKlipyMediaUrl(url)) return <KlipyLinkEmbed url={url} />;
        return <ImageLinkEmbed url={url} />;
    }

    // Generic link card — domain + URL, no third-party metadata fetching.
    let domain = url;
    let pathname = '';
    try {
        const parsed = new URL(url);
        domain = parsed.hostname.replace(/^www\./, '');
        pathname = parsed.pathname !== '/' ? parsed.pathname : '';
    } catch { /* keep url as domain */ }

    return (
        <div
            role="link"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); openUrl(url); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); openUrl(url); } }}
            className="mt-2 cursor-pointer no-underline"
            style={{ width: '100%', maxWidth: '360px' }}
        >
            {/* Accent rail was rgba(88,166,255) — a GitHub blue that appears
                nowhere else in Cipherline and clashed with the lume accent used
                by every other embed. On the token now, as is the icon/domain
                colour (was a hardcoded #25E0C8 duplicate of --cl-lume). */}
            <div
                className="flex items-start gap-3 px-3 py-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.05] transition-colors"
                style={{ borderLeft: '3px solid var(--cl-lume)' }}
            >
                <LinkIcon className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--cl-lume)', opacity: 0.7 }} />
                <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-[12px] font-semibold truncate" style={{ color: 'var(--cl-lume)' }}>{domain}</span>
                    {pathname && (
                        <span className="text-[11px] text-cl-faint truncate">{pathname}</span>
                    )}
                    <span className="text-[11px] text-cl-faint truncate">{url.length > 55 ? url.slice(0, 55) + '…' : url}</span>
                </div>
            </div>
        </div>
    );
};

interface ChatPaneProps {
    /** Server channels only: fetch a page of history older than `beforeIso` from
     *  the API and merge it into the store. Resolves with how many rows came
     *  back, so an empty page can retire the control. Local windowing
     *  (useMessagePagination) never touches the network, so without this the
     *  feed could never show anything past the newest 50 messages. */
    onLoadOlderFromServer?: (channelId: string, beforeIso: string) => Promise<number>;
    /** Server channels only: true once Dashboard has proof (a sub-page-sized
     *  response, on either the initial catch-up fetch or a page fetched via
     *  onLoadOlderFromServer) that the server has no messages older than
     *  what's already loaded for the active channel. Dashboard never remounts,
     *  so this persists across channel switches — unlike this component's own
     *  local exhaustedByChannel state below, which is a same-mount-only latch
     *  and resets (button reappears) every time this pane remounts, which
     *  happens on every conversation switch. Without this signal the button
     *  defaulted to visible for any channel until a wasted round trip proved
     *  otherwise, which is why it showed up "constantly... even when there's
     *  no old messages to view". */
    channelHistoryExhausted?: boolean;
    bundleReady?: boolean;
    activeChat: { id: string, title?: string, type?: string, other_user_id?: string, avatar_url?: string };
    /** C2: contact userIds whose identity key changed since first-seen (unacknowledged). */
    keyChangedSenders?: Set<string>;
    /** F1: the specific reason each flagged contact is flagged. A superset of
     *  `keyChangedSenders` (which is now just its key set) — 'key_changed' is
     *  one of several verdicts, and the banner must say which, because
     *  "they reinstalled" and "this key is not published by their account at
     *  all" call for very different reactions from the user. */
    senderWarnings?: Record<string, SenderVerdict>;
    /** C2: called when the user resolves a key change (verify/acknowledge) for a contact. */
    onKeyChangeResolved?: (userId: string) => void;
    messages: any[];
    /** Server channels only: true while `messages`' catch-up fetch for the
     *  currently active channel hasn't resolved even once yet. Without this,
     *  switching to a channel whose local cache is empty (or hasn't loaded)
     *  briefly renders the "end-to-end encrypted, no history" empty state
     *  before the real messages arrive — membersFetching/chatLoading below
     *  don't cover this (membersFetching only gates the FIRST channel opened
     *  per server; every later switch within that server skips it). */
    messagesFetching?: boolean;
    onMessageSent: (msg: any) => void;
    onAddToGroup?: () => void;
    typingUsers: Set<string>;
    sendTypingEvent: (event: 'typing:start' | 'typing:stop', cid: string) => void;
    activeCall: { id: string, conversation_id?: string, livekit_url: string, livekit_token: string, e2ee_key_b64: string, videoByDefault?: boolean, mode?: 'p2p' | 'sfu', isInitiator?: boolean } | null;
    onCallChange: (callData: { id: string, conversation_id?: string, livekit_url: string, livekit_token: string, e2ee_key_b64: string, videoByDefault?: boolean, mode?: 'p2p' | 'sfu', isInitiator?: boolean } | null) => void;
    /** Fired with `true` the instant the user clicks "Call", BEFORE the
     *  start-call API round-trip. Lets Dashboard fire its panel-fade
     *  transition immediately so the user gets visual feedback rather
     *  than waiting ~1-2 s for the API. Fired with `false` on error. */
    onStartingCallChange?: (starting: boolean) => void;
    chatSearch?: string;
    friendRemovedEvent?: { removed_by: string, other_user_id: string } | null;
    onCloseChatRequest?: () => void;
    /** Current notification preference for this conversation. Defaults to 'all'. */
    notifPref?: 'all' | 'mentions' | 'none';
    /** Set a specific notification mode (replaces the old binary mute toggle). */
    onSetNotifMode?: (mode: 'all' | 'mentions' | 'none') => void;
    retention: RetentionHook;
    friendStatuses?: Record<string, FriendStatusEntry>;
    /** Pinned message IDs. DMs: the local-bookmark pin list. Channels: the
     *  shared, server-backed pinned list (every entry is also in
     *  serverSavedIds — pinning always server-saves). */
    pinnedMsgIds: string[];
    onPinMessage: (msgId: string) => void;
    onUnpinMessage: (msgId: string) => void;
    /** Server-SAVED message IDs (channel messages only) — pinned or not.
     *  Drives the amber "Saved to server" icon and suppresses the local
     *  expiry countdown. A superset of pinnedMsgIds in a channel. Not
     *  present for DMs. */
    serverSavedIds?: string[];
    /** "Save to server" / "Remove from server" (channel only, SAVE_MESSAGES).
     *  Absent for DMs, which have no server to save to. */
    onServerSaveMessage?: (msgId: string) => void;
    onServerUnsaveMessage?: (msgId: string) => void;
    pinnedSidebarExpanded: boolean;
    onTogglePinnedSidebar: () => void;
    onOpenPinnedCallOverlay: () => void;
    pinnedSearchQuery: string;
    /** Dashboard provides this ref so it can call jumpToMessage from the call overlay. */
    jumpToMessageRef?: React.MutableRefObject<((id: string) => void) | null>;
    /** Opens the profile modal for the given user id. */
    onOpenProfile?: (userId: string) => void;
    /** Forwarded from useRealtime via Dashboard. When a peer changes their
     *  avatar, the message-bubble author avatars (read from a deviceToAvatar /
     *  userIdToAvatar map populated once at chat load) and any other in-pane
     *  surfaces invalidate via this signal. */
    avatarUpdatedEvent?: { user_id: string; avatar_url: string } | null;
    /**
     * When set, ChatPane is rendering a server text channel instead of a DM/group.
     * The send path uses Sender Keys (channel key encryption) instead of ECIES
     * per-recipient envelopes. Call/pin/edit/delete controls are hidden for channels.
     */
    activeChannel?: {
        channel_id: string;
        name: string;
        topic: string | null;
        /** Optional emoji prefix shown in front of the channel name (legacy). */
        icon_emoji?: string | null;
        /** Lucide-icon identifier, preferred over icon_emoji when set. */
        icon_name?: string | null;
        server_id: string;
        /** Server-resolved per-channel permissions decimal-stringified BigInt,
         *  flowed through from the channel list. Used by ChatPane to compute
         *  canManageMessages / canEmbed / canMention via the channelPermissions prop. */
        my_permissions?: string;
    } | null;
    /** Fires (via useRealtime → Dashboard) when a moderator adds, renames, or
     *  deletes one of this channel's server's custom emojis. Refetches
     *  useServerEmojis when it matches this channel's own server_id, so an
     *  edit made by someone else shows up while this chat stays mounted —
     *  see docs/custom-emoji-design.md's "Open follow-up" section, which this
     *  closes. */
    emojisChangedEvent?: { server_id: string; ts: number } | null;
    /** Called after a channel message is successfully sent (optimistic append). */
    onChannelMessageSent?: (msg: any) => void;
    /** Instant send: update the marker on a message already shown (sending →
     *  delivered / failed). See utils/pendingSend.ts. */
    onPatchSentMessage?: (kind: 'dm' | 'channel', conversationId: string, clientMsgId: string, patch: SendPatch) => void;
    /** userId → hex role colour; when set, sender names are tinted by their top role. */
    memberRoleColors?: Record<string, string | null>;
    /** userId → server nickname; when set, server channel messages show the
     *  member's nickname instead of their account username. */
    serverMemberNicknames?: Record<string, string>;
    /**
     * Per-server retention overrides for the active channel. When set, the
     * expiry indicator on channel messages uses these values instead of the
     * user's global policy. Supplied by Dashboard from the per-server settings
     * stored in localStorage by ServerMemberOptionsModal.
     */
    channelMessageRetention?: MessageRetention;
    channelAttachmentRetention?: AttachmentRetention;
    /** Conversation type for the chat being rendered. Used as the type-specific
     *  retention fallback when no per-X override prop is provided — guarantees the
     *  badge calculator agrees with the Dashboard sweep. */
    convType?: 'dm' | 'group' | 'server';
    /** Current user's server list — used by ServerInviteEmbed to detect membership. */
    servers?: import('../hooks/useServers').ServerInfo[];
    /** Called when the user joins (or wants to navigate to) a server from an invite embed. */
    onInviteJoin?: (serverId: string, serverName: string) => void;
    /** Called when the user clicks an invite URL inside a text message — shows the
     *  invite preview / join modal.  If omitted, the URL opens in the system browser. */
    onInviteCodeClick?: (code: string) => void;
    /** Fully-resolved per-channel permission bitfield for the current user.
     *  Provided by Dashboard from the channel list's my_permissions field.
     *  Undefined for DMs and group chats — no server permission gating applies there. */
    channelPermissions?: bigint;
    /** True while this server channel's Sender Key hasn't arrived on this
     *  device yet (Dashboard's awaiting-keys gate). Disables the composer with
     *  a "waiting for keys" placeholder instead of letting sends fail. */
    channelKeyMissing?: boolean;
    /** Phase 4c: true when pullChannelKeys gave up installing this channel's
     *  key after repeated failures and is in its cool-off window before
     *  trying a fresh request — distinct from the plain "still waiting on
     *  the first delivery" state channelKeyMissing alone represents. */
    channelKeyCoolingOff?: boolean;
    /** Fired when a send fails specifically because the local device has no
     *  Sender Key for this channel yet (e2ee-engine's "No channel key"
     *  error) — lets the caller file a key request instead of only showing
     *  a toast that clears itself with nothing having asked for the key. */
    onChannelKeyMissing?: (serverId: string, channelId: string) => void;
    /** Per-userId read_at timestamp for this conversation (DM only). */
    readReceipts?: Record<string, number>;
    /** Sends a message:read WS event when enabled. */
    sendReadReceipt?: (conversation_id: string, message_id: string, opts?: { selfOnly?: boolean }) => void;
    /** Privacy setting: show/hide read receipts. */
    showReadReceipts?: boolean;
    /** Current user's own UUID — required to look up verification state per contact. */
    myUserId?: string;
    /** Opens the report flow for a specific message's sender, with the
     *  message's own (client-decrypted) text pre-filled as evidence —
     *  the "Report Message" context-menu action. Omitted → that action
     *  is hidden (e.g. no report affordance wired up for this surface yet). */
    onReport?: (userId: string, username: string, snippet?: string) => void;
}

const ConfirmDialog: React.FC<{
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    showDeleteDataCheckbox?: boolean;
    onConfirm: (deleteData?: boolean) => void;
    onCancel: () => void;
}> = ({ title, message, confirmLabel = 'Confirm', danger = false, showDeleteDataCheckbox = false, onConfirm, onCancel }) => {
    const [deleteData, setDeleteData] = useState(false);
    return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="bg-cl-deep border border-white/10 rounded-2xl shadow-2xl fade-pop-enter overflow-hidden" style={{ width: '400px', padding: '32px' }}>
                <h2 className="text-xl font-bold text-white mb-2" style={{ marginTop: 0 }}>{title}</h2>
                <p className="text-cl-muted" style={{ fontSize: '0.9rem', lineHeight: 1.5, marginBottom: '24px' }}>{message}</p>
                {showDeleteDataCheckbox && (
                    <div className="mb-6">
                        <ClCheckbox
                            checked={deleteData}
                            onChange={(v) => setDeleteData(v)}
                            label="Delete all local chat history forever"
                        />
                    </div>
                )}
                {/* flex:1 goes on wrapper divs, not ClButton's `style` — see the
                    fullWidth comment on the sidebarBlockConfirm buttons in
                    Dashboard.tsx for why. */}
                <div style={{ display: 'flex', gap: '12px' }}>
                    <div style={{ flex: 1 }}>
                        <ClButton variant="ghost" fullWidth onClick={onCancel}>Cancel</ClButton>
                    </div>
                    <div style={{ flex: 1 }}>
                        <ClButton variant={danger || deleteData ? 'danger' : 'primary'} fullWidth onClick={() => onConfirm(showDeleteDataCheckbox ? deleteData : undefined)}>
                            {deleteData ? 'Delete & Close' : confirmLabel}
                        </ClButton>
                    </div>
                </div>
            </div>
        </div>
    );
};



/**
 * Attachments above this size decrypt automatically on first view only, then
 * require an explicit tap on revisit (decrypting a 2 GB blob on every scroll-by
 * is not free).
 *
 * Module scope because two places need it: the auto-decrypt effect, and
 * retryDecrypt(). It used to be declared inside the effect, so retryDecrypt's
 * reference resolved to nothing and retrying a failed decrypt threw a
 * ReferenceError instead of retrying — reported all along as TS2304
 * "Cannot find name 'LARGE_FILE_BYTES'".
 */
const LARGE_FILE_BYTES = 50 * 1024 * 1024;
/** The bits of an attachment message's content the media caches key on. */
type AttachmentRef = { type?: string; attachment_id?: string };
// Auto-decrypt concurrency. Opening a chat used to start a download + decrypt
// for EVERY attachment in it at once (and again, in parallel, for each chat
// flicked past on the way). Four at a time keeps the network busy while the
// newest — the ones on screen — finish first.
const attachmentDecryptSlots = new PrioritySemaphore(4);

/**
 * Quick-reaction row shown at the top of the message context menu. Fixed set,
 * not a real "recent/frequent" ranking — this app doesn't track per-user
 * emoji usage anywhere yet, so building a live-ranked row here would be a new
 * feature, not a wiring-up of an existing one. These four are a reasonable,
 * static stand-in for "recent/frequent"; "more…" opens the full picker
 * (custom server emoji included) for anything else.
 */
const QUICK_REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉'];

const NOOP_TYPING: (event: 'typing:start' | 'typing:stop', cid: string) => void = () => {};

const ChatPane: React.FC<ChatPaneProps> = ({ bundleReady = false, activeChat, keyChangedSenders, senderWarnings = {}, onKeyChangeResolved, messages, messagesFetching = false, onMessageSent, onAddToGroup, typingUsers, sendTypingEvent: sendTypingEventProp, activeCall, onCallChange, onStartingCallChange, chatSearch = '', friendRemovedEvent, onCloseChatRequest, notifPref = 'all', onSetNotifMode, retention, friendStatuses, pinnedMsgIds, onPinMessage, onUnpinMessage, serverSavedIds = [], onServerSaveMessage, onServerUnsaveMessage, pinnedSidebarExpanded, onTogglePinnedSidebar, onOpenPinnedCallOverlay, pinnedSearchQuery, jumpToMessageRef, onOpenProfile, avatarUpdatedEvent, activeChannel = null, emojisChangedEvent, onChannelMessageSent, onPatchSentMessage, memberRoleColors, serverMemberNicknames, channelMessageRetention, channelAttachmentRetention, convType, servers = [], onInviteJoin, onInviteCodeClick, channelPermissions, channelKeyMissing = false, channelKeyCoolingOff = false, onChannelKeyMissing, onLoadOlderFromServer, channelHistoryExhausted = false, readReceipts = {}, sendReadReceipt, showReadReceipts = true, myUserId = '', onReport }) => {
    const { token, deviceId, user } = useAuth();
    const openProfileCtx = useOpenProfile();
    const toast = useToast();
    // "Message yourself": a one-member DM. Derived from the chat's own shape
    // (`other_user_id` is YOUR id) so it holds for every way the chat can be
    // opened. `affordances` is the single list of what such a chat does not do.
    const isSelfChat = isSelfDm(activeChat, myUserId || user?.user_id);
    const affordances = chatAffordances(isSelfChat);
    // Nobody else is there to see you type: the event is never emitted.
    const sendTypingEvent = affordances.typingIndicators ? sendTypingEventProp : NOOP_TYPING;
    // Free tier caps uploads at 100 MB (paid/trial = 2 GB). Server enforces it
    // on initiate; this is the friendly pre-upload check + upgrade nudge.
    const { maxUploadBytes, isFreeTier, promptUpgrade } = useSubscription();

    // ── Pinned messages panel: keep mounted through its exit animation ────────
    // `pinnedSidebarExpanded` flips false the instant the user toggles the
    // panel closed, and the portal below used to stop rendering
    // PinnedMessagesPanel that same render — the content vanished instantly
    // while the host shell (Dashboard.tsx's DM panel / ServerContextPanel.tsx)
    // spent the next 220ms animating its own height/opacity collapse around
    // an already-empty box. `pinnedPanelMounted` lags the close by
    // PINNED_PANEL_EXIT_MS (see useKeepMountedForExit.test.ts for the state
    // machine's own coverage) so `.pinned-panel-exit` (index.css) has time to
    // play, and is kept shorter than that 220ms host collapse so the content
    // is always gone before the host unmounts the portal root out from under
    // it. A re-open within the grace window just cancels the pending timer —
    // no ghost, nothing left stuck, immediate re-open.
    const PINNED_PANEL_EXIT_MS = 200;
    const pinnedPanelMounted = useKeepMountedForExit(pinnedSidebarExpanded, PINNED_PANEL_EXIT_MS);
    // Snapshot of the last-rendered-open <PinnedMessagesPanel> element.
    // Refreshed every render while open; left untouched once closing starts,
    // so the frozen element (same messages/searchQuery/scroll-bearing DOM
    // node) is what fades out — the exit animation must not visibly disturb
    // scroll position or an in-progress search by snapping to whatever the
    // live props become post-close (e.g. Dashboard.tsx clears
    // pinnedSearchQuery back to '' the moment pinnedSidebarExpanded is false).
    const pinnedPanelElementRef = useRef<React.ReactElement<React.ComponentProps<typeof PinnedMessagesPanel>> | null>(null);

    // ── Per-channel effective retention helpers ───────────────────────────────
    // When a per-server retention override is set (channelMessageRetention /
    // channelAttachmentRetention props), use that instead of the global policy
    // for all expiry calculations and "saved" state in this channel.
    const getEffectiveMsgExpiryAt = (id: string, sentAtMs: number, mediaWindow = false): number | null => {
        // Explicit save always wins.
        if (retention.policy.savedMessageIds.includes(id)) return null;
        // KLIPY GIFs age with the ATTACHMENT window (saved state stays per message id).
        if (mediaWindow) return getEffectiveMediaMsgExpiryAt(id, sentAtMs);
        // Resolution chain: per-X override > per-type default (dm/group/server) > global.
        // The per-type default fallback keeps the badge calculator in sync with the
        // Dashboard sweep, which uses the same chain.
        const typeDefault: MessageRetention = convType
            ? getEffectiveMessageRetention(retention.policy, convType)
            : retention.policy.messageRetention;
        const effRetention: MessageRetention = channelMessageRetention ?? typeDefault;
        // Explicit unsave: grace period anchored to unsave time, with natural window applied.
        if (retention.policy.unsavedMessageIds.includes(id)) {
            const unsavedAt   = retention.policy.unsavedMessageTimestamps?.[id] ?? sentAtMs;
            const graceExpiry = unsavedAt + UNSAVE_EXPIRY_MS;
            const retMs       = messageRetentionMs(effRetention);
            if (retMs === Number.POSITIVE_INFINITY) return graceExpiry;
            return Math.max(sentAtMs + retMs, graceExpiry);
        }
        if (effRetention === 'never') return null;
        return sentAtMs + messageRetentionMs(effRetention);
    };
    const getEffectiveMediaMsgExpiryAt = (id: string, sentAtMs: number): number | null => {
        const typeDefault: AttachmentRetention = convType
            ? getEffectiveAttachmentRetention(retention.policy, convType)
            : retention.policy.attachmentRetention;
        const effRetention: AttachmentRetention = channelAttachmentRetention ?? typeDefault;
        if (retention.policy.unsavedMessageIds.includes(id)) {
            const unsavedAt   = retention.policy.unsavedMessageTimestamps?.[id] ?? sentAtMs;
            const graceExpiry = unsavedAt + UNSAVE_EXPIRY_MS;
            const retMs       = attachmentRetentionMs(effRetention);
            if (retMs === Number.POSITIVE_INFINITY) return graceExpiry;
            return Math.max(sentAtMs + retMs, graceExpiry);
        }
        if (effRetention === 'never') return null;
        return sentAtMs + attachmentRetentionMs(effRetention);
    };
    const getEffectiveAttachExpiryAt = (attId: string, sentAtMs: number): number | null => {
        if (retention.policy.savedAttachmentIds.includes(attId)) return null;
        const typeDefault: AttachmentRetention = convType
            ? getEffectiveAttachmentRetention(retention.policy, convType)
            : retention.policy.attachmentRetention;
        const effRetention: AttachmentRetention = channelAttachmentRetention ?? typeDefault;
        if (retention.policy.unsavedAttachmentIds.includes(attId)) {
            const unsavedAt   = retention.policy.unsavedAttachmentTimestamps?.[attId] ?? sentAtMs;
            const graceExpiry = unsavedAt + UNSAVE_EXPIRY_MS;
            const retMs       = attachmentRetentionMs(effRetention);
            if (retMs === Number.POSITIVE_INFINITY) return graceExpiry;
            return Math.max(sentAtMs + retMs, graceExpiry);
        }
        if (effRetention === 'never') return null;
        return sentAtMs + attachmentRetentionMs(effRetention);
    };
    /** True when a message is considered "saved" under the effective policy.
     *  An explicit per-channel finite retention means messages are NOT saved
     *  by default — they will expire — even if the global policy is 'never'. */
    const isEffectiveMsgSaved = (id: string, mediaWindow = false): boolean => {
        if (retention.policy.unsavedMessageIds.includes(id)) return false;
        if (retention.policy.savedMessageIds.includes(id)) return true;
        // A KLIPY GIF is "kept by default" only when the ATTACHMENT window is Forever.
        if (mediaWindow) return resolveChatAttachmentRetention(retention.policy, convType, channelAttachmentRetention) === 'never';
        const effRetention: MessageRetention = resolveChatMessageRetention(retention.policy, convType, channelMessageRetention);
        return effRetention === 'never';
    };
    const isEffectiveAttachSaved = (attId: string): boolean => {
        if (retention.policy.unsavedAttachmentIds.includes(attId)) return false;
        if (retention.policy.savedAttachmentIds.includes(attId)) return true;
        const effRetention: AttachmentRetention = resolveChatAttachmentRetention(retention.policy, convType, channelAttachmentRetention);
        return effRetention === 'never';
    };

    const [inputText, setInputText] = useState('');
    const [sending, setSending] = useState(false);

    // ── Physics / personality refs ────────────────────────────────────────────
    const sendIcoRef     = useRef<SVGSVGElement | null>(null);
    const emptySendRef = useRef(0);           // consecutive empty send attempts
    const [loudInput,  setLoudInput]  = useState(false); // ALL CAPS detection
    const [composerFocused, setComposerFocused] = useState(false); // whole-pill focus glow
    const [boxTremble, setBoxTremble] = useState(false); // brief @everyone shake
    const everyonePrevRef = useRef(false);               // tracks @everyone presence edge

    // Placeholder pool for empty send egg (3+ attempts)
    /** Staged-then-removed attachments before the paperclip shrugs. */
    const ATTACH_SHRUG_AT = 3;

    const EMPTY_SEND_POOL = [
        "the void can't receive messages",
        "there's nothing here to send",
        'words first, then send',
        'try saying something first',
    ];
    const emptySendPlaceholder = useRef(0);

    // ── The composer placeholder is ONE slot with three eggs wanting it ──────
    // (empty-send crash, write-then-erase, and anything added later). They all
    // go through here so a second egg can't stomp the first one's line
    // mid-display, and so the restore timer is never double-scheduled.
    const phTimer = useRef(0);
    const flashPlaceholder = useCallback((line: string, ms = 2400) => {
        const el = inputRef.current;
        if (!el) return;
        window.clearTimeout(phTimer.current);
        el.setAttribute('placeholder', line);
        phTimer.current = window.setTimeout(() => {
            // Drop the override and let React's own placeholder prop win again
            // on the next render.
            inputRef.current?.removeAttribute('placeholder');
        }, ms);
    }, []);
    useEffect(() => () => window.clearTimeout(phTimer.current), []);

    // ── Write-then-erase ────────────────────────────────────────────────────
    // Typing something real and deleting all of it, three times over. Tracks
    // the high-water length since the field was last empty, so a stray
    // keystroke doesn't count and neither does a send (which clears the field
    // through a different path — see the reset in the send handler).
    const draftHighWater = useRef(0);
    const draftErases = useRef(0);

    /** Staged files removed without ever sending — see removeStagedFile. */
    const attachRemovals = useRef(0);
    const clipRef = useRef<HTMLButtonElement>(null);

    // Header-lock escalation egg (catalog): clicking the E2EE lock repeatedly
    // earns increasingly dry reassurance in an owned status slot; reverts 3.5s
    // after the last poke. Factually true every time.
    const LOCK_POOL = ['still encrypted.', 'yes, still.', 'it’s not going to stop being encrypted.', '…'];
    const [lockMsg, setLockMsg] = useState<string | null>(null);
    const lockPokes = useRef(0);
    const lockTimer = useRef(0);
    const pokeLock = () => {
        lockPokes.current = Math.min(lockPokes.current + 1, LOCK_POOL.length);
        setLockMsg(LOCK_POOL[lockPokes.current - 1]);
        window.clearTimeout(lockTimer.current);
        lockTimer.current = window.setTimeout(() => { setLockMsg(null); lockPokes.current = 0; }, 3500);
    };
    useEffect(() => () => window.clearTimeout(lockTimer.current), []);

    // Upload status pool (catalog) — deterministic per filename so re-renders
    // don't reroll the line mid-upload.
    // Empty-conversation copy. Permanent UI text, not an egg — so no rotating
    // pool (rule 3 doesn't apply) and it stays factual. Naming the other person
    // is local data the client already holds; nothing is revealed or
    // transmitted by rendering it (rule 8).
    const emptyChatCopy = activeChannel
        ? {
            title: `#${activeChannel.name} is empty`,
            sub: 'First message sets the tone. It’s encrypted either way.',
        }
        : convType === 'group'
            ? {
                title: 'No messages yet',
                sub: 'Everyone here has their own keys. Nothing leaves this device readable.',
            }
            : {
                title: 'No messages yet',
                sub: activeChat?.title
                    ? `Whatever you send ${activeChat.title} is encrypted on this machine before it leaves.`
                    : 'Anything you send is encrypted on this machine before it leaves.',
            };

    // Pools live in utils/eggPools.ts (testable; the doctrine's ≥3-line and
    // banned-vocabulary rules are enforced there). The label is chosen ONCE
    // when the upload is seeded and stored — the old version recomputed it
    // from a filename hash on every render specifically so it couldn't reroll
    // mid-upload, and the streak count would have broken that guarantee.
    const [uploadLabels, setUploadLabels] = useState<Record<string, string>>({});
    const uploadStreak = useRef(0);
    /** Called at each upload's pct-0 seed, in both the DM and channel paths. */
    const beginUploadLabel = (name: string) => {
        const label = uploadLabel(name, uploadStreak.current);
        uploadStreak.current++;
        setUploadLabels(prev => ({ ...prev, [name]: label }));
    };

    // ── Rate limiter: max 5 messages per 5 s (sliding window) ────────────────
    const RATE_LIMIT_MAX   = 5;
    const RATE_LIMIT_MS    = 5_000;
    const sendTimestamps   = useRef<number[]>([]);
    const [cooldownSecs, setCooldownSecs] = useState(0);
    const cooldownTimer    = useRef<ReturnType<typeof setInterval> | null>(null);

    const startCooldown = (remainingMs: number) => {
        if (cooldownTimer.current) clearInterval(cooldownTimer.current);
        setCooldownSecs(Math.ceil(remainingMs / 1000));
        cooldownTimer.current = setInterval(() => {
            setCooldownSecs(prev => {
                if (prev <= 1) {
                    clearInterval(cooldownTimer.current!);
                    cooldownTimer.current = null;
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
    };

    /** Returns the ms to wait before another send is allowed (0 = allowed now). */
    const getRateLimitDelay = (): number => {
        const now = Date.now();
        // Prune timestamps older than the window
        sendTimestamps.current = sendTimestamps.current.filter(t => now - t < RATE_LIMIT_MS);
        if (sendTimestamps.current.length < RATE_LIMIT_MAX) return 0;
        // Oldest timestamp in the window tells us when the slot frees up
        const oldest = sendTimestamps.current[0];
        return RATE_LIMIT_MS - (now - oldest);
    };
    // ─────────────────────────────────────────────────────────────────────────
    // Decrypted attachment URLs, by message id. Seeded from the session media
    // cache (utils/decryptedMediaCache) so re-opening a conversation shows its
    // images on the first paint instead of re-decrypting each one; the holds
    // are taken in the layout effect below and released on unmount.
    const [objectUrls, setObjectUrls] = useState<Record<string, string>>(() => {
        const seed: Record<string, string> = {};
        for (const m of messages) {
            const c = m?.content as AttachmentRef | undefined;
            if (m?.id && c?.type === 'attachment' && c.attachment_id) {
                const url = peekDecryptedMedia(c.attachment_id);
                if (url) seed[m.id] = url;
            }
        }
        return seed;
    });
    /** msgId → attachment id for every URL this pane holds in the media cache. */
    const heldMediaRef = useRef<Map<string, string>>(new Map());
    const paneMountedRef = useRef(true);
    // Attachment decrypts finish one by one; applying each as its own state
    // update re-rendered the whole pane once per image on a media-heavy chat.
    // Completions landing within one frame are applied together.
    // (`null` drops an entry — a render-time seed that was evicted before the
    // pane could take its hold; the decrypt effect then redoes it.)
    const pendingObjectUrlsRef = useRef<Record<string, string | null> | null>(null);
    const queueObjectUrl = useCallback((msgId: string, url: string | null) => {
        if (!pendingObjectUrlsRef.current) {
            pendingObjectUrlsRef.current = {};
            setTimeout(() => {
                const batch = pendingObjectUrlsRef.current;
                pendingObjectUrlsRef.current = null;
                if (!batch || !paneMountedRef.current) return;
                setObjectUrls(prev => {
                    const next = { ...prev };
                    for (const [id, u] of Object.entries(batch)) {
                        if (u === null) delete next[id]; else next[id] = u;
                    }
                    return next;
                });
            }, 16);
        }
        pendingObjectUrlsRef.current[msgId] = url;
    }, []);
    useLayoutEffect(() => {
        paneMountedRef.current = true;
        // Take the holds for the render-time seed. A seed that was evicted (or
        // replaced) in between is dropped so the decrypt effect redoes it.
        const lost: string[] = [];
        for (const m of messages) {
            const c = m?.content as AttachmentRef | undefined;
            const seeded = m?.id ? objectUrls[m.id] : undefined;
            if (!seeded || heldMediaRef.current.has(m.id) || c?.type !== 'attachment' || !c.attachment_id) continue;
            const url = acquireDecryptedMedia(c.attachment_id);
            if (url === seeded) heldMediaRef.current.set(m.id, c.attachment_id);
            else {
                if (url) releaseDecryptedMedia(c.attachment_id);
                lost.push(m.id);
            }
        }
        for (const id of lost) queueObjectUrl(id, null);
        const held = heldMediaRef.current;
        return () => {
            paneMountedRef.current = false;
            for (const attId of held.values()) releaseDecryptedMedia(attId);
            held.clear();
        };
        // Mount/unmount only: later URLs are held as they are created.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    /**
     * Show `url` (already registered in the media cache under `attachmentId`
     * and held for this caller) for message `msgId` right away. Replaces a hold
     * this row already had; if the pane is gone, gives the hold back.
     */
    const adoptAttachmentUrl = (msgId: string, attachmentId: string, url: string) => {
        if (!paneMountedRef.current) { releaseDecryptedMedia(attachmentId); return; }
        const prev = heldMediaRef.current.get(msgId);
        if (prev !== undefined) releaseDecryptedMedia(prev);
        heldMediaRef.current.set(msgId, attachmentId);
        setObjectUrls(p => ({ ...p, [msgId]: url }));
    };
    const [myDeviceIds, setMyDeviceIds] = useState<Set<string>>(new Set([deviceId || '']));
    // The participants of THIS conversation, as its own directory fetch
    // reported them. Deliberately NOT seeded from the identity cache and
    // deliberately not merged: it is the scope that keeps the four seeded maps
    // below from widening anything that reads them wholesale (today, the
    // DM/group @-mention candidate list). Empty until the fetch lands, which is
    // exactly where the pre-cache maps started, so mentions behave as before.
    const [conversationUserIds, setConversationUserIds] = useState<Set<string>>(() => new Set());
    // The four author maps, all seeded from the session-level peer identity
    // cache rather than `{}`. Dashboard keys this pane on activeChat.id, so it
    // remounts on EVERY conversation switch and these used to restart empty —
    // leaving every message row with `attachmentId === undefined` AND no name
    // until a fresh GET /conversations/:id/devices landed. That is why
    // already-downloaded avatars still flashed the fallback and cross-faded in
    // on every switch, and why rows briefly read "Unknown User" for people
    // resolved seconds earlier. Seeding makes both facts available on the FIRST
    // render: the name renders straight away, and useEncryptedAvatar's useState
    // initialiser serves the warm memory cache synchronously so the avatar
    // paints solid. See utils/peerIdentityCache — including why this can never
    // outrank a server nickname.
    const [deviceToUsername, setDeviceToUsername] = useState<Record<string, string>>(snapshotDeviceNames);
    const [deviceToAvatar, setDeviceToAvatar] = useState<Record<string, string>>(snapshotDeviceAvatarIds);
    const [userIdToUsername, setUserIdToUsername] = useState<Record<string, string>>(snapshotUserNames);
    const [userIdToAvatar, setUserIdToAvatar] = useState<Record<string, string>>(snapshotUserAvatarIds);
    // Refs for the lazy username/avatar resolver effect below. inFlightUserFetches
    // dedupes concurrent fetches for the same id; failedUserFetches caches 404s
    // (deleted accounts) so we don't retry every render. Both are per-component-
    // instance — fine for our use case since ChatPane mounts once per active chat.
    const inFlightUserFetches = useRef<Set<string>>(new Set());
    const failedUserFetches = useRef<Set<string>>(new Set());
    // Server IDs whose member list has been fully fetched at least once this
    // session. On first visit to a server we hold the message list behind a
    // spinner; on subsequent channel switches within the same server the maps
    // are already populated so we render immediately.
    const fetchedServerIds = useRef<Set<string>>(new Set());
    const [membersFetching, setMembersFetching] = useState(false);
    // DM/group conversation IDs whose participant list + avatars have been
    // fully preloaded. Same gate pattern as fetchedServerIds — spinner on first
    // visit, instant render on return visits (avatars already in memory cache).
    const fetchedChatIds = useRef<Set<string>>(new Set());
    const [chatLoading, setChatLoading] = useState(false);
    const [stagedFiles, setStagedFiles] = useState<File[]>([]);
    const [isDragOver, setIsDragOver] = useState(false);
    const dragCounterRef = useRef(0);
    const [manualDecryptIds, setManualDecryptIds] = useState<Set<string>>(new Set());
    const [decryptingIds, setDecryptingIds] = useState<Record<string, number>>({}); // msgId → 0-100
    /** Per-message decrypt failure state. Drives the "Couldn't decrypt — Retry"
     *  card. Cleared the moment a retry is initiated. */
    const [decryptErrors, setDecryptErrors] = useState<Record<string, { code: string; message: string }>>({});
    /** Per-message "attachment was removed (retention/server-side)" state. Drives
     *  the subtle gray "Attachment no longer available" placeholder INSTEAD of the
     *  alarming red error card. Hydrated from localStorage on every chat open so
     *  the placeholder appears immediately without an extra 404 round-trip. */
    const [removedAttachmentMsgIds, setRemovedAttachmentMsgIds] = useState<Set<string>>(new Set());
    /** AbortControllers for in-flight manual decrypts so the Cancel button can stop them. */
    const decryptAbortRef = useRef<Map<string, AbortController>>(new Map());
    const pagination = useMessagePagination(messages, activeChat?.id);
    const preservedScrollHeightRef = useRef<number | null>(null);
    const feedRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hasSentOnce = useRef(false); // guard: don't steal focus on mount
    const autoDecryptingRef = useRef<Set<string>>(new Set()); // in-flight auto-decrypt guard

    // ── Message entrance-animation bookkeeping ────────────────────────────
    // We animate ONLY genuinely-new messages (just-sent + freshly-arrived),
    // never the initial history dump and never paginated-in older messages —
    // and each one exactly ONCE. The tracker works on the row's stable identity
    // (utils/messageEntrance.ts messageRowKey), not `msg.id`: an instantly-sent
    // channel message swaps its client id for the server's within a few hundred
    // ms, and keying on the id replayed the entrance on every swap.
    // One tracker per mounted pane (a useState initialiser: created once, and
    // usable during render without reading a ref).
    const [entrance] = useState<EntranceTracker>(createEntranceTracker);
    useEffect(() => {
        entrance.reset();
        // "in a row" means in this conversation — carrying the streak across a
        // switch would quip about files the user sent somewhere else.
        uploadStreak.current = 0;
    }, [entrance, activeChat?.id, activeChannel?.channel_id]);
    const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({}); // filename → 0-100

    // Blob-URL cache for staged-file preview thumbnails.
    // Keyed by File object identity so the same URL is returned on every re-render
    // (progress updates must not recreate URLs — that reloads the video decoder).
    // Entries are revoked whenever a file is removed from stagedFiles.
    const stagedFileUrlCacheRef = useRef<Map<File, string>>(new Map());
    const getOrCreateStagedUrl = (f: File): string | null => {
        if (!f.type.startsWith('image/') && !f.type.startsWith('video/')) return null;
        if (!stagedFileUrlCacheRef.current.has(f)) {
            stagedFileUrlCacheRef.current.set(f, URL.createObjectURL(f));
        }
        return stagedFileUrlCacheRef.current.get(f)!;
    };
    useEffect(() => {
        // Revoke blob URLs for files that are no longer staged.
        const currentSet = new Set(stagedFiles);
        for (const [file, url] of stagedFileUrlCacheRef.current) {
            if (!currentSet.has(file)) {
                URL.revokeObjectURL(url);
                stagedFileUrlCacheRef.current.delete(file);
            }
        }
    }, [stagedFiles]);
    useEffect(() => {
        const cache = stagedFileUrlCacheRef.current;
        return () => {
            for (const url of cache.values()) URL.revokeObjectURL(url);
            cache.clear();
        };
    }, []);
    // ── Read receipts: send when messages load while this chat is active ──────
    const lastSentReceiptRef = useRef<string | null>(null);
    // Focused AND visible: a read needs a reader (utils/readReceipt.ts
    // readReceiptToSend). Re-runs the effect below when attention returns, so
    // whatever arrived while the window was in the background is reported then.
    const windowAttended = useWindowFocus();
    useEffect(() => {
        if (!sendReadReceipt || !activeChat?.id) return;
        // The newest REAL message, never a row this device made up (an
        // undecryptable placeholder, a group "X added Y" line): other devices
        // read `last_read_message_id` — mobile's gap detector reports any id it
        // does not hold as a message that never arrived — and the gateway
        // rejects a non-UUID. See utils/readReceipt.ts.
        const send = readReceiptToSend({
            lastId: lastReadableMessageId(messages),
            lastSentId: lastSentReceiptRef.current,
            attended: windowAttended,
            // A self chat has no one to receipt to: always the self-only form, which
            // still clears the unread badge on your other devices.
            showReadReceipts: showReadReceipts && affordances.readReceipts,
        });
        if (!send) return;
        lastSentReceiptRef.current = send.id;
        sendReadReceipt(activeChat.id, send.id, send.selfOnly ? { selfOnly: true } : undefined);
    }, [messages, activeChat?.id, showReadReceipts, affordances.readReceipts, sendReadReceipt, windowAttended]);

    const [safetyModalOpen, setSafetyModalOpen] = useState(false);
    const [groupSettingsOpen, setGroupSettingsOpen] = useState(false);
    // Chat-header "More" menu (3-dot button). Uses the canonical
    // useContextMenu primitive so it portals to body and viewport-clamps —
    // never clipped by the chat-pane's overflow-hidden ancestors.
    const moreMenu = useContextMenu();

    // Channel topic full-text popup — shown when the user clicks the
    // truncated topic line in the chat header for a server channel.
    const [showTopicDialog, setShowTopicDialog] = useState(false);
    // Tracks where each row's mousedown landed, so onRowClick can tell a tap
    // apart from a drag. Single ref shared across rows is fine — only one row
    // can be receiving a drag at a time.
    const rowMouseDownRef = useRef<{ x: number; y: number } | null>(null);
    /** True for the instant a pointer press is being dispatched on a message row —
     *  see the row's onFocus for why a mouse-driven focus must not pin the bar. */
    const rowPointerPressRef = useRef(false);
    const [isFriend, setIsFriend] = useState(true); // optimistic default
    const [friendStatus, setFriendStatus] = useState<string>('accepted');

    // ── Per-channel permission gates ────────────────────────────────────────
    // channelPermissions is only set for server text channels (via my_permissions
    // from the channel list API). For DMs / groups it's undefined and all gates
    // are open (server permissions don't apply there).
    const isServerChannel = !!activeChannel;

    // ── Custom server emojis (docs/custom-emoji-design.md) ──────────────────
    // null serverId short-circuits the hook to an empty, non-fetching list —
    // DMs/groups have no server, so no custom category and no resolvable
    // tokens (a message somehow carrying one there just falls back to
    // ":name:" text, same as a deleted emoji does everywhere).
    const emojiServerId = activeChannel?.server_id ?? null;
    const { emojis: serverEmojis, loading: serverEmojisLoading, refresh: refreshServerEmojis } = useServerEmojis(emojiServerId, token);
    // Someone else (a different member/session) added, renamed, or deleted a
    // custom emoji on THIS channel's server — refetch so it shows up without
    // needing to leave and reopen the channel. Own edits already refresh
    // themselves (useServerEmojis updates local state directly on
    // create/rename/remove), so this only ever does useful work for a
    // change this client didn't just make itself.
    useEffect(() => {
        if (!emojisChangedEvent || !emojiServerId) return;
        if (emojisChangedEvent.server_id !== emojiServerId) return;
        refreshServerEmojis();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [emojisChangedEvent]);
    const emojiById = useMemo(() => {
        const m = new Map<string, ServerEmoji>();
        for (const e of serverEmojis) m.set(e.emoji_id, e);
        return m;
    }, [serverEmojis]);
    const resolveEmoji = useCallback((id: string) => emojiById.get(id), [emojiById]);
    // No server at all to check a custom-emoji token against (DM/group) — an
    // unresolved token here can't be honestly called "deleted" the way it can
    // in a server channel with a loaded emoji list, since it's simply outside
    // any list this client could check. Softens the "unavailable" wording;
    // see MissingEmojiPlaceholder's `noServerContext`.
    const noServerEmojiContext = emojiServerId === null;
    /** Gate for clickable @mentions (renderTextWithMentions): a user mention
     *  is only "known" — and therefore clickable — if we've actually
     *  resolved that id to a username somewhere (channel-members fetch,
     *  conversation-devices fetch, or the lazy per-user fallback fetch all
     *  populate this map). An unknown/departed user's id was never added
     *  here, so the mention correctly renders non-interactive instead of
     *  opening a profile that doesn't resolve to anything. */
    const mentionedUserIsKnown = useCallback(
        (uid: string) => !!userIdToUsername[uid],
        [userIdToUsername],
    );
    /** Opens the mentioned user's profile — same `openProfileCtx` (falling
     *  back to the `onOpenProfile` prop) pattern the sender-name click
     *  already uses just below, applied to @mention pills instead. */
    const handleMentionClick = useCallback(
        (uid: string, e: React.MouseEvent | React.KeyboardEvent) => {
            const anchor = 'clientX' in e ? { x: e.clientX, y: e.clientY } : undefined;
            if (openProfileCtx) openProfileCtx(uid, anchor);
            else onOpenProfile?.(uid);
        },
        [openProfileCtx, onOpenProfile],
    );
    /** This channel's Sender Key hasn't been delivered to this device yet —
     *  encrypting would throw, so gate the composer (distinct placeholder).
     *  Only for members who can send at all: a read-only member has nothing to
     *  encrypt, so "waiting for keys" would just hide the real reason (the
     *  permission message below) behind a state that may never resolve —
     *  nobody with SEND_MESSAGES need ever have opened the channel. */
    const keyMissing     = isServerChannel && channelKeyMissing
                           && (channelPermissions === undefined
                               || !!(channelPermissions & Permissions.SEND_MESSAGES));

    // ── Server-side history paging (server channels only) ────────────────────
    // useMessagePagination only widens a window over what's already in memory,
    // so once it's exhausted the feed used to simply stop — leaving everything
    // past the newest 50 messages unreachable. `exhaustedServerHistory` latches
    // once a fetch comes back empty so the control retires instead of looping.
    // Both maps are keyed by channel id rather than reset in an effect —
    // resetting via setState-in-effect triggers a cascading render, and keying
    // means switching channels mid-fetch can't leave a stale spinner behind.
    const [exhaustedByChannel, setExhaustedByChannel] = useState<Record<string, boolean>>({});
    const [loadingOlderFor, setLoadingOlderFor] = useState<string | null>(null);

    const channelId = activeChannel?.channel_id ?? null;
    const loadingOlder = !!channelId && loadingOlderFor === channelId;

    const oldestLoadedIso = messages.length
        ? messages.reduce(
            (min: string, m: { timestamp: string }) => (m.timestamp < min ? m.timestamp : min),
            messages[0].timestamp as string,
        )
        : null;

    const canLoadOlderFromServer =
        isServerChannel && !!onLoadOlderFromServer && !!oldestLoadedIso && !!channelId
        && !exhaustedByChannel[channelId] && !channelHistoryExhausted && !loadingOlder;

    const fetchOlderFromServer = useCallback(async () => {
        if (!channelId || !onLoadOlderFromServer || !oldestLoadedIso) return;
        setLoadingOlderFor(channelId);
        try {
            const got = await onLoadOlderFromServer(channelId, oldestLoadedIso);
            // An empty page means the server has nothing older — latch it so the
            // control retires for this channel instead of re-asking forever.
            if (got === 0) setExhaustedByChannel(prev => ({ ...prev, [channelId]: true }));
        } finally {
            setLoadingOlderFor(prev => (prev === channelId ? null : prev));
        }
    }, [channelId, onLoadOlderFromServer, oldestLoadedIso]);
    /** User can post text messages in this channel. */
    const canSend        = (!isServerChannel || channelPermissions === undefined
                           || !!(channelPermissions & Permissions.SEND_MESSAGES)) && !keyMissing;
    /** User can attach files / GIFs in this channel. */
    const canAttach      = !isServerChannel || channelPermissions === undefined
                           || !!(channelPermissions & Permissions.ATTACH_FILES);
    /** User can add emoji reactions in this channel. */
    const canReactServer = !isServerChannel || channelPermissions === undefined
                           || !!(channelPermissions & Permissions.ADD_REACTIONS);
    /** User can delete others' messages and server-save messages in this channel.
     *  Defaults false (strict) when channelPermissions hasn't loaded — this is a
     *  privilege bit, not a basic right, so we don't show the controls speculatively. */
    const canManageMessages = isServerChannel
                              && channelPermissions !== undefined
                              && !!(channelPermissions & Permissions.MANAGE_MESSAGES);
    /** Pin/Unpin — the SINGLE source of truth for both the hover action bar and
     *  the right-click context menu (messageMenuGating.ts). Do not re-derive
     *  "!activeChannel || canManageMessages" at a second call site — that
     *  duplication is exactly how the two menus would drift apart. */
    const canPinInThisChat = canPinMessage({ isChannelMessage: isServerChannel, canManageMessages });
    /** SAVE_MESSAGES — "Save to server" as its own action, separate from pin.
     *  Strict default (false until permissions load), same as canManageMessages. */
    const canSaveMessages = isServerChannel
                            && channelPermissions !== undefined
                            && !!(channelPermissions & Permissions.SAVE_MESSAGES);
    /** Hover bar + context menu share this, so they can never disagree
     *  (messageMenuGating.serverSaveAction). Handlers missing → hidden. */
    const serverSaveActionFor = (msgId: string): ServerSaveAction =>
        (onServerSaveMessage && onServerUnsaveMessage)
            ? serverSaveAction({
                isChannelMessage: isServerChannel,
                canSaveMessages,
                isServerSaved: serverSavedIds.includes(msgId),
                isPinned: pinnedMsgIds.includes(msgId),
            })
            : 'hidden';
    /** Whether this chat currently allows composing at all (send/reply/react/
     *  edit) — false e.g. in a DM after removing the other person as a friend,
     *  where history stays visible but the conversation is otherwise frozen.
     *  Same condition the hover action bar has always used to show itself. */
    const canComposeInThisChat = isServerChannel || isFriend || activeChat?.type === 'group';
    /** User can include URLs in messages. When false, the send button disables the
     *  moment a URL is detected in the input. Default is permissive when permissions
     *  aren't loaded — the API will still reject (P8b) so the UI failure mode is graceful. */
    const canEmbed       = !isServerChannel || channelPermissions === undefined
                           || !!(channelPermissions & Permissions.EMBED_LINKS);
    /** User can @everyone / @here. Strict default (false) — a privileged action.
     *  DMs/groups have no notion of mention-everyone; permissive only there. */
    const canMention     = !isServerChannel
                           || (channelPermissions !== undefined
                               && !!(channelPermissions & Permissions.MENTION_EVERYONE));
    /** Whether the current input text contains a URL. Uses a non-global clone of
     *  URL_REGEX to avoid the stateful-lastIndex pitfall when using .test(). */
    const hasUrlInInput = useMemo(
        () => /https?:\/\/[^\s<>"{}|\\^`[\]]+/.test(inputText),
        [inputText],
    );
    /** True when EMBED_LINKS denies this user from sending, AND they currently have
     *  a URL in the textarea. Drives an inline warning + send-button disable. */
    const blockedByEmbed = isServerChannel && !canEmbed && hasUrlInInput;
    // ────────────────────────────────────────────────────────────────────────
    const [sentFriendRequests, setSentFriendRequests] = useState<Set<string>>(new Set());
    const [confirmDialog, setConfirmDialog] = useState<{
        title: string; message: string; confirmLabel?: string; danger?: boolean; showDeleteDataCheckbox?: boolean; onConfirm: (deleteData?: boolean) => void;
    } | null>(null);
    /** Pending message deletion awaiting the shared ConfirmDialog. */
    const [pendingDelete, setPendingDelete] = useState<{ msgId: string; copy: DeleteConfirmCopy } | null>(null);

    // New Interaction States
    const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null);
    const hoverTimeoutRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hoverLeaveTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Set to true when a picker (emoji/gif) is dismissed by an outside click so
    // that same click doesn't accidentally toggle save/unsave on the message below.
    const pickerJustClosedRef  = useRef(false);
    const [callDurations, setCallDurations] = useState<Record<string, { duration: number, active: boolean }>>({});
    const callDurationsRef = useRef<Record<string, { duration: number, active: boolean }>>({});
    // Ticks every second while any call is active so live duration counters update.
    const [callTick, setCallTick] = useState(0);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [replyingId, setReplyingId] = useState<string | null>(null);
    const [showEmojiPicker, setShowEmojiPicker] = useState<string | null>(null);
    const [reactionPickerAnchor, setReactionPickerAnchor] = useState<HTMLElement | null>(null);
    const [showInputEmojiPicker, setShowInputEmojiPicker] = useState(false);
    const emojiButtonRef = useRef<HTMLButtonElement>(null);
    const [showGifPicker, setShowGifPicker] = useState(false);
    const gifButtonRef  = useRef<HTMLButtonElement>(null);
    const [showKeyHelpPopover, setShowKeyHelpPopover] = useState(false);
    const keyHelpButtonRef = useRef<HTMLButtonElement>(null);
    const keyHelpPopoverRef = useRef<HTMLDivElement>(null);
    const [gifAnchorRect, setGifAnchorRect] = useState<DOMRect | null>(null);
    const [reactionTooltip, setReactionTooltip] = useState<{
        emoji: string;
        names: string[];
        rect: DOMRect;
    } | null>(null);
    const reactionHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [highlightedMsgId, setHighlightedMsgId] = useState<string | null>(null);
    const pendingScrollMsgIdRef = useRef<string | null>(null);

    // Listen for global keybind events dispatched by Dashboard
    useEffect(() => {
        const onToggleGif = () => {
            setShowGifPicker(prev => {
                if (!prev) setGifAnchorRect(gifButtonRef.current?.getBoundingClientRect() ?? null);
                setShowInputEmojiPicker(false);
                return !prev;
            });
        };
        const onToggleEmoji = () => {
            setShowInputEmojiPicker(prev => {
                setShowGifPicker(false);
                return !prev;
            });
        };
        window.addEventListener('keybind:toggle-gif-picker', onToggleGif);
        window.addEventListener('keybind:toggle-emoji-picker', onToggleEmoji);
        return () => {
            window.removeEventListener('keybind:toggle-gif-picker', onToggleGif);
            window.removeEventListener('keybind:toggle-emoji-picker', onToggleEmoji);
        };
    }, []);

    // :emoji: autocomplete state
    const [emojiSuggestions, setEmojiSuggestions] = useState<EmojiSuggestion[]>([]);
    const [emojiQueryRange, setEmojiQueryRange] = useState<{ start: number; end: number } | null>(null);
    const [selectedSuggestionIdx, setSelectedSuggestionIdx] = useState(0);

    // @mention autocomplete state
    type MentionSuggestion = {
        type: 'everyone' | 'here' | 'user' | 'role';
        id: string;
        label: string;
        color?: string;
        /** `user` rows only — encrypted-avatar attachment id, when the user
         *  has one, for the suggestion row's icon. */
        avatarId?: string | null;
        /** `user` rows only — lets the suggestion menu disambiguate two
         *  members who share a display name (usernames aren't unique;
         *  `(username, discriminator)` is — see packages/shared/user.ts).
         *  Only populated for the channel-members source today; DM/group
         *  candidates (built from userIdToUsername) don't carry it. */
        discriminator?: number | null;
        /** `user` rows in a server channel only — the member's server
         *  nickname. DISPLAY + MATCHING ONLY: `label` stays the username, so
         *  the inserted `@label` and the wire token are unchanged. */
        nickname?: string | null;
    };
    const [mentionSuggestions, setMentionSuggestions] = useState<MentionSuggestion[]>([]);
    const [mentionQueryRange, setMentionQueryRange] = useState<{ start: number; end: number } | null>(null);
    const [selectedMentionIdx, setSelectedMentionIdx] = useState(0);
    // Members/roles fetched for autocomplete (channel mode only)
    const [mentionMembers, setMentionMembers] = useState<Array<{ user_id: string; username: string; discriminator: number | null }>>([]);
    const [mentionRoles, setMentionRoles] = useState<Array<{ role_id: string; name: string; color: number; mentionable: boolean }>>([]);
    /** Role IDs the current viewer holds in the active server channel — used to
     *  detect role-mention highlights without an extra API call (piggy-backs on
     *  the member list fetch that already happens for autocomplete). */
    const [myServerRoleIds, setMyServerRoleIds] = useState<Set<string>>(new Set());
    // Map: display-label → full wire token. Updated whenever mentionMembers/mentionRoles load.
    // Used by buildWireText to substitute @label → <@type:id:label> just before sending.
    const mentionTokenMapRef = useRef<Record<string, string>>({});
    // Map: display form (":name:", colons included) → full wire token
    // (<:name:id>). Same purpose/shape as mentionTokenMapRef, one level
    // simpler: no need to rebuild it on data load — an entry is registered
    // right when a custom emoji is picked (autocomplete or the full picker),
    // and buildEmojiWireText only ever substitutes exactly what was picked.
    // A hand-typed ":name:" that was never selected stays plain text, same
    // "gracefully degrades, no data loss" rule buildWireText documents.
    const emojiTokenMapRef = useRef<Record<string, string>>({});
    // The message right-click menu — canonical ContextMenu primitive (portals
    // to body, viewport-clamped, own outside-click/Escape/keyboard-nav
    // handling). msgCtxOpenIdRef remembers which row opened it purely so
    // focus can return there once it closes (see the effect below) — a
    // right-click does not reliably move focus on every platform, so
    // handleContextMenu focuses the row explicitly on open.
    const msgContextMenu = useContextMenu();
    const msgCtxOpenIdRef = useRef<string | null>(null);
    useEffect(() => {
        if (msgContextMenu.isOpen || !msgCtxOpenIdRef.current) return;
        const id = msgCtxOpenIdRef.current;
        msgCtxOpenIdRef.current = null;
        document.getElementById(`msg-${id}`)?.focus();
    }, [msgContextMenu.isOpen]);
    // Ticker forces a re-render every 30s so "will be deleted in Xh" badges count down.
    const [nowTick, setNowTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setNowTick(t => t + 1), 30_000);
        return () => clearInterval(id);
    }, []);
    // The key-help popover is portaled to document.body (fixed-positioned off
    // the trigger button's rect), so the trigger and the panel don't share a
    // DOM subtree — use the predicate form so clicking either counts as "inside".
    useDismissOnOutsideClick(
        (target: Node) => !!(keyHelpButtonRef.current?.contains(target) || keyHelpPopoverRef.current?.contains(target)),
        showKeyHelpPopover,
        () => setShowKeyHelpPopover(false),
    );
    // Auto-dismiss once the key arrives — don't leave a stale explanation
    // open for a channel that's no longer waiting on anything.
    useEffect(() => {
        if (!keyMissing) setShowKeyHelpPopover(false);
    }, [keyMissing]);

    const [isCallInitiator, setIsCallInitiator] = useState(false);
    const [currentCallId, setCurrentCallId] = useState<string | null>(null);
    const [epoch, setEpoch] = useState(1);

    // (More-menu dismissal lives inside useContextMenu — no extra wiring.)

    // Check friendship status for DMs
    useEffect(() => {
        if (!token || activeChat?.type !== 'dm' || !activeChat?.other_user_id) {
            setIsFriend(true); // group chats always allow messaging
            return;
        }
        if (!affordances.friendshipLookup) {
            // Your own self chat: friendship does not apply (and there is no row to look up).
            setIsFriend(true);
            setFriendStatus('accepted');
            return;
        }
        axios.get(`${API_BASE}/friends/status/${activeChat.other_user_id}`, {
            headers: { Authorization: `Bearer ${token}` }
        }).then(res => {
            setIsFriend(res.data.status === 'accepted');
            setFriendStatus(res.data.status);
        }).catch(() => {
            setIsFriend(true); // fail open
            setFriendStatus('accepted');
        });
    }, [token, activeChat?.id, activeChat?.other_user_id, activeChat?.type, affordances.friendshipLookup]);

    // Re-check friendship status when a friend:removed WS event arrives for this chat
    useEffect(() => {
        if (!friendRemovedEvent || activeChat?.type !== 'dm' || !activeChat?.other_user_id) return;
        const isRelevant =
            friendRemovedEvent.removed_by === activeChat.other_user_id ||
            friendRemovedEvent.other_user_id === activeChat.other_user_id;
        if (isRelevant) setIsFriend(false);
    }, [friendRemovedEvent, activeChat?.other_user_id, activeChat?.type]);

    // Fetch server members + roles for @mention autocomplete when in channel mode.
    useEffect(() => {
        if (!token || !activeChannel) {
            setMentionMembers([]);
            setMentionRoles([]);
            setMyServerRoleIds(new Set());
            mentionTokenMapRef.current = {};
            return;
        }
        const sid = activeChannel.server_id;
        // Gate message rendering on the first fetch for this server so the user
        // never sees "Unknown User". Subsequent channel switches within the same
        // server skip the gate because the maps are already populated.
        const isFirstFetch = !fetchedServerIds.current.has(sid);
        if (isFirstFetch) setMembersFetching(true);
        // The roster comes from the shared roster cache (the same one the
        // server panel renders from): a cached server applies immediately —
        // which also lifts the first-fetch gate in the same tick — and the
        // revalidation below only re-applies if something changed. It also
        // means a channel switch no longer re-requests members + roles when the
        // panel (or the previous channel) fetched them seconds ago, and a cold
        // open shares ONE request pair with the panel instead of making its own.
        const applyRoster = (roster: Roster) => {
            const mRes = { data: roster.members as unknown as unknown[] };
            const members: Array<{ user_id: string; username: string; discriminator: number | null }> =
                (mRes.data as any[]).map((m: any) => ({ user_id: m.user_id, username: m.username, discriminator: m.discriminator ?? null }));
            const roles: Array<{ role_id: string; name: string; color: number; mentionable: boolean }> =
                (roster.roles as unknown as Array<{ role_id: string; name: string; color: number; mentionable: boolean; is_everyone: boolean }>).filter(r => !r.is_everyone);
            setMentionMembers(members);
            setMentionRoles(roles);

            // Populate the userId → username AND userId → avatar maps so message
            // rendering can resolve both sender names and avatars. Without these,
            // server channel messages fall back to truncated user-IDs and the
            // generic fallback avatar — these maps are only otherwise populated
            // by the DM device-list path which doesn't fire for server channels.
            // PERF: unchanged maps keep their identity — these feed every
            // message row's dependency token (MemoRow), and on a channel switch
            // within a server they are usually already populated (identity
            // cache / previous fetch), so a fresh copy re-rendered every row.
            setUserIdToUsername(prev => {
                let next: Record<string, string> | null = null;
                for (const m of members) {
                    if (m.user_id && m.username && prev[m.user_id] !== m.username) (next ??= { ...prev })[m.user_id] = m.username;
                }
                return next ?? prev;
            });
            rememberIdentities(mRes.data as Array<{ user_id?: string | null; avatar_url?: string | null; username?: string | null }>);
            setUserIdToAvatar(prev => {
                let next: Record<string, string> | null = null;
                for (const m of mRes.data as any[]) {
                    // Avatar can be null/empty for users who haven't set one — only
                    // overwrite when we have an actual attachment id. EncryptedAvatar
                    // handles the null case with its fallback initial.
                    if (m.user_id && m.avatar_url && prev[m.user_id] !== m.avatar_url) (next ??= { ...prev })[m.user_id] = m.avatar_url;
                }
                return next ?? prev;
            });

            // Capture the viewer's own role IDs for the mention-highlight check.
            // TypeORM raw query via `pg` driver returns PostgreSQL uuid[] as a JS
            // array, but guard against the "{uuid,...}" string form just in case.
            const myMember = (mRes.data as any[]).find((m: any) => m.user_id === user?.user_id);
            const rawRoleIds = myMember?.role_ids;
            const parsedRoleIds: string[] = Array.isArray(rawRoleIds)
                ? rawRoleIds.filter(Boolean)
                : typeof rawRoleIds === 'string' && rawRoleIds.startsWith('{')
                    ? rawRoleIds.slice(1, -1).split(',').filter(Boolean)
                    : [];
            setMyServerRoleIds(prev => (prev.size === parsedRoleIds.length && parsedRoleIds.every(id => prev.has(id)) ? prev : new Set<string>(parsedRoleIds)));

            // Rebuild the label → wire-token lookup used by buildWireText
            const map: Record<string, string> = {
                everyone: '@everyone',
                here: '@here',
            };
            for (const m of members) map[m.username] = `<@u:${m.user_id}:${m.username}>`;
            for (const r of roles)   map[r.name]     = `<@r:${r.role_id}:${r.name}>`;
            mentionTokenMapRef.current = map;

            // Pre-warm the avatar memory cache for every member. NOT awaited:
            // this used to sit inside the loading gate, so the first channel
            // opened in a server each session held its messages behind a
            // spinner until every member avatar had finished two REST calls and
            // a decrypt, or until the 5 s timeout — seconds of stall to buy a
            // fallback-icon flash. useAvatarWarming warms these in the
            // background ahead of time, and the flash it was avoiding is a
            // 180 ms cross-fade inside an identically-sized box (see
            // EncryptedAvatar), so the trade was the wrong way round. This
            // still runs, it just no longer blocks the paint.
            const avatarIds = (mRes.data as any[]).map((m: any) => m.avatar_url).filter(Boolean);
            void preloadAvatars(avatarIds, token);

            fetchedServerIds.current.add(sid);
            if (isFirstFetch) setMembersFetching(false);
        };
        const cachedRoster = peekRoster(sid);
        if (cachedRoster) applyRoster(cachedRoster);
        refreshRoster(sid, token).then(roster => {
            if (roster && roster !== cachedRoster) applyRoster(roster);
            else if (!roster && isFirstFetch) setMembersFetching(false);
        }).catch(() => {
            if (isFirstFetch) setMembersFetching(false);
        });
    }, [token, activeChannel?.channel_id]);

    // Bulk fetch Call Durations for UI History rendering
    useEffect(() => {
        if (!token || !activeChat || messages.length === 0) return;
        
        const fetchDurations = async () => {
            const callIds = Array.from(new Set(messages
                .filter(m => m.content?.type === 'call_key' && m.content?.call_id)
                .map(m => m.content!.call_id)));
            
            const missingOrActiveIds = callIds.filter(id => {
                const cstate = callDurationsRef.current[id];
                return !cstate || cstate.active;
            });
            
            if (missingOrActiveIds.length === 0) return;

            try {
                const res = await axios.post(`${API_BASE}/calls/bulk_status`, { session_ids: missingOrActiveIds }, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                
                setCallDurations(prev => {
                    const next = { ...prev };
                    let changed = false;
                    for (const [id, status] of Object.entries(res.data as Record<string, any>)) {
                        if (status.created_at) {
                            const start = new Date(status.created_at).getTime();
                            const end = status.ended_at ? new Date(status.ended_at).getTime() : Date.now();
                            const duration = Math.floor((end - start) / 1000);
                            
                            if (!next[id] || next[id].duration !== duration || next[id].active !== status.active) {
                                next[id] = { duration, active: status.active };
                                changed = true;
                            }
                        }
                    }
                    if (changed) {
                        callDurationsRef.current = next;
                    }
                    return changed ? next : prev;
                });
            } catch (err) {
                // Silently fails polling
            }
        };
        fetchDurations();
    // Depends on activeChat's IDENTITY, not the object: server channels pass a
    // synthetic activeChat, and any caller building that inline would re-fire
    // this POST on every one of its renders. Nothing below reads a field other
    // than the id (via the guard above), so the id is the whole dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages, token, activeChat?.id]);

    // Live 1-second ticker for active call duration counters.
    useEffect(() => {
        const hasActive = Object.values(callDurations).some(d => d.active);
        if (!hasActive) return;
        const id = setInterval(() => setCallTick(t => t + 1), 1000);
        return () => clearInterval(id);
    }, [callDurations]);

    // Poll the server every 3 s while any call is marked active so the UI
    // transitions to "Call ended" in near-real-time without needing a page refresh.
    useEffect(() => {
        const activeIds = Object.entries(callDurations)
            .filter(([, d]) => d.active)
            .map(([id]) => id);
        if (activeIds.length === 0 || !token) return;

        const poll = async () => {
            try {
                const res = await axios.post(
                    `${API_BASE}/calls/bulk_status`,
                    { session_ids: activeIds },
                    { headers: { Authorization: `Bearer ${token}` } }
                );
                setCallDurations(prev => {
                    const next = { ...prev };
                    let changed = false;
                    for (const [id, status] of Object.entries(res.data as Record<string, any>)) {
                        if (status.created_at) {
                            const start = new Date(status.created_at).getTime();
                            const end   = status.ended_at ? new Date(status.ended_at).getTime() : Date.now();
                            const dur   = Math.floor((end - start) / 1000);
                            if (!next[id] || next[id].duration !== dur || next[id].active !== status.active) {
                                next[id] = { duration: dur, active: status.active };
                                changed = true;
                            }
                        }
                    }
                    if (changed) callDurationsRef.current = next;
                    return changed ? next : prev;
                });
            } catch { /* silent */ }
        };

        const id = setInterval(poll, 3000);
        return () => clearInterval(id);
    }, [callDurations, token]);

    useEffect(() => {
        // Epoch Rotation (10m)
        let interval: ReturnType<typeof setInterval>;
        if (isCallInitiator && currentCallId && bundleReady) {
            interval = setInterval(async () => {
                try {
                    const newKey = await generateCallKey();
                    const nextEpoch = epoch + 1;

                    // claim_otp=1: consume a one-time prekey per recipient device (per-message forward secrecy)
                    const devicesRes = await axios.get(`${API_BASE}/conversations/${activeChat.id}/devices?claim_otp=1`, {
                        headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId }
                    });

                    const safeUUID = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                    const content: ClientContent = {
                        client_msg_id: safeUUID,
                        type: 'call_key',
                        call_id: currentCallId,
                        epoch: nextEpoch,
                        e2ee_key_b64: newKey,
                        key_id: `rotate-${nextEpoch}`,
                        rotates_at: new Date(Date.now() + 10 * 60000).toISOString()
                    };
                    const rotationDevices = devicesRes.data as { device_id: string; spk_pub_b64: string }[];
                    // RC-2: address exactly the devices that got wrapped, not
                    // the full fetched list — see encryptAndAddress.ts.
                    const { ciphertext_b64, recipient_device_ids } = await encryptAndAddress(JSON.stringify(content), user!.user_id, rotationDevices, deviceId ?? undefined);

                    await axios.post(`${API_BASE}/messages/send`, {
                        conversation_id: activeChat.id,
                        recipient_device_ids,
                        envelope_type: 'signal_chat',
                        ciphertext_b64,
                        sent_at_client: new Date().toISOString()
                    }, {
                        headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId }
                    });

                    onMessageSent({
                        id: content.client_msg_id!,
                        content: content,
                        sender_device_id: deviceId,
                        timestamp: new Date().toISOString(),
                        conversation_id: activeChat.id
                    });

                    // Update UI gracefully
                    setEpoch(nextEpoch);
                    onCallChange({
                        id: currentCallId,
                        conversation_id: activeChat.id,
                        livekit_url: activeCall?.livekit_url || '', // Use existing mapping
                        livekit_token: activeCall?.livekit_token || '',
                        e2ee_key_b64: newKey,
                        mode: activeCall?.mode || 'sfu'
                    });

                } catch (e) {
                    console.error('Epoch rotation failed', e);
                }
            }, 10 * 60000); // 10 minutes
        }
        return () => clearInterval(interval);
    }, [isCallInitiator, currentCallId, epoch, activeChat.id, token, deviceId, onMessageSent, onCallChange]);

    useEffect(() => {
        // Fetch all my device IDs to correctly align "isMe" bubbles for multi-device sync
        if (token) {
            axios.get(`${API_BASE}/devices`, {
                headers: { Authorization: `Bearer ${token}` }
            }).then(res => {
                if (Array.isArray(res.data)) {
                    const ids = res.data.map((d: any) => d.device_id);
                    setMyDeviceIds(prev => setIfChanged(prev, [...ids, deviceId as string]));
                }
            }).catch(e => console.error('Failed to resolve personal devices', e));
        }
    }, [token, user?.user_id, deviceId]);

    // Build deviceId → username map for the active conversation
    useEffect(() => {
        if (!token || !deviceId || !activeChat?.id) return;
        const cid = activeChat.id;
        const isFirstFetch = !fetchedChatIds.current.has(cid);
        // Gate message rendering on first visit to this DM/group so the user
        // never sees "Unknown User" or a missing avatar on initial load.
        if (isFirstFetch) setChatLoading(true);
        axios.get(`${API_BASE}/conversations/${cid}/devices`, {
            headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId }
        }).then(async (res) => {
            if (Array.isArray(res.data)) {
                const deviceMap: Record<string, string> = {};
                const avatarMap: Record<string, string> = {};
                const userMap: Record<string, string> = {};
                const userAvatarMap: Record<string, string> = {};
                res.data.forEach((d: any) => {
                    deviceMap[d.device_id] = d.username;
                    avatarMap[d.device_id] = d.avatar_url;
                    // Multiple devices per user — last write wins, which is fine
                    if (d.user_id) {
                        userMap[d.user_id] = d.username;
                        userAvatarMap[d.user_id] = d.avatar_url;
                    }
                });
                // Merged, not replaced: all four maps are seeded from the
                // session peer-identity cache at mount, so a wholesale replace
                // would throw away every id and name this pane did not just
                // fetch and reintroduce the fallback flash for anyone the lazy
                // resolver had already filled in. The fresh response still wins
                // per key, so a changed avatar or handle corrects here.
                rememberIdentities(res.data as Array<{ user_id?: string | null; device_id?: string | null; avatar_url?: string | null; username?: string | null }>);
                // Replaced, not merged — this one IS the per-conversation scope.
                setConversationUserIds(new Set(Object.keys(userMap)));
                // Same identity when nothing changed (see renderMemo.mergeIfChanged).
                setDeviceToUsername(prev => mergeIfChanged(prev, deviceMap));
                setUserIdToUsername(prev => mergeIfChanged(prev, userMap));
                setDeviceToAvatar(prev => mergeIfChanged(prev, avatarMap));
                setUserIdToAvatar(prev => mergeIfChanged(prev, userAvatarMap));
                // Pre-populate mention token map for DM / group chats so that
                // @username text gets converted to wire tokens even when the
                // user doesn't explicitly pick from the autocomplete dropdown.
                // Server channels do the same thing via the members useEffect above.
                const mentionMap: Record<string, string> = {
                    everyone: '@everyone',
                    here: '@here',
                };
                for (const [uid, uname] of Object.entries(userMap)) {
                    if (uid && uname) mentionMap[uname] = `<@u:${uid}:${uname}>`;
                }
                mentionTokenMapRef.current = mentionMap;

                // Pre-warm the avatar memory cache. NOT awaited — see the same
                // change on the server-members effect above. Holding the gate
                // here cost the first open of every DM in a session however
                // long two REST calls and a decrypt per participant took; the
                // warmer covers these ahead of time and a cold one now
                // cross-fades in rather than blocking the message list.
                if (isFirstFetch) {
                    const avatarIds = res.data
                        .map((d: any) => d.avatar_url)
                        .filter(Boolean);
                    void preloadAvatars(avatarIds, token);
                    fetchedChatIds.current.add(cid);
                }
            }
            if (isFirstFetch) setChatLoading(false);
        }).catch(() => {
            if (isFirstFetch) setChatLoading(false);
        });
    }, [token, deviceId, activeChat?.id]);

    // ── Lazy username/avatar resolver ────────────────────────────────────────
    // Catches the case where a message arrives from a user we haven't already
    // hydrated via the channel-members fetch or the conversation-devices fetch.
    // Without this, the message bubble falls back to a truncated id; with this,
    // we fire a one-time GET /v1/auth/users/:userId for the missing user and
    // patch both userIdToUsername + userIdToAvatar so every existing bubble
    // re-renders with the real name and avatar.
    //
    // Dedupe via inFlightUserFetches ref (concurrent renders won't double-fire)
    // and failedUserFetches ref (404s / deleted accounts won't retry every render).
    useEffect(() => {
        if (!token || !messages.length) return;
        const missing = new Set<string>();
        for (const msg of messages) {
            const uid = msg.sender_user_id;
            if (!uid) continue;
            if (userIdToUsername[uid]) continue;
            if (inFlightUserFetches.current.has(uid)) continue;
            if (failedUserFetches.current.has(uid)) continue;
            missing.add(uid);
        }
        if (missing.size === 0) return;
        for (const uid of missing) inFlightUserFetches.current.add(uid);
        // Fire one request per missing user. Could batch later if it becomes
        // a hot path — typical conversations have <50 unique senders.
        for (const uid of missing) {
            axios.get(`${API_BASE}/auth/users/${uid}`, {
                headers: { Authorization: `Bearer ${token}` },
            }).then(res => {
                const data = res.data;
                if (data && data.username) {
                    rememberUserName(uid, data.username);
                    setUserIdToUsername(prev => ({ ...prev, [uid]: data.username }));
                    if (data.avatar_url) {
                        rememberUserAvatarId(uid, data.avatar_url);
                        setUserIdToAvatar(prev => ({ ...prev, [uid]: data.avatar_url }));
                    }
                } else {
                    // Endpoint returned null (deleted account / not found).
                    failedUserFetches.current.add(uid);
                }
            }).catch(() => {
                // 404 / network failure — cache so we don't retry every render.
                failedUserFetches.current.add(uid);
            }).finally(() => {
                inFlightUserFetches.current.delete(uid);
            });
        }
    }, [messages, token, userIdToUsername]);

    // Real-time avatar refresh for the maps that drive message-bubble author
    // avatars. The maps above are populated ONCE per chat-load fetch — without
    // this listener every existing bubble showing a peer's avatar stays on
    // their old image until the user navigates away and back. Patches both
    // userIdToAvatar (per-user) and walks deviceToAvatar (which is keyed on
    // device_id but ultimately resolves to the same human's avatar across
    // every device they own — we can't know which devices belong to which
    // user without the conversation/devices payload, so we just refetch it
    // when an avatar changes for a user we have an entry for. Cheap.).
    useEffect(() => {
        if (!avatarUpdatedEvent || !activeChat?.id || !token || !deviceId) return;
        const { user_id, avatar_url: newAttachmentId } = avatarUpdatedEvent;

        // Patch the per-user map immediately (cheap, synchronous). The session
        // cache is patched too, or the next remount would seed the stale id
        // straight back over the top of this.
        rememberUserAvatarId(user_id, newAttachmentId);
        setUserIdToAvatar(prev =>
            (user_id in prev) || prev[user_id] !== newAttachmentId
                ? { ...prev, [user_id]: newAttachmentId }
                : prev
        );

        // Refetch the device → avatar map so message bubbles keyed by
        // sender_device_id pick up the new avatar too. The endpoint returns
        // a small JSON list (one row per device); cost is negligible.
        axios.get(`${API_BASE}/conversations/${activeChat.id}/devices`, {
            headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId },
        }).then(res => {
            if (!Array.isArray(res.data)) return;
            const avatarMap: Record<string, string> = {};
            const userAvatarMap: Record<string, string> = {};
            res.data.forEach((d: any) => {
                avatarMap[d.device_id] = d.avatar_url;
                if (d.user_id) userAvatarMap[d.user_id] = d.avatar_url;
            });
            rememberIdentities(res.data as Array<{ user_id?: string | null; device_id?: string | null; avatar_url?: string | null; username?: string | null }>);
            setDeviceToAvatar(prev => mergeIfChanged(prev, avatarMap));
            setUserIdToAvatar(prev => mergeIfChanged(prev, userAvatarMap));
        }).catch(() => { /* not fatal — userIdToAvatar patch above still applied */ });
    }, [avatarUpdatedEvent, activeChat?.id, token, deviceId]);

    // Pagination resets automatically inside useMessagePagination when activeChat.id changes.

    // Auto-focus input after send — guarded so it never fires on first mount
    useEffect(() => {
        if (!sending && hasSentOnce.current) inputRef.current?.focus();
    }, [sending]);

    // true  = new content should keep the view pinned to the bottom.
    // false = user has scrolled up; stop following until they return.
    const followBottomRef = useRef(true);
    const isAtBottomRef   = useRef(true);
    const [showScrollBtn, setShowScrollBtn] = useState(false);

    // Tracks the last scrollTop value we personally set or confirmed (via a snap,
    // a layout effect, or an onScroll event). Used to detect user-initiated scrolls
    // synchronously inside useLayoutEffect, before the async onScroll event fires.
    const lastKnownScrollTopRef = useRef(0);
    // Records the scrollTop at the moment of our last deliberate snap-to-bottom.
    // Unlike lastKnownScrollTopRef this is NEVER updated by onScroll — only by
    // our own snaps. This makes it a stable baseline for the RAF comparison:
    // if el.scrollTop has moved more than 30 px below it, the user scrolled away.
    const lastSnapBottomRef = useRef(0);
    // Guards against scheduling multiple concurrent RAF snaps for objectUrls updates.
    const snapScheduledRef = useRef(false);

    // ── In-place-edit viewport anchor ─────────────────────────────────────────
    // Set by the submit handler when a bare text edit is dispatched while the
    // user is scrolled up. Holds the edited row's top edge relative to the feed
    // viewport, measured BEFORE the edit commits; the layout effect further down
    // re-measures that same row afterwards and corrects scrollTop by the drift,
    // so the row the user was looking at does not move even when the edit makes
    // it taller/shorter or the composer's "Editing Message" strip unmounts.
    // The row carries `id={`msg-${msg.id}`}` and a stable React key (its
    // identity, utils/messageEntrance.ts), so it is the same DOM node before
    // and after an edit — no remount to fight.
    const editAnchorRef = useRef<{ msgId: string; rowTop: number } | null>(null);
    const findMsgRow = (msgId: string): HTMLElement | null => {
        const el = feedRef.current;
        if (!el) return null;
        try { return el.querySelector<HTMLElement>(`#msg-${CSS.escape(msgId)}`); }
        catch { return null; }
    };
    const captureEditAnchor = (msgId: string) => {
        const el = feedRef.current;
        const row = findMsgRow(msgId);
        if (!el || !row) { editAnchorRef.current = null; return; }
        editAnchorRef.current = {
            msgId,
            rowTop: row.getBoundingClientRect().top - el.getBoundingClientRect().top,
        };
    };

    // ── Reveal new messages with a FLIP slide ─────────────────────────────────
    // When a message is appended the feed must end up scrolled to the bottom, but
    // we don't want the existing text to *jump* up to make room. We use the FLIP
    // technique: snap scrollTop to the final bottom instantly (Last), then offset
    // the message column DOWN by exactly how far it shifted (Invert) so it looks
    // unchanged, then transition that offset to zero (Play) — the column slides up
    // smoothly into place and the new message rises into view from the bottom.
    // This is immune to scroll-anchoring / row-height / overflow quirks because
    // the motion is a transform on the content, not an animated scroll.
    const contentRef = useRef<HTMLDivElement>(null);
    const flipCleanupRef = useRef<(() => void) | null>(null);
    // Content height at the last reveal, so we can measure how much a new message
    // grew the column — works whether the feed scrolls (overflow) or just makes
    // room by shrinking the mt-auto margin (short list), unlike a scrollTop delta.
    const lastSeenScrollHeightRef = useRef(0);
    const revealNewMessage = useCallback(() => {
        const el = feedRef.current;
        const c = contentRef.current;
        if (!el) return;
        const delta = el.scrollHeight - lastSeenScrollHeightRef.current; // column growth
        lastSeenScrollHeightRef.current = el.scrollHeight;
        // Land on the true bottom immediately (final state) for the overflow case.
        const newBottom = el.scrollHeight - el.clientHeight;
        el.scrollTop = el.scrollHeight;
        lastKnownScrollTopRef.current = newBottom;
        lastSnapBottomRef.current = newBottom;
        // Only FLIP for a sane, on-screen-sized growth (skip giant images / pagination / first paint).
        if (!c || delta <= 2 || delta >= el.clientHeight) return;
        if (flipCleanupRef.current) flipCleanupRef.current();
        c.style.transition = 'none';
        c.style.transform = `translateY(${delta}px)`;
        void c.offsetHeight; // force reflow so the invert paints before we play
        c.style.transition = 'transform .42s cubic-bezier(.22, 1, .36, 1)';
        c.style.transform = 'translateY(0)';
        const onEnd = () => {
            c.style.transition = '';
            c.style.transform = '';
            c.removeEventListener('transitionend', onEnd);
            flipCleanupRef.current = null;
        };
        c.addEventListener('transitionend', onEnd);
        flipCleanupRef.current = onEnd;
    }, []);
    useEffect(() => () => { if (flipCleanupRef.current) flipCleanupRef.current(); }, []);

    // ── Dynamic composer clearance ────────────────────────────────────────────
    // The composer floats absolutely over the feed, so the feed needs a bottom
    // spacer tall enough that the last message clears it. A fixed spacer wastes
    // space for a one-line composer and is too short when staged files / a reply
    // strip inflate it — so measure the composer and size the spacer to match.
    const composerWrapRef = useRef<HTMLDivElement>(null);
    const [composerH, setComposerH] = useState(64);
    useEffect(() => {
        const node = composerWrapRef.current;
        if (!node || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => setComposerH(node.offsetHeight));
        ro.observe(node);
        setComposerH(node.offsetHeight);
        return () => ro.disconnect();
    }, [activeChat?.id, activeChannel?.channel_id]);

    // Recompute "are we at the bottom?" on every scroll event.
    // Simple distance check — no direction tracking needed (that caused races with
    // the old RAF loop updating prevScrollTopRef from its own scrollTop mutations).
    const checkBottom = () => {
        const el = feedRef.current;
        if (!el) return;
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        // More than 120 px from bottom → user scrolled away, stop following.
        if (dist > 120) followBottomRef.current = false;
        // Within 60 px → user is at (or returned to) the bottom, re-engage.
        if (dist < 60)  followBottomRef.current = true;
        isAtBottomRef.current = dist < 120;
        setShowScrollBtn(dist > 1500);
    };

    // ── Snap to bottom on chat switch ────────────────────────────────────────
    // Fires exactly once per chat, not on every messages update.
    useEffect(() => {
        // Cancel any RAF snap that was scheduled for the previous chat so it
        // can't misfire with a stale topAtSchedule baseline.
        snapScheduledRef.current = false;
        const el = feedRef.current;
        if (!el) return;
        el.scrollTop                  = el.scrollHeight;
        lastKnownScrollTopRef.current = el.scrollHeight - el.clientHeight;
        lastSnapBottomRef.current     = el.scrollHeight - el.clientHeight;
        lastSeenScrollHeightRef.current = el.scrollHeight;
        followBottomRef.current       = true;
        isAtBottomRef.current         = true;
        setShowScrollBtn(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeChat?.id]);

    // ── Snap to bottom after loading gate lifts ───────────────────────────────
    // chatLoading / membersFetching block message rendering while avatars
    // preload. The activeChat?.id snap above fires while the feed is empty
    // (scrollHeight tiny). When the gate drops, messages render below the fold
    // but scrollTop stays at 0. This effect detects the false→true→false
    // transition and re-snaps once messages are in the DOM.
    const wasLoadingRef = useRef(false);
    useLayoutEffect(() => {
        const isLoading = chatLoading || membersFetching || messagesFetching;
        if (isLoading) { wasLoadingRef.current = true; return; }
        if (!wasLoadingRef.current) return;
        wasLoadingRef.current = false;
        const el = feedRef.current;
        if (!el) return;
        el.scrollTop                  = el.scrollHeight;
        lastKnownScrollTopRef.current = el.scrollHeight - el.clientHeight;
        lastSnapBottomRef.current     = el.scrollHeight - el.clientHeight;
        lastSeenScrollHeightRef.current = el.scrollHeight;
        followBottomRef.current       = true;
        isAtBottomRef.current         = true;
        setShowScrollBtn(false);
    }, [chatLoading, membersFetching, messagesFetching]);

    // ── Snap to bottom on every new message (any sender) ─────────────────────
    // The existing pagination.displayed effect below ONLY snaps if
    // followBottomRef is true — i.e. the user has to already be near the
    // bottom. When the user has scrolled up, that path leaves them put. The
    // user requested the symmetric behaviour to "send-snaps-me-to-bottom":
    // any new message (theirs OR a peer's) should snap them to the bottom.
    // This effect re-engages followBottomRef and force-snaps independent of
    // the existing logic. Keyed on the last message's stable IDENTITY
    // (utils/messageEntrance.ts) so we don't re-snap when the array reference
    // changes for unrelated reasons (edits, reactions, attachment-key
    // resolution, etc.) — nor when the SAME message is confirmed, swaps its
    // client id for the server's, takes the server's time, or is re-sorted:
    // keyed on `id::timestamp`, every one of those re-ran the reveal. A row
    // that was already revealed as the last one is never revealed again.
    // On a chat switch the gate only records (the chat-switch effect above is
    // the canonical snap-on-mount).
    const [revealGate] = useState<RevealGate>(createRevealGate);
    useLayoutEffect(() => {
        const chatId = activeChat?.id ?? null;
        const last = messages[messages.length - 1];
        const lastMsgKey = last ? messageRowKey(last, deviceId, 'no-id') : null;
        if (!revealGate.check(chatId, lastMsgKey)) return;

        const el = feedRef.current;
        if (!el) return;
        followBottomRef.current       = true;
        isAtBottomRef.current         = true;
        setShowScrollBtn(false);
        // FLIP slide-up to reveal the new message instead of snapping.
        revealNewMessage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages, activeChat?.id]);

    // ── Follow-bottom: synchronous snap for new messages ─────────────────────
    // Fires when the message poll delivers new content (~every 5 s). Polls are
    // infrequent, so the race window with the compositor's scroll delivery is
    // tiny. We also check scrollTop directly to catch any in-flight user scroll
    // that hasn't reached onScroll yet.
    useLayoutEffect(() => {
        const el = feedRef.current;
        if (!el) return;
        const currentTop = el.scrollTop;
        // If scrollTop decreased the user has started scrolling up; sync the ref
        // before onScroll arrives so we don't snap them back.
        if (currentTop < lastKnownScrollTopRef.current - 10) {
            followBottomRef.current = false;
            isAtBottomRef.current   = false;
        }
        lastKnownScrollTopRef.current = currentTop;
        if (!followBottomRef.current) return;
        el.scrollTop                  = el.scrollHeight;
        lastKnownScrollTopRef.current = el.scrollHeight - el.clientHeight;
        lastSnapBottomRef.current     = el.scrollHeight - el.clientHeight;
    }, [pagination.displayed]);

    // ── Follow-bottom: RAF-deferred snap for attachment decryption ────────────
    // objectUrls can change dozens of times in rapid succession when a chat with
    // many images is first opened. During that burst the compositor thread is
    // simultaneously processing the user's scroll gestures, but it hasn't yet
    // delivered the updated scrollTop to the main thread — so reading el.scrollTop
    // inside a synchronous useLayoutEffect still shows "bottom" even though the
    // user is already scrolling away. Deferring to requestAnimationFrame gives the
    // compositor one full frame to commit the user's position before we decide
    // whether to snap.
    //
    // Baseline: lastSnapBottomRef — the scrollTop at our LAST deliberate snap.
    // It is NEVER updated by scroll events, only by our own snaps. This means:
    //   • If the user scrolled away (el.scrollTop shrank from lastSnapBottomRef)
    //     the comparison catches it regardless of when the layout effect ran.
    //   • If content grew (scrollHeight grew, scrollTop unchanged)
    //     el.scrollTop == lastSnapBottomRef → comparison misses → we snap. ✓
    // Previous approach used topAtSchedule (current scrollTop at commit time),
    // which fails whenever the user has already scrolled before the effect runs.
    useLayoutEffect(() => {
        if (!followBottomRef.current || snapScheduledRef.current) return;
        snapScheduledRef.current = true;
        requestAnimationFrame(() => {
            snapScheduledRef.current = false;
            const el = feedRef.current;
            if (!el || !followBottomRef.current) return;
            // After one frame the compositor has committed the user's scrollTop.
            // Compare against the last position WE set (lastSnapBottomRef), not
            // against what was current when the layout effect ran.
            if (el.scrollTop < lastSnapBottomRef.current - 30) {
                followBottomRef.current       = false;
                isAtBottomRef.current         = false;
                lastKnownScrollTopRef.current = el.scrollTop;
                return;
            }
            el.scrollTop                  = el.scrollHeight;
            lastKnownScrollTopRef.current = el.scrollHeight - el.clientHeight;
            lastSnapBottomRef.current     = el.scrollHeight - el.clientHeight;
        });
    }, [objectUrls]);

    // Also catch image natural-height layout that happens after React's paint
    // (blob URLs are in memory so they load fast, but the browser still sizes
    // them asynchronously). The 'load' event fires when the image is fully sized.
    // onLoad is async (browser event), so followBottomRef is already correct by
    // then — no race to worry about here.
    useEffect(() => {
        const el = feedRef.current;
        if (!el) return;
        const onLoad = () => {
            const feedEl = feedRef.current;
            if (!feedEl || !followBottomRef.current) return;
            feedEl.scrollTop              = feedEl.scrollHeight;
            lastKnownScrollTopRef.current = feedEl.scrollHeight - feedEl.clientHeight;
            lastSnapBottomRef.current     = feedEl.scrollHeight - feedEl.clientHeight;
        };
        el.addEventListener('load', onLoad, true); // capture so we catch img load
        return () => el.removeEventListener('load', onLoad, true);
    }, []);

    // PERF: which attachments get decrypted into object URLs. It used to be
    // every attachment in the conversation's whole loaded history on every
    // open (a DM's full local history, a channel's every loaded page) — each
    // one an IndexedDB read + AES-GCM decrypt + a resident decrypted blob +
    // a pane re-render, for rows nobody could see. Now: the rows on screen,
    // one page above them (so scrolling up finds them ready — media is still
    // auto-loaded, just a page ahead instead of all at once), and pinned
    // messages (the pinned panel shows them). The rest still get their
    // ENCRYPTED bytes cached locally in the background, exactly as before, so
    // they survive the server's attachment sweep; they're decrypted when
    // scrolled near.
    const stablePinnedMsgIds = useShallowStable(pinnedMsgIds);
    const decryptScope = useMemo(() => {
        const start = Math.max(0, messages.length - pagination.visibleCount - MESSAGE_PAGE_SIZE);
        if (start === 0) return { inScope: messages, outOfScope: [] as typeof messages };
        const pinned = new Set(stablePinnedMsgIds);
        const inScope: typeof messages = [];
        const outOfScope: typeof messages = [];
        for (let i = 0; i < start; i++) {
            const m = messages[i];
            if (m?.content?.type !== 'attachment') continue;
            (pinned.has(m.id) ? inScope : outOfScope).push(m);
        }
        for (let i = start; i < messages.length; i++) inScope.push(messages[i]);
        return { inScope, outOfScope };
    }, [messages, pagination.visibleCount, stablePinnedMsgIds]);

    useEffect(() => {
        for (const msg of decryptScope.outOfScope) {
            const c = msg?.content as AttachmentRef | undefined;
            if (c?.attachment_id && token) backgroundCacheEncryptedAttachment(c.attachment_id, token);
        }
    }, [decryptScope, token]);

    useEffect(() => {
        // Auto-decrypt attachments when messages arrive.
        // Large files (>50MB): decrypt automatically on FIRST view, manual on revisit.
        const SEEN_KEY = 'cipherline_seen_large_attachments';
        const getSeenSet = (): Set<string> => {
            try { return new Set(JSON.parse(secureLocalStore.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); }
        };
        const markSeen = (attachmentId: string) => {
            const s = getSeenSet(); s.add(attachmentId);
            secureLocalStore.setItem(SEEN_KEY, JSON.stringify([...s]));
        };

        // Hydrate the per-user "known-removed" attachment set so messages whose
        // attachments have already been swept render the gray placeholder
        // without hitting the API for another 404.
        const removedAttSet = user?.user_id ? getRemovedAttachmentIds(user.user_id) : new Set<string>();
        if (removedAttSet.size > 0) {
            setRemovedAttachmentMsgIds(prev => {
                let next: Set<string> | null = null;
                for (const msg of messages) {
                    const c = msg?.content as any;
                    if (c?.type === 'attachment' && c.attachment_id && removedAttSet.has(c.attachment_id) && !prev.has(msg.id)) {
                        if (!next) next = new Set(prev);
                        next.add(msg.id);
                    }
                }
                return next ?? prev;
            });
        }

        // Newest first: the bottom of the feed is what is on screen, so it takes
        // the decrypt slots first (see attachmentDecryptSlots).
        [...decryptScope.inScope].reverse().forEach(async (msg) => {
            const content = msg.content as any;
            const msgId: string = msg.id;
            // Skip attachments we already know the server doesn't have. Saves a
            // pointless 404 round-trip on every render after the first one.
            if (content?.type === 'attachment' && content.attachment_id && removedAttSet.has(content.attachment_id)) {
                return;
            }
            if (
                content.type === 'attachment' &&
                !objectUrls[msgId] &&
                !pendingObjectUrlsRef.current?.[msgId] &&
                !heldMediaRef.current.has(msgId) &&
                !manualDecryptIds.has(msgId) &&
                !autoDecryptingRef.current.has(msgId) &&
                !decryptErrors[msgId] &&
                !removedAttachmentMsgIds.has(msgId)
            ) {
                // Already decrypted this session (this chat earlier, or another
                // pane): no IndexedDB read, no decrypt, no flash of a spinner.
                const cachedUrl = content.attachment_id ? acquireDecryptedMedia(content.attachment_id) : null;
                if (cachedUrl) {
                    if (!paneMountedRef.current) { releaseDecryptedMedia(content.attachment_id); return; }
                    heldMediaRef.current.set(msgId, content.attachment_id);
                    queueObjectUrl(msgId, cachedUrl);
                    return;
                }
                const isLarge = content.byte_size >= LARGE_FILE_BYTES;
                if (isLarge) {
                    const seenBefore = getSeenSet().has(content.attachment_id);
                    if (seenBefore) {
                        setManualDecryptIds(prev => new Set([...prev, msgId]));
                        return;
                    }
                    // First time — mark as seen NOW (before async) so re-runs skip it
                    if (content.attachment_id) markSeen(content.attachment_id);
                }
                autoDecryptingRef.current.add(msgId);
                try {
                    await attachmentDecryptSlots.run(false, () => trackActivity('attachment:decrypt', async () => {
                        // Left this chat while queued: don't spend the slot (and
                        // a large file still counts as never viewed).
                        if (!paneMountedRef.current) {
                            if (isLarge && content.attachment_id) {
                                const s = getSeenSet(); s.delete(content.attachment_id);
                                secureLocalStore.setItem(SEEN_KEY, JSON.stringify([...s]));
                            }
                            return;
                        }
                        // 1. Prefer the local encrypted-bytes cache — zero-network path.
                        let encBlob: Blob | null = await getEncryptedAttachment(content.attachment_id);

                        // 2. Fall back to MinIO download via the centralised util that
                        //    enforces timeouts and structured errors. ALWAYS cache on
                        //    success — the user's local retention window can outlast the
                        //    server's 14-day MinIO sweep.
                        if (!encBlob) {
                            encBlob = await downloadEncryptedAttachment(
                                content.attachment_id,
                                token!,
                                API_BASE,
                            );
                            putEncryptedAttachment(content.attachment_id, encBlob).catch(e => console.warn('[cache] write failed', e));
                        }

                        const key = await importKeyFromBase64(content.file_key_b64);
                        const decryptedBlob = await decryptBlob(encBlob, key, content.file_nonce_b64, content.mime);
                        if (content.attachment_id) {
                            const objUrl = putDecryptedMediaBlob(content.attachment_id, decryptedBlob);
                            if (!paneMountedRef.current) { releaseDecryptedMedia(content.attachment_id); return; }
                            heldMediaRef.current.set(msgId, content.attachment_id);
                            queueObjectUrl(msgId, objUrl);
                        }
                    }));
                } catch (err) {
                    console.error('Failed to decrypt and render attachment', err);
                    // If large file failed after marking seen, unmark it so user can retry manually
                    if (isLarge && content.attachment_id) {
                        const s = getSeenSet(); s.delete(content.attachment_id);
                        secureLocalStore.setItem(SEEN_KEY, JSON.stringify([...s]));
                    }
                    // 404 = the attachment has been deleted (local retention
                    // sweep OR server-side 14d MinIO sweep), on either the
                    // metadata or the blob leg — see isAttachmentGone.
                    // Treat as "no longer available" — subtle gray placeholder,
                    // no red error, no Retry button. Persist the attachment_id
                    // so subsequent renders skip the fetch entirely.
                    const is404 = isAttachmentGone(err);
                    if (is404) {
                        if (user?.user_id && content.attachment_id) {
                            markAttachmentRemoved(user.user_id, content.attachment_id);
                        }
                        setRemovedAttachmentMsgIds(prev => {
                            const n = new Set(prev); n.add(msgId); return n;
                        });
                    } else if (isLarge) {
                        // Large file genuine failure: fall back to the manual
                        // "Decrypt & View" button (less alarming than a red card).
                        setManualDecryptIds(prev => new Set([...prev, msgId]));
                    } else {
                        const code = err instanceof AttachmentDownloadError ? err.code : 'decrypt_failed';
                        const message = err instanceof AttachmentDownloadError
                            ? describeDownloadError(err)
                            : (err instanceof Error ? err.message : 'Decryption failed');
                        setDecryptErrors(prev => ({ ...prev, [msgId]: { code, message } }));
                    }
                } finally {
                    autoDecryptingRef.current.delete(msgId);
                }
            }
        });
    }, [messages, decryptScope, token, objectUrls, manualDecryptIds, decryptErrors, removedAttachmentMsgIds, user?.user_id, queueObjectUrl]);

    const decryptManual = async (msg: any) => {
        const content = msg.content as any;
        const msgId = msg.id;

        // Clear any prior error so the error card disappears while we retry.
        setDecryptErrors(prev => {
            if (!prev[msgId]) return prev;
            const n = { ...prev }; delete n[msgId]; return n;
        });

        // Set up an AbortController so the user can cancel a stuck download.
        const aborter = new AbortController();
        decryptAbortRef.current.set(msgId, aborter);

        setDecryptingIds(prev => ({ ...prev, [msgId]: 0 }));
        try {
            // 1. Prefer the local encrypted-bytes cache. Saved attachments land here
            //    the first time they're downloaded, so this path keeps them viewable
            //    forever even after the server has purged the MinIO object.
            let encryptedBlob: Blob | null = await getEncryptedAttachment(content.attachment_id);

            // 2. Network fetch — only if cache miss. Bounded by hard timeouts via
            //    downloadEncryptedAttachment (10s metadata / 60s blob default).
            if (!encryptedBlob) {
                setDecryptingIds(prev => ({ ...prev, [msgId]: 5 }));
                encryptedBlob = await downloadEncryptedAttachment(
                    content.attachment_id,
                    token!,
                    API_BASE,
                    {
                        signal: aborter.signal,
                        onProgress: (pct) => {
                            // Reserve the last 10% for the decrypt step.
                            setDecryptingIds(prev => ({ ...prev, [msgId]: Math.min(90, Math.round(pct * 0.9)) }));
                        },
                    },
                );
                // Always cache — respects the user's local retention window even if
                // longer than the server's 14-day purge. Evicted by the retention sweeper.
                putEncryptedAttachment(content.attachment_id, encryptedBlob).catch(e => console.warn('[cache] write failed', e));
            }

            // 3. Decrypt
            setDecryptingIds(prev => ({ ...prev, [msgId]: 90 }));
            const key = await importKeyFromBase64(content.file_key_b64);
            const decryptedBlob = await decryptBlob(encryptedBlob, key, content.file_nonce_b64, content.mime);

            // 4. Create object URL and clean up
            setDecryptingIds(prev => ({ ...prev, [msgId]: 100 }));
            adoptAttachmentUrl(msgId, content.attachment_id, putDecryptedMediaBlob(content.attachment_id, decryptedBlob));
            setManualDecryptIds(prev => { const n = new Set(prev); n.delete(msgId); return n; });
            setDecryptingIds(prev => { const n = { ...prev }; delete n[msgId]; return n; });
        } catch (err: any) {
            console.error('Manual decrypt failed', err);
            setDecryptingIds(prev => { const n = { ...prev }; delete n[msgId]; return n; });

            // Aborted = user clicked Cancel. Drop them back to the manual button
            // (no error card), since they explicitly stopped it.
            if (err instanceof AttachmentDownloadError && err.code === 'aborted') {
                setManualDecryptIds(prev => new Set([...prev, msgId]));
                return;
            }

            // 404 = retention/server-side delete — render gray "no longer
            // available" placeholder instead of the alarming red card.
            const is404 = isAttachmentGone(err);
            if (is404) {
                if (user?.user_id && content.attachment_id) {
                    markAttachmentRemoved(user.user_id, content.attachment_id);
                }
                setRemovedAttachmentMsgIds(prev => {
                    const n = new Set(prev); n.add(msgId); return n;
                });
                return;
            }

            // Surface a structured error in the UI. The error card replaces the
            // alert() that was here before — it's persistent until the user clicks
            // Retry, and it tells them WHY ("Download timed out", "HTTP 404", …).
            const code = err instanceof AttachmentDownloadError ? err.code : 'decrypt_failed';
            const message = err instanceof AttachmentDownloadError
                ? describeDownloadError(err)
                : (err instanceof Error ? err.message : 'Decryption failed');
            setDecryptErrors(prev => ({ ...prev, [msgId]: { code, message } }));
        } finally {
            decryptAbortRef.current.delete(msgId);
        }
    };

    /** Cancel an in-flight manual decrypt. Re-adds the row to manualDecryptIds
     *  so the "Decrypt & View" button reappears. */
    const cancelDecrypt = (msgId: string) => {
        const a = decryptAbortRef.current.get(msgId);
        if (a) a.abort();
        decryptAbortRef.current.delete(msgId);
        setDecryptingIds(prev => { const n = { ...prev }; delete n[msgId]; return n; });
        setManualDecryptIds(prev => new Set([...prev, msgId]));
    };

    /** Retry after an error card was shown. Clears the error and re-runs the
     *  appropriate path: small files re-enter the auto-decrypt useEffect via
     *  the message list; large files go back to manual decrypt. */
    const retryDecrypt = (msg: any) => {
        const msgId = msg.id;
        setDecryptErrors(prev => {
            const n = { ...prev }; delete n[msgId]; return n;
        });
        const content = msg.content as any;
        const isLarge = content?.byte_size >= LARGE_FILE_BYTES;
        if (isLarge) {
            // Manual decrypt path.
            decryptManual(msg);
        }
        // Small files: clearing decryptErrors above is enough — the auto-decrypt
        // useEffect's dep array includes decryptErrors, so it re-runs and tries again.
    };

    /**
     * Fire-and-forget: download the encrypted ciphertext and put it in IndexedDB.
     * Called whenever the user marks an attachment Saved (from every save entry
     * point). Idempotent — no-op if already cached. Safe to run in parallel with
     * decrypt flows; they all read the cache as source of truth.
     */
    const ensureAttachmentCached = async (msg: any) => {
        const content = msg?.content as any;
        const attId = content?.attachment_id;
        if (!attId || content?.type !== 'attachment') return;
        try {
            if (await hasEncryptedAttachment(attId)) return;
            const blob = await downloadEncryptedAttachment(attId, token!, API_BASE);
            await putEncryptedAttachment(attId, blob);
        } catch (e) {
            console.warn('[save] background cache fetch failed — attachment may still be on server for now', e);
        }
    };

    const handleInputTyping = (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
        const val = e.target.value;
        setInputText(val);
        if (e.target instanceof HTMLTextAreaElement) {
            e.target.style.height = 'auto'; // reset to measure true content height
            e.target.style.height = `${Math.min(e.target.scrollHeight, 260)}px`;
        }

        // Write-then-erase egg: remember the longest this draft ever got, and
        // when it collapses back to empty, count that as one erase.
        if (val.length === 0) {
            if (draftHighWater.current >= DRAFT_MIN_CHARS) {
                draftErases.current += 1;
                if (draftErases.current >= DRAFT_ERASED_AT) {
                    flashPlaceholder(pickRotating(DRAFT_ERASED_POOL, draftErases.current - DRAFT_ERASED_AT));
                }
            }
            draftHighWater.current = 0;
        } else if (val.length > draftHighWater.current) {
            draftHighWater.current = val.length;
        }

        // ALL CAPS detection — 6+ consecutive uppercase-only letters
        setLoudInput(/[A-Z]{6,}/.test(val) && val !== val.toLowerCase());
        // @everyone — tremble ONCE on the rising edge (not every keystroke), so the
        // box shakes for ~0.8s instead of shivering continuously while you type.
        const hasEveryone = val.includes('@everyone');
        if (hasEveryone && !everyonePrevRef.current) {
            if (sendIcoRef.current) playIco(sendIcoRef.current, 'play-scared');
            setBoxTremble(true);
            window.setTimeout(() => setBoxTremble(false), 820);
        }
        everyonePrevRef.current = hasEveryone;

        // ── :emoji: autocomplete detection ────────────────────────────────────
        const cursor = (e.target as HTMLTextAreaElement).selectionStart ?? val.length;
        const before = val.slice(0, cursor);
        // Match a lone colon followed by 2+ word chars with no space since it
        const triggerMatch = before.match(/:([a-z0-9_+\-]{2,})$/);
        if (triggerMatch) {
            const query = triggerMatch[1];
            const results = searchEmojiWithCustom(query, serverEmojis);
            if (results.length > 0) {
                setEmojiSuggestions(results);
                setEmojiQueryRange({ start: cursor - triggerMatch[0].length, end: cursor });
                setSelectedSuggestionIdx(0);
            } else {
                setEmojiSuggestions([]);
                setEmojiQueryRange(null);
            }
        } else {
            setEmojiSuggestions([]);
            setEmojiQueryRange(null);
        }

        // ── @mention autocomplete detection ─────────────────────────────────
        // Match `@` preceded by start-of-string or whitespace (lookbehind so
        // the space isn't consumed), followed by 0–32 chars that are NOT another
        // `@`, a newline, or `>`.  Allowing spaces in the query keeps the dropdown
        // open while the user types multi-word role / user names like "Server Admin".
        // A second `@` in the text closes off the current query automatically.
        const mentionMatch = before.match(/(?:^|(?<=[\s\n]))@([^@\n>]{0,32})$/);
        if (mentionMatch && !emojiQueryRange) {
            const query = mentionMatch[1].toLowerCase().trimEnd(); // trim trailing spaces before filtering
            const triggerStart = cursor - mentionMatch[0].length; // mentionMatch[0] starts with @
            const triggerEnd = cursor;

            // Build candidate list:
            // 1. @everyone / @here — gated by MENTION_EVERYONE in server channels
            //    (DMs/groups have no concept; canMention is permissive there).
            const specials: MentionSuggestion[] = canMention
                ? [
                    { type: 'everyone', id: 'everyone', label: 'everyone' },
                    { type: 'here',     id: 'here',     label: 'here' },
                ]
                : [];
            // 2. Members (from channel fetch or from DM/group userIdToUsername map)
            const memberCandidates: MentionSuggestion[] = (
                activeChannel
                    ? mentionMembers.map(m => ({
                        type: 'user' as const, id: m.user_id, label: m.username,
                        avatarId: userIdToAvatar[m.user_id] ?? null,
                        discriminator: m.discriminator,
                        nickname: serverMemberNicknames?.[m.user_id] ?? null,
                    }))
                    : Object.entries(userIdToUsername)
                        // Scoped to THIS conversation's participants, which is
                        // load-bearing rather than cosmetic. `userIdToUsername`
                        // is seeded from the session peer-identity cache so
                        // author names survive a remount, which means it holds
                        // everyone this session has resolved anywhere. Reading
                        // it wholesale here would offer a DM's @-autocomplete
                        // people who are not in the DM — both a mention token
                        // for a non-participant and a readout, from inside one
                        // conversation, of who else the account has been
                        // talking to. Name lookups elsewhere are all keyed by a
                        // sender id already present in the message list, so
                        // this is the only consumer that needs the scope.
                        .filter(([uid]) => uid !== user?.user_id && conversationUserIds.has(uid))
                        .map(([uid, un]) => ({
                            type: 'user' as const, id: uid, label: un,
                            avatarId: userIdToAvatar[uid] ?? null,
                        }))
            );
            // 3. Roles (channel mode only)
            const roleCandidates: MentionSuggestion[] = activeChannel
                ? mentionRoles.map(r => ({
                    type: 'role' as const,
                    id: r.role_id,
                    label: r.name,
                    color: r.color !== -1 ? `#${((r.color >>> 0) & 0xFFFFFF).toString(16).padStart(6, '0')}` : undefined,
                }))
                : [];

            const all: MentionSuggestion[] = [...specials, ...memberCandidates, ...roleCandidates];
            // Matches username OR server nickname; prefix hits before substring
            // hits (see utils/mentionSuggestions.ts).
            const filtered = rankMentionCandidates(all, query, 10);

            if (filtered.length > 0) {
                setMentionSuggestions(filtered);
                setMentionQueryRange({ start: triggerStart, end: triggerEnd });
                setSelectedMentionIdx(0);
            } else {
                setMentionSuggestions([]);
                setMentionQueryRange(null);
            }
        } else {
            setMentionSuggestions([]);
            setMentionQueryRange(null);
        }

        sendTypingEvent('typing:start', activeChat.id);
        // DM/group: claim this message's recipients now, while it is being
        // typed, so Enter goes straight to encrypt + POST.
        if (!activeChannel && bundleReady) primeRecipients(activeChat.id);

        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => {
            sendTypingEvent('typing:stop', activeChat.id);
        }, 3000);
    };

    const insertEmojiSuggestion = (suggestion: EmojiSuggestion) => {
        if (!emojiQueryRange) return;
        // Custom-server-emoji suggestion: insert the clean ":name:" form (not
        // the wire token — that would put a raw UUID in the textarea) and
        // register the substitution buildEmojiWireText applies at send time.
        // Same "clean display + token map" split insertMentionSuggestion
        // already uses for @mentions, for the same reason.
        const displayText = suggestion.custom ? `:${suggestion.name}:` : suggestion.native;
        if (suggestion.custom) {
            emojiTokenMapRef.current[displayText] = `<:${suggestion.name}:${suggestion.id}>`;
        }
        const before = inputText.slice(0, emojiQueryRange.start);
        const after = inputText.slice(emojiQueryRange.end);
        const next = before + displayText + after;
        setInputText(next);
        setEmojiSuggestions([]);
        setEmojiQueryRange(null);
        requestAnimationFrame(() => {
            const ta = inputRef.current;
            if (ta) {
                const pos = emojiQueryRange.start + displayText.length;
                ta.focus();
                ta.setSelectionRange(pos, pos);
            }
        });
    };

    const insertMentionSuggestion = (suggestion: MentionSuggestion) => {
        if (!mentionQueryRange) return;
        // What the user sees in the textarea: just @label (clean, no ID clutter)
        const displayToken = suggestion.type === 'everyone' ? '@everyone'
            : suggestion.type === 'here'    ? '@here'
            : `@${suggestion.label}`;
        // Also keep the wire-format token in the map so buildWireText can substitute later
        if (suggestion.type === 'user') {
            mentionTokenMapRef.current[suggestion.label] = `<@u:${suggestion.id}:${suggestion.label}>`;
        } else if (suggestion.type === 'role') {
            mentionTokenMapRef.current[suggestion.label] = `<@r:${suggestion.id}:${suggestion.label}>`;
        }
        const before = inputText.slice(0, mentionQueryRange.start);
        const after  = inputText.slice(mentionQueryRange.end);
        // Always add a trailing space after the token if there isn't one
        const next = before + displayToken + (after.startsWith(' ') ? '' : ' ') + after.trimStart();
        setInputText(next);
        setMentionSuggestions([]);
        setMentionQueryRange(null);
        requestAnimationFrame(() => {
            const ta = inputRef.current;
            if (ta) {
                const pos = mentionQueryRange.start + displayToken.length + 1;
                ta.focus();
                ta.setSelectionRange(pos, pos);
            }
        });
    };

    /**
     * Filter out any files that exceed the hard 10 GB cap. Alerts the user
     * once per reject and returns only the files that are small enough to
     * actually upload. Called from every file ingestion path (picker, drag-
     * drop, paste) so no single ingestion site can bypass the limit.
     */
    const filterUploadableFiles = (files: File[]): File[] => {
        const ok: File[] = [];
        const tooBig: string[] = [];
        for (const f of files) {
            if (f.size > maxUploadBytes) tooBig.push(f.name);
            else ok.push(f);
        }
        if (tooBig.length) {
            if (isFreeTier) {
                // Show the Pro explainer so the user can act on it.
                promptUpgrade('upload', freeTierTooLargeDetail(tooBig));
            } else {
                // Paid users hit the hard 2 GB ceiling — a toast is sufficient.
                const cap = `${(maxUploadBytes / 1024 / 1024 / 1024).toFixed(0)} GB`;
                const names = tooBig.length === 1 ? `"${tooBig[0]}"` : tooBig.join('\n');
                toast.push({
                    kind: 'error',
                    title: tooBig.length === 1 ? 'File too large' : `${tooBig.length} files too large`,
                    message: tooBig.length === 1
                        ? `${names} exceeds the ${cap} upload limit and won't be attached.`
                        : `These files exceed the ${cap} upload limit and won't be attached:\n${names}`,
                });
            }
        }
        return ok;
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = filterUploadableFiles(Array.from(e.target.files || []));
        if (files.length === 0) {
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }
        setStagedFiles(prev => [...prev, ...files]);
        if (fileInputRef.current) fileInputRef.current.value = '';
        setTimeout(() => inputRef.current?.focus(), 0);
    };

    const handleDragEnter = (e: React.DragEvent) => {
        e.preventDefault();
        // Don't show the drop overlay if the user lacks ATTACH_FILES — drop will
        // be rejected anyway; pretending you can accept the file is dishonest UX.
        if (!canAttach) return;
        dragCounterRef.current += 1;
        if (dragCounterRef.current === 1) setIsDragOver(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        if (!canAttach) return;
        dragCounterRef.current -= 1;
        if (dragCounterRef.current === 0) setIsDragOver(false);
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        dragCounterRef.current = 0;
        setIsDragOver(false);
        // Permission gate — server enforces too (P8a), but blocking client-side
        // gives a clean toast instead of a 403 mid-upload.
        if (!canAttach) {
            toast.push({
                kind: 'warning',
                title: 'No permission',
                message: "You don't have permission to attach files in this channel.",
            });
            return;
        }
        const files = filterUploadableFiles(Array.from(e.dataTransfer.files));
        if (files.length === 0) return;
        setStagedFiles(prev => [...prev, ...files]);
        setTimeout(() => inputRef.current?.focus(), 0);
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
        const raw = Array.from(e.clipboardData.files);
        if (raw.length > 0) {
            e.preventDefault();
            if (!canAttach) {
                toast.push({
                    kind: 'warning',
                    title: 'No permission',
                    message: "You don't have permission to attach files in this channel.",
                });
                return;
            }
            const files = filterUploadableFiles(raw);
            if (files.length > 0) setStagedFiles(prev => [...prev, ...files]);
            return;
        }
        // Text paste — warn if the clipboard plus the current input would exceed
        // the cap (the browser's maxLength will silently clamp otherwise).
        const text = e.clipboardData.getData('text');
        if (text && inputText.length + text.length > MAX_TEXT_MESSAGE_LENGTH) {
            const fits = Math.max(0, MAX_TEXT_MESSAGE_LENGTH - inputText.length);
            toast.push({
                kind: 'warning',
                title: 'Paste truncated',
                message: `Messages are capped at ${MAX_TEXT_MESSAGE_LENGTH.toLocaleString()} characters. Only the first ${fits.toLocaleString()} of your paste were kept.`,
            });
        }
    };

    const removeStagedFile = (idx: number) => {
        setStagedFiles(prev => prev.filter((_, i) => i !== idx));
        // Attach-then-unattach egg: pick a file, change your mind, repeat —
        // and the paperclip shrugs. Visual only, no line: the shrug is the
        // whole joke, so it doesn't need words (rule 1). Counter is reset by a
        // successful send, so it only fires on genuine back-and-forth.
        attachRemovals.current += 1;
        if (attachRemovals.current === ATTACH_SHRUG_AT) {
            const el = clipRef.current;
            if (el && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
                el.classList.remove('cmp-shrug');
                void el.getBoundingClientRect();
                el.classList.add('cmp-shrug');
                window.setTimeout(() => el.classList.remove('cmp-shrug'), 550);
            }
        }
    };

    const uploadFile = async (file: File, devices: { device_id: string; spk_pub_b64: string }[]): Promise<void> => {
        // Show "Encrypting…" state immediately (progress = 0).
        setUploadProgress(prev => ({ ...prev, [file.name]: 0 }));
        beginUploadLabel(file.name);

        let keyB64: string;
        let ivB64: string;
        let encryptedSize: number;
        let encryptedBlob: Blob | null = null;
        let tempPath: string | null = null;

        // Attempt to get the disk path so the main process can stream-read the file
        // via Node.js (bypasses Electron's Blob API which fails for large files).
        // webUtils.getPathForFile returns '' for in-memory / clipboard files.
        let filePath = '';
        try { filePath = window.electronAPI?.getPathForFile?.(file) ?? ''; } catch { /* ignore */ }
        console.log('[Upload/DM] file:', file.name, 'size:', file.size, 'path:', filePath || '(none — using WebCrypto)');

        // Track whether we got live encryption-progress events so the upload bar
        // can continue from 46 % instead of jumping from 0.
        let encryptProgressReceived = false;

        if (filePath) {
            // PRIMARY: Node.js fs stream in main process — reliable for any file size.
            // file.arrayBuffer() / file.slice().arrayBuffer() both go through Chromium's
            // sandboxed Blob reader which throws NotReadableError above ~2 GB.
            // Node.js reads directly via the OS and has no such limit.
            let unsubEncrypt: (() => void) | null = null;
            unsubEncrypt = window.electronAPI!.onEncryptProgress(({ encrypted, total }) => {
                encryptProgressReceived = true;
                // Map encryption progress to 1–45 % (> 0 switches the UI to show the bar).
                const pct = Math.max(1, Math.round((encrypted / total) * 45));
                setUploadProgress(prev => prev[file.name] === pct ? prev : { ...prev, [file.name]: pct });
            });
            try {
                const enc = await window.electronAPI!.encryptFileToTemp(filePath);
                keyB64        = enc.keyB64;
                ivB64         = enc.ivB64;
                encryptedSize = enc.encryptedSize;
                tempPath      = enc.tempPath;
            } finally {
                unsubEncrypt?.();
            }
        } else if (file.size > LARGE_FILE_THRESHOLD) {
            // SECONDARY: chunk-based IPC encryption — for large files without a
            // disk path. Sends 16 MB slices to the main process; only one chunk
            // lives in the V8 heap at a time so there is no OOM risk regardless
            // of file size. Returns a temp path, so the upload uses streamUpload.
            const enc = await chunkEncryptFile(file, (encrypted, total) => {
                encryptProgressReceived = true;
                const pct = Math.max(1, Math.round((encrypted / total) * 45));
                setUploadProgress(prev => prev[file.name] === pct ? prev : { ...prev, [file.name]: pct });
            });
            keyB64        = enc.keyB64;
            ivB64         = enc.ivB64;
            encryptedSize = enc.encryptedSize;
            tempPath      = enc.tempPath;
        } else {
            // FALLBACK: in-renderer WebCrypto via file.arrayBuffer().
            // Works for File objects (not Blob slices!) up to ~1.5 GB on 64-bit.
            const key = await generateAesGcmKey();
            const enc = await encryptBlob(file, key);
            encryptedBlob = enc.encryptedBlob;
            ivB64         = enc.ivB64;
            keyB64        = await exportKeyToBase64(key);
            encryptedSize = encryptedBlob.size;
        }

        // Map 0–1 upload fraction to the display percentage.
        // If encryption emitted progress (0–45 %) continue from 46 %;
        // otherwise the bar starts at 1 % and runs to 100 %.
        const uploadPct = (fraction: number) =>
            encryptProgressReceived
                ? Math.round(46 + fraction * 54)
                : Math.max(1, Math.round(fraction * 100));

        const initRes = await axios.post(`${API_BASE}/attachments/initiate`, buildAttachmentInitiateBody({
            conversationId: activeChat.id,
            sizeBytes: encryptedSize,
            mimeType: file.type || 'application/octet-stream',
        }), { headers: { Authorization: `Bearer ${token}` } });

        try {
            if (tempPath) {
                // Stream the encrypted temp file through the main process.
                // The ciphertext never enters the V8 heap.
                let unsubProgress: (() => void) | null = null;
                unsubProgress = window.electronAPI!.onUploadProgress(({ uploaded, total }) => {
                    const pct = uploadPct(uploaded / total);
                    setUploadProgress(prev => prev[file.name] === pct ? prev : { ...prev, [file.name]: pct });
                });
                try {
                    await window.electronAPI!.streamUpload({
                        url: initRes.data.upload_url,
                        filePath: tempPath,
                        contentType: file.type || 'application/octet-stream',
                        size: encryptedSize,
                    });
                    setUploadProgress(prev => ({ ...prev, [file.name]: 100 }));
                } catch (err) {
                    setUploadProgress(prev => { const n = { ...prev }; delete n[file.name]; return n; });
                    throw err;
                } finally {
                    unsubProgress?.();
                }
            } else {
                await new Promise<void>((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('PUT', initRes.data.upload_url);
                    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
                    xhr.upload.onprogress = (e) => {
                        if (!e.lengthComputable) return;
                        const pct = uploadPct(e.loaded / e.total);
                        setUploadProgress(prev => prev[file.name] === pct ? prev : { ...prev, [file.name]: pct });
                    };
                    xhr.onload = () => {
                        if (xhr.status < 400) {
                            setUploadProgress(prev => ({ ...prev, [file.name]: 100 }));
                            resolve();
                        } else {
                            setUploadProgress(prev => { const n = { ...prev }; delete n[file.name]; return n; });
                            reject(new Error(`Upload failed: HTTP ${xhr.status}`));
                        }
                    };
                    xhr.onerror = () => {
                        setUploadProgress(prev => { const n = { ...prev }; delete n[file.name]; return n; });
                        reject(new Error('Upload network error'));
                    };
                    xhr.send(encryptedBlob!);
                });
            }
        } finally {
            if (tempPath) {
                try { await window.electronAPI!.deleteFile(tempPath); } catch { /* best-effort */ }
            }
        }
        const safeUUID = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const content: ClientContent = {
            client_msg_id: safeUUID,
            type: 'attachment',
            attachment_id: initRes.data.attachment_id,
            filename: file.name,
            byte_size: file.size,
            mime: file.type || 'application/octet-stream',
            file_key_b64: keyB64,
            file_nonce_b64: ivB64,
            enc_alg: 'aes256gcm',
            chunk_size: 0
        };
        // RC-2: address exactly the devices that got wrapped.
        const { ciphertext_b64, recipient_device_ids } = await encryptAndAddress(JSON.stringify(content), user!.user_id, devices, deviceId ?? undefined);

        const sendRes = await axios.post(`${API_BASE}/messages/send`, {
            conversation_id: activeChat.id,
            recipient_device_ids,
            envelope_type: 'signal_chat',
            ciphertext_b64,
            sent_at_client: new Date().toISOString()
        }, { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } });
        // The server's timestamp: this row's position and time, as everyone else sees it.
        const serverTs = typeof sendRes.data?.received_at_server === 'string' ? sendRes.data.received_at_server as string : undefined;

        // The sender shows their own file straight from the picked File (no
        // re-download, no decrypt) — registered in the shared cache so a later
        // visit to this chat paints it instantly too.
        adoptAttachmentUrl(content.client_msg_id!, initRes.data.attachment_id, putDecryptedMediaBlob(initRes.data.attachment_id, file));
        onMessageSent({
            id: content.client_msg_id!,
            content,
            sender_device_id: deviceId,
            timestamp: serverTs ? clampFutureTimestamp(serverTs) : new Date().toISOString(),
            ...(serverTs ? { server_ts: serverTs } : {}),
            conversation_id: activeChat.id
        });
    };

    const uploadFileToChannel = async (file: File, channelId: string): Promise<void> => {
        // Show "Encrypting…" state immediately (progress = 0).
        setUploadProgress(prev => ({ ...prev, [file.name]: 0 }));
        beginUploadLabel(file.name);

        // ── Step 1: Encrypt ──────────────────────────────────────────────────
        let keyB64: string;
        let ivB64: string;
        let encryptedSize: number;
        let encryptedBlob: Blob | null = null;
        let tempPath: string | null = null;

        let filePath = '';
        try { filePath = window.electronAPI?.getPathForFile?.(file) ?? ''; } catch { /* ignore */ }
        console.log('[Upload/Ch] file:', file.name, 'size:', file.size, 'path:', filePath || '(none — using WebCrypto)');

        let encryptProgressReceived = false;

        if (filePath) {
            // PRIMARY: Node.js fs stream — see uploadFile for full explanation.
            let unsubEncrypt: (() => void) | null = null;
            unsubEncrypt = window.electronAPI!.onEncryptProgress(({ encrypted, total }) => {
                encryptProgressReceived = true;
                const pct = Math.max(1, Math.round((encrypted / total) * 45));
                setUploadProgress(prev => prev[file.name] === pct ? prev : { ...prev, [file.name]: pct });
            });
            try {
                const enc = await window.electronAPI!.encryptFileToTemp(filePath);
                keyB64        = enc.keyB64;
                ivB64         = enc.ivB64;
                encryptedSize = enc.encryptedSize;
                tempPath      = enc.tempPath;
            } finally {
                unsubEncrypt?.();
            }
        } else if (file.size > LARGE_FILE_THRESHOLD) {
            // SECONDARY: chunk-based IPC encryption — same as uploadFile above.
            const enc = await chunkEncryptFile(file, (encrypted, total) => {
                encryptProgressReceived = true;
                const pct = Math.max(1, Math.round((encrypted / total) * 45));
                setUploadProgress(prev => prev[file.name] === pct ? prev : { ...prev, [file.name]: pct });
            });
            keyB64        = enc.keyB64;
            ivB64         = enc.ivB64;
            encryptedSize = enc.encryptedSize;
            tempPath      = enc.tempPath;
        } else {
            // FALLBACK: in-renderer WebCrypto via file.arrayBuffer().
            // Works for File objects up to ~1.5 GB on 64-bit.
            const key = await generateAesGcmKey();
            const enc = await encryptBlob(file, key);
            encryptedBlob = enc.encryptedBlob;
            ivB64         = enc.ivB64;
            keyB64        = await exportKeyToBase64(key);
            encryptedSize = encryptedBlob.size;
        }

        const uploadPct = (fraction: number) =>
            encryptProgressReceived
                ? Math.round(46 + fraction * 54)
                : Math.max(1, Math.round(fraction * 100));

        // ── Step 2: Initiate S3 upload slot ──────────────────────────────────
        // channel_id tells the service this is a server-channel attachment (not
        // an avatar), so it verifies server membership and stores the file under
        // channels/<channelId>/<id>.
        const initRes = await axios.post(`${API_BASE}/attachments/initiate`, buildAttachmentInitiateBody({
            channelId,
            sizeBytes: encryptedSize,
            mimeType: file.type || 'application/octet-stream',
        }), { headers: { Authorization: `Bearer ${token}` } });

        // ── Step 3: Upload to the presigned PUT URL ───────────────────────────
        try {
            if (tempPath) {
                // Stream the encrypted temp file through the main process.
                // The ciphertext never enters the V8 heap.
                let unsubProgress: (() => void) | null = null;
                unsubProgress = window.electronAPI!.onUploadProgress(({ uploaded, total }) => {
                    const pct = uploadPct(uploaded / total);
                    setUploadProgress(prev => prev[file.name] === pct ? prev : { ...prev, [file.name]: pct });
                });
                try {
                    await window.electronAPI!.streamUpload({
                        url: initRes.data.upload_url,
                        filePath: tempPath,
                        contentType: file.type || 'application/octet-stream',
                        size: encryptedSize,
                    });
                    // Keep bar at 100% while the message-envelope post is in-flight.
                    setUploadProgress(prev => ({ ...prev, [file.name]: 100 }));
                } catch (err) {
                    setUploadProgress(prev => { const n = { ...prev }; delete n[file.name]; return n; });
                    throw err;
                } finally {
                    unsubProgress?.();
                }
            } else {
                // Standard XHR upload for in-memory files.
                await new Promise<void>((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('PUT', initRes.data.upload_url);
                    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
                    xhr.upload.onprogress = (e) => {
                        if (!e.lengthComputable) return;
                        const pct = uploadPct(e.loaded / e.total);
                        setUploadProgress(prev => prev[file.name] === pct ? prev : { ...prev, [file.name]: pct });
                    };
                    xhr.onload = () => {
                        if (xhr.status < 400) {
                            // Keep bar at 100% while the message-envelope post is in-flight.
                            setUploadProgress(prev => ({ ...prev, [file.name]: 100 }));
                            resolve();
                        } else {
                            setUploadProgress(prev => { const n = { ...prev }; delete n[file.name]; return n; });
                            reject(new Error(`Upload failed: HTTP ${xhr.status}`));
                        }
                    };
                    xhr.onerror = () => {
                        setUploadProgress(prev => { const n = { ...prev }; delete n[file.name]; return n; });
                        reject(new Error('Upload network error'));
                    };
                    xhr.send(encryptedBlob!);
                });
            }
        } finally {
            // Always clean up the encrypted temp file.
            if (tempPath) {
                try { await window.electronAPI!.deleteFile(tempPath); } catch { /* best-effort */ }
            }
        }

        // ── Steps 4–7: Build and post the channel message ────────────────────
        const safeUUID = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const contentJson = JSON.stringify({
            client_msg_id: safeUUID,
            type: 'attachment',
            attachment_id: initRes.data.attachment_id,
            filename: file.name,
            byte_size: file.size,
            mime: file.type || 'application/octet-stream',
            file_key_b64: keyB64,
            file_nonce_b64: ivB64,
            enc_alg: 'aes256gcm',
            chunk_size: 0,
        });

        const { epoch, nonce_b64, ciphertext_b64: channelCt, signature_b64 } =
            await window.electronAPI!.encryptChannelMessage(contentJson, channelId, { user_id: user?.user_id, device_id: deviceId });

        const resp = await axios.post(`${API_BASE}/channels/${channelId}/messages`, {
            sender_device_id: deviceId,
            epoch,
            nonce_b64,
            ciphertext_b64: channelCt,
            signature_b64,
        }, { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } });

        const content = JSON.parse(contentJson);
        // Key objectUrls by the SAME id that will become msg.id in the channel
        // message list (the server-assigned UUID). Using safeUUID here caused the
        // auto-decrypt effect to miss the local blob URL (it looks up objectUrls[msg.id])
        // and attempt to re-download and re-decrypt the file that was just uploaded,
        // triggering a "Couldn't decrypt" error card for the sender.
        const serverMsgId = resp.data.id ?? safeUUID;
        adoptAttachmentUrl(serverMsgId, initRes.data.attachment_id, putDecryptedMediaBlob(initRes.data.attachment_id, file));
        onChannelMessageSent?.({
            id: serverMsgId,
            content,
            sender_device_id: deviceId,
            sender_user_id: resp.data.sender_user_id ?? null,
            // The server's time, so it sorts where everyone else sees it.
            timestamp: resp.data?.created_at ? clampFutureTimestamp(String(resp.data.created_at)) : new Date().toISOString(),
            conversation_id: channelId,
        });
    };

    const dispatchAction = async (content: ClientContent) => {
        if (!bundleReady) { console.warn('[E2EE] Dispatch blocked — key bundle not synced yet'); return; }
        try {
            await sendClientContent(content);
        } catch (err) {
            console.error('Failed to dispatch action:', err);
        }
    };

    /**
     * Encrypt and send one ClientContent to the active chat or channel — the
     * same path every message takes (per-device envelopes for a DM/group, the
     * Sender Key for a channel). Throws on failure so a caller can surface it;
     * `dispatchAction` above is the fire-and-forget wrapper.
     */
    const sendClientContent = async (content: ClientContent) => {
        if (!bundleReady) throw new Error('Your encryption keys are still syncing. Try again in a moment.');
        if (!content.client_msg_id) {
            content.client_msg_id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        }

        // Never overtake a message still queued for this conversation: an
        // edit, delete or reaction aimed at it would reach people first and
        // find nothing to act on.
        await deliveryQueue.idle(activeChannel ? deliveryKey('channel', activeChannel.channel_id) : deliveryKey('dm', activeChat.id));

        // Channel branch: encrypt once with the channel's Sender Key,
        // POST to /channels/:id/messages. Server validates action perms
        // (delete-others requires MANAGE_MESSAGES, edit must be self).
        if (activeChannel) {
            const channelId = activeChannel.channel_id;
            const contentJson = JSON.stringify(content);
            const { epoch, nonce_b64, ciphertext_b64, signature_b64 } =
                await window.electronAPI!.encryptChannelMessage(contentJson, channelId, { user_id: user?.user_id, device_id: deviceId });

            // Build action metadata so the server can perm-gate without
            // reading the ciphertext. Only sent for action types — normal
            // messages omit these and the server treats them as posts.
            const body: Record<string, unknown> = {
                sender_device_id: deviceId,
                epoch,
                nonce_b64,
                ciphertext_b64,
                signature_b64,
            };
            if (content.type === 'edit' || content.type === 'delete' || content.type === 'reaction') {
                body.action_type = content.type;
                body.action_target_id = (content as any).target_id;
            }

            const resp = await axios.post(`${API_BASE}/channels/${channelId}/messages`,
                body, { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } });

            onChannelMessageSent?.({
                id: resp.data.id ?? content.client_msg_id!,
                content,
                sender_device_id: deviceId,
                sender_user_id: resp.data.sender_user_id ?? null,
                // The server's time, so it sorts where everyone else sees it.
                timestamp: resp.data?.created_at ? clampFutureTimestamp(String(resp.data.created_at)) : new Date().toISOString(),
                conversation_id: channelId,
            });
            return;
        }

        // Conversation branch (DM/group): per-recipient envelopes. Recipients
        // (one claimed one-time prekey per device) come from the bundle primed
        // while typing when there is one — single use either way.
        const devices = await takeRecipients(activeChat.id);
        // RC-2: address exactly the devices that got wrapped.
        const { ciphertext_b64, recipient_device_ids } = await encryptAndAddress(JSON.stringify(content), user!.user_id, devices, deviceId ?? undefined);
        const sendRes = await axios.post(`${API_BASE}/messages/send`, {
            conversation_id: activeChat.id,
            recipient_device_ids,
            envelope_type: 'signal_chat',
            ciphertext_b64,
            sent_at_client: new Date().toISOString()
        }, { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } });
        const serverTs = typeof sendRes.data?.received_at_server === 'string' ? sendRes.data.received_at_server as string : undefined;

        onMessageSent({
            id: content.client_msg_id!,
            content,
            sender_device_id: deviceId,
            timestamp: serverTs ? clampFutureTimestamp(serverTs) : new Date().toISOString(),
            ...(serverTs ? { server_ts: serverTs } : {}),
            conversation_id: activeChat.id
        });
    };

    /**
     * Send a KLIPY GIF as a `klipy_gif` REFERENCE — the slug and the one
     * rendition picked, inside the normal E2EE envelope. Nothing is uploaded;
     * each recipient's client loads the media from KLIPY if (and only if) that
     * recipient has opted in. Re-validated against the shared contract first so
     * this client can never put a non-KLIPY URL on the wire.
     */
    const handleSendKlipyGif = async (ref: KlipyGifRef) => {
        const clean = parseKlipyGifRef(ref);
        if (!clean) throw new Error('That GIF could not be sent.');
        const content: ClientContent = {
            type: 'klipy_gif',
            slug: clean.slug,
            media: clean.media,
            ...(clean.title ? { title: clean.title } : {}),
        };
        await sendClientContent(content);
    };

    /**
     * Send the user's OWN contact verification code into this DM as a
     * `safety_number` embed, so the other side can compare it with one click
     * instead of transcribing forty characters.
     *
     * Safe to put on the wire: the code is a hash of PUBLIC identity keys, so
     * it discloses nothing the key directory does not already serve to anyone
     * who asks. What it deliberately does NOT carry is any claim about the
     * outcome — the recipient recomputes the expectation from its own copy of
     * the keys (see utils/safetyNumberEmbed.ts). Same envelope path as every
     * other DM message; the server stays a blind relay and learns nothing new.
     */
    const handleSendSafetyNumber = useCallback(async (code: string, deviceCount: number) => {
        if (!activeChat?.id || !user?.user_id || !deviceId || !token) {
            throw new Error('Not ready to send');
        }
        const safeUUID = typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `local-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        const content: ClientContent = {
            client_msg_id: safeUUID,
            type: 'safety_number',
            user_id: user.user_id,
            code,
            device_count: deviceCount,
        };
        // claim_otp=1 for per-message forward secrecy, exactly as the composer does.
        const devicesRes = await axios.get(`${API_BASE}/conversations/${activeChat.id}/devices?claim_otp=1`, {
            headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId },
        });
        if (!Array.isArray(devicesRes.data)) {
            throw new Error(`[E2EE] /conversations/${activeChat.id}/devices returned ${typeof devicesRes.data} instead of array`);
        }
        const devs = devicesRes.data as { device_id: string; spk_pub_b64: string }[];
        const { ciphertext_b64, recipient_device_ids } =
            await encryptAndAddress(JSON.stringify(content), user.user_id, devs, deviceId ?? undefined);
        await axios.post(`${API_BASE}/messages/send`, {
            conversation_id: activeChat.id,
            recipient_device_ids,
            envelope_type: 'signal_chat',
            ciphertext_b64,
            sent_at_client: new Date().toISOString(),
        }, { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } });

        onMessageSent({
            id: safeUUID,
            content,
            sender_device_id: deviceId,
            // Carried explicitly so the optimistic bubble renders as "yours"
            // through the same envelope-sender path a received one uses,
            // rather than through a device-id fallback.
            sender_user_id: user.user_id,
            timestamp: new Date().toISOString(),
            conversation_id: activeChat.id,
        });
    }, [activeChat, user, deviceId, token, onMessageSent]);

    /** Actually send the delete. Never call this directly from a UI affordance —
     *  go through `requestDelete` so the confirmation policy applies. */
    const performDelete = async (msgId: string) => {
        // Removed confirm() as native dialogs in Electron break window focus hooks
        const target = messages.find(m => m.id === msgId);
        await dispatchAction({ type: 'delete', target_id: msgId });
        // An explicit delete is the ONE place the server copy of a file goes.
        // Retention sweeps are per-device and local-only (Dashboard), so the
        // file stays available to the user's other devices and to recipients
        // until someone deliberately deletes the message. Sent after the
        // delete itself so a failed delete never leaves a message pointing at
        // a missing file. Best effort: the server authorises (uploader, or a
        // group owner/admin) and its 14-day sweep is the backstop.
        const attachmentId = attachmentToDeleteWithMessage(target);
        if (attachmentId && token) {
            axios.delete(`${API_BASE}/attachments/${attachmentId}`, { headers: { Authorization: `Bearer ${token}` } })
                .catch(() => { /* not ours to delete, already gone, or offline: the server sweep covers it */ });
        }
    };

    /**
     * The single funnel every delete affordance goes through. Shows the
     * confirmation unless the activation bypassed it (Shift held — see
     * shouldConfirmMessageDelete for why that works from the keyboard too).
     */
    const requestDelete = (msg: { id: string }, activation: DeleteActivation, isOwnMessage: boolean) => {
        if (!shouldConfirmMessageDelete(activation)) {
            performDelete(msg.id);
            return;
        }
        setPendingDelete({
            msgId: msg.id,
            copy: buildDeleteConfirmCopy({ isOwnMessage }),
        });
    };

    /** Scroll the feed to centre a message row by id, flash it, expand pagination if needed. */
    const jumpToMessage = useCallback((targetId: string) => {
        // Resolve ID: also try matching content.client_msg_id for group-chat cross-device
        // compatibility (recipients may store the same message under a different envelope_id).
        const resolvedId = (() => {
            const byId = messages.find((m: any) => m.id === targetId);
            if (byId) return byId.id as string;
            const byClient = messages.find((m: any) => m.content?.client_msg_id === targetId);
            return (byClient?.id as string | undefined) ?? targetId;
        })();

        const doScroll = (id: string): boolean => {
            const feedEl = feedRef.current;
            if (!feedEl) return false;
            const msgEl = document.getElementById(`msg-${id}`);
            if (!msgEl) return false;

            // Disengage auto-follow so the layout effect won't snap us back.
            followBottomRef.current = false;
            isAtBottomRef.current   = false;
            setShowScrollBtn(true);

            // Scroll the feed container directly — more reliable than scrollIntoView
            // which walks all scrollable ancestors and can hit the wrong container.
            const feedRect = feedEl.getBoundingClientRect();
            const msgRect  = msgEl.getBoundingClientRect();
            const centredTop = feedEl.scrollTop
                + msgRect.top  - feedRect.top
                - (feedRect.height - msgRect.height) / 2;
            feedEl.scrollTo({ top: Math.max(0, centredTop), behavior: 'smooth' });

            setHighlightedMsgId(id);
            setTimeout(() => setHighlightedMsgId(prev => (prev === id ? null : prev)), 1800);
            return true;
        };

        if (doScroll(resolvedId)) return;

        // Not in the DOM yet — expand pagination window; the effect below will
        // fire once the new rows are painted.
        pendingScrollMsgIdRef.current = resolvedId;
        pagination.ensureVisible(resolvedId);
        // Retry after a short delay in case ensureVisible triggers a render that
        // isn't fully committed to the DOM by the time the effect runs.
        setTimeout(() => {
            const pending = pendingScrollMsgIdRef.current;
            if (!pending) return; // already handled by the effect below
            if (doScroll(pending)) pendingScrollMsgIdRef.current = null;
        }, 200);
    }, [pagination, messages]);

    // Keep the jumpToMessage function accessible to Dashboard (for call-overlay jump).
    useEffect(() => {
        if (jumpToMessageRef) jumpToMessageRef.current = jumpToMessage;
    }, [jumpToMessage, jumpToMessageRef]);

    // After pagination expands (new rows painted), complete a pending jump.
    useEffect(() => {
        const id = pendingScrollMsgIdRef.current;
        if (!id) return;
        const feedEl = feedRef.current;
        if (!feedEl) return;
        const msgEl = document.getElementById(`msg-${id}`);
        if (!msgEl) return;

        pendingScrollMsgIdRef.current = null;
        followBottomRef.current = false;
        isAtBottomRef.current   = false;
        setShowScrollBtn(true);

        const feedRect = feedEl.getBoundingClientRect();
        const msgRect  = msgEl.getBoundingClientRect();
        const centredTop = feedEl.scrollTop
            + msgRect.top  - feedRect.top
            - (feedRect.height - msgRect.height) / 2;
        feedEl.scrollTo({ top: Math.max(0, centredTop), behavior: 'smooth' });

        setHighlightedMsgId(id);
        setTimeout(() => setHighlightedMsgId(prev => (prev === id ? null : prev)), 1800);
    }, [pagination.displayed]);

    const handleReact = (msgId: string, emoji: string, currentHasIt: boolean) => {
        dispatchAction({ type: 'reaction', target_id: msgId, emoji, action: currentHasIt ? 'remove' : 'add' });
        setShowEmojiPicker(null);
    };

    /** Whatever was in the composer when an edit was opened, restored on cancel. */
    const preEditDraftRef = useRef<string>('');

    const startEdit = (msg: any) => {
        // Opening an edit replaces the composer contents; hold the draft so
        // Escape / Cancel can hand it back instead of silently eating it.
        if (!editingId) preEditDraftRef.current = inputText;
        setEditingId(msg.id);
        setReplyingId(null);
        // The composer speaks DISPLAY text (`@name`, `:party:`); the stored
        // message is WIRE text (`<@u:ID:name>`, `<:party:ID>`). Loading the
        // wire form straight in put the raw token in front of the user and
        // made them edit around it. Convert for display, and seed the token
        // maps first so `buildWireText` can put every untouched mention back
        // exactly as it was on save — see tokenMapsFromWireText.
        const rawText = msg.content.text || '';
        const seeds = tokenMapsFromWireText(rawText);
        mentionTokenMapRef.current = { ...mentionTokenMapRef.current, ...seeds.mentions };
        emojiTokenMapRef.current   = { ...emojiTokenMapRef.current, ...seeds.emojis };
        setInputText(mentionsToDisplayText(rawText));
        setTimeout(() => {
            if (inputRef.current) {
                inputRef.current.style.height = 'auto';
                inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 260)}px`;
                inputRef.current.focus();
            }
        }, 0);
    };

    /** Abandon the in-progress edit, restore the pre-edit draft, refocus the composer. */
    const cancelEdit = () => {
        const draft = preEditDraftRef.current;
        preEditDraftRef.current = '';
        setEditingId(null);
        setInputText(draft);
        setTimeout(() => {
            const ta = inputRef.current;
            if (!ta) return;
            ta.style.height = 'auto';
            ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`;
            ta.focus();
            // Caret to the end of the restored draft rather than wherever the
            // edited text left it.
            const end = ta.value.length;
            ta.setSelectionRange(end, end);
        }, 0);
    };

    // Escape backs out of an edit wherever focus is — the composer handler
    // below only saw it while the textarea itself was focused, so clicking the
    // message list and pressing Esc did nothing. The suggestion popups register
    // after the edit starts, so an open popup is on top and closes first.
    useEscape(() => cancelEdit(), !!editingId);
    useEscape(() => { setMentionSuggestions([]); setMentionQueryRange(null); }, mentionSuggestions.length > 0);
    useEscape(() => { setEmojiSuggestions([]); setEmojiQueryRange(null); }, emojiSuggestions.length > 0);
    // TASK 2: reply mode had no Escape-to-cancel before (Discord does this).
    // Doesn't touch the typed draft — only clears which message is quoted.
    useEscape(() => setReplyingId(null), !!replyingId);

    // ── Instant-send delivery (utils/pendingSend.ts, utils/deliveryQueue.ts) ──
    /** Recipient devices for a DM/group send, fresh from the server.
     *  claim_otp=1 consumes a one-time prekey per recipient device
     *  (per-message forward secrecy), so every result is single-use. */
    const fetchConversationDevices = async (conversationId: string): Promise<RecipientDevice[]> => {
        const raw = await trackActivity('send:devices', () => axios.get(`${API_BASE}/conversations/${conversationId}/devices?claim_otp=1`, {
            headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId }
        }).then(r => r.data));
        if (!Array.isArray(raw)) {
            throw new Error(`[E2EE] /conversations/${conversationId}/devices returned ${typeof raw} instead of array`);
        }
        return raw;
    };

    /** Start claiming the NEXT message's recipients while it is still being
     *  typed, so Enter does not wait a round trip for them
     *  (utils/recipientBundles.ts — single use, bounded age). */
    const primeRecipients = (conversationId: string) => {
        recipientBundles.prime(recipientBundleKey(deviceId, conversationId), () => fetchConversationDevices(conversationId));
    };
    /** This send's recipients: the bundle primed while typing, else a fresh claim. */
    const takeRecipients = (conversationId: string): Promise<RecipientDevice[]> =>
        recipientBundles.take(recipientBundleKey(deviceId, conversationId), () => fetchConversationDevices(conversationId));

    type DeliveryJob = { kind: 'dm' | 'channel'; conversationId: string; serverId?: string; content: ClientContent };
    /** One delivery lane per conversation, shared by every ChatPane mount. */
    const deliveryKey = (kind: 'dm' | 'channel', conversationId: string) => `${deviceId ?? ''}:${kind}:${conversationId}`;

    /** Deliver a message that is already in the feed: encrypt (overlapping the
     *  previous message's POST), then POST strictly after it, then mark it
     *  delivered — taking the server's id (channel) and the server's time, which
     *  moves it to the position every other member sees — or failed. Never
     *  throws: a failure belongs to the message, not to the composer. */
    const enqueueDelivery = (job: DeliveryJob): void => {
        const clientMsgId = job.content.client_msg_id;
        if (!clientMsgId) return;
        const headers = { Authorization: `Bearer ${token}`, 'x-device-id': deviceId };
        const contentJson = JSON.stringify(job.content);
        const fail = (err: unknown) => {
            console.error('Failed to send:', err instanceof Error ? `${err.name}: ${err.message}` : String(err), err);
            onPatchSentMessage?.(job.kind, job.conversationId, clientMsgId, { send_state: 'failed', send_error: sendFailureReason(err) });
            const msg = err instanceof Error ? err.message : String(err);
            // This device hasn't got the channel's Sender Key: start fetching it
            // so a Retry can succeed.
            if (job.kind === 'channel' && job.serverId && /No channel key|Channel key for epoch/.test(msg)) {
                onChannelKeyMissing?.(job.serverId, job.conversationId);
            }
        };
        if (job.kind === 'channel') {
            const c = job.content as { text?: string; reply_to_id?: string; mentions?: { type: string }[] };
            const mentionsEveryone = (c.mentions ?? []).some(m => m.type === 'everyone' || m.type === 'here');
            const containsUrl = /https?:\/\/[^\s<>"{}|\\^`[\]]+/.test(c.text ?? '');
            void deliveryQueue.enqueue(deliveryKey('channel', job.conversationId), {
                prepare: () => trackActivity('send:encrypt', () => window.electronAPI!.encryptChannelMessage(contentJson, job.conversationId, { user_id: user?.user_id, device_id: deviceId })),
                post: async ({ epoch, nonce_b64, ciphertext_b64, signature_b64 }) => {
                    // A 429 waits out the server's window and tries again (the
                    // limit is respected, never exceeded) instead of failing.
                    const resp = await trackActivity('send:post', () => withRateLimitRetry(() => axios.post(`${API_BASE}/channels/${job.conversationId}/messages`, {
                        sender_device_id: deviceId,
                        epoch,
                        nonce_b64,
                        ciphertext_b64,
                        signature_b64,
                        ...(c.reply_to_id ? { reply_to_id: c.reply_to_id } : {}),
                        ...(mentionsEveryone ? { mentions_everyone: true } : {}),
                        ...(containsUrl ? { contains_url: true } : {}),
                    }, { headers })));
                    onPatchSentMessage?.('channel', job.conversationId, clientMsgId, {
                        send_state: null,
                        id: resp.data?.id,
                        sender_user_id: resp.data?.sender_user_id ?? undefined,
                        // The server's created_at — what every other member sorts
                        // this message by — replaces this device's compose time.
                        timestamp: resp.data?.created_at ? clampFutureTimestamp(String(resp.data.created_at)) : undefined,
                    });
                },
                fail,
            });
        } else {
            void deliveryQueue.enqueue(deliveryKey('dm', job.conversationId), {
                prepare: async () => {
                    const devices = await takeRecipients(job.conversationId);
                    // RC-2: address exactly the devices that got wrapped.
                    return trackActivity('send:encrypt', () => encryptAndAddress(contentJson, user!.user_id, devices, deviceId ?? undefined));
                },
                post: async ({ ciphertext_b64, recipient_device_ids }) => {
                    const resp = await trackActivity('send:post', () => withRateLimitRetry(() => axios.post(`${API_BASE}/messages/send`, {
                        conversation_id: job.conversationId,
                        recipient_device_ids,
                        envelope_type: 'signal_chat',
                        ciphertext_b64,
                        sent_at_client: new Date().toISOString()
                    }, { headers })));
                    // The server's received_at_server: the ordering key (and time)
                    // every recipient gets for this message. An older API does not
                    // return it; the row then simply stays where it is.
                    const serverTs = typeof resp.data?.received_at_server === 'string' ? resp.data.received_at_server : undefined;
                    onPatchSentMessage?.('dm', job.conversationId, clientMsgId, serverTs
                        ? { send_state: null, server_ts: serverTs, timestamp: clampFutureTimestamp(serverTs) }
                        : { send_state: null });
                },
                fail,
            });
        }
    };

    /** Retry a failed message: same content, same client_msg_id (so a copy the
     *  server did get, with only the reply lost, dedupes on every receiver). */
    const retrySend = (msg: { id: string; content?: unknown }) => {
        const content = msg.content as ClientContent | undefined;
        const clientMsgId = content?.client_msg_id;
        if (!content || !clientMsgId) return;
        const kind: 'dm' | 'channel' = activeChannel ? 'channel' : 'dm';
        const conversationId = activeChannel ? activeChannel.channel_id : activeChat.id;
        onPatchSentMessage?.(kind, conversationId, clientMsgId, { send_state: 'sending' });
        enqueueDelivery({ kind, conversationId, serverId: activeChannel?.server_id, content });
    };

    /** Delete a message that never reached anyone — local only, nothing to tell the server. */
    const discardUnsent = (msg: { id: string }) => {
        const del = {
            id: `unsend-${msg.id}`,
            content: { type: 'delete', target_id: msg.id } as unknown as ClientContent,
            sender_device_id: deviceId,
            timestamp: new Date().toISOString(),
        };
        if (activeChannel) onChannelMessageSent?.({ ...del, conversation_id: activeChannel.channel_id });
        else onMessageSent({ ...del, conversation_id: activeChat.id });
    };

    const handleSendAll = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!bundleReady) { toast.push({ kind: 'info', title: 'Please Wait', message: 'Establishing secure session — please wait a moment' }); return; }
        if (sending || (stagedFiles.length === 0 && !inputText.trim())) {
            if (!sending && stagedFiles.length === 0 && !inputText.trim()) {
                // Empty send egg — every 3rd poke crashes the icon + cycles placeholder
                emptySendRef.current += 1;
                if (emptySendRef.current >= 3) {
                    emptySendRef.current = 0;
                    playIco(sendIcoRef.current, 'play-crash', true);
                    const idx = emptySendPlaceholder.current % EMPTY_SEND_POOL.length;
                    emptySendPlaceholder.current += 1;
                    flashPlaceholder(EMPTY_SEND_POOL[idx]);
                }
            }
            return;
        }
        if (inputText.length > MAX_TEXT_MESSAGE_LENGTH) {
            toast.push({
                kind: 'warning',
                title: 'Message too long',
                message: `Messages are capped at ${MAX_TEXT_MESSAGE_LENGTH.toLocaleString()} characters. This one is ${inputText.length.toLocaleString()}.`,
            });
            return;
        }

        // ── Rate-limit check ────────────────────────────────────────────────
        const delay = getRateLimitDelay();
        if (delay > 0) {
            startCooldown(delay);
            return;
        }
        // ────────────────────────────────────────────────────────────────────

        // ── Does this submit get to move the viewport? ───────────────────────
        // This one handler serves both "send new content" and "submit an edit to
        // a message that already exists". Only the first is allowed to drag the
        // feed to the bottom: an edit is reached by scrolling UP, and snapping
        // down on submit threw the user away from what they were reading.
        // Decision logic + rationale: utils/feedScrollDecision.ts.
        const submitKind = classifySubmit({ editingId, stagedFileCount: stagedFiles.length });
        const viewportAction = decideViewportAction({
            kind: submitKind,
            wasAtBottom: isAtBottomRef.current,
        });
        const keepViewport = viewportAction === 'preserve-anchor';
        // Measure the edited row BEFORE anything commits; the layout effect
        // further down restores it once the new text (and the unmounting
        // "Editing Message" strip) have changed the feed's layout.
        if (keepViewport && editingId) captureEditAnchor(editingId);
        else editAnchorRef.current = null;

        // Paper-plane fly on a real send (the flat send button has no kit pressAnim).
        playIco(sendIcoRef.current, 'play-send');
        hasSentOnce.current = true;
        if (!keepViewport) followBottomRef.current = true;   // follow down when the user sends
        setSending(true);

        // ── Plain text is INSTANT ────────────────────────────────────────────
        // A text-only send is put in the feed (marked 'sending') and the
        // composer is cleared the moment the content is built; the devices
        // fetch → encrypt → POST happens behind it, in order, through
        // enqueueDelivery. A failure never takes the message back: it stays in
        // the feed marked "Not delivered" with Retry / Delete
        // (utils/pendingSend.ts). Edits and anything with files keep the
        // original, awaited flow.
        const textOnly = !editingId && stagedFiles.length === 0 && inputText.trim().length > 0;
        // `as` cast: assigned inside a closure, which TypeScript's flow analysis
        // does not see, so it would narrow it to false in the finally.
        let earlyReleased = false as boolean;
        const releaseComposerEarly = () => {
            earlyReleased = true;
            sendTimestamps.current.push(Date.now()); // the rate limiter counts it NOW, not after the round trip
            setInputText('');
            setLoudInput(false);
            emptySendRef.current = 0;
            draftHighWater.current = 0;
            draftErases.current = 0;
            attachRemovals.current = 0;
            setTimeout(() => { if (inputRef.current) inputRef.current.style.height = 'auto'; }, 0);
            setReplyingId(null);
            if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
            sendTypingEvent('typing:stop', activeChat.id);
            setSending(false);
            if (!keepViewport) {
                requestAnimationFrame(() => revealNewMessage());
            }
        };
        try {
            // An awaited send (files, an edit) first lets every message already
            // queued for this conversation go out: it must not overtake them,
            // or an edit could reach people before the message it edits.
            if (!textOnly) {
                await deliveryQueue.idle(activeChannel ? deliveryKey('channel', activeChannel.channel_id) : deliveryKey('dm', activeChat.id));
            }
            // DM/group recipients are resolved PER MESSAGE (takeRecipients),
            // never once per send and shared: each resolution claims one
            // one-time prekey per recipient device, and the recipient deletes
            // that prekey after the first message that used it — so a second
            // file (or the text after a file) encrypted to the same claim was
            // undecryptable for every recipient. Channel sends use the Sender
            // Key and need no recipient list.

            // Upload each staged file sequentially
            for (const file of stagedFiles) {
                // Labelled for the Performance log (encrypt + upload + post).
                if (activeChannel) {
                    await trackActivity('upload:send', () => uploadFileToChannel(file, activeChannel.channel_id));
                } else {
                    const fileRecipients = await takeRecipients(activeChat.id);
                    await trackActivity('upload:send', () => uploadFile(file, fileRecipients));
                }
            }
            setStagedFiles([]);
            setUploadProgress({}); // clear all bars now that all uploads are done

            // Send or Edit text if present
            if (inputText.trim()) {
                // Transform display text (@label) → wire tokens (<@type:id:label>) before sending.
                // For channel mode we have a full label→token map; for DM/group mode the map is
                // populated with @everyone/@here only (no member list needed there).
                const wireText = buildEmojiWireText(buildWireText(inputText, mentionTokenMapRef.current), emojiTokenMapRef.current);
                if (editingId) {
                    // Edit path is the same regardless of conversation type —
                    // dispatchAction internally branches on `activeChannel`
                    // and routes through the channel Sender Key + the channel
                    // edit endpoint when applicable.
                    await dispatchAction({ type: 'edit', target_id: editingId, text: wireText });
                    setEditingId(null);
                } else if (activeChannel) {
                    // ── Sender Keys channel message path ──────────────────────────────
                    // One ciphertext, encrypted with the shared channel key. No per-
                    // recipient envelopes needed — the key was distributed separately.
                    const safeUUID = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                    // If the entire message is a bare Cipherline invite URL, send it as a
                    // typed `server_invite` so recipients see the rich embed immediately.
                    const bareInviteCode = extractInviteCode(wireText.trim());
                    const mentions = bareInviteCode ? [] : extractMentionsFromText(wireText);
                    // Tell the API whether this message has an @everyone / @here so it can set
                    // mentions_everyone on the WS event without decrypting the ciphertext.
                    const mentionsEveryone = mentions.some(m => m.type === 'everyone' || m.type === 'here');
                    // P7g: block send entirely if the user lacks MENTION_EVERYONE.
                    // The mention dropdown already hides @everyone/@here when canMention
                    // is false, but a user could still type the token by hand.
                    // Returning here jumps to the outer finally, which clears `sending`.
                    if (mentionsEveryone && !canMention) {
                        toast.push({
                            kind: 'error',
                            title: 'No permission',
                            message: "You don't have permission to mention @everyone in this channel.",
                        });
                        return;
                    }
                    // P7d-API: detect URL presence; server enforces EMBED_LINKS (P8b).
                    // We pre-disable the send button in the UI but also flag here so
                    // a tampered client can't bypass the API check by skipping the field.
                    const containsUrl = /https?:\/\/[^\s<>"{}|\\^`[\]]+/.test(wireText);
                    // Same belt-and-suspenders pattern as the @everyone guard above:
                    // the send button is disabled when blockedByEmbed is true, but the
                    // Enter-to-send keyboard path bypasses that. Without this check
                    // we'd let the request fly, get a 403 back, and surface a popup
                    // that locks the chat until dismissed.
                    if (isServerChannel && !canEmbed && containsUrl) {
                        toast.push({
                            kind: 'warning',
                            title: 'No link permission',
                            message: "Your message contains a URL but you don't have permission to send links in this channel. Remove the URL to send.",
                        });
                        return;
                    }
                    const msgContent: ClientContent = bareInviteCode
                        ? { client_msg_id: safeUUID, type: 'server_invite', code: bareInviteCode }
                        : { client_msg_id: safeUUID, type: 'text', text: wireText, ...(replyingId ? { reply_to_id: replyingId } : {}), ...(mentions.length > 0 ? { mentions } : {}) };
                    if (textOnly) {
                        // Shown NOW under its client id; delivery swaps in the
                        // server id (or marks it failed) — see enqueueDelivery.
                        onChannelMessageSent?.({
                            id: safeUUID,
                            content: msgContent,
                            sender_device_id: deviceId,
                            sender_user_id: user?.user_id ?? null,
                            timestamp: new Date().toISOString(),
                            conversation_id: activeChannel.channel_id,
                            send_state: 'sending',
                        });
                        releaseComposerEarly();
                        enqueueDelivery({ kind: 'channel', conversationId: activeChannel.channel_id, serverId: activeChannel.server_id, content: msgContent });
                    } else {
                    const contentJson = JSON.stringify(msgContent);
                    const { epoch, nonce_b64, ciphertext_b64: channelCt, signature_b64 } =
                        await trackActivity('send:encrypt', () => window.electronAPI!.encryptChannelMessage(contentJson, activeChannel.channel_id, { user_id: user?.user_id, device_id: deviceId }));
                    const resp = await trackActivity('send:post', () => axios.post(`${API_BASE}/channels/${activeChannel.channel_id}/messages`, {
                        sender_device_id: deviceId,
                        epoch,
                        nonce_b64,
                        ciphertext_b64: channelCt,
                        signature_b64,
                        ...(replyingId ? { reply_to_id: replyingId } : {}),
                        ...(mentionsEveryone ? { mentions_everyone: true } : {}),
                        ...(containsUrl ? { contains_url: true } : {}),
                    }, { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } }));
                    // Optimistic append for the sender's own view.
                    // id = server DB row id so the WS dedup check can match it.
                    // content.client_msg_id = safeUUID as secondary dedup key.
                    onChannelMessageSent?.({
                        id: resp.data.id ?? safeUUID,
                        content: msgContent,
                        sender_device_id: deviceId,
                        sender_user_id: resp.data.sender_user_id ?? null,
                        // The server's time, so it sorts where everyone else sees it.
                        timestamp: resp.data?.created_at ? clampFutureTimestamp(String(resp.data.created_at)) : new Date().toISOString(),
                        conversation_id: activeChannel.channel_id,
                    });
                    }
                } else {
                    const safeUUID = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                    // If the entire message is a bare Cipherline invite URL, send it as a
                    // typed `server_invite` so the recipient sees the rich embed.
                    const bareInviteCode = extractInviteCode(wireText.trim());
                    const mentions = bareInviteCode ? [] : extractMentionsFromText(wireText);
                    const content: ClientContent = bareInviteCode
                        ? { client_msg_id: safeUUID, type: 'server_invite', code: bareInviteCode }
                        : { client_msg_id: safeUUID, type: 'text', text: wireText, ...(replyingId ? { reply_to_id: replyingId } : {}), ...(mentions.length > 0 ? { mentions } : {}) };
                    const sentMsg = {
                        id: content.client_msg_id!,
                        content,
                        sender_device_id: deviceId,
                        timestamp: new Date().toISOString(),
                        conversation_id: activeChat.id
                    };
                    if (textOnly) {
                        // Shown (and the composer freed) NOW. The id is the client_msg_id the
                        // post-send append always used, so nothing is swapped when it lands.
                        onMessageSent({ ...sentMsg, send_state: 'sending' });
                        releaseComposerEarly();
                        enqueueDelivery({ kind: 'dm', conversationId: activeChat.id, content });
                    } else {
                        // Its own recipients — never the files' (see takeRecipients above).
                        const devices = await takeRecipients(activeChat.id);
                        // RC-2: address exactly the devices that got wrapped.
                        const { ciphertext_b64, recipient_device_ids } = await trackActivity('send:encrypt', () => encryptAndAddress(JSON.stringify(content), user!.user_id, devices, deviceId ?? undefined));
                        const sendRes = await trackActivity('send:post', () => axios.post(`${API_BASE}/messages/send`, {
                            conversation_id: activeChat.id,
                            recipient_device_ids,
                            envelope_type: 'signal_chat',
                            ciphertext_b64,
                            sent_at_client: new Date().toISOString()
                        }, { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } }));
                        const serverTs = typeof sendRes.data?.received_at_server === 'string' ? sendRes.data.received_at_server as string : undefined;
                        onMessageSent(serverTs ? { ...sentMsg, server_ts: serverTs, timestamp: clampFutureTimestamp(serverTs) } : sentMsg);
                    }
                }

                if (!earlyReleased) {
                    setInputText('');
                    setLoudInput(false);
                    emptySendRef.current = 0;
                    // A send empties the field too, but it isn't second-guessing —
                    // clear the write-then-erase state so it never counts, and so
                    // an erase streak doesn't survive a message actually going out.
                    draftHighWater.current = 0;
                    draftErases.current = 0;
                    attachRemovals.current = 0;
                    setTimeout(() => { if (inputRef.current) inputRef.current.style.height = 'auto'; }, 0);
                    setReplyingId(null);
                    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
                    sendTypingEvent('typing:stop', activeChat.id);
                }
                // Fly the send icon again on success of an AWAITED send (files,
                // an edit), which can take seconds. An instant text send already
                // flew it on submit, in this same tick — a second call there
                // was only swallowed by playIco's busy guard.
                if (!earlyReleased) playIco(sendIcoRef.current, 'play-send');
            }

            // Record successful send for rate-limit sliding window
            if (!earlyReleased) sendTimestamps.current.push(Date.now());

        } catch (err) {
            // Only the awaited flows (edits, files) land here: an instant text
            // send reports its own failure on the message (enqueueDelivery).
            const status = (err as any)?.response?.status as number | undefined;
            if (status === 429) {
                // Server-side rate limit hit — sync the client cooldown so the
                // UI disables the input until the window expires.
                const retryAfterSecs = parseInt(
                    (err as any).response.headers?.['retry-after'] ?? '3', 10
                );
                startCooldown(retryAfterSecs * 1000);
                return;
            }
            const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
            console.error('Failed to send:', errMsg, err);
            // Use the toast system — non-blocking, dismissable, and doesn't
            // freeze further sends behind a modal click. 403s get a friendlier
            // permission-specific message; everything else falls back to a
            // generic "couldn't send" toast.
            const serverMsg = (err as any)?.response?.data?.message as string | undefined;
            if (/No channel key|Channel key for epoch/.test(errMsg)) {
                // e2ee-engine threw before any network call — this device
                // hasn't received the channel's Sender Key yet.
                toast.push({
                    kind: 'error',
                    title: 'Channel key not received yet',
                    message: 'Your device is still waiting for this channel\'s encryption key — it arrives automatically once another member is online.',
                });
                if (activeChannel) onChannelKeyMissing?.(activeChannel.server_id, activeChannel.channel_id);
            } else if (status === 403) {
                toast.push({
                    kind: 'error',
                    title: 'No permission',
                    message: serverMsg || "You don't have permission to perform that action in this channel.",
                });
            } else {
                toast.push({
                    kind: 'error',
                    title: 'Send failed',
                    message: serverMsg || 'Failed to send one or more items.',
                });
            }
        } finally {
            setSending(false);
            // Follow to bottom after sending NEW content — the user expects to
            // see their message. Use the smooth slide (not an instant snap) so
            // the feed glides up to reveal it. The new-message layout effect will
            // also fire and re-target, which is fine — revealNewMessage is
            // idempotent.
            //
            // Skipped entirely for an in-place edit made while scrolled up:
            // revealNewMessage() assigns `el.scrollTop = el.scrollHeight`, and
            // running it here unconditionally was the reported bug. The edited
            // row is held still by the anchor layout effect instead.
            if (!keepViewport && !earlyReleased) {
                followBottomRef.current = true;
                isAtBottomRef.current   = true;
                setShowScrollBtn(false);
                // The new-message layout effect runs the FLIP reveal; this is a
                // fallback in case the optimistic append already committed.
                requestAnimationFrame(() => revealNewMessage());
            }
            setTimeout(() => inputRef.current?.focus(), 0);
        }
    };

    const [pendingCallMode, setPendingCallMode] = useState<boolean | null>(null);

    const handleStartCall = async (videoEnabled: boolean, _e?: React.MouseEvent<HTMLButtonElement>) => {
        if (sending) return;

        if (activeCall && activeCall.conversation_id !== activeChat.id) {
            setPendingCallMode(videoEnabled);
            return;
        }

        await executeStartCall(videoEnabled);
    };

    const executeStartCall = async (videoEnabled: boolean) => {
        if (!bundleReady) { toast.push({ kind: 'info', title: 'Please Wait', message: 'Establishing secure session — please wait a moment' }); return; }
        setSending(true);
        // Optimistic flag — fires Dashboard's panel transition immediately so
        // the user sees the call section appear (with a "Connecting…"
        // placeholder) without waiting for the API round-trip.
        onStartingCallChange?.(true);

        try {
            // Three independent steps, run together rather than back to back
            // (instant join — they used to be two serial round trips plus the
            // key generation in front of the call appearing). The device fetch
            // still happens on every start exactly as before, so one-time
            // prekey consumption is unchanged.
            const [keyR, devicesR, initR] = await Promise.allSettled([
                // 1. Generate local E2EE session key for zero-knowledge LiveKit routing
                generateCallKey(),
                // 2. claim_otp=1: consume a one-time prekey per recipient device (per-message forward secrecy)
                axios.get(`${API_BASE}/conversations/${activeChat.id}/devices?claim_otp=1`, {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'x-device-id': deviceId
                    }
                }),
                // 3. Initiate backend call orchestrator to get LiveKit JWT Auth token
                axios.post(`${API_BASE}/calls/start`,
                    { conversation_id: activeChat.id },
                    { headers: { Authorization: `Bearer ${token}` } }
                ),
            ]);
            if (keyR.status === 'rejected' || devicesR.status === 'rejected' || initR.status === 'rejected') {
                // Run serially, a failed key/device step meant /calls/start was
                // never sent. Now it may already have created a session that is
                // ringing the other side with no key coming — end it.
                if (initR.status === 'fulfilled' && !initR.value.data?.joined && initR.value.data?.session_id) {
                    axios.post(`${API_BASE}/calls/${initR.value.data.session_id}/end`, {}, { headers: { Authorization: `Bearer ${token}` } })
                        .catch(() => { /* best-effort */ });
                }
                throw keyR.status === 'rejected' ? keyR.reason
                    : devicesR.status === 'rejected' ? devicesR.reason
                    : (initR as PromiseRejectedResult).reason;
            }
            const callKey = keyR.value;
            const devicesRes = devicesR.value;
            const initRes = initR.value;

            // If the server merged this start into an EXISTING session
            // (advisory-lock path), the original caller already broadcast a
            // call_key message. Find it in the local messages array rather
            // than reading it from the server (which no longer returns it).
            const joined = !!initRes.data.joined;
            const joinedKey = joined
                ? (messages.find(
                    (m: any) => m.content?.type === 'call_key' && m.content?.call_id === initRes.data.session_id
                  )?.content?.e2ee_key_b64 || '')
                : '';
            const sessionKey = joined ? joinedKey : callKey;

            if (!joined) {
                // 4. Construct E2EE payload text map conveying the AES key
                const content: ClientContent = {
                    type: 'call_key',
                    call_id: initRes.data.session_id,
                    epoch: 1,
                    e2ee_key_b64: callKey,
                    key_id: 'initial',
                    rotates_at: new Date(Date.now() + 10 * 60000).toISOString()
                };
                const callDevices = devicesRes.data as { device_id: string; spk_pub_b64: string }[];
                // RC-2: address exactly the devices that got wrapped.
                const { ciphertext_b64, recipient_device_ids } = await encryptAndAddress(JSON.stringify(content), user!.user_id, callDevices, deviceId ?? undefined);

                // 5. Post Envelope
                await axios.post(`${API_BASE}/messages/send`, {
                    conversation_id: activeChat.id,
                    recipient_device_ids,
                    envelope_type: 'signal_chat',
                    ciphertext_b64,
                    sent_at_client: new Date().toISOString()
                }, {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'x-device-id': deviceId
                    }
                });

                // Must be a UUID: the read-receipt effect sends whatever the
                // LAST message's id is as `last_read_message_id`, and the WS
                // gateway's MessageReadEventDto pins that field to @IsUUID()
                // — a `local-<ts>` id is dropped server-side, silently
                // stalling read receipts for this conversation until the next
                // real message. The four sibling onMessageSent call sites all
                // use content.client_msg_id (a safeUUID); this call_key path
                // has no client_msg_id, so mint one the same way.
                const localMsgId = typeof crypto.randomUUID === 'function'
                    ? crypto.randomUUID()
                    : `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                onMessageSent({
                    id: localMsgId,
                    content: content,
                    sender_device_id: deviceId,
                    timestamp: new Date().toISOString(),
                    conversation_id: activeChat.id
                });
            } else {
                console.log(`[ChatPane] startCall merged into existing session ${initRes.data.session_id} — skipping call_key broadcast.`);
            }

            setIsCallInitiator(!joined);
            setCurrentCallId(initRes.data.session_id);
            setEpoch(1);

            console.log(`[ChatPane] Transitioning to LiveKit call. Session: ${initRes.data.session_id}, URL: ${initRes.data.livekit_url}, Mode: sfu, Joined: ${joined}`);

            if (!initRes.data.livekit_url) {
                toast.push({ kind: 'error', title: 'Call Error', message: 'The server did not return a LiveKit connection URL. Check API configuration.' });
                setSending(false);
                onStartingCallChange?.(false);
                return;
            }

            onCallChange({
                id: initRes.data.session_id,
                conversation_id: activeChat.id,
                livekit_url: initRes.data.livekit_url,
                livekit_token: initRes.data.livekit_token || '',
                e2ee_key_b64: sessionKey,
                videoByDefault: videoEnabled,
                mode: 'sfu',
                isInitiator: !joined
            });

        } catch (err: any) {
            console.error('Failed to start LiveKit session', err);
            const msg = err.response?.data?.message || err.message || 'Unknown error';
            toast.push({ kind: 'error', title: 'Call Failed', message: `Could not start call. Error: ${msg}` });
            // Clear optimistic flag so the panel falls back to out-of-call layout.
            onStartingCallChange?.(false);
        } finally {
            setSending(false);
        }
    };

    // Removed duplicate activeBanner polling; now handled globally in Dashboard.tsx

    const displayMessages = (chatSearch.trim()
        ? messages.filter((m: any) => typeof m.content?.text === 'string' && messageTextMatches(m.content.text, chatSearch))
        : pagination.displayed
    ).filter((m: any) =>
        // Expired/removed attachments vanish entirely rather than leaving a
        // placeholder row. An 'attachment' message carries no text (see the
        // ClientContent union), so hiding the whole row drops nothing else.
        // Known-removed ids are hydrated from localStorage on chat open, so
        // these never even flash before disappearing; a newly-detected 404
        // marks the id and the next render filters it out.
        !(m.content?.type === 'attachment' && removedAttachmentMsgIds.has(m.id)),
    );

    // Preserve scroll position when loading earlier messages (visibleCount grows).
    useLayoutEffect(() => {
        const el = feedRef.current;
        if (el && preservedScrollHeightRef.current !== null) {
            const delta = el.scrollHeight - preservedScrollHeightRef.current;
            if (delta > 0) {
                el.scrollTop += delta;
                // Keep lastKnownScrollTopRef in sync so the follow-bottom effect
                // doesn't misinterpret this programmatic scrollTop increase as a snap.
                lastKnownScrollTopRef.current = el.scrollTop;
            }
            preservedScrollHeightRef.current = null;
        }
    }, [pagination.visibleCount]);

    // ── Hold the edited message still when an in-place edit commits ───────────
    // Preserving raw scrollTop is not enough: the new text can be taller or
    // shorter than the old, which shifts every row below it (and, if the edited
    // row is above the viewport, every row in view). So we anchor on the EDITED
    // ROW itself — captured at submit time in handleSendAll, re-measured here
    // once the new content has laid out — and correct scrollTop by its drift.
    //
    // Declared after the "snap to bottom on every new message" layout effect on
    // purpose: React runs layout effects in declaration order, so this one sees
    // the final scrollTop. It deliberately yields to that effect via the
    // followBottomRef guard — if a peer's message landed in the same commit as
    // the edit, the documented snap-to-bottom wins and the anchor is dropped
    // rather than scrolling the user back up and undoing it.
    useLayoutEffect(() => {
        const anchor = editAnchorRef.current;
        if (!anchor) return;
        editAnchorRef.current = null;               // single-shot
        if (followBottomRef.current) return;        // something legitimately pinned the bottom
        if (pendingScrollMsgIdRef.current) return;  // a jump-to-message owns the viewport
        const el = feedRef.current;
        const row = findMsgRow(anchor.msgId);
        if (!el || !row) return;               // edited row scrolled out of the window / deleted
        const next = correctedScrollTop({
            scrollTop:     el.scrollTop,
            maxScrollTop:  el.scrollHeight - el.clientHeight,
            rowTopBefore:  anchor.rowTop,
            rowTopAfter:   row.getBoundingClientRect().top - el.getBoundingClientRect().top,
        });
        if (next === el.scrollTop) return;
        el.scrollTop = next;
        // Keep the follow-bottom bookkeeping honest about where the feed is, so
        // the next poll's layout effect doesn't read this as the user scrolling.
        lastKnownScrollTopRef.current = el.scrollTop;
    }, [messages]);

    const handleAddReaction = (msgId: string, emoji: string) => {
        const msg = messages.find(m => m.id === msgId);
        const ids = Array.isArray(msg?.reactions?.[emoji]) ? msg!.reactions![emoji] as string[] : [];
        // Shared with the pill's own `hasMine` — see isMyReaction for why
        // these must not be two separate expressions.
        const currentHasIt = isMyReaction(ids, user?.user_id, myDeviceIds);
        // Mark HERE, in the one funnel every add path goes through, not at the
        // individual call sites. Reacting from the EMOJI PICKER creates a
        // brand-new pill, which has no previous render to diff against and so
        // relies entirely on this mark to animate on mount. Marking only at the
        // pill's own onClick meant clicking an existing reaction animated while
        // picking a new one silently did not — the exact asymmetry reported.
        // Context menus and any future entry point get it for free now.
        rxnLog('add/remove ->', `${msgId}:${emoji}`, 'currentHasIt =', currentHasIt);
        markLocalReactionToggle(`${msgId}:${emoji}`);
        handleReact(msgId, emoji, currentHasIt);
    };

    /**
     * Right-click message menu. Builds the item list once, at click time —
     * same pattern as the header's "More options" menu (moreMenu) above, and
     * for the same reason: everything context-aware (ownership, permissions,
     * save/pin state) needs to be current at the moment of the click, not
     * whenever this component last rendered.
     *
     * Gating for Reply/Edit/React/Delete goes through messageMenuGating.ts —
     * the SAME functions the hover action bar effectively encodes inline —
     * so the two menus cannot silently disagree about what's allowed. Pin
     * goes through the shared `canPinInThisChat` computed once above.
     */
    const handleContextMenu = (e: React.MouseEvent, msg: any) => {
        e.preventDefault();
        // Right-click does not reliably move focus on every platform; focus
        // the row explicitly so there's something sane to return focus to
        // when the menu closes (see the isOpen-watching effect above).
        (e.currentTarget as HTMLElement).focus?.();
        msgCtxOpenIdRef.current = msg.id ?? null;

        const isAttachment = msg.content?.type === 'attachment';
        const attId: string | undefined = isAttachment ? msg.content?.attachment_id : undefined;
        const isTextLike = isTextLikeMessageType(msg.content?.type);
        // A KLIPY GIF is a reference, not text or a file — it gets its own
        // copy/save items below (and not "Copy Text").
        const isKlipyGif = msg.content?.type === 'klipy_gif';
        const klipyRef = isKlipyGif ? parseKlipyGifRef(msg.content) : null;
        const isMe = msg.sender_user_id
            ? msg.sender_user_id === user?.user_id
            : myDeviceIds.has(msg.sender_device_id);

        const sentMs = typeof msg.timestamp === 'number' ? msg.timestamp : Date.parse(msg.timestamp || '');
        const sentMsSafe = Number.isFinite(sentMs) ? sentMs : Date.now();
        // Server-saved messages never expire — same rule as the bubble's own
        // countdown (see `isServerSaved` in the message render).
        const isServerSaved = serverSavedIds.includes(msg.id);
        // A pinned message is kept forever by the retention sweep (pin = save),
        // so it must not advertise a deletion time either. The bubble already
        // hides its badge for pinned messages; this is the right-click menu's
        // status row, which used to say "Deletes in N days" about one the
        // sweep would never delete.
        const isPinnedForExpiry = pinnedMsgIds.includes(msg.id);
        const expiryAt = (isServerSaved || isPinnedForExpiry) ? null : (attId
            ? getEffectiveAttachExpiryAt(attId, sentMsSafe)
            : (isTextLike ? getEffectiveMsgExpiryAt(msg.id, sentMsSafe, msg.content?.type === 'klipy_gif') : null));
        const remainingMs = expiryAt ? expiryAt - Date.now() : null;
        let deletionText: string | null = null;
        if (remainingMs !== null) {
            if (remainingMs <= 0) {
                deletionText = 'Deletion pending';
            } else {
                const hrs  = Math.max(1, Math.round(remainingMs / (60 * 60 * 1000)));
                const days = Math.round(hrs / 24);
                deletionText = hrs < 24
                    ? `Deletes in ${hrs} hour${hrs !== 1 ? 's' : ''}`
                    : `Deletes in ${days} day${days !== 1 ? 's' : ''}`;
            }
        }

        const saved = isAttachment
            ? (attId ? isEffectiveAttachSaved(attId) : false)
            : (isTextLike ? isEffectiveMsgSaved(msg.id, msg.content?.type === 'klipy_gif') : false);
        const isPinned = pinnedMsgIds.includes(msg.id);

        const canReact = isServerChannel ? canReactServer : (isFriend || activeChat?.type === 'group');
        const gateCtx = {
            isChannelMessage: isServerChannel,
            canManageMessages,
            isOwnMessage: isMe,
            isTextMessage: msg.content?.type === 'text',
            canCompose: canComposeInThisChat,
            canReact,
        };

        // Groups are joined with a single divider each, and an empty group
        // contributes nothing — keeps the menu from ever showing two dividers
        // in a row just because one group's items were all gated out.
        const groups: ContextMenuItem[][] = [];

        // ── Status row — deletion countdown or saved badge, info only ───────
        if (isServerSaved) {
            groups.push([{ custom: (
                <div className="px-1 py-0.5 text-[11px] text-cl-glow/80 select-none flex items-center gap-1.5">
                    <Archive className="w-3 h-3" strokeWidth={2} />
                    {isPinned ? 'Saved to server · pinned' : 'Saved to server'}
                </div>
            ) }]);
        } else if (deletionText) {
            groups.push([{ custom: (
                <div className="px-1 py-0.5 text-[11px] text-cl-glow/70 select-none">{deletionText}</div>
            ) }]);
        } else if (isPinned) {
            groups.push([{ custom: (
                <div className="px-1 py-0.5 text-[11px] text-cl-lume/70 select-none flex items-center gap-1.5">
                    <Save className="w-3 h-3" strokeWidth={2} />
                    Pinned · kept on this device
                </div>
            ) }]);
        } else if (saved) {
            groups.push([{ custom: (
                <div className="px-1 py-0.5 text-[11px] text-cl-lume/70 select-none flex items-center gap-1.5">
                    <Save className="w-3 h-3" strokeWidth={2} />
                    Saved
                </div>
            ) }]);
        }

        // ── Quick reactions — fixed set + "more" opening the full picker ────
        if (canReactToMessage(gateCtx)) {
            groups.push([{ custom: (
                <div className="flex items-center gap-1">
                    {QUICK_REACTION_EMOJIS.map(emoji => (
                        <button
                            key={emoji}
                            type="button"
                            className="w-7 h-7 flex items-center justify-center rounded-md text-[16px] leading-none hover:bg-white/10 transition-colors"
                            onClick={() => { handleAddReaction(msg.id, emoji); msgContextMenu.close(); }}
                            aria-label={`React with ${emoji}`}
                        >
                            {emoji}
                        </button>
                    ))}
                    <button
                        type="button"
                        className="w-7 h-7 flex items-center justify-center rounded-md text-cl-faint hover:bg-white/10 hover:text-cl-lume transition-colors"
                        onClick={() => {
                            const rowEl = document.getElementById(`msg-${msg.id}`);
                            setShowEmojiPicker(msg.id);
                            setReactionPickerAnchor(rowEl);
                            msgContextMenu.close();
                        }}
                        aria-label="More reactions"
                        title="More reactions"
                    >
                        <SmilePlus className="w-4 h-4" />
                    </button>
                </div>
            ) }]);
        }

        // ── Compose-adjacent actions ─────────────────────────────────────────
        const composeGroup: ContextMenuItem[] = [];
        if (canReplyToMessage(gateCtx)) {
            composeGroup.push({
                icon: <Reply />, label: 'Reply',
                onSelect: () => {
                    setEditingId(null);
                    setInputText('');
                    setReplyingId(msg.id);
                    setTimeout(() => { if (inputRef.current) { inputRef.current.style.height = 'auto'; inputRef.current.focus(); } }, 0);
                },
            });
        }
        if (canEditMessage(gateCtx)) {
            // "↑" hint only when THIS message is what the Up-arrow shortcut
            // would actually open — findLastEditableOwnMessage is the same
            // pure lookup the composer's own Up-arrow handler uses, so the
            // hint can never point at the wrong row.
            const isArrowUpTarget = findLastEditableOwnMessage(messages, {
                myUserId: user?.user_id ?? null,
                myDeviceIds,
            })?.id === msg.id;
            composeGroup.push({
                icon: <Edit2 />, label: 'Edit',
                accessory: isArrowUpTarget ? '↑' : undefined,
                onSelect: () => startEdit(msg),
            });
        }
        if (composeGroup.length) groups.push(composeGroup);

        // ── Copy / attachment utilities ──────────────────────────────────────
        const utilGroup: ContextMenuItem[] = [];
        if (isTextLike && !isKlipyGif) {
            utilGroup.push({
                icon: <Copy />, label: 'Copy Text',
                onSelect: () => {
                    const text = displayTextOf(msg.content) ?? '';
                    writeToClipboard(text).catch(() =>
                        toast.push({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' }));
                },
            });
        }
        if (klipyRef) {
            // The KLIPY media URL — a public KLIPY CDN link, nothing of ours.
            utilGroup.push({
                icon: <LinkIcon />, label: 'Copy GIF link',
                onSelect: () => writeToClipboard(klipyRef.media.url).catch(() =>
                    toast.push({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' })),
            });
            const klipyFav = findKlipyFavorite(loadFavorites(), klipyRef.slug);
            utilGroup.push({
                icon: <Bookmark />, label: klipyFav ? 'Remove from favorites' : 'Favorite GIF',
                onSelect: () => {
                    try {
                        if (klipyFav) void removeFavorite(klipyFav.id);
                        else addKlipyFavorite(klipyRef); // a reference only — no bytes
                    } catch (err) {
                        console.warn('[ChatPane] KLIPY GIF save failed', (err as Error)?.message);
                    }
                },
            });
        }
        utilGroup.push({
            icon: <LinkIcon />, label: 'Copy Message ID',
            onSelect: () => writeToClipboard(msg.id).catch(() =>
                toast.push({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' })),
        });
        if (isAttachment && attId && objectUrls[msg.id]) {
            utilGroup.push({
                icon: <Download />, label: 'Download',
                onSelect: () => downloadAttachment(msg),
            });
        }
        groups.push(utilGroup);

        // ── Author ────────────────────────────────────────────────────────────
        // Same target as clicking the sender's name in the header: your own
        // profile for "You", the sender's for anyone else.
        const nameTargetId = isMe ? (user?.user_id ?? null) : (msg.sender_user_id ?? null);
        if (nameTargetId && (openProfileCtx || onOpenProfile)) {
            groups.push([{
                icon: <User />, label: 'View Profile',
                onSelect: () => {
                    if (openProfileCtx) openProfileCtx(nameTargetId, { x: e.clientX, y: e.clientY });
                    else onOpenProfile!(nameTargetId);
                },
            }]);
        }

        // ── Pin / Save ────────────────────────────────────────────────────────
        const pinSaveGroup: ContextMenuItem[] = [];
        if ((isTextLike || (isAttachment && attId)) && canPinInThisChat) {
            pinSaveGroup.push({
                icon: <Pin />, label: isPinned ? 'Unpin' : 'Pin',
                onSelect: () => {
                    if (isPinned) {
                        onUnpinMessage(msg.id);
                    } else {
                        onPinMessage(msg.id);
                        if (!activeChannel) {
                            if (isTextLike) retention.saveMessage(msg.id);
                            else if (attId) { retention.saveAttachment(attId); ensureAttachmentCached(msg); }
                        }
                    }
                },
            });
        }
        // Save to server — its own action, next to Pin (SAVE_MESSAGES; channel
        // only). A pinned message is always saved and the API refuses to
        // unsave it, so it shows a disabled row that says why.
        const saveAction = (isTextLike || (isAttachment && attId)) ? serverSaveActionFor(msg.id) : 'hidden';
        if (saveAction === 'save') {
            pinSaveGroup.push({
                icon: <Archive />, label: 'Save to server',
                onSelect: () => onServerSaveMessage?.(msg.id),
            });
        } else if (saveAction === 'unsave') {
            pinSaveGroup.push({
                icon: <Archive />, label: 'Remove from server',
                onSelect: () => onServerUnsaveMessage?.(msg.id),
            });
        } else if (saveAction === 'pinned') {
            pinSaveGroup.push({
                icon: <Archive />, label: 'Saved (pinned)', accessory: 'Unpin first',
                disabled: true,
                onSelect: () => { /* disabled — unpin first */ },
            });
        }
        if (isTextLike || (isAttachment && attId)) {
            pinSaveGroup.push({
                icon: <Save />, label: saved ? 'Remove from my saves' : 'Save for me',
                onSelect: () => {
                    if (isTextLike) {
                        if (saved) retention.unsaveMessage(msg.id);
                        else retention.saveMessage(msg.id);
                    } else if (attId) {
                        if (saved) { retention.unsaveAttachment(attId); deleteEncryptedAttachment(attId); }
                        else { retention.saveAttachment(attId); ensureAttachmentCached(msg); }
                    }
                },
            });
        }
        if (pinSaveGroup.length) groups.push(pinSaveGroup);

        // ── Report — others' messages only; server also rejects self-reports ──
        if (onReport && (isTextLike || (isAttachment && attId)) && msg.sender_user_id && msg.sender_user_id !== myUserId) {
            const resolvedName = (activeChannel && serverMemberNicknames?.[msg.sender_user_id])
                ?? deviceToUsername[msg.sender_device_id]
                ?? userIdToUsername[msg.sender_user_id]
                ?? 'this user';
            const snippet = isKlipyGif
                ? `[KLIPY GIF${klipyRef?.title ? `: ${klipyRef.title}` : ''}${klipyRef ? ` — ${klipyRef.media.url}` : ''}]`
                : isTextLike
                ? (msg.content?.text ?? '')
                : `[Attachment: ${msg.content?.filename ?? 'file'}, sent ${new Date(sentMsSafe).toLocaleString()}]`;
            groups.push([{
                icon: <Flag />, label: 'Report Message', danger: true,
                onSelect: () => onReport(msg.sender_user_id, resolvedName, snippet),
            }]);
        }

        // ── Delete — destructive, always last ────────────────────────────────
        if (canDeleteMessage(gateCtx)) {
            groups.push([{
                icon: <Trash2 />, label: isMe ? 'Delete' : 'Delete (moderator)', danger: true,
                onSelect: () => {
                    const activation: DeleteActivation = { entryPoint: 'contextmenu', shiftKey: false };
                    requestDelete(msg, activation, isMe);
                },
            }]);
        }

        const items: ContextMenuItem[] = [];
        groups.filter(g => g.length > 0).forEach((group, i) => {
            if (i > 0) items.push({ divider: true });
            items.push(...group);
        });

        msgContextMenu.open(e, items);
    };

    const downloadAttachment = (msg: any) => {
        const url = objectUrls[msg.id];
        if (!url) return;
        const a = document.createElement('a');
        a.href = url;
        a.download = msg.content?.filename || 'download';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    // ── Message rows skip re-rendering when nothing they draw changed ──────────
    // PERF: this pane re-renders on every composer keystroke, on the 160 ms
    // hover timer, and on every Dashboard state change (presence, typing,
    // unread counts). Each of those used to re-run the whole row body for every
    // row on screen — mention/emoji/URL parsing, timestamp formatting, reply
    // lookups — even though no row had changed. Each row is now a MemoRow whose
    // deps are: the message, its neighbours (grouping/date divider), its own
    // per-row flags, and `rowGlobals` below — every pane-wide value a row
    // reads while rendering.
    //
    // A skipped row keeps its handlers from its last render. Handlers that act
    // on state OUTSIDE those deps (the context menu, edit, delete, reactions,
    // jump-to-reply, decrypt retries, parent callbacks, retention writes) are
    // shadowed inside the row by the stable stand-ins below, which always call
    // the latest committed version. Render-time helpers (isEffectiveMsgSaved,
    // expiry, serverSaveActionFor, ...) are used directly: everything they read
    // is in `rowGlobals`, so a change re-renders the row with fresh ones.
    const rowLive = useLiveCallbacks({
        decryptManual, cancelDecrypt, retryDecrypt, ensureAttachmentCached,
        requestDelete, startEdit, handleAddReaction, handleContextMenu, jumpToMessage, handleMentionClick,
        onKeyChangeResolved, onPinMessage, onUnpinMessage, onServerSaveMessage, onServerUnsaveMessage,
        onOpenProfile, onInviteJoin, onInviteCodeClick,
        saveMessage: retention.saveMessage, unsaveMessage: retention.unsaveMessage,
        saveAttachment: retention.saveAttachment, unsaveAttachment: retention.unsaveAttachment,
    });
    // Outer names for the two optional props whose PRESENCE a row reads at
    // render time (the row shadows the plain names with stand-ins).
    const onOpenProfileProp = onOpenProfile;
    const onInviteCodeClickProp = onInviteCodeClick;
    // Props Dashboard rebuilds on every render (`x || []`, `?? {}`) are kept
    // at one identity while their contents are equal.
    const stUser = useShallowStable(user);
    const stServerEmojis = useShallowStable(serverEmojis);
    const stActiveChat = useShallowStable(activeChat);
    const stKeyChangedSenders = useShallowStable(keyChangedSenders);
    const stSenderWarnings = useShallowStable(senderWarnings);
    const stServerSavedIds = useShallowStable(serverSavedIds);
    const stActiveChannel = useShallowStable(activeChannel);
    const stMemberRoleColors = useShallowStable(memberRoleColors);
    const stServerMemberNicknames = useShallowStable(serverMemberNicknames);
    const stServers = useShallowStable(servers);
    // The retention policy object is rebuilt with fresh id arrays whenever any
    // channel's messages change (Dashboard's channelRetention) — compare one
    // level deeper.
    const stRetentionPolicy = useShallowStable(retention.policy, 2);
    const hasServerSave = !!onServerSaveMessage;
    const hasServerUnsave = !!onServerUnsaveMessage;
    const hasOpenProfile = !!onOpenProfile;
    const hasInviteCodeClick = !!onInviteCodeClick;
    const hasKeyChangeResolved = !!onKeyChangeResolved;
    // `nowTick` (30 s) refreshes the time-relative strings a row draws
    // ("Today at", expiry countdowns) — the reason that ticker exists.
    const rowGlobals = [
        token, stUser, stServerEmojis, serverEmojisLoading, stActiveChat, stKeyChangedSenders, stSenderWarnings,
        stablePinnedMsgIds, stServerSavedIds, stActiveChannel, stMemberRoleColors, stServerMemberNicknames,
        convType, stServers, showReadReceipts, myUserId, myDeviceIds, deviceToUsername, deviceToAvatar,
        userIdToUsername, userIdToAvatar, isFriend, myServerRoleIds, openProfileCtx, isServerChannel,
        noServerEmojiContext, canReactServer, canManageMessages, canPinInThisChat, canSaveMessages,
        hasServerSave, hasServerUnsave, hasOpenProfile, hasInviteCodeClick, hasKeyChangeResolved,
        stRetentionPolicy, channelMessageRetention, channelAttachmentRetention, resolveEmoji,
        mentionedUserIsKnown, nowTick,
    ];
    // Reply quotes: one id/client-id index per `messages` change instead of
    // two linear scans of the whole conversation per reply row per render.
    const replyLookup = useMemo(() => {
        const byId = new Map<string, (typeof messages)[number]>();
        const byClientId = new Map<string, (typeof messages)[number]>();
        for (const m of messages) {
            if (m?.id != null && !byId.has(m.id)) byId.set(m.id, m);
            const cid = m?.content?.client_msg_id;
            if (cid != null && !byClientId.has(cid)) byClientId.set(cid, m);
        }
        return { byId, byClientId };
    }, [messages]);

    return (
        <div
            className="flex flex-col h-full relative overflow-x-hidden min-w-0 w-full"
            style={{ background: 'linear-gradient(180deg, var(--cl-deep) 0%, var(--cl-abyss) 100%)' }}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
        >
            {/* One-time "you can save a message" coach mark — first message you
                receive in a one-to-one DM that auto-deletes. Renders nothing
                otherwise (see SaveCoachMark / utils/saveCoachMark). */}
            <SaveCoachMark
                userId={user?.user_id}
                accountCreatedAt={user?.created_at}
                isOneToOneDm={!activeChannel && activeChat.type === 'dm' && !isSelfChat}
                retention={resolveChatMessageRetention(retention.policy, convType, channelMessageRetention)}
                messages={messages}
                myUserId={myUserId || user?.user_id}
                isSaved={(id) => isEffectiveMsgSaved(id)}
                onSave={(id) => retention.saveMessage(id)}
                windowActive={windowAttended}
            />
            {/* Drag-and-drop overlay */}
            {isDragOver && (
                <div className="absolute inset-0 z-[100] flex items-center justify-center">
                    <div className="absolute inset-0 bg-cl-lume/10 backdrop-blur-[1px] border-2 border-dashed border-cl-lume/60 rounded-xl" />
                    <div className="relative flex flex-col items-center gap-2 text-cl-lume">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.8 }}>
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                        <span className="text-[15px] font-semibold" style={{ opacity: 0.85 }}>Drop to attach</span>
                    </div>
                </div>
            )}
            {/* Chat Header — three modes:
                  - Server channel: Hash/emoji icon + name + truncated topic
                                    (click topic for full-text popup)
                  - DM: avatar + name + "Playing X" if applicable
                  - Group: avatar + name + "Group Chat" subtitle */}
            <div className="h-[54px] border-b border-cl-border bg-cl-deep flex flex-row items-center justify-between px-4 shrink-0 z-20 w-full">
                {activeChannel ? (
                    /* ── Server channel header ─────────────────────────── */
                    <div className="flex items-center gap-3 max-w-[60%] min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-cl-lume/10 border border-cl-lume/20 flex items-center justify-center shrink-0">
                            {activeChannel.icon_name ? (
                                <ChannelIconRenderer name={activeChannel.icon_name} size={20} className="text-cl-lume" />
                            ) : activeChannel.icon_emoji ? (
                                <span className="text-[18px] leading-none">{activeChannel.icon_emoji}</span>
                            ) : (
                                <Hash className="w-5 h-5 text-cl-lume" />
                            )}
                        </div>
                        <div className="flex flex-col gap-0 min-w-0">
                            <h3 className="text-[var(--cl-text)] text-[15px] truncate leading-tight m-0 font-display">
                                {activeChannel.name}
                            </h3>
                            {activeChannel.topic ? (
                                /* Deliberately a plain button, not ClButton. The kit's
                                   `.cap` hard-sets 15px/800 weight, 13px 25px padding, a
                                   surface fill and a 1.5px ring — and ClButton puts the
                                   `style` prop on its OUTER wrapper, so none of that can
                                   be overridden from here. The topic rendered as a chunky
                                   bubble that was bolder and larger than the channel name
                                   above it, inverting the hierarchy. */
                                <button
                                    type="button"
                                    onClick={() => setShowTopicDialog(true)}
                                    title={activeChannel.topic}
                                    className="cl-chan-topic"
                                >
                                    {activeChannel.topic}
                                </button>
                            ) : null}
                        </div>
                    </div>
                ) : (
                    /* ── DM / Group header ─────────────────────────────── */
                    <div
                        className={`flex items-center gap-3 max-w-[50%] ${activeChat.type === 'dm' && activeChat.other_user_id && (openProfileCtx || onOpenProfile) ? 'cursor-pointer group/hdr' : ''}`}
                        onClick={(e) => {
                            if (activeChat.type === 'dm' && activeChat.other_user_id) {
                                if (openProfileCtx) openProfileCtx(activeChat.other_user_id, { x: e.clientX, y: e.clientY });
                                else onOpenProfile?.(activeChat.other_user_id);
                            }
                        }}
                    >
                        <EncryptedAvatar
                            attachmentId={activeChat.avatar_url}
                            userId={activeChat.type === 'dm' ? activeChat.other_user_id : null}
                            isGroup={activeChat.type !== 'dm'}
                            token={token}
                            className="w-8 h-8 shrink-0"
                            fallbackSize={16}
                        />
                        <div className="flex flex-col gap-0">
                            <h3 className={`text-[var(--cl-text)] text-[15.5px] truncate leading-tight m-0 font-display ${activeChat.type === 'dm' && onOpenProfile ? 'group-hover/hdr:text-cl-lume transition-colors' : ''}`} style={{ fontWeight: 600 }}>
                                {activeChat.title || 'Unknown Chat'}
                            </h3>
                            {(() => {
                                const partnerStatus = activeChat.type === 'dm' && activeChat.other_user_id
                                    ? (friendStatuses?.[activeChat.other_user_id]?.status ?? 'offline')
                                    : 'offline';
                                const dmGame = activeChat.type === 'dm' && activeChat.other_user_id && partnerStatus !== 'offline'
                                    ? (friendStatuses?.[activeChat.other_user_id]?.current_game ?? null)
                                    : null;
                                if (dmGame) {
                                    return (
                                        <p className="text-[12px] text-cl-muted truncate leading-tight m-0 mt-0.5">
                                            Playing {dmGame}
                                        </p>
                                    );
                                }
                                if (activeChat.type !== 'dm') {
                                    return (
                                        <p className="text-[12px] text-cl-faint truncate leading-tight flex items-center gap-1.5 m-0 mt-0.5">
                                            <span className="w-1.5 h-1.5 rounded-full bg-cl-lume/70"></span>
                                            Group Chat
                                        </p>
                                    );
                                }
                                return null;
                            })()}
                        </div>
                        {/* Encryption lock — DS chat header LockStatus (lume).
                            Poking it repeatedly earns the escalation pool. */}
                        <span
                            className="shrink-0 flex cursor-pointer"
                            style={{ color: 'var(--cl-lume)' }}
                            title="End-to-end encrypted"
                            onClick={pokeLock}
                        >
                            <Lock size={13} strokeWidth={2.4} />
                        </span>
                        {lockMsg && (
                            <span className="text-[11px] font-bold text-cl-lume fade-enter select-none shrink-0">
                                {lockMsg}
                            </span>
                        )}
                    </div>
                )}

                <div className="cl-hdr-actions flex items-center gap-0.5 relative">
                    {/* Phone/Video are DM/group-only — for server channels, calls
                        happen by joining a voice channel from the right-hand panel. */}
                    {!activeChannel && affordances.calls && (
                        <>
                            <ClButton
                                icon
                                onClick={(e: React.MouseEvent<HTMLButtonElement>) => handleStartCall(false, e)}
                                disabled={sending || (!isFriend && activeChat?.type === 'dm')}
                                tooltip={!isFriend && activeChat?.type === 'dm' ? 'You must be friends to call' : 'Start Audio Call'}
                                variant="ghost"
                            >
                                <Phone className="w-5 h-5" />
                            </ClButton>
                            <ClButton
                                icon
                                onClick={() => {
                                    if (isFreeTier) { promptUpgrade('video_call'); return; }
                                    handleStartCall(true);
                                }}
                                disabled={sending || (!isFriend && activeChat?.type === 'dm')}
                                tooltip={
                                    !isFriend && activeChat?.type === 'dm'
                                        ? 'You must be friends to call'
                                        : isFreeTier
                                        ? 'Video calls are a Pro feature — upgrade for $2.50/mo + tax'
                                        : 'Start Video Call'
                                }
                                variant="ghost"
                                style={isFreeTier ? { opacity: 0.55 } : undefined}
                            >
                                <Video className="w-5 h-5" />
                            </ClButton>
                            {activeChat?.type === 'dm' && activeChat?.other_user_id && (() => {
                                // Same badge, same vocabulary, same tooltips as the incoming-call
                                // screen — see `contactTrust.ts`. This used to roll its own
                                // three-way icon/colour/tooltip off `getVerificationState`
                                // alone, which is how the header shield and the call badge
                                // came to disagree: a contact with 2 of 4 devices verified
                                // read as a flat "unverified" here while the call screen
                                // showed "Partly verified (2/4)". One derivation, one answer.
                                // Pins PLUS any device the directory publishes that the
                                // pins never recorded, counted as unverified. Without it
                                // a device added after verification that never sends
                                // (the "ghost device", docs/ghost-device.md) left this
                                // shield green while every send was wrapped to it.
                                const devices = contactTrustDevices(myUserId, activeChat.other_user_id);
                                const trust = deriveContactTrust({
                                    // The banner's warning state is per-conversation and already
                                    // carries the specific verdict; reuse it rather than
                                    // re-deriving a second opinion from the same store.
                                    verdict: keyChangedSenders?.has(activeChat.other_user_id)
                                        ? (senderWarnings[activeChat.other_user_id] ?? 'key_changed')
                                        : null,
                                    devices,
                                });
                                return (
                                    <TrustBadge
                                        trust={trust}
                                        displayName={activeChat.title || 'This contact'}
                                        size={20}
                                        onClick={() => setSafetyModalOpen(true)}
                                        className="px-2"
                                    />
                                );
                            })()}
                        </>
                    )}

                    {pendingCallMode !== null && (
                        <div className="absolute top-12 right-12 w-64 bg-cl-surface border border-white/10 rounded-xl shadow-2xl p-4 z-50 fade-pop-enter">
                            <h3 className="text-sm font-bold text-white mb-2 m-0">Leave Current Call?</h3>
                            <p className="text-xs text-cl-muted mb-4 m-0 leading-tight">You are already in an active call. Do you want to leave it and start a new call here?</p>
                            {/* ClConfirm's canonical button row — right-aligned
                                intrinsic-width sm buttons, matching the Dashboard
                                twin and every other confirm in the app. */}
                            <div className="flex items-center justify-end" style={{ gap: 12 }}>
                                <ClButton size="sm" variant="ghost" onClick={() => setPendingCallMode(null)}>Cancel</ClButton>
                                <ClButton size="sm" onClick={() => {
                                    const vid = pendingCallMode;
                                    setPendingCallMode(null);
                                    executeStartCall(vid);
                                }}>Leave &amp; Call</ClButton>
                            </div>
                        </div>
                    )}

                    {/* Server channels get a direct Pin button instead of the 3-dot
                        menu — the only server-specific action in the menu was pins,
                        so a dedicated button is cleaner and removes the dead DM/group
                        items that would otherwise appear. */}
                    {activeChannel ? (
                        <ClButton
                            icon
                            onClick={onTogglePinnedSidebar}
                            tooltip={pinnedSidebarExpanded ? 'Hide pinned messages' : 'Pinned messages'}
                            variant={pinnedSidebarExpanded ? 'primary' : 'ghost'}
                            active={pinnedSidebarExpanded}
                        >
                            <Pin className="w-5 h-5" />
                        </ClButton>
                    ) : (
                    /* 3-dot More menu — items built fresh on each open so all
                        the context-aware state (friendStatus, isMuted, pin counts,
                        sentFriendRequests) is current. The menu portals to body via
                        useContextMenu, so it's never clipped by the chat-pane's
                        overflow-hidden ancestors. */
                    <ClButton
                        icon
                        variant="ghost"
                        active={moreMenu.isOpen}
                        onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                            const otherId = activeChat.type === 'dm' ? activeChat.other_user_id : null;
                            const items: import('./primitives/ContextMenu').ContextMenuItem[] = [];

                            // Pinned Messages — in header menu for DMs/groups
                            items.push({
                                icon: <Pin />,
                                label: 'Pinned Messages',
                                accessory: pinnedMsgIds.length > 0 ? `${pinnedMsgIds.length}` : undefined,
                                onSelect: () => {
                                    if (activeCall) onOpenPinnedCallOverlay();
                                    else onTogglePinnedSidebar();
                                },
                            });
                            items.push({ divider: true });

                            if (activeChat.type === 'group') {
                                items.push({ icon: <Settings />, label: 'Manage Group', onSelect: () => setGroupSettingsOpen(true) });
                                items.push({
                                    icon: notifPref === 'none' ? <BellOff /> : notifPref === 'mentions' ? <BellDot /> : <Bell />,
                                    label: 'Notifications',
                                    onSelect: () => {},
                                    submenu: [
                                        { icon: <Bell />, label: 'All Messages', checked: notifPref === 'all', onSelect: () => { onSetNotifMode?.('all'); } },
                                        { icon: <BellDot />, label: '@Mentions Only', checked: notifPref === 'mentions', onSelect: () => { onSetNotifMode?.('mentions'); } },
                                        { icon: <BellOff />, label: 'Off', checked: notifPref === 'none', onSelect: () => { onSetNotifMode?.('none'); } },
                                    ],
                                });
                                items.push({ divider: true });
                                items.push({
                                    icon: <LogOut />, label: 'Leave Group', danger: true,
                                    onSelect: () => onCloseChatRequest?.(),
                                });
                            } else if (isSelfChat) {
                                // Your own chat: no profile / friend / block / report / group-add /
                                // notification entries — only pins (above) and closing it.
                                items.push({
                                    icon: <X />, label: 'Close DM',
                                    onSelect: () => onCloseChatRequest?.(),
                                });
                            } else {
                                // DM — branches by friend status
                                if (friendStatus === 'accepted') {
                                    items.push({
                                        icon: <User />, label: 'View Profile',
                                        onSelect: () => {
                                            if (otherId) {
                                                if (openProfileCtx) openProfileCtx(otherId, { x: e.clientX, y: e.clientY });
                                                else onOpenProfile?.(otherId);
                                            }
                                        },
                                    });
                                    items.push({ icon: <Users />, label: 'Add to Group Chat', onSelect: () => onAddToGroup?.() });
                                    items.push({ divider: true });
                                    items.push({
                                        icon: <UserMinus />, label: 'Remove Friend',
                                        onSelect: () => {
                                            if (!otherId) return;
                                            setConfirmDialog({
                                                title: 'Remove Friend',
                                                message: `Remove ${activeChat.title} as a friend? You'll no longer be able to send messages, but your chat history will remain visible.`,
                                                confirmLabel: 'Remove', danger: true,
                                                onConfirm: async () => {
                                                    setConfirmDialog(null);
                                                    try {
                                                        await axios.delete(`${API_BASE}/friends/${otherId}`, { headers: { Authorization: `Bearer ${token}` } });
                                                        setIsFriend(false);
                                                        setFriendStatus('none');
                                                    } catch (err: any) { toast.push({ kind: 'error', title: 'Remove Failed', message: err?.response?.data?.message || 'Failed to remove friend.' }); }
                                                },
                                            });
                                        },
                                    });
                                } else if (friendStatus === 'blocked') {
                                    items.push({
                                        icon: <Ban />, label: 'Unblock',
                                        onSelect: async () => {
                                            if (!otherId) return;
                                            try {
                                                await axios.post(`${API_BASE}/friends/unblock`, { target_id: otherId }, { headers: { Authorization: `Bearer ${token}` } });
                                                setFriendStatus('none');
                                            } catch { toast.push({ kind: 'error', title: 'Unblock Failed', message: 'Failed to unblock' }); }
                                        },
                                    });
                                    if (otherId && sentFriendRequests.has(otherId)) {
                                        items.push({ icon: <User />, label: 'Pending…', disabled: true, onSelect: () => {} });
                                    } else {
                                        items.push({
                                            icon: <UserPlus />, label: 'Add Friend',
                                            onSelect: async () => {
                                                if (!otherId) return;
                                                try {
                                                    await axios.post(`${API_BASE}/friends/unblock`, { target_id: otherId }, { headers: { Authorization: `Bearer ${token}` } });
                                                    await axios.post(`${API_BASE}/friends/request`, { target_username: activeChat.title || 'user' }, { headers: { Authorization: `Bearer ${token}` } });
                                                    nudges.notify({ kind: 'friend_request_sent' });
                                                    setSentFriendRequests(prev => new Set(prev).add(otherId));
                                                    setFriendStatus('pending');
                                                } catch { /* non-fatal */ }
                                            },
                                        });
                                    }
                                } else if (friendStatus === 'pending' || (otherId && sentFriendRequests.has(otherId))) {
                                    items.push({ icon: <User />, label: 'Pending…', disabled: true, onSelect: () => {} });
                                } else {
                                    items.push({
                                        icon: <UserPlus />, label: 'Add Friend',
                                        onSelect: async () => {
                                            if (!otherId) return;
                                            try {
                                                await axios.post(`${API_BASE}/friends/request`, { target_username: activeChat.title || 'user' }, { headers: { Authorization: `Bearer ${token}` } });
                                                nudges.notify({ kind: 'friend_request_sent' });
                                                setSentFriendRequests(prev => new Set(prev).add(otherId));
                                                setFriendStatus('pending');
                                            } catch { /* non-fatal */ }
                                        },
                                    });
                                }

                                if (friendStatus !== 'blocked') {
                                    items.push({
                                        icon: <Ban />, label: 'Block', danger: true,
                                        onSelect: () => {
                                            if (!otherId) return;
                                            setConfirmDialog({
                                                title: 'Block User',
                                                message: `Are you sure you want to block ${activeChat.title}? You will no longer receive messages from them.`,
                                                confirmLabel: 'Block', danger: true,
                                                onConfirm: async () => {
                                                    setConfirmDialog(null);
                                                    try {
                                                        await axios.post(`${API_BASE}/friends/block`, { target_id: otherId }, { headers: { Authorization: `Bearer ${token}` } });
                                                        setIsFriend(false);
                                                        setFriendStatus('blocked');
                                                    } catch (err: any) { toast.push({ kind: 'error', title: 'Block Failed', message: err?.response?.data?.message || 'Failed to block user.' }); }
                                                },
                                            });
                                        },
                                    });
                                }

                                // Report — independent of block status (you can still
                                // report someone you've already blocked) and independent
                                // of friend status. This is the DM's own "..." menu, not
                                // a specific message, so there's no snippet to attach —
                                // same as every other user-level (not message-level)
                                // report entry point in the app.
                                if (onReport && otherId) {
                                    items.push({
                                        icon: <Flag />, label: 'Report User', danger: true,
                                        onSelect: () => onReport(otherId, activeChat.title || 'this user'),
                                    });
                                }

                                items.push({
                                    icon: notifPref === 'none' ? <BellOff /> : notifPref === 'mentions' ? <BellDot /> : <Bell />,
                                    label: 'Notifications',
                                    onSelect: () => {},
                                    submenu: [
                                        { icon: <Bell />, label: 'All Messages', checked: notifPref === 'all', onSelect: () => { onSetNotifMode?.('all'); } },
                                        { icon: <BellDot />, label: '@Mentions Only', checked: notifPref === 'mentions', onSelect: () => { onSetNotifMode?.('mentions'); } },
                                        { icon: <BellOff />, label: 'Off', checked: notifPref === 'none', onSelect: () => { onSetNotifMode?.('none'); } },
                                    ],
                                });
                                items.push({ divider: true });
                                items.push({
                                    icon: <X />, label: 'Close DM',
                                    onSelect: () => onCloseChatRequest?.(),
                                });
                            }

                            moreMenu.open(e, items, activeChat.title);
                        }}
                        tooltip="More options"
                    >
                        <MoreVertical className="w-5 h-5" />
                    </ClButton>
                    )}
                </div>
            </div>

            {/* Portal target for the More menu — rendered at the end so it
                doesn't get clipped by chat-pane overflow. */}
            {moreMenu.menu}

            {/* Channel topic full-text popup — only ever shown when activeChannel
                is set and the topic is non-empty (the trigger button is gated
                the same way). */}
            {showTopicDialog && activeChannel && activeChannel.topic && (
                <ChannelTopicDialog
                    channelName={activeChannel.name}
                    topic={activeChannel.topic}
                    iconEmoji={activeChannel.icon_emoji}
                    iconName={activeChannel.icon_name}
                    onClose={() => setShowTopicDialog(false)}
                />
            )}

            {/* Incoming Call Banner removed - Handled globally in Dashboard */}

            {/* C2: identity-key-change warning (warn-but-show). Surfaced when a DM
                contact's pinned identity key changed since first-seen.
                Compact pill + hover/focus tooltip — see UnverifiedDeviceBanner
                for why this isn't the paragraph-sized version it used to be. */}
            {activeChat?.type === 'dm' && activeChat?.other_user_id && keyChangedSenders?.has(activeChat.other_user_id) && (() => {
                // F1: the verdict decides the wording. 'unattributed' and
                // 'unrecognized_verified' are NOT "they probably reinstalled" —
                // they are the shapes a sender-identity forgery actually takes,
                // and the copy must not talk the user out of noticing.
                const verdict: SenderVerdict = senderWarnings[activeChat.other_user_id!] ?? 'key_changed';
                const name = activeChat.title || 'This contact';
                return (
                    <UnverifiedDeviceBanner
                        verdict={verdict}
                        displayName={name}
                        onVerify={() => setSafetyModalOpen(true)}
                    />
                );
            })()}

            {/* Messages Scroll Area */}
            <div
                ref={feedRef}
                onScroll={() => {
                    const el = feedRef.current;
                    // Sync lastKnownScrollTopRef on every scroll so the layout effect
                    // comparison stays accurate between React commit phases.
                    if (el) lastKnownScrollTopRef.current = el.scrollTop;
                    checkBottom();
                    if (el && el.scrollTop < 80 && !chatSearch.trim()) {
                        if (pagination.hasMore) {
                            preservedScrollHeightRef.current = el.scrollHeight;
                            pagination.loadMore();
                        } else if (canLoadOlderFromServer) {
                            preservedScrollHeightRef.current = el.scrollHeight;
                            void fetchOlderFromServer();
                        }
                    }
                }}
                className="flex-1 overflow-y-auto overflow-x-hidden pl-6 pr-2 py-4 flex flex-col min-w-0"
                // Disable Chromium scroll anchoring: it auto-adjusts scrollTop the
                // instant a row is inserted, which steals the distance our slide-up
                // animation needs (start would already equal the new bottom).
                style={{ overflowAnchor: 'none' }}
            >
                {/* Pagination: "load earlier" indicator at the top of the feed */}
                {pagination.hasMore && !chatSearch.trim() && (
                    <ClButton
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                            const el = feedRef.current;
                            if (el) preservedScrollHeightRef.current = el.scrollHeight;
                            pagination.loadMore();
                        }}
                        style={{ alignSelf: 'center', marginBottom: 12, fontSize: 11, borderRadius: 999, padding: '6px 12px' }}
                    >
                        Load earlier messages ({messages.length - pagination.visibleCount} older)
                    </ClButton>
                )}

                {/* Local window exhausted — go to the server for older history.
                    Server-saved messages are exempt from retention, so they're
                    usually the oldest rows in the channel and only reachable
                    this way. */}
                {!pagination.hasMore && canLoadOlderFromServer && !chatSearch.trim() && (
                    <ClButton
                        variant="ghost"
                        size="sm"
                        loading={loadingOlder}
                        onClick={() => {
                            const el = feedRef.current;
                            if (el) preservedScrollHeightRef.current = el.scrollHeight;
                            void fetchOlderFromServer();
                        }}
                        style={{ alignSelf: 'center', marginBottom: 12, fontSize: 11, borderRadius: 999, padding: '6px 12px' }}
                    >
                        {loadingOlder ? 'Loading…' : 'Load older history'}
                    </ClButton>
                )}

                <div ref={contentRef} className="flex flex-col flex-1" style={{ willChange: 'transform' }}>
                {/* Messages already in hand ALWAYS win over the loading gate, even
                    while membersFetching/chatLoading/messagesFetching is still true.
                    This pane remounts on every conversation switch (keyed by
                    activeChat.id / activeChannel.channel_id in Dashboard), which
                    resets chatLoading's "first fetch" ref — so revisiting an
                    already-loaded, already-cached conversation re-ran the
                    device/username fetch and re-armed this loading gate every
                    single time, hiding the already-rendered message list behind
                    the spinner for its duration and back again: the reported
                    "messages, then nothing, then back" flash. The lazy
                    username/avatar resolver effect elsewhere in this file already
                    patches in any names that arrive after this paint, so there's
                    no correctness reason to hide content we already have just
                    because a supplementary fetch hasn't resolved yet. */}
                {messages.length === 0 ? (
                    (membersFetching || chatLoading || messagesFetching) ? (
                        <div className="flex-1 flex items-center justify-center">
                            <div className="w-5 h-5 border-2 border-white/20 border-t-primary rounded-full animate-spin" />
                        </div>
                    ) : (
                        // The app's highest-traffic empty surface — every brand-new
                        // DM and every fresh channel lands here. It used to be a
                        // grey padlock over "Messages are end-to-end encrypted.";
                        // the fact moves into the subline and the mascot carries
                        // the moment. No CTA: the composer is directly below and
                        // already focused, so a button would be a second route to
                        // one keystroke away.
                        <div className="flex-1 flex items-center justify-center">
                            <MascotEmpty size={56} {...emptyChatCopy} />
                        </div>
                    )
                ) : (
                    // mt-auto sticks a short message list to the BOTTOM (just above the
                    // composer) so a near-empty chat doesn't cling to the top with a big
                    // gap. When the list overflows, the auto margin collapses to 0 and
                    // normal scrolling resumes — unlike justify-end, this never clips the
                    // top out of scroll reach.
                    <div className="flex flex-col mt-auto">
                    {/* ── Read receipt "Seen" indicator pre-computation ─────────
                        Only shown in DMs. Find the other user's last read timestamp,
                        then walk back from the end to find the last sent (isMe) message
                        whose send time falls at or before that timestamp. */}
                    {(() => {
                        const otherUserReadAt: number | undefined = convType === 'dm' && readReceipts
                            ? Object.entries(readReceipts).find(([uid]) => uid !== user?.user_id)?.[1]
                            : undefined;
                        const lastSeenMsgIndex: number = otherUserReadAt !== undefined
                            ? (() => {
                                for (let i = displayMessages.length - 1; i >= 0; i--) {
                                    const m = displayMessages[i];
                                    const isMineCheck = m.sender_user_id
                                        ? m.sender_user_id === user?.user_id
                                        : myDeviceIds.has(m.sender_device_id);
                                    if (!isMineCheck) continue;
                                    const mTs = typeof m.timestamp === 'number'
                                        ? m.timestamp
                                        : Date.parse(m.timestamp || '');
                                    if (Number.isFinite(mTs) && mTs <= otherUserReadAt) return i;
                                }
                                return -1;
                            })()
                            : -1;

                        // ── Decide which messages get the entrance animation ──────
                        // First populated render: seed the seen-set, animate nothing
                        // (no cascade on chat open). Afterwards, a not-yet-seen message
                        // animates only if it's at/after the newest timestamp we've seen
                        // (appended live), so paginated-in older messages stay still.
                        // Rows are keyed by their stable identity (client_msg_id for
                        // this device's own sends), so confirming a send, adopting the
                        // server id and re-sorting by server time all update the SAME
                        // row — never unmount it and mount a fresh one that would play
                        // its entrance again. A row that is entering keeps entering
                        // until its onAnimationEnd calls finish(). utils/messageEntrance.ts.
                        const rowKeys = assignRowKeys(displayMessages, deviceId);
                        const enteringKeys = entrance.decide(displayMessages, rowKeys);

                        // Grouping input for each row, in one forward pass: the
                        // nearest earlier non-system message, or null when that
                        // is a call bar (same rule as `prev` inside the row).
                        const groupPrev: Array<(typeof displayMessages)[number] | null> = new Array(displayMessages.length);
                        {
                            let lastNonSystem: (typeof displayMessages)[number] | null = null;
                            for (let i = 0; i < displayMessages.length; i++) {
                                groupPrev[i] = lastNonSystem && lastNonSystem.content?.type !== 'call_key' ? lastNonSystem : null;
                                if (displayMessages[i]?.content?.type !== 'system') lastNonSystem = displayMessages[i];
                            }
                        }
                        return displayMessages.map((msg, index) => {
                        const rowKey = rowKeys[index];
                        const entering = enteringKeys.has(rowKey);
                        const replyToId = msg.content?.reply_to_id;
                        // The quoted message, found by index (was two scans of
                        // the whole conversation per reply row per render).
                        const replyTarget = replyToId
                            ? (replyLookup.byId.get(replyToId) || replyLookup.byClientId.get(replyToId))
                            : undefined;
                        const callId: string | undefined = msg.content?.type === 'call_key' ? msg.content.call_id : undefined;
                        const rowCall = callId ? callDurations[callId] : undefined;
                        const rowDeps = [
                            ...rowGlobals, msg, index > 0 ? displayMessages[index - 1] : null, groupPrev[index],
                            index === lastSeenMsgIndex, entering,
                            hoveredMsgId === msg.id, highlightedMsgId === msg.id,
                            showEmojiPicker === msg.id ? (reactionPickerAnchor ?? 'open') : null,
                            objectUrls[msg.id], decryptErrors[msg.id], decryptingIds[msg.id], manualDecryptIds.has(msg.id),
                            replyTarget, rowCall, rowCall?.active ? callTick : 0,
                        ];
                        return (
                        <MemoRow key={rowKey} deps={rowDeps} render={() => {
                        // Handlers that act on state outside this row's deps →
                        // stable stand-ins (see rowLive).
                        const {
                            decryptManual, cancelDecrypt, retryDecrypt, ensureAttachmentCached,
                            requestDelete, startEdit, handleAddReaction, handleContextMenu, jumpToMessage, handleMentionClick,
                            onPinMessage, onUnpinMessage, onKeyChangeResolved, onServerSaveMessage, onServerUnsaveMessage,
                            onInviteJoin,
                        } = rowLive;
                        const retention = {
                            saveMessage: rowLive.saveMessage, unsaveMessage: rowLive.unsaveMessage,
                            saveAttachment: rowLive.saveAttachment, unsaveAttachment: rowLive.unsaveAttachment,
                        };
                        const onOpenProfile = onOpenProfileProp ? rowLive.onOpenProfile : undefined;
                        const onInviteCodeClick = onInviteCodeClickProp ? rowLive.onInviteCodeClick : undefined;
                        const isMe = msg.sender_user_id
                            ? msg.sender_user_id === user?.user_id
                            : myDeviceIds.has(msg.sender_device_id);

                        // ── Shared timestamp for this message ─────────────────
                        const msgMs = typeof msg.timestamp === 'number' ? msg.timestamp : Date.parse(msg.timestamp || '');

                        // ── Date divider helpers ──────────────────────────────
                        // Find the previous non-system, non-call_key message for date comparison.
                        const prevAny = index > 0 ? displayMessages[index - 1] : null;
                        const prevAnyMs = prevAny
                            ? (typeof prevAny.timestamp === 'number' ? prevAny.timestamp : Date.parse(prevAny.timestamp || ''))
                            : 0;
                        const showDateDivider = Number.isFinite(msgMs) && (
                            index === 0 ||
                            !Number.isFinite(prevAnyMs) ||
                            new Date(msgMs).toDateString() !== new Date(prevAnyMs).toDateString()
                        );
                        const dateLabel = (() => {
                            if (!showDateDivider || !Number.isFinite(msgMs)) return '';
                            const d   = new Date(msgMs);
                            const now = new Date();
                            const todayStr     = now.toDateString();
                            const yday = new Date(now); yday.setDate(now.getDate() - 1);
                            if (d.toDateString() === todayStr)       return 'Today';
                            if (d.toDateString() === yday.toDateString()) return 'Yesterday';
                            const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
                            // Cached formatters — see utils/messageTimeFormat.
                            if (diffDays < 7)  return formatWeekdayShortMonthDay(d);
                            if (diffDays < 365) return formatWeekdayLongMonthDay(d);
                            return formatLongMonthDayYear(d);
                        })();
                        const DateDivider = showDateDivider ? (
                            <div className="flex items-center gap-3 my-4 px-4 select-none">
                                <div className="flex-1 h-px bg-white/[0.06]" />
                                <span className="text-[11px] text-cl-faint font-medium tracking-wide whitespace-nowrap px-1">{dateLabel}</span>
                                <div className="flex-1 h-px bg-white/[0.06]" />
                            </div>
                        ) : null;

                        // ── System messages: event bar ────────────────────────
                        // Two variants of `type: 'system'`:
                        //   1. Plain text events (joined/left/kicked) — rendered as
                        //      the usual divider pill with the supplied text.
                        //   2. `kind: 'encrypted'` placeholder, set by Dashboard's
                        //      catch handler when channel-message decryption fails
                        //      (typically because the Sender Key for the message's
                        //      epoch hasn't been distributed to this device yet).
                        //      Previously fell into the same render branch but with
                        //      no text, producing the "lines with nothing in them"
                        //      bug: just the divider rules and an empty pill.
                        if (msg.content?.type === 'system') {
                            // DM placeholder (Message integrity §2, utils/dmInbound.ts):
                            // an envelope arrived that this device could not decrypt
                            // or show. It is permanent — the server's copy is gone
                            // once acked — so, unlike the channel variant below, it
                            // does not promise to resolve.
                            const systemRow = msg.content as { kind?: unknown; data?: { reason?: unknown } };
                            if (systemRow.kind === UNDECRYPTABLE_KIND) {
                                return (
                                    <React.Fragment key={rowKey}>
                                        {DateDivider}
                                        <div className="flex items-center gap-3 my-2 px-4 select-none" role="note">
                                            <div className="flex-1 h-px bg-white/[0.05]" />
                                            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-cl-glow/20 bg-cl-glow/[0.05] text-cl-glow/70 text-[11px] font-medium">
                                                <Lock className="w-3 h-3 flex-shrink-0" />
                                                <span>{placeholderText(systemRow.data?.reason)}</span>
                                            </div>
                                            <div className="flex-1 h-px bg-white/[0.05]" />
                                        </div>
                                    </React.Fragment>
                                );
                            }
                            // Encrypted-placeholder branch — render a clear lock
                            // indicator so the user understands the message exists
                            // but couldn't be decrypted. Will resolve into real
                            // content once the channel key is delivered + a re-pull
                            // happens (Ctrl+R or channel switch + back).
                            if ((msg.content as any).kind === 'encrypted') {
                                return (
                                    <React.Fragment key={rowKey}>
                                        {DateDivider}
                                        <div className="flex items-center gap-3 my-2 px-4 select-none">
                                            <div className="flex-1 h-px bg-white/[0.05]" />
                                            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-cl-glow/20 bg-cl-glow/[0.05] text-cl-glow/70 text-[11px] font-medium">
                                                <Lock className="w-3 h-3 flex-shrink-0" />
                                                <span>Couldn't decrypt — waiting on this channel's key</span>
                                            </div>
                                            <div className="flex-1 h-px bg-white/[0.05]" />
                                        </div>
                                    </React.Fragment>
                                );
                            }

                            const sysText  = (msg.content.text as string) || '';
                            const isJoin   = /joined|added/i.test(sysText);
                            const isLeave  = /left|removed|kicked/i.test(sysText);
                            const SysIcon  = isJoin ? UserPlus : isLeave ? UserMinus : null;
                            return (
                                <React.Fragment key={rowKey}>
                                    {DateDivider}
                                    <div className="flex items-center gap-3 my-2 px-4 select-none">
                                        <div className="flex-1 h-px bg-white/[0.05]" />
                                        <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-[11px] font-medium ${
                                            isJoin  ? 'bg-blue-500/[0.07] border-blue-500/20 text-blue-400/80' :
                                            isLeave ? 'bg-white/[0.03] border-white/[0.06] text-cl-faint' :
                                                      'bg-white/[0.03] border-white/[0.06] text-cl-faint'
                                        }`}>
                                            {SysIcon && <SysIcon className="w-3 h-3 flex-shrink-0" />}
                                            <span>{sysText}</span>
                                        </div>
                                        <div className="flex-1 h-px bg-white/[0.05]" />
                                    </div>
                                </React.Fragment>
                            );
                        }

                        // ── Call messages: full-width bar ─────────────────────
                        if (msg.content?.type === 'call_key') {
                            const callId    = msg.content.call_id!;
                            const callState = callDurations[callId];
                            const active    = callState?.active ?? false;
                            // Live duration: seconds since message timestamp for active calls.
                            // callTick forces a re-render every second.
                            void callTick;
                            const liveSecs  = active
                                ? Math.max(0, Math.floor((Date.now() - (Number.isFinite(msgMs) ? msgMs : Date.now())) / 1000))
                                : (callState?.duration ?? 0);
                            const fmtSecs   = (s: number) => {
                                const h = Math.floor(s / 3600);
                                const m = Math.floor((s % 3600) / 60);
                                const sec = s % 60;
                                return h > 0
                                    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
                                    : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
                            };
                            const callerName = isMe ? (user?.username ?? 'You') : (deviceToUsername[msg.sender_device_id] || 'Someone');
                            return (
                                <React.Fragment key={rowKey}>
                                    {DateDivider}
                                    <div className="flex items-center gap-3 my-2 px-4 select-none">
                                        <div className="flex-1 h-px bg-white/[0.05]" />
                                        <div className={`flex items-center gap-2 px-3 py-1 rounded-full border text-[11px] font-medium ${
                                            active
                                                ? 'bg-cl-ok/[0.08] border-cl-ok/20 text-cl-ok'
                                                : 'bg-white/[0.03] border-white/[0.06] text-cl-faint'
                                        }`}>
                                            <PhoneCall className={`w-3 h-3 flex-shrink-0 ${active ? 'text-cl-ok' : 'text-cl-faint'}`} />
                                            {active ? (
                                                <>
                                                    <span>{callerName} started a call</span>
                                                    <span className="opacity-50">·</span>
                                                    <span className="font-mono tabular-nums">{fmtSecs(liveSecs)}</span>
                                                </>
                                            ) : callState ? (
                                                <>
                                                    <span>Call ended</span>
                                                    <span className="opacity-50">·</span>
                                                    <span className="font-mono tabular-nums">{fmtSecs(liveSecs)}</span>
                                                </>
                                            ) : (
                                                <span>{callerName} started a call</span>
                                            )}
                                        </div>
                                        <div className="flex-1 h-px bg-white/[0.05]" />
                                    </div>
                                </React.Fragment>
                            );
                        }

                        // Consecutive-message grouping: if the previous non-system message is from
                        // the same sender within 30 minutes, hide the avatar/name/timestamp header.
                        // A call_key bar is a hard visual break — the first message after a call
                        // must always show the full header regardless of sender or timing.
                        const prev = (() => {
                            for (let i = index - 1; i >= 0; i--) {
                                const p = displayMessages[i];
                                if (p?.content?.type === 'system') continue;
                                if (p?.content?.type === 'call_key') return null; // call bar breaks grouping
                                return p;
                            }
                            return null;
                        })();
                        const prevMs = prev ? (typeof prev.timestamp === 'number' ? prev.timestamp : Date.parse(prev.timestamp || '')) : 0;
                        const sameSender = !!prev
                            && prev.sender_device_id === msg.sender_device_id
                            && Number.isFinite(msgMs) && Number.isFinite(prevMs)
                            && (msgMs - prevMs) < 30 * 60 * 1000;
                        const showHeader = !sameSender;

                        // Save/retention state for this message (text, server_invite, or attachment).
                        const isAttachment = msg.content?.type === 'attachment';
                        const attId: string | undefined = isAttachment ? msg.content?.attachment_id : undefined;
                        // server_invite messages are treated the same as text for all retention
                        // operations (save, expiry, pin, react, delete timer display).
                        // klipy_gif counts too: the GIF is hosted on KLIPY but the MESSAGE is
                        // ours, so it saves, expires, pins and shows its countdown like text —
                        // otherwise a chat's text would age out and leave a wall of GIFs.
                        const isTextLike = isTextLikeMessageType(msg.content?.type);
                        // `saved` = effective saved state (considers per-channel retention override).
                        const saved = isAttachment
                            ? (attId ? isEffectiveAttachSaved(attId) : false)
                            : (isTextLike ? isEffectiveMsgSaved(msg.id, msg.content?.type === 'klipy_gif') : false);
                        // `showAccentBar` = only show the gutter accent for timed-retention users —
                        // users with "save forever" policy don't need the accent since everything
                        // is saved by default.
                        // Deletion time computation.
                        // `inlineBadge`  — short form shown in the header (< 24 h only, urgent).
                        // `compactExpiry`— short form shown inline in grouped messages on hover
                        //                  (any finite expiry): "1w", "3d", "23h".
                        // `deletionText` — verbose form for the right-click menu info row and
                        //                  tooltip on the inline badge.
                        const sentMs = Number.isFinite(msgMs) ? msgMs : Date.now();
                        // Server-saved messages are stored permanently on the server —
                        // local retention policy does not apply, so no deletion timer is shown.
                        const isServerSaved = serverSavedIds.includes(msg.id);
                        const expiryAt = isServerSaved ? null : (isAttachment && attId
                            ? getEffectiveAttachExpiryAt(attId, sentMs)
                            : (isTextLike ? getEffectiveMsgExpiryAt(msg.id, sentMs, msg.content?.type === 'klipy_gif') : null));
                        let inlineBadge: string | null = null;
                        let compactExpiry: string | null = null;
                        let deletionText: string | null = null;
                        if (expiryAt !== null) {
                            const remainingMs = expiryAt - Date.now();
                            if (remainingMs <= 0) {
                                inlineBadge = '!';
                                compactExpiry = '!';
                                deletionText = 'Deletion pending';
                            } else {
                                const totalHrs  = remainingMs / (60 * 60 * 1000);
                                const totalDays = remainingMs / (24 * 60 * 60 * 1000);
                                const hrs  = Math.max(1, Math.round(totalHrs));
                                const days = Math.max(1, Math.round(totalDays));
                                const wks  = Math.round(totalDays / 7);
                                const mos  = Math.round(totalDays / 30);
                                // Compact label covers all ranges
                                if (totalHrs < 24)      compactExpiry = `${hrs}h`;
                                else if (totalDays < 7) compactExpiry = `${days}d`;
                                else if (totalDays < 60) compactExpiry = `${Math.max(1, wks)}w`;
                                else                     compactExpiry = `${Math.max(1, mos)}mo`;
                                // Verbose for tooltips / right-click menu
                                deletionText = totalHrs < 24
                                    ? `Deletes in ${hrs} hour${hrs !== 1 ? 's' : ''}`
                                    : `Deletes in ${days} day${days !== 1 ? 's' : ''}`;
                                // Badge in header: always show for any finite expiry
                                inlineBadge = compactExpiry;
                            }
                        }

                        // Username + avatar resolution.
                        // Priority for server channels: server nickname > device username > account username
                        // Final fallback is "Unknown User" — never the raw user/device id.
                        // The lazy-resolver effect (useEffect on `messages`) fires a
                        // /v1/auth/users/:id fetch for any sender_user_id we don't have
                        // yet, so this fallback is transient — it resolves to the real
                        // username within ~one round-trip if the user account exists.
                        const resolvedName = (activeChannel && msg.sender_user_id && serverMemberNicknames?.[msg.sender_user_id])
                            ?? deviceToUsername[msg.sender_device_id]
                            ?? (msg.sender_user_id ? userIdToUsername[msg.sender_user_id] : null)
                            ?? (isMe ? (user?.username ?? 'You') : 'Unknown User');
                        const resolvedAvatar = isMe
                            ? (user?.avatar_url || undefined)
                            : (deviceToAvatar[msg.sender_device_id] ?? (msg.sender_user_id ? userIdToAvatar[msg.sender_user_id] : undefined));

                        // Smart timestamp
                        const smartTimestamp = (() => {
                            const d = new Date(msgMs || Date.now());
                            const now = new Date();
                            const isToday = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
                            const yesterday = new Date(now);
                            yesterday.setDate(now.getDate() - 1);
                            const isYesterday = d.getDate() === yesterday.getDate() && d.getMonth() === yesterday.getMonth() && d.getFullYear() === yesterday.getFullYear();
                            // Cached formatter — this ran per row per render (see utils/messageTimeFormat).
                            const timeStr = formatHourMinute(d);
                            if (isToday) return `Today at ${timeStr}`;
                            if (isYesterday) return `Yesterday at ${timeStr}`;
                            return `${formatNumericDate(d)} ${timeStr}`;
                        })();

                        // Row click toggles save/unsave.
                        // For text messages: anywhere on the row except interactive children.
                        // For attachments: clicking blank space (not the image/video itself) saves it.
                        //
                        // Two new guards prevent the row click from firing when the user
                        // really wanted to do something else:
                        //
                        //   (a) Active text selection — if `window.getSelection()` reports
                        //       any non-empty selection, the user just finished dragging to
                        //       highlight text; the click is the trailing edge of that drag,
                        //       not an intent to save. Without this, "select text in a
                        //       message" would also save the message.
                        //
                        //   (b) Drag distance — if the pointer moved meaningfully between
                        //       mousedown and mouseup, treat it as a drag (e.g. starting a
                        //       text selection that didn't end up selecting because the
                        //       user only crossed a single character). Threshold matches
                        //       ImageLightbox's DRAG_THRESHOLD (4 px).
                        const onRowClick = (e: React.MouseEvent) => {
                            // If a picker was just dismissed by this same click, ignore it.
                            if (pickerJustClosedRef.current) { pickerJustClosedRef.current = false; return; }
                            // No mousedown was recorded on this row — the click started
                            // somewhere else (e.g. dismissing a context menu from another
                            // pane). Treat it as a ghost click and do nothing.
                            if (!rowMouseDownRef.current) return;
                            // Guard (a): user is highlighting text in this row.
                            const sel = typeof window !== 'undefined' ? window.getSelection() : null;
                            if (sel && sel.toString().length > 0) return;
                            // Guard (b): the click came from a drag, not a tap.
                            const start = rowMouseDownRef.current;
                            if (Math.abs(e.clientX - start.x) > 4 || Math.abs(e.clientY - start.y) > 4) {
                                rowMouseDownRef.current = null;
                                return;
                            }
                            rowMouseDownRef.current = null;
                            const target = e.target as HTMLElement;
                            if (target.closest('button, a, input, textarea, video, audio, img, canvas')) return;
                            if (isTextLike) {
                                if (isEffectiveMsgSaved(msg.id, msg.content?.type === 'klipy_gif')) retention.unsaveMessage(msg.id);
                                else retention.saveMessage(msg.id);
                            } else if (msg.content?.type === 'attachment' && attId) {
                                if (isEffectiveAttachSaved(attId)) {
                                    retention.unsaveAttachment(attId);
                                    deleteEncryptedAttachment(attId);
                                } else {
                                    retention.saveAttachment(attId);
                                    ensureAttachmentCached(msg);
                                }
                            }
                        };
                        // Capture mousedown coords so onRowClick above can detect drags.
                        const onRowMouseDown = (e: React.MouseEvent) => {
                            // Flag the press for the row's onFocus. Focus is dispatched
                            // synchronously inside this same mousedown, so clearing it on a
                            // 0ms timer is enough and needs no mouseup listener.
                            rowPointerPressRef.current = true;
                            setTimeout(() => { rowPointerPressRef.current = false; }, 0);
                            if (e.button !== 0) return;
                            rowMouseDownRef.current = { x: e.clientX, y: e.clientY };
                        };

                        // Highlight row if this message mentions the current user.
                        // All mention types (everyone, direct, role) highlight regardless
                        // of who sent the message — including messages you sent yourself
                        // (self-mentions, @everyone you sent, roles you belong to).
                        const msgText = msg.content?.type === 'text' ? (msg.content.text ?? '') : '';
                        const mentionsMe = !!(
                            msgText && (
                                // @everyone / @here
                                msgText.includes('@everyone') || msgText.includes('@here')
                                // Direct user mention token (matches you as sender OR receiver)
                                || (!!user?.user_id && msgText.includes(`<@u:${user.user_id}:`))
                                // Role mention for any role you belong to
                                || messageTextMentionsRole(msgText, myServerRoleIds)
                            )
                        );

                        const authorUserId = isMe
                            ? (user?.user_id ?? null)
                            : (msg.sender_user_id ?? null);
                        const avatarEl = showHeader ? (
                            <EncryptedAvatar
                                attachmentId={resolvedAvatar}
                                userId={authorUserId}
                                token={token}
                                className="w-10 h-10 shrink-0 mt-0.5 ring-1 ring-white/5 shadow-sm"
                                fallbackSize={24}
                                bypassFriendGate={isServerChannel}
                            />
                        ) : (
                            <div className="w-10 shrink-0" />
                        );

                        return (
                            <React.Fragment key={rowKey}>
                            {DateDivider}
                            <div
                                id={`msg-${msg.id}`}
                                className={`group relative flex gap-3 py-0.5 pr-2 pl-3 ${showHeader ? 'mt-3' : ''} ${
                                    mentionsMe ? '' : 'hover:bg-white/[0.015]'
                                } ${highlightedMsgId === msg.id ? 'msg-reply-highlight' : ''} ${(isTextLike || (msg.content?.type === 'attachment' && attId)) ? 'cursor-pointer' : ''} ${
                                    entering ? (isMe ? 'cl-msg-enter-sent' : 'cl-msg-enter-recv') : ''
                                }`}
                                onAnimationEnd={(e) => {
                                    // Mark seen + strip the class once the entrance finishes so the
                                    // lingering transform can't establish a containing block under
                                    // the hover menu. Guard so child animations don't trigger this.
                                    if (e.target === e.currentTarget && e.animationName.startsWith('cl-msg-in')) {
                                        entrance.finish(rowKey);
                                        e.currentTarget.classList.remove('cl-msg-enter-sent', 'cl-msg-enter-recv');
                                    }
                                }}
                                onMouseEnter={() => {
                                    // Cancel any in-flight leave timer so moving from row → menu → row
                                    // doesn't flicker the action menu.
                                    if (hoverLeaveTimerRef.current) clearTimeout(hoverLeaveTimerRef.current);
                                    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
                                    hoverTimeoutRef.current = setTimeout(() => setHoveredMsgId(msg.id), 160);
                                }}
                                onMouseLeave={() => {
                                    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
                                    // Short grace period — the action menu is absolutely positioned
                                    // above the row's layout box, so the mouse briefly leaves the div
                                    // bounds while travelling up to reach the buttons. Without this
                                    // delay the menu collapses before the user can click it.
                                    if (hoverLeaveTimerRef.current) clearTimeout(hoverLeaveTimerRef.current);
                                    hoverLeaveTimerRef.current = setTimeout(() => setHoveredMsgId(null), 200);
                                }}
                                // A message that never reached the server has nothing to
                                // react to, pin, edit or reply to yet — Retry / Delete sit
                                // under it instead.
                                onContextMenu={(e) => { if (isUnconfirmedSend(msg)) { e.preventDefault(); return; } handleContextMenu(e, msg); }}
                                onMouseDown={onRowMouseDown}
                                onClick={onRowClick}
                                // The action bar only mounts while the row is "hovered", which
                                // made Delete (and every other action) mouse-only — there was no
                                // keyboard route to it at all. Putting the row in the tab order
                                // and treating focus like hover gives one: Tab to the row, Tab
                                // again into the bar, Enter to confirm-delete or Shift+Enter to
                                // bypass. React's onFocus/onBlur are focusin/focusout, so they
                                // also fire as focus moves between the row and the bar inside
                                // it; the 0ms blur timer is cancelled by the immediately
                                // following focus so the bar doesn't flicker shut mid-Tab.
                                tabIndex={0}
                                onFocus={(e) => {
                                    // A mouse press on the row body now focuses it too (it is
                                    // tabbable), and pinning the bar on THAT would leave it stuck
                                    // open after the mouse moved away — hover already owns that
                                    // case. Focus landing on a DESCENDANT always re-arms, mouse
                                    // included: the onBlur below fires during a msgbar button's
                                    // mousedown and would otherwise unmount the button before its
                                    // click ever dispatched.
                                    if (rowPointerPressRef.current && e.target === e.currentTarget) return;
                                    if (hoverLeaveTimerRef.current) clearTimeout(hoverLeaveTimerRef.current);
                                    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
                                    setHoveredMsgId(msg.id);
                                }}
                                onBlur={() => {
                                    if (hoverLeaveTimerRef.current) clearTimeout(hoverLeaveTimerRef.current);
                                    hoverLeaveTimerRef.current = setTimeout(() => setHoveredMsgId(null), 0);
                                }}
                            >
                                {/* Mention highlight — rendered first so it sits behind all content.
                                    Rounded overlay slightly inset from the row edges so the corners
                                    are visible.  group-hover darkens it without moving any content. */}
                                {mentionsMe && (
                                    <div className="absolute inset-0 mx-1 rounded-md bg-cl-glow/[0.08] group-hover:bg-cl-glow/[0.13] pointer-events-none" />
                                )}
                                {/* Discord-style: avatar always on the left, regardless of author. */}
                                {avatarEl}

                                <div className="relative flex flex-col min-w-0 flex-1">

                                    {/* Grouped message gutter — floats in the avatar gutter to the left.
                                        Server-saved and pinned icons are always visible; compact expiry
                                        and local-save icon remain hover-only. */}
                                    {!showHeader && (isServerSaved || pinnedMsgIds.includes(msg.id) || saved || compactExpiry) && (
                                        <span className="absolute top-1/2 -translate-y-1/2 flex items-center gap-0.5 pointer-events-none right-full pr-2">
                                            {isServerSaved && (
                                                <span className="inline-flex shrink-0" title="Saved to server">
                                                    <Archive className="w-2.5 h-2.5 text-cl-glow" />
                                                </span>
                                            )}
                                            {/* Pin icon. In a channel every pinned message is also
                                                server-saved, so a pinned channel message shows BOTH
                                                icons — amber archive (saved) + pin — which is what
                                                tells it apart from a message that is only saved.
                                                DM/group: the local pin's only indicator. */}
                                            {pinnedMsgIds.includes(msg.id) && (
                                                <span className="inline-flex shrink-0" title="Pinned">
                                                    <Pin className="w-2.5 h-2.5 text-white/40" />
                                                </span>
                                            )}
                                            {/* Expiry / save indicators are suppressed when the message is
                                                pinned — the pin icon is the only persistent status shown.
                                                The save state is surfaced in the hover action menu instead. */}
                                            {!pinnedMsgIds.includes(msg.id) && (saved || compactExpiry) && (
                                                <span className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                                                    {saved ? (
                                                        <Save className="w-3 h-3 text-cl-muted" strokeWidth={2} />
                                                    ) : (
                                                        <span className="text-[10px] text-cl-glow/70 whitespace-nowrap">{compactExpiry}</span>
                                                    )}
                                                </span>
                                            )}
                                        </span>
                                    )}

                                    {showHeader && (() => {
                                        // Click target: own profile for "You", sender's profile for others.
                                        const nameTargetId = isMe ? (user?.user_id ?? null) : (msg.sender_user_id ?? null);
                                        const nameClickable = !!nameTargetId && !!(openProfileCtx || onOpenProfile);
                                        return (
                                        <div className="flex items-baseline gap-2 mb-0.5">
                                            <span
                                                className={`text-[14px] font-semibold leading-tight ${nameClickable ? 'cursor-pointer hover:brightness-125 transition-[filter]' : ''}`}
                                                style={{ color: (msg.sender_user_id && memberRoleColors?.[msg.sender_user_id]) || 'white' }}
                                                // Press = the open, one event early: start the
                                                // profile + images now; the click joins them.
                                                onPointerDown={nameClickable ? (e) => {
                                                    if (e.button === 0) scheduleProfilePrefetch(nameTargetId, token, { immediate: true });
                                                } : undefined}
                                                onClick={nameClickable ? (e) => {
                                                    e.stopPropagation();
                                                    if (openProfileCtx) openProfileCtx(nameTargetId!, { x: e.clientX, y: e.clientY });
                                                    else onOpenProfile!(nameTargetId!);
                                                } : undefined}
                                            >
                                                {resolvedName}
                                            </span>
                                            <span className="text-[11px] text-cl-faint leading-tight">
                                                {smartTimestamp}
                                            </span>
                                            {msg.edited && (
                                                <span className="text-[10px] text-cl-faint italic">(edited)</span>
                                            )}
                                            {/* Saved to server (amber) — channel only. Pinned or not. */}
                                            {isServerSaved && (
                                                <span className="inline-flex shrink-0" title="Saved to server">
                                                    <Archive className="w-2.5 h-2.5 text-cl-glow" />
                                                </span>
                                            )}
                                            {/* Pinned — channel (shared, and always also saved, so it
                                                sits next to the amber icon) or DM/group (local). */}
                                            {pinnedMsgIds.includes(msg.id) && (
                                                <span className="inline-flex shrink-0" title="Pinned">
                                                    <Pin className="w-2.5 h-2.5 text-white/40" />
                                                </span>
                                            )}
                                            {/* Urgency badge (<24h) or saved icon — suppressed on pinned messages
                                                (pin icon is the sole persistent indicator; save state surfaces
                                                in the hover action menu). For non-pinned messages: mutually
                                                exclusive pair, hover-only. */}
                                            {!pinnedMsgIds.includes(msg.id) && (inlineBadge && deletionText ? (
                                                <span className="relative group/cd inline-flex items-center cursor-default opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                                                    <span className="text-[10px] text-cl-glow/70 tabular-nums font-medium">· {inlineBadge}</span>
                                                    <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 text-[11px] bg-cl-deep border border-white/10 rounded-md text-cl-text whitespace-nowrap opacity-0 group-hover/cd:opacity-100 transition-opacity duration-150 z-50 shadow-lg">
                                                        {deletionText}
                                                    </span>
                                                </span>
                                            ) : saved ? (
                                                <Save className="w-3 h-3 text-cl-muted shrink-0 self-center translate-y-px opacity-0 group-hover:opacity-100 transition-opacity duration-150" strokeWidth={2} />
                                            ) : null)}
                                        </div>
                                        );
                                    })()}

                                    {/* Reply quote preview — click to jump to the original message */}
                                    {msg.content?.reply_to_id && (
                                        <div
                                            onClick={(e) => { e.stopPropagation(); jumpToMessage(msg.content.reply_to_id); }}
                                            className="text-[12px] p-2 rounded-lg mb-1 opacity-70 border-l-2 border-cl-lume/50 bg-white/[0.03] w-fit max-w-full min-w-0 overflow-hidden whitespace-nowrap text-ellipsis cursor-pointer hover:bg-white/[0.06] hover:opacity-90 transition-colors"
                                        >
                                            {displayTextOf(replyTarget?.content) || 'Original message'}
                                        </div>
                                    )}

                                    {/* Body */}
                                    {msg.content?.type === 'text' ? (
                                        <>
                                            {/* Hide the link text when the whole message is just a bare image URL or
                                                a bare Cipherline invite URL — the embed below will render instead. */}
                                            {(() => {
                                                const rawText = msg.content.text ?? '';
                                                const trimmed = rawText.trim();
                                                const isBareImageUrl = /^https?:\/\/\S+$/.test(trimmed) && isImageUrl(trimmed);
                                                const isBareInviteUrl = INVITE_URL_RE.test(trimmed);
                                                if (isBareImageUrl || isBareInviteUrl) return null;

                                                // Scale up emoji-only messages based on count.
                                                const emojiOnly = isEmojiOnly(trimmed);
                                                // A custom-emoji token can't render as a bare glyph, so an
                                                // emoji-only message that contains one needs the dedicated
                                                // jumbo renderer instead of the raw-text fast path below.
                                                const hasCustomToken = new RegExp(EMOJI_TOKEN_RE.source).test(trimmed);
                                                let fontSize = '15px';
                                                let lineHeight: string | number = 'normal';
                                                if (emojiOnly) {
                                                    const n = countEmojis(trimmed);
                                                    if (n <= 3)      { fontSize = '3em';   lineHeight = 1.1; }
                                                    else if (n <= 5) { fontSize = '2em';   lineHeight = 1.15; }
                                                    else if (n <= 8) { fontSize = '1.5em'; lineHeight = 1.2; }
                                                }

                                                return (
                                                    <div
                                                        className={`text-white/90 break-words whitespace-pre-wrap overflow-hidden${msg.send_state === 'sending' ? ' cl-send-pending' : ''}`}
                                                        style={{ fontSize, lineHeight, wordBreak: 'break-word' }}
                                                    >
                                                        {emojiOnly
                                                            ? (hasCustomToken ? renderJumboContent(trimmed, resolveEmoji, token, serverEmojisLoading, noServerEmojiContext) : trimmed)
                                                            : renderTextWithMentions(rawText, user?.user_id ?? null, memberRoleColors, onInviteCodeClick, resolveEmoji, token, serverEmojisLoading, noServerEmojiContext, mentionedUserIsKnown, handleMentionClick)}
                                                        {msg.edited && !showHeader && (
                                                            <span className="text-[10px] opacity-40 ml-2 italic">(edited)</span>
                                                        )}
                                                    </div>
                                                );
                                            })()}
                                            {/* URL embeds — invite cards, YouTube player, or generic link card */}
                                            {(() => {
                                                const text: string = msg.content.text ?? '';
                                                const matches = [...text.matchAll(new RegExp(URL_REGEX.source, 'g'))].map(m => m[0]);
                                                const unique = [...new Set(matches)].slice(0, 3);
                                                if (unique.length === 0) return null;
                                                return (
                                                    <div className="flex flex-col gap-1 w-full items-start">
                                                        {unique.map((u, i) => {
                                                            const code = extractInviteCode(u);
                                                            if (code) {
                                                                return (
                                                                    <ServerInviteEmbed
                                                                        key={i}
                                                                        code={code}
                                                                        token={token}
                                                                        servers={servers}
                                                                        onJoin={(serverId, serverName) => onInviteJoin?.(serverId, serverName)}
                                                                    />
                                                                );
                                                            }
                                                            return <MessageEmbed key={i} url={u} />;
                                                        })}
                                                    </div>
                                                );
                                            })()}
                                        </>
                                    ) : msg.content?.type === 'attachment' ? (
                                        <div className="flex flex-col w-full items-start">
                                            {/* Removed/expired attachments are filtered out of
                                                displayMessages entirely (the row disappears), so
                                                there's no "no longer available" placeholder branch
                                                here anymore. */}
                                            {decryptErrors[msg.id] ? (
                                                /* ── Decrypt failure card ─────────────────────────
                                                   Genuine errors only — timeouts, network, key issues.
                                                   404 (retention delete) is handled by the placeholder
                                                   above so users don't see alarming red cards for
                                                   intentional deletions. */
                                                <div className="flex items-start gap-3 p-3.5 bg-cl-flash/[0.08] border border-cl-flash/25 rounded-xl min-w-[260px] max-w-[360px]">
                                                    <div className="w-7 h-7 rounded-lg bg-cl-flash/15 border border-cl-flash/25 flex items-center justify-center shrink-0 mt-0.5">
                                                        <AlertTriangle className="w-3.5 h-3.5 text-cl-flash" />
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-[12px] font-semibold text-cl-text leading-tight truncate">
                                                            Couldn't decrypt {msg.content.filename}
                                                        </p>
                                                        <p className="text-[11px] text-cl-flash/70 mt-0.5 leading-snug">
                                                            {decryptErrors[msg.id].message}
                                                        </p>
                                                        <ClButton
                                                            size="sm"
                                                            variant="ghost"
                                                            onClick={() => retryDecrypt(msg)}
                                                            style={{ marginTop: 8 }}
                                                        >
                                                            <RotateCcw size={11} /> Retry
                                                        </ClButton>
                                                    </div>
                                                </div>
                                            ) : decryptingIds[msg.id] !== undefined ? (
                                                <div className="flex items-center gap-3 p-3 bg-white/5 rounded-xl min-w-[260px]">
                                                    <Clock className="w-5 h-5 text-white/50 animate-pulse shrink-0" />
                                                    <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                                                        <span className="text-[12px] opacity-90 truncate">{msg.content.filename}</span>
                                                        <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                                                            <div className="h-full bg-cl-lume transition-[width] duration-200" style={{ width: `${decryptingIds[msg.id]}%` }} />
                                                        </div>
                                                    </div>
                                                    {/* Cancel — bails out of a stuck download. */}
                                                    <ClButton
                                                        icon
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() => cancelDecrypt(msg.id)}
                                                        tooltip="Cancel"
                                                    >
                                                        <X size={12} />
                                                    </ClButton>
                                                </div>
                                            ) : manualDecryptIds.has(msg.id) ? (
                                                <div className="flex flex-col gap-3 p-4 bg-white/5 rounded-xl">
                                                    <div className="flex items-center gap-3">
                                                        <Lock className="w-6 h-6 text-cl-lume" />
                                                        <div className="flex flex-col">
                                                            <span className="text-[13px] font-semibold">{msg.content.filename}</span>
                                                            <span className="text-[11px] opacity-50">Large file encrypted</span>
                                                        </div>
                                                    </div>
                                                    <ClButton fullWidth size="sm" onClick={() => decryptManual(msg)}>
                                                        Decrypt &amp; View
                                                    </ClButton>
                                                </div>
                                            ) : (
                                                <FileViewer
                                                    objectUrl={objectUrls[msg.id] ?? null}
                                                    filename={msg.content.filename}
                                                    mime={msg.content.mime}
                                                />
                                            )}
                                        </div>
                                    ) : msg.content?.type === 'call_key' ? (
                                        <div className="inline-flex items-center gap-2 py-2 px-3 bg-white/5 rounded-xl text-[12px] opacity-80 border border-white/5 w-fit">
                                            <PhoneCall className="w-4 h-4 text-cl-lume" />
                                            <div className="flex flex-col">
                                                <span>{isMe ? (user?.username ?? 'You') : deviceToUsername[msg.sender_device_id] || 'Someone'} started a call.</span>
                                                {callDurations[msg.content.call_id!] && (
                                                    <span className="text-[10px] opacity-60 font-semibold mt-0.5 text-cl-lume">
                                                        {callDurations[msg.content.call_id!].active
                                                            ? "Call in progress..."
                                                            : `Call ended • ${Math.floor(callDurations[msg.content.call_id!].duration / 60)}m ${callDurations[msg.content.call_id!].duration % 60}s`}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    ) : msg.content?.type === 'klipy_gif' ? (
                                        // Validated inside the embed (sender-controlled URL);
                                        // loads nothing unless this user opted in or taps.
                                        <KlipyGifEmbed content={msg.content} />
                                    ) : msg.content?.type === 'server_invite' ? (
                                        <ServerInviteEmbed
                                            code={msg.content.code}
                                            token={token}
                                            servers={servers}
                                            onJoin={(serverId, serverName) => onInviteJoin?.(serverId, serverName)}
                                        />
                                    ) : msg.content?.type === 'safety_number' ? (() => {
                                        // Re-validated here, not trusted: a row stored before the
                                        // content boundary checked this variant (or by any other
                                        // path) reaches the renderer as-is, and a non-string code
                                        // used to throw inside the embed and take the whole app to
                                        // the root error screen (utils/contentValidation.ts).
                                        const sn = parseSafetyNumberContent(msg.content);
                                        if (!sn) {
                                            return (
                                                <span className="inline-flex items-center gap-1.5 text-[12px] text-cl-faint italic" role="note">
                                                    <Lock className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                                                    {placeholderText('malformed')}
                                                </span>
                                            );
                                        }
                                        return (
                                        <SafetyNumberEmbed
                                            code={sn.code}
                                            claimedUserId={sn.claimedUserId}
                                            deviceCount={sn.deviceCount}
                                            // The verdict's subject comes from the ENVELOPE, never from
                                            // the payload — `msg.sender_user_id` is what the transport
                                            // says actually sent this. `content.user_id` is handed over
                                            // separately so the embed can report a disagreement between
                                            // the two rather than silently resolve it.
                                            senderUserId={
                                                msg.sender_user_id
                                                ?? (myDeviceIds.has(msg.sender_device_id) ? myUserId : null)
                                            }
                                            myUserId={myUserId}
                                            senderName={
                                                isMe
                                                    ? (user?.username ?? 'You')
                                                    : (userIdToUsername[msg.sender_user_id ?? '']
                                                        || deviceToUsername[msg.sender_device_id]
                                                        || activeChat.title
                                                        || 'them')
                                            }
                                            token={token}
                                            onVerified={uid => onKeyChangeResolved?.(uid)}
                                            // Same source as the header shield above, so the
                                            // embed's resting claim and the badge six inches
                                            // away cannot disagree about how bad things are.
                                            contactVerdict={
                                                msg.sender_user_id
                                                && keyChangedSenders?.has(msg.sender_user_id)
                                                    ? (senderWarnings[msg.sender_user_id] ?? 'key_changed')
                                                    : null
                                            }
                                        />
                                        );
                                    })() : (
                                        <span className="opacity-30 italic text-[12px]">Unsupported message variant</span>
                                    )}

                                    {/* Reactions row — bigger, thinner border, tooltip of reactors. */}
                                    {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                                            {Object.entries(msg.reactions).map(([emoji, deviceIds]) => {
                                                const ids = Array.isArray(deviceIds) ? deviceIds as string[] : [];
                                                const count = ids.length;
                                                // In server channels reactions are keyed by user_id;
                                                // in DMs/groups they may be device_id.  Check both.
                                                const hasMine = isMyReaction(ids, user?.user_id, myDeviceIds);
                                                // For server channels: gate by ADD_REACTIONS perm.
                                                // For DMs/groups: gate by friendship/group membership.
                                                const canReact = isServerChannel
                                                    ? canReactServer
                                                    : (isFriend || activeChat?.type === 'group');
                                                const reactorNames: string[] = ids.map(id => {
                                                    if (id === user?.user_id || myDeviceIds.has(id)) return user?.username ?? 'You';
                                                    // Prefer user-id map (server channels), fall back to device-id map (DMs).
                                                    // Final fallback is "Unknown" — never the raw id.
                                                    return userIdToUsername[id] ?? deviceToUsername[id] ?? 'Unknown';
                                                });
                                                return count > 0 && (
                                                    <ReactionPill
                                                        key={emoji}
                                                        emoji={emoji}
                                                        animKey={`${msg.id}:${emoji}`}
                                                        msgId={msg.id}
                                                        count={count}
                                                        hasMine={hasMine}
                                                        canReact={canReact}
                                                        resolveEmoji={resolveEmoji}
                                                        token={token}
                                                        emojisLoading={serverEmojisLoading}
                                                        noServerContext={noServerEmojiContext}
                                                        onClick={() => {
                                                            // Always dismiss tooltip on click — if this was the last
                                                            // reaction the button disappears and onMouseLeave never fires.
                                                            if (reactionHoverTimer.current) clearTimeout(reactionHoverTimer.current);
                                                            setReactionTooltip(null);
                                                            // handleAddReaction marks the key itself, so every
                                                            // entry point (pill, picker, context menu) behaves the
                                                            // same — nothing to do here beyond dispatching.
                                                            if (canReact) handleAddReaction(msg.id, emoji);
                                                        }}
                                                        onHoverStart={(rect) => {
                                                            reactionHoverTimer.current = setTimeout(() => {
                                                                setReactionTooltip({ emoji, names: reactorNames, rect });
                                                            }, 400);
                                                        }}
                                                        onHoverEnd={() => {
                                                            if (reactionHoverTimer.current) clearTimeout(reactionHoverTimer.current);
                                                            setReactionTooltip(null);
                                                        }}
                                                        onContextMenuShow={(rect) => {
                                                            setReactionTooltip({ emoji, names: reactorNames, rect });
                                                        }}
                                                    />
                                                );
                                            })}
                                        </div>
                                    )}

                                    {/* Instant send: this message never reached the server. It
                                        stays in the feed rather than vanishing; Retry re-sends
                                        the same content, Delete drops it (local only). */}
                                    {msg.send_state === 'failed' && (
                                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 mt-1 text-[12px] text-cl-flash" role="status">
                                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                            <span>Not delivered{msg.send_error ? ` — ${msg.send_error}` : ''}</span>
                                            <button
                                                type="button"
                                                onClick={(e) => { e.stopPropagation(); retrySend(msg); }}
                                                className="ml-1 inline-flex items-center gap-1 font-semibold text-cl-text hover:underline focus-visible:underline outline-none"
                                            >
                                                <RotateCcw className="w-3 h-3" /> Retry
                                            </button>
                                            <span className="text-cl-faint" aria-hidden>·</span>
                                            <button
                                                type="button"
                                                onClick={(e) => { e.stopPropagation(); discardUnsent(msg); }}
                                                className="text-cl-muted hover:text-cl-text hover:underline focus-visible:underline outline-none"
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    )}
                                </div>

                                {/* Discord-style: no right-side avatar — every row is left-aligned. */}

                                {/* Floating action menu — always above the row, anchored to the right edge.
                                    For server channels the menu always shows (Reply/Edit/Delete work regardless
                                    of reaction permission). For DMs/groups it requires friendship/membership. */}
                                {hoveredMsgId === msg.id && !isUnconfirmedSend(msg) && (isServerChannel || isFriend || activeChat?.type === 'group') && (
                                    <div
                                        className={`msgbar absolute ${showHeader ? '-top-11' : '-top-9'} right-14 z-30`}
                                        onClick={(e) => e.stopPropagation()}
                                        onMouseEnter={() => {
                                            // Mouse reached the menu — cancel the leave timer so the menu stays open.
                                            if (hoverLeaveTimerRef.current) clearTimeout(hoverLeaveTimerRef.current);
                                        }}
                                        onMouseLeave={() => {
                                            // Mouse left the menu without clicking — start leave timer.
                                            if (hoverLeaveTimerRef.current) clearTimeout(hoverLeaveTimerRef.current);
                                            hoverLeaveTimerRef.current = setTimeout(() => setHoveredMsgId(null), 200);
                                        }}
                                    >
                                        {/* React button — hidden when ADD_REACTIONS is denied on this channel */}
                                        {(isServerChannel ? canReactServer : (isFriend || activeChat?.type === 'group')) && (
                                            <MsgBarBtn
                                                icon={<SmilePlus />}
                                                label="React"
                                                onClick={(e) => { setShowEmojiPicker(msg.id); setReactionPickerAnchor(e.currentTarget); }}
                                            />
                                        )}
                                        <MsgBarBtn
                                            icon={<Reply />}
                                            label="Reply"
                                            onClick={() => { setEditingId(null); setInputText(''); setReplyingId(msg.id); setTimeout(() => { if (inputRef.current) { inputRef.current.style.height = 'auto'; inputRef.current.focus(); } }, 0); }}
                                        />
                                        {/* Pin.
                                            Channel: SERVER-BACKED and shared with everyone in the
                                            server. Requires MANAGE_MESSAGES (the API enforces the
                                            same), keeps the message out of the retention sweep, and
                                            counts toward the server's storage quota. There used to be
                                            a separate amber "Server Save" button here that hit this
                                            exact endpoint while Pin only wrote a client-only
                                            bookmark — two buttons, one of which silently did nothing
                                            for anyone else. Pin is now the single affordance and
                                            Server Save is gone.
                                            DM/group: still a local bookmark; there is no shared-pin
                                            concept for an E2EE DM, so nothing to sync. */}
                                        {(isTextLike || (msg.content?.type === 'attachment' && attId)) &&
                                         canPinInThisChat && (
                                            <MsgBarBtn
                                                icon={<Pin />}
                                                label={
                                                    pinnedMsgIds.includes(msg.id)
                                                        ? (activeChannel ? 'Unpin — stays saved to the server' : 'Unpin')
                                                        : activeChannel
                                                            ? 'Pin — visible to everyone, also saves it to the server'
                                                            : 'Pin'
                                                }
                                                active={pinnedMsgIds.includes(msg.id)}
                                                warm={!!activeChannel}
                                                onClick={() => {
                                                    const isPinned = pinnedMsgIds.includes(msg.id);
                                                    if (isPinned) {
                                                        onUnpinMessage(msg.id);
                                                    } else {
                                                        onPinMessage(msg.id);
                                                        if (!activeChannel) {
                                                            // DM: also save to retention for offline access
                                                            if (isTextLike) retention.saveMessage(msg.id);
                                                            else if (msg.content?.type === 'attachment' && attId) {
                                                                retention.saveAttachment(attId);
                                                                ensureAttachmentCached(msg);
                                                            }
                                                        }
                                                    }
                                                    setHoveredMsgId(null);
                                                }}
                                            />
                                        )}
                                        {/* Save to server — channel only, SAVE_MESSAGES. Its own
                                            action next to Pin: a saved message never expires and
                                            counts toward server storage, but is not pinned. Every
                                            pinned message is saved and can't be unsaved until it is
                                            unpinned, so a pinned one shows a disabled "Saved (pinned)"
                                            whose tooltip says so. Gating shared with the context menu
                                            via serverSaveActionFor → messageMenuGating. */}
                                        {(isTextLike || (msg.content?.type === 'attachment' && attId)) && (() => {
                                            const action = serverSaveActionFor(msg.id);
                                            if (action === 'hidden') return null;
                                            if (action === 'pinned') {
                                                return (
                                                    <MsgBarBtn
                                                        icon={<Archive />}
                                                        label="Saved (pinned) — Unpin first to remove it from the server"
                                                        active
                                                        warm
                                                        disabled
                                                        onClick={() => { /* disabled — unpin first */ }}
                                                    />
                                                );
                                            }
                                            const isSaved = action === 'unsave';
                                            return (
                                                <MsgBarBtn
                                                    icon={<Archive />}
                                                    label={isSaved
                                                        ? 'Remove from server — it will be deleted 30 days after it was sent'
                                                        : 'Save to server — keep it permanently instead of deleting it after 30 days'}
                                                    active={isSaved}
                                                    warm
                                                    onClick={() => {
                                                        if (isSaved) onServerUnsaveMessage?.(msg.id);
                                                        else onServerSaveMessage?.(msg.id);
                                                        setHoveredMsgId(null);
                                                    }}
                                                />
                                            );
                                        })()}
                                        {/* Save / unsave — text, invite, and attachment messages.
                                            `saved` ALONE drives the active state/stroke — this is
                                            the personal "Save for me" (retention-exemption) action,
                                            distinct from Pin and from the channel "Save to server"
                                            button above, which has its own icon/active state now
                                            (SAVE_MESSAGES). Used to also key off
                                            `pinnedMsgIds.includes(msg.id)` so a pinned message showed
                                            as saved here too; that's redundant now, not a behaviour
                                            change to drop: pinning a DM/group message ALSO calls
                                            retention.saveMessage()/saveAttachment() (both at the local
                                            click site above and in Dashboard.tsx's incoming-pin-op
                                            sync, which does the same for a pin that arrived from
                                            another device — "a pin means save-forever"), so `saved`
                                            already reflects a DM pin. For a channel, pinning does NOT
                                            imply this personal save (the `if (!activeChannel)` guard
                                            above skips it) — but the channel case now has its own
                                            "Save to server" button/state, so this one no longer needs
                                            to borrow the pin state to communicate that. */}
                                        {(isTextLike || (msg.content?.type === 'attachment' && attId)) && (
                                            <MsgBarBtn
                                                icon={<Save strokeWidth={saved ? 2.5 : 2} />}
                                                label={saved ? 'Remove from my saves' : 'Save for me'}
                                                active={saved}
                                                onClick={() => {
                                                    if (isTextLike) {
                                                        saved ? retention.unsaveMessage(msg.id) : retention.saveMessage(msg.id);
                                                    } else if (attId) {
                                                        if (saved) {
                                                            retention.unsaveAttachment(attId);
                                                            deleteEncryptedAttachment(attId);
                                                        } else {
                                                            retention.saveAttachment(attId);
                                                            ensureAttachmentCached(msg);
                                                        }
                                                    }
                                                }}
                                            />
                                        )}
                                        {isMe && msg.content?.type === 'text' && (
                                            <MsgBarBtn icon={<Edit2 />} label="Edit" onClick={() => startEdit(msg)} />
                                        )}
                                        {(isMe || (canManageMessages && !isMe)) && (
                                            <MsgBarBtn
                                                icon={<Trash2 />}
                                                label={isMe ? 'Delete — Shift to skip prompt' : 'Delete (moderator) — Shift to skip prompt'}
                                                danger
                                                onClick={(e) => {
                                                    // `detail === 0` is how the DOM distinguishes a click
                                                    // the browser synthesised from Enter/Space on a focused
                                                    // button from a real pointer click. Recorded so the
                                                    // policy table can see both paths; `shiftKey` is set on
                                                    // BOTH, which is what makes the bypass keyboard-reachable.
                                                    const activation: DeleteActivation = {
                                                        entryPoint: e.detail === 0 ? 'msgbar-keyboard' : 'msgbar-mouse',
                                                        shiftKey: e.shiftKey,
                                                    };
                                                    requestDelete(msg, activation, isMe);
                                                }}
                                            />
                                        )}
                                    </div>
                                )}

                                {/* Full emoji picker — reaction mode (portal, above anchor button) */}
                                {showEmojiPicker === msg.id && reactionPickerAnchor && (
                                    <EmojiPickerPopover
                                        anchorEl={reactionPickerAnchor}
                                        customEmojis={serverEmojis}
                                        token={token}
                                        onEmojiSelect={(emoji) => {
                                            const key = emojiSelectionToToken(emoji);
                                            if (key) handleAddReaction(msg.id, key);
                                            setShowEmojiPicker(null);
                                            setReactionPickerAnchor(null);
                                        }}
                                        onClose={() => { pickerJustClosedRef.current = true; setShowEmojiPicker(null); setReactionPickerAnchor(null); }}
                                    />
                                )}
                            {/* Read receipt — INSIDE the message's own content column, as its
                                last child, so it trails the message the way `(edited)` does
                                rather than floating at the far right edge of the pane.
                                Previously this was a sibling AFTER the row with
                                `justify-end`, which pinned it to the pane's right margin and
                                left it visually detached from the message it describes.
                                Placing it in the column also means it inherits the same left
                                offset as the text and the reactions automatically, and works
                                for EVERY message variant — the column wraps text,
                                attachments and invites alike, so this needs no per-type
                                branch. `lastSeenMsgIndex` is already scoped to your own
                                messages in a DM, so it can only ever appear where it makes
                                sense. */}
                            {index === lastSeenMsgIndex && showReadReceipts && (
                                <span className="text-[11px] text-cl-faint select-none mt-0.5">Seen</span>
                            )}
                            </div>
                            </React.Fragment>
                        );
                        }} />
                        );
                        });
                    })()}
                    </div>
                )}
                </div>
                <div className="shrink-0" style={{ height: composerH + 16 }} />
            </div>

            {/* Right-click message menu — portalled to body by the shared
                ContextMenu primitive (see handleContextMenu above for the
                item-building logic). */}
            {msgContextMenu.menu}

            {/* Jump-to-bottom button — top-centre, only after scrolling far up */}
            {showScrollBtn && (
                <ClButton
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                        followBottomRef.current = true;
                        isAtBottomRef.current   = true;
                        setShowScrollBtn(false);
                        const _jEl = feedRef.current;
                        if (_jEl) {
                            _jEl.scrollTop                = _jEl.scrollHeight;
                            lastKnownScrollTopRef.current = _jEl.scrollHeight - _jEl.clientHeight;
                            lastSnapBottomRef.current     = _jEl.scrollHeight - _jEl.clientHeight;
                        }
                    }}
                    tooltip="Jump to latest"
                    style={{ position: 'absolute', top: 64, left: '50%', transform: 'translateX(-50%)', zIndex: 40, borderRadius: 999, padding: '6px 12px', fontSize: 12, gap: 6 }}
                    className="msg-menu-enter shadow-lg"
                >
                    <ChevronDown className="w-3.5 h-3.5" />
                    Jump to latest
                </ClButton>
            )}

            {/* Input Controller - Floating */}
            <div ref={composerWrapRef} className="absolute bottom-4 left-4 right-4 shrink-0 flex flex-col pointer-events-none z-50">
                {!isFriend && activeChat?.type === 'dm' ? (
                    <div className="flex items-center justify-center gap-3 py-4 px-6 bg-cl-surface border border-white/[0.06] rounded-xl text-center pointer-events-auto shadow-2xl">
                        <UserMinus className="w-4 h-4 text-cl-faint shrink-0" />
                        <p className="text-[13px] text-cl-faint">
                            You are no longer friends with <span className="text-cl-muted font-medium">{activeChat.title}</span>. Send a friend request to message again.
                        </p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-2 pointer-events-auto">
                        {typingUsers.size > 0 ? (
                            <div className="text-[12px] text-cl-muted mb-2 italic pl-4 font-medium h-4 truncate">
                                {(() => {
                                    // Resolve display names. Fall back to "Someone" when the user
                                    // hasn't been hydrated into userIdToUsername yet (e.g. a server
                                    // member who hasn't sent a message this session). The indicator
                                    // still shows — better than disappearing on a name lookup miss.
                                    const names = Array.from(typingUsers).map(
                                        uid => userIdToUsername[uid] ?? 'Someone'
                                    );
                                    const n = names.length;
                                    if (n > 3) return 'Multiple people are typing…';
                                    if (n === 3) return `${names[0]}, ${names[1]}, and ${names[2]} are typing…`;
                                    if (n === 2) return `${names[0]} and ${names[1]} are typing…`;
                                    return `${names[0]} is typing…`;
                                })()}
                            </div>
                        ) : (
                            <div className="h-4" />
                        )}

                        {editingId && (
                            <div className="flex items-center justify-between px-3 py-2 bg-cl-surface border border-cl-lume/30 rounded-[14px] relative">
                                <div className="flex items-center gap-2 text-[13px]">
                                    <Edit2 className="w-4 h-4 text-cl-lume" />
                                    <span className="font-semibold text-cl-lume">Editing Message</span>
                                </div>
                                <ClButton variant="ghost" size="sm" onClick={cancelEdit} style={{ fontSize: 12 }}>✕ Cancel</ClButton>
                            </div>
                        )}
                        {replyingId && (() => {
                            const replyTarget = messages.find(m => m.id === replyingId);
                            const replyText   = displayTextOf(replyTarget?.content) ?? (replyTarget?.content?.type === 'attachment' ? replyTarget?.content?.filename ?? 'Attachment' : 'Message');
                            return (
                                <div className="flex items-center justify-between px-3 py-2 bg-cl-surface border border-[var(--cl-border)] rounded-[14px] relative min-w-0">
                                    <div className="flex items-center gap-2 text-[13px] min-w-0 overflow-hidden">
                                        <CornerUpLeft className="w-4 h-4 text-cl-muted shrink-0" />
                                        <span className="text-cl-muted shrink-0">Replying to</span>
                                        <span className="font-semibold text-cl-text truncate">{replyText}</span>
                                    </div>
                                    <ClButton variant="ghost" size="sm" onClick={() => setReplyingId(null)} style={{ fontSize: 12, gap: 4, flexShrink: 0, marginLeft: 12 }}>
                                        <span>✕</span><span>Cancel</span>
                                    </ClButton>
                                </div>
                            );
                        })()}

                        {/* Composer — DS DesktopChatColumn: the input row is a compact
                            cl-surface pill. Staged files / cooldown / embed notices ride
                            ABOVE it as their own strips. The all-caps "loud" egg warms the
                            pill to glow + inflates it; @everyone trembles the send plane;
                            3× empty send crashes the plane and quips the placeholder. */}
                        <div className={`flex flex-col gap-1.5 relative z-10 w-full ${!canSend ? 'opacity-70' : ''}`}>
                            {stagedFiles.length > 0 && (
                                <div className="flex gap-2.5 flex-wrap px-0.5 pb-0.5">
                                    {stagedFiles.map((f, i) => {
                                        const isImage = f.type.startsWith('image/');
                                        const isVideo = f.type.startsWith('video/');
                                        const isMedia = isImage || isVideo;
                                        // getOrCreateStagedUrl returns the SAME blob URL on every re-render
                                        // for the same File object — progress updates no longer reload the video.
                                        const objUrl = getOrCreateStagedUrl(f);
                                        const pct = uploadProgress[f.name];
                                        const uploading = pct !== undefined;

                                        const closeBtn = !uploading && (
                                            <button
                                                type="button"
                                                onClick={(e: React.MouseEvent) => { e.preventDefault(); removeStagedFile(i); }}
                                                title="Remove"
                                                className="absolute top-1.5 right-1.5 z-20 flex items-center justify-center w-[22px] h-[22px] rounded-full bg-black/55 text-white/80 opacity-0 group-hover:opacity-100 transition-all duration-150 hover:bg-black/75 hover:text-white active:scale-90"
                                                style={{ backdropFilter: 'blur(6px)' }}
                                            >
                                                <X className="w-3.5 h-3.5" strokeWidth={2.6} />
                                            </button>
                                        );

                                        const uploadOverlay = uploading && (
                                            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 bg-black/55" style={{ backdropFilter: 'blur(2px)' }}>
                                                {pct === 0 ? (
                                                    <span className="text-[10px] font-medium text-white/80 tracking-wide animate-pulse">{uploadLabels[f.name] ?? ENCRYPTING_POOL[0]}</span>
                                                ) : (
                                                    <>
                                                        <span className="text-[12px] font-bold text-cl-lume tabular-nums">{pct}%</span>
                                                        <div className="w-14 h-1 rounded-full overflow-hidden bg-white/15">
                                                            <div className="h-full bg-cl-lume rounded-full transition-[width] duration-300 ease-out" style={{ width: `${pct}%` }} />
                                                        </div>
                                                    </>
                                                )}
                                            </div>
                                        );

                                        if (isMedia) {
                                            return (
                                                <div key={i} className="group relative overflow-hidden rounded-2xl border border-white/10 bg-black/30 shadow-[0_2px_8px_rgba(0,0,0,.25)]" style={{ width: 100, height: 100 }}>
                                                    {isVideo ? (
                                                        <video src={`${objUrl!}#t=0.001`} className="w-full h-full object-cover" preload="metadata" />
                                                    ) : (
                                                        <img src={objUrl!} alt={f.name} className="w-full h-full object-cover" />
                                                    )}
                                                    {isVideo && !uploading && (
                                                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                                            <div className="flex items-center justify-center w-9 h-9 rounded-full bg-black/45" style={{ backdropFilter: 'blur(6px)' }}>
                                                                <Play className="w-4 h-4 text-white fill-white ml-[1px]" />
                                                            </div>
                                                        </div>
                                                    )}
                                                    {/* bottom scrim + size */}
                                                    {!uploading && (
                                                        <>
                                                            <div className="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-black/65 to-transparent pointer-events-none" />
                                                            <span className="absolute bottom-1.5 left-2 text-[9.5px] font-semibold tracking-wide text-white/85 pointer-events-none">{formatStagedSize(f.size)}</span>
                                                        </>
                                                    )}
                                                    {closeBtn}
                                                    {uploadOverlay}
                                                </div>
                                            );
                                        }

                                        return (
                                            <div key={i} className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-white/10 bg-cl-deep p-3 shadow-[0_2px_8px_rgba(0,0,0,.25)]" style={{ width: 158, height: 100 }}>
                                                <div className="flex items-center justify-center w-9 h-9 rounded-xl shrink-0" style={{ background: 'var(--cl-lume-tint)' }}>
                                                    <FileText className="w-[18px] h-[18px] text-cl-lume" />
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="text-[12px] font-semibold text-white/90 truncate leading-tight">{f.name}</p>
                                                    <p className="text-[10px] text-white/40 mt-0.5">{formatStagedSize(f.size)}</p>
                                                </div>
                                                {closeBtn}
                                                {uploadOverlay}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {/* Rate-limit warning strip */}
                            {cooldownSecs > 0 && (
                                <div className="mx-2 mb-1 px-3 py-1.5 rounded-lg bg-cl-glow/10 border border-cl-glow/20 flex items-center gap-2">
                                    <span className="text-cl-glow text-[11px] font-semibold">⚡ Slow down</span>
                                    <span className="text-cl-glow/70 text-[11px]">— you can send again in {cooldownSecs}s</span>
                                </div>
                            )}

                            {/* EMBED_LINKS denial warning — visible when the input contains a URL
                                but the user lacks the permission for this channel. Styled as a
                                soft amber notice (same visual language as the cooldown strip
                                above) rather than a hard red error — this is a soft block, not
                                a failure, and removing the URL clears it. */}
                            {blockedByEmbed && (
                                <div className="mx-2 mb-1 px-3 py-2 rounded-xl bg-cl-glow/[0.08] border border-cl-glow/20 flex items-center gap-2.5">
                                    <Lock className="w-3.5 h-3.5 text-cl-glow/80 shrink-0" />
                                    <div className="flex-1 min-w-0 leading-tight">
                                        <p className="text-[11.5px] font-semibold text-cl-glow">No link permission</p>
                                        <p className="text-[10.5px] text-cl-glow/55 mt-0.5">
                                            You can't send links in this channel. Remove the URL to send your message.
                                        </p>
                                    </div>
                                </div>
                            )}

                            <form
                                onSubmit={handleSendAll}
                                className="cl-composer"
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    // The composer FLOATS over the feed (absolute, bottom-4), so its own
                                    // fill is the only thing hiding scrolled messages. The disabled look
                                    // (key-wait / cooling-off / no SEND_MESSAGES) must therefore be OPAQUE:
                                    // a bare rgba(255,255,255,.02) let message text show straight through.
                                    // Dimmed tint layered over a solid base keeps the look, loses the leak.
                                    background: !canSend
                                        ? 'linear-gradient(rgba(255,255,255,.02), rgba(255,255,255,.02)), var(--cl-deep)'
                                        : 'var(--cl-surface)',
                                    border: `1.5px solid ${
                                        !canSend ? 'rgba(255,255,255,.05)'
                                            : loudInput ? 'var(--cl-glow)'
                                                : composerFocused ? 'var(--cl-lume)'
                                                    : 'var(--cl-border)'
                                    }`,
                                    borderRadius: 26,
                                    padding: '6px 6px 6px 8px',
                                    boxShadow: loudInput
                                        ? '0 0 16px rgba(255,201,77,.28)'
                                        : '0 2px 12px rgba(0,0,0,.22)',
                                    transition: 'border-color .18s ease',
                                    transform: loudInput ? 'scale(1.012)' : 'none',
                                    animation: boxTremble ? 'cl-fshake .27s ease 3' : 'none',
                                }}
                            >
                                <input type="file" multiple ref={fileInputRef} className="hidden" onChange={(e) => { if (!canAttach) return; handleFileSelect(e); }} />

                                {canAttach && canSend && (
                                    <button ref={clipRef} type="button" className="cmp-ico" onClick={() => fileInputRef.current?.click()} disabled={sending || cooldownSecs > 0} title="Attach File">
                                        <Paperclip className="w-[18px] h-[18px]" />
                                    </button>
                                )}

                                <textarea
                                    data-chat-input
                                    placeholder={
                                        keyMissing
                                            ? (channelKeyCoolingOff
                                                ? "Couldn't install channel key — retrying automatically…"
                                                : 'Waiting for channel keys — they arrive automatically…')
                                            : !canSend
                                                ? "You don't have permission to send messages in this channel"
                                                : stagedFiles.length > 0
                                                    ? 'Add a caption…'
                                                    : isSelfChat ? 'Message yourself…' : 'Message…'
                                    }
                                    value={inputText}
                                    onChange={handleInputTyping}
                                    onFocus={() => setComposerFocused(true)}
                                    onBlur={() => setComposerFocused(false)}
                                    onPaste={handlePaste}
                                    disabled={sending || cooldownSecs > 0 || !canSend}
                                    ref={inputRef}
                                    autoFocus
                                    maxLength={MAX_TEXT_MESSAGE_LENGTH}
                                    className={`flex-1 min-w-0 bg-transparent border-none outline-none ring-0 text-[14.5px] font-medium resize-none [&::-webkit-scrollbar]:hidden [scrollbar-width:none] ${cooldownSecs > 0 ? 'text-white/30' : 'text-white/90'} ${!canSend ? 'cursor-not-allowed placeholder-white/30 italic' : 'placeholder-white/25'}`}
                                    rows={1}
                                    style={{ display: 'block', padding: '2px 4px', lineHeight: '22px', minHeight: 22, maxHeight: 260, overflowY: 'auto', outline: 'none', outlineWidth: 0, boxShadow: 'none', border: 0, background: 'transparent', WebkitAppearance: 'none', appearance: 'none', WebkitBoxShadow: 'none' as any }}
                                    onKeyDown={(e) => {
                                        if (mentionSuggestions.length > 0) {
                                            if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedMentionIdx(i => nextSuggestionIndex(i, mentionSuggestions.length, 'up')); return; }
                                            if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedMentionIdx(i => nextSuggestionIndex(i, mentionSuggestions.length, 'down')); return; }
                                            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); insertMentionSuggestion(mentionSuggestions[selectedMentionIdx]); return; }
                                        }
                                        if (emojiSuggestions.length > 0) {
                                            if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedSuggestionIdx(i => nextSuggestionIndex(i, emojiSuggestions.length, 'up')); return; }
                                            if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedSuggestionIdx(i => nextSuggestionIndex(i, emojiSuggestions.length, 'down')); return; }
                                            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); insertEmojiSuggestion(emojiSuggestions[selectedSuggestionIdx]); return; }
                                        }
                                        // Up on an empty composer edits your last message
                                        // (Discord/Slack/iMessage convention). Every guard
                                        // lives in shouldOpenEditorOnArrowUp — when it says no
                                        // we fall through WITHOUT preventDefault so the
                                        // textarea keeps Up as an ordinary caret key. The two
                                        // suggestion-menu blocks above already claimed Up and
                                        // returned, so reaching here means no menu is open.
                                        if (e.key === 'ArrowUp') {
                                            const ta = e.currentTarget;
                                            const candidate = findLastEditableOwnMessage(messages, {
                                                myUserId: user?.user_id,
                                                myDeviceIds,
                                            });
                                            const open = shouldOpenEditorOnArrowUp({
                                                composerText: inputText,
                                                selectionStart: ta.selectionStart ?? 0,
                                                selectionEnd: ta.selectionEnd ?? 0,
                                                isEditing: !!editingId,
                                                isReplying: !!replyingId,
                                                hasOpenSuggestions: mentionSuggestions.length > 0 || emojiSuggestions.length > 0,
                                                stagedFileCount: stagedFiles.length,
                                                modifiers: {
                                                    shiftKey: e.shiftKey, ctrlKey: e.ctrlKey,
                                                    altKey: e.altKey, metaKey: e.metaKey,
                                                },
                                                hasEditableCandidate: !!candidate,
                                            });
                                            if (open && candidate) {
                                                e.preventDefault();
                                                startEdit(candidate);
                                            }
                                            return;
                                        }
                                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendAll(e); }
                                    }}
                                />

                                {emojiSuggestions.length > 0 && inputRef.current && (
                                    <SuggestionMenu
                                        anchorEl={inputRef.current}
                                        sectionLabel="Emoji"
                                        selectedIndex={selectedSuggestionIdx}
                                        items={emojiSuggestions.map((s): SuggestionMenuItem => ({
                                            key: s.id,
                                            icon: s.custom ? (
                                                <EmojiImage
                                                    name={s.name}
                                                    serverId={emojiServerId}
                                                    attachmentId={s.custom.attachmentId}
                                                    keyB64={s.custom.keyB64}
                                                    nonceB64={s.custom.nonceB64}
                                                    token={token}
                                                    className="w-5 h-5"
                                                />
                                            ) : (
                                                <span className="text-[16px] leading-none">{s.native}</span>
                                            ),
                                            label: `:${s.name.toLowerCase()}:`,
                                            hint: s.custom ? resolveCustomEmojiHint(emojiServerId, servers) : undefined,
                                            onSelect: () => insertEmojiSuggestion(s),
                                        }))}
                                    />
                                )}

                                {mentionSuggestions.length > 0 && inputRef.current && (() => {
                                    // Two members can share a display name — usernames aren't
                                    // globally unique, only (username, discriminator) is (see
                                    // packages/shared/user.ts), and a nickname can equal someone
                                    // else's username — so two rows can otherwise render as
                                    // identical, unusable "@Dawson" / "@Dawson".
                                    // describeMentionUserRow shows the nickname as the primary
                                    // label with the username beside it, and adds the
                                    // discriminator ONLY to rows that would still look alike,
                                    // among the `user` rows currently visible in this list.
                                    return (
                                    <SuggestionMenu
                                        anchorEl={inputRef.current}
                                        sectionLabel="Members"
                                        selectedIndex={selectedMentionIdx}
                                        items={mentionSuggestions.map((s): SuggestionMenuItem => {
                                            const isSpecial = s.type === 'everyone' || s.type === 'here';
                                            const isRole = s.type === 'role';
                                            const userText = s.type === 'user' ? describeMentionUserRow(s, mentionSuggestions) : null;
                                            const hint = isSpecial
                                                ? (s.type === 'everyone' ? 'Notify all members' : 'Notify online members')
                                                : isRole
                                                    ? 'Role'
                                                    : userText?.secondary;
                                            return {
                                                key: `${s.type}-${s.id}`,
                                                icon: isSpecial ? (
                                                    <span className="w-5 h-5 rounded-full bg-cl-lume/20 flex items-center justify-center shrink-0 text-[11px] font-bold text-cl-lume">@</span>
                                                ) : isRole ? (
                                                    <span className="w-5 h-5 rounded-full flex items-center justify-center shrink-0" style={{ background: s.color ? `${s.color}33` : 'rgba(255,255,255,0.08)' }}>
                                                        <span className="w-2 h-2 rounded-full" style={{ background: s.color ?? 'rgba(255,255,255,0.4)' }} />
                                                    </span>
                                                ) : (
                                                    // Real encrypted avatar when present; when the user
                                                    // has none, EncryptedAvatar's own fallback (deterministic
                                                    // userColor() backdrop + person-glyph) kicks in — the
                                                    // same fallback every other member row in the app uses
                                                    // (ServerContextPanel, ParticipantCard), so a user without
                                                    // an avatar looks identical here and everywhere else.
                                                    // Decorative only in this dropdown (disableClickProfile)
                                                    // so clicking it inserts the mention instead of opening
                                                    // a profile. bypassFriendGate matches every other
                                                    // member-list row: you already share a server/conversation
                                                    // with this person.
                                                    <EncryptedAvatar
                                                        attachmentId={s.avatarId ?? null}
                                                        userId={s.id}
                                                        token={token}
                                                        className="w-5 h-5"
                                                        fallbackSize={11}
                                                        bypassFriendGate
                                                        disableClickProfile
                                                    />
                                                ),
                                                label: `@${userText ? userText.primary : s.label}`,
                                                hint,
                                                onSelect: () => insertMentionSuggestion(s),
                                            };
                                        })}
                                    />
                                    );
                                })()}

                                <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                                    {keyMissing && (
                                        <button
                                            ref={keyHelpButtonRef}
                                            type="button"
                                            className="cmp-ico"
                                            onClick={() => setShowKeyHelpPopover(v => !v)}
                                            title="Why can't I send yet?"
                                        >
                                            <HelpCircle className="w-[18px] h-[18px]" />
                                        </button>
                                    )}
                                    {showKeyHelpPopover && keyHelpButtonRef.current && createPortal(
                                        (() => {
                                            const r = keyHelpButtonRef.current!.getBoundingClientRect();
                                            return (
                                                <div
                                                    ref={keyHelpPopoverRef}
                                                    style={{
                                                        position: 'fixed',
                                                        bottom: window.innerHeight - r.top + 8,
                                                        right: window.innerWidth - r.right,
                                                        zIndex: 9999,
                                                        width: 280,
                                                    }}
                                                    className="bg-cl-raise border border-white/[0.08] rounded-xl p-3 shadow-2xl"
                                                >
                                                    <div className="flex items-center gap-2 mb-1.5">
                                                        <Lock className="w-3.5 h-3.5 text-cl-lume shrink-0" />
                                                        <span className="text-[12.5px] font-semibold text-cl-text">
                                                            {channelKeyCoolingOff ? "Couldn't install channel key" : 'Waiting for channel keys'}
                                                        </span>
                                                    </div>
                                                    {channelKeyCoolingOff ? (
                                                        <p className="text-[11.5px] leading-relaxed text-white/60">
                                                            The key arrived but couldn't be installed after a few tries —
                                                            usually a temporary hiccup on the sending device's end.
                                                            Cipherline will automatically request it again shortly; no
                                                            action needed.
                                                        </p>
                                                    ) : (
                                                    <p className="text-[11.5px] leading-relaxed text-white/60">
                                                        This channel is end-to-end encrypted with a key only members'
                                                        devices hold — the server never sees it. Your device hasn't
                                                        received it yet, which happens if you're new here, just joined,
                                                        or were just given access to this channel.
                                                    </p>
                                                    )}
                                                    {!channelKeyCoolingOff && (
                                                    <p className="text-[11.5px] leading-relaxed text-white/60 mt-1.5">
                                                        No action needed — another member's device delivers it
                                                        automatically the moment it's online, and sending unlocks
                                                        right away.
                                                    </p>
                                                    )}
                                                </div>
                                            );
                                        })(),
                                        document.body
                                    )}
                                    {canAttach && canSend && (
                                        <button
                                            ref={gifButtonRef as any}
                                            type="button"
                                            className="cmp-ico"
                                            onClick={() => {
                                                if (!showGifPicker) setGifAnchorRect(gifButtonRef.current?.getBoundingClientRect() ?? null);
                                                setShowGifPicker(v => !v);
                                                setShowInputEmojiPicker(false);
                                            }}
                                            disabled={sending || cooldownSecs > 0}
                                            title="GIF"
                                            style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '-0.02em' }}
                                        >GIF</button>
                                    )}
                                    {showGifPicker && (
                                        <GifPicker
                                            anchorRect={gifAnchorRect}
                                            onGifSelect={async (file) => {
                                                setShowGifPicker(false);
                                                followBottomRef.current = true;
                                                try {
                                                    if (activeChannel) {
                                                        await uploadFileToChannel(file, activeChannel.channel_id);
                                                    } else {
                                                        // claim_otp=1: consume a one-time prekey per recipient device (per-message forward secrecy)
                                                        const devicesRes = await axios.get(`${API_BASE}/conversations/${activeChat.id}/devices?claim_otp=1`, { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } });
                                                        const devices = devicesRes.data as { device_id: string; spk_pub_b64: string }[];
                                                        await uploadFile(file, devices);
                                                    }
                                                } catch (err: any) {
                                                    // This used to be a bare console.error, so every failure mode
                                                    // (upload rejected, size cap, no channel key, offline) looked
                                                    // identical from the user's side: the picker closes and nothing
                                                    // happens. Surface the real reason — a GIF send is a normal
                                                    // message send and deserves the same feedback as one.
                                                    console.error('[GifPicker] Failed to send GIF:', err);
                                                    toast.push({
                                                        kind: 'error',
                                                        title: "Couldn't send GIF",
                                                        message: err?.response?.data?.message || err?.message || 'The upload failed. Please try again.',
                                                    });
                                                }
                                            }}
                                            onKlipySelect={async (ref) => {
                                                setShowGifPicker(false);
                                                followBottomRef.current = true;
                                                try {
                                                    await handleSendKlipyGif(ref);
                                                } catch (err: any) {
                                                    console.error('[GifPicker] Failed to send KLIPY GIF:', err?.message);
                                                    toast.push({
                                                        kind: 'error',
                                                        title: "Couldn't send GIF",
                                                        message: err?.response?.data?.message || err?.message || 'Please try again.',
                                                    });
                                                }
                                            }}
                                            onClose={() => { pickerJustClosedRef.current = true; setShowGifPicker(false); }}
                                        />
                                    )}
                                    {canSend && (
                                        <button ref={emojiButtonRef as any} type="button" className="cmp-ico" onClick={() => { setShowInputEmojiPicker(v => !v); setShowGifPicker(false); }} disabled={sending || cooldownSecs > 0} title="Emoji">
                                            <Smile className="w-[18px] h-[18px]" />
                                        </button>
                                    )}
                                    {showInputEmojiPicker && (
                                        <EmojiPickerPopover
                                            anchorEl={emojiButtonRef.current}
                                            customEmojis={serverEmojis}
                                            token={token}
                                            onEmojiSelect={(emoji) => {
                                                // Same clean-display-form rule as insertEmojiSuggestion: a
                                                // custom pick inserts ":name:" and registers the wire-token
                                                // substitution, rather than putting a raw UUID in the box.
                                                const displayText = emoji.native ?? (emoji.id && emoji.name ? `:${emoji.name}:` : null);
                                                if (!displayText) { setShowInputEmojiPicker(false); return; }
                                                if (!emoji.native && emoji.id && emoji.name) {
                                                    emojiTokenMapRef.current[displayText] = `<:${emoji.name}:${emoji.id}>`;
                                                }
                                                const ta = inputRef.current;
                                                if (ta) {
                                                    const start = ta.selectionStart ?? ta.value.length;
                                                    const end = ta.selectionEnd ?? ta.value.length;
                                                    setInputText(ta.value.slice(0, start) + displayText + ta.value.slice(end));
                                                    requestAnimationFrame(() => { ta.focus(); const pos = start + displayText.length; ta.setSelectionRange(pos, pos); });
                                                } else {
                                                    setInputText(prev => prev + displayText);
                                                }
                                                setShowInputEmojiPicker(false);
                                            }}
                                            onClose={() => { pickerJustClosedRef.current = true; setShowInputEmojiPicker(false); }}
                                        />
                                    )}
                                    {canSend && (() => {
                                        if (cooldownSecs > 0) return (
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, color: 'rgb(251,191,36)', fontWeight: 800, fontSize: 13, flexShrink: 0 }}>
                                                {cooldownSecs}
                                            </div>
                                        );
                                        const isDisabled = blockedByEmbed || sending || (!stagedFiles.length && !inputText.trim());
                                        return (
                                            <button type="submit" disabled={isDisabled} className="cl-send-btn" title={blockedByEmbed ? "Remove the URL to send." : 'Send'}>
                                                <Send ref={sendIcoRef as React.Ref<SVGSVGElement>} className="cl-ico w-[17px] h-[17px]" style={{ marginRight: 1, marginTop: 1 }} />
                                            </button>
                                        );
                                    })()}
                                </div>
                            </form>
                        </div>
                    </div>
                )}
            </div>

            <SafetyVerificationModal
                isOpen={safetyModalOpen}
                onClose={() => setSafetyModalOpen(false)}
                myUserId={myUserId}
                myDeviceId={deviceId}
                remoteUserId={activeChat.other_user_id || ''}
                remoteUsername={activeChat.title || 'User'}
                token={token}
                onResolved={() => { if (activeChat.other_user_id) onKeyChangeResolved?.(activeChat.other_user_id); }}
                // Only offered on a real 1:1 conversation — a safety code
                // commits to ONE account's key set, so "send it here" is only
                // meaningful where there is a single other party to compare it.
                onSendCode={activeChat.type === 'dm' ? handleSendSafetyNumber : undefined}
                // Drives the modal's explicit "Dismiss this warning" action.
                // Now that a warning survives a restart, that action is what
                // guarantees the user can never be stranded with one — the
                // modal's other resolutions all need a live key fetch that is
                // unavailable offline, and absent by definition for the
                // `unattributed` verdict.
                activeWarning={
                    activeChat.other_user_id && keyChangedSenders?.has(activeChat.other_user_id)
                        ? (senderWarnings[activeChat.other_user_id] ?? 'key_changed')
                        : null
                }
            />

            {groupSettingsOpen && activeChat.type === 'group' && (
                <GroupSettingsModal
                    conversationId={activeChat.id}
                    conversationTitle={activeChat.title || 'Group Chat'}
                    avatarUrl={activeChat.avatar_url}
                    onClose={() => setGroupSettingsOpen(false)}
                    onGroupLeft={() => {
                        setGroupSettingsOpen(false);
                        window.location.reload();
                    }}
                />
            )}

            {/* Custom in-app confirm dialog */}
            {confirmDialog && (
                <ConfirmDialog
                    title={confirmDialog.title}
                    message={confirmDialog.message}
                    confirmLabel={confirmDialog.confirmLabel}
                    danger={confirmDialog.danger}
                    onConfirm={confirmDialog.onConfirm}
                    onCancel={() => setConfirmDialog(null)}
                />
            )}

            {/* Message-delete confirmation. Uses the shared primitive (not the
                local ConfirmDialog above) for the house exit animation. No
                message → the compact, centred yes/no layout. */}
            {pendingDelete && (
                <SharedConfirmDialog
                    title={pendingDelete.copy.title}
                    confirmLabel={pendingDelete.copy.confirmLabel}
                    onConfirm={() => { performDelete(pendingDelete.msgId); setPendingDelete(null); }}
                    onCancel={() => setPendingDelete(null)}
                />
            )}

            {/* Reaction "who reacted" tooltip — portal so it's never clipped */}
            {reactionTooltip && createPortal(
                <div
                    style={{
                        position:      'fixed',
                        left:          Math.max(8, Math.min(
                                           reactionTooltip.rect.left + reactionTooltip.rect.width / 2 - 90,
                                           window.innerWidth - 188
                                       )),
                        top:           reactionTooltip.rect.top > 80
                                           ? reactionTooltip.rect.top - 8
                                           : reactionTooltip.rect.bottom + 8,
                        transform:     reactionTooltip.rect.top > 80 ? 'translateY(-100%)' : 'none',
                        zIndex:        9999,
                        background:    'var(--cl-deep)',
                        border:        '1px solid rgba(255,255,255,0.10)',
                        borderRadius:  10,
                        boxShadow:     '0 4px 20px rgba(0,0,0,0.55)',
                        padding:       '8px 12px',
                        minWidth:      120,
                        maxWidth:      220,
                        pointerEvents: 'none',
                    }}
                >
                    <div style={{ fontSize: 22, textAlign: 'center', marginBottom: 4 }}>
                        {renderReactionGlyph(reactionTooltip.emoji, resolveEmoji, token, serverEmojisLoading, noServerEmojiContext)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--cl-faint)', marginBottom: 4, textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Reacted
                    </div>
                    {reactionTooltip.names.map((name, i) => (
                        <div key={i} style={{ fontSize: 13, color: 'var(--cl-text)', padding: '1px 0', textAlign: 'center' }}>
                            {name}
                        </div>
                    ))}
                </div>,
                document.body,
            )}

            {/* Portal: render the pinned panel into the Pane 4 target div in Dashboard.
                This keeps all ChatPane state (objectUrls, deviceToUsername, etc.) available
                while placing the panel visually inside the right-hand context sidebar.
                Works during calls too — the pinned panel appears above the call video/members.

                Gated on `pinnedPanelMounted`, not `pinnedSidebarExpanded` directly, so the
                panel stays portalled for its exit animation (see the state machine above).
                While open, `pinnedPanelElementRef` is refreshed with live props every render;
                once closing starts we stop refreshing it and instead clone the last live
                element with `closing: true` — the fade-out shows exactly what the user had
                open (same scroll position, same in-progress search) rather than snapping to
                whatever the now-closed parent's live props became. */}
            {pinnedPanelMounted && (() => {
                const root = document.getElementById('pinned-panel-root');
                if (pinnedSidebarExpanded) {
                    pinnedPanelElementRef.current = (
                        <PinnedMessagesPanel
                            messages={messages}
                            pinnedMsgIds={pinnedMsgIds}
                            objectUrls={objectUrls}
                            searchQuery={pinnedSearchQuery}
                            onJumpTo={(id) => { onTogglePinnedSidebar(); jumpToMessage(id); }}
                            onUnpin={(id) => onUnpinMessage(id)}
                            /* Channel: server-shared pin, requires MANAGE_MESSAGES — same
                               gate as the Pin/Unpin button in the hover toolbar and context
                               menu above. DM/group: a local bookmark anyone can toggle.
                               canPinInThisChat (canPinMessage, messageMenuGating.ts) is the
                               single source of truth for this exact rule — reuse it instead
                               of re-deriving it inline a third time. */
                            canUnpin={canPinInThisChat}
                            onClose={onTogglePinnedSidebar}
                            deviceToUsername={deviceToUsername}
                            userIdToUsername={userIdToUsername}
                            deviceToAvatar={deviceToAvatar}
                            userIdToAvatar={userIdToAvatar}
                            myDeviceIds={myDeviceIds}
                            token={token}
                            isInline
                            onReport={onReport}
                            closing={false}
                        />
                    );
                }
                if (!root || !pinnedPanelElementRef.current) return null;
                const element = pinnedSidebarExpanded
                    ? pinnedPanelElementRef.current
                    : React.cloneElement(pinnedPanelElementRef.current, { closing: true });
                return createPortal(element, root);
            })()}
        </div>
    );
};

export default ChatPane;
