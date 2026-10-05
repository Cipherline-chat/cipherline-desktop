import secureLocalStore from '../utils/secureLocalStore';
import { mentionsToPlainText } from '../utils/mentionTokens';
import { fetchChannelSaveState, withId, withoutId, asSaveRequestError, type ChannelSaveState } from '../utils/channelServerSaves';
import { quotaExceededMessage } from '../utils/serverStorageCopy';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import FriendsPane from './FriendsPane';
import ChatPane, { messageTextMentionsUser, messageTextMentionsRole } from './ChatPane';
import { CallPane } from './CallPane';
import { useCallsChannelKey } from '../hooks/useCallsChannelKey';
import { resolveCallKeyGate, CALL_KEY_STALL_MS, CALL_KEY_DEGRADED_GRACE_MS } from '../utils/callKeyGate';
import { CallEncryptionIndicator, type CallEncryptionIndicatorMode } from './server/CallEncryptionIndicator';
import { useRealtime, formatDeviceLinkedToast } from '../hooks/useRealtime';
import { generateCallKey } from '../utils/crypto';
import { useRetentionPolicy, type MessageRetention, type AttachmentRetention, type StoragePolicy, getEffectiveMessageRetention, getEffectiveAttachmentRetention } from '../hooks/useRetentionPolicy';
import { useKeybinds } from '../hooks/useKeybinds';
import { useViewEnter } from '../hooks/useViewEnter';
import { useFocusSpansSidebar } from '../hooks/useFocusLayout';
import { useScreenLock } from '../hooks/useScreenLock';
import ScreenLockOverlay from './ScreenLockOverlay';
import UpdateRailTile from './UpdateRailTile';
import { useBackupAutoSchedule } from '../hooks/useBackupAutoSchedule';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { useContextMenu } from '../hooks/useContextMenu';
import { HoverActions } from './primitives/HoverActions';
import { unlockAudioContext } from '../hooks/useParticipantAudio';
import { unlockPendingContexts } from '../utils/audioUnlock';
import { setHasActiveCall } from '../utils/activeCallRegistry';
import { shouldTeardownForCallStatus, shouldKeepRetryingStalenessCheck, type CallStatusResponse } from '../utils/callStalenessPolicy';
import { useGlobalKeybindListener } from '../hooks/useGlobalKeybindListener';
import { useVoiceSettings } from '../hooks/useVoiceSettings';
import { useKeyRotation } from '../hooks/useKeyRotation';
import { clampFutureTimestamp, sweepRetention } from '../utils/retentionSweeper';
import { parseRetentionOverride, pinnedIdsForChannel, serverRetentionKey, sweepPolicyFor } from '../utils/retentionResolve';
import { pageNeedsKeyRequest, splitExpiredIncoming, type IncomingRetention } from '../utils/channelHistoryRetention';
import { attachmentToDeleteWithMessage } from '../utils/attachmentOnDelete';
import { foldChannelHistory, isUndecryptablePlaceholder, coveredServerWindow, pruneVanishedPlaceholders, deletedChannelTargetIds } from '../utils/channelHistoryMerge';
import { splitReusableChannelRows } from '../utils/channelRowReuse';
import { isChannelServeRejection, oldestFirst } from '../utils/channelIntegrity';
import { notePrekeyUsage } from '../utils/prekeyHealth';
import { getPurgedMessageIds, markMessagesPurged } from '../utils/retentionTombstones';
import { markAttachmentsRemoved } from '../utils/removedAttachmentTracker';
import { PurgeConfirmModal } from './PurgeControls';
import { formatLastSeen } from '../utils/formatLastSeen';
import { chatBucket, chatBucketLabel } from '../utils/chatListDividers';
import { computeMissingKeyChannels, computeUnmintedChannels, decideChannelEntryAction, shouldMintAfterKeyRequest, chunkEnvelopes, buildChannelKeyContent, pickJitterMs, resolveEpochClaim, resolveEpochDivergence, computeMissingEpochsForChannel, coalesceKeyRequestEvents, coalesceEnvelopesReadyEvents, decideEnvelopesReadyAction, channelEpochKey, shouldGiveUpOnChannelKey, computeCoolOffUntil, isCoolingOff, computeEpochsToDistribute, channelCarriesSenderKeys, coalesceRotationEvents, decideRotationAction, decideRotationScheduling, computeRotationEpoch, resolveRotationClaim, normalizeRotationReason, type ServerEpochInfo } from '../utils/channelKeyDistribution';
import { HistoryRequestModal } from './HistoryRequestModal';
import { HistorySyncBanner } from './HistorySyncBanner';
import { DeviceStorageSetupModal } from './DeviceStorageSetupModal';
import { useDeviceStorageSetup } from '../hooks/useDeviceStorageSetup';
import { TrialBanner } from './billing/TrialBanner';
import { AnnouncementBanners } from './AnnouncementBanners';
import { KeyProtectionNotice } from './KeyProtectionNotice';
import { EncryptionAtRestNotice } from './EncryptionAtRestNotice';
// “The Descent” full-screen settings (replaced the centered SettingsModal —
// the old component is kept on disk as a reference/fallback, not rendered).
import { SettingsScreen } from './settings/SettingsScreen';
import { OnboardingChecklist } from './OnboardingChecklist';
import { ReferrerFriendOffer } from './signup/ReferrerFriendOffer';
import { ReferralJoinedToast } from './signup/ReferralJoinedToast';
import { FirstWeekNudges } from './FirstWeekNudges';
import { nudges } from '../utils/firstWeekNudgeStore';
import { isUserAuthoredContentType } from '../utils/firstWeekNudges';
import { MascotEmpty } from './MascotEmpty';
import { ProWelcome } from './ProWelcome';
import { useSubscription } from '../contexts/SubscriptionContext';
import { MessageSquare, MessagesSquare, Users, Settings, Search, Server, FolderOpen, Calendar, Plus, PhoneCall, Pin, ChevronDown, Bell, BellOff, BellDot, AtSign, LogOut, User, UserX, UserMinus, CheckCheck, Link as LinkIcon, Trash2, UserPlus, Image as ImageIcon, Gift, Flag, Phone, PhoneOff, PhoneIncoming, AlertTriangle } from 'lucide-react';
import { HomePanel as HomePanelBase } from './HomePanel';
import { memoWithStableCallbacks } from '../utils/memoWithStableCallbacks';
import { pinKey, type PinnedHomeItem } from '../utils/homePins';
import { type LocalCallSession } from '../utils/homeActiveCalls';
import { stepFocusSuspension } from '../utils/callFocusSuspension';
import { saveAvatarKey } from '../utils/avatarKeyStore';
import { EncryptedAvatar } from './EncryptedAvatar';
import { ClButton, ClSearch, ClModal } from './cl';
import { Banner } from './Banner';
import { CloseChatDialog } from './CloseChatDialog';
import { ProfileOpenContext } from '../contexts/ProfileOpenContext';
import { FriendshipContext } from '../contexts/FriendshipContext';
import { CallServerCtx } from '../contexts/CallServerCtx';
import { ReportOpenContext } from '../contexts/ReportOpenContext';
import { useAvatarBroadcast } from '../hooks/useAvatarBroadcast';
import { useAvatarWarming } from '../hooks/useAvatarWarming';
import { useKeyBundleSync } from '../hooks/useKeyBundleSync';
import { useUserStatus, STATUS_CONFIG, type UserStatus } from '../hooks/useUserStatus';
import { selectActiveFriends, resolveActiveStatus } from '../utils/activeNow';
import { useGameSettings } from '../hooks/useGameSettings';
import { usePrivacySettings } from '../hooks/usePrivacySettings';
import { useGifSettings } from '../hooks/useGifSettings';
import { StatusPicker, StatusIcon } from './StatusPicker';
import { useClTooltip } from './cl/useClTooltip';
import { computeTooltipPlacement, type TooltipRect, type TooltipPlacement } from './cl/tooltipPlacement';
import { CreateGroupModal } from './CreateGroupModal';
import { StartDMModal } from './StartDMModal';
import { AddToGroupModal } from './AddToGroupModal';
import { GroupSettingsModal } from './GroupSettingsModal';
import { SoloKickDialog } from './call/SoloKickDialog';
import { FloatingHuddleCard } from './call/FloatingHuddleCard';
import { ProfileModal } from './ProfileModal';
import { ServerChannelList } from './server/ServerChannelList';
import { ServerIcon } from './server/ServerIcon';
import { ServerContextPanel } from './server/ServerContextPanel';
import { CreateServerModal } from './server/CreateServerModal';
import { JoinServerModal } from './server/JoinServerModal';
import { ServerSettingsModal } from './server/ServerSettingsModal';
import { ServerInviteModal } from './server/ServerInviteModal';
import { InvitePreviewModal } from './server/JoinServerModal';
import { ServerMemberOptionsModal, computeServerLocalStats } from './server/ServerMemberOptionsModal';
import { ConvRetentionSection, convRetentionKey } from './ConvRetentionSection';
import {
    DndContext, DragOverlay, PointerSensor,
    useSensor, useSensors,
    type DragEndEvent, type DragStartEvent, type DragOverEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableServerTile } from './rail/SortableServerTile';
import { trackActivity, beginActivity, setFreezeLogView } from '../utils/freezeLog';
import { createCoalescedRunner } from '../utils/coalescedRun';
import { createTaskQueue, type TaskQueue } from '../utils/idleTasks';
import { useServerRailOrder } from './rail/useServerRailOrder';
import { moveServerToRailPosition } from './rail/serverRailOrder';
import { ConfirmDialog } from './primitives/ConfirmDialog';
import { CallProvider, useCallContextSafe, type FocusedStream } from '../contexts/CallContext';
import { useNotificationDispatch } from '../hooks/useNotificationDispatch';
import { useNotificationPrefs } from '../contexts/NotificationContext';
import { playSound, playLoopingSound, type SoundCategory } from '../utils/notificationSounds';
import { computeDnd as computeNotifDnd } from '../hooks/useDndState';
import { useServers, type ChannelInfo, type ServerInfo, type HuddleCallInfo } from '../hooks/useServers';
import { useCoalescedPersist } from '../hooks/useCoalescedPersist';
import { usePersonalSavesSync } from '../hooks/usePersonalSavesSync';
import { useGifLibrarySync } from '../hooks/useGifLibrarySync';
import type { SavesLocalBinding } from '../services/personalSavesSyncEnv';
import { addedSaves, mergeScope } from '../utils/personalSavesSync';
import { withPersonalChannelSaves, attachmentIdsOf } from '../utils/personalChannelSaves';
import * as messageStore from '../utils/messageStore';
import { Permissions, hasPermission } from '@cipherline/shared';
import {
    resolveQuickReplyTarget,
    normalizeQuickReplyText,
    buildQuickReplyContent,
    newClientMsgId,
    describeQuickReplyError,
} from '../utils/quickReply';
import { canOpenServerSettings, type ServerSettingsTab } from '../utils/serverSettingsAccess';
import type { ChannelMessageEvent } from '../hooks/useRealtime';

import { useToast } from '../contexts/ToastContext';
import { writeToClipboard } from '../utils/clipboard';
import { dmGroupRailBadges, serverChannelBadges, clearCountsForIds, resolveBadge, trayBadgeCount, effectiveChannelMode, type BadgeState } from '../utils/unreadBadges';
import { clearCounts, reconcileChannelUnread, shouldAdvanceChannelCursor } from '../utils/channelReadSync';
import { RailBadge } from './RailBadge';
import { IncomingCallWaves } from './call/IncomingCallWaves';
import { useRailMembrane } from './rail/useRailMembrane';
import type { RestBox } from './rail/railMembrane';
import { deriveServerCallPresence, summarizeCallRoster, mergeVoiceUserName, mergeVoiceUserAvatarId, labelVoiceUsers } from '../utils/serverCallPresence';
import { rememberUserName } from '../utils/peerIdentityCache';
import { resolveNotification, type NotifDecision } from '../utils/notificationDecision';
import { fetchWithRetry } from '../utils/fetchWithRetry';
import { useHydration } from '../contexts/HydrationContext';
import { useMascotCue } from '../hooks/useMascotCue';
import { API_BASE } from '../constants';
import { recordFirstSeen, getStoredPub } from '../utils/keyVerification';
import { deriveContactTrust, type ContactTrust } from '../utils/contactTrust';
import { TrustBadge } from './TrustBadge';
import { evaluateSender, actionFor, isWarnable, hasUnverifiedDeviceWarning, type SenderVerdict } from '../utils/senderTrust';
import { loadWarnings, raiseWarning, resolveWarning, snapshotWarnings } from '../utils/senderWarningStore';
import * as directoryKeyWatch from '../utils/directoryKeyWatch';
import * as ownDeviceLedger from '../utils/ownDeviceLedger';
import * as publishedDeviceSets from '../utils/publishedDeviceSets';
import { contactTrustDevices } from '../utils/contactBadgeDevices';
import { OwnDeviceAlert, type OwnDeviceName } from './OwnDeviceAlert';
import * as deviceDirectory from '../utils/deviceDirectory';
import { record as recordDelivery } from '../utils/deliveryDiagnostics';
import { ackMessageEnvelopes } from '../utils/messageAck';
import { encryptAndAddress } from '../utils/encryptAndAddress';
import { isSelfDm, labelSelfConversations, selfConversationTitle, selfMatchesQuery, isSilentIncoming } from '../utils/selfConversation';
import { applyPinOp, applyPinOps, localPinOp, pruneLedger, type PinOp, type PinLedger, ownPinOps } from '../utils/pinSync';
import { canOfferFriendGatedAction, type FriendRelationship } from '../utils/friendGatedActions';
/** Forget an unpinned message's timestamp after this long. Long enough that
 *  a device offline for a fortnight can't resurrect a pin with a stale op. */
const PIN_LEDGER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
import { applyIncomingDmMessages, commitPulledBatch, decryptFailureOutcome, deletedDmTargets, persistIncomingDms, placeholderText, undecryptablePlaceholder, UNDECRYPTABLE_KIND, type PulledForStore } from '../utils/dmInbound';
import { contentProblem } from '../utils/contentValidation';

import { Minus, Square, X, MoreVertical, Info, Volume2 } from 'lucide-react';
import cipherlineMark from '../assets/cipherline-mark.svg';
import { ReportModal } from './ReportModal';
import { SharedContentModal, type SharedTab } from './SharedContentModal';

/** How many `channel:decrypt-message` invokes may be in flight at once from
 *  one history read. See decryptChannelRows for why this is bounded. */
const CHANNEL_DECRYPT_BATCH = 16;
/** PERF: Home re-rendered on EVERY dashboard render (its callbacks are inline
 *  lambdas, so even React.memo never matched) — the second most expensive
 *  component during boot and after a wake. It now re-renders only when the
 *  data it shows changes. See memoWithStableCallbacks. */
const HomePanel = memoWithStableCallbacks(HomePanelBase);
/** Reconnect/wake resync: at most this many of its requests in flight at once,
 *  each start jittered by up to RESYNC_JITTER_MS (see the wsConnectCount
 *  effect). Low enough that the open conversation's refresh is never queued
 *  behind a wall of per-server reloads; high enough that a 10-server account
 *  still resyncs within a few seconds. */
const RESYNC_CONCURRENCY = 3;
const RESYNC_JITTER_MS = 150;

// ── Call transition — full-panel cross-fade ─────────────────────────────────
// Every previous attempt tried to animate the layout SHIFT between the out-of-
// call and in-call states. That fundamentally cannot look clean: the two
// states have different heights, and any visible morph between them looks
// jarring (jumps, blank spaces, content sliding past content).
//
// This implementation never lets the user SEE the layout shift. The entire
// chat-panel content fades to invisible, the layout swaps under cover of
// opacity 0, then fades back in. The transition the user perceives is just:
// "panel fades out → panel fades back in with new content." Same way Spotify
// or Apple Music handles a major view switch.
//
// 180 ms exit + 180 ms enter = 360 ms total.
/** One encrypted channel message row as the API returns it. */
interface RawChannelRow {
    id: string;
    epoch: number;
    nonce_b64: string;
    ciphertext_b64: string;
    signature_b64: string;
    sender_identity_pub_b64?: string | null;
    sender_device_id: string;
    sender_user_id?: string | null;
    created_at: string;
    // Plaintext metadata flag — server validates MENTION_EVERYONE at write
    // time. Used for sleep-resync Phase 4's mention reconciliation, which
    // needs it alongside the decrypted text (see reconcileChannelMentions).
    mentions_everyone?: boolean;
}

/**
 * One recipient device for a channel-key envelope.
 *
 * All four fields are load-bearing. `encryptForDevices` (electron/e2ee-engine.ts)
 * verifies the SPK's Ed25519 signature before ECDH (CRIT-7) and SKIPS any device
 * missing `sig_b64` or `identity_pub_b64` — if every device is skipped it throws,
 * which the caller treats as "no envelopes" and posts nothing. Any endpoint or
 * projection feeding this type must carry all four through.
 */
interface ChannelKeyRecipient {
    user_id: string;
    device_id: string;
    spk_pub_b64: string;
    sig_b64: string;
    identity_pub_b64: string;
}

/** A channel message as the UI stores it, decrypted or placeholder. */
interface StoredChannelMsg {
    id: string;
    /** The decrypted ClientContent union, or the placeholder shape. Left loose:
     *  the merge below folds edits/deletes/reactions by reaching into it, and
     *  narrowing here would mean re-typing that whole reducer. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content: any;
    sender_device_id: string;
    sender_user_id: string | null;
    timestamp: string;
    conversation_id: string;
}

// isUndecryptablePlaceholder and the channel-history fold now live together in
// utils/channelHistoryMerge.ts (imported above) so the reducer that decides
// "insert / apply / upgrade a placeholder in place" can be unit-tested on its
// own. That in-place upgrade is the invariant the envelopes-ready handler
// depends on to refresh a channel WITHOUT dropping its cache.

/** Custom window controls — shown on Linux only since we use native overlay on Windows */
const isMac = navigator.userAgent.toLowerCase().includes('macintosh');
const isWindows = navigator.userAgent.toLowerCase().includes('windows');

const WindowControls: React.FC = () => {
    const [maximized, setMaximized] = React.useState(false);
    React.useEffect(() => {
        const api = window.electronAPI;
        if (!api) return;
        if (typeof api.isMaximized === 'function') {
            api.isMaximized().then(setMaximized).catch(() => {});
        }
        if (typeof api.onMaximizeChange === 'function') {
            return api.onMaximizeChange(setMaximized);
        }
    }, []);
    // Linux only: macOS has native traffic lights, Windows has the native
    // titleBarOverlay (main.ts). Outside Electron there's no window to control.
    if (isMac || isWindows || !window.electronAPI) return null;
    // Backstop against drawing a SECOND set of caption buttons. This is the
    // ground truth for "is Electron already painting native window controls",
    // rather than inferring it from the platform: main.ts scopes
    // titleBarOverlay to win32, but it rendered on Linux too when that was
    // `!== 'darwin'`, putting the native overlay on top of these buttons and
    // leaving this minimise glyph poking out beside it — the stray dash next
    // to the minimize button. Checking the API means re-enabling the overlay
    // on Linux can never silently resurrect that.
    if (navigator.windowControlsOverlay?.visible) return null;
    // Flat caption buttons: fully transparent at rest so the abyss drag bar
    // shows straight through, with a subtle hover (cl-surface for min/maximise,
    // flash for close) for feedback.
    const base: React.CSSProperties = {
        width: 40, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', background: 'transparent', color: 'var(--cl-muted)', cursor: 'pointer',
        borderRadius: 8, padding: 0, transition: 'background .18s, color .18s',
    };
    const hover = (bg: string, fg: string) => ({
        onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => {
            e.currentTarget.style.background = bg; e.currentTarget.style.color = fg;
        },
        onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => {
            e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--cl-muted)';
        },
    });
    return (
        <div className="no-drag flex items-center gap-0.5 shrink-0">
            <button title="Minimize" style={base} onClick={() => window.electronAPI?.minimizeWindow?.()} {...hover('var(--cl-surface)', 'var(--cl-text)')}><Minus size={14} /></button>
            <button title={maximized ? 'Restore' : 'Maximize'} style={base} onClick={() => window.electronAPI?.maximizeWindow?.()} {...hover('var(--cl-surface)', 'var(--cl-text)')}><Square size={11} /></button>
            <button title="Close" style={base} onClick={() => window.electronAPI?.closeWindow?.()} {...hover('var(--cl-flash)', 'var(--cl-on-flash)')}><X size={14} /></button>
        </div>
    );
};

/**
 * Rail tile — 44×44 rounded-square nav tile, verbatim from the Redesign
 * `app.jsx` RailTile. Active tiles sit on the track's sliding lume pill, so
 * their colour flips to `--cl-on-lume`; accent tiles (add-server) read lume.
 * A faint inset top-light gives the unselected tiles their pressed-into-the-
 * deck look. The numeric badge rides the top-right corner with a sink ring.
 */
const RailTile: React.FC<{
    icon?: React.ReactNode;
    label?: string;
    title?: string;
    active?: boolean;
    accent?: boolean;
    badge?: BadgeState | null;
    onClick?: () => void;
}> = ({ icon, label, title, active, accent, badge, onClick }) => {
    const restColor = active ? 'var(--cl-lume)' : accent ? 'var(--cl-lume)' : 'var(--cl-muted)';
    return (
        <button
            onClick={onClick}
            title={title}
            className="no-drag"
            style={{
                position: 'relative', zIndex: 1, width: 44, height: 44, border: 'none',
                background: 'none', cursor: 'pointer', borderRadius: 12, display: 'flex',
                alignItems: 'center', justifyContent: 'center', padding: 0, color: restColor,
                fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 13,
                transition: 'color .2s, background .2s', flex: 'none',
            }}
            onMouseEnter={(e) => {
                if (!active) {
                    e.currentTarget.style.color = 'var(--cl-text)';
                    e.currentTarget.style.background = 'rgba(255,255,255,.06)';
                }
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.color = restColor;
                e.currentTarget.style.background = 'none';
            }}
        >
            {icon || label}
            <RailBadge badge={badge ?? null} />
        </button>
    );
};

/** Brand mark with wiggle + sleep easter egg (click 5× to wiggle; 10× to sleep).
 *  Also answers the `cl:cuttlefish` cue — this mark is always mounted and is
 *  never covered by the modal that emits it, so it's the one mascot guaranteed
 *  to give the egg a visible payoff. */
const Mascot: React.FC<{ onClick: () => void }> = ({ onClick }) => {
    const markRef = useRef<HTMLImageElement>(null);
    const clicksRef = useRef(0);
    const asleepRef = useRef(false);
    // rule 9 — this element is always on screen, and both animations below are
    // WAAPI (no CSS media query to fall back on), so the check has to be here.
    const motionOk = () => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const wiggle = () => {
        const el = markRef.current;
        if (!el || asleepRef.current || !motionOk()) return;
        el.animate([
            { transform: 'rotate(0)' },
            { transform: 'rotate(-8deg)' },
            { transform: 'rotate(7deg)' },
            { transform: 'rotate(-3deg)' },
            { transform: 'rotate(0)' },
        ], { duration: 620, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    };
    useMascotCue(wiggle);
    const handleClick = () => {
        onClick();
        clicksRef.current += 1;
        if (clicksRef.current === 5) wiggle();
        if (clicksRef.current >= 10) {
            const el = markRef.current;
            if (!el || !motionOk()) return;
            asleepRef.current = true;
            el.animate([
                { transform: 'rotate(0) translateY(0)', opacity: '1' },
                { transform: 'rotate(10deg) translateY(3px)', opacity: '0.55' },
            ], { duration: 600, fill: 'forwards', easing: 'ease' });
            setTimeout(() => {
                if (el) el.animate([
                    { transform: 'rotate(10deg) translateY(3px)', opacity: '0.55' },
                    { transform: 'rotate(0) translateY(0)', opacity: '1' },
                ], { duration: 500, fill: 'forwards', easing: 'cubic-bezier(.34,1.56,.64,1)' });
                asleepRef.current = false;
                clicksRef.current = 0;
            }, 3800);
        }
    };
    return (
        <button
            onClick={handleClick}
            title="cipherline"
            className="no-drag"
            style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, display: 'flex', flex: 'none', transition: 'transform .35s var(--cl-spring)' }}
            onMouseEnter={(e) => { if (!asleepRef.current) (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; }}
        >
            <img ref={markRef} src={cipherlineMark} alt="cipherline" width={30} height={24} />
        </button>
    );
};

/**
 * Sunk rail track with the sliding lume indicator (verbatim from `app.jsx`
 * RailTrack). The track is a content-width "deck" recessed into the abyss;
 * the lume pill slides to `activeIndex` (44px tile + 6px gap = 50px step) and
 * scales/fades out when nothing in the track is active (`activeIndex < 0`).
 * The pill lives inside the track so it scrolls in lock-step with the tiles.
 */
const RailTrack: React.FC<{ activeIndex: number; children: React.ReactNode }> = ({ activeIndex, children }) => {
    const track = React.useRef<HTMLDivElement | null>(null);
    const indicator = React.useRef<HTMLSpanElement | null>(null);
    // Hold the last real slot while nothing is active, so the indicator fades
    // out where it was rather than sliding home first.
    const lastActive = React.useRef(0);
    if (activeIndex >= 0) lastActive.current = activeIndex;
    const slot = lastActive.current;

    // ── Geometry is MEASURED, never assumed ──────────────────────────────
    // This used to be `slot * 50` from a hardcoded 44px tile + 6px gap. That
    // is true for the RailTile buttons and FALSE for the server tiles, which
    // render inside a `<div className="relative group">` wrapper rather than
    // as bare flex children — so the indicator drifted further off-centre the
    // further down the rail it went, which is exactly what was reported.
    // Reading the real child box is immune to that and to any future layout
    // change. Child 0 is the indicator itself, so slot N is child N + 1.
    const [rest, setRest] = React.useState<RestBox | null>(null);
    // PERF (freeze fix): this effect used to depend on `children`, which is a
    // fresh element array on EVERY Dashboard render — so every render, for any
    // reason (a message arriving, a presence tick, a fetch landing), re-ran it:
    // it read offsetTop/offsetWidth straight after React's DOM commit, which
    // FORCES a synchronous style + layout of the whole document, and it tore
    // down and rebuilt a ResizeObserver over every tile. Measured with the
    // freeze harness it was the single largest JS-attributed cost at startup
    // (~1.1 s of forced layout across the boot renders), and it ran again on
    // every burst of state updates afterwards.
    //
    // Now it runs when the active slot changes (the only time the indicator
    // must move this frame), and otherwise lets observers report geometry
    // changes: ResizeObserver for any tile/track resize (callbacks run after
    // the browser's own layout, so reading geometry there forces nothing) and
    // a MutationObserver for tiles being added, removed or reordered (a server
    // joined, drag-to-reorder), which re-observes the new children and
    // re-measures on the next frame instead of synchronously.
    React.useLayoutEffect(() => {
        const el = track.current;
        const measure = () => {
            const tile = el?.children[slot + 1] as HTMLElement | undefined;
            if (!tile) return;
            const next = {
                top: tile.offsetTop, left: tile.offsetLeft,
                width: tile.offsetWidth, height: tile.offsetHeight,
            };
            setRest(prev => (prev && prev.top === next.top && prev.left === next.left
                && prev.width === next.width && prev.height === next.height) ? prev : next);
        };
        measure();
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        const observeAll = () => {
            ro.observe(el);
            for (const c of Array.from(el.children)) ro.observe(c);
        };
        observeAll();
        let raf = 0;
        const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
            // Tile set changed. Newly added children need observing; removed
            // ones are dropped by the browser. Re-measure on the next frame,
            // after layout has happened anyway.
            observeAll();
            if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(); });
        });
        mo?.observe(el, { childList: true });
        return () => {
            ro.disconnect();
            mo?.disconnect();
            if (raf) cancelAnimationFrame(raf);
        };
    }, [slot]);

    // Geometry is written straight to the node every frame — see
    // useRailMembrane for why this bypasses React state, and railMembrane.ts
    // for why the integrator is analytic.
    useRailMembrane(indicator, rest ? rest.top : 0, rest);

    const hidden = activeIndex < 0 || !rest;
    return (
        <div className="cl-rail-track" ref={track}>
            <span
                ref={indicator}
                aria-hidden
                className="cl-rail-indicator"
                style={{
                    // The fade-out is the ONLY thing here that may transition:
                    // it is not part of the travel, and runs only when the
                    // track has nothing active at all.
                    transform: hidden ? 'scale(0.6)' : 'none',
                    opacity: hidden ? 0 : 1,
                }}
            />
            {children}
        </div>
    );
};

/**
 * Context-panel option row — verbatim from the DS DesktopContextPanel
 * `OptionRow`: a ghost button (no fill) that warms to cl-surface on hover, or
 * to flash-tint with flash text when `danger`.
 */
const OptionRow: React.FC<{ icon: React.ReactNode; label: string; danger?: boolean; onClick?: () => void }> = ({ icon, label, danger, onClick }) => (
    <button
        onClick={onClick}
        className="no-drag"
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', border: 'none', background: 'none', cursor: 'pointer', padding: '9px 8px', borderRadius: 9, color: danger ? 'var(--cl-flash)' : 'var(--cl-muted)', fontSize: 13.5, fontWeight: 700, fontFamily: 'var(--cl-font-body)' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = danger ? 'var(--cl-flash-tint)' : 'var(--cl-surface)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
        {icon}{label}
    </button>
);

const CONFETTI_COLORS = ['#25E0C8', '#5e8ee0', '#FFC94D', '#4ADE80', '#FF8FB1'];
const CONFETTI_COUNT = 22;
const confettiPieces = Array.from({ length: CONFETTI_COUNT }, (_, i) => ({
    x: (i / CONFETTI_COUNT) * 100,
    delay: (i * 0.06) % 0.8,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    size: 5 + (i % 4) * 2,
    rotation: (i * 47) % 360,
    duration: 1.6 + (i % 5) * 0.2,
}));

/**
 * First friend, ever. Every other celebration in this app fires on a billing
 * or security-setup event — an upgrade, a referral, 2FA, a backup. Nothing
 * marked a human one.
 *
 * Deliberately wordless. Rule 2 allows text only in slots the UI already owns,
 * and a banner conjured to say "you made a friend!" is exactly the floating
 * line the doctrine retired ("Server sealed. Go be weird together."). The
 * confetti IS the payoff, the same way the celebration button's is.
 */
const FirstFriendConfetti: React.FC<{ onDone: () => void }> = ({ onDone }) => {
    React.useEffect(() => {
        const t = setTimeout(onDone, 2600);
        return () => clearTimeout(t);
    }, [onDone]);

    return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9998, pointerEvents: 'none', overflow: 'hidden' }}>
            {confettiPieces.map((p, i) => (
                <motion.div
                    key={i}
                    initial={{ y: -20, opacity: 1 }}
                    animate={{ y: '100vh', opacity: 0, rotate: p.rotation }}
                    transition={{ duration: p.duration + 0.6, delay: p.delay, ease: 'easeIn' }}
                    style={{
                        position: 'absolute',
                        left: `${p.x}%`,
                        top: -12,
                        width: p.size,
                        height: p.size,
                        borderRadius: 2,
                        background: p.color,
                    }}
                />
            ))}
        </div>
    );
};

const ReferralWelcomeBanner: React.FC<{ days: number; onDismiss: () => void }> = ({ days, onDismiss }) => {
    React.useEffect(() => {
        const t = setTimeout(onDismiss, 6000);
        return () => clearTimeout(t);
    }, [onDismiss]);

    return (
        <motion.div
            key="referral-welcome"
            initial={{ y: -80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -80, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            style={{
                position: 'fixed', top: 40,
                left: 0, right: 0, margin: '0 auto',
                width: 380,
                zIndex: 9999, pointerEvents: 'auto',
            }}
        >
            {/* Confetti rain — positioned over the card's width (380 px) */}
            <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 0, overflow: 'visible', pointerEvents: 'none' }}>
                {confettiPieces.map((p, i) => (
                    <motion.div
                        key={i}
                        initial={{ y: -10, opacity: 1 }}
                        animate={{ y: 70, opacity: 0, rotate: p.rotation }}
                        transition={{ duration: p.duration, delay: p.delay, ease: 'easeIn' }}
                        style={{
                            position: 'absolute',
                            left: `${p.x}%`,
                            top: -8,
                            width: p.size,
                            height: p.size,
                            borderRadius: 2,
                            background: p.color,
                        }}
                    />
                ))}
            </div>
            {/* Banner card */}
            <div style={{
                position: 'relative',
                display: 'flex', alignItems: 'center', gap: 14,
                background: 'linear-gradient(135deg, #0B1428 0%, #0e1e38 100%)',
                border: '1px solid rgba(37,224,200,0.35)',
                borderRadius: 16,
                padding: '14px 20px',
                boxShadow: '0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(37,224,200,0.12), 0 0 24px rgba(37,224,200,0.18)',
            }}>
                <div style={{
                    width: 40, height: 40, borderRadius: 12, flexShrink: 0,
                    background: 'rgba(37,224,200,0.12)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    <motion.div
                        animate={{ rotate: [0, -12, 12, -8, 8, 0] }}
                        transition={{ duration: 0.7, delay: 0.3 }}
                    >
                        <Gift size={20} style={{ color: 'var(--cl-lume)' }} />
                    </motion.div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: '#fff', fontWeight: 700, fontSize: 14, fontFamily: 'var(--cl-font-body)' }}>
                        Referral applied!
                    </div>
                    <div style={{ color: 'var(--cl-lume)', fontWeight: 600, fontSize: 13, marginTop: 1 }}>
                        +{days} free trial days added to your account
                    </div>
                </div>
                {/* Auto-dismiss progress bar */}
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, borderRadius: '0 0 16px 16px', overflow: 'hidden' }}>
                    <motion.div
                        initial={{ width: '100%' }}
                        animate={{ width: '0%' }}
                        transition={{ duration: 6, ease: 'linear' }}
                        style={{ height: '100%', background: 'var(--cl-lume)', opacity: 0.5 }}
                    />
                </div>
                <button
                    onClick={onDismiss}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--cl-muted)', flexShrink: 0 }}
                >
                    <X size={15} />
                </button>
            </div>
        </motion.div>
    );
};

interface DashboardProps {
    /** When set, Dashboard immediately shows the InvitePreviewModal for this code. */
    initialDeepLinkInviteCode?: string | null;
    /** The invite was remembered through signup (not a link opened by someone already
     *  signed in) — the join prompt plays its welcome entrance. */
    deepLinkInviteArrival?: boolean;
    onDeepLinkConsumed?: () => void;
}

/**
 * Sits inside <CallProvider> so it can access the call context.
 *
 * SUSPENDS the focused-stream view on tabs that render full-width and
 * therefore have no `#call-focus-root` in the tree — Friends and Home. On
 * those tabs a focused stream has nowhere to paint: FocusedStreamBanner bails
 * because its portal target is missing, and SidebarConference skips the tile
 * too (it assumes the banner owns it), so the participant's video disappeared
 * from the app entirely until you navigated back. Parking the focus instead
 * drops the tile back into the right-hand context panel, which pane 4 keeps
 * mounted for the whole call; leaving restores the same participant + track.
 * The call is never touched — audio and every other tile stay live, because
 * only `focusedStream` (a pure view concern) changes.
 *
 * Home was missing from this list, which is the whole of that bug. The rules
 * live in utils/callFocusSuspension so they're testable without a DOM; this
 * component is just the wiring.
 *
 * The effect runs on every focus change, not only on tab transitions, so a
 * tile focused from the context panel *while* suppressed is parked too rather
 * than being stranded invisible.
 *
 * Nothing here moves or remounts `#call-focus-root` — the portal target keeps
 * the single DOM position aa6cc6d7 gave it, and `focus-banner-enter` still
 * plays exactly once per genuine (un)focus, never on a reparent.
 */
const CallFocusSuppressor = ({ suppressFocus, callActive }: { suppressFocus: boolean; callActive: boolean }) => {
    const callCtx = useCallContextSafe();
    const setFocusedStream = callCtx?.setFocusedStream;
    const focusedStream = callCtx?.focusedStream ?? null;
    const savedFocusRef = React.useRef<FocusedStream | null>(null);

    React.useEffect(() => {
        if (!setFocusedStream) return;
        const next = stepFocusSuspension<FocusedStream>({
            suppressed: suppressFocus,
            callActive,
            current: focusedStream,
            saved: savedFocusRef.current,
        });
        savedFocusRef.current = next.saved;
        if (next.apply !== undefined) setFocusedStream(next.apply);
    }, [suppressFocus, callActive, focusedStream, setFocusedStream]);

    return null;
};

/**
 * DM conversation-list avatar + presence badge, with a "Playing X" hover
 * tooltip via `cl/useClTooltip` (portal + viewport collision handling,
 * replacing the old `group-hover/game-tip` sibling `<span>` that was clipped
 * by the scrolling conversation list and stuck at z-[60]).
 *
 * Extracted out of the conversation-list `.map()` because `useClTooltip` is a
 * hook — calling it directly inside a loop body would call it a different
 * number of times per render as the conversation count changes, which
 * breaks React's rules of hooks. One component instance per row sidesteps
 * that; each row's tooltip gets its own hook instance instead.
 */
const DmAvatarBadge: React.FC<{
    avatarAttachmentId: string | null;
    otherUserId: string;
    token: string | null;
    status: UserStatus;
    currentGame: string | null;
    /** Present on phones only — phone glyph instead of the dot. */
    onMobile?: boolean;
    /** Your own "message yourself" row: no presence dot (it would only ever say you are online). */
    hideStatus?: boolean;
}> = ({ avatarAttachmentId, otherUserId, token, status, currentGame, onMobile, hideStatus }) => {
    const showController = !!currentGame && status !== 'offline' && !onMobile;
    const { anchorProps, tooltip } = useClTooltip(showController ? `Playing ${currentGame}` : undefined, { preferred: 'top' });
    const { ref: tipRef, ...tipHandlers } = anchorProps;

    return (
        // Outer wrapper: relative + no overflow so status dot is never clipped.
        // z-[1] gives it a stacking context above sibling rows; no hover-time
        // elevation is needed any more since the tooltip now portals to
        // <body> instead of painting as a local sibling.
        <div className="w-9 h-9 rounded-full shrink-0 relative z-[1]" ref={tipRef as React.Ref<HTMLDivElement>} {...tipHandlers}>
            {/* Inner: overflow-hidden clips avatar to circle */}
            <div className="w-full h-full rounded-full flex items-center justify-center overflow-hidden">
                <EncryptedAvatar
                    attachmentId={avatarAttachmentId}
                    userId={otherUserId}
                    token={token}
                    className="w-full h-full"
                    fallbackSize={16}
                    disableClickProfile
                />
            </div>
            {/* Status badge — outside overflow:hidden, always visible */}
            {hideStatus ? null : showController ? (
                <span className="absolute bottom-0 right-[-1px] z-10 flex items-center justify-center">
                    <StatusIcon status={status} currentGame={currentGame} size={14} />
                </span>
            ) : (
                <span className="absolute bottom-0 right-0 border-[2px] border-cl-deep rounded-full z-10 flex items-center justify-center">
                    <StatusIcon status={status} currentGame={null} onMobile={onMobile} size={8} />
                </span>
            )}
            {tooltip}
        </div>
    );
};

const Dashboard: React.FC<DashboardProps> = ({ initialDeepLinkInviteCode, deepLinkInviteArrival, onDeepLinkConsumed }) => {
    const { logout, token, deviceId, userId, user, refreshAccessToken, refreshProfile } = useAuth();
    // Stable alias for the signed-in account's id: several callbacks below take a
    // `userId` PARAMETER (the other person) that shadows the auth one, and "is this
    // row me?" must never be answered with the wrong one.
    const authUserId = userId;
    const { bundleReady } = useKeyBundleSync();
    // Hydration bookkeeping: markSettled feeds the first-paint gate,
    // bumpGeneration is what makes previously-failed avatar loads retry.
    const { markSettled, bumpGeneration } = useHydration();
    const toast = useToast();
    const [activeTab, setActiveTab] = useState<'home' | 'dms' | 'groups' | 'servers' | 'files' | 'calendar' | 'friends'>('home');
    const [activeChat, setActiveChat] = useState<{ id: string, title?: string, type?: string, other_user_id?: string, avatar_url?: string } | null>(null);
    const activeChatRef = useRef(activeChat);
    useEffect(() => { activeChatRef.current = activeChat; }, [activeChat]);
    const [listSearch, setListSearch] = useState('');
    const [chatSearch, setChatSearch] = useState('');
    const [pinnedSidebarExpanded, setPinnedSidebarExpanded] = useState(false);
    const togglePinnedSidebar = useCallback(() => {
        setPinnedSidebarExpanded(prev => {
            if (prev) setChatSearch('');
            return !prev;
        });
    }, []);
    /** Ref populated by ChatPane — lets Dashboard call jumpToMessage from the call overlay. */
    const jumpToMessageRef = useRef<((id: string) => void) | null>(null);
    const [conversations, setConversations] = useState<any[]>([]);
    const [messagesState, setMessagesState] = useState<Record<string, any[]>>({});

    // Per-conversation last-activity clock (ms epoch), persisted per account.
    // The server is a blind relay whose conversation records don't track
    // message traffic, and messagesState is in-memory — so without this,
    // "recent" ordering and timestamps reset every launch. Derived by merging
    // the newest in-memory message time per conversation into the stored map.
    /**
     * Guard for the home-screen save effects below.
     *
     * Both slices load with a lazy initializer and write back on every change.
     * If the read yields nothing the state starts empty — and the write-back
     * effect then fires on mount and overwrites the stored value with that
     * empty state, turning a *transient* read miss into permanent loss. That
     * is why home pins survived a session but came back blank after a restart:
     * a locked keystore (StorageLockedScreen) or a single skipped record
     * decrypt is enough to erase them, and the erase is what persists.
     *
     * So: only ever write once we know the store was actually readable. When
     * it isn't, we keep the ciphertext untouched instead of clobbering it —
     * the same stance secureLocalStore.setItem already takes while locked.
     */
    const homePersistReadyRef = useRef(!secureLocalStore.isLocked());
    /** Set once the cache-restore effect has run — see the hidden-conversations
     *  persist effect for why that one can't use an empty-value guard. */
    const hiddenRestoredRef = useRef(false);

    const [lastActivityAt, setLastActivityAt] = useState<Record<string, number>>(() => {
        if (!userId) return {};
        try { return JSON.parse(secureLocalStore.getItem(`cipherline_last_activity_${userId}`) || '{}'); } catch { return {}; }
    });
    useEffect(() => {
        setLastActivityAt(prev => {
            let changed = false;
            const next = { ...prev };
            for (const [cid, msgs] of Object.entries(messagesState)) {
                const last = msgs[msgs.length - 1];
                if (!last) continue;
                const t = new Date(last.sent_at_client || last.timestamp || last.received_at_server || 0).getTime();
                if (t > 0 && (!next[cid] || t > next[cid])) { next[cid] = t; changed = true; }
            }
            return changed ? next : prev;
        });
    }, [messagesState]);
    useEffect(() => {
        if (!userId || !homePersistReadyRef.current) return;
        try { secureLocalStore.setItem(`cipherline_last_activity_${userId}`, JSON.stringify(lastActivityAt)); } catch {}
    }, [lastActivityAt, userId]);

    // C2: automatic sender-identity pinning. Set of contact userIds whose
    // identity key has changed since first-seen (TOFU) and not yet acknowledged.
    // Surfaced as a "safety number changed" banner in ChatPane (warn-but-show).
    // F1: the full verdict per contact, not just the binary "key changed".
    // `keyChangedSenders` below is derived from this and kept as a Set so the
    // shield icon and the existing banner keep their current shape.
    // ── Warning LIFETIME (not threshold) ────────────────────────────────────
    // This map used to be purely in-memory, so the banner and the picker
    // marker vanished on the next launch while the changed key stayed in use —
    // the alarm turning itself off. It is now mirrored into
    // `senderWarningStore` (encrypted, per-account, `kv_warn_v1_{uid}`) and
    // rehydrated at boot. The THRESHOLD is unchanged: only `isWarnable`
    // verdicts ever land here, never plain `first_contact`.
    //
    // Note the shape: every write to the store is WRITE-THROUGH at the point
    // the warning is raised or resolved. There is deliberately no effect that
    // mirrors this state into storage — an effect of that shape fires once on
    // mount with the empty initial value and writes it over the stored data,
    // which is exactly how persisted pins and ignored-games were wiped before.
    const [senderWarnings, setSenderWarnings] = useState<Record<string, SenderVerdict>>({});
    const keyChangedSenders = useMemo(
        () => new Set(Object.keys(senderWarnings)),
        [senderWarnings],
    );
    /** Contacts the user explicitly resolved during THIS session. Guards the
     *  one race the async rehydrate below has: a resolve that lands while
     *  `whenAccountReady()` is still pending would otherwise be undone by the
     *  restore that follows it. */
    const resolvedWarningsRef = useRef<Set<string>>(new Set());
    const clearSenderWarning = useCallback((uid: string) => {
        if (userId) {
            resolvedWarningsRef.current.add(uid);
            // Tell the directory-fetch producer which contradiction the user
            // just answered, so the next `/devices` response does not re-raise
            // it. `snapshotWarnings` supplies the pub from the DURABLE record
            // (envelope-sourced) alongside the one the directory watch itself
            // last raised on — the two can name different keys, and resolving
            // the banner has to answer both. This is read BEFORE
            // `resolveWarning` deletes the record.
            //
            // Note this is NOT a "the modal is open" flag. See the ledger note
            // in directoryKeyWatch.ts — verify/acknowledge both re-pin, so they
            // need no suppression at all; DISMISS deliberately does not, which
            // is why the standing contradiction has to be remembered per
            // (contact, key) rather than per modal lifetime.
            let durablePub: string | undefined;
            try { durablePub = snapshotWarnings(userId)[uid]?.pub; } catch { /* best effort */ }
            directoryKeyWatch.noteResolved(uid, durablePub);
            // Write-through: an explicit user act (verify / acknowledge /
            // dismiss) is the ONLY thing that retires a warning, so it must
            // survive the restart too.
            resolveWarning(userId, uid);
        }
        setSenderWarnings(prev => {
            if (!(uid in prev)) return prev;
            const next = { ...prev };
            delete next[uid];
            return next;
        });
    }, [userId]);

    // Rehydrate unresolved warnings for the active account.
    //
    // MUST await `whenAccountReady()`: per-account records are cold right
    // after an explicit sign-in (the store is still decrypting them under
    // HKDF(master, userId)), and a read before that returns empty — which here
    // means "no warnings", i.e. precisely the silence this change exists to
    // prevent. `isAccountReady` is the belt-and-braces re-check for the case
    // where the account changed again while we were awaiting.
    //
    // Merges rather than replaces, and anything already raised in-session
    // wins: a live verdict derived from an envelope this session is fresher
    // evidence than the stored snapshot.
    useEffect(() => {
        if (!userId) return;
        resolvedWarningsRef.current = new Set();
        let cancelled = false;
        void (async () => {
            try {
                await secureLocalStore.whenAccountReady();
                if (cancelled || !secureLocalStore.isAccountReady(userId)) return;
                const restored = loadWarnings(userId);
                if (!Object.keys(restored).length) return;
                setSenderWarnings(prev => {
                    const next = { ...prev };
                    let changed = false;
                    for (const [uid, verdict] of Object.entries(restored)) {
                        if (uid in next || resolvedWarningsRef.current.has(uid)) continue;
                        next[uid] = verdict;
                        changed = true;
                    }
                    return changed ? next : prev;
                });
            } catch (e) {
                // Reading failed. The pin store is untouched, so the next
                // message from the contact re-derives and re-raises the
                // verdict — the recovery path, not a silent all-clear.
                console.warn('[Dashboard] could not restore sender warnings', e);
            }
        })();
        return () => { cancelled = true; };
    }, [userId]);

    // Pin a sender's identity key on first contact (TOFU); flag a key change on a
    // mismatch. `sp` (the Ed25519 identity pub) is GCM-authenticated for DMs and
    // server-supplied for channels — either way a change is worth surfacing.
    // Skips own/multi-device echoes (su === userId) and missing inputs.
    //
    // RC-7 / Phase 5: `sd` (sender device id) makes the pin per (contact,
    // device) instead of per contact — a contact's second device has its own
    // identity key by design and must never read as a "change". `sd` is
    // absent for envelopes from a not-yet-updated sender; isKeyChanged/
    // recordFirstSeen both treat that permissively (never flags a change,
    // buckets by pub for later adoption — see keyVerification.ts).
    //
    // F1 (critical) — sender-identity binding. `sp` is NOT bound to `su` by
    // anything cryptographic: `decryptEnvelope` verifies the signature against
    // the very key the envelope names, so it proves self-consistency and
    // nothing more. A forger who can deliver an envelope invents an identity
    // key and a device id, ECDHs against the recipient's PUBLISHED prekey, and
    // claims any `su` it likes — and the old body of this function stayed
    // completely silent about it, because `isKeyChanged` treats an unseen
    // device id as "a new device" by design (RC-7). Even for a contact the
    // user had Safety-Number-verified.
    //
    // `evaluateSender` is what closes that: it adds the two attribution
    // sources the envelope cannot supply — the server's published key
    // directory, and out-of-band verification (`isUnrecognizedForVerifiedContact`,
    // written for exactly this and previously never called from anywhere).
    // See `senderTrust.ts` for why this cannot be fixed by signing more.
    //
    // Returns the verdict so key-material call sites can act on it; content
    // call sites can ignore the return and just get the pin + banner.
    // F1: warm the sender-attribution directory from every `/devices`,
    // `/recipient-devices` and `/identity_keys` response the app already makes.
    // No extra request and no new metadata reaches the server — see the
    // sealed-sender note in deviceDirectory.ts.
    //
    // The SAME responses also close the key-fetch-time detection gap. Until
    // now `pinAndDetect` was the only producer of `senderWarnings` and all
    // four of its call sites are message-RECEIVE paths, so a contact whose
    // pinned device started presenting a different identity key stayed
    // unmarked until they happened to send something — even though the
    // contradiction was sitting in the `/devices` response the client already
    // fetches on chat open and on every send.
    //
    // These raises are SESSION-SCOPED ON PURPOSE and deliberately do NOT go
    // through `raiseWarning`: their input is server-authored and unsigned, so
    // making them durable would hand a hostile server a free way to fill the
    // refuse-not-evict warning table (blocking real, envelope-sourced
    // warnings from ever being stored) and to write that noise into the
    // user's backup. The full argument is at the top of `directoryKeyWatch.ts`
    // — including why re-derivability makes persistence unnecessary here in
    // the first place. Note `onWarn` never hands us the offending pub, which
    // is the argument `raiseWarning` would need.
    //
    // The install stays mount-once (as it always was — the cache warm must not
    // miss a response while `userId` is momentarily empty), so the account is
    // read through a ref rather than captured in the closure.
    const myUserIdRef = useRef<string>(userId ?? '');
    // Ghost-device fix (docs/ghost-device.md): the same interceptor feeds the
    // own-device ledger (this account's rows) and the published-set cache
    // (contacts' complete sets). Both need this install's identity, read
    // through refs for the same mount-once reason as the account id above.
    const myDeviceIdRef = useRef<string>(deviceId ?? '');
    const localIdentityPubRef = useRef<string>('');
    /**
     * The local key as state (so the alarm re-derives once it has been read),
     * tagged with the (account, device) it was read for. Both this and the
     * alarm state are only honoured when the tag matches the current pair,
     * which makes an account or device switch drop them without a
     * synchronous reset inside an effect.
     */
    const [ownSelfRead, setOwnSelfRead] = useState<{ key: string; pub: string } | null>(null);
    const ownSelfKey = `${userId ?? ''}|${deviceId ?? ''}`;
    const ownSelfPub = ownSelfRead?.key === ownSelfKey ? ownSelfRead.pub : '';
    const [ownAlertRead, setOwnAlertRead] = useState<{ key: string; state: ReturnType<typeof ownDeviceLedger.currentOwnAlerts> } | null>(null);
    const ownAlertState = ownAlertRead?.key === ownSelfKey
        ? ownAlertRead.state
        : { alerts: [], selfKeyMismatch: false, unreviewedBaseline: [] };
    const [ownAlertNames, setOwnAlertNames] = useState<Record<string, OwnDeviceName>>({});
    useEffect(() => {
        myUserIdRef.current = userId ?? '';
        // Session state keyed to the previous account: drop it on a switch so
        // one account's dismissals can never silence another's warnings.
        directoryKeyWatch._reset();
        publishedDeviceSets._reset();
        ownDeviceLedger._resetSession();
    }, [userId]);
    useEffect(() => {
        myDeviceIdRef.current = deviceId ?? '';
        localIdentityPubRef.current = '';
        const key = `${userId ?? ''}|${deviceId ?? ''}`;
        let cancelled = false;
        void (async () => {
            try {
                const pub = window.electronAPI ? await window.electronAPI.getLocalIdentity() : null;
                if (!cancelled && pub) {
                    localIdentityPubRef.current = pub;
                    setOwnSelfRead({ key, pub });
                }
            } catch { /* no local identity: own-device observation stays off */ }
        })();
        return () => { cancelled = true; };
    }, [deviceId, userId]);
    useEffect(() => {
        const eject = deviceDirectory.installDirectoryCapture(axios, (entries, fullUserId, url) => {
            const me = myUserIdRef.current;
            publishedDeviceSets.observePublished(entries, fullUserId, url, me);
            const own = ownDeviceLedger.ownRowsFromDirectory(entries, fullUserId, url, me);
            if (own && myDeviceIdRef.current && localIdentityPubRef.current) {
                // No-op until the account's store is ready (see ownDeviceLedger).
                ownDeviceLedger.observeOwnDevices(
                    me,
                    { deviceId: myDeviceIdRef.current, pub: localIdentityPubRef.current },
                    own.rows,
                    own.complete,
                );
            }
            directoryKeyWatch.observeDirectory(entries, {
                myUserId: myUserIdRef.current,
                fullUserId,
                onWarn: ({ userId: them, verdict }) => {
                    // Never OVERWRITE an existing entry. A durable
                    // `unattributed` / `unrecognized_verified` is strictly
                    // stronger evidence than this producer can offer, and a
                    // directory response must not be able to downgrade it.
                    setSenderWarnings(prev => (prev[them] ? prev : { ...prev, [them]: verdict }));
                },
            });
        });
        return () => {
            eject(); deviceDirectory._reset(); directoryKeyWatch._reset();
            publishedDeviceSets._reset(); ownDeviceLedger._resetSession();
        };
    }, []);

    /** Transport for `deviceDirectory.ensureUser`. Injected rather than imported
     *  by that module so the attribution logic stays testable outside a browser
     *  (axios touches `window.location` at import time). */
    const fetchIdentityKeys = useCallback(async (uid: string): Promise<deviceDirectory.DirectoryEntry[]> => {
        const res = await axios.get(`${API_BASE}/keys/identity_keys?user_id=${encodeURIComponent(uid)}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        return (res.data ?? []) as deviceDirectory.DirectoryEntry[];
    }, [token]);

    const pinAndDetect = useCallback((su?: string | null, sp?: string | null, sd?: string | null): SenderVerdict | null => {
        if (!userId || !su || !sp || su === userId) return null;

        const verdict = evaluateSender({
            myUserId: userId,
            theirUserId: su,
            senderPub: sp,
            senderDeviceId: sd ?? undefined,
            directory: deviceDirectory.status(su, sp, sd ?? undefined),
        });

        if (isWarnable(verdict)) {
            // Never silent. Every warnable verdict reaches the user as a
            // banner in the conversation — the whole point of F1 is that an
            // unrecognized key stops being indistinguishable from first contact.
            setSenderWarnings(prev => (prev[su] === verdict ? prev : { ...prev, [su]: verdict }));
            // …and never silent AFTER A RESTART either. `sp` is stored with it
            // because the offending key is by construction absent from the pin
            // store (we refused to adopt it), so nothing else on disk records
            // that it ever arrived.
            raiseWarning(userId, su, verdict, sp, sd ?? undefined);
        } else {
            recordFirstSeen(userId, su, sp, sd ?? undefined);
        }
        return verdict;
    }, [userId]);
    const [pinnedMessagesState, setPinnedMessagesState] = useState<Record<string, string[]>>({});
    const [hiddenConversations, setHiddenConversations] = useState<string[]>([]);
    const [pinnedHomeItems, setPinnedHomeItems] = useState<PinnedHomeItem[]>(() => {
        if (!userId) return [];
        try { return JSON.parse(secureLocalStore.getItem(`cipherline_home_pins_${userId}`) || '[]'); } catch { return []; }
    });
    useEffect(() => {
        // isAccountReady: belt and braces for login()'s await - never persist
        // into a namespace whose records are not in memory yet.
        if (!userId || !homePersistReadyRef.current || !secureLocalStore.isAccountReady(userId)) return;
        try { secureLocalStore.setItem(`cipherline_home_pins_${userId}`, JSON.stringify(pinnedHomeItems)); } catch {}
    }, [pinnedHomeItems, userId]);
    // Dedupe/match on pinKey rather than per-type field comparisons, so adding
    // a pin variant (servers) doesn't need a new branch in two places.
    const handlePinToHome = useCallback((item: PinnedHomeItem) => {
        setPinnedHomeItems(prev =>
            prev.some(p => pinKey(p) === pinKey(item)) ? prev : [...prev, item],
        );
    }, []);
    const handleUnpinFromHome = useCallback((item: PinnedHomeItem) => {
        setPinnedHomeItems(prev => prev.filter(p => pinKey(p) !== pinKey(item)));
    }, []);

    // ── 3-mode notification preferences ─────────────────────────────────────────
    // 'all'      → every message triggers badge + sound (default)
    // 'mentions' → only @mentions trigger badge; regular messages are silent
    // 'none'     → fully muted, but @mention badges still appear (@-badge bypasses)
    type NotifMode = 'all' | 'mentions' | 'none';
    const [notifPrefs, setNotifPrefs] = useState<Record<string, NotifMode>>(() => {
        try {
            // Prefer the new key; fall back to migrating the old binary muted list
            const saved = secureLocalStore.getItem(`cipherline_notif_prefs_${userId}`);
            if (saved) return JSON.parse(saved);
            const old = JSON.parse(secureLocalStore.getItem(`cipherline_muted_convs_${userId}`) || 'null');
            if (Array.isArray(old)) {
                const migrated: Record<string, NotifMode> = {};
                for (const id of old) migrated[id] = 'none';
                return migrated;
            }
            return {};
        } catch { return {}; }
    });
    /** Current notification mode for a conversation (default 'all'). */
    const notifMode = useCallback((id: string): NotifMode => notifPrefs[id] ?? 'all', [notifPrefs]);
    /** Set a specific notification mode for a conversation (used by ChatPane three-dots menu). */
    const setConvNotifMode = useCallback((id: string, mode: NotifMode) => setNotifPrefs(prev => ({ ...prev, [id]: mode })), []);

    // ── Mention badge counts ──────────────────────────────────────────────────
    // Incremented whenever an incoming message mentions the current user (@user /
    // @everyone / @here). These counts are shown in an amber @-badge and are NOT
    // suppressed by 'none' notification mode — @mentions always bypass mute.
    const [mentionCounts, setMentionCounts] = useState<Record<string, number>>(() => {
        if (!userId) return {};
        try { return JSON.parse(secureLocalStore.getItem(`cipherline_mentions_${userId}`) || '{}'); } catch { return {}; }
    });

    const [presence, setPresence] = useState<Record<string, boolean>>({});
    const [activeCall, setActiveCall] = useState<{ id: string, conversation_id?: string, livekit_url: string, livekit_token: string, e2ee_key_b64: string, videoByDefault?: boolean, mode?: 'p2p' | 'sfu', isInitiator?: boolean, isVoiceChannel?: boolean, voiceChannelName?: string, callsChannelId?: string } | null>(null);

    // ── Calls-channel E2EE ────────────────────────────────────────────────
    // Server calls (huddle / legacy voice) derive their LiveKit room key from
    // the channel's Sender Key rather than using the DM `call_key` flow. Until
    // this reports 'ready' the CallPane below is NOT mounted, so the client
    // never connects to the room unencrypted — there is no plaintext fallback.
    // A rotation (member removed / demoted) advances the epoch, this re-derives,
    // and CallPane swaps the key on the live room without reconnecting.
    const activeCallsChannelId = activeCall?.callsChannelId ?? null;
    const callsChannelKey = useCallsChannelKey(activeCallsChannelId);

    // The freshly derived room key, but ONLY when it belongs to the channel the
    // call is actually in. React state lags its input by one render, so on the
    // pass where activeCall moves to a different Calls channel (a moderator
    // force-move, or hopping between two Calls channels) `callsChannelKey` is
    // still the PREVIOUS channel's 'ready' — reading `status === 'ready'` alone
    // would hand channel A's room key to channel B for that commit, which is
    // long enough for CallPane to mount and start connecting under a key nobody
    // else in that room holds. Null here means "no usable key", which is what
    // both the latch below and the gate treat it as.
    const freshCallsKeyB64 =
        callsChannelKey.status === 'ready' && callsChannelKey.channelId === activeCallsChannelId
            ? callsChannelKey.keyB64
            : null;

    // Per-call key history, scoped by `marker` = `${callId}:${channelId}` so a
    // key latched for one call can NEVER be reused to enter another room. The
    // channel id is ALSO carried separately and re-checked by the gate, so the
    // binding survives even if the marker scheme is ever changed.
    //   lastGoodKeyB64 — the room key this call actually connected under.
    //   waitingSince   — start of the current keyless stretch (null = have a key).
    const [callsKeyGate, setCallsKeyGate] = useState<{
        marker: string;
        channelId: string;
        lastGoodKeyB64: string | null;
        waitingSince: number | null;
    } | null>(null);

    useEffect(() => {
        const callId = activeCall?.id;
        const channelId = activeCallsChannelId;
        if (!callId || !channelId) { setCallsKeyGate(null); return; }
        const marker = `${callId}:${channelId}`;
        setCallsKeyGate(prev => {
            // A different call — start from a clean slate, never inherit.
            const base = prev?.marker === marker
                ? prev
                : { marker, channelId, lastGoodKeyB64: null, waitingSince: null };
            if (freshCallsKeyB64) {
                if (base.lastGoodKeyB64 === freshCallsKeyB64 && base.waitingSince === null) return base;
                return { marker, channelId, lastGoodKeyB64: freshCallsKeyB64, waitingSince: null };
            }
            if (base.waitingSince != null) return base;
            return { marker, channelId, lastGoodKeyB64: base.lastGoodKeyB64, waitingSince: Date.now() };
        });
    }, [activeCall?.id, activeCallsChannelId, freshCallsKeyB64]);

    // Maps session_id → e2ee_key_b64. Populated from TWO places, never from a
    // server response: every decrypted `call_key` envelope, and the key this
    // device generated itself when it started a call.
    //
    // The second half is not redundant. `GET /conversations/:id/devices`
    // deliberately excludes "the sender's exact current device"
    // (conversations.service.ts), so the starting device is NEVER a recipient
    // of its own `call_key` message and can never learn the key back off the
    // wire. Without recording it here, every later local join of a session
    // THIS device started read `callKeyStoreRef.current[id] || ''` and got the
    // empty string — the `joined: true` merge path in startGlobalCall and the
    // chat pane's "Join Call" banner both do — which mounts CallPane keyless,
    // i.e. connects a DM call in PLAINTEXT while every peer that did receive
    // the key is publishing GCM. (A Calls-channel call cannot land in that
    // state: its key is derived, not delivered, and the mount is gated on it.)
    const callKeyStoreRef = useRef<Record<string, string>>({});
    /**
     * Bumped on every write to `callKeyStoreRef`, purely to force a re-render.
     *
     * The ref has to stay the source of truth — `pullMessages` and the WS
     * handlers write to it from callbacks with empty dep arrays and must see
     * their own writes synchronously. But a ref write renders nothing, and
     * that is precisely how a late `call_key` used to be lost: the key landed
     * in the store while CallPane was already mounted keyless, nothing
     * re-evaluated, and the call stayed in plaintext for its whole duration.
     * The counter is what lets the gate below re-run when a key finally shows
     * up. Always write through `recordCallKey`, never to the ref directly.
     */
    const [callKeyEpoch, setCallKeyEpoch] = useState(0);
    const recordCallKey = useCallback((callId: string, keyB64: string) => {
        if (!callId || !keyB64) return;
        if (callKeyStoreRef.current[callId] === keyB64) return;
        callKeyStoreRef.current[callId] = keyB64;
        setCallKeyEpoch(n => n + 1);
    }, []);
    const recordCallKeyRef = useRef(recordCallKey);
    useEffect(() => { recordCallKeyRef.current = recordCallKey; }, [recordCallKey]);

    /**
     * The key the `call_key` flow delivered for a DM/group call, or '' while
     * we are still waiting for it. Read through `callKeyEpoch` so a key that
     * lands AFTER the call object was built still reaches this render — that
     * is the whole point of the epoch counter, see recordCallKey.
     */
    const deliveredCallKeyB64 = activeCall && !activeCall.callsChannelId
        ? (activeCall.e2ee_key_b64 || callKeyStoreRef.current[activeCall.id] || '')
        : '';
    // Referenced so the epoch is a real dependency of this render rather than
    // an incidental one — the ref read above is what it exists to refresh.
    void callKeyEpoch;

    /** When the current keyless stretch of a DM/group call began, so the gate
     *  can decide when to stop implying progress. Cleared the moment a key
     *  arrives, and re-armed per call id. */
    const [dmKeyWait, setDmKeyWait] = useState<{ callId: string; since: number } | null>(null);
    useEffect(() => {
        const id = activeCall?.id;
        if (!id || activeCall?.callsChannelId || deliveredCallKeyB64) { setDmKeyWait(null); return; }
        setDmKeyWait(prev => (prev && prev.callId === id) ? prev : { callId: id, since: Date.now() });
    }, [activeCall?.id, activeCall?.callsChannelId, deliveredCallKeyB64]);

    // Clock feeding the gate's elapsed-time decisions. Deliberately NOT a 1 Hz
    // ticker: elapsed time changes what the user is shown exactly ONCE per
    // keyless stretch (waiting → "still waiting", or holding → "keys
    // unavailable"), so one timeout aimed at that threshold is enough, and a
    // per-second re-render of a component this size during a live call is not
    // a cost worth paying for a message that never counts down.
    //
    // A stale `callsKeyNow` is safe by construction: resolveCallKeyGate
    // clamps a negative elapsed to 0, i.e. it under-reports the wait and shows
    // the calmer state, never a premature "stalled".
    const [callsKeyNow, setCallsKeyNow] = useState(() => Date.now());
    useEffect(() => {
        // Either wait can be the live one: a Calls channel waiting on its
        // derived key, or a DM/group call waiting on a delivered `call_key`.
        // Without the second term the DM wait never re-rendered at the stall
        // boundary and sat on "Securing call…" forever.
        const since = callsKeyGate?.waitingSince ?? dmKeyWait?.since;
        if (since == null) return;
        // Holding a latched key → the degraded grace applies; otherwise this
        // call has never connected and the (longer) stall window applies.
        const threshold = callsKeyGate?.lastGoodKeyB64
            ? CALL_KEY_DEGRADED_GRACE_MS
            : CALL_KEY_STALL_MS;
        const t = window.setTimeout(
            () => setCallsKeyNow(Date.now()),
            Math.max(0, since + threshold - Date.now()) + 50,
        );
        return () => window.clearTimeout(t);
    }, [callsKeyGate?.waitingSince, callsKeyGate?.lastGoodKeyB64, dmKeyWait?.since]);

    const callsGateMarker = activeCall?.id && activeCallsChannelId
        ? `${activeCall.id}:${activeCallsChannelId}`
        : null;
    const callsGateCurrent = callsKeyGate && callsKeyGate.marker === callsGateMarker ? callsKeyGate : null;
    /**
     * What the Calls-channel key situation means for THIS render: connect (and
     * with which key), block, or hold-but-warn. `kind: 'connect'` is the only
     * outcome that may mount CallPane, and it always carries a non-empty key
     * derived for THIS channel — see utils/callKeyGate.ts for both
     * invariants and their tests.
     */
    const callsChannelGate = resolveCallKeyGate({
        channelId: activeCallsChannelId,
        deliveredKeyB64: deliveredCallKeyB64 || null,
        status: callsChannelKey.status,
        keyB64: freshCallsKeyB64,
        keyChannelId: callsChannelKey.status === 'ready' ? callsChannelKey.channelId : null,
        lastGoodKeyB64: callsGateCurrent?.lastGoodKeyB64 ?? null,
        lastGoodChannelId: callsGateCurrent?.channelId ?? null,
        waitingSinceMs: activeCallsChannelId
            ? (callsGateCurrent?.waitingSince ?? null)
            : (dmKeyWait?.since ?? null),
        nowMs: callsKeyNow,
    });

    /**
     * What the channel-row padlock (HuddleButton) should show for the local
     * user's OWN active Huddle call — same gate that decides whether
     * CallPane may mount, never a separate/hardcoded guess. 'blocked'
     * (loading or stalled — no confirmed key yet) → spinner; 'connect' → a
     * real key is in hand → padlock. 'not_applicable' (no active Calls-
     * channel call) → null, so no row anywhere renders an icon for it.
     */
    // Remote participants publishing in the clear, reported up by CallPane's
    // RemoteE2EEWatcher.
    //
    // Stored as the CALL ID this applies to rather than a boolean, which is
    // what makes it self-expiring: a warning raised during one call can never
    // be read during another, because the ids won't match. The boolean version
    // needed a `useEffect` to clear it on call end, which (a) tripped
    // react-hooks/set-state-in-effect and (b) still left a real window — a new
    // call mounts before its watcher has reported, so the previous call's
    // `true` was briefly visible on the new one. Comparing ids has neither
    // problem and needs no effect.
    const [unencryptedPeersForCallId, setUnencryptedPeersForCallId] = useState<string | null>(null);
    const callHasUnencryptedPeers = !!activeCall && unencryptedPeersForCallId === activeCall.id;

    /**
     * The channel-row padlock.
     *
     * `callsChannelGate` answers "does THIS device hold a real key", which is
     * necessary and was for a long time treated as sufficient. It is not:
     * LiveKit enables encryption per remote participant, so a peer on a build
     * older than 1.0.13 sends media the server can read while ours stays
     * encrypted. On that call the gate still says 'connect' and the padlock
     * still went green — reporting our own state as if it were the call's.
     * 'mixed' is that case, and it deliberately loses to nothing: a green
     * padlock over a partly-plaintext call is the overstatement worth fixing.
     */
    const myCallEncryptionState: 'connecting' | 'connected' | 'mixed' | null =
        callsChannelGate.kind === 'connect'
            ? (callHasUnencryptedPeers ? 'mixed' : 'connected')
            : callsChannelGate.kind === 'blocked' ? 'connecting'
                : null;

    // Optimistic in-flight flag for the start-call request. Flips true the
    // instant the user clicks "Call" so the panel transitions IMMEDIATELY
    // (rather than after the ~1-2 second API round-trip). While true we
    // render the in-call panel layout with a "Connecting…" placeholder
    // where SidebarConference will eventually go. Cleared automatically
    // when activeCall is set, or by the start-call function on error.
    const [isStartingCall, setIsStartingCall] = useState(false);
    useEffect(() => {
        if (activeCall) setIsStartingCall(false);
    }, [activeCall]);

    // The call section mounts the INSTANT a join starts (isStartingCall shows
    // the Connecting… placeholder) and unmounts the instant the call ends —
    // no grace window, no exit choreography. Leaving must feel like a snap:
    // the old 220 ms snapshot window kept dead call UI on screen while
    // background teardown reflowed it, which read as sluggish jumping.
    const callPaneActive = !!activeCall || isStartingCall;
    const [hasFocusedStream, setHasFocusedStream] = useState(false);
    const [, setCallStartedAt] = useState<number>(0);
    const [settingsOpen, setSettingsOpen] = useState(false);
    // Freeze log context: which top-level view is showing (a static name —
    // never which conversation or channel).
    useEffect(() => { setFreezeLogView(settingsOpen ? 'settings' : activeTab); }, [activeTab, settingsOpen]);
    const [settingsInitialTab, setSettingsInitialTab] = useState<import('./settings/SettingsScreen').PaneId | undefined>(undefined);

    const [checklistRefreshSignal, setChecklistRefreshSignal] = useState(0);
    const [, setContextMenuOpenId] = useState<string | null>(null);

    // "Welcome to Pro" celebration — shown once the first time we detect an active
    // PAID subscription (the Stripe checkout completes in the browser; the status
    // poll / window-focus refresh surfaces it). Derived, gated by a per-user flag.
    const { status: subStatus } = useSubscription();
    const [proDismissed, setProDismissed] = useState(false);
    const showProWelcome = !proDismissed
        && !!userId
        && !!subStatus?.has_subscription
        && subStatus.subscription_status === 'active'
        && !secureLocalStore.getItem(`cipherline_pro_welcomed_${userId}`);
    const dismissProWelcome = () => {
        if (userId) { try { secureLocalStore.setItem(`cipherline_pro_welcomed_${userId}`, '1'); } catch { /* ignore */ } }
        setProDismissed(true);
    };

    const [referralWelcomeDismissed, setReferralWelcomeDismissed] = useState(false);
    const referralBonusDays = userId
        ? parseInt(secureLocalStore.getItem(`cl_referral_welcome_${userId}`) ?? '0', 10)
        : 0;
    const showReferralWelcome = !referralWelcomeDismissed && referralBonusDays > 0;
    const dismissReferralWelcome = () => {
        if (userId) { try { secureLocalStore.removeItem(`cl_referral_welcome_${userId}`); } catch { /* ignore */ } }
        setReferralWelcomeDismissed(true);
    };
    const [sentFriendRequests, setSentFriendRequests] = useState<Set<string>>(new Set());

    const startGlobalCall = async (targetUserId: string) => {
        if (!token || !deviceId || !bundleReady) return;
        // Optimistic flag — fires the panel transition the instant the user
        // clicks Call, BEFORE the API round-trip. Cleared when activeCall is
        // set (success path) or in the catch (failure path).
        setIsStartingCall(true);
        try {
            let convId = '';
            const existing = conversations.find(c => c.type === 'dm' && c.other_user_id === targetUserId);
            if (existing) {
                convId = existing.conversation_id;
            } else {
                const res = await axios.post(`${API_BASE}/conversations/dm`, { other_user_id: targetUserId }, { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId }});
                convId = res.data.conversation_id;
            }

            const callKey = await generateCallKey();
            const initRes = await axios.post(`${API_BASE}/calls/start`, { conversation_id: convId }, { headers: { Authorization: `Bearer ${token}` }});

            // When the advisory lock merged us into an existing session, the original
            // caller already broadcast a call_key message. Read the key from our local
            // store (populated when any call_key message is decrypted) rather than from
            // the server response, which no longer carries the key.
            const joined = !!initRes.data.joined;
            const sessionKey = joined
                ? (callKeyStoreRef.current[initRes.data.session_id] || '')
                : callKey;
            // Record OUR OWN key for this session: nothing else can. The device
            // list this key is broadcast to excludes this device, so the store
            // would otherwise never learn it and every later local join of this
            // session would mount keyless (see callKeyStoreRef's note).
            if (sessionKey) recordCallKeyRef.current(initRes.data.session_id, sessionKey);

            if (!joined) {
                // claim_otp=1: consume a one-time prekey per recipient device (per-message forward secrecy)
                const devicesRes = await axios.get(`${API_BASE}/conversations/${convId}/devices?claim_otp=1`, { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId }});

                const content = {
                    client_msg_id: `global-${Date.now()}`,
                    type: 'call_key',
                    call_id: initRes.data.session_id,
                    epoch: 1,
                    e2ee_key_b64: callKey,
                    key_id: 'initial',
                    rotates_at: new Date(Date.now() + 10 * 60000).toISOString()
                };
                const callDevices = devicesRes.data as { device_id: string; spk_pub_b64: string }[];
                // RC-2: address exactly the devices that got wrapped.
                const { ciphertext_b64, recipient_device_ids } = await encryptAndAddress(JSON.stringify(content), userId!, callDevices, deviceId ?? undefined);

                await axios.post(`${API_BASE}/messages/send`, {
                    conversation_id: convId,
                    recipient_device_ids,
                    envelope_type: 'signal_chat',
                    ciphertext_b64,
                    sent_at_client: new Date().toISOString()
                }, { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } });
            } else {
                console.log(`[Dashboard] startGlobalCall merged into existing session ${initRes.data.session_id} — skipping call_key broadcast.`);
            }

            // Leave any active server voice/huddle call before switching to this
            // conversation call — otherwise the server keeps the user in the
            // participant list until the LiveKit disconnect watchdog fires.
            if (activeVoiceChannelId) {
                try {
                    await axios.post(
                        `${API_BASE}/channels/${activeVoiceChannelId}/leave_voice`,
                        {},
                        { headers: { Authorization: `Bearer ${token}` } },
                    );
                } catch { /* best-effort */ }
                setActiveVoiceChannelId(null);
            }
            if (activeHuddleCallId) {
                try { await leaveHuddleCall(activeHuddleCallId); } catch { /* best-effort */ }
                setActiveHuddleCallId(null);
                setActiveHuddleChannelId(null);
            }

            setActiveCall({
                id: initRes.data.session_id,
                conversation_id: convId,
                livekit_url: initRes.data.livekit_url,
                livekit_token: initRes.data.livekit_token || '',
                e2ee_key_b64: sessionKey,
                mode: 'sfu',
                isInitiator: !joined
            });
        } catch(e) {
            console.error("Failed to start global call:", e);
            setIsStartingCall(false);
        }
    };
    const [, setGroupMemberContextId] = useState<string | null>(null);
    const [profileModalUserId, setProfileModalUserId] = useState<string | null>(null);
    const [reportTarget, setReportTarget] = useState<{ id: string; username: string; snippet?: string } | null>(null);
    const [profileModalAnchor, setProfileModalAnchor] = useState<{ x: number; y: number } | null>(null);
    const [profileModalRoleCtx, setProfileModalRoleCtx] = useState<{
        roleIds: string[];
        roles: Array<{ role_id: string; name: string; color: number }>;
        serverId?: string;
        currentNickname?: string | null;
        canSetNickname?: boolean;
        autoEditNickname?: boolean;
    } | null>(null);
    // Single entry point that every caller routes through — stores userId, anchor, and optional server role context.
    const openProfileAt = React.useCallback((
        uid: string,
        anchor?: { x: number; y: number },
        roleCtx?: { roleIds: string[]; roles: Array<{ role_id: string; name: string; color: number }>; serverId?: string; currentNickname?: string | null; canSetNickname?: boolean; autoEditNickname?: boolean },
    ) => {
        setProfileModalAnchor(anchor ?? null);
        setProfileModalUserId(uid);
        setProfileModalRoleCtx(roleCtx ?? null);
    }, []);
    // ── Server state ──────────────────────────────────────────────────────────
    const {
        servers, channels: serverChannels, categories: serverCategories, channelsLoading,
        loading: serversLoading,
        huddleCalls, myPermissions, loadChannels, loadMyPermissions, reloadCategories, loadServers,
        loadHuddleCalls, applyHuddleCallsSnapshot, applyHuddleSpawn, applyHuddleDestroy, applyHuddleRename, applyHuddleParticipant,
        spawnHuddleCall, joinHuddleCall, leaveHuddleCall, renameHuddleCall,
        createServer, joinServer,
    } = useServers(token, userId);

    // Settle the 'servers' core load once useServers' own initial fetch stops
    // running. That fetch is kicked off inside useServers, not by
    // rehydrateAll, so without this the first-paint gate would wait out its
    // full timeout on every cold start. loadServers() swallows its own errors,
    // so `loading` going false means settled — succeeded or not, which is what
    // the gate wants.
    //
    // Watches the true→false TRANSITION rather than `!loading`, because
    // useServers initialises loading to false: testing the bare flag would
    // settle on the very first render, before the fetch had even started, and
    // quietly defeat the gate for servers.
    const sawServersLoadingRef = useRef(false);
    useEffect(() => {
        if (serversLoading) { sawServersLoadingRef.current = true; return; }
        // No token means there is nothing to wait for at all.
        if (!token) { markSettled('servers'); return; }
        if (sawServersLoadingRef.current) markSettled('servers');
    }, [serversLoading, token, markSettled]);

    // ── Server rail order (drag-to-reorder, per-account, client-owned) ────────
    // See rail/useServerRailOrder.ts. `serverIds` is memoized so the merge in
    // the hook doesn't recompute on every unrelated Dashboard render.
    const serverIds = useMemo(() => servers.map(s => s.server_id), [servers]);
    const { orderedIds: railServerOrder, reorder: reorderServerRail, moveByKeyboard: moveServerRailByKeyboard } =
        useServerRailOrder(userId, serverIds);
    const railServers = useMemo(
        () => railServerOrder
            .map(id => servers.find(s => s.server_id === id))
            .filter((s): s is (typeof servers)[number] => !!s),
        [railServerOrder, servers],
    );

    // Pointer drag state for the server rail — mirrors ServerChannelList's
    // activeId/overId pair (see its onDragStart/onDragOver/onDragEnd). An 8px
    // activation threshold on PointerSensor is what keeps a plain click on a
    // server icon from being swallowed as a drag.
    const [railDragId, setRailDragId] = useState<string | null>(null);
    const [railOverId, setRailOverId] = useState<string | null>(null);
    const [railMoveAnnouncement, setRailMoveAnnouncement] = useState('');
    const railSensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    );
    const railServerKeys = useMemo(() => railServers.map(s => `srv:${s.server_id}`), [railServers]);
    const getRailDropLine = useCallback((itemKey: string): 'top' | 'bottom' | null => {
        if (!railDragId || railOverId !== itemKey) return null;
        const aIdx = railServerKeys.indexOf(railDragId);
        const oIdx = railServerKeys.indexOf(itemKey);
        if (oIdx === -1) return null;
        return (aIdx === -1 || aIdx < oIdx) ? 'bottom' : 'top';
    }, [railDragId, railOverId, railServerKeys]);
    const onRailDragStart = useCallback(({ active }: DragStartEvent) => {
        setRailDragId(active.id as string);
        setRailOverId(null);
    }, []);
    const onRailDragOver = useCallback(({ over }: DragOverEvent) => {
        setRailOverId(over ? (over.id as string) : null);
    }, []);
    const onRailDragEnd = useCallback(({ active, over }: DragEndEvent) => {
        setRailDragId(null);
        setRailOverId(null);
        if (!over || active.id === over.id) return;
        const activeServerId = (active.id as string).slice(4); // 'srv:'.length
        const overServerId = (over.id as string).slice(4);
        reorderServerRail(activeServerId, overServerId);
        const newIndex = moveServerToRailPosition(railServerOrder, activeServerId, overServerId).indexOf(activeServerId);
        const movedServer = servers.find(s => s.server_id === activeServerId);
        if (movedServer && newIndex >= 0) {
            setRailMoveAnnouncement(`Moved ${movedServer.name} to position ${newIndex + 1} of ${railServerOrder.length}.`);
        }
    }, [reorderServerRail, railServerOrder, servers]);
    const draggedRailServer = railDragId
        ? servers.find(s => s.server_id === railDragId.slice(4))
        : null;
    /** Alt+ArrowUp/Down on a focused server tile — the keyboard equivalent of
     *  the pointer drag, same convention as cl/ClSelect.tsx's role reorder. */
    const onRailTileKeyDown = useCallback((e: React.KeyboardEvent, serverId: string) => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        const before = railServerOrder.indexOf(serverId);
        moveServerRailByKeyboard(serverId, e.key === 'ArrowDown' ? 1 : -1);
        const movedServer = servers.find(s => s.server_id === serverId);
        if (movedServer && before >= 0) {
            const after = e.key === 'ArrowDown' ? Math.min(railServerOrder.length - 1, before + 1) : Math.max(0, before - 1);
            setRailMoveAnnouncement(`Moved ${movedServer.name} to position ${after + 1} of ${railServerOrder.length}.`);
        }
    }, [railServerOrder, moveServerRailByKeyboard, servers]);

    // ── Load every joined server's channel list on boot ───────────────────────
    // serverChannels is filled lazily by loadChannels(), which only runs when
    // you open a server. Two separate features break while it's empty, and both
    // read to the user as "the app silently forgot something":
    //
    //   1. Unread badges. The server rail tile sums channelUnreadCounts over
    //      serverChannels[serverId]. An unvisited server has no channel-id list,
    //      so that sum is 0 — a channel message plays its notification sound and
    //      then shows a badge nowhere, until you happen to open that server.
    //      (The tray/dock badge sums the count maps directly and was correct the
    //      whole time, which is exactly what made this so confusing: the OS said
    //      "1 unread", the app showed nothing.)
    //   2. Pinned channels. HomePanel resolves a channel pin by looking it up in
    //      serverChannels and silently drops it when absent, so after a restart
    //      pinned channels vanished from Home until you visited their server.
    //
    // This used to fetch only the servers a channel PIN referenced, which fixed
    // (2) but left (1) broken for every server you hadn't opened. Both need the
    // same data, so load all joined servers once each. The ref guard keeps it to
    // one fetch per server per session.
    const serverChannelsLoadedRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        if (!token || !servers.length) return;
        for (const s of servers) {
            if (serverChannelsLoadedRef.current.has(s.server_id)) continue;
            if (serverChannels[s.server_id]) continue;                     // already loaded
            serverChannelsLoadedRef.current.add(s.server_id);
            void loadChannels(s.server_id);
        }
    }, [token, servers, serverChannels, loadChannels]);

    // ── Invite-to-server helpers ──────────────────────────────────────────────
    // Placed AFTER useServers so `servers` is in scope for the dependency arrays.

    // Hoisted above its usual spot (originally declared much further down,
    // alongside the other one-off UI state) so buildInviteToServerItems below
    // can read it. Moving a useState call earlier changes nothing about the
    // Rules of Hooks — call order just has to stay stable across renders,
    // not appear at any particular line number — and nothing between here
    // and the old declaration site reads it, so this is a pure relocation.
    const [globalFriends, setGlobalFriends] = useState<{ accepted: any[] } | null>(null);

    /**
     * Create an invite for `serverId` and send it as a `server_invite` E2EE message
     * into `conversationId`. Returns the sent content object so the caller can
     * optimistically append it to the message thread.
     */
    const sendInviteMessage = React.useCallback(async (serverId: string, conversationId: string): Promise<any | null> => {
        if (!token || !deviceId) return null;
        try {
            const invRes = await axios.post(
                `${API_BASE}/servers/${serverId}/invites`,
                {},
                { headers: { Authorization: `Bearer ${token}` } },
            );
            const code: string = invRes.data.code;
            const safeUUID = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `invite-${Date.now()}`;
            const content = {
                client_msg_id: safeUUID,
                type: 'server_invite',
                code,
            };
            // claim_otp=1: consume a one-time prekey per recipient device (per-message forward secrecy)
            const devicesRes = await axios.get(
                `${API_BASE}/conversations/${conversationId}/devices?claim_otp=1`,
                { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } },
            );
            const recipientDevices = devicesRes.data as { device_id: string; spk_pub_b64: string }[];
            // RC-2: address exactly the devices that got wrapped.
            const { ciphertext_b64, recipient_device_ids } = await encryptAndAddress(
                JSON.stringify(content),
                userId!,
                recipientDevices,
                deviceId ?? undefined,
            );
            await axios.post(
                `${API_BASE}/messages/send`,
                {
                    conversation_id: conversationId,
                    recipient_device_ids,
                    envelope_type: 'signal_chat',
                    ciphertext_b64,
                    sent_at_client: new Date().toISOString(),
                },
                { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } },
            );
            return content;
        } catch (e) {
            console.error('[Dashboard] sendInviteMessage failed:', e);
            return null;
        }
    }, [token, deviceId]);

    /**
     * Returns a submenu items array for "Invite to Server ▸" targeting `targetUserId`.
     * On select: DMsthe invite, navigates to the DM, and moves it to the top of the list.
     *
     * Gated here — not just at each call site — because the action works by
     * DMing the target, and the server's createDm now 400s for anyone who
     * isn't an accepted friend (or the viewer). Doing the check inside the
     * builder means every current AND future call site gets it for free,
     * rather than depending on each one remembering to check first (two call
     * sites had not: the DM sidebar's "Invite to Server" row, and the one
     * wired into ProfileModal — both fixed as part of this pass, but this is
     * the belt to their braces). Returning [] here also naturally hides the
     * whole "Invite to Server ▸" menu row wherever it's built as
     * `...(items.length ? [{ label: 'Invite to Server', submenu: items }] : [])`.
     */
    const buildInviteToServerItems = React.useCallback((targetUserId: string) => {
        if (!servers.length) return [];
        const relationship: FriendRelationship =
            targetUserId === userId
                ? 'self'
                : globalFriends?.accepted.some(f => f.user_id === targetUserId)
                    ? 'friend'
                    : 'stranger';
        if (!canOfferFriendGatedAction(relationship)) return [];
        return servers.map(srv => ({
            label: srv.name,
            onSelect: async () => {
                // ── 1. Find or create the DM conversation ──────────────────────
                const existing = conversations.find(
                    c => c.type === 'dm' && c.other_user_id === targetUserId,
                );
                let convId: string | null = existing?.conversation_id ?? null;
                let convTitle: string = existing?.title ?? 'Chat';
                let convAvatar: string | undefined = existing?.avatar_url;

                if (!convId) {
                    try {
                        const res = await axios.post(
                            `${API_BASE}/conversations/dm`,
                            { other_user_id: targetUserId },
                            { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } },
                        );
                        convId = res.data.conversation_id;
                        convTitle = res.data.title ?? convTitle;
                        convAvatar = res.data.avatar_url ?? convAvatar;
                    } catch (e) {
                        console.error('[Dashboard] buildInviteToServerItems: could not open DM:', e);
                        toast.push({ kind: 'error', title: 'Invite Failed', message: "Couldn't start a conversation to send the invite." });
                        return;
                    }
                }
                if (!convId) return;

                // ── 2. Navigate to the DM immediately ─────────────────────────
                // Mirrors handleStartChat so the user sees the conversation open
                // right away without waiting for the encrypt round-trip.
                setActiveChat({ id: convId, title: convTitle, type: 'dm', other_user_id: targetUserId, avatar_url: convAvatar });
                setActiveChannel(null);
                setActiveTab('dms');
                setHiddenConversations(prev =>
                    prev.includes(convId!) ? prev.filter(id => id !== convId) : prev,
                );

                // ── 3. Send the invite and add an optimistic message ───────────
                const sentContent = await sendInviteMessage(srv.server_id, convId);
                if (sentContent) {
                    setMessagesState(prev => {
                        const cId = convId!;
                        const thread = [...(prev[cId] || [])];
                        if (!thread.find(t => t.id === sentContent.client_msg_id)) {
                            thread.push({
                                id: sentContent.client_msg_id,
                                content: sentContent,
                                sender_device_id: deviceId,
                                timestamp: new Date().toISOString(),
                                conversation_id: cId,
                            });
                        }
                        return { ...prev, [cId]: thread };
                    });
                } else {
                    // sendInviteMessage already logged the cause; the DM opened
                    // fine (we're past step 1) but the invite itself never went
                    // out, which used to be entirely silent.
                    toast.push({ kind: 'error', title: 'Invite Failed', message: 'The conversation opened, but the invite could not be sent. Try again.' });
                }

                // ── 4. Refresh conversations to move this DM to the top ────────
                try {
                    const convsRes = await axios.get(`${API_BASE}/conversations`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    setConversations(labelSelfConversations(convsRes.data, userId));
                } catch { /* non-critical */ }
            },
        }));
    }, [servers, conversations, token, deviceId, sendInviteMessage, globalFriends, userId, toast]);

    const [activeServerView, setActiveServerView] = useState<{ serverId: string; serverName: string } | null>(null);
    const [activeChannel, setActiveChannel] = useState<ChannelInfo | null>(null);
    /** The synthetic `activeChat` ChatPane gets when a SERVER TEXT CHANNEL is
     *  open (channels aren't conversations, but ChatPane is shared). Memoised
     *  on the channel's identity rather than built as a literal in the JSX:
     *  ChatPane has an effect keyed on the whole object (the bulk call-duration
     *  fetch), so a fresh literal per render re-fired it on EVERY Dashboard
     *  render, which during a call meant a POST /calls/bulk_status per render
     *  on top of the 1 s duration ticker. */
    const activeChannelAsChat = useMemo(
        () => (activeChannel
            ? { id: activeChannel.channel_id, title: `#${activeChannel.name}`, type: 'channel', avatar_url: undefined }
            : null),
        // Narrowed on purpose: the result is derived from channel_id + name only,
        // and activeChannel gets a fresh identity on every channel-list refetch.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [activeChannel?.channel_id, activeChannel?.name],
    );
    // Re-plays the shared `.view-enter` settle-in on the list column whenever
    // the VIEW it shows changes (which tab, or which server). It stays mounted
    // across DMs↔servers and server→server, so — unlike pane 3, which is keyed
    // on chat/channel — nothing would otherwise re-trigger it, and the column
    // snapped while the chat beside it faded. Deliberately NOT keyed on the
    // active chat: a DM→DM switch changes nothing in this list.
    const pane2EnterRef = useViewEnter<HTMLElement>(`${activeTab}|${activeServerView?.serverId ?? ''}`);

    /** Bumped whenever the user saves a per-server retention setting so the
     *  activeChannelRetention memo re-reads localStorage immediately. */
    const [channelRetentionVersion, setChannelRetentionVersion] = useState(0);

    /** Bumped whenever ConvRetentionSection writes a per-conversation override
     *  so activeConvRetention re-reads localStorage immediately. */
    const [convRetentionVersion, setConvRetentionVersion] = useState(0);

    /** Server whose channel list we want to auto-select once it loads.
     *  Driven by the server-icon-click handler in Pane 1. Cleared once an
     *  effect picks the channel. See the effect below for semantics. */
    const [pendingChannelSelect, setPendingChannelSelect] = useState<string | null>(null);
    /** DM/Group type we want to auto-open a conversation for once one is
     *  available. Driven by the DMs/Groups rail-icon click handlers. The
     *  DM/Group case for the same problem pendingChannelSelect solves above:
     *  clicking the icon right after boot can land before `conversations`
     *  has finished its first fetch, so resolving synchronously at click
     *  time (the old behavior) silently no-ops with nothing to select and
     *  never retries — the user sees a populated sidebar once the fetch
     *  lands but an empty chat pane until they click a conversation
     *  themselves. This makes it a pending intent an effect fulfills as
     *  soon as data arrives, same as the server flow. */
    const [pendingNavSelect, setPendingNavSelect] = useState<'dm' | 'group' | null>(null);
    /** Server-SAVED message IDs per channel (pinned or not) — server-backed
     *  (GET /v1/channels/:cid/saves). A saved message never expires; this set
     *  also exempts it from the local retention sweep. Loaded on channel
     *  entry, reconnect, and on channel:pins_changed / saves_changed.
     *  Previously called `channelPins`. */
    const [channelServerSaves, setChannelServerSaves] = useState<Record<string, string[]>>({});
    /** The PINNED subset of channelServerSaves per channel (every pinned
     *  message is saved). Drives Pin/Unpin and the pinned-messages panel. */
    const [channelPinnedIds, setChannelPinnedIds] = useState<Record<string, string[]>>({});
    /** Write one channel's saved + pinned lists together, from one response,
     *  so they can never disagree. */
    const applyChannelSaveState = React.useCallback((cid: string, st: ChannelSaveState) => {
        setChannelServerSaves(prev => ({ ...prev, [cid]: st.saved }));
        setChannelPinnedIds(prev => ({ ...prev, [cid]: st.pinned }));
    }, []);
    /** Locally pinned message IDs per channel — stored in localStorage only,
     *  no server quota, no permission required. Mirrors the DM
     *  `pinnedMessagesState` pattern but scoped to channel messages. */
    const [localChannelPins, setLocalChannelPins] = useState<Record<string, string[]>>({});
    /** Bumps when a server-save/unsave lands so StoragePanel refetches its quota. */
    const [storageRefreshKey, setStorageRefreshKey] = useState(0);
    const [channelMessages, setChannelMessages] = useState<Record<string, any[]>>({});
    /** channelId → true once a channel-messages GET (the initial catch-up
     *  fetch OR a page from loadOlderChannelMessages) came back with fewer
     *  rows than the page limit — proof the server has nothing older than
     *  what's already loaded, since a short/empty page can only happen at
     *  the true start of history. Persists here (Dashboard never remounts)
     *  rather than in ChatPane's own local exhaustedByChannel latch, which
     *  resets — and un-hides the "Load older history" button — every time
     *  ChatPane remounts, which happens on every conversation switch. Without
     *  this, EVERY channel showed the button by default until a wasted round
     *  trip proved there was nothing to load, which is most channels, most
     *  of the time. Monotonic: only ever set true, never cleared — sending
     *  new messages doesn't add anything OLDER than what's already resident. */
    const [channelHistoryExhausted, setChannelHistoryExhausted] = useState<Record<string, boolean>>({});
    /** True while a channel's catch-up fetch (handleSelectChannel) hasn't
     *  resolved even once — lets ChatPane hold its loading spinner instead of
     *  flashing the "no history yet" empty state before channelMessages[id]
     *  is actually populated. Cleared (success or failure) once the fetch
     *  settles; fetchedChannelIdsRef then skips re-arming it on a later
     *  revisit to the same channel, matching the fetchedServerIds/
     *  fetchedChatIds "first visit only" pattern already used in ChatPane. */
    const [channelMessagesFetching, setChannelMessagesFetching] = useState<Record<string, boolean>>({});
    const fetchedChannelIdsRef = useRef<Set<string>>(new Set());
    /**
     * server_id → ms epoch of the newest message across any of its channels.
     * The server-side counterpart to `lastActivityAt` (which only covers DM /
     * group conversations), so HomePanel's "Pick back up" can rank a server
     * against a conversation on the same axis — without a clock a server could
     * only ever sort last.
     *
     * Derived, not persisted state: channelMessages is itself restored from
     * the encrypted local cache on boot, so a memo over it survives restarts
     * exactly as well as a stored map would, with no effect writing state
     * during render.
     */
    const serverLastActivityAt = useMemo<Record<string, number>>(() => {
        const out: Record<string, number> = {};
        for (const [srvId, chs] of Object.entries(serverChannels)) {
            let newest = 0;
            for (const ch of chs) {
                const msgs = channelMessages[ch.channel_id];
                const last = msgs?.[msgs.length - 1];
                if (!last) continue;
                const t = new Date(last.sent_at_client || last.timestamp || last.received_at_server || 0).getTime();
                if (t > newest) newest = t;
            }
            if (newest > 0) out[srvId] = newest;
        }
        return out;
    }, [channelMessages, serverChannels]);
    /** userId→hex role-color emitted by ServerContextPanel; threaded to ChatPane + CallPane. */
    // serverId → (userId → hex | null). Stored per-server so navigating to a
    // different server doesn't overwrite the role colors for the call's server.
    const [serverMemberRoleColors, setServerMemberRoleColors] = useState<Record<string, Record<string, string | null>>>({});
    /** serverId → (userId → avatar attachment ID | null). Pre-seeds fallbackAvatars in SidebarConference. */
    const [serverMemberAvatarMaps, setServerMemberAvatarMaps] = useState<Record<string, Record<string, string | null>>>({});
    /** userId→server-nickname emitted by ServerContextPanel; used in ChatPane to display
     *  the correct display name for server channel messages. */
    const [serverMemberNicknames, setServerMemberNicknames] = useState<Record<string, string>>({});
    const [showCreateServerModal, setShowCreateServerModal] = useState(false);
    const [showJoinServerModal, setShowJoinServerModal] = useState(false);
    const [showServerSettings, setShowServerSettings] = useState(false);
    /**
     * Deep link for the next Server Settings open — see ServerSettingsModal's
     * `tabRequest`. Nothing sets it today (its two callers, the cancel-flow
     * server warning and the owner-grace banner, were removed 2026-10-04 with the
     * lapsed-owner deletion policy); it stays wired, and is cleared on close so a
     * stale request can never leak into a later open.
     */
    const [serverSettingsTabRequest, setServerSettingsTabRequest] =
        useState<{ tab: ServerSettingsTab; nonce: number } | undefined>(undefined);
    const [showMemberOptionsModal, setShowMemberOptionsModal] = useState(false);
    const [showInviteModal, setShowInviteModal] = useState(false);
    const [deepLinkInviteCode, setDeepLinkInviteCode] = useState<string | null>(initialDeepLinkInviteCode ?? null);
    // The useState initializer above only covers cold start (Dashboard mounts
    // AFTER the code already arrived). The common case — app already running
    // and signed in, OS delivers a NEW cipherline://invite/<code> via macOS
    // open-url or Windows/Linux second-instance — updates App.tsx's state and
    // the prop changes, but a useState initializer never re-runs on a prop
    // change, so the modal silently never opened. Sync it explicitly.
    useEffect(() => {
        if (initialDeepLinkInviteCode) setDeepLinkInviteCode(initialDeepLinkInviteCode);
    }, [initialDeepLinkInviteCode]);
    /** Incremented when the server settings modal closes so ServerContextPanel
     *  re-fetches roles (new/deleted roles appear in the right-click menu). */
    const [serverRolesRefreshKey, setServerRolesRefreshKey] = useState(0);
    const [showAddServerMenu, setShowAddServerMenu] = useState(false);
    const addServerMenuRef = useRef<HTMLDivElement>(null);
    useDismissOnOutsideClick(addServerMenuRef, showAddServerMenu, () => setShowAddServerMenu(false));
    /** Channel ID of the voice channel the local user is currently connected to. */
    const [activeVoiceChannelId, setActiveVoiceChannelId] = useState<string | null>(null);
    /** Live participant lists per voice channel, keyed by channel_id. */
    const [voiceParticipants, setVoiceParticipants] = useState<Record<string, string[]>>({});
    // ──────────────────────────────────────────────────────────────────────────
    const [closeDialogState, setCloseDialogState] = useState<{ id: string, title: string, isGroup?: boolean } | null>(null);
    const [deleteDataChecked, setDeleteDataChecked] = useState(false);
    const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
    const [showStartDMModal, setShowStartDMModal] = useState(false);
    /** Shared media/files/links browser for the active DM/group. Null = closed. */
    const [sharedContentTab, setSharedContentTab] = useState<SharedTab | null>(null);
    // Close the browser when the conversation changes — it reads the active
    // chat's messages and must never show one conversation's media under
    // another's title.
    useEffect(() => { setSharedContentTab(null); }, [activeChat?.id]);
    const [addToGroupTarget, setAddToGroupTarget] = useState<{ user_id: string; username: string; avatar_url?: string } | null>(null);
    const [createGroupPreselected, setCreateGroupPreselected] = useState<{ user_id: string; username: string; avatar_url?: string }[]>([]);
    const [sidebarBlockConfirm, setSidebarBlockConfirm] = useState<{ userId: string; username: string } | null>(null);
    
    // Sidebar context menu — DMs / groups in the conversation list. Built via
    // the canonical useContextMenu hook (which itself uses useDismissOnOutsideClick
    // + the global 'close-all-popovers' signal — see the hook's docstring).
    const sidebarMenu = useContextMenu();

    // Server rail context menu — right-click on a server icon.
    const serverRailMenu = useContextMenu();

    // Friend-list row context menu (MoreVertical button or right-click on a friend row).
    const friendListMenu = useContextMenu();

    // Group-chat member row context menu.
    const groupMemberMenu = useContextMenu();

    // ── Server & channel notification preferences ─────────────────────────────
    // serverNotifPrefs: 3-mode per server ('all' | 'mentions' | 'none')
    // channelNotifPrefs: per-channel override ('all' | 'mentions' | 'none')
    // Persisted to localStorage keyed per user.
    const [serverNotifPrefs, setServerNotifPrefs] = useState<Record<string, NotifMode>>(() => {
        try {
            const saved = secureLocalStore.getItem(`cipherline_server_notif_prefs_${userId}`);
            if (saved) return JSON.parse(saved);
            // Migrate from old binary mutedServers list
            const old = JSON.parse(secureLocalStore.getItem(`cipherline_muted_servers_${userId}`) || 'null');
            if (Array.isArray(old)) {
                const migrated: Record<string, NotifMode> = {};
                for (const id of old) migrated[id] = 'none';
                return migrated;
            }
            return {};
        } catch { return {}; }
    });
    const [channelNotifPrefs] = useState<Record<string, NotifMode>>(() => {
        try {
            const saved = secureLocalStore.getItem(`cipherline_channel_notif_prefs_${userId}`);
            return saved ? JSON.parse(saved) : {};
        } catch { return {}; }
    });

    // Unread counts and mention counts for server channels.
    //
    // These are live-delivery counters: they're incremented by the
    // `channel:message_new` WS handler and by nothing else. They used to be
    // plain in-memory useState({}) with no persistence at all — unlike their
    // DM/group equivalents (cipherline_unread_*) and unlike channelMessages
    // itself, which IS cached — so every server/channel badge reset to zero on
    // any restart, however many unread messages were actually sitting there.
    //
    // Known remaining gap: messages that arrive while the app is fully CLOSED
    // still produce no badge, because channel messages don't go through the
    // envelope/ACK queue that backfills DMs on boot, and the channel list
    // carries no per-channel last-activity timestamp to compare against. The
    // catch-up fetch in handleSelectChannel only runs for the channel being
    // opened (whose badge is being cleared anyway). Closing that properly
    // needs a `last_message_at` on the channels payload — deliberately left
    // for a follow-up rather than fetching every channel's history on boot.
    const [channelUnreadCounts, setChannelUnreadCounts] = useState<Record<string, number>>(() => {
        if (!userId) return {};
        try { return JSON.parse(secureLocalStore.getItem(`cipherline_channel_unread_${userId}`) || '{}'); } catch { return {}; }
    });
    const [channelMentionCounts, setChannelMentionCounts] = useState<Record<string, number>>(() => {
        if (!userId) return {};
        try { return JSON.parse(secureLocalStore.getItem(`cipherline_channel_mentions_${userId}`) || '{}'); } catch { return {}; }
    });
    // Write-through, guarded the same way the home-screen state is: never
    // write while the store was unreadable (that would persist an empty map
    // over good ciphertext — see the homePersistReadyRef comment above).
    // Unlike the message caches these DO persist an empty map, because
    // "everything is read" is a real, reachable state that must survive a
    // restart; the ready-ref is what protects against the clobber case.
    useEffect(() => {
        if (!userId || !homePersistReadyRef.current) return;
        try { secureLocalStore.setItem(`cipherline_channel_unread_${userId}`, JSON.stringify(channelUnreadCounts)); } catch { /* quota — non-fatal */ }
    }, [channelUnreadCounts, userId]);
    useEffect(() => {
        if (!userId || !homePersistReadyRef.current) return;
        try { secureLocalStore.setItem(`cipherline_channel_mentions_${userId}`, JSON.stringify(channelMentionCounts)); } catch { /* quota — non-fatal */ }
    }, [channelMentionCounts, userId]);

    // Per-server role IDs for the current user — needed by handleChannelMessage to
    // decide whether a role-mention ping should trigger a notification badge/sound.
    // Populated lazily as servers are encountered; reset on logout.
    const [serverMyRoleIds, setServerMyRoleIds] = useState<Record<string, string[]>>({});
    const serverMyRoleIdsRef = useRef<Record<string, string[]>>({});

    // Refs for stale-closure avoidance in handleChannelMessage (useCallback([], []))
    const serverNotifPrefsRef = useRef(serverNotifPrefs);
    const channelNotifPrefsRef = useRef(channelNotifPrefs);
    const activeChannelRef = useRef<ChannelInfo | null>(null);
    const serversRef = useRef(servers);
    const channelUnreadCountsRef = useRef(channelUnreadCounts);
    const channelMentionCountsRef = useRef(channelMentionCounts);

    // ── Server read cursor for channels (multi-device) ───────────────────
    // POST /channels/:cid/read, optionally trailing-debounced so a burst of
    // live messages costs one request. `x-device-id` keeps the resulting
    // `channel:read` off THIS device (the server tells only our others).
    // A ref so the empty-deps handleChannelMessage always sees fresh auth.
    const channelReadTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const markChannelReadOnServerRef = useRef<(channelId: string, delayMs?: number) => void>(() => {});
    markChannelReadOnServerRef.current = (channelId: string, delayMs = 0) => {
        if (!token) return;
        const timers = channelReadTimersRef.current;
        const pending = timers.get(channelId);
        if (pending) clearTimeout(pending);
        const fire = () => {
            timers.delete(channelId);
            const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
            if (deviceId) headers['x-device-id'] = deviceId;
            axios.post(`${API_BASE}/channels/${channelId}/read`, {}, { headers })
                .catch(() => {/* non-fatal — worst case the next resync over-reports briefly */});
        };
        if (delayMs <= 0) fire();
        else timers.set(channelId, setTimeout(fire, delayMs));
    };
    useEffect(() => () => {
        for (const t of channelReadTimersRef.current.values()) clearTimeout(t);
        channelReadTimersRef.current.clear();
    }, []);

    // Keep refs in sync with state
    useEffect(() => { serverMyRoleIdsRef.current = serverMyRoleIds; }, [serverMyRoleIds]);
    useEffect(() => { serverNotifPrefsRef.current = serverNotifPrefs; }, [serverNotifPrefs]);
    useEffect(() => { channelNotifPrefsRef.current = channelNotifPrefs; }, [channelNotifPrefs]);
    useEffect(() => { activeChannelRef.current = activeChannel; }, [activeChannel]);
    useEffect(() => { serversRef.current = servers; }, [servers]);
    useEffect(() => { channelUnreadCountsRef.current = channelUnreadCounts; }, [channelUnreadCounts]);
    useEffect(() => { channelMentionCountsRef.current = channelMentionCounts; }, [channelMentionCounts]);

    // Pre-fetch the current user's role IDs for each server so that incoming
    // channel messages can be checked for role-mention pings without extra
    // round-trips.  Only fetches servers that haven't been loaded yet, so it's
    // safe to re-run whenever `servers` grows (e.g. after joining a new server).
    useEffect(() => {
        if (!servers.length || !userId || !token) return;
        servers.forEach(async (srv) => {
            // Skip if already fetched for this server (use ref to avoid stale closure).
            if (serverMyRoleIdsRef.current[srv.server_id] !== undefined) return;
            try {
                const res = await axios.get(`${API_BASE}/servers/${srv.server_id}/members`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                const myMember = (res.data as any[]).find((m: any) => m.user_id === userId);
                const raw = myMember?.role_ids;
                const parsed: string[] = Array.isArray(raw)
                    ? raw.filter(Boolean)
                    : typeof raw === 'string' && raw.startsWith('{')
                        ? raw.slice(1, -1).split(',').filter(Boolean)
                        : [];
                setServerMyRoleIds(prev => ({ ...prev, [srv.server_id]: parsed }));
            } catch {
                // Non-fatal — role mention notifications degrade silently.
                setServerMyRoleIds(prev => ({ ...prev, [srv.server_id]: [] }));
            }
        });
    }, [servers, userId, token]);

    // Persist server notif prefs
    useEffect(() => {
        if (userId) {
            try { secureLocalStore.setItem(`cipherline_server_notif_prefs_${userId}`, JSON.stringify(serverNotifPrefs)); } catch {}
        }
    }, [serverNotifPrefs, userId]);

    // ── Auto-sync notification prefs when server defaults change ─────────────
    // We persist the last-known default_notification_level per server so that,
    // even across sessions, we can detect when an admin changes the default and
    // auto-clear any non-muted explicit user override so users follow the new
    // default.  Only 'none' (muted) is preserved — the user explicitly silenced
    // that server and shouldn't be un-silenced by an admin action.
    const serverDefaultsCacheRef = useRef<Record<string, string | null>>((() => {
        try {
            const saved = secureLocalStore.getItem(`cipherline_server_notif_defaults_${userId}`);
            return saved ? (JSON.parse(saved) as Record<string, string | null>) : {};
        } catch { return {}; }
    })());

    useEffect(() => {
        if (!servers.length || !userId) return;

        const cache = serverDefaultsCacheRef.current;
        const newCache: Record<string, string | null> = {};

        setServerNotifPrefs(prev => {
            let next = prev;
            for (const srv of servers) {
                const newDefault = srv.default_notification_level ?? null;
                newCache[srv.server_id] = newDefault;

                const cachedDefault = cache[srv.server_id];
                // `undefined` means we've never seen this server — skip so we
                // don't wipe prefs on first load.
                if (cachedDefault !== undefined && cachedDefault !== newDefault) {
                    const userPref = prev[srv.server_id];
                    // Clear any non-muted explicit override so the user inherits
                    // the new server default.
                    if (userPref !== undefined && userPref !== 'none') {
                        if (next === prev) next = { ...prev };
                        delete (next as Record<string, NotifMode>)[srv.server_id];
                    }
                }
            }
            return next;
        });

        serverDefaultsCacheRef.current = newCache;
        try {
            secureLocalStore.setItem(`cipherline_server_notif_defaults_${userId}`, JSON.stringify(newCache));
        } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [servers, userId]);
    // Persist channel notif prefs
    useEffect(() => {
        if (userId) {
            try { secureLocalStore.setItem(`cipherline_channel_notif_prefs_${userId}`, JSON.stringify(channelNotifPrefs)); } catch {}
        }
    }, [channelNotifPrefs, userId]);

    /** The server the user has chosen to leave; drives a confirm dialog. */
    const [leaveServerTarget, setLeaveServerTarget] = useState<ServerInfo | null>(null);

    /** Fixed-position tooltip shown when hovering a server icon in the nav rail.
     *  `anchor` is the hovered icon's getBoundingClientRect() (viewport
     *  coordinates); actual on-screen placement is resolved by
     *  computeTooltipPlacement below once the tooltip node is measured, so a
     *  long name near the bottom (or either horizontal edge) of the rail
     *  clamps inside the viewport instead of running off-screen. Kept as a
     *  plain fixed-position node (not migrated to useClTooltip) because this
     *  is one hook instance shared across every rail item via mouse-driven
     *  state, not a per-item hover primitive — migrating would mean calling
     *  useClTooltip inside the rail's .map(), which breaks the rules of
     *  hooks (see DmAvatarBadge's comment for the same tradeoff done the
     *  other way, where a component-per-row split was cheap). */
    const [railTooltip, setRailTooltip] = useState<{
        name: string;
        anchor: TooltipRect;
        muted: boolean;
        /** Who is in a call in this server, already capped for display, or null
         *  when nothing visible is happening. Captured at hover time from
         *  serverCallPresence — see the badge for why an invisible call yields
         *  nothing here rather than an empty roster. */
        call: { names: string[]; overflow: number; total: number } | null;
    } | null>(null);
    const [railTooltipPlacement, setRailTooltipPlacement] = useState<TooltipPlacement | null>(null);
    // Callback ref rather than a measure-in-effect: it fires synchronously at
    // mount/commit time (React re-attaches it whenever `railTooltip` changes,
    // since that's this callback's useCallback dependency), which is enough
    // to place the tooltip before the next paint without an extra render
    // pass — and sidesteps the "don't setState synchronously in an effect"
    // lint rule that a `useLayoutEffect` doing the same measurement here
    // would trip.
    const railTooltipRef = useCallback((node: HTMLDivElement | null) => {
        if (!node || !railTooltip) { setRailTooltipPlacement(null); return; }
        const t = node.getBoundingClientRect();
        setRailTooltipPlacement(computeTooltipPlacement(
            railTooltip.anchor,
            { width: t.width, height: t.height },
            { width: window.innerWidth, height: window.innerHeight },
            { preferred: 'right' },
        ));
    }, [railTooltip]);

    // Group members for right-hand panel
    const [groupMembers, setGroupMembers] = useState<any[]>([]);
    const [groupMembersLoading, setGroupMembersLoading] = useState(false);
    // Group settings modal (opened from RH panel or sidebar context menu)
    const [manageGroupOpen, setManageGroupOpen] = useState(false);

    // DM partner public profile (bio, banner) fetched when activeChat changes
    const [dmPartnerProfile, setDmPartnerProfile] = useState<{
        banner_url: string | null;
        bio: string | null;
        status: string;
        last_seen_at: string | null;
        avatar_url: string | null;
    } | null>(null);

    const handleSidebarBlock = async (userId: string, username: string) => {
        setSidebarBlockConfirm({ userId, username });
    };

    const confirmSidebarBlock = async () => {
        if (!sidebarBlockConfirm) return;
        try {
            await axios.post(`${API_BASE}/friends/block`, { target_id: sidebarBlockConfirm.userId }, {
                headers: { Authorization: `Bearer ${token}` }
            });
        } catch (err) {
            console.error('Block failed', err);
        } finally {
            setSidebarBlockConfirm(null);
        }
    };


    
    // Global Incoming Call State
    const [globalIncomingCall, setGlobalIncomingCall] = useState<{
        session_id: string;
        e2ee_key_b64: string;
        sender: string;
        conversation_id: string;
        callerName: string;
        callerAvatarId: string | null;
        /** Caller's user_id for deterministic colored fallback avatar.
         *  For group calls this is still the inviter's id (avatar still shows),
         *  but `isGroup` below swaps to the Group icon treatment. */
        callerUserId: string | null;
        /** True when the incoming call is from a group conversation — the
         *  fallback avatar becomes the neutral <Users> icon instead of a
         *  user-color + <User> silhouette. */
        isGroup: boolean;
        /**
         * The caller's identity standing, computed once when the `call_key`
         * lands (see `deriveContactTrust`). Replaces the former
         * `senderUnverified: boolean`, which could only say verified/not and so
         * rendered the same mild amber disclaimer for "we have never met" as
         * for "a contact you verified is presenting a key you never vouched
         * for" — the second being a forgery signature, not a to-do item.
         *
         * Null for a group call: the trust question there is per-member, and a
         * single badge over a group would have to pick one member's answer and
         * imply it covers everyone.
         */
        callerTrust: ContactTrust | null;
    } | null>(null);

    const [activeChatCallStatus, setActiveChatCallStatus] = useState<any>(null);
    const [callCardVisible, setCallCardVisible] = useState(false);
    const lastDisconnectTimeRef = useRef<number>(0);
    const [callParticipantCount, setCallParticipantCount] = useState<number>(0);

    useEffect(() => {
        if (!activeChat || !token) {
            setActiveChatCallStatus(null);
            return;
        }
        let active = true;
        const fetchStatus = async () => {
            try {
                const res = await axios.get(`${API_BASE}/calls/conversation/${activeChat.id}/active`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (active) {
                    if (Date.now() - lastDisconnectTimeRef.current < 20000) {
                        // Suppress banner locally to prevent ghost banner while LiveKit unregisters the room 
                        // (LiveKit takes ~15s to send webhook to end the session if we were the last one).
                        setActiveChatCallStatus(null);
                    } else {
                        setActiveChatCallStatus(res.data.active ? res.data : null);
                    }
                }
            } catch (e) {
                if (active) setActiveChatCallStatus(null);
            }
        };
        fetchStatus();
        const interval = setInterval(fetchStatus, 3000);
        return () => {
            active = false;
            clearInterval(interval);
        };
    }, [activeChat?.id, token]);

    // Drive presence of the active call card — AnimatePresence handles the exit animation.
    useEffect(() => {
        setCallCardVisible(!!(activeChatCallStatus?.active));
    }, [activeChatCallStatus?.active]);

    useEffect(() => {
        if (!globalIncomingCall) return;
        // Through playLoopingSound, not a bare `new Audio()`: that bypassed the
        // notification prefs entirely (a user with every sound off, or the call
        // category off, still got 15 seconds of looping ringtone at full volume,
        // ignoring master_volume) AND the output-device routing, so it rang out
        // of the system default while the call itself played on the chosen
        // headset. Same shape as CallPane's outgoing ringback.
        //
        // Category is 'call' (call_sound.wav) — 'ringing' is the OUTGOING
        // ringback, a different cue with its own settings row. useNotification-
        // Dispatch deliberately skips its one-shot for category 'call' so this
        // loop is the only cue an incoming call produces; keeping the category
        // aligned is what makes that opt-out coherent.
        //
        // playLoopingSound returns a no-op stopper when the cue is suppressed,
        // so the cleanup path below stays unconditional and identical.
        const stopRing = playLoopingSound('call', notifGlobalPrefsRef.current);

        const timeout = setTimeout(() => {
            setGlobalIncomingCall(null); // 15s ring timeout
        }, 15000);

        return () => {
            stopRing();
            clearTimeout(timeout);
        };
    }, [globalIncomingCall]);

    useEffect(() => {
        if (globalIncomingCall && !activeCall) {
            (window as any).electronAPI?.setTitleBarColor?.('#25E0C8');
        } else {
            // Match the app's top drag bar (bg-cl-abyss) so the window controls blend in.
            (window as any).electronAPI?.setTitleBarColor?.('#0B0F1E');
        }
    }, [globalIncomingCall, activeCall]);

    const acceptGlobalCall = async () => {
        if (!globalIncomingCall || !token) return;
        try {
            // Leave any active server voice/huddle call before answering.
            if (activeVoiceChannelId) {
                try {
                    await axios.post(
                        `${API_BASE}/channels/${activeVoiceChannelId}/leave_voice`,
                        {},
                        { headers: { Authorization: `Bearer ${token}` } },
                    );
                } catch { /* best-effort */ }
                setActiveVoiceChannelId(null);
            }
            if (activeHuddleCallId) {
                try { await leaveHuddleCall(activeHuddleCallId); } catch { /* best-effort */ }
                setActiveHuddleCallId(null);
                setActiveHuddleChannelId(null);
            }
            // x-device-id lets the server tell "this device answering" apart
            // from "another of my devices already answered" (the multi-device
            // answer race — see calls.service.ts's joinCall) — without it the
            // server falls back to no-claim behavior, not a hard failure.
            const res = await axios.post(`${API_BASE}/calls/${globalIncomingCall.session_id}/join`, {}, { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } });
            setActiveCall({
                id: globalIncomingCall.session_id,
                conversation_id: globalIncomingCall.conversation_id,
                livekit_url: res.data.livekit_url,
                livekit_token: res.data.livekit_token,
                e2ee_key_b64: globalIncomingCall.e2ee_key_b64,
                videoByDefault: false,
                mode: 'sfu'
            });
            setCallStartedAt(Date.now());
            setGlobalIncomingCall(null);
        } catch (e: any) {
            console.error('Failed to accept global call', e);
            setGlobalIncomingCall(null);
            // 409 = another of this user's devices already claimed this call
            // (the multi-device answer race — see joinCall's Redis claim).
            // Not an error from this device's perspective, just "too slow."
            if (e?.response?.status === 409) {
                toast.push({ kind: 'info', title: 'Answered elsewhere', message: 'This call was already answered on your other device.' });
            } else {
                toast.push({ kind: 'error', title: 'Call Failed', message: 'Cannot connect. The call might have ended.' });
            }
        }
    };

    const handleDisconnectCall = async (wasLastPerson: boolean = false) => {
        // Disconnecting from LiveKit locally natively removes us from the room.
        // If we were the last person (or if we explicitly terminated the call), suppress the trailing ghost banner.
        if (wasLastPerson) {
            lastDisconnectTimeRef.current = Date.now();
            setActiveChatCallStatus(null);
        }

        // Voice channel call — notify server we left so participant count
        // updates. Fire-and-forget: leaving must never block on a round-trip.
        if (activeVoiceChannelId && token) {
            const vcId = activeVoiceChannelId;
            setActiveVoiceChannelId(null);
            axios.post(
                `${API_BASE}/channels/${vcId}/leave_voice`,
                {},
                { headers: { Authorization: `Bearer ${token}` } },
            ).catch(e => console.error('[Dashboard] Failed to leave voice channel:', e));
        } else if (activeHuddleCallId) {
            // Huddle call — delegate to handleLeaveHuddleCall which handles
            // optimistic state updates + server leave notification + WS fan-out.
            // handleLeaveHuddleCall is defined later in this component but only
            // called at runtime (after the full render), so TDZ is not an issue.
            handleLeaveHuddleCall();
        } else if (activeCall?.isInitiator && callParticipantCount <= 1 && activeCall.id) {
            // Cancel it on the backend if we initiated it and nobody joined —
            // fire-and-forget so the local teardown is instant.
            axios.post(`${API_BASE}/calls/${activeCall.id}/end`, {}, { headers: { Authorization: `Bearer ${token}` }})
                .catch(e => console.error('Failed to end call:', e));
        }

        setActiveCall(null);
        setHasFocusedStream(false);
    };
    // rehydrateAll (defined much later) runs from long-lived listeners and
    // needs to invoke today's handleDisconnectCall, not whatever closure
    // existed when rehydrateAll's useCallback was last recreated — same ref
    // pattern as fetchConversationsRef/fetchFriendsRef below.
    const handleDisconnectCallRef = useRef(handleDisconnectCall);
    useEffect(() => { handleDisconnectCallRef.current = handleDisconnectCall; });

    /**
     * Called by ChatPane's onCallChange when a DM or group call is started or
     * answered. Leaves any active server voice/huddle call first so the server
     * participant list updates immediately. Plain async function (no useCallback)
     * so the deps array — which executes synchronously at render time — never
     * forward-references state declared later in the component body (TDZ guard).
     */
    const handleConvCallChange = async (callData: typeof activeCall) => {
        if (callData) {
            // Same reason as startGlobalCall's: ChatPane generated this key and
            // broadcast it to every device EXCEPT this one, so this is the only
            // chance to record it. Covers the rotation path too (a rotated key
            // supersedes the one it replaces for any later join).
            if (callData.e2ee_key_b64) recordCallKeyRef.current(callData.id, callData.e2ee_key_b64);
            // Starting/joining a conversation call — leave any active server call.
            if (activeVoiceChannelId && token) {
                try {
                    await axios.post(
                        `${API_BASE}/channels/${activeVoiceChannelId}/leave_voice`,
                        {},
                        { headers: { Authorization: `Bearer ${token}` } },
                    );
                } catch { /* best-effort */ }
                setActiveVoiceChannelId(null);
            }
            if (activeHuddleCallId) {
                try { await leaveHuddleCall(activeHuddleCallId); } catch { /* best-effort */ }
                setActiveHuddleCallId(null);
                setActiveHuddleChannelId(null);
            }
        }
        setActiveCall(callData);
    };

    const [showSoloKickDialog, setShowSoloKickDialog] = useState(false);
    // Session ID currently showing (or about to show) SidebarConference's own
    // live inactivity countdown — set/cleared via CallPane's onInactivityWarning.
    // A late server-side call:solo_kick for the SAME session is that server
    // catching up on a kick the client already owns (see SidebarConference's
    // "Solo inactivity kick" effect for the full timing rationale), not a
    // second real kick — the soloKickEvent effect below uses this to skip the
    // redundant SoloKickDialog. Ref, not state: purely read inside an effect,
    // no re-render needed.
    const inactivityWarningSessionRef = useRef<string | null>(null);

    // Notifications State
    const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>(() => {
        try {
            return JSON.parse(secureLocalStore.getItem(`cipherline_unread_${userId}`) || '{}');
        } catch { return {}; }
    });
    const [unreadFriends, setUnreadFriends] = useState<number>(() => {
        try {
            return JSON.parse(secureLocalStore.getItem(`cipherline_unread_friends_${userId}`) || '0');
        } catch { return 0; }
    });
    // Write-through persistence for unread + mention badges. Previously only
    // SOME unread-update paths persisted (increments and mark-read didn't) and
    // mentions never did, so badges reset or went stale across restarts —
    // "everything clears out after a reboot". One effect per map covers every
    // update path, current and future.
    //
    // homePersistReadyRef guard: these were the only badge-persist effects
    // without it. If a per-account record ever fails to decrypt, the state
    // starts {} and this effect immediately writes {} back over the stored
    // value — turning a transient read miss into permanent loss. Same reason
    // the home-screen state above is guarded; see that comment.
    useEffect(() => {
        if (!userId || !homePersistReadyRef.current) return;
        try { secureLocalStore.setItem(`cipherline_unread_${userId}`, JSON.stringify(unreadCounts)); } catch {}
    }, [unreadCounts, userId]);
    useEffect(() => {
        if (!userId || !homePersistReadyRef.current) return;
        try { secureLocalStore.setItem(`cipherline_mentions_${userId}`, JSON.stringify(mentionCounts)); } catch {}
    }, [mentionCounts, userId]);
    // unreadFriends was never persisted at all — a restart with a pending,
    // unopened friend request silently reset the Friends rail badge to 0
    // even though channelUnreadCounts/channelMentionCounts already survived
    // restarts. Same write-through pattern as those two.
    useEffect(() => {
        if (!userId || !homePersistReadyRef.current) return;
        try { secureLocalStore.setItem(`cipherline_unread_friends_${userId}`, JSON.stringify(unreadFriends)); } catch {}
    }, [unreadFriends, userId]);

    // Ref for DND check in playNotification - updated after useUserStatus hook is set up below
    const myStatusRef = useRef<string>('online');

    // ── Notifications (v2) ──────────────────────────────────────────────────────
    // The dispatch hook owns sound + OS toast + DND/mode gating. We pass live
    // DND-context state (status / in-call / game) via a ref so the stable
    // `notify` callback always sees the latest without re-binding.
    const notify = useNotificationDispatch();
    const { prefs: notifGlobalPrefs, updatePrefs: updateNotifPrefs } = useNotificationPrefs();
    const notifGlobalPrefsRef = useRef(notifGlobalPrefs);
    useEffect(() => { notifGlobalPrefsRef.current = notifGlobalPrefs; }, [notifGlobalPrefs]);
    const notifCtxRef = useRef({ userStatus: 'online', activeCall: false, screensharing: false, gameActive: false });

    const playNotification = useCallback((category: SoundCategory = 'message') => {
        if (myStatusRef.current === 'dnd') return; // DND: suppress all sounds (legacy fallback path)
        // Through playSound, not a bare `new Audio()`: that bypassed
        // sounds_enabled, the per-category toggle and master_volume (a user
        // with sounds off still got one at full volume) AND the output-device
        // routing, so it played on the system default rather than the output
        // chosen in Voice & Video settings.
        //
        // The category is a parameter now. Its two callers — a friend request
        // arriving and one being accepted — used to share the generic message
        // cue, so socially they were indistinguishable from a chat message.
        // They have their own sounds as of the round-two set ('Hail' and
        // 'Link'); 'message' stays the default so any future caller that just
        // wants "something arrived" keeps the old behaviour.
        // Read through the ref so the callback stays dependency-free and its
        // callers' effects don't re-fire on every prefs change.
        playSound(category, notifGlobalPrefsRef.current);
    }, []);

    // Custom resizable panels — proportional to window width.
    // We store the user's preferred sidebar size as a RATIO of window width
    // (not a fixed pixel count), so when the window resizes — especially on
    // ultrawide monitors — the sidebars scale with it. Drag still works: it
    // converts the new pixel width back to a ratio, which is then applied on
    // every subsequent resize. Ratios are persisted across launches.
    const containerRef = useRef<HTMLDivElement>(null);

    // Sidebar size constraints. Min prevents the text from getting unreadable.
    // Max scales with window: on a 1280px screen max is 500; on a 3440px
    // ultrawide max is ~1000 (35% of width), so a manually-dragged 700px
    // sidebar still looks proportional instead of hugging the drag limit.
    const SIDEBAR_MIN_PX = 200;
    // The right context panel packs denser content (Shared tiles, storage rows,
    // retention selects) than the chat list, so it gets a higher floor — below
    // this its labels/tiles start wrapping.
    const RIGHT_PANEL_MIN_PX = 280;
    const sidebarMaxPx = (winW: number) => Math.max(500, Math.round(winW * 0.35));

    const DEFAULT_LEFT_RATIO  = 0.18; // ~18% of window
    const DEFAULT_RIGHT_RATIO = 0.20; // ~20% of window

    const [leftRatio, setLeftRatio] = useState<number>(() => {
        const saved = parseFloat(secureLocalStore.getItem('cipherline_left_sidebar_ratio') || '');
        return Number.isFinite(saved) && saved > 0 && saved < 0.5 ? saved : DEFAULT_LEFT_RATIO;
    });
    const [rightRatio, setRightRatio] = useState<number>(() => {
        const saved = parseFloat(secureLocalStore.getItem('cipherline_right_sidebar_ratio') || '');
        return Number.isFinite(saved) && saved > 0 && saved < 0.5 ? saved : DEFAULT_RIGHT_RATIO;
    });

    // Window width state so width recomputes on resize (not just drag).
    const [windowWidth, setWindowWidth] = useState<number>(() =>
        typeof window === 'undefined' ? 1280 : window.innerWidth
    );
    useEffect(() => {
        const onResize = () => setWindowWidth(window.innerWidth);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    // Persist ratios when they change.
    useEffect(() => {
        try { secureLocalStore.setItem('cipherline_left_sidebar_ratio',  String(leftRatio));  } catch {}
    }, [leftRatio]);
    useEffect(() => {
        try { secureLocalStore.setItem('cipherline_right_sidebar_ratio', String(rightRatio)); } catch {}
    }, [rightRatio]);

    // Derive actual pixel widths from ratios + current window size.
    // Also honored during drag — the drag handler updates the ratio, and this
    // memo recomputes the pixel width on the next render.
    const leftWidth = useMemo(() => {
        const target = leftRatio * windowWidth;
        return Math.max(SIDEBAR_MIN_PX, Math.min(sidebarMaxPx(windowWidth), target));
    }, [leftRatio, windowWidth]);
    const rightWidth = useMemo(() => {
        const target = rightRatio * windowWidth;
        return Math.max(RIGHT_PANEL_MIN_PX, Math.min(sidebarMaxPx(windowWidth), target));
    }, [rightRatio, windowWidth]);

    // At or below ~1370px of window the chat column gets too cramped for a
    // focused video to be comfortable, so the focused pane spans the
    // conversation / channel list column too and that list takes the height
    // underneath. See useFocusLayout.ts for the derivation — and note the
    // threshold is a comfort preference, not a legibility floor, so it is
    // meant to be moved on request. The server rail is never covered.
    const focusSpansSidebar = useFocusSpansSidebar();

    const draggingRef = useRef<null | 'left' | 'right'>(null);
    const dragStartX = useRef(0);
    const dragStartWidth = useRef(0);

    const onDividerMouseDown = useCallback((side: 'left' | 'right') => (e: React.MouseEvent) => {
        e.preventDefault();
        draggingRef.current = side;
        dragStartX.current = e.clientX;
        dragStartWidth.current = side === 'left' ? leftWidth : rightWidth;

        const onMouseMove = (ev: MouseEvent) => {
            if (!draggingRef.current) return;
            const delta = ev.clientX - dragStartX.current;
            const winW = window.innerWidth;
            const maxPx = sidebarMaxPx(winW);
            if (draggingRef.current === 'left') {
                const newPx = Math.max(SIDEBAR_MIN_PX, Math.min(maxPx, dragStartWidth.current + delta));
                setLeftRatio(newPx / winW);
            } else {
                // Cap rightWidth so the panel never pushes the chat area off-screen.
                // Available space = window − nav (68) − current left − 16px of dividers
                // − 280px minimum for the chat area.
                const rightHardMax = Math.max(RIGHT_PANEL_MIN_PX, winW - 68 - leftWidth - 16 - 280);
                const newPx = Math.max(RIGHT_PANEL_MIN_PX, Math.min(Math.min(maxPx, rightHardMax), dragStartWidth.current - delta));
                setRightRatio(newPx / winW);
            }
        };

        const onMouseUp = () => {
            draggingRef.current = null;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }, [leftWidth, rightWidth]);

    // Phase 3 (RC-3): per-envelope transient-failure counter, mirroring
    // pullChannelKeys' envelopeFailureCountRef but kept separate since these
    // are a different namespace of ids/failures. A permanent classification
    // is given up on immediately; a transient one gets 3 strikes first —
    // never an unbounded 5s-forever retry loop. "Giving up" stores a visible
    // placeholder before the ACK (utils/dmInbound.ts decryptFailureOutcome).
    const messageFailureCountRef = React.useRef<Map<string, number>>(new Map());

    // Message integrity §3 (utils/dmInbound.ts): envelopes this session
    // decrypted but could not yet STORE, keyed by envelope id. They are left
    // un-ACKed on the server, and when the next pull returns them they are
    // stored from here instead of being decrypted again — a second decrypt of
    // the same ciphertext is a REPLAY, a permanent failure that would ACK the
    // only copy away. In memory only: their messages are also in React state,
    // which useCoalescedPersist flushes on quit/hide/unmount.
    const unpersistedDmRef = React.useRef<Map<string, PulledForStore>>(new Map());

    // Boot gate for the DM pull. The restore effect REPLACES messagesState with
    // the stored history (`setMessagesState(await messageStore.loadAll(...))`).
    // A pull that lands first puts its messages into the still-empty state, the
    // coalesced persist then writes those threads holding ONLY the new
    // messages, and the replace drops them from state — both copies of the
    // thread lose data. So no pull runs until the stored history is in state.
    // The 5 s poll (and the explicit pull the restore effect fires once it has
    // loaded) picks up whatever is waiting; un-ACKed envelopes wait safely.
    const dmHistoryLoadedRef = React.useRef(false);

    // Re-entrancy latch for pullMessages. The WS `message:new` push and the 5 s
    // fallback poll both call it, and it awaits a GET, N decrypts, and an ACK
    // POST before touching state — a wide window for a second call to start.
    // Two concurrent pulls fetch the SAME envelopes (the server only drops them
    // on ACK), so both would decrypt them, both would count them, and both would
    // notify: one message, two unread, two dings. Worse, decrypting an envelope
    // consumes its one-time prekey, so whichever pull loses the race fails on
    // material the winner already spent and burns strikes against a message that
    // was never actually broken.
    //
    // Latch rather than drop: a call that arrives mid-flight sets `again`, and
    // the in-flight run loops once more when it finishes. Dropping it outright
    // would lose the ping for a message that landed after the current GET had
    // already returned, stranding it until the next 5 s tick.
    const pullInFlightRef = React.useRef(false);
    const pullAgainRef = React.useRef(false);

    // Hoist pullMessages so it can be called both by the WS push AND the polling interval
    const pullMessagesOnce = React.useCallback(() => trackActivity('dm:pull', async () => {
        if (!token || !deviceId || !userId) return;
        if (!dmHistoryLoadedRef.current) return; // see dmHistoryLoadedRef
        try {
            const res = await axios.get(`${API_BASE}/messages/pull`, {
                headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId }
            });
            // Any queued pin ops from our other devices have now been delivered,
            // so the retention sweep is safe to run. Set on a successful pull
            // even when it's empty — empty means there was nothing waiting.
            firstPullDoneRef.current = true;

            if (res.data && res.data.length > 0) {
                // Fresh this pull: drives notifications, counters and state.
                const newMsgsByConv: Record<string, any[]> = {};
                // Everything that must be ON DISK before its envelope is ACKed
                // (the ACK deletes the server's copy): decrypted messages,
                // placeholders, and envelopes carried from an earlier pull.
                const toStore: PulledForStore[] = [];
                // Envelopes with nothing to store (legacy, replay).
                const ackOnly: string[] = [];
                const keepPlaceholder = (env: any, reason: string) => {
                    const placeholder = undecryptablePlaceholder(env, reason);
                    (newMsgsByConv[env.conversation_id] ||= []).push(placeholder);
                    toStore.push({ envelopeId: env.envelope_id, conversationId: env.conversation_id, message: placeholder });
                };

                for (const env of res.data) {
                    // Decrypted on an earlier pull, not yet stored: store it,
                    // never decrypt it twice (see unpersistedDmRef).
                    const carried = unpersistedDmRef.current.get(env.envelope_id);
                    if (carried) { toStore.push(carried); continue; }

                    let decryptResult: { contentJson: string; senderPub?: string; senderUserId?: string; senderDeviceId?: string; usedOneTimePrekey?: boolean };
                    try {
                        decryptResult = await window.electronAPI!.decryptMessage(env.ciphertext_b64, deviceId!);
                    } catch (decryptErr) {
                        // Phase 1: this used to be the ONLY trace of a decrypt failure —
                        // a console line that vanished the moment DevTools wasn't open.
                        recordDelivery('message_decrypt', decryptErr, { envelope_id: env.envelope_id, conversation_id: env.conversation_id });
                        console.error('Failed to decrypt envelope', decryptErr);
                        // Phase 3 (RC-3) + Message integrity §2 (utils/dmInbound.ts):
                        // permanent failures are given up on at once, transient ones
                        // after 3 strikes — never an unbounded 5s-forever retry loop.
                        // Giving up now leaves a VISIBLE placeholder (stored, then
                        // ACKed) instead of acking the message away with no trace.
                        // Only a pre-E2EE LEGACY envelope and a REPLAY (this device
                        // already decrypted, and stored, that ciphertext) are dropped.
                        const outcome = decryptFailureOutcome(decryptErr, messageFailureCountRef.current.get(env.envelope_id) ?? 0);
                        if (outcome.action === 'retry') {
                            messageFailureCountRef.current.set(env.envelope_id, outcome.strikes);
                            continue;
                        }
                        messageFailureCountRef.current.delete(env.envelope_id);
                        if (outcome.action === 'drop') ackOnly.push(env.envelope_id);
                        else keepPlaceholder(env, outcome.reason);
                        continue;
                    }
                    messageFailureCountRef.current.delete(env.envelope_id);

                    // The decrypt SUCCEEDED, so nothing below may send this
                    // envelope round again: a retry would only REPLAY. Whatever
                    // goes wrong from here, the message (or, if it never got that
                    // far, a placeholder) is stored and ACKed with the batch.
                    let storedHere = false;
                    try {
                        const { contentJson, senderUserId: envelopeSenderUserId, senderPub: envelopeSenderPub, senderDeviceId: envelopeSenderDeviceId } = decryptResult;
                        // G3: local, telemetry-free prekey-pool signal — an
                        // inbound DM that used none of our one-time prekeys
                        // (or a draining pool) triggers a top-up check.
                        notePrekeyUsage(decryptResult.usedOneTimePrekey);
                        const content = JSON.parse(contentJson);
                        // The content boundary (utils/contentValidation.ts): the
                        // sender chose these bytes, so a variant a renderer would
                        // throw on (a numeric safety-number code crashed the app)
                        // is stored as a "couldn't be shown" placeholder instead.
                        const problem = contentProblem(content);
                        if (problem) {
                            recordDelivery('message_process', new Error(problem), { envelope_id: env.envelope_id, conversation_id: env.conversation_id });
                            keepPlaceholder(env, 'malformed');
                            continue;
                        }

                        // F1: key material is gated fail-closed, so its verdict must be
                        // computed against a FRESH directory — otherwise a cold cache
                        // reads as 'unknown' (permissive) and the gate never engages.
                        // Deliberately scoped to key material only: firing an
                        // identity_keys lookup on every inbound message would hand the
                        // server the sender of every sealed-sender envelope. `call_key`
                        // distributors are already known to the server, which routed
                        // the call, so nothing is given up here.
                        if (content?.type === 'call_key' && envelopeSenderUserId && envelopeSenderUserId !== userId) {
                            await deviceDirectory.ensureUser(envelopeSenderUserId, fetchIdentityKeys);
                        }

                        // C2 + F1: pin the sender's identity key (TOFU) / flag a change /
                        // detect an identity that no attribution source vouches for.
                        const senderVerdict = pinAndDetect(envelopeSenderUserId, envelopeSenderPub, envelopeSenderDeviceId);

                        // Sealed sender: resolve who sent this from inside the decrypted envelope (v:3).
                        // v:3 always carries the sender user id; own messages resolve to userId.
                        const resolvedSenderUserId: string | null = envelopeSenderUserId ?? null;

                        const received = {
                            id: content.client_msg_id || env.envelope_id,
                            content: content,
                            // Own messages carry THIS device's id (that is how the
                            // UI decides "mine" across my devices). Anyone else's
                            // carries the device sealed inside the envelope — the
                            // pull response stopped returning one with sealed
                            // sender, which left every other sender as '' and
                            // merged their reactions and message headers.
                            sender_device_id: envelopeSenderUserId === userId ? deviceId : (envelopeSenderDeviceId ?? env.sender_device_id ?? ''),
                            sender_user_id: resolvedSenderUserId,
                            // Retention is measured from this, and it is the SENDER'S
                            // clock: a far-future value would outlive the window.
                            timestamp: clampFutureTimestamp(env.sent_at_client),
                            conversation_id: env.conversation_id
                        };
                        (newMsgsByConv[env.conversation_id] ||= []).push(received);
                        toStore.push({ envelopeId: env.envelope_id, conversationId: env.conversation_id, message: received });
                        storedHere = true;
                        
                        // R2 / F1: only adopt a call media key from a sender whose identity
                        // some attribution source actually vouches for.
                        //
                        // The gate this replaces was `if (!pinned || pinned === sp)`, keyed on
                        // `getStoredPub(su, sd)`. That is open by construction against the
                        // forgery in senderTrust.ts: an invented device id (or an omitted `sd`)
                        // makes `pinned` null, `!pinned` is true, and the attacker's media key
                        // is adopted outright — full MITM of DM call media, with no warning
                        // anywhere, even for a Safety-Number-verified contact.
                        //
                        // `actionFor(..., 'key_material')` fails CLOSED instead: anything but
                        // 'ok'/'first_contact' is refused. Refusing costs a degraded call and a
                        // visible prompt to verify; accepting costs the call's confidentiality
                        // silently. First contact still passes — that is the TOFU bootstrap
                        // every conversation needs, and its protection is the Safety Number.
                        if (content.type === 'call_key' && content.call_id && content.e2ee_key_b64) {
                            const su = envelopeSenderUserId;
                            const isOwn = !su || su === userId;
                            const action = isOwn || !senderVerdict
                                ? 'accept'
                                : actionFor(senderVerdict, 'key_material');
                            if (action === 'accept') {
                                recordCallKeyRef.current(content.call_id, content.e2ee_key_b64);
                            } else {
                                // No sender/device identifiers in the log line — a rejected
                                // call key is exactly the moment not to start writing down
                                // who was talking to whom.
                                console.warn(`[E2EE] call_key rejected: sender identity not attributable (${senderVerdict})`);
                            }
                        }

                        // Global Calling Intercept — fetch caller profile for banner
                        if (content.type === 'call_key' && resolvedSenderUserId && resolvedSenderUserId !== userId) {
                            if (new Date(content.rotates_at).getTime() > Date.now()) {
                                let callerName = content.sender_username || 'Someone';
                                let callerAvatarId: string | null = null;
                                let callerUserId: string | null = resolvedSenderUserId || null;
                                let isGroup = false;
                                // "Show + warn" trust model: a call media key is only as
                                // trustworthy as the sender's identity. Compose the two
                                // independent sources — `senderVerdict` (is this key
                                // attributable to the claimed sender at all?) and the pin
                                // store (did the user ever vouch for it out of band?) — into
                                // the one value the badge renders. Computed HERE, at receipt,
                                // because `senderVerdict` is about this specific envelope and
                                // cannot be recovered later from the pin store alone.
                                // (envelopeSenderPub is guaranteed present — e2ee-engine
                                // rejects any envelope missing it before we get here.)
                                // Pins plus published-but-never-pinned devices (the
                                // ghost-device fix, docs/ghost-device.md §2.4), the
                                // same list the chat-header shield uses.
                                const callerTrust = deriveContactTrust({
                                    verdict: senderVerdict,
                                    devices: contactTrustDevices(userId!, resolvedSenderUserId),
                                    activeDeviceId: envelopeSenderDeviceId ?? null,
                                });

                                const convId = env.conversation_id;

                                // Since conversations is state, let's just make an API call to ensure we get group metadata instantly
                                try {
                                    if (resolvedSenderUserId) {
                                        const profileRes = await axios.get(`${API_BASE}/auth/users/${resolvedSenderUserId}`, {
                                            headers: { Authorization: `Bearer ${token}` }
                                        });
                                        callerName = profileRes.data.username || callerName;
                                        callerAvatarId = profileRes.data.avatar_url || null;
                                    }

                                    // If we can lookup the conversation from the /conversations API directly:
                                    const convsRes = await axios.get(`${API_BASE}/conversations`, { headers: { Authorization: `Bearer ${token}` }});
                                    const targetConv = convsRes.data.find((c: any) => c.conversation_id === convId);
                                    if (targetConv && targetConv.type === 'group') {
                                        callerName = targetConv.title || 'Group Chat';
                                        callerAvatarId = targetConv.avatar_url || null;
                                        isGroup = true;
                                        // For groups the "user" color makes no sense — null so
                                        // EncryptedAvatar renders its neutral group fallback.
                                        callerUserId = null;
                                    }
                                } catch {}

                                let firedCallToast = false;
                                setGlobalIncomingCall(prev => {
                                    if (prev && prev.session_id === content.call_id) return prev;
                                    firedCallToast = true;
                                    return {
                                        session_id: content.call_id,
                                        e2ee_key_b64: content.e2ee_key_b64,
                                        sender: callerName,
                                        conversation_id: env.conversation_id,
                                        callerName,
                                        callerAvatarId,
                                        callerUserId,
                                        isGroup,
                                        callerTrust: isGroup ? null : callerTrust,
                                    };
                                });
                                // Surface an OS toast for the incoming call so a
                                // backgrounded window still shows who's calling.
                                // The looping ringtone is played separately by the
                                // globalIncomingCall UI effect.
                                if (firedCallToast) {
                                    notify({
                                        category: 'call',
                                        conv_id: env.conversation_id,
                                        sender_name: callerName,
                                        text: isGroup ? `Group call · ${callerName}` : `${callerName} is calling…`,
                                        is_mention: true,
                                        mode: 'all',
                                        active_conv_id: null,  // calls always notify
                                        ctx: notifCtxRef.current,
                                    });
                                }
                            }
                        }

                    } catch (e) {
                        // Decrypted fine; something after it threw (malformed
                        // content JSON, a failed lookup, a bug). Keep what we have:
                        // the message if it was already recorded, else a placeholder.
                        recordDelivery('message_process', e, { envelope_id: env.envelope_id, conversation_id: env.conversation_id });
                        console.error('Failed to process envelope', e);
                        if (!storedHere) keepPlaceholder(env, 'unprocessable');
                    }
                }

                // Message integrity §3: STORE, then ACK (utils/dmInbound.ts). The
                // ACK deletes the server's copy, so it is sent only for envelopes
                // whose messages are durably on disk. A failed persist leaves
                // them on the server, carried here in decrypted form, and the
                // next pull stores them again before acking.
                const commit = await commitPulledBatch({
                    toStore,
                    ackOnly,
                    persist: byConversation => persistIncomingDms(userId, byConversation),
                    // Ack failure must NEVER swallow the notify/count logic
                    // below — see utils/messageAck.ts for the full incident.
                    // ackMessageEnvelopes cannot throw; a failed ack is logged
                    // and the envelopes are simply redelivered on the next poll
                    // (and re-stored idempotently), but the user is told about
                    // this batch now regardless.
                    ack: ids => ackMessageEnvelopes(API_BASE, ids, token!, deviceId!),
                });
                // A message that arrives ALREADY past the shortest retention
                // window (queued while this device was off, or backdated) would
                // otherwise sit in the thread until the next 5-minute tick.
                // Sweep right after this batch has landed in state instead.
                if (toStore.some(t => Date.now() - Date.parse(String(t.message?.timestamp)) > 24 * 60 * 60_000)) {
                    window.setTimeout(() => { void sweepRunRef.current?.(); }, 2500);
                }
                for (const s of commit.stored) unpersistedDmRef.current.delete(s.envelopeId);
                for (const c of commit.carry) unpersistedDmRef.current.set(c.envelopeId, c);
                if (commit.persistError) {
                    recordDelivery('message_persist', commit.persistError, { envelope_ids: commit.carry.map(c => c.envelopeId).join(',') });
                    console.error('Failed to store pulled messages — leaving them on the server (will retry next poll):', commit.persistError);
                }
                if (commit.ackError) {
                    recordDelivery('message_ack', commit.ackError, { envelope_ids: commit.acked.join(',') });
                    console.error('Failed to ack messages (will retry next poll):', commit.ackError);
                }

                if (Object.keys(newMsgsByConv).length > 0) {

                    // A message can arrive for a conversation this client has
                    // never seen — a first-ever DM from a new friend is the
                    // common case. The unread counters below are keyed by
                    // conversation_id, but the DM/group rail badges and the
                    // conversation list are rendered by iterating
                    // `conversations`, so with no row the count is invisible:
                    // notification sound, no badge, nothing to click, until
                    // something else happens to refetch the list. Pull it once
                    // if this batch references anything we don't know about.
                    const unknownConv = Object.keys(newMsgsByConv).some(
                        cId => !conversationsRef.current.some(
                            c => c.conversation_id === cId || c.id === cId,
                        ),
                    );
                    if (unknownConv) void fetchConversationsRef.current?.();

                    // Pre-calculate unread updates outside of the state modifier to prevent React Strict Mode
                    // double-invocation hooks from amplifying the counter!
                    let newUnreadCountByConv: Record<string, number> = {};
                    let newMentionCountByConv: Record<string, number> = {};
                    let newUnreadsForAudio = false;
                    // Per-conversation notification candidate (latest qualifying message)
                    // so a burst of messages collapses into ONE toast per conversation.
                    // Carries the resolved decision so notify() alerts on exactly the
                    // same terms the counters below were incremented on.
                    const notifCandidates: Record<string, {
                        text: string; mode: NotifMode; decision: NotifDecision;
                    }> = {};

                    // Read focus ONCE for the whole batch. It used to be sampled
                    // per message inside the loop and AGAIN inside notify(), after
                    // this function had already awaited several round trips — two
                    // reads of a value the user can change at any moment, used to
                    // answer the same question.
                    const windowFocused = document.hasFocus();
                    const activeConvId = activeChatRef.current?.id ?? null;
                    const gPrefs = notifGlobalPrefsRef.current;
                    const dndActive = computeNotifDnd(gPrefs, notifCtxRef.current).active;

                    for (const [cId, msgs] of Object.entries(newMsgsByConv)) {
                        // Your own self conversation never notifies or counts unread —
                        // see isSilentIncoming (also covers anything you sent yourself).
                        const convIsSelf = isSelfDm(
                            conversationsRef.current.find(c => c.id === cId || c.conversation_id === cId),
                            userId,
                        );
                        for (const m of msgs) {
                            // An undecryptable placeholder counts and notifies like a
                            // message (Message integrity §2): a message DID arrive, and
                            // a row nobody is told about is barely better than none.
                            const isPlaceholder = m.content.type === 'system' && m.content.kind === UNDECRYPTABLE_KIND;
                            if (!isSilentIncoming({ senderUserId: m.sender_user_id, myUserId: userId, convIsSelf }) && (isPlaceholder || ['text', 'attachment', 'server_invite', 'safety_number', 'klipy_gif'].includes(m.content.type))) {
                                const mode: NotifMode = notifPrefs[cId] ?? 'all';
                                const text = isPlaceholder ? `🔒 ${placeholderText(m.content.data?.reason)}`
                                    : m.content.type === 'text' ? (m.content.text ?? '')
                                    : m.content.type === 'attachment' ? '📎 Attachment'
                                    : m.content.type === 'klipy_gif' ? 'GIF'
                                    // Worth surfacing rather than dropping silently: a contact
                                    // sharing their safety code is an invitation to do the
                                    // verification ceremony, and it is time-sensitive in the
                                    // one case that matters (they are on a call with you).
                                    : m.content.type === 'safety_number' ? '🔐 Shared their safety code'
                                    : 'New message';
                                const decision = resolveNotification({
                                    text,
                                    directMention: !!(userId && m.content.type === 'text'
                                        && messageTextMentionsUser(m.content.text ?? '', userId)),
                                    keywords: gPrefs.keywords,
                                    mode,
                                    windowFocused,
                                    isActiveConversation: activeConvId === cId,
                                    suppressWhenActiveConv: gPrefs.suppress_when_active_conv,
                                    dndActive,
                                    dndLetMentionsThrough: gPrefs.dnd_let_mentions_through,
                                });
                                notifCandidates[cId] = { text, mode, decision };

                                if (decision.countsMention) {
                                    newMentionCountByConv[cId] = (newMentionCountByConv[cId] || 0) + 1;
                                }
                                if (decision.countsUnread) {
                                    newUnreadCountByConv[cId] = (newUnreadCountByConv[cId] || 0) + 1;
                                    newUnreadsForAudio = true;
                                }
                            }
                        }
                    }

                    // Fire one OS notification per conversation. notify() applies the
                    // decision computed above rather than re-deriving its own, so a
                    // sound without a badge (or a badge without a sound) can't happen.
                    for (const [cId, cand] of Object.entries(notifCandidates)) {
                        const conv = conversationsRef.current.find((c: any) => c.id === cId || c.conversation_id === cId);
                        const title = conv?.title || conv?.name || 'New message';
                        notify({
                            category: cand.decision.isMention ? 'mention' : 'message',
                            conv_id: cId,
                            sender_name: title,
                            text: cand.text,
                            is_mention: cand.decision.isMention,
                            mode: cand.mode,
                            active_conv_id: activeConvId,
                            ctx: notifCtxRef.current,
                            decision: cand.decision,
                        });
                    }

                    if (newUnreadsForAudio) {
                        setUnreadCounts(oldUnread => {
                            const nextUnread = { ...oldUnread };
                            for (const c in newUnreadCountByConv) {
                                nextUnread[c] = (nextUnread[c] || 0) + newUnreadCountByConv[c];
                            }
                            return nextUnread;
                        });
                    }

                    // Always update mention counts when mentions exist, even in muted convs
                    if (Object.keys(newMentionCountByConv).length > 0) {
                        setMentionCounts(prev => {
                            const next = { ...prev };
                            for (const c in newMentionCountByConv) {
                                next[c] = (next[c] || 0) + newMentionCountByConv[c];
                            }
                            return next;
                        });
                    }

                    setHiddenConversations(prev => {
                        let next = prev;
                        for (const cId of Object.keys(newMsgsByConv)) {
                            if (next.includes(cId)) {
                                next = next.filter(id => id !== cId);
                            }
                        }
                        return next;
                    });

                    // Pin ops synced from this user's other devices. Collected and
                    // applied OUT HERE rather than in the reducer below: that updater
                    // is double-invoked under StrictMode, and applying a pin inside it
                    // would run the LWW ledger mutation twice. Same reason the unread
                    // counters above are pre-calculated.
                    // Only ops our OWN user sent (pinSync.ownPinOps): a pin is a
                    // bookmark between this user's devices, never something a
                    // conversation partner can set or clear for us.
                    const incomingPinOps: PinOp[] = ownPinOps(newMsgsByConv, userId);
                    if (incomingPinOps.length > 0) {
                        setPinnedMessagesState(prevPins => {
                            const nextState = applyPinOps({ pins: prevPins, ledger: pinLedgerRef.current }, incomingPinOps);
                            pinLedgerRef.current = nextState.ledger;
                            return nextState.pins;
                        });
                        // A pin means save-forever. The pinning device already did
                        // this locally; without it here, THIS device would happily
                        // sweep the message by its own retention policy and leave the
                        // synced pin pointing at nothing.
                        for (const op of incomingPinOps) {
                            if (op.action === 'add') saveMessageRef.current(op.target_id);
                        }
                    }

                    // Avatar/banner keys carried by profile/group updates. Applied
                    // OUT HERE, not inside the state reducer below: an updater is
                    // double-invoked under StrictMode and must stay pure (it is the
                    // same merge the on-disk persist above ran — dmInbound's
                    // applyIncomingDmMessages).
                    for (const msgs of Object.values(newMsgsByConv)) {
                        for (const m of msgs) {
                            if (m.content?.type !== 'profile_update' && m.content?.type !== 'group_update') continue;
                            // Save the decryption key for the profile/group new avatar
                            if (m.content.avatar_attachment_id) {
                                saveAvatarKey(
                                    m.content.avatar_attachment_id,
                                    m.content.avatar_file_key_b64,
                                    m.content.avatar_file_nonce_b64
                                ).then(() => {
                                    // Dispatch an event to force EncryptedAvatars to try loading again
                                    window.dispatchEvent(new CustomEvent('cipherline:avatar_key_saved', { detail: m.content.avatar_attachment_id }));
                                    
                                    // Trigger a UI re-render with the new avatar_url
                                    setConversations(prev => [...prev].map(c => {
                                        const match = m.content.type === 'group_update'
                                            ? c.conversation_id === m.conversation_id
                                            : c.other_user_id === m.sender_user_id && c.type === 'dm';
                                        
                                        if (match) {
                                            return { ...c, avatar_url: m.content.avatar_attachment_id };
                                        }
                                        return c;
                                    }));

                                    setActiveChat(prev => {
                                        if (!prev) return prev;
                                        const match = m.content.type === 'group_update'
                                            ? prev.id === m.conversation_id
                                            : prev.other_user_id === m.sender_user_id && prev.type === 'dm';
                                        if (match) {
                                            return { ...prev, avatar_url: m.content.avatar_attachment_id };
                                        }
                                        return prev;
                                    });
                                }).catch(e => console.error('Failed to save avatar key', e));
                            }
                            // Save banner decryption key when present in profile_update
                            if (m.content.type === 'profile_update' && m.content.banner_attachment_id) {
                                saveAvatarKey(
                                    m.content.banner_attachment_id,
                                    m.content.banner_file_key_b64,
                                    m.content.banner_file_nonce_b64
                                ).then(() => {
                                    window.dispatchEvent(new CustomEvent('cipherline:avatar_key_saved', { detail: m.content.banner_attachment_id }));
                                }).catch(e => console.error('Failed to save banner key', e));
                            }
                        }
                    }

                    // Unpin any personally-pinned DM/group message this batch's
                    // delete markers just removed, on every one of this user's
                    // devices — the client-side mirror of the server's
                    // removePinForDeletedMessage cleanup for channel pins.
                    // Computed against messagesStateRef, the same pre-batch
                    // snapshot the merge below starts from, and OUTSIDE the
                    // setMessagesState updater (which must stay pure and can be
                    // double-invoked under StrictMode) — same reason the pin
                    // ops above are pre-calculated.
                    for (const { conversationId, targetId } of deletedDmTargets(messagesStateRef.current, newMsgsByConv)) {
                        if (pinnedMessagesStateRef.current[conversationId]?.includes(targetId)) {
                            handleUnpinMessageRef.current(conversationId, targetId);
                        }
                    }

                    setMessagesState(prev => applyIncomingDmMessages(prev, newMsgsByConv));
                }
            }
        } catch (err) {
            console.error('Polling error:', err);
        }
    }), [token, deviceId, notifPrefs, userId]);

    /** Serialised entry point — this is what the WS push and the poll call.
     *  See pullInFlightRef above for why concurrent pulls are not merely
     *  wasteful but actively destructive. */
    const pullMessagesRef = React.useRef<(() => Promise<void>) | null>(null);
    const pullMessages = React.useCallback(async () => {
        if (pullInFlightRef.current) { pullAgainRef.current = true; return; }
        pullInFlightRef.current = true;
        try {
            do {
                pullAgainRef.current = false;
                await pullMessagesOnce();
            } while (pullAgainRef.current);
        } finally {
            pullInFlightRef.current = false;
        }
    }, [pullMessagesOnce]);
    // For the history-restore effect, which must not take pullMessages as a
    // dependency (it re-runs per account, not per notification-pref change).
    useEffect(() => { pullMessagesRef.current = pullMessages; }, [pullMessages]);

    // Hardening follow-up: removed the M12 "Create Local Backup" / "Restore
    // Backup" modal pair that used to live here — a THIRD, independent
    // backup/restore implementation (hand-rolled, bypassing exportLocalHistory
    // /importLocalHistory entirely) that only ever backed up/restored
    // {userId, deviceId, privateKey, publicKey, topics, history} — silently
    // missing channel messages, pinned messages, settings, retention policy,
    // GIF favorites/keys/files, avatar keys, and attachments compared to the
    // real (BackupSection.tsx) backup. It also duplicated the cross-account
    // restore check inline instead of using importLocalHistory's, with the
    // same missing-userId-bypasses-the-check gap. Confirmed unreachable: its
    // only trigger props (onOpenBackup/onOpenRestore, passed to
    // SettingsScreen) were never actually called anywhere in SettingsScreen's
    // body — dead prop-drilling, same pattern as the legacy auto-backup
    // scheduler removed just above. BackupSection.tsx is the one live,
    // comprehensive backup/restore UI.

    // Purge-confirmation state for the active-chat storage panel. Modal reads this
    // to render the count + label; onConfirm runs the commit closure.
    const [pendingChatPurge, setPendingChatPurge] = useState<{
        count: number;
        label: string;
        convTitle?: string;
        commit: () => void;
    } | null>(null);

    // Storage retention policy
    const retention = useRetentionPolicy(userId);

    // Retention is PER DEVICE. Until this account has chosen one on this
    // device the first-run prompt shows and the retention sweeper is held —
    // otherwise a freshly restored / transferred history would be swept under
    // DEFAULT_POLICY before the user ever picked anything. This is the single
    // hook point every sign-in path (password, future QR / device link)
    // reaches; see utils/deviceStorageSetup.ts.
    const deviceStorage = useDeviceStorageSetup(userId);
    const deviceStorageReadyRef = useRef(false);
    deviceStorageReadyRef.current = deviceStorage.status === 'done';

    /** Per-server retention overrides for the active channel.
     *  Falls back to the server type-specific default, then the global policy.
     *  Re-reads localStorage whenever the active server changes OR the user
     *  updates retention in ServerMemberOptionsModal. */
    const activeChannelRetention = useMemo(() => {
        const serverMsg = getEffectiveMessageRetention(retention.policy, 'server');
        const serverAtt = getEffectiveAttachmentRetention(retention.policy, 'server');
        if (!activeChannel?.server_id || !userId) return { msg: serverMsg, att: serverAtt };
        const o = parseRetentionOverride(secureLocalStore.getItem(serverRetentionKey(userId, activeChannel.server_id)));
        return {
            msg: o?.messageRetention    ?? serverMsg,
            att: o?.attachmentRetention ?? serverAtt,
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeChannel?.server_id, userId, channelRetentionVersion, retention.policy]);

    /** Per-conversation retention overrides for the active DM/group chat.
     *  Falls back to the type-specific default (dm/group), then the global policy. */
    const activeConvRetention = useMemo(() => {
        const convType: 'dm' | 'group' = activeChat?.type === 'group' ? 'group' : 'dm';
        const typeMsg = getEffectiveMessageRetention(retention.policy, convType);
        const typeAtt = getEffectiveAttachmentRetention(retention.policy, convType);
        if (!activeChat?.id || !userId) return { msg: typeMsg, att: typeAtt };
        const o = parseRetentionOverride(secureLocalStore.getItem(convRetentionKey(userId, activeChat.id)));
        return {
            msg: o?.messageRetention    ?? typeMsg,
            att: o?.attachmentRetention ?? typeAtt,
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeChat?.id, activeChat?.type, userId, convRetentionVersion, retention.policy]);

    // Keybind management
    const keybinds = useKeybinds();

    // Screen Lock — local PIN gate for "walked away from your desk". See
    // useScreenLock.ts for the threat model.
    const screenLock = useScreenLock();

    // V2 encrypted-backup daily tick. No-op when the user hasn't unlocked
    // the vault or has set the interval to "off". See useBackupAutoSchedule
    // for the gating rules.
    useBackupAutoSchedule();

    // Silently rotate the signed prekey + replenish OTPs if the server reports
    // they're running low (< 20 OTPs remaining or SPK approaching its 30-day expiry).
    useKeyRotation();

    // Voice & audio processing settings
    const voice = useVoiceSettings();

    // Global keybind listener — dispatches call actions as custom DOM events
    // (SidebarConference listens) and handles navigation/chat actions directly.
    useGlobalKeybindListener(keybinds, {
        'toggle-mute':        () => window.dispatchEvent(new Event('keybind:toggle-mute')),
        'toggle-deafen':      () => window.dispatchEvent(new Event('keybind:toggle-deafen')),
        'toggle-camera':      () => window.dispatchEvent(new Event('keybind:toggle-camera')),
        'toggle-screenshare': () => window.dispatchEvent(new Event('keybind:toggle-screenshare')),
        'leave-call':         () => window.dispatchEvent(new Event('keybind:leave-call')),
        'quick-screenshare':  () => window.dispatchEvent(new Event('keybind:quick-screenshare')),
        'lock-screen':        () => screenLock.lockNow(),
        'open-settings':      () => setSettingsOpen(true),
        // SettingsScreen owns its own close (it asks before discarding unsaved
        // profile edits), so hand the request to it instead of unmounting it here.
        'close-panel':        () => window.dispatchEvent(new Event('keybind:close-panel')),
        'focus-chat-input':   () => {
            const el = document.querySelector<HTMLTextAreaElement>('[data-chat-input]');
            if (el) el.focus();
        },
        'toggle-gif-picker':  () => window.dispatchEvent(new Event('keybind:toggle-gif-picker')),
        'toggle-emoji-picker': () => window.dispatchEvent(new Event('keybind:toggle-emoji-picker')),
    });

    // Keep an always-fresh ref to messagesState so long-lived intervals can see latest
    const messagesStateRef = useRef<Record<string, any[]>>({});
    useEffect(() => { messagesStateRef.current = messagesState; });
    // Pin maps — exposed to the retention sweep so pinned messages bypass all
    // retention rules ("pin = save forever").
    /** LWW timestamps for cross-device pin ops — see utils/pinSync.ts. A ref,
     *  not state: nothing renders from it, and it must be readable inside the
     *  setPinnedMessagesState updater without adding a dependency. */
    const pinLedgerRef = useRef<PinLedger>({});
    const pinnedMessagesStateRef = useRef<Record<string, string[]>>({});
    useEffect(() => { pinnedMessagesStateRef.current = pinnedMessagesState; });
    const localChannelPinsRef = useRef<Record<string, string[]>>({});
    useEffect(() => { localChannelPinsRef.current = localChannelPins; });
    /** LWW ledger for channel "Save for me" — the channel twin of pinLedgerRef,
     *  so a save/unsave from another device resolves the same way a pin does. */
    const localChannelPinLedgerRef = useRef<PinLedger>({});
    /** True once THIS account's pins and channel saves have been read from
     *  storage. Gates the own-device saves sync (merging a remote snapshot into
     *  a not-yet-restored empty state would persist it over the real one) and
     *  lets the persist effects write an empty map (unpinning the last pin). */
    const [savesRestored, setSavesRestored] = useState(false);
    const channelServerSavesRef = useRef<Record<string, string[]>>({});
    useEffect(() => { channelServerSavesRef.current = channelServerSaves; });
    /** Forward-reference refs, same pattern as saveMessageRef below:
     *  handleUnpinMessage / handlePersonalChannelSave are declared ~2000 lines
     *  further down (after `savesSync`/`retention` exist), but the live
     *  channel-message handler and the DM pull loop — both defined here,
     *  above that point, with useCallback deps that don't include them — need
     *  to call them when a delete marker removes a message the viewer had
     *  personally pinned/saved. Reaching for the functions directly would
     *  trip the same TDZ rule saveMessageRef's comment describes. Kept
     *  no-op until the effects below (declared right after each real
     *  function) populate them on first render. */
    const handleUnpinMessageRef = useRef<(convId: string, msgId: string) => void>(() => {});
    const handlePersonalChannelSaveRef = useRef<(channelId: string, msgId: string, action: 'add' | 'remove') => void>(() => {});

    // Fresh refs for channel messages and server channels — used in the retention sweep
    // so the interval closure doesn't capture stale state.
    const channelMessagesRef = useRef<Record<string, any[]>>({});
    useEffect(() => { channelMessagesRef.current = channelMessages; });
    const serverChannelsRef = useRef<typeof serverChannels>({});
    useEffect(() => { serverChannelsRef.current = serverChannels; });
    // Same pattern: rehydrateAll runs from long-lived listeners (WS reconnect,
    // OS resume), so it reads the active server through a ref rather than
    // closing over state that would be stale by the time it fires.
    const activeServerViewRef = useRef<typeof activeServerView>(null);
    useEffect(() => { activeServerViewRef.current = activeServerView; });
    // Same reasoning, for Phase M's sleep-wake call-staleness backstop below —
    // rehydrateAll needs the call id current at the moment it actually runs,
    // not whatever it was when rehydrateAll's useCallback was last recreated.
    const activeCallRef = useRef<typeof activeCall>(null);
    useEffect(() => { activeCallRef.current = activeCall; });

    // Pre-compute resolved channel-permission maps so they're stable objects
    // (one map per server, keyed by channel_id → resolved BigInt). Recomputed
    // only when serverChannels changes — avoids recreating objects on every
    // Dashboard render and breaking useCallback([channelPermissionsMap]) in
    // ServerContextPanel.
    const channelPermissionsMaps = useMemo<Record<string, Record<string, bigint>>>(() => {
        const out: Record<string, Record<string, bigint>> = {};
        for (const [serverId, chs] of Object.entries(serverChannels)) {
            const map: Record<string, bigint> = {};
            for (const ch of chs) {
                if (ch.my_permissions) {
                    try { map[ch.channel_id] = BigInt(ch.my_permissions); } catch { /* ignore */ }
                }
            }
            out[serverId] = map;
        }
        return out;
    }, [serverChannels]);

    // ── Count-driven unread badges (utils/unreadBadges.ts) ─────────────────────
    // These classifiers map an id to its owner using whatever's loaded right
    // now; splitCountsByOwner/dmGroupRailBadges/serverChannelBadges treat an
    // id the classifier can't resolve as "not yet classifiable", never as
    // "zero unread" — see that file's comments for why this matters (it's the
    // whole point of this fix).
    const conversationTypeById = useMemo<Record<string, 'dm' | 'group'>>(() => {
        const out: Record<string, 'dm' | 'group'> = {};
        for (const c of conversations) {
            if (c.type === 'dm' || c.type === 'group') out[c.conversation_id] = c.type;
        }
        return out;
    }, [conversations]);
    const channelToServerId = useMemo<Record<string, string>>(() => {
        const out: Record<string, string> = {};
        for (const [serverId, chs] of Object.entries(serverChannels)) {
            for (const ch of chs) out[ch.channel_id] = serverId;
        }
        return out;
    }, [serverChannels]);
    const railBadges = useMemo(
        () => dmGroupRailBadges(
            unreadCounts, mentionCounts,
            id => conversationTypeById[id],
            // Per-conversation mode, so a DM set to @mentions-only shows a
            // quiet grey count rather than the red one it would otherwise
            // have started drawing now that such conversations accrue unread.
            id => notifPrefs[id] ?? 'all',
        ),
        [unreadCounts, mentionCounts, conversationTypeById, notifPrefs],
    );
    const serverRailBadges = useMemo(
        () => serverChannelBadges(channelUnreadCounts, channelMentionCounts, id => channelToServerId[id]),
        [channelUnreadCounts, channelMentionCounts, channelToServerId],
    );
    /** serverId → who is in a voice call there right now. Drives the rail's
     *  speaker badge and its hover roster. Both inputs are already
     *  permission-filtered server-side, so a call in a channel this user cannot
     *  see produces no entry and therefore no badge — see serverCallPresence. */
    const serverCallPresence = useMemo(
        () => deriveServerCallPresence(voiceParticipants, channelToServerId, huddleCalls),
        [voiceParticipants, channelToServerId, huddleCalls],
    );

    // ── Background avatar warming ────────────────────────────────────────────
    // Opening a chat used to stall because ChatPane held its loading gate until
    // every participant/member avatar had finished two REST calls and a decrypt.
    // The gate is gone; this is what makes that safe. It warms the DM/group
    // partners and the members of the servers the user is most likely to open
    // next, on idle, off the render path, capped and rate-paced — see
    // useAvatarWarming and utils/avatarWarmPlan for the numbers and why.
    useAvatarWarming({
        userId,
        token,
        conversations,
        friends: globalFriends?.accepted ?? null,
        servers,
        presence,
        unreadCounts,
        mentionCounts,
        lastActivityAt,
        serverBadges: serverRailBadges.byServer,
        serverLastActivityAt,
        serverChannels,
        channelMessages,
    });

    const conversationsRef = useRef<typeof conversations>([]);
    useEffect(() => { conversationsRef.current = conversations; });
    // pullMessages is defined well above fetchConversations, so it reaches it
    // through this ref rather than a direct call (the same pattern useRealtime
    // uses for its message callbacks). Kept fresh on every render.
    const fetchConversationsRef = useRef<(() => Promise<void>) | null>(null);
    const fetchFriendsRef = useRef<(() => Promise<void>) | null>(null);
    /** The most recent GET /friends payload, written synchronously when it
     *  lands (state only updates on the next render) — the reconnect resync
     *  reads pending_incoming from it right after its refresh settles. */
    const lastFriendsPayloadRef = useRef<{ pending_incoming?: unknown[] } | null>(null);
    // Always-current retention policy ref — used inside sweep effect so the
    // sweep doesn't fire on every policy change (only on mount + 5-min interval).
    const retentionPolicyRef = useRef(retention.policy);
    useEffect(() => { retentionPolicyRef.current = retention.policy; });

    // ── Effective retention for DELETING things ──────────────────────────────
    // One resolution chain for the 5-minute sweep, every "Purge now" flow and
    // the history-ingest filter: per-chat override > per-type default > global
    // (utils/retentionResolve.ts). Each site used to carry its own inline copy.
    /** Policy to sweep a server channel under (override stored per SERVER). */
    const serverSweepPolicy = useCallback((pol: StoragePolicy, serverId: string | undefined): StoragePolicy => {
        const override = serverId && userId
            ? parseRetentionOverride(secureLocalStore.getItem(serverRetentionKey(userId, serverId)))
            : null;
        return sweepPolicyFor(pol, 'server', override);
    }, [userId]);
    /** Policy to sweep a DM / group under (override stored per CONVERSATION). */
    const convSweepPolicy = useCallback((pol: StoragePolicy, convType: 'dm' | 'group', convId: string): StoragePolicy => {
        const override = userId ? parseRetentionOverride(secureLocalStore.getItem(convRetentionKey(userId, convId))) : null;
        return sweepPolicyFor(pol, convType, override);
    }, [userId]);
    // Same reason as the policy ref above: pullMessages is defined ~400 lines
    // BEFORE `retention` exists, and its useCallback deps don't include it, so
    // reaching for it directly would both trip the TDZ rule and pin a stale
    // saveMessage into the closure.
    const saveMessageRef = useRef(retention.saveMessage);
    useEffect(() => { saveMessageRef.current = retention.saveMessage; });

    // Own-device sync of personal pins + channel "Save for me" through the
    // `personal_saves` slot (hooks/usePersonalSavesSync.ts). The local side is
    // the same state the renderer, the backup vault and the retention sweep
    // already read; a merged remote snapshot is applied through functional
    // updaters that RE-merge, so a pin op that landed while the sync was on
    // the network is never overwritten.
    const savesLocal = useMemo<SavesLocalBinding>(() => ({
        load: () => ({
            conversation: { pins: pinnedMessagesStateRef.current, ledger: pinLedgerRef.current },
            channel: { pins: localChannelPinsRef.current, ledger: localChannelPinLedgerRef.current },
        }),
        save: (next, prev) => {
            setPinnedMessagesState(prevPins => {
                const m = mergeScope({ pins: prevPins, ledger: pinLedgerRef.current }, next.conversation);
                pinLedgerRef.current = m.ledger;
                return m.pins;
            });
            setLocalChannelPins(prevPins => {
                const m = mergeScope({ pins: prevPins, ledger: localChannelPinLedgerRef.current }, next.channel);
                localChannelPinLedgerRef.current = m.ledger;
                return m.pins;
            });
            // A pin means save-forever, exactly as for a pin op that arrives
            // in an envelope (see the pull loop).
            for (const { message_id } of addedSaves(prev.conversation, next.conversation)) {
                saveMessageRef.current(message_id);
            }
        },
    }), []);
    const savesSync = usePersonalSavesSync({ userId, deviceId, token, ready: savesRestored, local: savesLocal });
    const savesSyncRef = useRef(savesSync);
    savesSyncRef.current = savesSync;

    // GIF library: GifPicker syncs when it opens; this ALSO runs it at start and
    // on focus, so a new device of this account (a phone) can read the library
    // without anyone opening the picker here first — the sync republishes to a
    // device the current snapshot does not address (useGifLibrarySync's
    // anti-entropy check). An idle run is one metadata probe.
    const { syncNow: syncGifsNow } = useGifLibrarySync({ userId, deviceId, token });
    const gifSyncAtRef = useRef(0);
    useEffect(() => {
        if (!savesRestored) return;
        const run = () => {
            if (Date.now() - gifSyncAtRef.current < 60_000) return;
            gifSyncAtRef.current = Date.now();
            syncGifsNow();
        };
        run();
        window.addEventListener('focus', run);
        return () => window.removeEventListener('focus', run);
    }, [savesRestored, syncGifsNow]);

    /**
     * Record attachment ids the retention sweep just deleted as known-removed,
     * BEFORE the DELETE round-trips fire.
     *
     * Anyone still holding the message — this user's other devices, the other
     * party in a DM, every other member of a channel — will try to fetch these
     * bytes. Without the ledger entry each of those renders spends a 404 first
     * and can flash the red "Couldn't decrypt" card on the way to the gray
     * "no longer available" placeholder. Only one of the four sweep sites used
     * to do this; now all four go through here.
     */
    const markAttachmentsRemovedSafe = useCallback((attachmentIds: string[]) => {
        if (!userId || !attachmentIds.length) return;
        try { markAttachmentsRemoved(userId, attachmentIds); } catch { /* non-fatal bookkeeping */ }
    }, [userId]);

    /**
     * The server-saved / pinned ids of a channel, fetching them if this session
     * hasn't yet. Returns undefined when they can't be learned - callers then
     * SKIP the channel rather than sweep it blind: the sweep's whole pin
     * exemption rests on this set, and an empty stand-in deletes saved messages
     * (and, for a channel, tombstones them so they never come back).
     */
    const ensureChannelSaves = useCallback(async (channelId: string): Promise<string[] | undefined> => {
        const known = channelServerSavesRef.current[channelId];
        if (known !== undefined) return known;
        if (!token) return undefined;
        try {
            const st = await fetchChannelSaveState(API_BASE, channelId, token);
            applyChannelSaveState(channelId, st);
            return st.saved;
        } catch {
            return undefined;
        }
    }, [token, applyChannelSaveState]);

    /**
     * Sweep a set of server channels NOW under `policyFor(channelId)`, with the
     * same pin / server-save exemption the 5-minute sweep applies, tombstoning
     * what is dropped. Shared by the per-server "Purge now" and the per-type
     * "Remove N now" so neither can drift from the sweep again - both used to
     * call sweepRetention with no pins at all, which deleted pinned and
     * server-saved messages and tombstoned them.
     */
    const purgeChannelsNow = useCallback(async (
        channelIds: string[],
        policyFor: (channelId: string) => StoragePolicy,
    ): Promise<string[]> => {
        if (!userId) return [];
        // Learn each channel's saved set first (async), then do all the
        // reading and writing in one synchronous pass so nothing can land
        // between reading channelMessagesRef and replacing the state.
        const savesById: Record<string, string[]> = {};
        await Promise.all(channelIds.map(async (channelId) => {
            const saves = await ensureChannelSaves(channelId);
            if (saves !== undefined) savesById[channelId] = saves;
        }));
        const chMsgs = channelMessagesRef.current;
        const newChMsgs: Record<string, any[]> = { ...chMsgs };
        const attachmentsToDelete: string[] = [];
        let anyChanged = false;
        for (const channelId of channelIds) {
            const msgs = chMsgs[channelId];
            if (!Array.isArray(msgs) || savesById[channelId] === undefined) continue;
            const pinned = pinnedIdsForChannel(localChannelPinsRef.current[channelId], savesById[channelId]);
            const { prunedState: ps, attachmentsToDelete: atd, purgedMessageIds: pmi } =
                sweepRetention({ [channelId]: msgs }, policyFor(channelId), Date.now(), { [channelId]: pinned });
            if (atd.length) attachmentsToDelete.push(...atd);
            // Tombstone before the state write: the channel_messages row lives
            // on past the local cache, so an un-recorded purge comes straight
            // back on the next history fetch.
            markMessagesPurged(userId, channelId, pmi[channelId] ?? []);
            if (ps[channelId] !== msgs) {
                anyChanged = true;
                newChMsgs[channelId] = ps[channelId] ?? [];
            }
        }
        if (anyChanged) {
            setChannelMessages(newChMsgs);
            try { messageStore.saveAll('channel', userId, newChMsgs); } catch { /* the persist effect retries */ }
        }
        return attachmentsToDelete;
    }, [userId, ensureChannelSaves]);

    /**
     * Immediately sweep a single server's channel messages with the supplied
     * per-server retention overrides.  Called when the user confirms a "Purge
     * Now" in ServerMemberOptionsModal after decreasing retention.
     *
     * The global policy (savedMessageIds, etc.) is kept; only message/attachment
     * retention windows are replaced by the new per-server values.
     */
    const runServerChannelSweepNow = useCallback(async (
        serverId: string,
        newMessageRetention: MessageRetention,
        newAttachmentRetention: AttachmentRetention,
    ) => {
        if (!userId || !token) return;

        const pol = sweepPolicyFor(retention.policy, 'server', {
            messageRetention:    newMessageRetention,
            attachmentRetention: newAttachmentRetention,
        });
        const channelIds = (serverChannelsRef.current[serverId] ?? []).map(ch => ch.channel_id);
        const allAttachmentsToDelete = await purgeChannelsNow(channelIds, () => pol);

        if (allAttachmentsToDelete.length) {
            console.log(`[Retention/purge] deleting ${allAttachmentsToDelete.length} expired attachment(s) for server ${serverId}`);
            markAttachmentsRemovedSafe(allAttachmentsToDelete);
            // Local only. A retention window is THIS device's choice (per-device
            // storage), so it must not delete the server copy that the user's other
            // devices and recipients may still need. The server copy goes when the
            // user explicitly deletes the message (ChatPane.performDelete), and the
            // server's own 14-day sweepStaleAttachments is the backstop.
            const { deleteEncryptedAttachment } = await import('../utils/attachmentCache');
            await Promise.allSettled(allAttachmentsToDelete.map((id: string) => deleteEncryptedAttachment(id)));
        }
    }, [userId, token, retention.policy, markAttachmentsRemovedSafe, purgeChannelsNow]);

    /**
     * Immediately sweep a single DM/group conversation's messages with the
     * supplied per-conversation retention overrides.  Called when the user
     * confirms "Apply & Purge" in ConvRetentionSection.
     */
    const runConvSweepNow = useCallback(async (
        convId: string,
        newMessageRetention: MessageRetention,
        newAttachmentRetention: AttachmentRetention,
    ) => {
        if (!userId || !token) return;

        const convType: 'dm' | 'group' =
            conversationsRef.current.find((c: any) => c.conversation_id === convId)?.type === 'group' ? 'group' : 'dm';
        const effectivePolicy = sweepPolicyFor(retention.policy, convType, {
            messageRetention:    newMessageRetention,
            attachmentRetention: newAttachmentRetention,
        });

        const msgs = messagesStateRef.current[convId];
        if (!Array.isArray(msgs)) return;

        // Pin = save forever, here exactly as in the 5-minute sweep.
        const pinned = new Set(pinnedMessagesStateRef.current[convId] ?? []);
        const { prunedState, attachmentsToDelete } =
            sweepRetention({ [convId]: msgs }, effectivePolicy, Date.now(), { [convId]: pinned });

        if (prunedState[convId] !== msgs) {
            setMessagesState(prev => ({ ...prev, [convId]: prunedState[convId] ?? [] }));
        }

        if (attachmentsToDelete.length) {
            console.log(`[Retention/purge] deleting ${attachmentsToDelete.length} expired attachment(s) for conv ${convId}`);
            // Mark as known-removed before the network call so any stale
            // render referencing this attachment shows the gray placeholder
            // immediately rather than a transient red error card if the
            // server returns 404 first.
            markAttachmentsRemovedSafe(attachmentsToDelete);
            // Local only. A retention window is THIS device's choice (per-device
            // storage), so it must not delete the server copy that the user's other
            // devices and recipients may still need. The server copy goes when the
            // user explicitly deletes the message (ChatPane.performDelete), and the
            // server's own 14-day sweepStaleAttachments is the backstop.
            const { deleteEncryptedAttachment } = await import('../utils/attachmentCache');
            await Promise.allSettled(attachmentsToDelete.map((id: string) => deleteEncryptedAttachment(id)));
        }
    }, [userId, token, retention.policy, markAttachmentsRemovedSafe]);

    /**
     * How many messages ('msg') or files ('att') would a DRY-RUN sweep remove if
     * `type`'s default were `newVal`, honouring per-chat overrides, pins and
     * server saves - exactly what "Remove N now" would then remove. The count in
     * Settings -> Storage used to be computed from the DM store alone, so for
     * Server Channels (whose messages live in a different store) it was always
     * 0 and the "Remove now" button never appeared.
     */
    const countExpiringForType = useCallback((type: 'dm' | 'group' | 'server', kind: 'msg' | 'att', newVal: MessageRetention | AttachmentRetention): number => {
        const base = retentionPolicyRef.current;
        const field = (type === 'dm' ? 'dm' : type === 'group' ? 'group' : 'server') + (kind === 'msg' ? 'MessageRetention' : 'AttachmentRetention');
        const hypo = { ...base, [field]: newVal } as StoragePolicy;
        const now = Date.now();
        let n = 0;
        const tally = (msgs: any[], pruned: any[], attachmentsToDelete: string[]) => {
            if (kind === 'att') { n += attachmentsToDelete.length; return; }
            const kept = new Set(pruned);
            for (const m of msgs) if (!kept.has(m) && m?.content?.type !== 'attachment') n++;
        };
        if (type === 'server') {
            const channelToServer: Record<string, string> = {};
            for (const [sid, chs] of Object.entries(serverChannelsRef.current)) {
                for (const ch of chs) channelToServer[(ch as any).channel_id] = sid;
            }
            for (const [channelId, msgs] of Object.entries(channelMessagesRef.current)) {
                const saved = channelServerSavesRef.current[channelId];
                if (!Array.isArray(msgs) || saved === undefined) continue;   // unknown pins: don't promise a count
                const out = sweepRetention({ [channelId]: msgs }, serverSweepPolicy(hypo, channelToServer[channelId]), now,
                    { [channelId]: pinnedIdsForChannel(localChannelPinsRef.current[channelId], saved) });
                tally(msgs, out.prunedState[channelId] ?? [], out.attachmentsToDelete);
            }
        } else {
            for (const c of conversationsRef.current) {
                if (c.type !== type) continue;
                const msgs = messagesStateRef.current[c.conversation_id];
                if (!Array.isArray(msgs)) continue;
                const out = sweepRetention({ [c.conversation_id]: msgs }, convSweepPolicy(hypo, type, c.conversation_id), now,
                    { [c.conversation_id]: new Set(pinnedMessagesStateRef.current[c.conversation_id] ?? []) });
                tally(msgs, out.prunedState[c.conversation_id] ?? [], out.attachmentsToDelete);
            }
        }
        return n;
    }, [serverSweepPolicy, convSweepPolicy]);

    /** Immediately sweep all conversations of the given type (dm / group / server),
     *  respecting per-conv / per-server overrides AND pins / server saves.  Called
     *  when the user clicks "Remove N now" after shortening a type-specific default
     *  in StorageSettings. */
    const onPurgeTypeNow = useCallback(async (type: 'dm' | 'group' | 'server') => {
        if (!userId || !token) return;
        const pol = retentionPolicyRef.current;
        let allAttachmentsToDelete: string[] = [];

        if (type === 'server') {
            const channelToServer: Record<string, string> = {};
            for (const [sid, chs] of Object.entries(serverChannelsRef.current)) {
                for (const ch of chs) channelToServer[(ch as any).channel_id] = sid;
            }
            allAttachmentsToDelete = await purgeChannelsNow(
                Object.keys(channelMessagesRef.current),
                (channelId) => serverSweepPolicy(pol, channelToServer[channelId]),
            );
        } else {
            const current = messagesStateRef.current;
            const convIds = conversationsRef.current.filter((c: any) => c.type === type).map((c: any) => c.conversation_id as string);
            let anyChanged = false;
            const newState: Record<string, any[]> = { ...current };
            for (const convId of convIds) {
                const msgs = current[convId];
                if (!Array.isArray(msgs)) continue;
                const pinned = new Set(pinnedMessagesStateRef.current[convId] ?? []);
                const { prunedState: ps2, attachmentsToDelete: atd } =
                    sweepRetention({ [convId]: msgs }, convSweepPolicy(pol, type, convId), Date.now(), { [convId]: pinned });
                if (atd.length) allAttachmentsToDelete.push(...atd);
                if (ps2[convId] !== msgs) { anyChanged = true; newState[convId] = ps2[convId] ?? []; }
            }
            if (anyChanged) setMessagesState(newState);
        }

        if (allAttachmentsToDelete.length) {
            markAttachmentsRemovedSafe(allAttachmentsToDelete);
            // Local only: see the note on the other retention purge paths. The
            // server copy is not this device's to remove on a timer.
            const { deleteEncryptedAttachment } = await import('../utils/attachmentCache');
            await Promise.allSettled(allAttachmentsToDelete.map(id => deleteEncryptedAttachment(id)));
        }
    }, [userId, token, markAttachmentsRemovedSafe, purgeChannelsNow, serverSweepPolicy, convSweepPolicy]);

    // Hardening follow-up: removed a legacy local-only auto-backup scheduler
    // (autoBackupCfg/autoBackupPassword state, a startBackupScheduler
    // useEffect, handlePickAutoBackupDir/handleRunAutoBackupNow) — its
    // Settings UI had already been removed from StorageSettings.tsx (it
    // stopped destructuring the props Dashboard passed it) while all the
    // underlying wiring was left behind, unreachable. BackupSection.tsx +
    // useBackupAutoSchedule.ts is the one live auto-backup system (local
    // folder + Google Drive, persisted password, real Drive support) —
    // this was a redundant, dead second one. One-time cleanup of any
    // orphaned config an existing user may still have saved from before
    // the UI was removed (a stray `enabled: true` here can never actually
    // run — the legacy scheduler's password was session-only-in-a-since-
    // deleted-input, so it's fully inert — but leaving stale data forever
    // in a deleted feature's storage key is untidy).
    useEffect(() => {
        if (!userId) return;
        try { secureLocalStore.removeItem(`cipherline_auto_backup_cfg_${userId}`); } catch { /* non-fatal */ }
    }, [userId]);

    // Channel message handler: decrypt on arrival, then either apply as an
    // edit/delete/reaction action or append as a new message. Mirrors the
    // pullMessages logic for DM/group action types — the server has already
    // perm-gated the action at write time, so the client trusts and applies.
    //
    // Uses refs for all state reads (empty deps array) to avoid stale closures.
    const handleChannelMessage = useCallback(async (evt: ChannelMessageEvent) => {
        try {
            // Reject before decryption if the wire sender key doesn't match
            // the pinned key for this user+DEVICE (prevents a compromised server
            // from injecting forged messages that pass sig-check against a
            // swapped key). RC-7: keyed per device — a message from a KNOWN
            // device whose key changed is rejected; a message from a NEW device
            // of an already-known contact is not (that was the bug — every
            // device has its own identity key by design). TOFU case (no pinned
            // key yet for this device): proceed — pinAndDetect records it after.
            if (evt.sender_user_id && evt.sender_user_id !== userId && evt.sender_identity_pub_b64 && evt.sender_device_id) {
                const pinned = getStoredPub(userId!, evt.sender_user_id, evt.sender_device_id);
                if (pinned && pinned !== evt.sender_identity_pub_b64) {
                    throw new Error(`[E2EE] Channel message rejected: sender key mismatch for ${evt.sender_user_id}`);
                }
            }
            const contentJson = await window.electronAPI!.decryptChannelMessage({
                channel_id: evt.channel_id,
                epoch: evt.epoch,
                nonce_b64: evt.nonce_b64,
                ciphertext_b64: evt.ciphertext_b64,
                signature_b64: evt.signature_b64,
                sender_identity_pub_b64: evt.sender_identity_pub_b64,
                // G4: the row's own labels — checked against the sender-signed
                // binding, and the id feeds the replay ledger.
                message_id: evt.message_id,
                sender_user_id: evt.sender_user_id,
                sender_device_id: evt.sender_device_id,
            });
            // C2: pin the channel sender's identity key (TOFU) / flag a change.
            pinAndDetect(evt.sender_user_id, evt.sender_identity_pub_b64, evt.sender_device_id);
            const parsedContent = JSON.parse(contentJson);
            // Same content boundary as the DM pull (utils/contentValidation.ts):
            // a variant a renderer would throw on becomes a placeholder row.
            const content = contentProblem(parsedContent)
                ? { type: 'system', kind: UNDECRYPTABLE_KIND, data: { reason: 'malformed' } }
                : parsedContent;
            // A live message just decrypted fine — this channel has recovered
            // (or never lost) its key, so stop the retry timer from sweeping it.
            undecryptableChannelsRef.current.delete(evt.channel_id);

            // Computed BEFORE the setChannelMessages updater below, against
            // channelMessagesRef (the same pre-merge snapshot
            // refreshChannelHistory uses at its own deletedChannelTargetIds
            // call) — the removed row's own `id`, since that's what
            // `localChannelPins` is keyed by (`content.target_id` may instead
            // be a `client_msg_id`). A value assigned INSIDE a setState
            // updater and read right after the setState call is not
            // reliable: React does not guarantee the updater runs
            // synchronously during this call (React 19 in particular), so the
            // outer variable can still be null when read. The updater below
            // stays pure.
            const channelPurgedIds = userId ? getPurgedMessageIds(userId, evt.channel_id) : new Set<string>();
            const deletedRowId = content?.type === 'delete'
                ? deletedChannelTargetIds(
                    channelMessagesRef.current[evt.channel_id] ?? [],
                    [{ id: evt.message_id, timestamp: evt.created_at, content }],
                    channelPurgedIds,
                )[0] ?? null
                : null;

            setChannelMessages(prev => {
                const existing = prev[evt.channel_id] ?? [];
                let thread = [...existing];

                // ── Action types (edit / delete / reaction) ──────────────
                // Server has already validated the requester's permission
                // (self-edit only, MANAGE_MESSAGES for delete-others, etc.).
                if (content?.type === 'edit') {
                    const idx = thread.findIndex(t => t.id === content.target_id || t.content?.client_msg_id === content.target_id);
                    if (idx !== -1) {
                        thread[idx] = { ...thread[idx], content: { ...thread[idx].content, text: content.text }, edited: true };
                    }
                    return { ...prev, [evt.channel_id]: thread };
                }
                if (content?.type === 'delete') {
                    thread = thread.filter(t => t.id !== content.target_id && t.content?.client_msg_id !== content.target_id);
                    return { ...prev, [evt.channel_id]: thread };
                }
                if (content?.type === 'reaction') {
                    const idx = thread.findIndex(t => t.id === content.target_id || t.content?.client_msg_id === content.target_id);
                    if (idx !== -1) {
                        const target = thread[idx];
                        const reactions = { ...(target.reactions || {}) };
                        const reactor = evt.sender_user_id || evt.sender_device_id;
                        const list = Array.isArray(reactions[content.emoji]) ? reactions[content.emoji] : [];
                        let next: string[];
                        if (content.action === 'add') {
                            next = list.includes(reactor) ? list : [...list, reactor];
                        } else {
                            next = list.filter((id: string) => id !== reactor);
                        }
                        if (next.length === 0) delete reactions[content.emoji];
                        else reactions[content.emoji] = next;
                        thread[idx] = { ...target, reactions };
                    }
                    return { ...prev, [evt.channel_id]: thread };
                }

                // ── Normal message append ────────────────────────────────
                const msg = {
                    id: evt.message_id,
                    content,
                    sender_device_id: evt.sender_device_id,
                    sender_user_id: evt.sender_user_id,
                    timestamp: evt.created_at,
                    conversation_id: evt.channel_id,
                };
                const alreadyPresent =
                    thread.some(m => m.id === evt.message_id) ||
                    thread.some(m => m.content?.client_msg_id && m.content.client_msg_id === content?.client_msg_id);
                if (alreadyPresent) return prev;
                const merged = [...thread, msg].sort(
                    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                );
                return { ...prev, [evt.channel_id]: merged };
            });

            // A delete just removed a personally-saved ("Save for me")
            // channel message — unpin it on every one of this user's devices,
            // the client-side mirror of the server's
            // removePinForDeletedMessage cleanup for server pins.
            if (deletedRowId && localChannelPinsRef.current[evt.channel_id]?.includes(deletedRowId)) {
                handlePersonalChannelSaveRef.current(evt.channel_id, deletedRowId, 'remove');
            }

            // ── Unread / mention counting for channels ────────────────────
            // Only for new content messages, not edits/deletes/reactions.
            // Uses refs to avoid stale closures (callback has empty deps).
            if (content?.type && !['edit', 'delete', 'reaction'].includes(content.type)) {
                const isOwnMessage = !evt.sender_user_id || evt.sender_user_id === userId;
                // Multi-device: a message read live in the open channel moves
                // the SERVER cursor too (debounced), or every other device of
                // this user would count it unread. utils/channelReadSync.ts.
                if (shouldAdvanceChannelCursor({
                    messageChannelId: evt.channel_id,
                    activeChannelId: activeChannelRef.current?.channel_id,
                    activeChannelIsText: activeChannelRef.current?.kind === 'text',
                    windowFocused: document.hasFocus(),
                    documentVisible: document.visibilityState === 'visible',
                    isOwnMessage,
                })) {
                    markChannelReadOnServerRef.current(evt.channel_id, 1_500);
                }
                if (!isOwnMessage) {
                    // Determine effective notification mode for this channel
                    const chanPrefs = channelNotifPrefsRef.current;
                    const srvPrefs = serverNotifPrefsRef.current;
                    const srv = serversRef.current.find(s => s.server_id === evt.server_id);
                    const srvDefault: NotifMode = srv?.default_notification_level ?? 'all';
                    const srvMode: NotifMode = srvPrefs[evt.server_id] ?? srvDefault;
                    const effectiveMode: NotifMode = chanPrefs[evt.channel_id] ?? srvMode;

                    // @mention check: direct user ping, @everyone flag, or a role ping
                    // for any role the current user belongs to in this server.
                    // Keyword hits are folded in by resolveNotification, so this
                    // agrees with what the sound/toast fire on — it didn't before,
                    // and that gap was silent: a keyword hit in a muted or
                    // @mentions-only channel dinged with no badge to show for it.
                    const textBody = content?.type === 'text' ? (content.text ?? '') : '';
                    const myRoleSet = new Set<string>(serverMyRoleIdsRef.current[evt.server_id] ?? []);
                    const directMention = userId ? (
                        messageTextMentionsUser(textBody, userId) ||
                        evt.mentions_everyone ||
                        messageTextMentionsRole(textBody, myRoleSet)
                    ) : false;

                    const gPrefs = notifGlobalPrefsRef.current;
                    // The focus / active-channel test now lives inside the shared
                    // decision instead of wrapping this whole block — wrapping it
                    // meant a message arriving in the channel you're reading skipped
                    // notify() entirely, so the user's own suppress_when_active_conv
                    // preference never got a say.
                    const decision = resolveNotification({
                        text: textBody,
                        directMention,
                        keywords: gPrefs.keywords,
                        mode: effectiveMode,
                        windowFocused: document.hasFocus(),
                        isActiveConversation: activeChannelRef.current?.channel_id === evt.channel_id,
                        suppressWhenActiveConv: gPrefs.suppress_when_active_conv,
                        dndActive: computeNotifDnd(gPrefs, notifCtxRef.current).active,
                        dndLetMentionsThrough: gPrefs.dnd_let_mentions_through,
                    });

                    if (decision.countsMention) {
                        // @mentions always bump mention counter, even when muted
                        setChannelMentionCounts(prev => ({
                            ...prev,
                            [evt.channel_id]: (prev[evt.channel_id] ?? 0) + 1,
                        }));
                    }

                    if (decision.countsUnread) {
                        setChannelUnreadCounts(prev => ({
                            ...prev,
                            [evt.channel_id]: (prev[evt.channel_id] ?? 0) + 1,
                        }));
                    }

                    // Fire OS notification + sound off the SAME decision the two
                    // counters above were incremented from.
                    const chan = (serverChannelsRef.current[evt.server_id] ?? [])
                        .find(c => c.channel_id === evt.channel_id);
                    const chanName = chan?.name ? `#${chan.name}` : 'New message';
                    const srvName = srv?.name ? ` · ${srv.name}` : '';
                    notify({
                        category: decision.isMention ? 'mention' : 'message',
                        conv_id: evt.channel_id,
                        sender_name: `${chanName}${srvName}`,
                        text: textBody || 'New message',
                        is_mention: decision.isMention,
                        mode: effectiveMode,
                        active_conv_id: activeChannelRef.current?.channel_id ?? null,
                        ctx: notifCtxRef.current,
                        decision,
                    });
                }
            }
        } catch (err) {
            // G4: a replayed / mis-bound / malformed row is the server serving
            // something wrong, not a missing key — drop it. The placeholder
            // path below would render a permanent pill AND file key requests.
            if (isChannelServeRejection(err)) {
                console.warn('[Dashboard] Dropped a channel message the server served wrongly:', err);
                return;
            }
            console.error('[Dashboard] Failed to decrypt channel message:', err);
            // Previously this silently dropped the message — the sender saw
            // it land, the recipient saw nothing at all, no request was ever
            // filed, and nothing distinguished a missing key from any other
            // failure. Show the same key_missing placeholder history uses, and
            // file a request so the gap actually closes.
            // Never re-materialise a message the local retention sweep purged:
            // that placeholder IS the "it says it has no encryption keys for it
            // instead of just disappearing" symptom.
            if (userId && getPurgedMessageIds(userId, evt.channel_id).has(evt.message_id)) return;
            setChannelMessages(prev => {
                const existing = prev[evt.channel_id] ?? [];
                if (existing.some(m => m.id === evt.message_id)) return prev;
                const placeholder = {
                    id: evt.message_id,
                    content: { type: 'system', kind: 'encrypted', data: { reason: 'key_missing' } },
                    sender_device_id: evt.sender_device_id,
                    sender_user_id: evt.sender_user_id,
                    timestamp: evt.created_at,
                    conversation_id: evt.channel_id,
                };
                const merged = [...existing, placeholder].sort(
                    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                );
                return { ...prev, [evt.channel_id]: merged };
            });
            undecryptableChannelsRef.current.add(evt.channel_id);
            void channelKeyOpsRef.current.maybeFileKeyRequest(evt.server_id, evt.channel_id);
        }
    }, [userId, notify]);

    const { typingUsers, sendTypingEvent, clearTypingUsers, readReceipts, sendReadReceipt, selfReadEvent, historyRequest, setHistoryRequest, historyDelivered, clearHistoryDelivered, historyDeclined, setHistoryDeclined, deviceLinkedEvent, friendRemovedEvent, friendAcceptedEvent, friendRequestEvent, statusChangedEvent, sendPresenceIdle, callEndedEvent, soloKickEvent, answeredElsewhereEvent, groupMemberAddedEvent, groupUpdatedEvent, avatarUpdatedEvent, usernameUpdatedEvent, voiceStateEvent, huddleSpawnEvent, huddleDestroyEvent, huddleRenameEvent, huddleParticipantEvent, huddleForceMoveEvent, serverRemovedEvent, serverMemberJoinedEvent, permissionsChangedEvent, channelsChangedEvent, serverUpdatedEvent, serverMembersChangedEvent, channelPinsChangedEvent, emojisChangedEvent, serverGraceStatusEvent, channelKeyEnvelopesReadyEvents, setChannelKeyEnvelopesReadyEvents, channelReadEvents, setChannelReadEvents, keyRequestedEvents, setKeyRequestedEvents, channelKeyRotationEvents, setChannelKeyRotationEvents, channelSystemEvent, wsConnectCount } = useRealtime(token, pullMessages, handleChannelMessage, deviceId, userId);

    // ── Ghost-device fix: own-device alarm (docs/ghost-device.md §2.5) ───────
    // A COMPLETE listing of this account's devices at boot and on every
    // reconnect. The response goes through the directory interceptor, which
    // folds it into the own-device ledger; this effect only has to ask. A new
    // device that appears while connected is also caught by the partial own
    // rows in every `/conversations/:id/devices` response (i.e. on send).
    const refreshOwnAlerts = useCallback(() => {
        if (!userId || !deviceId || !ownSelfPub) return;
        setOwnAlertRead({
            key: `${userId}|${deviceId}`,
            state: ownDeviceLedger.currentOwnAlerts(userId, { deviceId, pub: ownSelfPub }),
        });
    }, [userId, deviceId, ownSelfPub]);
    useEffect(
        () => ownDeviceLedger.subscribeOwnLedger(uid => { if (uid === userId) refreshOwnAlerts(); }),
        [userId, refreshOwnAlerts],
    );
    useEffect(() => {
        if (!token || !userId || !deviceId || !ownSelfPub) return;
        let cancelled = false;
        void (async () => {
            try {
                // A cold per-account store reads empty, and the ledger must not
                // be judged (or created) from that. See ownDeviceLedger.ts.
                await secureLocalStore.whenAccountReady();
                if (cancelled || !secureLocalStore.isAccountReady(userId)) return;
                await axios.get(`${API_BASE}/keys/identity_keys?user_id=${encodeURIComponent(userId)}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
            } catch { /* offline: the ledger keeps what it had */ }
            if (!cancelled) refreshOwnAlerts();
        })();
        return () => { cancelled = true; };
    }, [token, userId, deviceId, ownSelfPub, wsConnectCount, refreshOwnAlerts]);
    // Names for the banner rows. Own account only; display-only.
    const ownAlertIds = useMemo(
        () => [...ownAlertState.alerts.map(a => a.device_id), ...ownAlertState.unreviewedBaseline].sort().join(','),
        [ownAlertState.alerts, ownAlertState.unreviewedBaseline],
    );
    useEffect(() => {
        if (!ownAlertIds || !token) return;
        let cancelled = false;
        axios.get(`${API_BASE}/devices`, { headers: { Authorization: `Bearer ${token}` } })
            .then(res => {
                if (cancelled || !Array.isArray(res.data)) return;
                const byId: Record<string, OwnDeviceName> = {};
                for (const d of res.data as (OwnDeviceName & { device_id?: string })[]) {
                    if (d?.device_id) byId[d.device_id] = { device_name: d.device_name, platform: d.platform, created_at: d.created_at };
                }
                setOwnAlertNames(byId);
            })
            .catch(() => { /* rows fall back to a short id */ });
        return () => { cancelled = true; };
    }, [ownAlertIds, token]);
    const handleOwnConfirm = useCallback((id: string, pub: string) => {
        if (userId) ownDeviceLedger.confirmOwnDevice(userId, id, pub);
    }, [userId]);
    const handleOwnReject = useCallback((id: string, pub: string) => {
        if (!userId) return;
        // Local record first: it is what keeps the alarm and withholds the
        // code if the server ignores the revoke.
        ownDeviceLedger.rejectOwnDevice(userId, id, pub);
        axios.post(`${API_BASE}/devices/${encodeURIComponent(id)}/revoke`, {}, {
            headers: { Authorization: `Bearer ${token}`, ...(deviceId ? { 'x-device-id': deviceId } : {}) },
        }).catch(() => { /* the local record still alarms */ });
    }, [userId, token, deviceId]);
    const { broadcastCurrentAvatar } = useAvatarBroadcast(token, userId);

    // Cancel incoming ringing visually if the caller hung up before we picked up
    //
    // This is also where 'call_ended' ("Line closed") belongs, and the ONLY
    // place it belongs today: the line closed without you being the one who
    // closed it. It is deliberately not fired when you leave a call yourself
    // (that is 'leave' / Ebb, the creature swimming off) and not when the
    // 15-second outgoing ringback times out, because that does not end the
    // call — only the sound stops, and the callee can still pick up.
    // Ref-guarded because this effect also re-runs when globalIncomingCall
    // changes, which would otherwise ring it twice for one hang-up.
    const lastCallEndedCue = useRef(callEndedEvent);
    useEffect(() => {
        if (callEndedEvent && globalIncomingCall?.session_id === callEndedEvent.session_id) {
            if (lastCallEndedCue.current !== callEndedEvent) {
                lastCallEndedCue.current = callEndedEvent;
                playSound('call_ended', notifGlobalPrefsRef.current);
            }
            setGlobalIncomingCall(null);
        }
    }, [callEndedEvent, globalIncomingCall]);

    // Someone pinned or unpinned in a channel we can see. Channel pins are
    // shared with the whole server, so refetch that channel's list rather than
    // waiting for the user to re-enter the channel.
    //
    // Refetch instead of applying a delta from the payload: the event is
    // metadata-only by design, and GET /pins is permission-checked, so this
    // can't become a way to learn about pins in a channel we shouldn't see.
    // Cheap — one request per pin action, and only for members who can view it.
    useEffect(() => {
        if (!channelPinsChangedEvent || !token) return;
        const cid = channelPinsChangedEvent.channel_id;
        let cancelled = false;
        (async () => {
            try {
                const st = await fetchChannelSaveState(API_BASE, cid, token);
                if (cancelled) return;
                applyChannelSaveState(cid, st);
            } catch {
                // Non-fatal: falls back to the refresh-on-channel-entry path.
            }
        })();
        return () => { cancelled = true; };
    }, [channelPinsChangedEvent, token, applyChannelSaveState]);

    // Kicked from call due to being alone for 15 minutes.
    //
    // This is the server-authoritative path — a backstop for when the
    // client's own local inactivity timer (SidebarConference) can't be relied
    // on (app backgrounded/suspended and its setTimeout got throttled, etc).
    // In the common case the client's local timer already left the call and
    // cleared activeCall well before this server event round-trips back
    // (poll + LiveKit calls), so the `!activeCall` guard below already no-ops
    // it. The remaining race — the server's poll happens to land just ahead
    // of the client's own countdown finishing — is covered by
    // inactivityWarningSessionRef: if the client is already showing (or about
    // to show) its own "removed due to inactivity" dialog for this exact
    // session, still force the disconnect (no reason to wait out the
    // client's remaining countdown seconds once the server has actually
    // removed us from the LiveKit room) but skip the second SoloKickDialog —
    // one kick should only ever produce one "you were removed" notice.
    useEffect(() => {
        if (!soloKickEvent || !activeCall) return;
        if (soloKickEvent.session_id === activeCall.id) {
            const alreadyHandledLocally = inactivityWarningSessionRef.current === activeCall.id;
            handleDisconnectCall(false);
            if (!alreadyHandledLocally) {
                setShowSoloKickDialog(true);
            }
        }
    }, [soloKickEvent]);

    // Multi-device answer race fix: a sibling device answered this ring
    // first (calls.service.ts's Redis claim in joinCall). Before this event
    // existed, a device that lost the race just sat there ringing until its
    // own local 15s timeout — indistinguishable from the call having been
    // genuinely missed. This device never joined LiveKit at all (unlike
    // soloKickEvent above, which handles an ALREADY-CONNECTED device being
    // removed), so there's no disconnect to run — just clear the ringing UI
    // and say what actually happened.
    //
    // The `!globalIncomingCall` guard is NOT what keeps the winner quiet, and
    // believing it was is what shipped this bug: the server emits the push
    // before the winner's own join response is serialized, so on the winner
    // the frame arrives while globalIncomingCall is still set and the toast
    // fired on the very device the user had just answered on. The winner is
    // now filtered out twice — server-side by socket device_id, client-side by
    // isOwnAnswerEcho in useRealtime — so by the time an event reaches this
    // effect it genuinely belongs to a losing sibling.
    //
    // A losing sibling can still see this event slightly ahead of its own
    // 409 handling in acceptGlobalCall; both paths converge on the same
    // "answered elsewhere" toast, so whichever fires first wins with no
    // conflicting UI.
    useEffect(() => {
        if (!answeredElsewhereEvent || !globalIncomingCall) return;
        if (answeredElsewhereEvent.session_id === globalIncomingCall.session_id) {
            setGlobalIncomingCall(null);
            toast.push({ kind: 'info', title: 'Answered elsewhere', message: 'This call was answered on your other device.' });
        }
    }, [answeredElsewhereEvent]);

    // QR-2 (adversarial review) — a device was just linked into this account
    // via QR sign-in. This is the "you would notice" control docs/QR-LINKING.md
    // §2.9 leans on for the scan-phishing and compromised-device residuals; it
    // had no listener anywhere before, so the server was emitting into the
    // void. No auto-dismiss (durationMs: 0) — this is a security-relevant
    // notice a user should consciously acknowledge, not routine chatter.
    useEffect(() => {
        if (!deviceLinkedEvent) return;
        toast.push({ kind: 'warning', durationMs: 0, ...formatDeviceLinkedToast(deviceLinkedEvent) });
    }, [deviceLinkedEvent]);

    // When we're added to a group: refresh conversations, unhide, inject system message, bump unread
    useEffect(() => {
        if (!groupMemberAddedEvent || !token) return;
        const { conversation_id, system_text } = groupMemberAddedEvent;

        // 'invite' ("Beacon") — a door opened for you. Safe to fire
        // unconditionally here: the gateway pushes group:member_added to the
        // NEW MEMBER alone so they can pull the conversation
        // (gateway.gateway.ts, "Push a group:member_added event to the new
        // member"), so this never fires for someone else being added to a
        // group you are already in.
        playSound('invite', notifGlobalPrefsRef.current);

        // Fetch conversations so the new group appears in the list
        axios.get(`${API_BASE}/conversations`, {
            headers: { Authorization: `Bearer ${token}` }
        }).then(res => {
            if (Array.isArray(res.data)) setConversations(labelSelfConversations(res.data, authUserId));
        }).catch(() => {});

        // Unhide if the user previously closed this group
        setHiddenConversations(prev => prev.filter(id => id !== conversation_id));

        // Inject the "X added Y" system message into the chat
        if (system_text) {
            const sysMsgId = `system-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            setMessagesState(prev => {
                const current = prev[conversation_id] || [];
                return {
                    ...prev,
                    [conversation_id]: [...current, {
                        id: sysMsgId,
                        content: { type: 'system', text: system_text },
                        sender_device_id: '__system__',
                        sender_user_id: '__system__',
                        timestamp: new Date().toISOString(),
                        conversation_id,
                    }],
                };
            });

            // Bump unread count unless this group is already the active chat
            if (activeChatRef.current?.id !== conversation_id) {
                setUnreadCounts(prev => ({
                    ...prev,
                    [conversation_id]: (prev[conversation_id] || 0) + 1,
                }));
            }
        }
    }, [groupMemberAddedEvent, token, authUserId]);

    // group:updated metadata_changed — admin renamed the group or changed its
    // icon. Patch conversations + activeChat in place so the sidebar tile,
    // chat header, and group settings preview all update instantly without
    // the user having to navigate away and back.
    useEffect(() => {
        if (!groupUpdatedEvent) return;
        if (groupUpdatedEvent.action !== 'metadata_changed') return;
        const { conversation_id, title, avatar_attachment } = groupUpdatedEvent;
        const patch = (c: any) => {
            const next = { ...c };
            if (title !== undefined)             next.title = title;
            if (avatar_attachment !== undefined) next.avatar_url = avatar_attachment;
            return next;
        };
        setConversations(prev => prev.map(c =>
            c.conversation_id === conversation_id ? patch(c) : c
        ));
        setActiveChat(prev => (prev && prev.id === conversation_id) ? patch(prev) : prev);
    }, [groupUpdatedEvent]);

    // When a member leaves/joins: inject a system message and refresh the member list
    useEffect(() => {
        if (!groupUpdatedEvent?.system_text) return;
        const { conversation_id, system_text } = groupUpdatedEvent;
        const sysMsgId = `system-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        setMessagesState(prev => {
            const current = prev[conversation_id] || [];
            return {
                ...prev,
                [conversation_id]: [...current, {
                    id: sysMsgId,
                    content: { type: 'system', text: system_text },
                    sender_device_id: '__system__',
                    sender_user_id: '__system__',
                    timestamp: new Date().toISOString(),
                    conversation_id,
                }]
            };
        });
        // Refresh member list if this is the open conversation
        if (activeChatRef.current?.id === conversation_id && token && deviceId) {
            axios.get(`${API_BASE}/conversations/${conversation_id}/devices`, {
                headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId }
            }).then(res => {
                const uniqueUsers = new Map();
                res.data.forEach((d: { user_id: string; username?: string; avatar_url?: string | null }) => {
                    if (d.user_id && !uniqueUsers.has(d.user_id)) {
                        uniqueUsers.set(d.user_id, { user_id: d.user_id, username: d.username, avatar_url: d.avatar_url });
                    }
                });
                setGroupMembers(Array.from(uniqueUsers.values()));
            }).catch(() => {});
        }
    }, [groupUpdatedEvent, token, deviceId]);

    // Seed ALL accepted friends (not just DM partners) so the friends tab
    // shows correct presence even for friends you've never messaged.
    const acceptedFriendsForStatus = React.useMemo(() =>
        globalFriends?.accepted ?? [],
        [globalFriends]
    );

    /** user_id → {username, avatar_url} for accepted friends — best-effort name
     *  resolution for the floating call widget's participant rows (Dashboard
     *  has no per-server member list for a server the user has navigated away
     *  from, unlike ServerContextPanel). Participants who aren't friends show
     *  a generic "Member" label rather than a fabricated name. */
    const friendNameMap = React.useMemo(() => {
        const map: Record<string, { username: string; avatar_url: string | null }> = {};
        for (const f of acceptedFriendsForStatus) {
            map[f.user_id] = { username: f.username, avatar_url: f.avatar_url ?? null };
        }
        return map;
    }, [acceptedFriendsForStatus]);

    const gameSettings = useGameSettings(userId);
    const privacy = usePrivacySettings();
    const gif = useGifSettings();

    const { myStatus, myCurrentGame, myCurrentGameProcess, setStatus, clearGame, friendStatuses, presenceAuthoritative } = useUserStatus({
        token,
        userId,
        acceptedFriends: acceptedFriendsForStatus,
        showGameActivity: gameSettings.settings.showGameActivity,
        wsConnectCount,
        sendPresenceIdle,
    });

    // The DM-partner presence bits from the 30 s REST poll, reconciled with
    // live status. Once a complete `presence:snapshot` has been applied,
    // `friendStatuses` is authoritative for everyone in our audience and is
    // kept current by events — while a poll result can be up to 30 s old,
    // which used to keep someone in "Active Now" (and their DM row green) for
    // half a minute after they went offline. Before any snapshot (an older
    // server) the poll is still the best signal for non-friends.
    const displayPresence = useMemo<Record<string, boolean>>(() => {
        if (!presenceAuthoritative) return presence;
        const out: Record<string, boolean> = {};
        for (const id of Object.keys(presence)) out[id] = (friendStatuses[id]?.status ?? 'offline') !== 'offline';
        return out;
    }, [presenceAuthoritative, presence, friendStatuses]);

    // Settings ▸ Game Activity's "ignore this game" — permanently adds the
    // currently-detected process to the ignore list (so it's never detected
    // again) AND clears the live status immediately, rather than waiting for
    // the next 10s poll to notice it's now ignored.
    const ignoreCurrentGame = useCallback(() => {
        if (!myCurrentGameProcess) return;
        gameSettings.addIgnoredProcess(myCurrentGameProcess);
        clearGame();
    }, [myCurrentGameProcess, gameSettings, clearGame]);

    // Keep the ref in sync so playNotification (defined above) always sees the latest status
    useEffect(() => { myStatusRef.current = myStatus; }, [myStatus]);

    // Keep the notification DND-context ref current (status / in-call / game).
    // Note: local-screenshare state isn't observable here — <CallProvider> is a
    // CHILD of Dashboard, so the call context (and its track state) lives below
    // this component, not in its scope. We default screensharing to false; the
    // "auto-DND while screensharing" toggle stays inert until it's wired from a
    // component inside the call tree. (Previously referenced callCtxRef, which
    // belongs to CallFocusSuppressor, not Dashboard — that was the crash.)
    useEffect(() => {
        notifCtxRef.current = {
            userStatus: myStatus ?? 'online',
            activeCall: !!activeCall,
            screensharing: false,
            gameActive: !!myCurrentGame,
        };
    }, [myStatus, activeCall, myCurrentGame]);

    // ── Unread badge + tray state push ──────────────────────────────────────────
    // Compute the cross-conversation unread total per the user's badge prefs and
    // push it to the main process (dock badge / taskbar overlay / tray tooltip).
    // Also pushes DND + status so the tray menu radio/checkbox stays in sync.
    useEffect(() => {
        if (!window.electronAPI) return;
        const p = notifGlobalPrefs;
        // One rule, in utils/unreadBadges.ts: only what is allowed to ping
        // counts. An @mentions-only conversation/channel shows a grey dot in
        // the app and contributes nothing here but its mentions.
        const serverMode = (sid: string): NotifMode | undefined =>
            serverNotifPrefs[sid] ?? servers.find(s => s.server_id === sid)?.default_notification_level ?? undefined;
        const count = trayBadgeCount({
            unreadCounts, mentionCounts, channelUnreadCounts, channelMentionCounts,
            conversationMode: id => notifPrefs[id] ?? 'all',
            channelMode: id => effectiveChannelMode(id, channelNotifPrefs, cid => channelToServerId[cid], serverMode),
            showBadgeCount: p.show_badge_count,
            onlyMentions: p.badge_only_mentions,
            includesMuted: p.badge_includes_muted,
        });

        const dndActive = computeNotifDnd(p, notifCtxRef.current).active;
        window.electronAPI.notifSetBadge?.(count);
        window.electronAPI.trayUpdateState?.({
            unreadCount: count,
            dndActive,
            dndManual: p.dnd_manual,
            status: myStatusRef.current,
            // The tray lives in the main process and can't read this itself —
            // the PIN verifier is in secureLocalStore, the renderer's encrypted
            // IndexedDB. Push it so "Lock" only appears when it would work.
            screenLockAvailable: !!(screenLock.settings.enabled && screenLock.settings.verifier),
        });
    }, [unreadCounts, mentionCounts, channelUnreadCounts, channelMentionCounts,
        notifGlobalPrefs, notifPrefs, channelNotifPrefs, serverNotifPrefs, servers, channelToServerId,
        myStatus, activeCall, myCurrentGame,
        screenLock.settings.enabled, screenLock.settings.verifier]);

    /**
     * Repair every piece of state the app can't rebuild on its own.
     *
     * One routine, three triggers (WS reconnect, OS resume, network online) so
     * there is a single list to keep complete. The previous arrangement had the
     * reconnect handler refreshing an ad-hoc subset inline — conversations and
     * servers, but not friends — which is how a reconnect could leave statuses
     * and avatars stale even when it fired correctly.
     *
     * Also bumps the hydration generation, which is what gives previously
     * FAILED loads elsewhere (avatars, above all) another attempt. Loads that
     * already succeeded sit in their caches and cost nothing.
     */
    // Sleep-wake call-staleness backstop (Phase M, reliability audit). On
    // waking, the WS socket was dead the entire time the device was asleep —
    // no `call:solo_kick`-style event could have arrived if the call actually
    // ended (the other party hung up, a server-side reap, etc.) while we were
    // out. GET /v1/calls/:id/status covers all three call kinds uniformly
    // (DM/group, voice-channel, huddle all set activeCall.id to the same
    // call_sessions.id — see handleJoinVoiceChannel/handleLeaveHuddleCall),
    // so a single check here backstops all of them.
    //
    // Retries over a generous grace window rather than acting on one failed
    // request — see callStalenessPolicy.ts's header comment for why a failed
    // check must never be treated as "the call is dead" (post-wake
    // networking is often slow to come back, not evidence of anything).
    // Fire-and-forget from rehydrateAll (not awaited) so a slow/retrying
    // check never delays the rest of rehydration.
    const checkCallStalenessOnWake = useCallback(async (callId: string, authToken: string) => {
        const GRACE_WINDOW_MS = 30_000; // > the 15s call-connect timeout, deliberately
        const RETRY_DELAY_MS = 3_000;
        const start = Date.now();

        // No AbortController/cleanup: this loop self-terminates within
        // GRACE_WINDOW_MS and bails immediately if the call it's checking
        // stops matching activeCallRef (hung up locally, or a different call
        // started) — Dashboard is effectively the whole app's lifetime, so
        // there's no meaningful "unmount mid-check" case to guard against.
        for (;;) {
            if (activeCallRef.current?.id !== callId) return; // no longer relevant

            let status: CallStatusResponse | null = null;
            try {
                const res = await axios.get(`${API_BASE}/calls/${callId}/status`, {
                    headers: { Authorization: `Bearer ${authToken}` },
                    timeout: 8000,
                });
                status = res.data;
            } catch {
                status = null; // network/timeout/auth hiccup — inconclusive, not "dead"
            }

            if (shouldTeardownForCallStatus(status)) {
                console.warn(`[hydrate] call ${callId} ended while asleep — tearing down locally`);
                toast.push({ kind: 'info', title: 'Call ended', message: 'This call ended while your device was asleep.' });
                handleDisconnectCallRef.current?.(true);
                return;
            }
            if (status !== null) return; // confirmed still active — nothing to do

            if (!shouldKeepRetryingStalenessCheck(Date.now() - start, GRACE_WINDOW_MS)) {
                console.warn(`[hydrate] call ${callId} staleness check exhausted its grace window with no conclusive answer — leaving call as-is`);
                return;
            }
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
    }, [toast]);

    /** user_id → display name, for people currently in a call. Populated by the
     *  voice-presence seed only; the rail roster labels anyone it does not
     *  cover as "Someone" rather than fetching per user or showing a raw id. */
    const [voiceUserNames, setVoiceUserNames] = useState<Record<string, string>>({});
    /** user_id -> avatar ATTACHMENT ID, for people currently in a call. The
     *  cross-server counterpart to serverMemberAvatarMaps, which only covers a
     *  server whose ServerContextPanel is mounted — i.e. one you have opened
     *  this session. Home's "Happening now" deck shows calls in servers you
     *  have NOT opened, so without this it had no avatar id for them at all and
     *  fell back to the colour placeholder every time. Fed by the same two
     *  sources as voiceUserNames: the batched seed and the live JOIN events. */
    const [voiceUserAvatarIds, setVoiceUserAvatarIds] = useState<Record<string, string>>({});
    const voiceSeedInFlightRef = useRef(false);
    /**
     * Seed live call presence — `voiceParticipants` AND `huddleCalls` — for
     * EVERY joined server from one request.
     *
     * Both maps are otherwise fed only by WS events (`channel:voice_state` and
     * the `huddle:*` family), which means at app START they are empty: a call
     * already in progress before you launched was invisible on Home and on the
     * rail until you happened to open that server. This is the missing seed.
     *
     * `huddleCalls` is the half that actually matters in practice. Every server
     * this product creates gets a `kind='huddle'` "Calls" channel and no
     * `kind='voice'` channel at all, so a seed that only filled
     * `voiceParticipants` filled nothing — which is exactly why "when the app
     * first loads it usually won't even show up at all" and why the rail badge
     * never lit. `huddleCalls` was previously loaded one huddle at a time by
     * `loadHuddleCalls`, and only for the server you had OPEN.
     *
     * One batched GET rather than the per-server loop it replaces — voice
     * presence work is the same shape the `voiceJoin` bucket exists to bound,
     * so N requests at boot for a user in N servers was the wrong direction.
     * The response is already VIEW_CHANNEL-filtered server-side and omits a
     * server whose only active call is in a channel this user cannot see, so
     * nothing here needs (or should have) a mirror permission check.
     *
     * Replace rather than merge: a channel that has emptied since the last
     * seed must lose its entry, and a merge would strand it forever. The cost
     * of replacing is a ~one-round-trip window in which a `voice_state` event
     * that lands mid-flight is overwritten by the older snapshot; that
     * self-heals on the next event for that channel, or at worst on the next
     * reconcile tick, which is why the tick exists at all.
     * `voiceSeedInFlightRef` collapses the boot seed racing a reconnect seed —
     * both write the same state, and the endpoint's bucket is small.
     */
    const seedVoicePresence = useCallback(async () => {
        if (!token || voiceSeedInFlightRef.current) return;
        voiceSeedInFlightRef.current = true;
        try {
            const res = await axios.get(`${API_BASE}/voice-participants`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const servers: Array<{
                server_id: string;
                channels: Array<{ channel_id: string; participants: string[] }>;
                huddles?: Array<{ huddle_id: string; calls: HuddleCallInfo[] }>;
                users: Array<{ user_id: string; name: string; avatar_url?: string | null }>;
            }> = res.data ?? [];
            const next: Record<string, string[]> = {};
            const nextHuddles: Record<string, HuddleCallInfo[]> = {};
            const names: Record<string, string> = {};
            const avatars: Record<string, string> = {};
            for (const s of servers) {
                for (const { channel_id, participants } of s.channels ?? []) {
                    if (participants?.length) next[channel_id] = participants;
                }
                // `huddles` is optional so a client running against an API that
                // predates it degrades to the old voice-only behaviour instead
                // of throwing — the desktop app and the API roll separately.
                for (const { huddle_id, calls } of s.huddles ?? []) {
                    if (calls?.length) nextHuddles[huddle_id] = calls;
                }
                // Names come with the seed so the rail's hover roster never has
                // to resolve a user id itself — the client has no username cache
                // for a server it has not opened, and one lookup per person in a
                // call is exactly the per-user fan-out this endpoint replaces.
                for (const u of s.users ?? []) {
                    if (!u?.user_id) continue;
                    names[u.user_id] = u.name;
                    // Optional for the same reason `huddles` is: the desktop app
                    // and the API roll separately, so an API that predates the
                    // field must degrade to the placeholder rather than throw.
                    if (u.avatar_url) avatars[u.user_id] = u.avatar_url;
                }
            }
            setVoiceParticipants(next);
            applyHuddleCallsSnapshot(nextHuddles);
            // Merge, don't replace: a name learned from a live join event since
            // this request went out must survive the older snapshot landing on
            // top of it, and a name for someone who has since left costs
            // nothing to keep. Live joins now carry `display_name` themselves,
            // so the seed is no longer the only source — see
            // mergeVoiceUserName.
            setVoiceUserNames(prev => ({ ...prev, ...names }));
            // Merged for the same reason the names are, plus one of its own: a
            // stale id here costs nothing (the attachment is immutable, and a
            // changed avatar is a NEW attachment that arrives with the next
            // event or seed), while dropping ids would re-blank the deck on
            // every reconcile tick.
            setVoiceUserAvatarIds(prev => ({ ...prev, ...avatars }));
        } catch {
            /* silent — presence stays as-is until the next tick; a stale roster
               is a better outcome than blanking the rail on one failed GET. */
        } finally {
            voiceSeedInFlightRef.current = false;
        }
    }, [token, applyHuddleCallsSnapshot]);
    const seedVoicePresenceRef = useRef(seedVoicePresence);
    useEffect(() => { seedVoicePresenceRef.current = seedVoicePresence; }, [seedVoicePresence]);

    // ── Voice presence: seed at boot, then reconcile slowly ───────────────────
    // The live path is the `channel:voice_state` WS push, which already fires
    // on every join and leave — this is NOT a substitute for it and must stay
    // far slower than anything that would matter.
    //
    // The seed closes the app-start gap. The 5-minute reconcile is only a
    // safety net for a state change whose event never landed: a socket that is
    // wedged without having "reconnected" (so the reconnect re-seed below never
    // runs), or a leave attributed by the server's disconnect-cleanup path
    // while this client was briefly deaf.
    //
    // Why 5 minutes: this read costs one permission-resolution pass per server
    // that currently has a live call, and nothing per server member — but the
    // reason to keep it slow is that it buys almost nothing. Everything it
    // could fix is already pushed; it exists so a missed event self-heals
    // within minutes instead of persisting until the next reconnect. At 1
    // request/5 min/user it is ~6.7x rarer than the 45s `presence:heartbeat`
    // (which is untouched here, and stays exempt from throttling/gating), and
    // it strictly REDUCES request count versus the per-server reconnect loop it
    // replaces. It also sits comfortably inside the endpoint's 6/10s bucket.
    useEffect(() => {
        if (!token) return;
        void seedVoicePresenceRef.current();
        const RECONCILE_MS = 5 * 60_000;
        const id = setInterval(() => { void seedVoicePresenceRef.current(); }, RECONCILE_MS);
        return () => clearInterval(id);
    }, [token]);

    const rehydrateOnce = useCallback(() => trackActivity('resume:rehydrate', async () => {
        if (!token) return;
        console.log('[hydrate] rehydrating');

        // Voice participants are event-driven only (channel:voice_state), so
        // anything that fired while we were away is simply gone — re-fetching
        // is the only way back in sync. seedVoicePresence replaces the whole
        // map in one shot (for every server, not just the active one), so the
        // clear-then-refill dance this used to do is no longer needed — and
        // dropping it removes the window where the rail and Home flashed empty
        // between the clear and the response.
        void seedVoicePresenceRef.current();

        await Promise.allSettled([
            fetchConversationsRef.current?.() ?? Promise.resolve(),
            fetchFriendsRef.current?.() ?? Promise.resolve(),
            // Own avatar/name: a lost /auth/me at boot is otherwise permanent.
            refreshProfile(),
            // loadServers swallows its own errors, so awaiting it always
            // settles — which is what the gate wants (settled, not succeeded).
            loadServers().finally(() => markSettled('servers')),
        ]);

        // Huddle calls are a separate subsystem (Redis-backed, per-huddle-
        // channel) with no batched read, so they stay scoped to the active
        // server here rather than fanning out N requests across every server.
        if (activeServerViewRef.current?.serverId) {
            const sid = activeServerViewRef.current.serverId;
            const huddles = (serverChannelsRef.current[sid] ?? []).filter(c => c.kind === 'huddle');
            for (const h of huddles) loadHuddleCalls(h.channel_id);
        }

        // Last, so retriers see freshly-loaded lists rather than racing them.
        bumpGeneration();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [token, loadServers, loadHuddleCalls, bumpGeneration, markSettled]);

    // PERF (freeze fix): one wake fires rehydrateAll TWICE within a few ms —
    // `app:resumed` directly, and the forced WS reconnect a moment later via
    // the wsConnectCount effect — and each run is four list fetches whose
    // responses each re-render the whole dashboard. Running them concurrently
    // doubled the post-wake render storm for no new information. Now a call
    // that arrives while a run is in flight does not start a parallel one; it
    // queues exactly ONE follow-up run after the current one settles (so a
    // run that started before the network was back still gets repaired by a
    // fresh one), and any number of further calls in that window collapse
    // into that same follow-up.
    const rehydrateOnceRef = useRef(rehydrateOnce);
    useEffect(() => { rehydrateOnceRef.current = rehydrateOnce; }, [rehydrateOnce]);
    const [rehydrateCoalesced] = useState(() => createCoalescedRunner(() => rehydrateOnceRef.current()));
    const rehydrateAll = useCallback(async (opts?: { checkCallStaleness?: boolean }): Promise<void> => {
        if (!token) return;
        // Independent of the list refresh and self-limiting — never coalesced
        // away, since only the wake trigger asks for it.
        if (opts?.checkCallStaleness && activeCallRef.current?.id) {
            void checkCallStalenessOnWake(activeCallRef.current.id, token);
        }
        return rehydrateCoalesced();
    }, [token, rehydrateCoalesced, checkCallStalenessOnWake]);

    // The OS woke from sleep. useRealtime rebuilds the socket on the same
    // signal; this repairs the data that socket's absence left stale.
    // checkCallStaleness: true only here, not on the WS-reconnect/online
    // triggers below — those are still-live-session blips LiveKit's own
    // reconnect logic already handles (see Phase B's OfflineScreen fix);
    // this backstop is specifically for "was the call ever un-ended while we
    // had literally no connection to find out" — sleep is the case that
    // actually produces that gap.
    useEffect(() => {
        const unsub = window.electronAPI?.onAppResumed?.(() => { void rehydrateAll({ checkCallStaleness: true }); });
        return () => { try { unsub?.(); } catch { /* ignore */ } };
    }, [rehydrateAll]);

    // Re-fetch data on WebSocket reconnect (e.g. coming back online after
    // being offline). wsConnectCount increments on every successful
    // connection; we skip the initial connect (count goes 0→1) because the
    // normal load effects already handle that, and only re-fetch on
    // subsequent reconnects.
    //
    // This is the single "make everything live again" resync — sleep-resync
    // Phase 3. Everything here has NO other resync path: each of these
    // pieces of state is mutated only by a specific WS event, so anything
    // that fired while the socket was a zombie (see useRealtime.ts's
    // liveness watchdog, Phase 1) is gone with nothing left to reconcile it
    // except re-fetching from the API. Previously this only covered
    // conversations/servers/voice+huddle-for-the-ACTIVE-server-only; friends,
    // channels/categories/permissions, non-active-server voice/huddle state,
    // pins, and roles all had no resync at all and just sat stale until
    // something unrelated happened to touch them.
    const prevWsConnectCount = useRef(0);
    // reconcileChannelMentions is defined further down (it needs
    // decryptChannelRow, which needs to exist first) — this effect runs long
    // before that point in the component body, so it can't close over the
    // function directly. Same forward-reference-via-ref pattern as
    // forceReconnectRef in useRealtime.ts's Phase 1 liveness watchdog.
    const reconcileChannelMentionsRef = useRef<(serverId: string, channelId: string, unreadCount: number) => void>(() => {});

    // Server-side read-cursor reconciliation, folded in by
    // utils/channelReadSync.ts reconcileChannelUnread: it RAISES (messages
    // that arrived while this device was asleep or closed) AND, new with the
    // multi-device audit, LOWERS — a channel read on another device while this
    // one was offline is otherwise lit here forever (the old rule was floor-
    // only, and `channel:read` only reaches a device that is connected). A
    // count that changed locally while the request was in flight is never
    // lowered, which is the race the floor rule existed for. The open channel
    // is never raised while the window is attended: the user is looking at it.
    const reconcileServerUnreadRef = useRef<(serverIds: string[]) => Promise<void>>(async () => {});
    reconcileServerUnreadRef.current = (serverIds: string[]) => {
        if (!token) return Promise.resolve();
        const pending: Promise<unknown>[] = [];
        for (const sid of serverIds) {
            const unreadAtRequest = channelUnreadCountsRef.current;
            const mentionsAtRequest = channelMentionCountsRef.current;
            pending.push(axios.get(`${API_BASE}/servers/${sid}/unread`, {
                headers: { Authorization: `Bearer ${token}` },
            }).then(res => {
                const raw: Array<{ channel_id: string; unread_count: number }> = Array.isArray(res.data) ? res.data : [];
                const open = activeChannelRef.current;
                const looking = open?.kind === 'text' && document.hasFocus() && document.visibilityState === 'visible';
                const rows = looking && open ? raw.map(r => r.channel_id === open.channel_id ? { ...r, unread_count: 0 } : r) : raw;
                setChannelUnreadCounts(prev => reconcileChannelUnread({
                    unread: prev, mentions: {}, rows, unreadAtRequest, mentionsAtRequest: {},
                }).unread);
                setChannelMentionCounts(prev => reconcileChannelUnread({
                    unread: {}, mentions: prev, rows, unreadAtRequest: {}, mentionsAtRequest,
                }).mentions);
                // Mentions can't be computed server-side (E2EE) — for any
                // channel reported unread, pull and decrypt just those messages.
                for (const row of rows) {
                    if (row.unread_count > 0) reconcileChannelMentionsRef.current(sid, row.channel_id, row.unread_count);
                }
            }).catch(() => {/* silent — local live-event tally stays as it was */}));
        }
        return Promise.all(pending).then(() => undefined);
    };
    // Cold start: the reconnect effect below deliberately skips the FIRST
    // connection, so before this nothing reconciled at launch — a channel read
    // on the phone while the desktop was closed stayed unread on the desktop.
    // Once per server per session, as servers become known.
    const unreadReconciledRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        if (!token || wsConnectCount === 0) return;
        const fresh = servers.map(s => s.server_id).filter(id => !unreadReconciledRef.current.has(id));
        if (fresh.length === 0) return;
        for (const id of fresh) unreadReconciledRef.current.add(id);
        void reconcileServerUnreadRef.current(fresh);
    }, [servers, token, wsConnectCount]);
    // Same forward-reference pattern: refreshChannelHistory is defined below.
    const refreshChannelHistoryRef = useRef<(serverId: string, channelId: string) => Promise<void>>(async () => {});
    // The reconnect resync's paced queue — see the effect below.
    const resyncQueueRef = useRef<TaskQueue>(null as unknown as TaskQueue);
    if (!resyncQueueRef.current) resyncQueueRef.current = createTaskQueue({ concurrency: RESYNC_CONCURRENCY, jitterMs: RESYNC_JITTER_MS });
    useEffect(() => {
        if (wsConnectCount === 0) return;
        if (prevWsConnectCount.current === 0) {
            // First connection on mount — skip, other effects handle initial load.
            prevWsConnectCount.current = wsConnectCount;
            return;
        }
        prevWsConnectCount.current = wsConnectCount;
        // Freeze log: the resync below is a burst of fetches whose responses
        // each re-render the dashboard. Label the window they land in.
        setTimeout(beginActivity('reconnect:resync'), 10_000);

        // PERF (wake/reconnect storm): everything below used to fire at once —
        // ~5 requests per joined server plus the global lists, every response
        // re-rendering the whole dashboard in whatever order it landed, all
        // while the user was trying to look at the conversation they woke the
        // PC to read. It now goes through one paced queue: what is on screen
        // first, then badges, then everything else, at most RESYNC_CONCURRENCY
        // requests in flight, start times jittered so the responses don't all
        // land in the same frame. A newer reconnect cancels whatever an older
        // one had not started yet (it is about to redo all of it).
        // Coverage is unchanged — same calls, same per-call semantics.
        const q = resyncQueueRef.current;
        q.cancelPending();
        const P_VISIBLE = 0, P_LISTS = 1, P_BADGES = 2, P_ACTIVE_SERVER = 3, P_REST = 4;

        // A missed typing:stop is unrecoverable (there's no "current typers"
        // snapshot to re-fetch) and would otherwise show "typing…" forever.
        // Clearing on every reconnect is the only correct fix — worst case
        // is a real typer's indicator blinks off and back on within a
        // couple seconds, harmless.
        clearTypingUsers();

        // ── P0: what the user is looking at ──────────────────────────────
        // The open channel's newest page. Live channel messages arrive only
        // as WS pushes, so anything posted while the socket was dead was
        // otherwise never shown here until the channel was re-opened (the
        // renderer reload that used to follow every reconnect hid this).
        if (token && activeChannel) {
            const { server_id: sid, channel_id: cid } = activeChannel;
            q.add(() => refreshChannelHistoryRef.current(sid, cid), P_VISIBLE);
            // Pins for the open channel — the same GET the
            // channelPinsChangedEvent handler above already uses. Scoped to
            // the active channel only: pins change rarely and are already
            // covered by the refresh-on-channel-entry path for anything else.
            q.add(() => fetchChannelSaveState(API_BASE, cid, token)
                .then(st => applyChannelSaveState(cid, st))
                .catch(() => {/* non-fatal — falls back to the refresh-on-entry path */}), P_VISIBLE);
        }
        // DMs waiting on the server (the 5 s poll would get them; don't wait).
        q.add(() => pullMessagesRef.current?.(), P_VISIBLE);

        // ── P1: the lists ────────────────────────────────────────────────
        // Reconnected after a drop — repair everything, not just the two lists
        // this effect used to refresh by hand. rehydrateAll is coalesced with
        // the OS-resume trigger, so a wake that fires both runs it once.
        // Friends + pending requests are event-driven only; after the refresh
        // lands, reconcile the unread-friends badge to a FLOOR of the true
        // pending-incoming count: unreadFriends tallies two different event
        // types (new incoming request AND newly-accepted) so it can't be
        // reset to pending_incoming.length exactly without losing the
        // accepted-notification half of what it means — but it must never
        // read LOWER than the number of requests actually waiting, which is
        // exactly the "badge says 0, Friends tab says 3" staleness bug. (This
        // used to be a second, separate GET /friends in the same burst.)
        q.add(async () => {
            await rehydrateAll();
            const pendingCount = (lastFriendsPayloadRef.current?.pending_incoming ?? []).length;
            if (pendingCount > 0 && activeTab !== 'friends') {
                setUnreadFriends(prev => Math.max(prev, pendingCount));
            }
        }, P_LISTS);

        // ── P2: badges ───────────────────────────────────────────────────
        // Server-side read-cursor reconciliation (sleep-resync Phase 4).
        // channelUnreadCounts is otherwise tallied ONLY from live WS events —
        // anything that arrived while the socket was a zombie, or on a
        // different device, has no other path back into it. This asks the
        // server directly instead of trusting the local tally.
        //
        // Reconciled, never reset: a count that changed locally while the
        // request was in flight is left alone (a message may have arrived
        // between this fetch firing and its response landing). Since the
        // multi-device audit it also LOWERS a count the server no longer
        // considers unread (read on another device while this one slept).
        //
        // Mentions can't be computed server-side (E2EE) — for any channel
        // reported unread, reconcileChannelMentions pulls and decrypts just
        // those messages to derive mentions locally (one channel at a time).
        //
        // The recount itself is utils/channelReadSync.reconcileChannelUnread
        // (raises AND lowers); it is run through the paced resync queue, the
        // open server first, one server per task.
        const activeSid = activeServerViewRef.current?.serverId ?? null;
        const ordered = activeSid
            ? [...servers.filter(s => s.server_id === activeSid), ...servers.filter(s => s.server_id !== activeSid)]
            : servers;
        if (token) {
            for (const s of ordered) {
                q.add(() => reconcileServerUnreadRef.current([s.server_id]), P_BADGES);
            }
        }

        // voiceParticipants / huddleCalls (event-driven only) are re-seeded
        // by rehydrateAll above — one batched GET for every joined server.
        // (This effect used to fire the same seed a second time.)

        // ── P3/P4: channels, categories, PERMISSIONS, huddles ────────────
        // For every joined server, not just the active one. Missing this meant
        // a role change during sleep left the client acting on stale
        // permission bits — channels it can no longer see still rendered, ones
        // it gained access to stayed hidden, until something else happened to
        // trigger a refetch. The open server goes first.
        for (const s of ordered) {
            const pr = s.server_id === activeSid ? P_ACTIVE_SERVER : P_REST;
            q.add(() => loadChannels(s.server_id), pr);
            q.add(() => reloadCategories(s.server_id), pr);
            q.add(() => loadMyPermissions(s.server_id), pr);
        }
        // Role editor / member list panes key off this to know their cached
        // role data may be stale.
        setServerRolesRefreshKey(k => k + 1);

        // Huddle calls are re-seeded per huddle channel (no batched read for
        // servers whose API predates the seed's `huddles` field).
        if (token) {
            for (const s of ordered) {
                const huddles = (serverChannels[s.server_id] ?? []).filter(c => c.kind === 'huddle');
                const pr = s.server_id === activeSid ? P_ACTIVE_SERVER : P_REST;
                for (const h of huddles) q.add(() => loadHuddleCalls(h.channel_id), pr);
            }
        }
    }, [wsConnectCount]); // eslint-disable-line react-hooks/exhaustive-deps

    // Track arriving friend requests
    const lastFriendReqEvent = useRef(friendRequestEvent);
    useEffect(() => {
        if (friendRequestEvent && lastFriendReqEvent.current !== friendRequestEvent) {
            lastFriendReqEvent.current = friendRequestEvent;
            setUnreadFriends(prev => prev + 1);
            // Friends tab has no "active chat" concept, always notify if unfocused
            playNotification('friend_request');
        }
    }, [friendRequestEvent, playNotification]);

    // Track friend accepted
    const lastFriendAccEvent = useRef(friendAcceptedEvent);
    useEffect(() => {
        if (friendAcceptedEvent && lastFriendAccEvent.current !== friendAcceptedEvent) {
            lastFriendAccEvent.current = friendAcceptedEvent;
            if (friendAcceptedEvent.requester_id === userId) {
                setUnreadFriends(prev => prev + 1);
                playNotification('friend_accepted');
                // Resolve the name once the refreshed friends list has them
                // (the effect below) — see the first-week nudges.
                pendingAcceptedFriendRef.current = friendAcceptedEvent.recipient_id;
            }
        }
    }, [friendAcceptedEvent, playNotification, userId]);

    // Someone accepted YOUR friend request: tell the first-week nudges (it may
    // offer "<name> is here — say hi"). Waits for the refetched list so the
    // name is real; fires once.
    const pendingAcceptedFriendRef = useRef<string | null>(null);
    useEffect(() => {
        const id = pendingAcceptedFriendRef.current;
        if (!id) return;
        const f = globalFriends?.accepted?.find(x => x.user_id === id);
        if (!f?.username) return;
        pendingAcceptedFriendRef.current = null;
        nudges.notify({ kind: 'friend_joined', username: f.username, userId: id });
    }, [globalFriends, friendAcceptedEvent]);

    // ── First friend, ever ───────────────────────────────────────────────────
    // Fires on the accepted-friends count crossing 0 → ≥1, which is inherently
    // "the first one" and needs no migration for existing accounts: their very
    // first observed count is already ≥1, and prevCount starts null so the
    // initial load can never trigger it. The persisted flag is belt-and-braces
    // so removing every friend and adding one again doesn't re-celebrate.
    const [firstFriendCelebration, setFirstFriendCelebration] = useState(false);
    const prevAcceptedCountRef = useRef<number | null>(null);
    useEffect(() => {
        const accepted = globalFriends?.accepted;
        if (!accepted) return;                        // not loaded yet
        const prev = prevAcceptedCountRef.current;
        prevAcceptedCountRef.current = accepted.length;
        if (prev !== 0 || accepted.length < 1) return;
        if (!userId || !homePersistReadyRef.current) return;
        const key = `cipherline_first_friend_${userId}`;
        try {
            if (secureLocalStore.getItem(key)) return;
            secureLocalStore.setItem(key, '1');
        } catch { return; }                            // can't persist → don't fire
        // The sound is not gated on reduced motion — that preference is about
        // motion, not audio, and `celebration` has its own mute like every
        // other cue. The confetti below is.
        playSound('celebration', notifGlobalPrefsRef.current);
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        setFirstFriendCelebration(true);
    }, [globalFriends, userId]);

    // Fetch friends on mount + any time a friend-relationship WS event fires.
    // Live-updating the globalFriends set is what unblocks avatar rendering
    // for brand-new friends (FriendshipContext derives from `accepted`) and
    // keeps the right-hand profile modal + pending tab fresh without a reload.
    const fetchFriends = useCallback(async () => {
        if (!token) return;
        try {
            // This is the load that hurt most when it failed: globalFriends
            // staying null gates FriendshipContext, which gates avatar
            // rendering app-wide. It used to be `.catch(() => {})` — one lost
            // race at startup and avatars stayed blank all session with nothing
            // logged to say why.
            const res = await fetchWithRetry(
                () => axios.get(`${API_BASE}/friends`, { headers: { Authorization: `Bearer ${token}` } }),
                { onRetry: (_e, n) => console.warn(`[hydrate] friends retry ${n}`) },
            );
            lastFriendsPayloadRef.current = res.data;
            setGlobalFriends(res.data);
        } catch (err) {
            console.error('Failed to fetch friends:', err);
            // Do NOT give up. globalFriends staying null means every other
            // person's avatar is gated off app-wide while the rest of the UI
            // works - the "half loaded" state. Keep trying on a slow cadence
            // until it lands; the gate flips and avatars load by themselves.
            if (friendsRetryTimerRef.current) clearTimeout(friendsRetryTimerRef.current);
            friendsRetryTimerRef.current = setTimeout(() => { friendsRetryTimerRef.current = null; void fetchFriendsRef.current?.(); }, 15_000);
        } finally {
            markSettled('friends');
        }
    }, [token, markSettled]);
    const friendsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (friendsRetryTimerRef.current) clearTimeout(friendsRetryTimerRef.current); }, []);

    useEffect(() => {
        void fetchFriends();
    }, [fetchFriends, friendAcceptedEvent, friendRequestEvent, friendRemovedEvent]);

    // rehydrateAll is declared above both core fetchers, so it reaches them by
    // ref — the same pattern pullMessages already uses for fetchConversations.
    useEffect(() => { fetchFriendsRef.current = fetchFriends; });

    // Close context menus when clicking anywhere
    useEffect(() => {
        const handleClick = () => {
            setContextMenuOpenId(null);
            setGroupMemberContextId(null);
            setSentFriendRequests(new Set());
        };
        document.addEventListener('click', handleClick);
        return () => document.removeEventListener('click', handleClick);
    }, []);

    // AudioContext unlock on user gesture. Chrome / Electron suspend
    // AudioContexts created without a gesture (cold app launch before the
    // user clicks anything); the per-acquire `ctx.resume()` calls can then
    // fail silently and leave incoming audio inaudible until the next time
    // the context happens to resume.
    //
    // Deliberately NOT one-shot: the local mic's voiceProcessor AudioContext
    // (registered via registerCtxForUnlock, see audioUnlock.ts) is often
    // created well AFTER the very first click in the app — e.g. auto-joining
    // a voice channel on launch happens before any click, but so does
    // clicking into the app itself before that join completes. A one-shot
    // listener that already fired and removed itself would miss it, which
    // was exactly how noise suppression went missing until the user left and
    // rejoined a call (the "leave" click was incidentally the first gesture
    // to land after the mic context existed). Redraining a Set of pending
    // contexts on every gesture is cheap — most calls are a no-op state
    // check — so keeping this listener alive for the app's lifetime costs
    // nothing measurable.
    useEffect(() => {
        const onGesture = () => {
            unlockAudioContext();
            unlockPendingContexts();
        };
        document.addEventListener('click', onGesture, { capture: true });
        document.addEventListener('keydown', onGesture, { capture: true });
        return () => {
            document.removeEventListener('click', onGesture, true);
            document.removeEventListener('keydown', onGesture, true);
        };
    }, []);

    // Clear friend unread badging when viewing the friends tab
    useEffect(() => {
        if (activeTab === 'friends') setUnreadFriends(0);
    }, [activeTab]);

    // Clear chat unread badging when clicking on a chat
    useEffect(() => {
        if (activeChat?.id) {
            setUnreadCounts(prev => {
                const next = { ...prev };
                delete next[activeChat.id];
                return next;
            });
        }
    }, [activeChat?.id, userId]);

    // When the window regains focus, clear unread for whichever chat is currently open
    useEffect(() => {
        const handleFocus = () => {
            // The open CHANNEL too (multi-device): messages that arrived while
            // the window was in the background counted as unread here and
            // were never reported read to the server, so the user's other
            // devices kept them unread even after they were looked at.
            const ch = activeChannelRef.current;
            if (ch?.kind === 'text') {
                const chId = ch.channel_id;
                setChannelUnreadCounts(prev => clearCounts(prev, [chId]));
                setChannelMentionCounts(prev => clearCounts(prev, [chId]));
                markChannelReadOnServerRef.current(chId);
            }
            const cId = activeChatRef.current?.id;
            if (!cId) return;
            setUnreadCounts(prev => {
                if (!prev[cId]) return prev; // nothing to clear
                const next = { ...prev };
                delete next[cId];
                return next;
            });
        };
        window.addEventListener('focus', handleFocus);
        return () => window.removeEventListener('focus', handleFocus);
    }, [userId]);

    // Global response interceptor:
    //  - 401: silently refresh the access token and retry the original
    //    request rather than kicking the user to the login screen.
    //  - 429: respect Retry-After (the server emits `Retry-After` for the
    //    default bucket and `Retry-After-message` / `Retry-After-call` for
    //    the named ones; values are SECONDS), wait, and retry once. Waits
    //    longer than 10 s aren't worth holding the request open for — let
    //    the caller's own error handling take it.
    useEffect(() => {
        const interceptorId = axios.interceptors.response.use(
            response => response,
            async (error) => {
                const originalRequest = error.config;
                if (error.response?.status === 401 && !originalRequest._retry) {
                    originalRequest._retry = true;
                    const newToken = await refreshAccessToken();
                    if (newToken) {
                        originalRequest.headers['Authorization'] = `Bearer ${newToken}`;
                        return axios(originalRequest);
                    }
                    // refreshAccessToken() already called logout() internally
                }
                if (error.response?.status === 429 && originalRequest && !originalRequest._retry429) {
                    const h = error.response.headers ?? {};
                    const retryAfterSec = parseInt(
                        h['retry-after'] ?? h['retry-after-message'] ?? h['retry-after-call'] ?? '1',
                        10,
                    );
                    const waitMs = (Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 1) * 1000;
                    if (waitMs <= 10_000) {
                        originalRequest._retry429 = true;
                        await new Promise(resolve => setTimeout(resolve, waitMs));
                        return axios(originalRequest);
                    }
                }
                return Promise.reject(error);
            }
        );
        return () => axios.interceptors.response.eject(interceptorId);
    }, [refreshAccessToken, logout]);

    // Initial load of cached messages across hard refreshes
    useEffect(() => {
        // Async because message history now hydrates in a second, deferred
        // phase (see the await below) — the synchronous reads above it still
        // resolve from phase 1, which completed before first paint.
        let cancelled = false;
        // A new account's history is not in state yet: hold the DM pull
        // (dmHistoryLoadedRef) and drop the previous account's carried batch.
        dmHistoryLoadedRef.current = false;
        unpersistedDmRef.current.clear();
        void (async () => {
        if (userId) {
            // MUST await `whenAccountReady()` FIRST, and re-check
            // `isAccountReady` after it — the same belt-and-braces the
            // sender-warning rehydrate above spells out. Everything read below
            // is per-account, and per-account records are cold right after an
            // explicit sign-in while the store decrypts them under
            // HKDF(master, userId). A cold start never noticed: hydrate() binds
            // the account before React renders. An IN-SESSION sign-in does not,
            // and a read in that window returns null for every key below —
            // conversation list, message history, pins, hidden conversations —
            // which the UI then shows as an account with nothing in it.
            //
            // DELIBERATELY OUTSIDE the try/finally: bailing out here must NOT
            // set `hiddenRestoredRef`. That ref unblocks the hidden-
            // conversations persist effect, and unblocking it on a restore that
            // never read anything is exactly the empty-state-clobbers-storage
            // shape the persist guards exist to prevent. A `finally` that runs
            // on this path would reintroduce it.
            setSavesRestored(false);
            await secureLocalStore.whenAccountReady();
            if (cancelled || !secureLocalStore.isAccountReady(userId)) return;
            try {
                // Conversation list — painted from cache immediately so the
                // home screen has something to render against on a cold
                // start, then reconciled by fetchConversations() when the
                // network round-trip lands. Also makes the list survive a
                // launch with no connectivity. The key is the same one
                // exportLocalHistory/importLocalHistory already round-trip
                // as `topics`, which until now nothing in the UI ever wrote
                // or read.
                const cachedConvs = secureLocalStore.getItem(`cipherline_convs_${userId}`);
                if (cachedConvs) {
                    const parsed = JSON.parse(cachedConvs);
                    if (Array.isArray(parsed) && parsed.length > 0) setConversations(parsed);
                }

                // Message history is hydrated in secureLocalStore's SECOND
                // phase — it's the bulk of the store, and blocking first paint
                // on decrypting it is what made launch feel frozen. By the
                // time this effect runs the shell is already on screen, so
                // awaiting here costs nothing visible. Everything read above
                // (conversation list, settings) came from phase 1 and is
                // already in memory.
                await secureLocalStore.hydrateMessages();

                setMessagesState(await trackActivity('startup:history-load', () => messageStore.loadAll('dm', userId)));
                // The stored history is now queued into state ahead of any
                // pull's update, so pulls may merge on top of it. Pull once
                // right away rather than waiting up to 5 s for the poll. Not
                // for a run the account has already moved on from: that would
                // open the gate before the NEW account's history is loaded.
                if (!cancelled) {
                    dmHistoryLoadedRef.current = true;
                    void pullMessagesRef.current?.();
                }

                // Server channel messages — same shape as DMs, persisted under a
                // sibling localStorage key. Phase Q' brings server channels to
                // full DM parity: local cache is the source of truth, the API
                // is consulted on channel entry only as a catch-up.
                setChannelMessages(await trackActivity('startup:history-load', () => messageStore.loadAll('channel', userId)));

                const hiddenCached = secureLocalStore.getItem(`cipherline_hidden_convs_${userId}`);
                if (hiddenCached) setHiddenConversations(JSON.parse(hiddenCached));

                // notifPrefs is initialised lazily from localStorage with auto-migration from
                // the old `cipherline_muted_convs_*` key — no extra hydration needed here.
                // serverNotifPrefs and channelNotifPrefs also self-initialise lazily.

                const storedPins = secureLocalStore.getItem(`cipherline_pinned_${userId}`);
                if (storedPins) {
                    try { setPinnedMessagesState(JSON.parse(storedPins)); } catch {}
                }

                // LWW ledger for cross-device pin ops. Separate key so the pin
                // map above keeps the exact shape the renderer, the backup
                // vault and sweepRetention already consume.
                const storedLedger = secureLocalStore.getItem(`cipherline_pin_ledger_${userId}`);
                if (storedLedger) {
                    try { pinLedgerRef.current = JSON.parse(storedLedger); } catch {}
                }

                const storedLocalChannelPins = secureLocalStore.getItem(`cipherline_local_channel_pins_${userId}`);
                if (storedLocalChannelPins) {
                    try { setLocalChannelPins(JSON.parse(storedLocalChannelPins)); } catch {}
                }
                const storedChannelLedger = secureLocalStore.getItem(`cipherline_local_channel_pin_ledger_${userId}`);
                if (storedChannelLedger) {
                    try { localChannelPinLedgerRef.current = JSON.parse(storedChannelLedger); } catch { /* corrupt: start with an empty ledger */ }
                }
                // Only here, after all four were read: an earlier throw leaves
                // it false, so sync stays off rather than merging into an
                // empty stand-in for state that failed to load.
                if (!cancelled) setSavesRestored(true);
            } catch (e) {
                console.error('Failed to restore cache', e);
            } finally {
                // Unblocks the hidden-conversations persist effect. In `finally`
                // so a partial restore still lets the user hide/unhide things —
                // staying blocked forever would be a worse failure than
                // re-persisting whatever state we ended up with.
                hiddenRestoredRef.current = true;
            }
        }
        })();
        return () => { cancelled = true; };
    }, [userId]);

    // Persist the conversation list so the next cold start can paint the
    // home screen before the network fetch returns (see the hydrate in the
    // restore effect above). Same empty-clobber guard as the message cache
    // below: an empty array here means "not loaded yet" (initial state, or a
    // failed/offline fetch), never "the user has no conversations", so it
    // must not overwrite a good cache. Leaving every conversation is rare and
    // self-corrects on the next successful non-empty fetch.
    useEffect(() => {
        if (!userId) return;
        if (conversations.length === 0) return;
        try {
            secureLocalStore.setItem(`cipherline_convs_${userId}`, JSON.stringify(conversations));
        } catch { /* quota / serialization — non-fatal */ }
    }, [conversations, userId]);

    // Persist message state sequentially. We persist even when the state is
    // empty (e.g. after a sweep wipes the last conversation) so a stale
    // localStorage entry doesn't reappear on the next launch.
    // Both message caches persist through useCoalescedPersist rather than a
    // plain effect. These are FULL snapshots, so the old effect re-ran
    // `JSON.stringify(entire history)` on the main thread for every single
    // arriving message — O(history) per message, and boot (draining the queued
    // backlog) is exactly when that hurts most. Coalescing writes only the
    // last value of a burst; the hook flushes on unmount/quit/hide so a
    // pending snapshot can't be lost (the local cache is the only copy of a
    // delivered message once the server drops the ACKed envelope).
    //
    // skipEmpty preserves the original guard: messagesState is {} on first
    // mount before the restore effect populates it, and both run in the same
    // commit — persisting {} would wipe the cache before the loaded data could
    // be written back. Intentional clears call removeItem directly.
    const persistDms = useCallback(
        (_k: string, v: Record<string, unknown>) => { if (userId) messageStore.saveAll('dm', userId, v as messageStore.ThreadMap); },
        [userId],
    );
    const persistChannels = useCallback(
        (_k: string, v: Record<string, unknown>) => { if (userId) messageStore.saveAll('channel', userId, v as messageStore.ThreadMap); },
        [userId],
    );
    useCoalescedPersist(userId ? `cipherline_msgs_${userId}` : null, messagesState, { write: persistDms });
    useCoalescedPersist(userId ? `cipherline_channel_msgs_${userId}` : null, channelMessages, { write: persistChannels });

    // Persist hidden conversations sequentially.
    //
    // Gated on the restore effect above having actually run. hiddenConversations
    // starts as [] and is filled in by that effect, but both run in the same
    // commit phase — so this one fires first, with the still-empty initial
    // value, and writes [] over the stored list before the re-render carrying
    // the restored data can write it back. Normally the correct value lands a
    // moment later, but a crash in between permanently unhid everything. Same
    // race the message cache guards against; an empty-array check can't be used
    // here because [] is a legitimate state (unhiding the last conversation
    // must persist), so gate on "has the restore run" instead.
    useEffect(() => {
        if (!userId || !homePersistReadyRef.current || !hiddenRestoredRef.current) return;
        secureLocalStore.setItem(`cipherline_hidden_convs_${userId}`, JSON.stringify(hiddenConversations));
    }, [hiddenConversations, userId]);

    // Persist muted conversations sequentially. notifPrefs is lazily
    // initialised from the store during render (with migration from the old
    // muted-list key), so unlike hiddenConversations it has no restore-effect
    // race — it only needs the locked-store guard.
    useEffect(() => {
        if (!userId || !homePersistReadyRef.current) return;
        secureLocalStore.setItem(`cipherline_notif_prefs_${userId}`, JSON.stringify(notifPrefs));
    }, [notifPrefs, userId]);

    // (Server/channel notif prefs are now persisted in their own effects above)

    // Persist pinned messages (DM / group — local only)
    // Guard: same race as the messagesState persist effect — on first mount
    // pinnedMessagesState is {} before the restore effect runs.  Without the
    // guard the empty initial state overwrites the persisted data.  Safe to
    // skip {} here because unpinning reduces an entry's array to [] (the key
    // stays present), never collapses the whole object back to {}.
    //
    // Once the restore has actually run (`savesRestored`), an empty map IS
    // written: applyPinOp deletes a container whose last pin is removed, so
    // unpinning the only pin produces {} — and skipping that write brought the
    // pin back on the next launch.
    useEffect(() => {
        if (!userId) return;
        if (!savesRestored && Object.keys(pinnedMessagesState).length === 0) return;
        try {
            secureLocalStore.setItem(`cipherline_pinned_${userId}`, JSON.stringify(pinnedMessagesState));
            // Pruned on write so the ledger doesn't accumulate a tombstone for
            // every message ever unpinned; currently-pinned ids are never dropped.
            pinLedgerRef.current = pruneLedger(
                { pins: pinnedMessagesState, ledger: pinLedgerRef.current }, Date.now(), PIN_LEDGER_TTL_MS,
            ).ledger;
            secureLocalStore.setItem(`cipherline_pin_ledger_${userId}`, JSON.stringify(pinLedgerRef.current));
        } catch { /* quota / serialization — non-fatal */ }
    }, [pinnedMessagesState, userId, savesRestored]);

    // Persist local channel pins (no server quota, no permission required)
    // Same guard as above — localChannelPins starts as {} on mount.
    // Written (with its LWW ledger) since channel saves sync between devices.
    useEffect(() => {
        if (!userId) return;
        if (!savesRestored && Object.keys(localChannelPins).length === 0) return;
        try {
            secureLocalStore.setItem(`cipherline_local_channel_pins_${userId}`, JSON.stringify(localChannelPins));
            localChannelPinLedgerRef.current = pruneLedger(
                { pins: localChannelPins, ledger: localChannelPinLedgerRef.current }, Date.now(), PIN_LEDGER_TTL_MS,
            ).ledger;
            secureLocalStore.setItem(`cipherline_local_channel_pin_ledger_${userId}`, JSON.stringify(localChannelPinLedgerRef.current));
        } catch { /* quota / serialization — non-fatal */ }
    }, [localChannelPins, userId, savesRestored]);

    // Background auto-polling for real-time Redis presence TTL indicators 
    useEffect(() => {
        let presenceInterval: ReturnType<typeof setInterval>;

        if (token && conversations.length > 0) {
            const fetchPresence = async () => {
                const userIds = conversations
                    .filter(c => c.other_user_id)
                    .map(c => c.other_user_id);

                if (userIds.length === 0) return;

                try {
                    const res = await axios.get(`${API_BASE}/gateway/presence?user_ids=${userIds.join(',')}`, {
                        headers: { Authorization: `Bearer ${token}` }
                    });
                    setPresence(res.data);
                } catch (err) {
                    console.error('Failed to poll presence', err);
                }
            };

            fetchPresence();
            // 30 s — WS user:status_changed events deliver realtime presence;
            // this poll is only reconciliation for missed events.
            presenceInterval = setInterval(fetchPresence, 30000);
        }

        return () => clearInterval(presenceInterval);
    }, [token, conversations]);

    // Hardening follow-up: removed a dead "M11: silent background vault sync"
    // effect that lived here — it read secureLocalStore key
    // `cipherline_rcv_jwk_${userId}`, which is never written anywhere in the
    // codebase (confirmed via a full-repo grep), so the function always
    // early-returned. The setInterval(…, 60_000) still ran forever on every
    // authenticated session doing nothing. The real backup/history-transfer
    // paths are BackupSection.tsx (local/Drive) and HistoryRequestModal.tsx /
    // HistorySyncBanner.tsx (server-relayed cross-device sync) — this was an
    // orphaned third mechanism, not a needed one.

    // ── Storage retention sweeper ─────────────────────────────────────────────
    // Walks messagesState every 5 minutes. Drops locally-expired messages and
    // clears expired attachments from THIS device's cache (never the server
    // copy: retention is per-device, see ChatPane.performDelete). Runs once on mount,
    // again whenever the topology (conversations / servers / channels) becomes
    // available so cold-start mis-sweeping is corrected immediately, and
    // continuously every 5 minutes after that.
    //
    // Cold-start safety: any conversation/channel whose type or parent server
    // can't be resolved yet is *skipped* rather than swept with a half-resolved
    // policy.  The topology-driven re-fire below picks them up the moment the
    // refs populate.
    /** Set after the first successful pullMessages. Until then the retention
     *  sweep is held off — see the guard inside `run` below. */
    const firstPullDoneRef = useRef(false);
    const sweepRunRef = useRef<(() => Promise<void>) | null>(null);
    useEffect(() => {
        if (!userId || !token) return;
        let cancelled = false;
        const run = () => trackActivity('retention:sweep', async () => {
            if (cancelled) return;
            // Pin freshness: a pin made on another device arrives as an envelope
            // on the next pull. Sweeping before that first pull lands would
            // delete a message this account has pinned elsewhere — permanently,
            // and the arriving pin would then resolve to a tombstone. Same
            // shape as the channel guard that skips a channel whose /pins
            // haven't been fetched yet.
            if (!firstPullDoneRef.current) return;
            // The same for saves/pins that travel in the `personal_saves`
            // slot (channel "Save for me", and every pin for a new or long-
            // offline device): wait until this device has tried to merge them.
            // A sweep before that could delete a message saved elsewhere, and
            // markMessagesPurged then stops it ever coming back.
            if (!savesSyncRef.current.hasPulledOnce()) return;
            // Per-device retention: no sweep until this device has a policy
            // the user chose (or an existing install's). The effect below
            // re-fires the sweep the moment setup completes.
            if (!deviceStorageReadyRef.current) return;
            const allAttachmentsToDelete: string[] = [];

            // 1. Sweep DM/group messages, applying per-conversation retention overrides
            //    where present (stored by ConvRetentionSection under
            //    `cipherline_conv_retention_${userId}_${convId}`).
            const current = messagesStateRef.current;
            const convIdsToSweep = Object.keys(current);
            const conversationsLoaded = conversationsRef.current.length > 0;
            if (convIdsToSweep.length > 0) {
                let anyDmChanged = false;
                const newDmState: Record<string, any[]> = {};

                for (const convId of convIdsToSweep) {
                    const msgs = current[convId];
                    if (!Array.isArray(msgs)) { newDmState[convId] = msgs; continue; }

                    // Resolve effective policy: per-conv override > type default > global.
                    const convInfo = conversationsRef.current.find((c: any) => c.conversation_id === convId);

                    // Cold-start safety: if conversations have loaded but this convId
                    // isn't among them, it's stale local data — let it sweep with default
                    // type 'dm'. But if conversations haven't loaded at all yet, *skip*
                    // this conversation so we don't mis-classify groups as DMs.
                    if (!convInfo && !conversationsLoaded) {
                        newDmState[convId] = msgs;
                        continue;
                    }

                    const convType: 'dm' | 'group' = convInfo?.type === 'group' ? 'group' : 'dm';
                    // per-conversation override > type default > global (a corrupt
                    // or unrecognised override is ignored, never obeyed).
                    const effectivePolicy = convSweepPolicy(retentionPolicyRef.current, convType, convId);

                    // Pin = save forever: include the conversation's pinned IDs so the
                    // sweeper bypasses retention rules for them.
                    const pinnedForConv = new Set(pinnedMessagesStateRef.current[convId] ?? []);
                    const { prunedState: ps, attachmentsToDelete: atd } =
                        sweepRetention(
                            { [convId]: msgs },
                            effectivePolicy,
                            Date.now(),
                            { [convId]: pinnedForConv },
                        );
                    if (atd.length) allAttachmentsToDelete.push(...atd);

                    if (ps[convId] !== msgs) {
                        anyDmChanged = true;
                        newDmState[convId] = ps[convId] ?? [];
                    } else {
                        newDmState[convId] = msgs;
                    }
                }

                if (anyDmChanged) {
                    setMessagesState(newDmState);
                    // Sync localStorage immediately rather than waiting for the persist
                    // useEffect to fire on the next render commit. Guards against data
                    // loss if the user force-quits between sweep and commit.
                    try {
                        messageStore.saveAll('dm', userId, newDmState);
                    } catch { /* quota or serialization — non-fatal, persist effect will retry */ }
                }
            }

            // 2. Sweep server channel messages using per-server retention overrides.
            //    Per-server settings are stored in localStorage by ServerMemberOptionsModal
            //    under `cipherline_server_retention_${userId}_${serverId}`.
            const chMsgs = channelMessagesRef.current;
            const chKeys = Object.keys(chMsgs);
            const serverChannelsLoaded = Object.keys(serverChannelsRef.current).length > 0;
            if (chKeys.length > 0) {
                // Build a channelId → serverId reverse-index from the current serverChannels snapshot.
                const channelToServer: Record<string, string> = {};
                for (const [serverId, chs] of Object.entries(serverChannelsRef.current)) {
                    for (const ch of chs) channelToServer[ch.channel_id] = serverId;
                }

                let anyChChanged = false;
                const newChMsgs: Record<string, any[]> = {};

                for (const channelId of chKeys) {
                    const msgs = chMsgs[channelId];
                    if (!Array.isArray(msgs)) { newChMsgs[channelId] = msgs; continue; }

                    // Cold-start safety: if no server channels are loaded yet, skip every
                    // channel — we'd silently miss every per-server override and apply the
                    // wrong policy. The topology-driven re-fire below picks them up as
                    // soon as `serverChannels` populates.
                    const serverId = channelToServer[channelId];
                    if (!serverId && !serverChannelsLoaded) {
                        newChMsgs[channelId] = msgs;
                        continue;
                    }

                    // Pin-freshness safety: if we've never fetched /pins for this
                    // channel, our `channelServerSaves` set is empty and a sweep
                    // would treat server-pinned messages as un-pinned. Skip the
                    // channel until pins are loaded — the topology re-sweep effect
                    // pre-fetches /pins for every cached channel on startup, so
                    // this is only a one-tick delay in normal operation.
                    if (channelServerSavesRef.current[channelId] === undefined) {
                        newChMsgs[channelId] = msgs;
                        continue;
                    }

                    // per-server override > server type default > global.
                    const effectivePolicy = serverSweepPolicy(retentionPolicyRef.current, serverId);

                    // Pin = save forever. Channels have two pin sources:
                    // localChannelPins (client-only, free) and channelServerSaves
                    // (server-quota-backed, visible to new joiners). Union both —
                    // either type pins the message locally.
                    const pinnedForChannel = pinnedIdsForChannel(
                        localChannelPinsRef.current[channelId],
                        channelServerSavesRef.current[channelId],
                    );
                    const { prunedState: ps, attachmentsToDelete: atd, purgedMessageIds: pmi } =
                        sweepRetention(
                            { [channelId]: msgs },
                            effectivePolicy,
                            Date.now(),
                            { [channelId]: pinnedForChannel },
                        );
                    if (atd.length) allAttachmentsToDelete.push(...atd);
                    // The channel_messages row survives this purge on the
                    // server, so remember the ids or the next history fetch
                    // re-inserts them (foldChannelHistory's `purgedIds`).
                    markMessagesPurged(userId, channelId, pmi[channelId] ?? []);

                    if (ps[channelId] !== msgs) {
                        anyChChanged = true;
                        newChMsgs[channelId] = ps[channelId] ?? [];
                    } else {
                        newChMsgs[channelId] = msgs;
                    }
                }

                if (anyChChanged) {
                    setChannelMessages(newChMsgs);
                    // Same sync-write rationale as DM/group sweep above.
                    try {
                        messageStore.saveAll('channel', userId, newChMsgs);
                    } catch { /* non-fatal */ }
                }
            }

            // Delete all expired attachments gathered from both sweeps.
            if (allAttachmentsToDelete.length) {
                console.log(`[Retention] deleting ${allAttachmentsToDelete.length} expired attachment(s)`);
                markAttachmentsRemovedSafe(allAttachmentsToDelete);
                // Local only: see the note on the other retention purge paths. The
                // server copy is not this device's to remove on a timer.
                const { deleteEncryptedAttachment } = await import('../utils/attachmentCache');
                await Promise.allSettled(allAttachmentsToDelete.map(id => deleteEncryptedAttachment(id)));
            }
            // P2-REND-16: prune stale avatar/icon/banner blobs every sweep cycle.
            const { pruneAvatarCache } = await import('../utils/attachmentCache');
            pruneAvatarCache().catch(() => {});
        });
        sweepRunRef.current = run;
        run();
        const id = setInterval(run, 5 * 60_000);
        return () => {
            cancelled = true;
            clearInterval(id);
            sweepRunRef.current = null;
        };
    // retentionPolicyRef is a ref — reads latest value without re-mounting sweep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userId, token]);

    // Device storage setup just completed (or was adopted for an existing
    // install): run the sweep that was held for it.
    useEffect(() => {
        if (deviceStorage.status === 'done') sweepRunRef.current?.();
    }, [deviceStorage.status]);

    // Sweep when the user COMES BACK, not only on the 5-minute timer. A timer
    // does not tick in a suspended machine, and a hidden window's timers are
    // throttled, so after a sleep or a long minimise the first tick can be
    // minutes away - during which messages already past their window sit in
    // the thread with a "Deletion pending" badge. Throttled to one per 30 s.
    useEffect(() => {
        let last = 0;
        const kick = () => {
            const now = Date.now();
            if (now - last < 30_000) return;
            last = now;
            void sweepRunRef.current?.();
        };
        const onVisible = () => { if (document.visibilityState === 'visible') kick(); };
        window.addEventListener('focus', kick);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            window.removeEventListener('focus', kick);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, []);

    // Sweep soon after ANY retention setting changes (global / per-type
    // default, a per-server or per-conversation override, a save or unsave) so
    // a shortened window takes effect within seconds rather than at the next
    // 5-minute tick. The sweep re-reads every setting itself, so this is just
    // a debounced doorbell. (The first sweep after login is still held by the
    // device-storage gate inside `run`.)
    useEffect(() => {
        // A widened window can bring back rows "Load older history" skipped as
        // expired under the old one, so forget how far it had already looked.
        olderCursorRef.current = {};
        const t = window.setTimeout(() => { void sweepRunRef.current?.(); }, 1500);
        return () => window.clearTimeout(t);
    }, [retention.policy, channelRetentionVersion, convRetentionVersion]);

    // Topology-driven re-sweep: when the conversation list or server channel
    // map populates for the first time after mount, fire the sweep again so
    // any conversations/channels we previously skipped (due to missing
    // type/server info) are now processed with the right policy. Subsequent
    // topology changes (new server joined, channel added) also re-fire — cheap
    // and idempotent thanks to the per-entry skip-on-no-change logic.
    const lastTopologySigRef = useRef('');
    useEffect(() => {
        const sig = `${conversations.length}|${servers.length}|${Object.keys(serverChannels).length}`;
        if (sig === lastTopologySigRef.current) return;
        lastTopologySigRef.current = sig;
        if (!sweepRunRef.current) return;

        // Before re-sweeping, refresh the server-pin set for every channel we
        // have locally cached messages for.  Without this, server-pinned
        // messages added by other admins while the user was online but not
        // viewing the channel would be missed by the sweep's pin check, and
        // the local copy would be wrongly deleted.  The pins endpoint is
        // membership-gated and lightweight (returns IDs only).
        const t = setTimeout(async () => {
            try {
                const cachedChannelIds = Object.keys(channelMessagesRef.current);
                if (token && cachedChannelIds.length > 0) {
                    await Promise.allSettled(cachedChannelIds.map(async (cid) => {
                        try {
                            applyChannelSaveState(cid, await fetchChannelSaveState(API_BASE, cid, token));
                        } catch { /* per-channel failure non-fatal — sweep skips that channel */ }
                    }));
                }
            } finally {
                sweepRunRef.current?.();
            }
        }, 500);
        return () => clearTimeout(t);
    }, [conversations.length, servers.length, serverChannels]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Storage-tab handlers ──────────────────────────────────────────────────
    /**
     * Remove the locally cached bytes of attachments whose messages a manual
     * purge just deleted. Deleting only the message row left the (encrypted)
     * blob in the attachment cache forever - nothing sweeps orphans - so
     * "Purge" / "Clear all" kept every file it claimed to remove. Local only,
     * same as the retention sweep: the server copy is not this device's to
     * delete (ChatPane.performDelete does that for an explicit message delete).
     */
    const dropAttachmentBlobsOf = useCallback(async (dropped: readonly unknown[]) => {
        const ids = [...new Set(dropped.map(attachmentToDeleteWithMessage).filter((x): x is string => !!x))];
        if (!ids.length) return;
        markAttachmentsRemovedSafe(ids);
        const { deleteEncryptedAttachment } = await import('../utils/attachmentCache');
        await Promise.allSettled(ids.map(id => deleteEncryptedAttachment(id)));
    }, [markAttachmentsRemovedSafe]);

    const handleClearAllMessages = useCallback(() => {
        if (!userId) return;
        const everything = Object.values(messagesStateRef.current).flatMap(t => (Array.isArray(t) ? t : []));
        setMessagesState({});
        try {
            messageStore.clearAll('dm', userId);
        } catch {}
        void dropAttachmentBlobsOf(everything);
    }, [userId, dropAttachmentBlobsOf]);

    const handlePurgeConversation = useCallback((convId: string, olderThanMs: number) => {
        const now = Date.now();
        const isKept = (m: any): boolean => {
            if (olderThanMs === 0) return false;
            if (m._pending) return true;
            const t = m?.timestamp ?? m?.sent_at ?? m?.created_at ?? m?.received_at ?? null;
            let ts = typeof t === 'number' ? t : (t ? Date.parse(t) : Date.now());
            if (!Number.isFinite(ts)) ts = Date.now();
            return (now - ts) < olderThanMs;
        };
        const current = messagesStateRef.current[convId];
        if (!current) return;
        void dropAttachmentBlobsOf(current.filter(m => !isKept(m)));
        setMessagesState(prev => {
            const messages = prev[convId];
            if (!messages) return prev;
            return { ...prev, [convId]: messages.filter(isKept) };
        });
    }, [dropAttachmentBlobsOf]);

    const handleLock = async () => {
        logout();
    };

    const fetchConversations = useCallback(async () => {
        if (!token) return;
        try {
            // Retried: a single failure here used to leave the sidebar empty
            // until the user refreshed, and losing the cold-start race with the
            // API coming up is the common way that happened.
            const res = await fetchWithRetry(() => axios.get(`${API_BASE}/conversations`, {
                headers: { Authorization: `Bearer ${token}` }
            }), { onRetry: (_e, n) => console.warn(`[hydrate] conversations retry ${n}`) });
            setConversations(labelSelfConversations(res.data, authUserId));
            
            // Auto-sync missing avatar keys to any new DMs (only after key bundle is on server)
            if (bundleReady) broadcastCurrentAvatar(res.data);
        } catch (err) {
            console.error('Failed to fetch conversations:', err);
        } finally {
            // Settled either way — an exhausted load must still open the gate,
            // or a persistent failure would hold the user on a skeleton forever.
            markSettled('conversations');
        }
    }, [token, broadcastCurrentAvatar, bundleReady, markSettled, authUserId]);

    useEffect(() => { fetchConversationsRef.current = fetchConversations; });

    // Load the conversation list on mount, not just when the DMs/Groups tabs
    // are open. This used to be gated on `activeTab === 'dms' || 'groups'`,
    // which worked only because the app booted on 'dms' — the Home Screen
    // (96e2efa) changed the default tab to 'home' and updated the render
    // gates but not this fetch gate, so on a cold start nothing ever fetched
    // and every home-screen section (pinned convs, "Pick back up", unread
    // totals) rendered against an empty array until the user clicked into
    // DMs or Groups. Servers already load unconditionally on mount
    // (useServers.ts) — this brings conversations in line.
    const didInitialConvFetchRef = useRef(false);
    useEffect(() => {
        // Fetch once on mount no matter which tab we land on, then keep the
        // original refresh-on-entering-DMs/Groups behaviour. The ref keeps
        // this from firing on every unrelated tab switch (files, calendar,
        // servers…), which a bare unconditional fetch here would do.
        if (!didInitialConvFetchRef.current || activeTab === 'dms' || activeTab === 'groups') {
            didInitialConvFetchRef.current = true;
            fetchConversations();
        }
    }, [activeTab, fetchConversations]);

    // Handle friend acceptance: refresh conversations and broadcast our own avatar key
    useEffect(() => {
        if (friendAcceptedEvent && userId && deviceId) {
            const otherUserId = friendAcceptedEvent.requester_id === userId
                ? friendAcceptedEvent.recipient_id 
                : friendAcceptedEvent.requester_id;
            
            // Proactively build the E2EE tunnel (create the DM)
            axios.post(`${API_BASE}/conversations/dm`, { other_user_id: otherUserId }, {
                headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId }
            }).then((apiRes) => {
                // To guarantee we re-send our avatar if they were removed and re-added, we clear our 'sent' memory for this DM tunnel:
                if (apiRes.data?.conversation_id) {
                    secureLocalStore.removeItem(`sent_avatar_${userId}_${apiRes.data.conversation_id}`);
                }
                
                // Instantly re-fetch. This will trigger broadcastCurrentAvatar() and push our key!
                fetchConversations();
            }).catch(console.error);
        }
    }, [friendAcceptedEvent, fetchConversations, userId, deviceId, token]);

    // Real-time avatar update — propagate the new attachment_id to every
    // state surface that displays this user's avatar. Previous iterations
    // missed activeChat / dmPartnerProfile / globalFriends, leaving the
    // chat header, right-side profile section, and friends-pane tiles
    // showing stale images even after the WS event arrived.
    useEffect(() => {
        if (!avatarUpdatedEvent) return;
        const { user_id, avatar_url: newAttachmentId } = avatarUpdatedEvent;

        // 1. DM conversation list (sidebar tiles).
        setConversations(prev => prev.map(c =>
            c.type === 'dm' && c.other_user_id === user_id
                ? { ...c, avatar_url: newAttachmentId }
                : c
        ));
        // 2. activeChat — this is what the chat header reads from for both
        //    DMs (peer's avatar) and groups (your member-row in headers that
        //    show member avatars). Without this patch the chat header stays
        //    stale until the user navigates away and back.
        setActiveChat(prev => {
            if (!prev) return prev;
            if (prev.type === 'dm' && prev.other_user_id === user_id) {
                return { ...prev, avatar_url: newAttachmentId };
            }
            return prev;
        });
        // 3. Right-hand profile panel (DM partner). dmPartnerProfile is the
        //    object backing the right-panel profile preview — name, bio,
        //    banner, and avatar — none of which are reactive to other state
        //    changes. Patch here when the visible partner changes their pic.
        setDmPartnerProfile(prev => {
            if (!prev) return prev;
            // The dmPartnerProfile entry has no user_id field directly — we
            // gate on activeChat at fetch time. Match by checking the active
            // chat's other_user_id equals the event's user_id.
            if (activeChat?.type === 'dm' && activeChat.other_user_id === user_id) {
                return { ...prev, avatar_url: newAttachmentId };
            }
            return prev;
        });
        // 4. Group members panel (right-hand panel).
        setGroupMembers(prev => prev.map(m =>
            m.user_id === user_id ? { ...m, avatar_url: newAttachmentId } : m
        ));
        // 5. globalFriends — friends-pane tiles, group-create selector, etc.
        //    Patch in place for instant feedback. Followed by a fetch only
        //    if we don't have an entry yet (i.e. someone became a friend
        //    while we were already running and they just changed avatar).
        setGlobalFriends(prev => {
            if (!prev) return prev;
            const accepted = prev.accepted.map((f: any) =>
                f.user_id === user_id ? { ...f, avatar_url: newAttachmentId } : f
            );
            return { ...prev, accepted };
        });
        // 6. If the event is for us, refresh our own profile in AuthContext
        //    so every place that reads `user.avatar_url` directly (status
        //    picker, settings preview, the My Profile tab) updates too.
        if (user_id === userId) {
            refreshProfile().catch(() => { /* not fatal */ });
        }
    }, [avatarUpdatedEvent]);

    // Real-time username change — the sibling of the avatar handler above, and
    // it patches the same surfaces for the same reason. A DM conversation's
    // `title` IS the partner's username (the server denormalises it into
    // GET /conversations), so without this a renamed friend kept their old
    // handle on the sidebar row and the chat header for the whole session.
    useEffect(() => {
        if (!usernameUpdatedEvent) return;
        const { user_id, username } = usernameUpdatedEvent;

        // 0. The session peer-identity cache, which seeds ChatPane's author
        //    name maps at mount. Without this the next chat switch would seed
        //    the OLD handle straight back over the live patches below — the
        //    cache must never be staler than the state it exists to prefill.
        //    (ChatPane does the same for `avatar:updated`, which is a prop it
        //    owns; this event is only ever handled here.)
        rememberUserName(user_id, username);

        // 1. DM conversation list (sidebar tiles) — title is the partner's name.
        // Your own row (the self conversation) keeps its "(You)" label.
        const patchedTitle = user_id === authUserId ? selfConversationTitle(username) : username;
        setConversations(prev => prev.map(c =>
            c.type === 'dm' && c.other_user_id === user_id
                ? { ...c, title: patchedTitle }
                : c
        ));
        // 2. activeChat — backs the chat header.
        setActiveChat(prev => {
            if (!prev) return prev;
            if (prev.type === 'dm' && prev.other_user_id === user_id) {
                return { ...prev, title: patchedTitle };
            }
            return prev;
        });
        // 3. Group members panel (right-hand panel).
        setGroupMembers(prev => prev.map(m =>
            m.user_id === user_id ? { ...m, username } : m
        ));
        // 4. globalFriends — friends-pane tiles, group-create selector, the
        //    DM context menu's friend lookup.
        setGlobalFriends(prev => {
            if (!prev) return prev;
            const accepted = prev.accepted.map((f: any) =>
                f.user_id === user_id ? { ...f, username } : f
            );
            return { ...prev, accepted };
        });
        // 5. If it's us, refresh AuthContext so every surface reading
        //    `user.username` directly (settings, profile card) follows.
        if (user_id === userId) {
            refreshProfile().catch(() => { /* not fatal */ });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [usernameUpdatedEvent]);

    useEffect(() => {
        if (!token || !deviceId) return;
        pullMessages(); // pull immediately on mount
        const interval = setInterval(pullMessages, 5000); // fallback poll every 5s
        return () => clearInterval(interval);
    }, [token, deviceId, pullMessages]);

    /**
     * Push a pin/unpin to this user's OTHER devices.
     *
     * The device list for a conversation contains every member's devices, so
     * this filters to our own user before wrapping — a pin is a private
     * bookmark, and without the filter the envelope would also reach the
     * person we're talking to. `encryptAndAddress` returns exactly the ids it
     * wrapped (RC-2), so the recipient list can't drift from the ciphertext.
     *
     * Best-effort by design: a failure here must never block the local pin,
     * which has already been applied by the caller.
     */
    const broadcastPinOp = React.useCallback(async (op: PinOp) => {
        if (!token || !deviceId || !userId) return;
        try {
            // claim_otp=1: consume a one-time prekey per recipient device (per-message forward secrecy)
            const devicesRes = await axios.get(
                `${API_BASE}/conversations/${op.container_id}/devices?claim_otp=1`,
                { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } },
            );
            if (!Array.isArray(devicesRes.data)) return;
            const myDevices = (devicesRes.data as { device_id: string; spk_pub_b64: string; user_id: string }[])
                // `device_id !== deviceId`: in a self conversation the roster includes
                // THIS device (so a one-device user can still encrypt a message); a pin
                // op has no use for that copy, so it never addresses the sender itself.
                .filter(d => d.user_id === userId && d.device_id !== deviceId);
            // Single-device account: nothing to sync to. Don't post an
            // envelope addressed to nobody.
            if (myDevices.length === 0) return;

            const content = {
                client_msg_id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `pin-${op.at}`,
                type: 'pin' as const,
                conversation_id: op.container_id,
                target_id: op.target_id,
                action: op.action,
                at: op.at,
            };
            const { ciphertext_b64, recipient_device_ids } = await encryptAndAddress(
                JSON.stringify(content), userId, myDevices, deviceId ?? undefined,
            );
            if (recipient_device_ids.length === 0) return;
            await axios.post(
                `${API_BASE}/messages/send`,
                {
                    conversation_id: op.container_id,
                    recipient_device_ids,
                    envelope_type: 'signal_chat',
                    ciphertext_b64,
                    sent_at_client: new Date().toISOString(),
                },
                { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } },
            );
        } catch (e) {
            console.warn('[Pins] Failed to sync pin to other devices:', e);
        }
    }, [token, deviceId, userId]);

    /** Apply a pin op locally (through the LWW resolver, so our own change is
     *  recorded in the ledger and a stale remote op can't undo it). */
    const applyPinLocally = React.useCallback((op: PinOp) => {
        setPinnedMessagesState(prevPins => {
            const next = applyPinOp({ pins: prevPins, ledger: pinLedgerRef.current }, op);
            pinLedgerRef.current = next.ledger;
            return next.pins;
        });
    }, []);

    const handlePinMessage = React.useCallback((convId: string, msgId: string) => {
        const op = localPinOp(convId, msgId, 'add', Date.now(), pinLedgerRef.current);
        applyPinLocally(op);
        void broadcastPinOp(op);
        savesSync.markDirty();
        // 'pinned' ("Anchor") — confirmation of your own action, so it fires
        // here rather than off channel:pins_changed. That event is broadcast
        // to everyone who can see the channel and covers unpins too, so
        // hanging the cue on it would ring for other people's housekeeping.
        // handleUnpinMessage stays silent: removing a pin is not an event
        // worth a sound.
        playSound('pinned', notifGlobalPrefsRef.current);
    }, [applyPinLocally, broadcastPinOp, savesSync]);

    const handleUnpinMessage = React.useCallback((convId: string, msgId: string) => {
        const op = localPinOp(convId, msgId, 'remove', Date.now(), pinLedgerRef.current);
        applyPinLocally(op);
        void broadcastPinOp(op);
        savesSync.markDirty();
    }, [applyPinLocally, broadcastPinOp, savesSync]);
    // Publish to handleUnpinMessageRef (declared far above, before this
    // function exists) so the DM pull loop can unpin a personally-pinned
    // message a delete just removed. See that ref's own comment.
    useEffect(() => { handleUnpinMessageRef.current = handleUnpinMessage; });

    /**
     * Channel "Save for me" — the personal, private half of a channel save,
     * synced to this account's other devices (never to anyone else) through the
     * `personal_saves` slot. Driven from the channel ChatPane's existing Save
     * action via `channelRetention` below, so the one gesture is both the
     * keep-forever retention save it always was AND the synced bookmark mobile
     * shows under "Saved for you".
     */
    const handlePersonalChannelSave = React.useCallback((channelId: string, msgId: string, action: 'add' | 'remove') => {
        const op = localPinOp(channelId, msgId, action, Date.now(), localChannelPinLedgerRef.current);
        setLocalChannelPins(prev => {
            const next = applyPinOp({ pins: prev, ledger: localChannelPinLedgerRef.current }, op);
            localChannelPinLedgerRef.current = next.ledger;
            return next.pins;
        });
        savesSync.markDirty();
    }, [savesSync]);
    // Publish to handlePersonalChannelSaveRef (declared far above, before this
    // function exists) so the live channel-message handler and the channel
    // history catch-up merge can unpin a personally-saved message a delete
    // just removed. See that ref's own comment.
    useEffect(() => { handlePersonalChannelSaveRef.current = handlePersonalChannelSave; });

    // The channel ChatPane's retention, with this account's channel saves from
    // other devices overlaid and its Save/Unsave fanned out as a personal save.
    const activeChannelId = activeChannel?.channel_id ?? null;
    const channelRetention = useMemo(() => {
        if (!activeChannelId) return retention;
        const saved = localChannelPins[activeChannelId] ?? [];
        const msgs: { id?: string; content?: { type?: string; attachment_id?: string } }[] = channelMessages[activeChannelId] ?? [];
        return withPersonalChannelSaves(retention, {
            savedMessageIds: saved,
            savedAttachmentIds: attachmentIdsOf(msgs, saved),
            messageIdForAttachment: (attId) =>
                msgs.find(m => m?.content?.type === 'attachment' && m.content.attachment_id === attId)?.id,
            onToggle: (msgId, action) => handlePersonalChannelSave(activeChannelId, msgId, action),
        });
    }, [retention, activeChannelId, localChannelPins, channelMessages, handlePersonalChannelSave]);

    // Opening a surface that shows saves is a moment the user wants them fresh.
    useEffect(() => {
        if (activeChannelId || pinnedSidebarExpanded) savesSync.syncSoon();
    }, [activeChannelId, pinnedSidebarExpanded, savesSync]);

    /** Attachment ids a channel message carries — the server can't read the
     *  encrypted body, so a save/pin declares them (they're then protected
     *  from the attachment sweep and charged to the quota). */
    const channelAttachmentIdsOf = React.useCallback((channelId: string, msgId: string): string[] => {
        const msg = (channelMessages[channelId] || []).find(m => m.id === msgId);
        return msg?.content?.type === 'attachment' && msg.content.attachment_id
            ? [msg.content.attachment_id]
            : [];
    }, [channelMessages]);

    const toastQuotaExceeded = React.useCallback((data: { limit_bytes?: number; storage_plan?: string } | undefined) => {
        console.warn('[ServerSave] Quota exceeded:', data);
        toast.push({ kind: 'error', title: 'Storage Limit', message: quotaExceededMessage(data) });
    }, [toast]);

    /**
     * Pin a channel message — POST /v1/channels/:cid/pins/:mid. Requires
     * MANAGE_MESSAGES. Pinning ALSO server-saves (every pinned message is
     * saved), so it counts toward the server's storage quota unless the
     * message was already saved. (Formerly `handleServerSaveChannel`, back
     * when pin and save were one action.)
     */
    const handleServerPinChannel = React.useCallback(async (channelId: string, msgId: string) => {
        if (!token) return;
        const wasSaved = (channelServerSavesRef.current[channelId] ?? []).includes(msgId);
        // Optimistic: pinned, and therefore saved.
        setChannelPinnedIds(prev => ({ ...prev, [channelId]: withId(prev[channelId], msgId) }));
        setChannelServerSaves(prev => ({ ...prev, [channelId]: withId(prev[channelId], msgId) }));
        try {
            await axios.post(`${API_BASE}/channels/${channelId}/pins/${msgId}`,
                { attachment_ids: channelAttachmentIdsOf(channelId, msgId) },
                { headers: { Authorization: `Bearer ${token}` } });
            if (!wasSaved) setStorageRefreshKey(k => k + 1);
        } catch (err: unknown) {
            const res = asSaveRequestError(err).response;
            // Roll back — the save too, but only if this pin was what added it.
            setChannelPinnedIds(prev => ({ ...prev, [channelId]: withoutId(prev[channelId], msgId) }));
            if (!wasSaved) setChannelServerSaves(prev => ({ ...prev, [channelId]: withoutId(prev[channelId], msgId) }));
            if (res?.data?.code === 'STORAGE_QUOTA_EXCEEDED') toastQuotaExceeded(res.data);
            else console.error('[ServerPin] pin failed:', err);
        }
    }, [token, channelAttachmentIdsOf, toastQuotaExceeded]);

    /** Unpin a channel message. It STAYS server-saved (no quota change) —
     *  removing it from the server is a separate "Remove from server". */
    const handleServerUnpinChannel = React.useCallback(async (channelId: string, msgId: string) => {
        if (!token) return;
        setChannelPinnedIds(prev => ({ ...prev, [channelId]: withoutId(prev[channelId], msgId) }));
        try {
            await axios.delete(`${API_BASE}/channels/${channelId}/pins/${msgId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
        } catch (err) {
            // Roll back: the server still says it's pinned.
            setChannelPinnedIds(prev => ({ ...prev, [channelId]: withId(prev[channelId], msgId) }));
            console.error('[ServerPin] unpin failed:', err);
        }
    }, [token]);

    /**
     * Save a channel message to the server WITHOUT pinning it — POST
     * /v1/channels/:cid/saves/:mid. Requires SAVE_MESSAGES. The message then
     * never expires (instead of being deleted 30 days after it was sent) and
     * counts toward the server's storage quota. Shows the amber Archive icon.
     */
    const handleServerSaveChannel = React.useCallback(async (channelId: string, msgId: string) => {
        if (!token) return;
        setChannelServerSaves(prev => ({ ...prev, [channelId]: withId(prev[channelId], msgId) }));
        try {
            await axios.post(`${API_BASE}/channels/${channelId}/saves/${msgId}`,
                { attachment_ids: channelAttachmentIdsOf(channelId, msgId) },
                { headers: { Authorization: `Bearer ${token}` } });
            setStorageRefreshKey(k => k + 1);
        } catch (err: unknown) {
            const res = asSaveRequestError(err).response;
            const code = res?.data?.code;
            // Already saved (e.g. by someone else a moment ago) — the optimistic
            // state is right; keep it rather than flicker it off.
            if (code === 'ALREADY_SAVED') return;
            setChannelServerSaves(prev => ({ ...prev, [channelId]: withoutId(prev[channelId], msgId) }));
            if (code === 'STORAGE_QUOTA_EXCEEDED') toastQuotaExceeded(res?.data);
            else if (res?.status === 403) toast.push({ kind: 'error', message: "You don't have permission to save messages to the server in this channel." });
            else console.error('[ServerSave] save failed:', err);
        }
    }, [token, channelAttachmentIdsOf, toastQuotaExceeded, toast]);

    /** Remove a server save. The message goes back to expiring 30 days after
     *  it was sent, and its quota is freed. The API refuses (409
     *  MESSAGE_PINNED) while the message is pinned — the UI never offers it
     *  then, but a pin by someone else can land first. */
    const handleServerUnsaveChannel = React.useCallback(async (channelId: string, msgId: string) => {
        if (!token) return;
        setChannelServerSaves(prev => ({ ...prev, [channelId]: withoutId(prev[channelId], msgId) }));
        try {
            await axios.delete(`${API_BASE}/channels/${channelId}/saves/${msgId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            setStorageRefreshKey(k => k + 1);
        } catch (err: unknown) {
            // Roll back: the server still says it's saved.
            setChannelServerSaves(prev => ({ ...prev, [channelId]: withId(prev[channelId], msgId) }));
            if (asSaveRequestError(err).response?.data?.code === 'MESSAGE_PINNED') {
                // Someone pinned it meanwhile — reflect that, and say why.
                setChannelPinnedIds(prev => ({ ...prev, [channelId]: withId(prev[channelId], msgId) }));
                toast.push({ kind: 'error', message: 'This message is pinned. Unpin it first to remove it from the server.' });
            } else {
                console.error('[ServerSave] unsave failed:', err);
            }
        }
    }, [token, toast]);

    // handleLocalPinChannel / handleLocalUnpinChannel were removed when channel
    // pins became server-backed and shared — see the ChatPane wiring below. The
    // `localChannelPins` STATE is deliberately kept: it's still loaded from
    // storage and unioned into the retention sweep, so messages a user pinned
    // under the old client-only scheme keep their local retention exemption
    // instead of being swept the first time they open the app after updating.
    // Nothing writes to it any more.

    const handleOptimisticMessage = React.useCallback((m: any) => {
        if (isUserAuthoredContentType(m?.content?.type)) nudges.notify({ kind: 'message_sent' });
        setHiddenConversations(prev => prev.includes(m.conversation_id) ? prev.filter(id => id !== m.conversation_id) : prev);
        // Computed BEFORE the setMessagesState updater below, against
        // messagesStateRef (the same pre-update snapshot the pull loop uses at
        // its own deletedDmTargets call above). A value assigned INSIDE a
        // setState updater and read right after the setState call is not
        // reliable: React does not guarantee the updater runs synchronously
        // during this call (React 19 in particular), so the outer variable can
        // still be null when read. The updater below stays pure.
        const deletedTargetId = deletedDmTargets(
            messagesStateRef.current,
            { [m.conversation_id]: [m] },
        )[0]?.targetId ?? null;
        setMessagesState(prev => {
            const next = { ...prev };
            const cId = m.conversation_id;
            let currentThread = [...(next[cId] || [])];

            if (m.content?.type === 'edit') {
                const targetIdx = currentThread.findIndex(t => t.id === m.content.target_id);
                if (targetIdx !== -1) {
                    currentThread[targetIdx] = {
                        ...currentThread[targetIdx],
                        content: { ...currentThread[targetIdx].content, text: m.content.text },
                        edited: true
                    };
                }
            } else if (m.content?.type === 'delete') {
                const targetIdx = currentThread.findIndex(t => t.id === m.content.target_id);
                if (targetIdx !== -1) {
                    currentThread.splice(targetIdx, 1);
                }
            } else if (m.content?.type === 'reaction') {
                const targetIdx = currentThread.findIndex(t => t.id === m.content.target_id);
                if (targetIdx !== -1) {
                    const msg = currentThread[targetIdx];
                    const reactions = { ...(msg.reactions || {}) };
                    const rKey = m.content.emoji;
                    let rList = Array.isArray(reactions[rKey]) ? reactions[rKey] : [];

                    if (m.content.action === 'add') {
                        if (!rList.includes(m.sender_device_id)) {
                            rList = [...rList, m.sender_device_id];
                        }
                    } else {
                        rList = rList.filter((id: string) => id !== m.sender_device_id);
                    }

                    if (rList.length === 0) {
                        delete reactions[rKey];
                    } else {
                        reactions[rKey] = rList;
                    }

                    currentThread[targetIdx] = { ...msg, reactions };
                }
            } else {
                if (!currentThread.find(t => t.id === m.id)) {
                    currentThread.push(m);
                }
            }
            next[cId] = currentThread;
            return next;
        });

        // Deleting your own personally-pinned DM/group message unpins it on
        // every one of your devices — the sender-side mirror of the server's
        // removePinForDeletedMessage cleanup for channel pins.
        // pinnedMessagesStateRef always holds this user's OWN pins, so this
        // only fires when the deleted message was actually pinned by the
        // viewer, never for someone else's message.
        if (deletedTargetId && pinnedMessagesStateRef.current[m.conversation_id]?.includes(deletedTargetId)) {
            handleUnpinMessage(m.conversation_id, deletedTargetId);
        }
    }, [handleUnpinMessage]);

    // Continuity — self-read sync: a message read on ANOTHER of this
    // account's devices (phone, another desktop) arrives here as
    // `selfReadEvent` (see useRealtime.ts's isSelfReadEvent — the server now
    // includes the reader's own other devices in message:read's broadcast
    // specifically for this). Clears this conversation's badge exactly the
    // way opening it locally does (handleStartChat below) — reading is
    // reading, regardless of which device did it; without this a message
    // read on the phone leaves the desktop badge lit until something else
    // happens to refresh it. Guarded the same way as that clear (only
    // updates state — and only re-renders — when there's actually a nonzero
    // count to drop), so a repeat/idempotent event (the server's exclusion
    // of the reporting device is best-effort, not guaranteed) is a no-op.
    useEffect(() => {
        if (!selfReadEvent) return;
        const { conversation_id } = selfReadEvent;
        setUnreadCounts(prev => prev[conversation_id] ? { ...prev, [conversation_id]: 0 } : prev);
        setMentionCounts(prev => prev[conversation_id] ? { ...prev, [conversation_id]: 0 } : prev);
        // A channel ChatPane reports reads through the same event with the
        // CHANNEL id as conversation_id, and the server relays it to our own
        // devices — so an older API that has no `channel:read` yet still
        // clears the channel badge here. Ids never collide (both are UUIDs of
        // different tables), so this is a no-op for a DM id.
        setChannelUnreadCounts(prev => clearCounts(prev, [conversation_id]));
        setChannelMentionCounts(prev => clearCounts(prev, [conversation_id]));
    }, [selfReadEvent]);

    // `channel:read` — one of THIS user's other devices read a channel
    // (POST /channels/:cid/read; the server tells only our own sockets).
    // Clears the badge exactly the way opening the channel here does. Drained
    // as a queue: several channels read in a row on the phone can land in one
    // React batch. Multi-device audit 2026-10-03, utils/channelReadSync.ts.
    useEffect(() => {
        if (channelReadEvents.length === 0) return;
        const ids = channelReadEvents.map(e => e.channel_id);
        setChannelReadEvents([]);
        setChannelUnreadCounts(prev => clearCounts(prev, ids));
        setChannelMentionCounts(prev => clearCounts(prev, ids));
    }, [channelReadEvents, setChannelReadEvents]);

    const handleStartChat = (chat: { id: string, title?: string, type?: string, other_user_id?: string, avatar_url?: string }) => {
        setActiveChat(chat);
        setActiveChannel(null); // Clear channel selection when switching to DM/group
        // Navigate to correct tab based on chat type
        setActiveTab(chat.type === 'group' ? 'groups' : 'dms');
        setHiddenConversations(prev => prev.includes(chat.id) ? prev.filter(id => id !== chat.id) : prev);
        // Clear unread + mention badges when opening the conversation
        setUnreadCounts(prev => prev[chat.id] ? { ...prev, [chat.id]: 0 } : prev);
        setMentionCounts(prev => prev[chat.id] ? { ...prev, [chat.id]: 0 } : prev);
        setPinnedSidebarExpanded(false);
        setChatSearch('');
        // Persist the last-opened conversation per type so the nav icon can
        // jump straight back to it next time the tab is clicked.
        if (userId) {
            const key = chat.type === 'group'
                ? `cipherline_last_group_${userId}`
                : `cipherline_last_dm_${userId}`;
            try { secureLocalStore.setItem(key, chat.id); } catch {}
        }
    };

    /**
     * Idempotent "open DM" — checks the local list first; if not found calls
     * POST /conversations/dm (which always returns the existing conversation if
     * one exists), refreshes the list, then navigates to it. Replaces the
     * stale-cache `handleStartChat({ id: ex ? ex.conversation_id : userId })` pattern.
     */
    const openDMWithUser = React.useCallback(async (
        userId: string,
        title: string,
        avatarUrl?: string,
    ) => {
        // Fast path: already in local state.
        const existing = conversations.find(c => c.type === 'dm' && c.other_user_id === userId);
        if (existing) {
            handleStartChat({ id: existing.conversation_id, title: existing.title || title, type: 'dm', other_user_id: userId, avatar_url: existing.avatar_url ?? avatarUrl });
            return;
        }
        // Slow path: create or fetch via idempotent endpoint.
        try {
            const res = await axios.post(
                `${API_BASE}/conversations/dm`,
                { other_user_id: userId },
                { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } },
            );
            const convId: string = res.data.conversation_id;
            const convTitle: string = res.data.title ?? title;
            const convAvatar: string | undefined = res.data.avatar_url ?? avatarUrl;
            // Refresh sidebar so the new DM appears.
            try {
                const convsRes = await axios.get(`${API_BASE}/conversations`, { headers: { Authorization: `Bearer ${token}` } });
                setConversations(labelSelfConversations(convsRes.data, authUserId));
            } catch { /* non-critical */ }
            handleStartChat({ id: convId, title: convTitle, type: 'dm', other_user_id: userId, avatar_url: convAvatar });
        } catch (e) {
            console.error('[Dashboard] openDMWithUser failed:', e);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conversations, token, deviceId]);

    /**
     * Resolves which conversation to open when the user clicks the DMs or
     * Groups nav icon.
     *
     * Priority:
     *   1. Last conversation the user explicitly opened of this type
     *      (persisted in localStorage across sessions).
     *   2. Most recently active conversation of this type
     *      (highest last-message timestamp, same ordering as the sidebar list).
     *
     * Returns null if there are no conversations of this type yet.
     */
    const resolveNavChat = (type: 'dm' | 'group') => {
        const pool = conversations.filter(c => c.type === type && !hiddenConversations.includes(c.conversation_id));
        if (pool.length === 0) return null;

        // 1. Remembered last conversation
        if (userId) {
            const key = type === 'group' ? `cipherline_last_group_${userId}` : `cipherline_last_dm_${userId}`;
            try {
                const savedId = secureLocalStore.getItem(key);
                if (savedId) {
                    const remembered = pool.find(c => c.conversation_id === savedId);
                    if (remembered) return remembered;
                }
            } catch {}
        }

        // 2. Most recently messaged fallback
        return [...pool].sort((a, b) => {
            const lastA = (messagesState[a.conversation_id] || []).slice(-1)[0];
            const lastB = (messagesState[b.conversation_id] || []).slice(-1)[0];
            const tA = lastA ? new Date(lastA.sent_at_client || lastA.timestamp || lastA.received_at_server).getTime() : new Date(a.created_at).getTime();
            const tB = lastB ? new Date(lastB.sent_at_client || lastB.timestamp || lastB.received_at_server).getTime() : new Date(b.created_at).getTime();
            return tB - tA;
        })[0] ?? null;
    };

    // Fulfil a pending DM/Group auto-select once resolveNavChat can actually
    // return something — i.e. once `conversations` has loaded. Set by the
    // DMs/Groups rail-icon click handlers in Pane 1; see pendingNavSelect's
    // declaration above for why this needs to be an effect (retries as data
    // arrives) rather than a one-shot check at click time.
    //
    // Bails if the user has since left the tab this was meant for, or
    // already has a conversation of the right type open — re-clicking the
    // icon, or manually picking a conversation while the fetch was still in
    // flight, shouldn't yank them somewhere else once it lands.
    useEffect(() => {
        if (!pendingNavSelect) return;
        if (activeTab !== (pendingNavSelect === 'dm' ? 'dms' : 'groups')) { setPendingNavSelect(null); return; }
        if (activeChat && activeChat.type === pendingNavSelect) { setPendingNavSelect(null); return; }
        const target = resolveNavChat(pendingNavSelect);
        if (!target) return; // nothing of this type yet (or ever) — stay pending, re-checked as conversations loads
        handleStartChat({ id: target.conversation_id, title: target.title, type: target.type, other_user_id: target.other_user_id, avatar_url: target.avatar_url });
        setPendingNavSelect(null);
    // resolveNavChat/handleStartChat aren't memoized — the actual reactive
    // inputs (conversations, hiddenConversations, userId) are listed instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingNavSelect, activeTab, activeChat, conversations, hiddenConversations, userId]);

    // Handle selecting a server text channel — loads history and shows chat
    /**
     * Decrypt one channel message row into the shape the UI stores, falling back
     * to an undecryptable placeholder. Shared by the initial channel fetch and
     * the older-history fetch so the sender-key pinning (TOFU) and the failure
     * shape can't drift between the two.
     */
    const decryptChannelRow = useCallback(async (channelId: string, m: RawChannelRow): Promise<StoredChannelMsg | null> => {
        try {
            // Reject before decryption if wire sender key ≠ pinned key for this
            // device (RC-7 — see the identical check in handleChannelMessage above).
            const wirePub: string = m.sender_identity_pub_b64 ?? '';
            if (m.sender_user_id && m.sender_user_id !== userId && wirePub && m.sender_device_id) {
                const pinned = getStoredPub(userId!, m.sender_user_id, m.sender_device_id);
                if (pinned && pinned !== wirePub) {
                    throw new Error(`[E2EE] Channel message rejected: sender key mismatch for ${m.sender_user_id}`);
                }
            }
            const contentJson = await window.electronAPI!.decryptChannelMessage({
                channel_id: channelId,
                epoch: m.epoch,
                nonce_b64: m.nonce_b64,
                ciphertext_b64: m.ciphertext_b64,
                signature_b64: m.signature_b64,
                sender_identity_pub_b64: wirePub,
                // G4 — see the live path in handleChannelMessage.
                message_id: m.id,
                sender_user_id: m.sender_user_id ?? null,
                sender_device_id: m.sender_device_id,
            });
            pinAndDetect(m.sender_user_id, m.sender_identity_pub_b64, m.sender_device_id);
            const parsedContent = JSON.parse(contentJson);
            return {
                id: m.id,
                // Content boundary — see the live channel path above.
                content: contentProblem(parsedContent)
                    ? { type: 'system', kind: UNDECRYPTABLE_KIND, data: { reason: 'malformed' } }
                    : parsedContent,
                sender_device_id: m.sender_device_id,
                sender_user_id: m.sender_user_id ?? null,
                timestamp: m.created_at,
                conversation_id: channelId,
            };
        } catch (err) {
            // G4: replayed / mis-bound / malformed — drop the row outright
            // rather than cache a key_missing placeholder that no key can heal.
            if (isChannelServeRejection(err)) {
                console.warn('[Dashboard] Dropped a channel history row the server served wrongly:', m.id, err);
                return null;
            }
            return {
                id: m.id,
                content: { type: 'system', kind: 'encrypted', data: { reason: 'key_missing' } },
                sender_device_id: m.sender_device_id,
                sender_user_id: m.sender_user_id ?? null,
                timestamp: m.created_at,
                conversation_id: channelId,
            };
        }
    }, [userId, pinAndDetect]);

    /**
     * Decrypt a page of channel rows: OLDEST FIRST (so a re-post can never
     * claim the replay ledger ahead of the original it copies — see
     * utils/channelIntegrity.ts), with rows the engine refused as
     * server-mis-served dropped. Every history fetch goes through this.
     */
    // PERF (freeze fix): every row is one `channel:decrypt-message` invoke, and
    // the main process runs each one synchronously (signature verify, key
    // lookup, AES-GCM, replay ledger). Firing a whole page — or, on a wake, a
    // page for EVERY unread channel — through one Promise.all queued hundreds
    // of those back to back on main's single thread, and main is also the
    // thread that routes input and repaints the window, so the window froze
    // until the queue drained (measured: main-loop stalls up to ~0.8 s, IPC
    // replies up to ~0.9 s late, right after a simulated wake). Bounded
    // batches keep the same total work, still pipelined, but let main breathe
    // between them. Order and results are unchanged.
    const decryptChannelRows = useCallback(async (channelId: string, raw: RawChannelRow[]): Promise<StoredChannelMsg[]> => {
        const rows = oldestFirst(raw);
        const out: Array<StoredChannelMsg | null> = [];
        for (let i = 0; i < rows.length; i += CHANNEL_DECRYPT_BATCH) {
            out.push(...await Promise.all(rows.slice(i, i + CHANNEL_DECRYPT_BATCH).map(m => decryptChannelRow(channelId, m))));
        }
        return out.filter((m): m is StoredChannelMsg => m !== null);
    }, [decryptChannelRow]);

    /**
     * Sleep-resync Phase 4 mention reconciliation. GET .../unread (called
     * from resyncAll below) tells us a channel has N messages we haven't
     * seen — counts only, since the server can never decrypt E2EE content to
     * tell us whether any of them actually mention us. This pulls just those
     * N messages, decrypts them through the normal catch-up pipeline, and
     * runs the identical mention-detection logic the live WS handler uses
     * (see the channel:message_new handler above) — so an @mention that
     * arrived while the socket was dead doesn't just vanish.
     *
     * Fetches the newest `unreadCount` messages (capped at 100, matching the
     * API's page limit) — since unread is always the tail of the channel,
     * this is exactly the unread set (or a close-enough superset if a couple
     * more arrived between the count and this fetch, which just means a
     * harmless extra couple of messages get scanned).
     */
    const reconcileChannelMentions = useCallback((serverId: string, channelId: string, unreadCount: number) => trackActivity('channel:mentions', async () => {
        if (!token || unreadCount <= 0) return;
        try {
            const res = await axios.get(`${API_BASE}/channels/${channelId}/messages`, {
                headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId ?? '' },
                params: { limit: Math.min(unreadCount, 100) },
            });
            const raw: RawChannelRow[] = res.data ?? [];
            if (!raw.length) return;
            const decrypted = await decryptChannelRows(channelId, raw);
            const everyoneFlagById = new Map(raw.map(m => [m.id, !!m.mentions_everyone]));
            const myRoleSet = new Set<string>(serverMyRoleIdsRef.current[serverId] ?? []);

            let mentionHits = 0;
            for (const m of decrypted) {
                const isOwnMessage = !m.sender_user_id || m.sender_user_id === userId;
                if (isOwnMessage) continue;
                const c = m.content;
                if (!c || c.type === 'system' || ['edit', 'delete', 'reaction'].includes(c.type)) continue;
                const textBody = c.type === 'text' ? (c.text ?? '') : '';
                const mentionsMe = userId ? (
                    messageTextMentionsUser(textBody, userId) ||
                    !!everyoneFlagById.get(m.id) ||
                    messageTextMentionsRole(textBody, myRoleSet)
                ) : false;
                if (mentionsMe) mentionHits++;
            }
            if (mentionHits > 0) {
                setChannelMentionCounts(prev => ({
                    ...prev,
                    [channelId]: Math.max(prev[channelId] ?? 0, mentionHits),
                }));
            }
        } catch { /* silent — mention count just stays at whatever it already was */ }
    }), [token, deviceId, decryptChannelRows, userId]);
    // One channel at a time (freeze fix). The resync fires this for every
    // unread channel of every server at once; running them concurrently put
    // every channel's decrypt burst on the main process simultaneously. Mention
    // badges are not urgent — draining them in sequence costs a few seconds of
    // latency on a badge and keeps the window responsive while it happens.
    const mentionQueueRef = useRef<Promise<void>>(Promise.resolve());
    useEffect(() => {
        reconcileChannelMentionsRef.current = (serverId, channelId, unreadCount) => {
            mentionQueueRef.current = mentionQueueRef.current
                .then(() => reconcileChannelMentions(serverId, channelId, unreadCount))
                .catch(() => { /* reconcileChannelMentions handles its own errors */ });
        };
    }, [reconcileChannelMentions]);

    /**
     * What retention says about rows that are about to ENTER a channel's cache
     * (utils/channelHistoryRetention.ts): the same effective policy and the same
     * pin / server-save exemption the 5-minute sweep uses. null = don't filter
     * (this device hasn't chosen a policy yet, or the channel's saved set is
     * unknown) - dropping would be a guess, and the sweep still runs later.
     *
     * `saved` lets a caller that just fetched the saved set pass it in: the
     * ref only catches up after the next render.
     */
    const incomingRetentionFor = useCallback((channelId: string, serverId: string | undefined, saved?: string[]): IncomingRetention | null => {
        if (!userId || !deviceStorageReadyRef.current) return null;
        const savedIds = saved ?? channelServerSavesRef.current[channelId];
        if (savedIds === undefined) return null;
        let sid = serverId;
        if (!sid) {
            for (const [candidate, chs] of Object.entries(serverChannelsRef.current)) {
                if (chs.some(c => c.channel_id === channelId)) { sid = candidate; break; }
            }
        }
        return {
            policy: serverSweepPolicy(retentionPolicyRef.current, sid),
            pinned: pinnedIdsForChannel(localChannelPinsRef.current[channelId], savedIds),
            now: Date.now(),
        };
    }, [userId, serverSweepPolicy]);

    /** channelId -> created_at of the oldest server row "Load older history" has
     *  looked at, INCLUDING rows retention dropped. The cursor the UI passes is
     *  the oldest row it can see; once a page is entirely past retention that
     *  would never advance and the control would re-ask the same page forever. */
    const olderCursorRef = useRef<Record<string, string>>({});

    /**
     * Fetch a page of OLDER channel history from the server.
     *
     * Until now the client only ever fetched `limit=50` with no `before=`, and
     * the "Load earlier messages" control just widened a window over what was
     * already in memory — `useMessagePagination` makes no network calls. So a
     * member who joined a server could never see anything past the newest 50
     * messages, no matter what channel keys they held. That hit server-saved
     * messages hardest: they're exempt from the retention sweep, so they're
     * usually the OLDEST rows in the channel and therefore always out of reach.
     *
     * Returns how many rows the server had before this point, so the caller can
     * tell "no more history" from "fetched a page".
     */
    const loadOlderChannelMessages = useCallback(async (channelId: string, beforeIso: string): Promise<number> => {
        if (!token) return 0;
        // Pages that are ENTIRELY past this device's retention window carry
        // nothing to show (and would be swept straight away), so skip over a
        // few of them per click to reach what is still inside the window - a
        // server-saved message, say, that sits behind weeks of expired rows.
        const MAX_SKIPPED_PAGES = 4;
        try {
            const savedIds = await ensureChannelSaves(channelId);
            let cursor = beforeIso;
            const remembered = olderCursorRef.current[channelId];
            if (remembered && Date.parse(remembered) < Date.parse(cursor)) cursor = remembered;
            let shown = 0;
            let exhausted = false;
            for (let page = 0; page <= MAX_SKIPPED_PAGES; page++) {
                const res = await axios.get(`${API_BASE}/channels/${channelId}/messages`, {
                    headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId ?? '' },
                    params: { limit: 50, before: cursor },
                });
                const raw: RawChannelRow[] = res.data ?? [];
                // Fewer rows than the page limit (including zero) can only mean
                // we've reached the true start of this channel's history - latch
                // it so the "Load older history" button retires for good instead
                // of needing one more round trip next time to find out.
                if (raw.length < 50) {
                    exhausted = true;
                    setChannelHistoryExhausted(prev => (prev[channelId] ? prev : { ...prev, [channelId]: true }));
                }
                if (!raw.length) break;
                const decrypted = await decryptChannelRows(channelId, raw);
                // "Load older history" re-reads the server, so it is the other way a
                // retention-purged message can come back. Retention is a standing
                // instruction, not a one-off - honour it here too, both the
                // ledger of what the sweep deleted and the window itself.
                const purgedIds = userId ? getPurgedMessageIds(userId, channelId) : new Set<string>();
                const { kept } = splitExpiredIncoming(decrypted, incomingRetentionFor(channelId, undefined, savedIds));
                setChannelMessages(prev => {
                    const existing = prev[channelId] ?? [];
                    const byId = new Map<string, StoredChannelMsg>(
                        (existing as StoredChannelMsg[]).map(m => [m.id, m]),
                    );
                    for (const m of kept) {
                        if (purgedIds.has(m.id)) continue;
                        const have = byId.get(m.id);
                        // Same upgrade rule as the main merge: a real decrypt beats a
                        // cached "couldn't decrypt" placeholder.
                        if (!have || (isUndecryptablePlaceholder(have) && !isUndecryptablePlaceholder(m))) {
                            byId.set(m.id, m);
                        }
                    }
                    // Same absence rule as refreshChannelHistory, with the window
                    // capped at the `before=` cursor this page was fetched under:
                    // this response completely covers [oldest row returned,
                    // cursor), so a cached pill in there that the server no
                    // longer holds is unhealable and gets dropped. Measured on
                    // the rows the server RETURNED (`decrypted`), not the ones
                    // kept, so a dropped-as-expired row still counts as present.
                    const olderWindow = coveredServerWindow(decrypted, cursor);
                    const merged = pruneVanishedPlaceholders(
                        [...byId.values()],
                        new Set(decrypted.map(m => m.id)),
                        olderWindow,
                    ).sort(
                        (a: StoredChannelMsg, b: StoredChannelMsg) =>
                            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
                    );
                    return { ...prev, [channelId]: merged };
                });
                shown += kept.filter(m => !purgedIds.has(m.id)).length;
                const oldestRow = raw.reduce((min, m) => (m.created_at < min ? m.created_at : min), raw[0].created_at);
                olderCursorRef.current[channelId] = oldestRow;
                if (shown > 0 || raw.length < 50) break;
                cursor = oldestRow;
            }
            // 0 retires the control (nothing older exists). If we only gave up
            // after skipping expired pages, the control must stay: the cursor
            // is remembered, so the next click carries on from there.
            return shown > 0 ? shown : (exhausted ? 0 : 1);
        } catch (e) {
            console.warn('[Channels] loadOlderChannelMessages failed:', e);
            return 0;
        }
    }, [token, deviceId, userId, decryptChannelRows, ensureChannelSaves, incomingRetentionFor]);

    /**
     * Catch-up fetch for ONE channel: pull the API's newest page of history and
     * MERGE it into the local cache. Extracted from handleSelectChannel so a
     * pure "my key situation changed, re-read history" refresh doesn't have to
     * re-run the whole channel-entry ceremony (read-cursor POST, unread-badge
     * clear, last-channel write, and — the one that mattered — the Sender Key
     * bootstrap, whose 'wait' branch calls fileKeyRequest with NO dedup. Routing
     * the envelopes-ready handler back through handleSelectChannel therefore
     * re-filed a key request on every push, and each request drew fresh
     * envelopes from every holder, which pushed another envelopes-ready. That
     * was the loop that kept the flicker going rather than firing once.)
     *
     * Local cache is the source of truth; the API only contributes rows we
     * don't have yet, plus real decrypts that upgrade cached "couldn't
     * decrypt" placeholders in place.
     */
    const refreshChannelHistory = useCallback((serverId: string, channelId: string) => trackActivity('channel:history', async () => {
        if (!token) return;
        try {
            // Stamped BEFORE the request so the absence check below can't blame
            // the server for a message that did not exist yet when we asked.
            const requestedAtIso = new Date().toISOString();
            // The pin / server-save set decides which old rows retention may
            // drop at the door (below). Asked for alongside the history so the
            // first visit to a channel doesn't wait on it afterwards.
            const savedIdsP = ensureChannelSaves(channelId);
            const res = await axios.get(`${API_BASE}/channels/${channelId}/messages`, {
                headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId ?? '' },
                params: { limit: 50 },
            });
            // Decrypt all messages in parallel (shared with the older-history
            // fetch — see decryptChannelRow).
            const raw: RawChannelRow[] = res.data ?? [];
            // No `before` param above — this is the server's newest 50, so
            // fewer than that means the channel's entire history is ≤ 50
            // messages and already resident once the merge below lands.
            // Same latch as loadOlderChannelMessages; see channelHistoryExhausted's doc comment.
            if (raw.length < 50) {
                setChannelHistoryExhausted(prev => (
                    prev[channelId] ? prev : { ...prev, [channelId]: true }
                ));
            }
            // Rows already cached as real content are reused, not re-decrypted
            // (see utils/channelRowReuse — fold would discard the new copy).
            const { reused, toDecrypt } = splitReusableChannelRows(raw, channelMessagesRef.current[channelId]);
            const decrypted = [...reused, ...await decryptChannelRows(channelId, toDecrypt)];
            // Retention at the door. A row already past this device's "Keep
            // for" window - one this cache never held, so no tombstone knows it
            // (a freshly-added device, a just-joined server, a long absence) -
            // must not be folded in only for the 5-minute sweep to delete it
            // again: for those minutes it would show, and once its epoch key
            // has aged out it would show as "Couldn't decrypt - waiting on this
            // channel's key" and file a key request. See
            // utils/channelHistoryRetention.ts.
            const { kept: keptRows } = splitExpiredIncoming(
                decrypted,
                incomingRetentionFor(channelId, serverId, await savedIdsP),
            );
            // Sort chronologically (oldest first) — sort() is non-mutating
            // on the intermediate array and idempotent.
            const sorted = [...keptRows].sort(
                (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );
            // Merge into the local cache, applying action messages (edit /
            // delete / reaction) on top. The base array is the existing
            // local cache so we don't lose anything that's been swept off
            // the API (e.g. messages older than the API's 30-day window
            // that the user wants to keep locally).
            //
            // foldChannelHistory (utils/channelHistoryMerge.ts, unit-tested)
            // inserts genuinely new rows, applies edit/delete/reaction
            // envelopes, and — critically — upgrades a cached "couldn't
            // decrypt" placeholder in place once a decrypted copy of the same
            // id arrives. That in-place heal is what makes dropping the whole
            // channel's cache unnecessary when a key finally lands.
            // `purgedIds` is what stops the server's copy of a retention-deleted
            // message from being read as "new" and re-inserted — see
            // utils/retentionTombstones.ts.
            const purgedIds = userId ? getPurgedMessageIds(userId, channelId) : new Set<string>();
            // No `before=` on this fetch, so the response is the top of the
            // channel: it completely covers [oldest row returned, requestedAt).
            // A cached "couldn't decrypt" pill inside that window that the
            // server did NOT return has been hard-deleted server-side
            // (retention sweep), so no key will ever decrypt it — drop it
            // instead of leaving a permanent "waiting on this channel's key"
            // pill for content that no longer exists. Decrypted rows are
            // untouched: the local cache is meant to outlive the server's
            // 30-day retention. The requestedAt cap spares a live
            // channel:message_new placeholder that arrived mid-flight.
            // Measured on what the server RETURNED, not on what retention kept:
            // a row dropped at the door is still a row the server holds.
            const serverWindow = coveredServerWindow(decrypted, requestedAtIso);
            // Unpin any personally-saved ("Save for me") channel message this
            // batch's delete markers will remove — computed against
            // channelMessagesRef (the same pre-merge snapshot foldChannelHistory
            // below starts from) and OUTSIDE the setChannelMessages updater,
            // which must stay pure. This is the catch-up path: a delete that
            // happened while this device wasn't looking at the channel is
            // caught here on next open/reconnect, same intent as the live
            // handler in handleChannelMessage.
            for (const id of deletedChannelTargetIds(channelMessagesRef.current[channelId] ?? [], sorted, purgedIds)) {
                if (localChannelPinsRef.current[channelId]?.includes(id)) {
                    handlePersonalChannelSaveRef.current(channelId, id, 'remove');
                }
            }
            setChannelMessages(prev => {
                const next = foldChannelHistory(prev[channelId] ?? [], sorted, purgedIds, serverWindow);
                // Nothing new (the usual re-open): keep the same array so the
                // open pane and everything keyed on it doesn't re-render.
                const before = prev[channelId];
                if (before && next.length === before.length && next.every((m, i) => m === before[i])) return prev;
                return { ...prev, [channelId]: next };
            });
            // At least one history message couldn't decrypt (missing/stale
            // epoch key) — file a request once for the whole batch instead
            // of per-message. Previously this placeholder was purely
            // cosmetic: nothing ever asked for the key that would clear it.
            // Purged rows are excluded from the question: a message the user
            // deliberately retention-deleted must not send this device begging
            // other members for the key that would decrypt it.
            if (pageNeedsKeyRequest(sorted, purgedIds)) {
                undecryptableChannelsRef.current.add(channelId);
                void channelKeyOpsRef.current.maybeFileKeyRequest(serverId, channelId);
            } else {
                // Everything in the newest page decrypted — this channel has
                // recovered. Clearing the flag matters: the 75s retry timer
                // sweeps `undecryptableChannelsRef` and re-files a key request
                // for every entry, and until now only a successful LIVE decrypt
                // ever removed one. A channel healed by history alone stayed in
                // the set for the whole session, re-requesting every 75s
                // forever — one more engine driving the envelopes-ready churn.
                undecryptableChannelsRef.current.delete(channelId);
            }
        } catch (err) {
            console.error('[Dashboard] Failed to load channel history:', err);
        }
    }), [token, deviceId, userId, decryptChannelRows, ensureChannelSaves, incomingRetentionFor]);
    useEffect(() => { refreshChannelHistoryRef.current = refreshChannelHistory; }, [refreshChannelHistory]);

    /** Channels with an ensureChannelKeyBootstrap pass currently running.
     *  Purely an in-flight guard (cleared in `finally`), NOT a "done" set:
     *  re-entering a channel must still be able to re-run the pass to clear a
     *  stale gate. Without it, opening a channel and joining its call in the
     *  same instant fires two concurrent passes, and fileKeyRequest
     *  deliberately bypasses its own 60 s dedup. */
    const channelKeyEnsureInFlightRef = useRef<Set<string>>(new Set());

    /**
     * Drive a keyed channel's Sender-Key bootstrap: mint epoch 1 if the
     * channel has never been keyed anywhere, otherwise pull (and if needed
     * request) what we're missing, gating meanwhile.
     *
     * Extracted from handleSelectChannel because opening the channel row was
     * NOT the only way to need a key. A server Calls channel derives its
     * LiveKit room key from this same Sender Key, and every call join path
     * (spawn a huddle call, join an existing one, join a legacy voice channel,
     * get force-moved into one) reaches the room WITHOUT ever going through
     * handleSelectChannel — so a channel at latest_epoch 0 left the joiner
     * waiting on a key nobody would ever mint. See the ensure effect keyed on
     * activeCall.callsChannelId below, which is what actually closes that gap
     * for all four paths at once.
     *
     * Respects everything the original block did: bootstrapAndDistribute's own
     * in-flight guard + epoch-claim arbitration, and the "we may legitimately
     * not be the minter" case (file a request, wait for a holder).
     *
     * The load-bearing rule it enforces (unchanged from the handleSelectChannel
     * original): a NEW MEMBER must never mint. Calling rotateChannelKey() when
     * a key already exists somewhere creates a fresh epoch nobody else has,
     * making every existing message permanently undecryptable. "Truly new
     * channel" is decided ONLY by the server's authoritative latest_epoch === 0
     * (no ServerSenderKeyMeta row has ever existed); an unknown/failed lookup
     * routes to 'wait', never to 'mint'. A new member gets their keys from
     * pullChannelKeys() or the server:member_joined distribution instead.
     */
    const ensureChannelKeyBootstrap = useCallback(async (channel: {
        channel_id: string;
        server_id: string;
        kind: string;
        /** Server's authoritative MAX(epoch). Pass `undefined` to force a
         *  fresh GET — what the call paths do, since a channel object cached
         *  since server-load can carry a stale 0 and provoke a needless mint. */
        latest_epoch?: number;
    }) => {
        if (!channelCarriesSenderKeys(channel.kind)) return;
        if (channelKeyEnsureInFlightRef.current.has(channel.channel_id)) return;
        channelKeyEnsureInFlightRef.current.add(channel.channel_id);
        try {
            const existingEpoch = await window.electronAPI!.getLatestChannelEpoch(channel.channel_id);

            // channel.latest_epoch (from GET /servers/:sid/channels, which
            // fetched this very channel list) is the authoritative signal —
            // 0 is a real "nobody has ever minted a key here" answer, not
            // an unknown state. Only fall back to the slower per-channel GET
            // when the channel object doesn't carry it (e.g. an older API,
            // or a locally-constructed object) — and if THAT fails too,
            // leave it undefined; decideChannelEntryAction treats unknown
            // the same as "wait" (safe: never blind-mints over a channel
            // that might already have real keys).
            let latestEpoch = channel.latest_epoch;
            if (latestEpoch === undefined) {
                try {
                    const metaRes = await axios.get(
                        `${API_BASE}/channels/${channel.channel_id}/epoch`,
                        { headers: { Authorization: `Bearer ${token}` } }
                    );
                    latestEpoch = metaRes.data?.epoch ?? 0;
                } catch { /* stays undefined — routes to the wait branch below */ }
            }

            const action = decideChannelEntryAction({ localEpoch: existingEpoch, latestEpoch });
            if (action === 'mint') {
                // Brand-new channel (no epoch anywhere) — first opener mints
                // epoch 1 AND seeds it to every current member device, so the
                // channel is decryptable server-wide immediately instead of
                // only by whoever happened to open it first.
                await channelKeyOpsRef.current.bootstrapAndDistributeChannelKey(channel.server_id, channel.channel_id);
            } else if (action === 'wait') {
                // Existing channel but we lack the key. Pull any waiting
                // envelopes; if still keyless, file a persistent key request
                // (online holders answer within seconds, offline holders find
                // it on their next connect — and if the request comes back
                // unanswerable, fileKeyRequest mints instead) and gate the
                // composer meanwhile.
                console.log(`[Channels] Awaiting key distribution for channel ${channel.channel_id}`);
                setAwaitingChannelKeys(prev => ({ ...prev, [channel.channel_id]: true }));
                // Deliberately NOT awaited: opening a channel must not block
                // its catch-up fetch on a key round-trip, and a call join must
                // not block its connect on one either — useCallsChannelKey's
                // poll picks the key up the moment it lands.
                void channelKeyOpsRef.current.pullChannelKeys(channel.server_id)
                    .then(async () => {
                        const held = await window.electronAPI!.getLatestChannelEpoch(channel.channel_id);
                        if (held !== null) {
                            setAwaitingChannelKeys(prev => {
                                if (!prev[channel.channel_id]) return prev;
                                const next = { ...prev };
                                delete next[channel.channel_id];
                                return next;
                            });
                        } else {
                            await channelKeyOpsRef.current.fileKeyRequest(channel.server_id, channel.channel_id);
                        }
                    })
                    .catch(() => {
                        // pullChannelKeys rejected — still file the request rather
                        // than leaving the gate stranded with no request ever
                        // filed. fileKeyRequest sets firstKeyRequestTimeRef BEFORE
                        // its own POST, so even if THIS also fails, the 10-minute
                        // fallback-rotation timer is armed instead of never firing.
                        void channelKeyOpsRef.current.fileKeyRequest(channel.server_id, channel.channel_id);
                    });
            } else {
                // Key already held — clear any stale awaiting-flag from an
                // earlier visit. The channelKeyEnvelopesReadyEvents queue
                // (see its consumer effect) now drains every channel in a
                // batch, not just the last one, so this is a safety net
                // rather than the primary fix — but reopening the channel
                // remains the cheapest, most reliable point to resync if
                // anything upstream still slipped through.
                setAwaitingChannelKeys(prev => {
                    if (!prev[channel.channel_id]) return prev;
                    const next = { ...prev };
                    delete next[channel.channel_id];
                    return next;
                });
            }
        } catch (err) {
            console.warn('[Channels] Key bootstrap failed (non-fatal):', err);
        } finally {
            channelKeyEnsureInFlightRef.current.delete(channel.channel_id);
        }
    }, [token]);

    const handleSelectChannel = useCallback(async (channel: ChannelInfo) => {
        setActiveChannel(channel);
        setActiveChat(null); // Clear DM/group selection

        // First visit to this channel this session — hold ChatPane's spinner
        // until the catch-up fetch below settles instead of letting it render
        // messages.length === 0 as "no history" for the instant before the
        // real (possibly non-empty) array lands.
        const isFirstMessagesFetch = !fetchedChannelIdsRef.current.has(channel.channel_id);
        if (isFirstMessagesFetch) {
            setChannelMessagesFetching(prev => ({ ...prev, [channel.channel_id]: true }));
        }

        // Clear channel unread + mention badges when user enters the channel
        setChannelUnreadCounts(prev => {
            if (!prev[channel.channel_id]) return prev;
            const next = { ...prev };
            delete next[channel.channel_id];
            return next;
        });
        setChannelMentionCounts(prev => {
            if (!prev[channel.channel_id]) return prev;
            const next = { ...prev };
            delete next[channel.channel_id];
            return next;
        });

        // Advance the server-side read cursor (sleep-resync Phase 4) — fire
        // and forget. This is what lets GET /servers/:sid/unread give a
        // reconnecting client (or a second device) an accurate unread count
        // instead of trusting only locally-tallied live WS events, which are
        // silently incomplete for anything missed while disconnected.
        if (token && channel.kind === 'text') {
            markChannelReadOnServerRef.current(channel.channel_id);
        }

        // Remember last-active channel per server so we can auto-select on
        // re-entry. localStorage map: { [serverId]: channelId }, keyed per
        // user (so multi-account installs don't bleed). Only text channels
        // are remembered — voice channels would auto-join on entry which
        // we don't want.
        if (userId && channel.kind === 'text') {
            try {
                const key = `cipherline_last_channel_${userId}`;
                const map = JSON.parse(secureLocalStore.getItem(key) || '{}');
                map[channel.server_id] = channel.channel_id;
                secureLocalStore.setItem(key, JSON.stringify(map));
            } catch { /* localStorage full / disabled — non-fatal */ }
        }

        // ── Sender Key bootstrap ──────────────────────────────────────────────
        // Body lives in ensureChannelKeyBootstrap above so the Calls-channel
        // call-join paths can drive the exact same mint-vs-request decision —
        // they never pass through here. See its doc comment.
        await ensureChannelKeyBootstrap(channel);

        // Catch-up fetch: pull recent server-channel history and MERGE with the
        // local cache. See refreshChannelHistory — the body moved there so the
        // envelopes-ready handler can re-read history without re-running this
        // whole function.
        await refreshChannelHistory(channel.server_id, channel.channel_id);
        // Settle the loading flag regardless of outcome (success, failure, or
        // skipped because there's no token) — an indefinite spinner would be
        // worse than falling through to render whatever's in the local cache.
        if (isFirstMessagesFetch) {
            fetchedChannelIdsRef.current.add(channel.channel_id);
            setChannelMessagesFetching(prev => {
                if (!prev[channel.channel_id]) return prev;
                const next = { ...prev };
                delete next[channel.channel_id];
                return next;
            });
        }

        // Load server-saved (and pinned) message IDs for this channel —
        // server-backed, READ_MESSAGE_HISTORY. Failures here are non-fatal.
        if (token) {
            try {
                applyChannelSaveState(channel.channel_id, await fetchChannelSaveState(API_BASE, channel.channel_id, token));
            } catch { /* non-fatal */ }
        }
    }, [token, userId, refreshChannelHistory, ensureChannelKeyBootstrap, applyChannelSaveState]);

    // ── Calls-channel key bootstrap for every call-JOIN path ────────────────
    // A Calls channel's LiveKit room key is derived from its Sender Key, and
    // the render gate below refuses to mount CallPane until this device holds
    // the current epoch. Epoch 1, however, used to be minted ONLY by
    // handleSelectChannel — and NONE of the ways into a Calls-channel call go
    // through it: spawning a huddle call, joining an existing one, joining a
    // legacy voice channel, and a moderator's force-move all set activeCall
    // directly from their own handlers. On a channel nobody has ever keyed
    // (latest_epoch 0 — which is every Calls channel predating this feature)
    // nothing minted, requestMissingChannelKeys skips latest_epoch 0 by design
    // (no holder exists to answer a request), and the joiner waited forever.
    //
    // Hanging this off activeCall.callsChannelId rather than patching each
    // handler is deliberate: a fifth join path added later is covered without
    // anyone remembering to. It runs the instant the call becomes active,
    // which is still strictly before any connection — CallPane cannot mount
    // until the key exists.
    const callKeyEnsuredForRef = useRef<string | null>(null);
    useEffect(() => {
        const callId = activeCall?.id;
        const channelId = activeCall?.callsChannelId;
        if (!callId || !channelId) { callKeyEnsuredForRef.current = null; return; }
        const marker = `${callId}:${channelId}`;
        if (callKeyEnsuredForRef.current === marker) return;

        const chan = Object.values(serverChannels).flat().find(c => c.channel_id === channelId);
        if (!chan) {
            // That server's channel list hasn't landed yet, so we can't resolve
            // the server id the key protocol needs. Bail WITHOUT marking this
            // done — serverChannels is a dep, so the effect retries the moment
            // the list arrives (the force-move path can genuinely land here).
            console.warn('[CallsChannelKey] No local channel record for', channelId, '— deferring key bootstrap');
            return;
        }
        callKeyEnsuredForRef.current = marker;
        // latest_epoch is deliberately NOT forwarded: a channel object cached
        // since server-load can carry a stale 0, and blind-minting over a
        // channel that has since been keyed only loses arbitration and forces
        // a discard-and-request round trip. Undefined makes it re-read the
        // authoritative epoch first.
        void ensureChannelKeyBootstrap({
            channel_id: chan.channel_id,
            server_id: chan.server_id,
            kind: chan.kind,
        });
    }, [activeCall?.id, activeCall?.callsChannelId, serverChannels, ensureChannelKeyBootstrap]);

    // Auto-select a channel when entering a server.
    //
    // When the user clicks a server icon in Pane 1, we set
    // pendingChannelSelect = serverId. Once that server's channel list
    // arrives in `serverChannels`, this effect picks the channel:
    //   1. Last-active text channel for this server (localStorage), or
    //   2. The first text channel (sorted by `position`), or
    //   3. The first channel of any kind (only if no text exists).
    //
    // Skipped when the user is already viewing a channel in this server —
    // re-clicking the icon shouldn't bounce them off their current channel.
    useEffect(() => {
        if (!pendingChannelSelect || !userId) return;
        const list = serverChannels[pendingChannelSelect];
        if (!list || list.length === 0) return;
        if (activeChannel && activeChannel.server_id === pendingChannelSelect) {
            // Already viewing a channel in this server — clear the flag and bail.
            setPendingChannelSelect(null);
            return;
        }
        let lastMap: Record<string, string> = {};
        try { lastMap = JSON.parse(secureLocalStore.getItem(`cipherline_last_channel_${userId}`) || '{}'); } catch {}
        const remembered = lastMap[pendingChannelSelect];
        const target =
            (remembered && list.find(c => c.channel_id === remembered && c.kind === 'text')) ||
            [...list].filter(c => c.kind === 'text').sort((a, b) => a.position - b.position)[0] ||
            list[0];
        if (target) handleSelectChannel(target);
        setPendingChannelSelect(null);
    }, [pendingChannelSelect, serverChannels, userId, activeChannel, handleSelectChannel]);

    // Keep voice participant lists in sync with WS voice_state events.
    useEffect(() => {
        if (!voiceStateEvent) return;
        const { channel_id, user_id, action, display_name, avatar_url } = voiceStateEvent;
        // Learn the name from the event that introduced the id. Before this,
        // names came only from the batched seed, so anyone who joined since
        // the last seed rendered as "Someone" until the next one.
        setVoiceUserNames(prev => mergeVoiceUserName(prev, user_id, display_name));
        setVoiceUserAvatarIds(prev => mergeVoiceUserAvatarId(prev, user_id, avatar_url));
        setVoiceParticipants(prev => {
            const current = prev[channel_id] ?? [];
            if (action === 'join') {
                if (current.includes(user_id)) return prev;
                return { ...prev, [channel_id]: [...current, user_id] };
            } else {
                return { ...prev, [channel_id]: current.filter(id => id !== user_id) };
            }
        });
    }, [voiceStateEvent]);

    // ── Huddle WS events → useServers state mutations ──────────────────────
    useEffect(() => {
        if (!huddleSpawnEvent) return;
        applyHuddleSpawn(huddleSpawnEvent.huddle_id, huddleSpawnEvent.call);
    }, [huddleSpawnEvent, applyHuddleSpawn]);
    useEffect(() => {
        if (!huddleDestroyEvent) return;
        applyHuddleDestroy(huddleDestroyEvent.huddle_id, huddleDestroyEvent.call_id);
    }, [huddleDestroyEvent, applyHuddleDestroy]);
    useEffect(() => {
        if (!huddleRenameEvent) return;
        applyHuddleRename(huddleRenameEvent.huddle_id, huddleRenameEvent.call_id, huddleRenameEvent.name);
    }, [huddleRenameEvent, applyHuddleRename]);
    useEffect(() => {
        if (!huddleParticipantEvent) return;
        // Same as the voice_state effect above — and this is the path that
        // actually fires, since createServer seeds a Calls channel, not voice.
        setVoiceUserNames(prev => mergeVoiceUserName(
            prev, huddleParticipantEvent.user_id, huddleParticipantEvent.display_name,
        ));
        setVoiceUserAvatarIds(prev => mergeVoiceUserAvatarId(
            prev, huddleParticipantEvent.user_id, huddleParticipantEvent.avatar_url,
        ));
        applyHuddleParticipant(
            huddleParticipantEvent.huddle_id,
            huddleParticipantEvent.call_id,
            huddleParticipantEvent.user_id,
            huddleParticipantEvent.action,
        );
    }, [huddleParticipantEvent, applyHuddleParticipant]);

    // ── Force-move: a moderator with MOVE_MEMBERS moved us to another call ──
    // The server already left us out of the old call, put us in the new one,
    // and evicted us from the old LiveKit room — so this deliberately does
    // NOT run the normal join path. Re-issuing a leave here would
    // double-decrement the source call, and routing through
    // handleJoinExistingHuddleCall would raise the "switch calls?" prompt
    // (we're by definition already in a call) anchored to a stale click
    // position. The event carries a destination-scoped token; just connect.
    useEffect(() => {
        if (!huddleForceMoveEvent) return;
        const ev = huddleForceMoveEvent;
        setActiveVoiceChannelId(null);
        setActiveHuddleCallId(ev.call_id);
        setActiveHuddleChannelId(ev.huddle_id);
        setActiveCall({
            id: ev.call_id,
            livekit_url: ev.livekit_url,
            livekit_token: ev.livekit_token,
            e2ee_key_b64: '',
            callsChannelId: ev.huddle_id,
            mode: 'sfu',
            isInitiator: false,
            isVoiceChannel: true,
            voiceChannelName: ev.call_name,
        });
        toast.push({
            kind: 'info',
            title: 'You were moved',
            message: `A moderator moved you to ${ev.call_name}.`,
        });
    // toast is a stable context value; re-running on it would re-fire the move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [huddleForceMoveEvent]);

    // Auto-load active calls for any Huddle channel in the current server.
    useEffect(() => {
        if (!activeServerView?.serverId) return;
        const huddles = (serverChannels[activeServerView.serverId] ?? []).filter(c => c.kind === 'huddle');
        for (const h of huddles) {
            loadHuddleCalls(h.channel_id);
        }
    }, [activeServerView?.serverId, serverChannels, loadHuddleCalls]);

    // ── Channel key distribution ─────────────────────────────────────────────
    // pullChannelKeys: fetches pending channel key envelopes from the server for
    // a given server's channels, decrypts them in the main process, and stores
    // them locally. Called after joining a server and on dashboard mount.
    const pullChannelKeys = useCallback(async (serverId: string) => {
        if (!token || !deviceId) return;
        // Phase 4c: WS push, the connect/repair sweep, and the 75s retry timer
        // can all trigger a pull for the same server around the same time.
        // Without this guard two overlapping calls could both decrypt-and-
        // install the same envelope batch, double-counting failures against
        // the retry bound and racing on which one's ACK POST lands last.
        if (pullChannelKeysInFlightRef.current.has(serverId)) return;
        pullChannelKeysInFlightRef.current.add(serverId);
        try {
            const res = await axios.get(`${API_BASE}/servers/${serverId}/channel-keys/pending`, {
                headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId }
            });
            const envelopes: Array<{
                envelope_id: string;
                channel_id: string;
                epoch: number;
                ciphertext_b64: string;
                sender_user_id: string;
            }> = res.data ?? [];
            if (!envelopes.length) return;

            const ackIds: string[] = [];
            // Arbitrated fingerprints for this server, fetched at most once per
            // pull and only when a conflict actually shows up.
            let arbitrated: Map<string, string | null> | null = null;
            const arbitratedFingerprint = async (channelId: string, epoch: number): Promise<string | null> => {
                if (!arbitrated) {
                    arbitrated = new Map();
                    try {
                        const r = await axios.get(`${API_BASE}/servers/${serverId}/key-epochs`, {
                            headers: { Authorization: `Bearer ${token}` },
                        });
                        for (const c of (r.data ?? []) as { channel_id: string; epochs: ServerEpochInfo[] }[]) {
                            for (const e of c.epochs) arbitrated.set(`${c.channel_id}:${e.epoch}`, e.fingerprint_b64);
                        }
                    } catch { /* leave empty — conflict stays unresolved this round */ }
                }
                return arbitrated.get(`${channelId}:${epoch}`) ?? null;
            };

            for (const env of envelopes) {
                try {
                    const { contentJson: ckContentJson, senderUserId: ckSenderUserId, senderPub: ckSenderPub, senderDeviceId: ckSenderDeviceId } = await window.electronAPI!.decryptMessage(env.ciphertext_b64, deviceId);
                    // F1: channel_key is key material — warm the directory before
                    // judging it, for the same reason as call_key above. The
                    // distributor is already known to the server here (it routed the
                    // handshake), so this costs no sealed-sender property.
                    if (ckSenderUserId && ckSenderUserId !== userId) {
                        await deviceDirectory.ensureUser(ckSenderUserId, fetchIdentityKeys);
                    }
                    // C2 + F1: pin the key distributor's identity (TOFU) / flag a change.
                    const ckVerdict = pinAndDetect(ckSenderUserId, ckSenderPub, ckSenderDeviceId);
                    const content = JSON.parse(ckContentJson);
                    if (content?.type === 'channel_key' && content.key_b64) {
                        // R3 / RC-7: refuse an epoch key from a distributor whose identity
                        // doesn't match the pinned TOFU record for THAT DEVICE — a swapped
                        // distributor key lets the server poison the channel's symmetric key
                        // (read/forge). First-contact for this device (no pin yet) is allowed,
                        // and critically so is ANY other device of an already-known distributor
                        // (ckSenderDeviceId unknown to the pin store) — every device has its own
                        // identity key by design, and treating that as a "change" here is exactly
                        // what left multi-device accounts permanently stuck on "waiting for
                        // channel keys": the distributor answering a request was never
                        // guaranteed to be the same device whose key got pinned first.
                        // Throwing routes to the catch below, which ACKs to avoid replay.
                        //
                        // F1: the pinned-pub comparison this replaced was open to the
                        // same forgery as the call_key gate — an unknown device id made
                        // `pinned` null and the epoch key was installed unconditionally,
                        // which hands a forger the channel's symmetric key and with it
                        // the ability to READ and FORGE every message in that epoch.
                        // Fail closed on any verdict that is not 'ok'/'first_contact'.
                        if (ckSenderUserId && ckSenderUserId !== userId && ckVerdict
                            && actionFor(ckVerdict, 'key_material') !== 'accept') {
                            throw new Error(`[Channels] epoch key rejected: distributor identity not attributable (${ckVerdict})`);
                        }
                        const rotatesAt = content.rotates_at
                            ? content.rotates_at
                            : new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
                        let stored = await window.electronAPI!.setChannelKey(env.channel_id, env.epoch, content.key_b64, rotatesAt);
                        if (stored === 'conflict') {
                            // We hold a DIFFERENT key for this epoch. Ask the server
                            // who won arbitration and, if this envelope carries the
                            // winner, install it over ours.
                            //
                            // Previously this just logged and fell through to the ACK
                            // below, which soft-deleted the winner's envelope server
                            // side while never storing the key — so the only copy
                            // could be destroyed. Recovery leaned entirely on the
                            // repair sweep, and on a two-member server whose winner
                            // went offline right after distributing, that epoch's
                            // history was gone for good.
                            const winner = await arbitratedFingerprint(env.channel_id, env.epoch);
                            if (winner) {
                                stored = await window.electronAPI!.setChannelKey(
                                    env.channel_id, env.epoch, content.key_b64, rotatesAt, winner,
                                );
                            }
                        }
                        if (stored === 'conflict') {
                            // Either the server has no arbitrated fingerprint yet or
                            // OUR key is the winner. Leave the envelope unacked so a
                            // later pull can install it if the repair sweep decides we
                            // lost; the poison bound below stops it replaying forever.
                            // Phase 4c: keyed on (channel, epoch), not envelope_id —
                            // now that submitHandshake upserts (RC-8), envelope_id is
                            // stable across redistribution too, but the natural key is
                            // what this counter is conceptually about either way.
                            const key = channelEpochKey(env.channel_id, env.epoch);
                            const n = (envelopeFailureCountRef.current.get(key) ?? 0) + 1;
                            envelopeFailureCountRef.current.set(key, n);
                            console.warn(`[Channels] Epoch ${env.epoch} conflict for channel ${env.channel_id} — unresolved (attempt ${n})`);
                            if (shouldGiveUpOnChannelKey(n)) {
                                ackIds.push(env.envelope_id);
                                envelopeFailureCountRef.current.delete(key);
                                const until = computeCoolOffUntil(Date.now());
                                setChannelKeyCoolOff(prev => ({ ...prev, [env.channel_id]: until }));
                            }
                            continue;
                        }
                        console.log(`[Channels] Received epoch ${env.epoch} key for channel ${env.channel_id} (${stored})`);
                    }
                    ackIds.push(env.envelope_id);
                    envelopeFailureCountRef.current.delete(channelEpochKey(env.channel_id, env.epoch));
                    // A successful install clears any prior give-up cool-off for
                    // this channel — whatever was wrong resolved itself (a fresh
                    // redistribution, a TOFU pin clearing, etc).
                    setChannelKeyCoolOff(prev => {
                        if (!(env.channel_id in prev)) return prev;
                        const next = { ...prev };
                        delete next[env.channel_id];
                        return next;
                    });
                } catch (e) {
                    recordDelivery('channel_key_decrypt', e, { envelope_id: env.envelope_id, channel_id: env.channel_id, epoch: env.epoch });
                    console.warn('[Channels] Failed to process key envelope:', e);
                    // Poison-envelope bound: ACKing on the FIRST failure (the old
                    // behavior) permanently destroyed a key that merely hit a
                    // transient decrypt error (e.g. a distributor's identity not
                    // pinned yet racing this pull). Never ACKing at all replays
                    // the same broken envelope forever if it's genuinely
                    // corrupted. Retry up to CHANNEL_KEY_RETRY_LIMIT pulls before
                    // giving up and entering a cool-off — a fresh
                    // request/re-distribution can still resolve it after that,
                    // just not on every single pull in the meantime.
                    const key = channelEpochKey(env.channel_id, env.epoch);
                    const failCount = (envelopeFailureCountRef.current.get(key) ?? 0) + 1;
                    if (shouldGiveUpOnChannelKey(failCount)) {
                        ackIds.push(env.envelope_id);
                        envelopeFailureCountRef.current.delete(key);
                        const until = computeCoolOffUntil(Date.now());
                        setChannelKeyCoolOff(prev => ({ ...prev, [env.channel_id]: until }));
                    } else {
                        envelopeFailureCountRef.current.set(key, failCount);
                    }
                }
            }

            if (ackIds.length) {
                await axios.post(
                    `${API_BASE}/servers/${serverId}/channel-keys/ack`,
                    { envelope_ids: ackIds },
                    { headers: { Authorization: `Bearer ${token}` } }
                ).catch(() => { /* non-fatal */ });
            }
        } catch (e) {
            // Non-fatal — new members will get keys on next pullChannelKeys call
            console.warn('[Channels] pullChannelKeys failed:', e);
        } finally {
            pullChannelKeysInFlightRef.current.delete(serverId);
        }
    }, [token, deviceId]);

    // ── Channel key backfill protocol ────────────────────────────────────────
    // Persistent key-requests + on-demand distribution. Pure decision logic
    // lives in utils/channelKeyDistribution.ts; everything here is the
    // effectful side (IPC, REST, WS-event plumbing).

    // Composer gate: channelId → true while the server has Sender Keys for a
    // text channel that this device doesn't hold yet.
    const [awaitingChannelKeys, setAwaitingChannelKeys] = useState<Record<string, boolean>>({});
    // Phase 4c: channelId → cool-off-until (ms epoch). Set when pullChannelKeys
    // gives up on installing a channel's key after CHANNEL_KEY_RETRY_LIMIT
    // attempts — ChatPane renders a distinct "couldn't install, retrying
    // later" state instead of the indefinite "Waiting for channel keys…",
    // and requestMissingChannelKeys/fileKeyRequest skip re-filing a request
    // for the channel until the window passes (no point hammering a request
    // that just failed to install 3 times in a row).
    const [channelKeyCoolOff, setChannelKeyCoolOff] = useState<Record<string, number>>({});
    // 60s in-session dedup of filed key requests (channelId → last POST ts).
    const keyRequestDedupRef = useRef<Map<string, number>>(new Map());
    // Requests currently being served, so overlapping sweeps don't double-send.
    const servingKeyRequestsRef = useRef<Set<string>>(new Set());
    // Phase 4c (RC-9 follow-on): serverIds currently mid-pullChannelKeys, so
    // an overlapping WS push + sweep + 75s timer can't decrypt/process the
    // same envelope batch concurrently from two call stacks at once.
    const pullChannelKeysInFlightRef = useRef<Set<string>>(new Set());
    // Per-(channel,epoch) failed-install attempt counter — see
    // channelEpochKey / CHANNEL_KEY_RETRY_LIMIT in channelKeyDistribution.ts.
    const envelopeFailureCountRef = useRef<Map<string, number>>(new Map());
    // channel_ids with at least one undecryptable message (live or history)
    // — read by the retry timer below so history gets periodic recovery
    // attempts too, not just a one-shot request at the moment of failure.
    const undecryptableChannelsRef = useRef<Set<string>>(new Set());
    // channelId → when a key request was FIRST filed for it (unlike
    // keyRequestDedupRef, which tracks the MOST RECENT request). Read by the
    // retry timer's fallback-rotation check: "has this been stuck long
    // enough that no holder is ever coming back." Loosely maintained (not
    // cleared on every possible recovery path) is fine — a stale entry only
    // means fallback rotation might fire slightly eagerly, and the
    // server-arbitrated recordEpoch race makes that self-healing, not wrong.
    const firstKeyRequestTimeRef = useRef<Map<string, number>>(new Map());
    // channel_ids currently minting via bootstrapAndDistributeChannelKey.
    // The create-server flow, the pendingChannelSelect auto-select, the
    // sweep's active-channel self-heal, and the mint-after-key-request path
    // can all race the same never-minted channel from this one device —
    // without this guard a second concurrent call mints a needless epoch 2
    // on top of the first mint's still-in-flight epoch 1.
    const bootstrapInFlightRef = useRef<Set<string>>(new Set());

    /**
     * Encrypt the given epochs of a channel's Sender Keys to each recipient
     * device and POST them as key-handshake envelopes (grouped per recipient
     * user, chunked ≤20 per call — the API's hard cap). Failures are
     * non-fatal warns: the request/retry protocol re-covers them.
     */
    const distributeChannelKeys = useCallback(async (
        serverId: string,
        channelId: string,
        epochs: number[],
        // sig_b64 + identity_pub_b64 must survive all the way to encryptMessage:
        // e2ee-engine verifies the SPK signature (CRIT-7) and skips any device
        // missing them. Dropping them in this projection silently produced zero
        // envelopes for every recipient.
        recipients: ChannelKeyRecipient[],
        rotationReason: string,
    ) => {
        if (!token || !userId || !epochs.length || !recipients.length) return;
        const byUser = new Map<string, Omit<ChannelKeyRecipient, 'user_id'>[]>();
        for (const r of recipients) {
            if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
            byUser.get(r.user_id)!.push({
                device_id: r.device_id,
                spk_pub_b64: r.spk_pub_b64,
                sig_b64: r.sig_b64,
                identity_pub_b64: r.identity_pub_b64,
            });
        }
        for (const epoch of epochs) {
            const keyB64 = await window.electronAPI!.getChannelKey(channelId, epoch);
            if (!keyB64) continue; // pruned locally — another holder may still cover it
            for (const [recipientUserId, devices] of byUser) {
                const envelopes: { device_id: string; ciphertext_b64: string }[] = [];
                for (const dev of devices) {
                    try {
                        const content = buildChannelKeyContent({
                            channelId, epoch, keyB64, deviceId: dev.device_id, rotationReason,
                        });
                        // RC-7 / Phase 5: pass our own device id so the recipient can pin
                        // this distributor per (us, this-device) instead of per-user —
                        // the channel-key path is where the old per-user TOFU pin hard-
                        // rejected a second device of an already-known contact.
                        const ct = await window.electronAPI!.encryptMessage(JSON.stringify(content), userId, [dev], deviceId ?? undefined);
                        envelopes.push({ device_id: dev.device_id, ciphertext_b64: ct });
                    } catch (e) {
                        // Per-device failure is non-fatal, but must never be silent:
                        // a 100%-failing wrap used to look identical to "nothing to do".
                        console.warn('[Channels] Failed to wrap channel key for device', dev.device_id, e);
                    }
                }
                if (devices.length && !envelopes.length) {
                    console.error(
                        `[Channels] Wrapped 0/${devices.length} envelopes for channel ${channelId} epoch ${epoch} ` +
                        `— recipient ${recipientUserId} will stay stuck waiting for keys. ` +
                        `Check that the devices endpoint returns sig_b64 + identity_pub_b64.`,
                    );
                }
                for (const chunk of chunkEnvelopes(envelopes)) {
                    await axios.post(
                        `${API_BASE}/servers/${serverId}/key-handshake`,
                        { recipient_user_id: recipientUserId, channel_id: channelId, epoch, envelopes: chunk },
                        { headers: { Authorization: `Bearer ${token}` } }
                    ).catch(e => console.warn('[Channels] key-handshake failed for', channelId, 'epoch', epoch, e));
                    await new Promise(r => setTimeout(r, 100)); // throttle headroom
                }
            }
        }
    }, [token, userId, deviceId]);

    /**
     * Mint epoch 1 for a never-bootstrapped channel, record the epoch
     * metadata, then seed the key to every current member device with VIEW —
     * a brand-new channel becomes decryptable server-wide immediately instead
     * of only by whoever opened it first.
     */
    const bootstrapAndDistributeChannelKey = useCallback(async (serverId: string, channelId: string) => {
        if (!token || !deviceId) return;
        // The create-server flow, the auto-select on channel open, the
        // sweep's active-channel self-heal, and mint-after-key-request can
        // all reach this for the same never-minted channel from this one
        // device — let the first caller do the work, the rest no-op.
        if (bootstrapInFlightRef.current.has(channelId)) return;
        bootstrapInFlightRef.current.add(channelId);
        try {
            const { epoch } = await window.electronAPI!.rotateChannelKey(channelId);
            console.log(`[Channels] Bootstrapped new Sender Key for channel ${channelId} epoch=${epoch}`);
            const localFingerprint = await window.electronAPI!.getChannelKeyFingerprint(channelId, epoch);
            if (!localFingerprint) return; // key vanished under us — bail rather than distribute nothing

            // The key is now installed locally and usable for our own sends
            // regardless of how arbitration below turns out — clear the gate
            // immediately rather than leaving it to a later, easily-skipped
            // code path. If arbitration is lost below, that branch re-sets it
            // (we discard this key and go back to waiting on the real winner's).
            setAwaitingChannelKeys(prev => {
                if (!prev[channelId]) return prev;
                const next = { ...prev };
                delete next[channelId];
                return next;
            });

            // Record epoch metadata (with our key's fingerprint) with retries —
            // this table is load-bearing for more than display now:
            // fulfillment-marking, missing-key detection, AND arbitration all
            // read it. A silently-lost POST here doesn't just delay a UI label,
            // it can leave the channel permanently undetectable-as-keyed (bug
            // this whole feature exists to fix) or leave a genuine two-minter
            // race unresolved. Retry with backoff before giving up; a later
            // repair sweep is the only other way this ever gets recorded.
            let claim: { created: boolean; fingerprint_b64: string | null } | null = null;
            for (const delayMs of [0, 500, 1500]) {
                if (delayMs) await new Promise(r => setTimeout(r, delayMs));
                try {
                    const res = await axios.post(
                        `${API_BASE}/channels/${channelId}/epoch`,
                        { epoch, fingerprint_b64: localFingerprint, rotation_reason: 'create' },
                        { headers: { Authorization: `Bearer ${token}` } }
                    );
                    claim = res.data;
                    break;
                } catch (e) {
                    console.warn('[Channels] Failed to record epoch metadata (will retry):', e);
                }
            }
            if (!claim) {
                // All retries failed — we genuinely don't know if we won the
                // arbitration. Leave the key installed locally (still usable for
                // our own sends) but don't distribute it; the repair sweep in
                // requestMissingChannelKeys reconciles this the next time it runs.
                return;
            }

            // Two members opening a brand-new channel at once can each mint a
            // different epoch-1 key. The server's INSERT ... ON CONFLICT above
            // made exactly one of them the winner; resolveEpochClaim reads that
            // back from {created, fingerprint_b64} without us needing to guess.
            const outcome = resolveEpochClaim({
                localFingerprintB64: localFingerprint,
                created: claim.created,
                serverFingerprintB64: claim.fingerprint_b64,
            });
            if (outcome === 'lost') {
                console.warn(`[Channels] Lost epoch ${epoch} arbitration for channel ${channelId}; discarding and re-requesting`);
                await window.electronAPI?.discardChannelKey(channelId, epoch);
                setAwaitingChannelKeys(prev => ({ ...prev, [channelId]: true }));
                await channelKeyOpsRef.current.fileKeyRequest(serverId, channelId);
                return;
            }

            try {
                const res = await axios.get(
                    `${API_BASE}/servers/${serverId}/channels/${channelId}/recipient-devices`,
                    { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } }
                );
                await distributeChannelKeys(serverId, channelId, [epoch], res.data ?? [], 'create');
            } catch (e) {
                console.warn('[Channels] recipient-devices fetch failed (members will key-request):', e);
            }
        } finally {
            bootstrapInFlightRef.current.delete(channelId);
        }
    }, [token, deviceId, distributeChannelKeys]);

    /** POST a key request for one channel (bypasses the 60s dedup). If the
     *  response says the channel has never been minted anywhere
     *  (latest_epoch === 0), this request can never be answered by anyone —
     *  mint locally instead of leaving the composer waiting on it forever. */
    const fileKeyRequest = useCallback(async (serverId: string, channelId: string) => {
        if (!token || !deviceId) return;
        // Phase 4c: a channel that just gave up after CHANNEL_KEY_RETRY_LIMIT
        // failed install attempts doesn't need a fresh request fired on the
        // very next sweep tick — that's how a genuinely broken channel key
        // hammered the request endpoint every cycle with no chance of a
        // different outcome. Let the cool-off window pass first; an
        // unrelated redistribution (someone else coming online) still
        // reaches this device via the normal push/pull paths regardless.
        if (isCoolingOff(channelKeyCoolOff[channelId], Date.now())) return;
        keyRequestDedupRef.current.set(channelId, Date.now());
        if (!firstKeyRequestTimeRef.current.has(channelId)) {
            firstKeyRequestTimeRef.current.set(channelId, Date.now());
        }
        try {
            const res = await axios.post(
                `${API_BASE}/servers/${serverId}/channels/${channelId}/key-request`,
                {},
                { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } }
            );
            if (shouldMintAfterKeyRequest(res.data?.latest_epoch)) {
                void channelKeyOpsRef.current.bootstrapAndDistributeChannelKey(serverId, channelId);
            }
        } catch (e) {
            console.warn('[Channels] key-request failed for', channelId, e);
        }
    }, [token, deviceId, channelKeyCoolOff]);

    /** fileKeyRequest, but respecting the 60s per-channel dedup instead of
     *  always bypassing it. Safe to call from any decrypt-failure path
     *  without needing to duplicate the dedup check at every call site. */
    const maybeFileKeyRequest = useCallback(async (serverId: string, channelId: string) => {
        const last = keyRequestDedupRef.current.get(channelId) ?? 0;
        if (Date.now() - last < 60_000) return;
        await fileKeyRequest(serverId, channelId);
    }, [fileKeyRequest]);

    /**
     * Pull any waiting envelopes, then compare the server's per-channel
     * latest epoch (from the channels list) against local holdings and file
     * key requests for every text channel this device can see but not
     * decrypt. Also refreshes the composer's awaiting-keys gate. Safe to
     * call often — 60s per-channel dedup.
     */
    const requestMissingChannelKeys = useCallback(async (serverId: string) => {
        if (!token || !deviceId) return;
        try {
            await pullChannelKeys(serverId);
            const res = await axios.get(`${API_BASE}/servers/${serverId}/channels`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const channels: { channel_id: string; kind: string; latest_epoch?: number }[] = res.data ?? [];
            const localLatest: Record<string, number | null> = {};
            for (const c of channels) {
                // Calls channels carry Sender Keys too — their room key is
                // derived from one, so they need the same backfill sweep.
                if (!channelCarriesSenderKeys(c.kind)) continue;
                localLatest[c.channel_id] = await window.electronAPI!.getLatestChannelEpoch(c.channel_id);
            }
            const missing = computeMissingKeyChannels(channels, localLatest);
            const missingSet = new Set(missing);
            // Never-minted channels (latest_epoch === 0) are invisible to
            // computeMissingKeyChannels on purpose — nobody holds a key for
            // them to request. Left alone, this loop would just clear their
            // gate below with no key ever arriving: composer re-enables,
            // send throws, ChatPane re-gates it — a flicker loop. Only the
            // ACTIVE channel's gate is ever visible, so only it needs
            // healing here; a non-active one heals for free the moment it's
            // opened (handleSelectChannel mints directly on latest_epoch 0).
            const unminted = computeUnmintedChannels(channels, localLatest);
            const unmintedSet = new Set(unminted);
            const active = activeChannelRef.current;
            const activeUnminted = active?.server_id === serverId && unmintedSet.has(active.channel_id)
                ? active.channel_id
                : null;
            setAwaitingChannelKeys(prev => {
                const next = { ...prev };
                for (const c of channels) {
                    if (!channelCarriesSenderKeys(c.kind)) continue;
                    if (missingSet.has(c.channel_id) || c.channel_id === activeUnminted) next[c.channel_id] = true;
                    else delete next[c.channel_id];
                }
                return next;
            });
            if (activeUnminted) {
                // Jittered so a server with several members open on this
                // same never-minted channel at once doesn't all fire the
                // mint in the same instant — arbitration converges either
                // way, but spreading it out means only the loser(s) pay for
                // a wasted mint instead of everyone racing simultaneously.
                setTimeout(() => {
                    void channelKeyOpsRef.current.bootstrapAndDistributeChannelKey(serverId, activeUnminted);
                }, pickJitterMs());
            }
            const now = Date.now();
            for (const cid of missing) {
                const last = keyRequestDedupRef.current.get(cid) ?? 0;
                if (now - last < 60_000) continue;
                await fileKeyRequest(serverId, cid);
                // Space requests out — a rejoin or reconnect can hit dozens of
                // channels in this loop, and firing them all back to back
                // would burn through the 60/min throttle in under a second.
                await new Promise(r => setTimeout(r, 150));
            }

            // ── Split-brain repair + full-epoch-set backfill sweep ──────────
            // For every epoch this device already holds, compare its
            // fingerprint against the server's arbitrated record. A mismatch
            // means we lost a race we never observed (offline when the
            // winner claimed it, or the divergence predates this repair
            // mechanism) — discard and re-request. A missing/null server
            // fingerprint means nobody has claimed this epoch yet — claim it
            // so a LATER divergence gets caught instead of staying silent.
            // Separately (not just latest-vs-local like the missing[] pass
            // above): request every server-known epoch we don't hold AT ALL,
            // so a device stuck on epoch 5 while missing 1–4 eventually
            // recovers old history instead of sitting on it forever with the
            // composer fully enabled. Composer gating only keys off the
            // channel's LATEST epoch being unreachable — missing intermediates
            // must not block sending.
            try {
                const epochsRes = await axios.get(`${API_BASE}/servers/${serverId}/key-epochs`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                const serverEpochs: { channel_id: string; epochs: ServerEpochInfo[] }[] = epochsRes.data ?? [];
                const serverByChannel = new Map(serverEpochs.map(e => [e.channel_id, e.epochs]));

                for (const c of channels) {
                    if (!channelCarriesSenderKeys(c.kind)) continue;
                    const localFps = await window.electronAPI!.listChannelEpochFingerprints(c.channel_id);
                    let heldEpochs = Object.keys(localFps).map(Number);
                    const serverEpochList = serverByChannel.get(c.channel_id) ?? [];
                    if (!heldEpochs.length && !serverEpochList.length) continue;
                    const serverByEpoch = new Map(serverEpochList.map(e => [e.epoch, e]));

                    for (const epoch of heldEpochs) {
                        const action = resolveEpochDivergence(localFps[epoch], serverByEpoch.get(epoch));
                        if (action === 'keep') continue;
                        if (action === 'claim') {
                            axios.post(
                                `${API_BASE}/channels/${c.channel_id}/epoch`,
                                { epoch, fingerprint_b64: localFps[epoch], rotation_reason: 'backfill' },
                                { headers: { Authorization: `Bearer ${token}` } }
                            ).catch(() => { /* next sweep retries */ });
                        } else {
                            console.warn(`[Channels] Repair: discarding diverged epoch ${epoch} for channel ${c.channel_id}`);
                            await window.electronAPI?.discardChannelKey(c.channel_id, epoch);
                            heldEpochs = heldEpochs.filter(e => e !== epoch);
                        }
                    }

                    const { missingEpochs, missingLatest } = computeMissingEpochsForChannel(serverEpochList, heldEpochs, Date.now());
                    if (missingLatest) {
                        setAwaitingChannelKeys(prev => ({ ...prev, [c.channel_id]: true }));
                    }
                    if (missingEpochs.length) {
                        const last = keyRequestDedupRef.current.get(c.channel_id) ?? 0;
                        if (Date.now() - last >= 60_000) await fileKeyRequest(serverId, c.channel_id);
                    }
                }
            } catch (e) {
                console.warn('[Channels] Repair sweep failed (non-fatal):', e);
            }
        } catch (e) {
            console.warn('[Channels] requestMissingChannelKeys failed:', e);
        }
    }, [token, deviceId, pullChannelKeys, fileKeyRequest]);

    /**
     * RC-10 / Phase 6: fetch this server's pinned-epoch set and tell the main
     * process to protect exactly those epochs (per channel) from
     * pruneOldKeys — otherwise a pinned message's epoch can age out locally
     * before anyone ever redistributes it to a future joiner. Called on
     * server open and hourly (see the two effects below `serveKeyRequests`),
     * and reused by the distributors below so they don't issue a second,
     * redundant fetch just to log unservable pins.
     * 404-tolerant: an older API build without this endpoint simply means
     * nothing gets protected — no worse than the pre-Phase-6 behavior.
     */
    const refreshProtectedEpochs = useCallback(async (serverId: string): Promise<Map<string, number[]>> => {
        const byChannel = new Map<string, number[]>();
        if (!token) return byChannel;
        try {
            const res = await axios.get(`${API_BASE}/servers/${serverId}/pinned-epochs`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            for (const p of (res.data ?? []) as { channel_id: string; epoch: number }[]) {
                if (!byChannel.has(p.channel_id)) byChannel.set(p.channel_id, []);
                byChannel.get(p.channel_id)!.push(p.epoch);
            }
            for (const [channelId, epochs] of byChannel) {
                await window.electronAPI?.setProtectedEpochs(channelId, epochs);
            }
        } catch (e: any) {
            if (e?.response?.status !== 404) {
                console.warn('[Channels] Failed to refresh pinned epochs for', serverId, e);
            }
        }
        return byChannel;
    }, [token]);

    /**
     * Answer open key requests in a server with every epoch this device
     * holds. Runs on connect (all servers) and after a jittered delay on the
     * `server:key_requested` push. Re-fetching the pending list right before
     * answering collapses multi-holder storms: the first delivery marks the
     * request fulfilled server-side and later responders see an empty list.
     */
    const serveKeyRequests = useCallback(async (serverId: string) => {
        if (!token || !deviceId) return;
        try {
            const res = await axios.get(`${API_BASE}/servers/${serverId}/key-requests/pending`, {
                headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId },
            });
            const pending: { request_id: string; channel_id: string; requester_user_id: string; requester_device_id: string }[] = res.data ?? [];
            // RC-10: fetched (and used to refresh main-process protection) once
            // per sweep, not once per request — a request storm shouldn't cost
            // one GET each just to log the same per-channel pin gaps repeatedly.
            const pinnedByChannel = pending.length ? await refreshProtectedEpochs(serverId) : new Map<string, number[]>();
            for (const req of pending) {
                if (servingKeyRequestsRef.current.has(req.request_id)) continue;
                servingKeyRequestsRef.current.add(req.request_id);
                try {
                    const epochs = await window.electronAPI!.listChannelEpochs(req.channel_id);
                    if (!epochs.length) continue; // we hold nothing for this channel
                    const { unservable } = computeEpochsToDistribute(epochs, pinnedByChannel.get(req.channel_id) ?? [], undefined);
                    if (unservable.length) {
                        console.error(`[Channels] Pinned epoch(s) ${unservable.join(',')} for channel ${req.channel_id} not held by this device — cannot serve them; another holder may still cover it`);
                    }
                    const devRes = await axios.get(
                        `${API_BASE}/servers/${serverId}/members/${req.requester_user_id}/devices`,
                        { headers: { Authorization: `Bearer ${token}` } }
                    );
                    const dev = (devRes.data ?? []).find((d: { device_id: string }) => d.device_id === req.requester_device_id);
                    if (!dev) continue; // device gone/revoked — sweep will clean the request
                    await distributeChannelKeys(
                        serverId, req.channel_id, epochs,
                        [{ user_id: req.requester_user_id, ...dev }],
                        'backfill',
                    );
                } finally {
                    servingKeyRequestsRef.current.delete(req.request_id);
                }
            }
        } catch (e) {
            console.warn('[Channels] serveKeyRequests failed:', e);
        }
    }, [token, deviceId, distributeChannelKeys, refreshProtectedEpochs]);

    // Always-current ref so the earlier-defined handleSelectChannel can call
    // into the protocol without dependency churn (serverChannelsRef pattern).
    const channelKeyOpsRef = useRef({ bootstrapAndDistributeChannelKey, fileKeyRequest, pullChannelKeys, maybeFileKeyRequest });
    useEffect(() => {
        channelKeyOpsRef.current = { bootstrapAndDistributeChannelKey, fileKeyRequest, pullChannelKeys, maybeFileKeyRequest };
    });

    /** Mint & distribute a freshly created text channel's Sender Key
     *  immediately, instead of waiting for whoever opens it first. Wired as
     *  the `onChannelCreated` callback on both channel-creation dialogs.
     *  Defined AFTER bootstrapAndDistributeChannelKey, so — unlike
     *  handleSelectChannel above — it can close over it directly instead of
     *  going through channelKeyOpsRef. */
    const handleChannelCreated = useCallback((serverId: string, channel: { channel_id: string; kind: string }) => {
        // Calls channels need epoch 1 minted at creation too, or the first
        // member to join a call sits on "Waiting for channel keys…" forever.
        if (!channelCarriesSenderKeys(channel.kind)) return;
        void bootstrapAndDistributeChannelKey(serverId, channel.channel_id);
    }, [bootstrapAndDistributeChannelKey]);

    // Connect-time sweep over every server: answer requests filed while this
    // device was offline, pull waiting envelopes, and file our own requests.
    // This is what makes the protocol converge without any online overlap at
    // join time — persistent server state bridges the sessions.
    useEffect(() => {
        if (!token || !deviceId || wsConnectCount === 0 || servers.length === 0) return;
        // Jittered start: a gateway pod roll reconnects every socket at once,
        // so every online holder in a server would otherwise fire this sweep
        // in the same instant — a real thundering herd, not the collapsed
        // storm the reactive (server:key_requested) path achieves via its own
        // jitter. Spreading the START of the sweep is enough; requests are
        // idempotent either way, this just avoids the burst.
        const t = setTimeout(() => {
            (async () => {
                for (const srv of servers) {
                    await serveKeyRequests(srv.server_id);
                    await requestMissingChannelKeys(srv.server_id);
                }
            })().catch(() => { /* non-fatal */ });
        }, pickJitterMs());
        return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token, deviceId, wsConnectCount, servers.length]);

    // RC-10 / Phase 6: refresh which epochs are pin-protected whenever a
    // server is opened — this is the common case that actually matters (the
    // member about to view pinned messages is exactly who needs their own
    // device to still hold the key), plus hourly for every joined server so
    // protection stays current even for servers this session never opens.
    useEffect(() => {
        if (!activeServerView?.serverId) return;
        void refreshProtectedEpochs(activeServerView.serverId);
    }, [activeServerView?.serverId, refreshProtectedEpochs]);

    useEffect(() => {
        if (!token || !deviceId) return;
        const id = setInterval(() => {
            for (const srv of serversRef.current) void refreshProtectedEpochs(srv.server_id);
        }, 60 * 60 * 1000);
        return () => clearInterval(id);
    }, [token, deviceId, refreshProtectedEpochs]);

    /**
     * Recovery path for a channel that's been gated a long time with no
     * key-holder ever answering: mint a fresh epoch at (server's latest + 1)
     * so this device can send again. History stays locked until an
     * old-epoch holder eventually returns — that part is cryptographically
     * unavoidable, we can't retroactively decrypt messages encrypted under a
     * key we never had — but sending recovers instead of staying stuck
     * forever. Server-arbitrated via the same recordEpoch race resolution as
     * any other mint: if a holder came back online moments before this fires
     * and answered the request instead, this device loses arbitration,
     * discards its attempt, and re-requests — no new divergence, matching
     * the split-brain repair already in place for the create-time race.
     */
    const attemptFallbackRotation = useCallback(async (serverId: string, channelId: string) => {
        if (!token || !deviceId) return;
        try {
            const epochRes = await axios.get(`${API_BASE}/channels/${channelId}/epoch`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const serverLatest: number = epochRes.data?.epoch ?? 0;
            const { epoch } = await window.electronAPI!.rotateChannelKey(channelId, serverLatest + 1);
            const localFingerprint = await window.electronAPI!.getChannelKeyFingerprint(channelId, epoch);
            if (!localFingerprint) return;

            const recordRes = await axios.post(
                `${API_BASE}/channels/${channelId}/epoch`,
                { epoch, fingerprint_b64: localFingerprint, rotation_reason: 'recovery' },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            const outcome = resolveEpochClaim({
                localFingerprintB64: localFingerprint,
                created: recordRes.data.created,
                serverFingerprintB64: recordRes.data.fingerprint_b64,
            });
            if (outcome === 'lost') {
                console.warn(`[Channels] Fallback rotation lost arbitration for channel ${channelId} — a holder answered first`);
                await window.electronAPI?.discardChannelKey(channelId, epoch);
                await fileKeyRequest(serverId, channelId);
                return;
            }

            console.log(`[Channels] Fallback-rotated channel ${channelId} to epoch ${epoch} — sending recovered`);
            firstKeyRequestTimeRef.current.delete(channelId);
            // Distribute every locally held epoch (not just the new one) so
            // any member who reconnects gets whatever history this device
            // does hold, same as the member_join/backfill distribution paths.
            const heldEpochs = await window.electronAPI!.listChannelEpochs(channelId);
            try {
                const res = await axios.get(
                    `${API_BASE}/servers/${serverId}/channels/${channelId}/recipient-devices`,
                    { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } }
                );
                await distributeChannelKeys(serverId, channelId, heldEpochs, res.data ?? [], 'recovery');
            } catch (e) {
                console.warn('[Channels] recipient-devices fetch failed after fallback rotation:', e);
            }
            // Sending recovers immediately (latest epoch now installed);
            // if intermediate history is still missing, the next sweep's
            // computeMissingEpochsForChannel re-derives that independently —
            // it doesn't gate the composer either way.
            setAwaitingChannelKeys(prev => {
                if (!prev[channelId]) return prev;
                const next = { ...prev };
                delete next[channelId];
                return next;
            });
        } catch (e) {
            console.warn('[Channels] Fallback rotation failed for', channelId, e);
        }
    }, [token, deviceId, distributeChannelKeys, fileKeyRequest]);

    // ── Calls-channel Sender-Key rotation on lost access ──────────────────────
    //
    // Driven by `server:channel_key_rotation_needed`, which the API pushes to
    // the POST-change authorized holder set when someone LOSES access to a
    // Calls channel (role edit, channel/category override, kick, ban, leave).
    // See utils/channelKeyDistribution's rotation section for the full rationale
    // and for every pure decision this orchestrates.
    //
    // Fails CLOSED and QUIET: every abort path leaves the PREVIOUS epoch
    // installed and in use, which is exactly today's behaviour — so a failed
    // rotation is a no-op, never a broken call, a broken channel, or a failed
    // admin action. Nothing here is user-visible.
    const rotationInFlightRef = useRef<Set<string>>(new Set());
    const rotationTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    /** At most one queued trailing rotation per channel — see
     *  decideRotationScheduling's 'queue_followup'. */
    const rotationFollowupRef = useRef<Map<string, { serverId: string; reason: string }>>(new Map());
    const rotationOpsRef = useRef<{
        rotate: (serverId: string, channelId: string, reason: string) => Promise<void>;
        schedule: (serverId: string, channelId: string, reason: string) => void;
    }>({ rotate: async () => {}, schedule: () => {} });

    const rotateCallsChannelKey = useCallback(async (
        serverId: string,
        channelId: string,
        reason: string,
    ) => {
        if (!token || !deviceId) return;

        const kind = (serverChannelsRef.current[serverId] ?? [])
            .find(c => c.channel_id === channelId)?.kind;
        let localLatest: number | null = null;
        try {
            localLatest = await window.electronAPI!.getLatestChannelEpoch(channelId);
        } catch {
            return; // IPC unavailable — stand down; the pre-existing key stays valid.
        }

        const decision = decideRotationAction({ channelKind: kind, holdsLocalKey: localLatest != null });
        if (decision !== 'rotate') {
            // Not an error: the audience is every remaining holder, so most of
            // these are "somebody else is better placed to do this". Logged
            // (not silent) because a channel nobody rotates is a real gap.
            console.log(`[Channels] Rotation signal for ${channelId} → ${decision}`);
            return;
        }

        rotationInFlightRef.current.add(channelId);
        try {
            // Server's arbitrated latest, fetched FRESH — a rotation may have
            // landed server-side whose envelopes haven't reached us yet.
            const epochRes = await axios.get(`${API_BASE}/channels/${channelId}/epoch`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const target = computeRotationEpoch(epochRes.data?.epoch ?? 0, localLatest);
            if (target == null) return; // never bootstrapped anywhere — not rotation's job

            const { epoch } = await window.electronAPI!.rotateChannelKey(channelId, target);
            const localFingerprint = await window.electronAPI!.getChannelKeyFingerprint(channelId, epoch);
            if (!localFingerprint) {
                await window.electronAPI?.discardChannelKey(channelId, epoch);
                return;
            }

            const rotationReason = normalizeRotationReason(reason);
            // Same retry ladder as the bootstrap mint: a lost POST here can't be
            // recovered by the caller, and this table is what arbitrates the
            // concurrent-minter race that every remaining holder is running
            // right now.
            let claim: { created: boolean; fingerprint_b64: string | null } | null = null;
            for (const delayMs of [0, 500, 1500]) {
                if (delayMs) await new Promise(r => setTimeout(r, delayMs));
                try {
                    const res = await axios.post(
                        `${API_BASE}/channels/${channelId}/epoch`,
                        { epoch, fingerprint_b64: localFingerprint, rotation_reason: rotationReason },
                        { headers: { Authorization: `Bearer ${token}` } }
                    );
                    claim = res.data;
                    break;
                } catch (e) {
                    console.warn('[Channels] Rotation epoch record failed (will retry):', e);
                }
            }

            const outcome = resolveRotationClaim({ claim, localFingerprintB64: localFingerprint });
            if (outcome !== 'distribute') {
                // Unlike the bootstrap mint we always DISCARD here: the previous
                // epoch is still valid and still in use by everyone, so keeping
                // an unregistered/losing higher epoch would only make us publish
                // under material nobody else can obtain.
                await window.electronAPI?.discardChannelKey(channelId, epoch);
                if (outcome === 'discard_and_request') {
                    // Another remaining holder won the race — their epoch is the
                    // real one; ask for it. We keep decrypting under the old
                    // epoch until it lands, so nothing is gated meanwhile.
                    console.log(`[Channels] Lost rotation race for ${channelId} epoch ${epoch} — requesting the winner's key`);
                    await fileKeyRequest(serverId, channelId);
                } else {
                    console.warn(`[Channels] Could not register rotated epoch ${epoch} for ${channelId} — discarded; previous key stays in use`);
                }
                return;
            }

            // Recipient list fetched FRESH and AFTER the access change, never a
            // cached member list: getChannelRecipientDevices resolves through
            // viewersOf → VIEW_CHANNEL | CONNECT for Calls channels, which is
            // what actually excludes the demoted member. If this fetch fails we
            // have a registered epoch nobody else holds yet — recoverable, since
            // every other member's own key-request sweep will ask us for it.
            const res = await axios.get(
                `${API_BASE}/servers/${serverId}/channels/${channelId}/recipient-devices`,
                { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } }
            );
            // Only the NEW epoch: a Calls channel is live media with no history,
            // and every remaining holder already has the older epochs.
            await distributeChannelKeys(serverId, channelId, [epoch], res.data ?? [], rotationReason);
            console.log(`[Channels] Rotated Calls channel ${channelId} to epoch ${epoch} (${rotationReason})`);
        } catch (e) {
            console.warn('[Channels] Calls-channel rotation failed for', channelId, e);
        } finally {
            rotationInFlightRef.current.delete(channelId);
            const followup = rotationFollowupRef.current.get(channelId);
            if (followup) {
                // An access change landed while we were mid-rotation, so the
                // recipient list we just used predates it — the member it
                // demoted may have received the epoch we just distributed. Run
                // exactly one more pass, now that their demotion is applied.
                rotationFollowupRef.current.delete(channelId);
                rotationOpsRef.current.schedule(followup.serverId, channelId, followup.reason);
            }
        }
    }, [token, deviceId, distributeChannelKeys, fileKeyRequest]);

    /** Jitter-schedule at most one rotation per channel. Every remaining holder
     *  receives the same event in the same instant, so without the jitter they
     *  would all mint simultaneously and all but one would lose arbitration and
     *  immediately re-request — correct, but a needless storm. */
    const scheduleCallsChannelRotation = useCallback((
        serverId: string,
        channelId: string,
        reason: string,
    ) => {
        const action = decideRotationScheduling({
            armed: rotationTimersRef.current.has(channelId),
            inFlight: rotationInFlightRef.current.has(channelId),
        });
        if (action === 'ride') return;
        if (action === 'queue_followup') {
            rotationFollowupRef.current.set(channelId, { serverId, reason });
            return;
        }
        const t = setTimeout(() => {
            rotationTimersRef.current.delete(channelId);
            void rotationOpsRef.current.rotate(serverId, channelId, reason);
        }, pickJitterMs());
        rotationTimersRef.current.set(channelId, t);
    }, []);

    useEffect(() => {
        rotationOpsRef.current = { rotate: rotateCallsChannelKey, schedule: scheduleCallsChannelRotation };
    });

    // Drain the rotation queue: ONE rotation per channel per burst. An admin
    // editing several roles in a row (or deleting a role that demotes many
    // members at once) produces a storm of these for the same channel; minting
    // an epoch per event would re-run the whole member×device fan-out each time
    // for no extra security.
    useEffect(() => {
        if (channelKeyRotationEvents.length === 0) return;
        for (const evt of coalesceRotationEvents(channelKeyRotationEvents)) {
            scheduleCallsChannelRotation(evt.server_id, evt.channel_id, evt.reason);
        }
        setChannelKeyRotationEvents([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channelKeyRotationEvents]);

    // Drop pending rotation timers on unmount (sign-out / window teardown) so a
    // fired timer can't touch key material after the session is gone.
    useEffect(() => () => {
        for (const t of rotationTimersRef.current.values()) clearTimeout(t);
        rotationTimersRef.current.clear();
        rotationFollowupRef.current.clear();
    }, []);

    // Periodic retry while any channel is gated or has undecryptable history.
    // Before this, recovery depended entirely on one-shot triggers (channel
    // open, permission grant, connect) — a device that missed its window (the
    // key-holder came online a moment too early or too late) sat on
    // "Couldn't decrypt" / a disabled composer until the user happened to
    // revisit the channel. 75s keeps this cheap: every downstream call is
    // already deduped (60s per-channel key-request dedup, request-fulfilled
    // short-circuits), so a fully-converged server costs one GET per tick.
    const FALLBACK_ROTATION_AFTER_MS = 10 * 60 * 1000;
    useEffect(() => {
        if (!token || !deviceId) return;
        const interval = setInterval(() => {
            const gatedChannelIds = Object.keys(awaitingChannelKeys).filter(cid => awaitingChannelKeys[cid]);
            const affectedChannelIds = new Set([...gatedChannelIds, ...undecryptableChannelsRef.current]);
            if (affectedChannelIds.size === 0) return;
            const affectedServerIds = new Set<string>();
            const channelToServer = new Map<string, string>();
            for (const srv of serversRef.current) {
                const chans = serverChannelsRef.current[srv.server_id] ?? [];
                for (const c of chans) {
                    if (!affectedChannelIds.has(c.channel_id)) continue;
                    affectedServerIds.add(srv.server_id);
                    channelToServer.set(c.channel_id, srv.server_id);
                }
            }
            for (const sid of affectedServerIds) void requestMissingChannelKeys(sid);

            // Fallback rotation: a gated channel with no answer in 10+
            // minutes means no holder is coming back for THIS request cycle
            // — recover sending instead of leaving the composer disabled
            // indefinitely. Only applies to the composer gate (missing
            // LATEST epoch), not merely-undecryptable history.
            for (const cid of gatedChannelIds) {
                const first = firstKeyRequestTimeRef.current.get(cid);
                if (!first || Date.now() - first < FALLBACK_ROTATION_AFTER_MS) continue;
                const sid = channelToServer.get(cid);
                if (!sid) continue;
                void attemptFallbackRotation(sid, cid);
            }
        }, 75_000);
        return () => clearInterval(interval);
    }, [token, deviceId, awaitingChannelKeys, requestMissingChannelKeys, attemptFallbackRotation]);

    // One outstanding jittered serve timer per server (ref, not React state —
    // it must survive across renders without being cancelled by an unrelated
    // server's event landing in between). The OLD single-`setTimeout`-variable
    // version's cleanup cancelled server X's pending serve the instant server
    // Y's event replaced the single nullable slot, silently dropping X's
    // response until the next connect sweep.
    const keyRequestServeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

    // A member device just asked for keys we may hold. Drain the whole
    // queued batch, jitter-schedule ONE serve per distinct server (a second
    // event for a server that already has a pending timer just rides it —
    // serveKeyRequests re-checks the pending list when it fires, so if a
    // faster holder already delivered we stand down instead of duplicating
    // envelopes), then clear the queue.
    useEffect(() => {
        if (keyRequestedEvents.length === 0) return;
        for (const serverId of coalesceKeyRequestEvents(keyRequestedEvents, deviceId)) {
            if (keyRequestServeTimersRef.current.has(serverId)) continue;
            const t = setTimeout(() => {
                keyRequestServeTimersRef.current.delete(serverId);
                void serveKeyRequests(serverId);
            }, pickJitterMs());
            keyRequestServeTimersRef.current.set(serverId, t);
        }
        setKeyRequestedEvents([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keyRequestedEvents]);

    // ── Notification click-to-focus, quick reply, and tray events ───────────────
    // Open the right conversation/channel when an OS toast is clicked; send a
    // reply when the user types in an inline-reply toast (macOS + Windows); and respond to
    // tray menu actions (status change, pause notifications, sign out).
    // Forward reference: handleChannelMessageSent is defined further down this
    // component, after this callback. Mirrored into a ref (the same idiom as
    // conversationsRef) so the quick-reply path can reach it without a TDZ
    // hazard in the dependency array.
    const handleChannelMessageSentRef = useRef<((msg: any) => void) | null>(null);

    /**
     * Send a message typed into an OS toast's inline reply field.
     *
     * This runs while the app is backgrounded, so it cannot lean on anything the
     * composer relies on — there is no mounted ChatPane, no activeChat, and the
     * conversation list may not have hydrated yet. Four things it must get right,
     * each of which was previously wrong and produced the same user-visible
     * symptom ("my reply didn't go through"):
     *
     *  1. Route by target KIND. Channel toasts advertise a reply field too, but
     *     channels encrypt under an epoch key, not per-recipient-device ECIES.
     *     The old code looked the id up in the conversation list only and
     *     `return`ed on a miss, so every server-channel reply was dropped.
     *  2. Survive an unhydrated conversation list. A toast can fire before the
     *     list loads, and a Windows toast can be replied to from the Action
     *     Center much later — so a lookup miss triggers a re-resolve rather than
     *     a silent bail.
     *  3. Append optimistically. There is NO self-fan-out: the server excludes
     *     the sending device from the envelope list, and the local encrypted
     *     store is the only copy this device will ever have. Without this append
     *     a perfectly successful send is invisible here forever — the peer gets
     *     it, the sender never sees it.
     *  4. Report failures. Everything used to collapse into a console.warn that
     *     no user will ever read.
     */
    const sendQuickReply = useCallback(async (convId: string, rawText: string) => {
        if (!token || !deviceId || !userId) {
            toast.push({ kind: 'error', title: 'Reply not sent', message: 'Open Cipherline and sign in to reply.' });
            return;
        }

        const normalized = normalizeQuickReplyText(rawText);
        if (!normalized.ok) {
            // An empty reply is a no-op, not an error worth a toast.
            if (normalized.reason === 'too_long') {
                toast.push({
                    kind: 'error',
                    title: 'Reply not sent',
                    message: `Messages are capped at ${normalized.limit.toLocaleString()} characters.`,
                });
            }
            return;
        }
        const text = normalized.text;

        const auth = { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } };
        let target = resolveQuickReplyTarget(
            convId,
            conversationsRef.current as any,
            serverChannelsRef.current as any,
        );

        // (2) The id matched nothing loaded. Refresh the conversation list from
        //     the network before concluding we can't place it.
        if (target.kind === 'unknown') {
            try {
                const res = await axios.get(`${API_BASE}/conversations`, auth);
                target = resolveQuickReplyTarget(convId, (res.data ?? []) as any, serverChannelsRef.current as any);
            } catch {
                // Fall through: treated as a channel below, which fails loudly.
            }
        }

        const clientMsgId = newClientMsgId();
        const content = buildQuickReplyContent(text, clientMsgId);

        try {
            if (target.kind === 'dm') {
                // claim_otp=1: consume a one-time prekey per recipient device (per-message forward secrecy)
                const devicesRes = await axios.get(`${API_BASE}/conversations/${convId}/devices?claim_otp=1`, auth);
                const recipientDevices = devicesRes.data as { device_id: string; spk_pub_b64: string }[];
                // RC-2: address exactly the devices that got wrapped. Same
                // encrypt-then-send pipeline the composer uses — the plaintext
                // never leaves this process unencrypted.
                const { ciphertext_b64, recipient_device_ids } = await encryptAndAddress(
                    JSON.stringify(content), userId, recipientDevices, deviceId,
                );
                await axios.post(
                    `${API_BASE}/messages/send`,
                    {
                        conversation_id: convId,
                        recipient_device_ids,
                        envelope_type: 'signal_chat',
                        ciphertext_b64,
                        sent_at_client: new Date().toISOString(),
                    },
                    auth,
                );
                // (3) Load-bearing: without this the message never appears here.
                handleOptimisticMessage({
                    id: clientMsgId,
                    content,
                    sender_device_id: deviceId,
                    timestamp: new Date().toISOString(),
                    conversation_id: convId,
                });
            } else {
                // A channel, or an id we still can't place — a channel send is
                // the only remaining possibility. If it isn't one, encryption
                // throws ("no channel key") or the API rejects it, and either
                // way the catch below tells the user instead of swallowing it.
                const channelId = target.kind === 'channel' ? target.channelId : convId;
                const { epoch, nonce_b64, ciphertext_b64, signature_b64 } =
                    await window.electronAPI!.encryptChannelMessage(JSON.stringify(content), channelId, { user_id: userId, device_id: deviceId });
                const resp = await axios.post(
                    `${API_BASE}/channels/${channelId}/messages`,
                    { sender_device_id: deviceId, epoch, nonce_b64, ciphertext_b64, signature_b64 },
                    auth,
                );
                handleChannelMessageSentRef.current?.({
                    id: resp.data?.id ?? clientMsgId,
                    content,
                    sender_device_id: deviceId,
                    sender_user_id: resp.data?.sender_user_id ?? null,
                    timestamp: new Date().toISOString(),
                    conversation_id: channelId,
                });
            }
        } catch (e) {
            // (4) Never silent: a dropped reply is indistinguishable from a sent
            //     one otherwise, which is exactly the reported bug.
            console.warn('[Notif] quick reply failed:', e);
            toast.push({ kind: 'error', title: 'Reply not sent', message: describeQuickReplyError(e) });
        }
    }, [token, deviceId, userId, toast, handleOptimisticMessage]);

    const openFromNotification = useCallback((convId: string) => {
        // Try DM/group first.
        const conv = conversationsRef.current.find((c: any) => c.id === convId || c.conversation_id === convId);
        if (conv) {
            handleStartChat({
                id: conv.id ?? conv.conversation_id,
                title: conv.title ?? conv.name,
                type: conv.type,
                other_user_id: conv.other_user_id,
                avatar_url: conv.avatar_url,
            });
            return;
        }
        // Otherwise look for a channel with this id across all loaded servers.
        for (const [serverId, chans] of Object.entries(serverChannelsRef.current)) {
            const ch = (chans as ChannelInfo[]).find(c => c.channel_id === convId);
            if (ch) {
                const srv = serversRef.current.find(s => s.server_id === serverId);
                setActiveTab('servers');
                setActiveServerView({ serverId, serverName: srv?.name ?? 'Server' });
                loadChannels(serverId);
                void requestMissingChannelKeys(serverId);
                handleSelectChannel(ch);
                return;
            }
        }
    }, [handleStartChat, handleSelectChannel, loadChannels, requestMissingChannelKeys]);

    // PERF: bound ONCE. The handlers change identity on almost every dashboard
    // render (openFromNotification alone depends on four callbacks), so this
    // effect used to tear down and re-register six IPC listeners — plus a
    // notifReplyReady round trip to main — on nearly every commit: ~0.3 s of
    // main-thread time in the 12 s after a wake on the dev box, the single
    // most expensive effect in that window. The listeners now call through a
    // ref that always holds the latest handlers, so behaviour is identical.
    const trayHandlersRef = useRef({ openFromNotification, sendQuickReply, setStatus, updateNotifPrefs, logout, lockNow: screenLock.lockNow });
    trayHandlersRef.current = { openFromNotification, sendQuickReply, setStatus, updateNotifPrefs, logout, lockNow: screenLock.lockNow };
    useEffect(() => {
        if (!window.electronAPI) return;
        const h = trayHandlersRef;
        const offClick = window.electronAPI.onNotificationClicked?.((convId) => h.current.openFromNotification(convId));
        const offReply = window.electronAPI.onNotificationReplied?.(({ conv_id, text }) => h.current.sendQuickReply(conv_id, text));
        const offStatus = window.electronAPI.onTraySetStatus?.((s) => { h.current.setStatus(s); });
        const offDnd = window.electronAPI.onTrayToggleDnd?.((enabled) => { h.current.updateNotifPrefs({ dnd_manual: enabled }); });
        const offLock = window.electronAPI.onTrayLock?.(() => { h.current.lockNow(); });
        const offSignOut = window.electronAPI.onTraySignOut?.(() => { h.current.logout(); });
        // Announce that the reply listener above is bound. Main queues toast
        // replies until it sees this, so a reply the user submitted while the
        // renderer was reloading is drained here instead of falling on the floor.
        void window.electronAPI.notifReplyReady?.().catch(() => { /* older main */ });
        return () => { offClick?.(); offReply?.(); offStatus?.(); offDnd?.(); offLock?.(); offSignOut?.(); };
    }, []);

    // On server:member_joined (existing member receives this event):
    // distribute EVERY channel epoch key this device holds to the new
    // member's devices — full history, not just {latest ∪ pinned} (all
    // pinned epochs we still hold are in the full set by definition).
    useEffect(() => {
        if (!serverMemberJoinedEvent || !token || !userId || !deviceId) return;
        const { server_id, user_id: newUserId } = serverMemberJoinedEvent;
        if (newUserId === userId) return; // Don't distribute to ourselves

        // Refresh the right-panel member list so the new joiner appears immediately.
        setServerRolesRefreshKey(k => k + 1);

        (async () => {
            try {
                // Fetch the new member's device key bundles.
                const devRes = await axios.get(
                    `${API_BASE}/servers/${server_id}/members/${newUserId}/devices`,
                    { headers: { Authorization: `Bearer ${token}` } }
                );
                const newMemberDevices: Omit<ChannelKeyRecipient, 'user_id'>[] = devRes.data ?? [];
                if (!newMemberDevices.length) return;

                // Fetch the channel list FRESH — the serverChannels cache is
                // lazily populated and empty for servers this session hasn't
                // opened, which used to silently skip distribution entirely.
                const chRes = await axios.get(`${API_BASE}/servers/${server_id}/channels`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                const channels: { channel_id: string; kind: string }[] = chRes.data ?? [];
                // RC-10: fetched once for the whole join, not once per channel —
                // also refreshes the main process's prune-protection for every
                // pinned channel on this server as a side effect.
                const pinnedByChannel = await refreshProtectedEpochs(server_id);
                for (const ch of channels) {
                    if (!channelCarriesSenderKeys(ch.kind)) continue;
                    const epochs = await window.electronAPI!.listChannelEpochs(ch.channel_id);
                    if (!epochs.length) continue; // no keys held — another member covers it
                    const { unservable } = computeEpochsToDistribute(epochs, pinnedByChannel.get(ch.channel_id) ?? [], undefined);
                    if (unservable.length) {
                        console.error(`[Channels] Pinned epoch(s) ${unservable.join(',')} for channel ${ch.channel_id} not held by this device — new member ${newUserId} won't get them from us; another holder may still cover it`);
                    }
                    await distributeChannelKeys(
                        server_id, ch.channel_id, epochs,
                        newMemberDevices.map(d => ({ user_id: newUserId, ...d })),
                        'member_join',
                    );
                }
            } catch (e) {
                console.warn('[Dashboard] Failed to distribute channel keys to new member:', e);
            }
        })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serverMemberJoinedEvent]);

    // Handle server:permissions_changed — a moderator on `server_id` mutated
    // role permissions, role assignments, or channel/category overrides. Pull
    // fresh `myPermissions[server_id]` AND `channels[server_id]` so every UI
    // gate that derives from those (send bar enablement, attach button, huddle
    // join, server-settings tab visibility, etc.) re-evaluates without a reload.
    // The API resolver applies the current user's roles/overrides on each call,
    // so this picks up demotions / promotions / channel-specific deny rules in
    // a single round-trip per event.
    useEffect(() => {
        if (!permissionsChangedEvent) return;
        const { server_id } = permissionsChangedEvent;
        loadMyPermissions(server_id);
        loadChannels(server_id);
        // A grant may have just made channels visible to us that we hold no
        // keys for — pull envelopes and file key requests for any gap. This
        // is the entire fix for "granted VIEW but can't read history".
        void requestMissingChannelKeys(server_id);
        // Also reload the right-panel member list so role badge changes
        // (assign / unassign / role rename / colour change) appear immediately.
        setServerRolesRefreshKey(k => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [permissionsChangedEvent]);

    // A channel was created/updated/deleted somewhere in a server we're in.
    // Refresh the list/categories live instead of only on next server-open,
    // AND request Sender Keys for anything newly visible — a channel someone
    // else just created (and already keyed via bootstrapAndDistributeChannelKey)
    // becomes usable immediately instead of waiting for this device's next
    // connect sweep. The event deliberately carries no channel_id (see
    // notifyServerChannelsChanged), so this always does a full VIEW-filtered
    // re-fetch rather than touching one specific channel.
    useEffect(() => {
        if (!channelsChangedEvent) return;
        const { server_id } = channelsChangedEvent;
        loadChannels(server_id);
        reloadCategories(server_id);
        void requestMissingChannelKeys(server_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channelsChangedEvent]);

    // The roster changed in a server we're in — someone left, was kicked,
    // banned or unbanned, or had a nickname / mute edited. serverRolesRefreshKey
    // is what ServerContextPanel's loadMembers() watches, so bumping it is the
    // whole fix. None of those mutations used to broadcast anything: the member
    // list stayed as it was when you opened the server.
    useEffect(() => {
        if (!serverMembersChangedEvent) return;
        setServerRolesRefreshKey(k => k + 1);
    }, [serverMembersChangedEvent]);

    // A server's own profile changed — name, description, icon, banner, default
    // notification level, or system channel. Reload the servers list so the rail
    // tile, its tooltip, the server header, and the settings screen all repaint.
    // Nothing refetches GET /servers on its own, so before this listener (and
    // the broadcast that feeds it) a rename or a new icon stayed stale on every
    // other member's screen for the whole session.
    useEffect(() => {
        if (!serverUpdatedEvent) return;
        loadServers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serverUpdatedEvent]);

    // Handle server:owner_lapsed / server:owner_grace_cleared — the owner's
    // subscription expired (grace period started/ticking) or was resolved
    // (resubscribed, transferred to a Pro member, or an admin comp/trial
    // grant reactivated them). Neither event had ANY client-side listener
    // before this — the ServerGraceBanner only ever reflected whatever
    // owner_lapsed_at happened to be from the last loadServers() call, so a
    // just-cleared grace period could sit stale in the UI for a long time.
    // Reload the servers list so the banner appears/disappears live.
    useEffect(() => {
        if (!serverGraceStatusEvent) return;
        loadServers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serverGraceStatusEvent]);

    // Handle server:channel_key_envelopes_ready — a distributor just posted
    // fresh Sender Key envelopes for one or more of our channels. Pull them
    // now so a new joiner doesn't sit on "Couldn't decrypt" placeholders
    // waiting for the polling retry timeout, then lift the composer gate for
    // any channel whose key actually landed.
    //
    // Drains the WHOLE batch (coalesceEnvelopesReadyEvents), not just the
    // latest entry: the old single-nullable-slot version processed only one
    // event per React-batched render, silently losing every other channel's
    // gate-clear when a distributor posted several channels' envelopes back to
    // back (the exact "stuck on Waiting for channel keys" race described where
    // this state lived before).
    //
    // What this deliberately no longer does is delete the cached messages for
    // every channel in the batch. The server addresses envelopes to specific
    // DEVICES but notifies the recipient USER (gateway.
    // notifyChannelKeyEnvelopesReady → broadcastToUsers), so a device that was
    // not in the envelope list — already keyed, thread fully decrypted on
    // screen — receives this push too. Verified live against the dev API. The
    // unconditional drop therefore emptied a perfectly good thread, and since
    // the loading flag is only armed on a channel's FIRST visit, the re-render
    // showed the "no messages" empty state rather than a spinner. A served key
    // request stays `fulfilled_at IS NULL` until the recipient ACKs, so holders
    // re-serve it on every retry tick and reconnect — and the old code's
    // handleSelectChannel re-entry re-filed the request itself, closing the
    // cycle. That was the reported flicker.
    //
    // Now: decide per channel (decideEnvelopesReadyAction), never delete, and
    // refresh through the history-only path so no key request is re-filed.
    useEffect(() => {
        if (channelKeyEnvelopesReadyEvents.length === 0) return;
        const { serverIds, channelIds } = coalesceEnvelopesReadyEvents(channelKeyEnvelopesReadyEvents);
        setChannelKeyEnvelopesReadyEvents([]);
        (async () => {
            // Snapshot which channels we held a key for BEFORE pulling, so we
            // can tell "this device just gained a key" (worth re-reading
            // history for) from "these envelopes were for a sibling device".
            const heldBefore = new Map<string, boolean>();
            for (const channel_id of channelIds) {
                heldBefore.set(
                    channel_id,
                    (await window.electronAPI!.getLatestChannelEpoch(channel_id)) !== null,
                );
            }

            for (const server_id of serverIds) await pullChannelKeys(server_id);

            const serverOf = new Map(
                channelKeyEnvelopesReadyEvents.map(e => [e.channel_id, e.server_id]),
            );
            for (const channel_id of channelIds) {
                // Key installed → lift the composer's awaiting-keys gate.
                const held = await window.electronAPI!.getLatestChannelEpoch(channel_id);
                if (held !== null) {
                    firstKeyRequestTimeRef.current.delete(channel_id);
                    setAwaitingChannelKeys(prev => {
                        if (!prev[channel_id]) return prev;
                        const next = { ...prev };
                        delete next[channel_id];
                        return next;
                    });
                }

                const cached = channelMessagesRef.current[channel_id] ?? [];
                const action = decideEnvelopesReadyAction({
                    heldKeyBefore: heldBefore.get(channel_id) ?? false,
                    heldKeyAfter: held !== null,
                    hasUndecryptableCached: cached.some(isUndecryptablePlaceholder),
                });
                if (action === 'ignore') continue;

                // Only the channel the user is actually looking at gets an
                // eager re-read. A background channel needs no immediate work
                // now that its cache is left intact: handleSelectChannel's
                // catch-up merge upgrades any placeholder in place the moment
                // it's opened. (The old code cleared EVERY channel in the
                // batch, which is why a new joiner's 20-channel server was left
                // with 19 empty threads until each was visited one by one.)
                if (activeChannelRef.current?.channel_id !== channel_id) continue;

                // Re-read history and MERGE. Placeholders that decrypt now are
                // upgraded in place by refreshChannelHistory; anything the API
                // no longer serves stays put instead of being lost to a drop.
                await refreshChannelHistory(serverOf.get(channel_id) ?? '', channel_id);
            }
        })().catch(() => {/* non-fatal */});
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channelKeyEnvelopesReadyEvents]);

    // Handle server:removed — the current user was kicked or banned.
    // Drop the server from the local list and navigate away if we were viewing it.
    useEffect(() => {
        if (!serverRemovedEvent) return;
        const { server_id } = serverRemovedEvent;
        // If the user was viewing this server, switch away first.
        if (activeServerView?.serverId === server_id) {
            setActiveServerView(null);
            setActiveChannel(null);
            setActiveTab('dms');
        }
        // Involuntary leave (kick / ban / server deleted) — same orphan cleanup
        // as the explicit Leave Server flow above.
        if (userId) {
            try { secureLocalStore.removeItem(`cipherline_server_retention_${userId}_${server_id}`); } catch {}
        }
        // Reload servers list so the removed server disappears from the nav rail.
        loadServers();
    }, [serverRemovedEvent]); // eslint-disable-line react-hooks/exhaustive-deps

    // Inject ephemeral system messages (join / leave / kick / ban) into the
    // channel message list for display in the server's system channel.
    useEffect(() => {
        if (!channelSystemEvent) return;
        const { channel_id, event_type, username, actor_username, created_at } = channelSystemEvent;

        const systemText = (() => {
            switch (event_type) {
                case 'member_join':  return `${username} joined the server.`;
                case 'member_leave': return `${username} left the server.`;
                case 'member_kick':  return `${username} was kicked by ${actor_username ?? 'a moderator'}.`;
                case 'member_ban':   return `${username} was banned by ${actor_username ?? 'a moderator'}.`;
                default:             return `${username} triggered an unknown event.`;
            }
        })();

        const syntheticMsg = {
            id: `sys_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            content: { type: 'system', text: systemText },
            sender_device_id: '',
            sender_user_id: '',
            timestamp: created_at,
            conversation_id: channel_id,
        };

        setChannelMessages(prev => {
            const existing = prev[channel_id] ?? [];
            const merged = [...existing, syntheticMsg].sort(
                (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );
            return { ...prev, [channel_id]: merged };
        });
    }, [channelSystemEvent]);

    // Join an always-on voice channel. Reuses the existing activeCall / CallPane
    // infrastructure — the voice session ID becomes the LiveKit room name.
    // The call UI lives entirely in the right-hand ServerContextPanel (pane 4);
    // pane 3 (text chat) is never touched by this function.
    const handleJoinVoiceChannel = useCallback(async (channel: ChannelInfo) => {
        if (!token || !deviceId) return;
        if (activeVoiceChannelId === channel.channel_id) return; // already here

        const doJoin = async () => {
            // ── Optimistic: light the UI up the instant of the click ──
            // The row highlights and the call section shows Connecting…
            // before any round-trip. Reverted on failure.
            const prevVoiceChannelId = activeVoiceChannelId;
            setActiveVoiceChannelId(channel.channel_id);
            setIsStartingCall(true);
            // Play immediately — before the API round-trip so we're still
            // inside the browser's user-gesture autoplay context.
            // Through playSound, not a bare `new Audio()`: that bypassed the
            // notification prefs entirely (a user with sounds off, or the join
            // category off, still got it at full volume) AND bypassed the
            // output-device routing, so it played on the system default while
            // the call itself played on the chosen headset. Same P2-REND-5
            // rule the in-call cues already follow.
            playSound('join', notifGlobalPrefsRef.current);

            // Leave the previous voice channel in the background — the
            // endpoint is channel-scoped, so it can't race the new join.
            if (prevVoiceChannelId) {
                axios.post(
                    `${API_BASE}/channels/${prevVoiceChannelId}/leave_voice`,
                    {},
                    { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } },
                ).catch(() => { /* best-effort */ });
            }

            try {
                const res = await axios.post(
                    `${API_BASE}/channels/${channel.channel_id}/join_voice`,
                    {},
                    { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId }, timeout: 15000 },
                );
                const { session_id, livekit_token, livekit_url } = res.data;
                setActiveCall({
                    id: session_id,
                    livekit_url,
                    livekit_token,
                    e2ee_key_b64: '',
                    callsChannelId: channel.channel_id,
                    mode: 'sfu',
                    isInitiator: false,
                    isVoiceChannel: true,
                    voiceChannelName: channel.name,
                });
            } catch (err) {
                // Roll the optimism back — we're in no channel now (the old
                // one was already told we left).
                setActiveVoiceChannelId(null);
                setIsStartingCall(false);
                toast.push({ kind: 'error', title: 'Call connection failed', message: "Couldn't join the voice channel — check your network and try again." });
                console.error('[Dashboard] Failed to join voice channel:', err);
            }
        };

        // If already in any call, ask before switching.
        if (activeCall) {
            setPendingServerJoin({ fn: doJoin, channelName: channel.name, anchor: { ...lastClickPos.current } });
            return;
        }

        await doJoin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token, deviceId, activeVoiceChannelId, activeCall]);

    // ── Huddle call lifecycle handlers ─────────────────────────────────────
    /** Call session id of the Huddle call the local user is currently in. */
    const [activeHuddleCallId, setActiveHuddleCallId] = useState<string | null>(null);

    // Sync activeCallRegistry from whichever of the three call-state pieces
    // is set. Deliberately a single effect keyed on the derived boolean
    // rather than editing every one of the 14+ setActiveCall/
    // setActiveVoiceChannelId/setActiveHuddleCallId call sites individually
    // — this is correct regardless of which code path changed the state,
    // where hand-threading a write into every call site would only be as
    // reliable as the least-careful future edit to one of them (see
    // activeCallRegistry.ts).
    useEffect(() => {
        setHasActiveCall(activeCall !== null || activeVoiceChannelId !== null || activeHuddleCallId !== null);
    }, [activeCall, activeVoiceChannelId, activeHuddleCallId]);
    /** Channel id of the Huddle channel the local user is currently in.
     *  Set alongside activeHuddleCallId so we can find the server without
     *  relying on active_call_session_id (a WS-driven field that may lag). */
    const [activeHuddleChannelId, setActiveHuddleChannelId] = useState<string | null>(null);
    /** Expand/collapse state for the floating call widget (shown when
     *  navigated away from the call's own server) — independent of
     *  ServerContextPanel's own per-huddle huddleExpanded map. */
    const [floatingHuddleExpanded, setFloatingHuddleExpanded] = useState(true);

    /** What this client is actually connected to, in the shape HomePanel's
     *  active-call rows compare against. `voiceParticipants` / `huddleCalls`
     *  are server-side membership only, so the deck used to offer "Join" on
     *  the very call the user was sitting in (a dead button — both join
     *  handlers early-return on the active session). Note the asymmetry the
     *  matcher depends on: a voice channel is keyed by its CHANNEL id, a
     *  huddle call by its CALL id, never activeHuddleChannelId. */
    const localCallSession = useMemo<LocalCallSession>(
        () => ({ voiceChannelId: activeVoiceChannelId, huddleCallId: activeHuddleCallId }),
        [activeVoiceChannelId, activeHuddleCallId],
    );

    // ── Pending server-join confirmation ────────────────────────────────────
    // When the user tries to join a server call while already in any other call,
    // we capture the deferred action and the click position, then show a small
    // inline popup (same style as the DM call-conflict card in ChatPane).
    const lastClickPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    useEffect(() => {
        const track = (e: MouseEvent) => { lastClickPos.current = { x: e.clientX, y: e.clientY }; };
        document.addEventListener('mousedown', track);
        return () => document.removeEventListener('mousedown', track);
    }, []);

    const [pendingServerJoin, setPendingServerJoin] = useState<{
        fn: () => Promise<void>;
        channelName: string;
        anchor: { x: number; y: number };
    } | null>(null);

    // ── Call-action cooldown (rate-limit feedback) ──────────────────────────
    const [callCooldownSecs, setCallCooldownSecs] = useState(0);
    const callCooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

    const startCallCooldown = useCallback((remainingMs: number) => {
        if (callCooldownTimer.current) clearInterval(callCooldownTimer.current);
        let secs = Math.ceil(remainingMs / 1000);
        setCallCooldownSecs(secs);
        callCooldownTimer.current = setInterval(() => {
            secs -= 1;
            setCallCooldownSecs(secs);
            if (secs <= 0) {
                clearInterval(callCooldownTimer.current!);
                callCooldownTimer.current = null;
            }
        }, 1000);
    }, []);
    // ────────────────────────────────────────────────────────────────────────

    /** Spawn a fresh call under a Huddle and join it immediately. Each click
     *  spawns its own call (the user explicitly chose this behaviour — see
     *  Phase M plan). Drops any prior server call. */
    const handleSpawnHuddleCall = useCallback(async (huddle: ChannelInfo) => {
        if (!token || !deviceId) return;

        const doSpawn = async () => {
            // ── Optimistic: Connecting… renders immediately; prior
            // connections are dropped in the background (both endpoints are
            // scoped to the old channel/call, so they can't race the spawn).
            setIsStartingCall(true);
            // playSound, not a bare `new Audio()` — see handleJoinVoiceChannel.
            playSound('join', notifGlobalPrefsRef.current);
            if (activeVoiceChannelId) {
                const prevVc = activeVoiceChannelId;
                setActiveVoiceChannelId(null);
                axios.post(`${API_BASE}/channels/${prevVc}/leave_voice`, {},
                    { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } })
                    .catch(() => { /* best-effort */ });
            }
            if (activeHuddleCallId) {
                const prevCall = activeHuddleCallId;
                setActiveHuddleCallId(null);
                setActiveHuddleChannelId(null);
                leaveHuddleCall(prevCall).catch(() => { /* best-effort */ });
            }

            try {
                const res = await spawnHuddleCall(huddle.channel_id);
                if (!res) { setIsStartingCall(false); return; }
                setActiveHuddleCallId(res.call_id);
                setActiveHuddleChannelId(huddle.channel_id);
                setActiveCall({
                    id: res.call_id,
                    livekit_url: res.livekit_url,
                    livekit_token: res.livekit_token,
                    e2ee_key_b64: '',
                    callsChannelId: huddle.channel_id,
                    mode: 'sfu',
                    isInitiator: true,
                    isVoiceChannel: true,
                    voiceChannelName: res.name,
                });
            } catch (err: any) {
                setIsStartingCall(false);
                if (err?.response?.status === 429) {
                    const retryAfterSecs = parseInt(err.response.headers?.['retry-after'] ?? '10', 10);
                    startCallCooldown(retryAfterSecs * 1000);
                    return;
                }
                toast.push({ kind: 'error', title: 'Call connection failed', message: "Couldn't start the call — check your network and try again." });
                console.error('[Dashboard] Failed to spawn huddle call:', err);
            }
        };

        // If already in any call, ask before switching.
        if (activeCall) {
            setPendingServerJoin({ fn: doSpawn, channelName: huddle.name, anchor: { ...lastClickPos.current } });
            return;
        }

        await doSpawn();
    }, [token, deviceId, activeVoiceChannelId, activeHuddleCallId, activeCall, spawnHuddleCall, leaveHuddleCall, startCallCooldown]);

    /** Join an *existing* call under a Huddle (clicked from the active-calls list). */
    const handleJoinExistingHuddleCall = useCallback(async (callId: string, displayName: string) => {
        if (!token || !deviceId) return;
        if (activeHuddleCallId === callId) return;

        const doJoin = async () => {
            // Optimistic — same shape as doSpawn above.
            setIsStartingCall(true);
            // playSound, not a bare `new Audio()` — see handleJoinVoiceChannel.
            playSound('join', notifGlobalPrefsRef.current);
            if (activeVoiceChannelId) {
                const prevVc = activeVoiceChannelId;
                setActiveVoiceChannelId(null);
                axios.post(`${API_BASE}/channels/${prevVc}/leave_voice`, {},
                    { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } })
                    .catch(() => { /* best-effort */ });
            }
            if (activeHuddleCallId) {
                const prevCall = activeHuddleCallId;
                setActiveHuddleChannelId(null);
                leaveHuddleCall(prevCall).catch(() => { /* best-effort */ });
            }
            try {
                const res = await joinHuddleCall(callId);
                if (!res) { setIsStartingCall(false); return; }
                setActiveHuddleCallId(res.call_id);
                setActiveHuddleChannelId(res.huddle_id);
                setActiveCall({
                    id: res.call_id,
                    livekit_url: res.livekit_url,
                    livekit_token: res.livekit_token,
                    e2ee_key_b64: '',
                    callsChannelId: res.huddle_id,
                    mode: 'sfu',
                    isInitiator: false,
                    isVoiceChannel: true,
                    voiceChannelName: displayName,
                });
            } catch (err: any) {
                setIsStartingCall(false);
                if (err?.response?.status === 429) {
                    const retryAfterSecs = parseInt(err.response.headers?.['retry-after'] ?? '10', 10);
                    startCallCooldown(retryAfterSecs * 1000);
                    return;
                }
                toast.push({ kind: 'error', title: 'Call connection failed', message: "Couldn't join the call — check your network and try again." });
                console.error('[Dashboard] Failed to join huddle call:', err);
            }
        };

        // If already in any call, ask before switching.
        if (activeCall) {
            setPendingServerJoin({ fn: doJoin, channelName: displayName, anchor: { ...lastClickPos.current } });
            return;
        }

        await doJoin();
    }, [token, deviceId, activeHuddleCallId, activeVoiceChannelId, activeCall, joinHuddleCall, leaveHuddleCall, startCallCooldown]);

    /** Leave the current Huddle call (no spawn). */
    const handleLeaveHuddleCall = useCallback(async () => {
        if (!activeHuddleCallId) return;
        const callId = activeHuddleCallId;

        // Optimistic update: clear local state immediately so the card
        // disappears at once. If we're the only participant, also remove the
        // call entry so the panel empties without waiting for a WS round-trip.
        setActiveHuddleCallId(null);
        setActiveHuddleChannelId(null);
        setActiveCall(null);

        // Find the call in local state to check if we're the last participant.
        let huddleId: string | null = null;
        let isLastParticipant = false;
        for (const [hid, calls] of Object.entries(huddleCalls)) {
            const match = calls.find(c => c.call_id === callId);
            if (match) {
                huddleId = hid;
                isLastParticipant = match.participants.length <= 1;
                break;
            }
        }
        if (huddleId && isLastParticipant) {
            applyHuddleDestroy(huddleId, callId);
        }

        // Fire the server leave in the background — server destroys the room
        // and fans out `huddle:call_destroyed` to other connected clients.
        leaveHuddleCall(callId).catch(err =>
            console.error('[Dashboard] leaveHuddleCall error:', err)
        );
    }, [activeHuddleCallId, leaveHuddleCall, huddleCalls, applyHuddleDestroy]);

    // Optimistically append a sent channel message to local state.
    // Called by ChatPane after a successful POST /channels/:id/messages.
    /**
     * Optimistic local update for the SENDER of a channel message. Mirrors
     * the receive-handler's action processing so the sender sees their
     * own edit/delete/reaction land instantly without a round-trip.
     */
    const handleChannelMessageSent = useCallback((msg: any) => {
        if (!msg?.conversation_id) return;
        if (isUserAuthoredContentType(msg?.content?.type)) nudges.notify({ kind: 'message_sent' });
        const cid = msg.conversation_id;
        const content = msg.content;

        // Computed BEFORE the setChannelMessages updater below, against
        // channelMessagesRef (the same pre-merge snapshot
        // refreshChannelHistory / handleChannelMessage use) — the removed
        // row's own `id` (not `content.target_id`, which may instead be a
        // `client_msg_id`), since that's what `localChannelPins` is keyed by.
        // A value assigned INSIDE a setState updater and read right after the
        // setState call is not reliable: React does not guarantee the
        // updater runs synchronously during this call (React 19 in
        // particular), so the outer variable can still be null when read.
        // The updater below stays pure.
        const sentPurgedIds = userId ? getPurgedMessageIds(userId, cid) : new Set<string>();
        const deletedRowId = content?.type === 'delete'
            ? deletedChannelTargetIds(
                channelMessagesRef.current[cid] ?? [],
                [{ id: msg.id, timestamp: msg.timestamp, content }],
                sentPurgedIds,
            )[0] ?? null
            : null;

        setChannelMessages(prev => {
            let thread = [...(prev[cid] ?? [])];

            if (content?.type === 'edit') {
                const idx = thread.findIndex(t => t.id === content.target_id || t.content?.client_msg_id === content.target_id);
                if (idx !== -1) {
                    thread[idx] = { ...thread[idx], content: { ...thread[idx].content, text: content.text }, edited: true };
                }
                return { ...prev, [cid]: thread };
            }
            if (content?.type === 'delete') {
                thread = thread.filter(t => t.id !== content.target_id && t.content?.client_msg_id !== content.target_id);
                return { ...prev, [cid]: thread };
            }
            if (content?.type === 'reaction') {
                const idx = thread.findIndex(t => t.id === content.target_id || t.content?.client_msg_id === content.target_id);
                if (idx !== -1) {
                    const target = thread[idx];
                    const reactions = { ...(target.reactions || {}) };
                    const reactor = msg.sender_user_id || msg.sender_device_id;
                    const list = Array.isArray(reactions[content.emoji]) ? reactions[content.emoji] : [];
                    let next: string[];
                    if (content.action === 'add') next = list.includes(reactor) ? list : [...list, reactor];
                    else                          next = list.filter((id: string) => id !== reactor);
                    if (next.length === 0) delete reactions[content.emoji];
                    else                   reactions[content.emoji] = next;
                    thread[idx] = { ...target, reactions };
                }
                return { ...prev, [cid]: thread };
            }

            // Normal message — dedupe (server WS echo may also call this)
            const dup =
                thread.some(m => m.id === msg.id) ||
                thread.some(m => m.content?.client_msg_id && m.content.client_msg_id === content?.client_msg_id);
            if (dup) return prev;
            return { ...prev, [cid]: [...thread, msg] };
        });

        // Deleting your own personally-saved channel message ("Save for me")
        // unpins it on every one of your devices — the client-side mirror of
        // the server's removePinForDeletedMessage cleanup for server pins.
        if (deletedRowId && localChannelPinsRef.current[cid]?.includes(deletedRowId)) {
            handlePersonalChannelSaveRef.current(cid, deletedRowId, 'remove');
        }
    }, [userId]);

    // Publish the channel optimistic-append handler to the quick-reply path,
    // which is declared above this point and so can't reference it directly.
    useEffect(() => { handleChannelMessageSentRef.current = handleChannelMessageSent; });

    // (Sidebar context-menu dismissal is owned by useContextMenu — no extra
    // wiring here. See the hook for the consume-on-outside-click contract.)

    // Fetch group members for the right-hand panel
    useEffect(() => {
        if (!activeChat || activeChat.type !== 'group' || !token || !deviceId) {
            setGroupMembers([]);
            return;
        }
        setGroupMembersLoading(true);
        axios.get(`${API_BASE}/conversations/${activeChat.id}/devices`, {
            headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId }
        }).then(res => {
            const uniqueUsers = new Map<string, any>();
            res.data.forEach((d: any) => {
                if (d.user_id && !uniqueUsers.has(d.user_id)) {
                    uniqueUsers.set(d.user_id, { user_id: d.user_id, username: d.username, avatar_url: d.avatar_url });
                }
            });
            if (userId && !uniqueUsers.has(userId)) {
                // Self-fallback: if the devices endpoint didn't include us
                // (can happen briefly during pairing handshakes), seed our own
                // entry from AuthContext. Include avatar_url — without it the
                // group-members panel showed everyone's picture except the
                // current user's, falling through to the initials placeholder.
                uniqueUsers.set(userId, {
                    user_id: userId,
                    username: user?.username || 'You',
                    avatar_url: user?.avatar_url ?? null,
                });
            }
            setGroupMembers(Array.from(uniqueUsers.values()));
        }).catch(() => {}).finally(() => setGroupMembersLoading(false));
    }, [activeChat?.id, activeChat?.type, token, deviceId, userId]);


    // Fetch DM partner public profile (bio, banner) for right-hand panel
    useEffect(() => {
        if (!activeChat || activeChat.type !== 'dm' || !activeChat.other_user_id || !token) {
            setDmPartnerProfile(null);
            return;
        }
        const uid = activeChat.other_user_id;
        axios.get(`${API_BASE}/auth/users/${uid}`, { headers: { Authorization: `Bearer ${token}` } })
            .then(res => setDmPartnerProfile({
                banner_url: res.data.banner_url ?? null,
                bio: res.data.bio ?? null,
                status: res.data.status ?? 'offline',
                last_seen_at: res.data.last_seen_at ?? null,
                avatar_url: res.data.avatar_url ?? null,
            }))
            .catch(() => setDmPartnerProfile(null));
    }, [activeChat?.id, activeChat?.type, activeChat?.other_user_id, token]);

    // When the active DM partner goes offline, the WS event now carries last_seen_at.
    // Update dmPartnerProfile immediately so the right panel shows "Last seen X ago"
    // without needing to re-fetch the profile.
    useEffect(() => {
        if (!statusChangedEvent) return;
        if (statusChangedEvent.status !== 'offline') return;
        if (statusChangedEvent.user_id !== activeChat?.other_user_id) return;
        if (!statusChangedEvent.last_seen_at) return;
        setDmPartnerProfile(prev => prev ? { ...prev, last_seen_at: statusChangedEvent.last_seen_at } : prev);
    }, [statusChangedEvent, activeChat?.other_user_id]);

    // Execute DM closure / Group leave
    const handleCloseConversation = useCallback(async (id: string, deleteData: boolean, isGroup: boolean) => {
        if (isGroup) {
            try {
                await axios.post(`${API_BASE}/conversations/${id}/leave`, {}, {
                    headers: { Authorization: `Bearer ${token}` }
                });
            } catch (err) {
                console.error('Failed to leave group:', err);
                // Even if it fails (e.g., group doesn't exist anymore), we might want to still hide it locally
            }
        }
        
        setHiddenConversations(prev => [...new Set([...prev, id])]);
        
        if (activeChatRef.current?.id === id) {
            setActiveChat(null);
        }
        
        if (deleteData) {
            setMessagesState(prev => {
                const next = { ...prev };
                delete next[id];
                return next;
            });
            // Also drop the per-conversation pin list and retention override —
            // both are scoped to this convId and would otherwise become orphaned
            // localStorage entries forever.
            setPinnedMessagesState(prev => {
                if (!(id in prev)) return prev;
                const next = { ...prev };
                delete next[id];
                return next;
            });
            if (userId) {
                try {
                    // One record per conversation now, so this is a single
                    // removal instead of rewriting the whole history to drop one key.
                    await messageStore.removeThread('dm', userId, id);
                } catch(e) {}
                // Per-conversation retention override entry — orphaned otherwise.
                try { secureLocalStore.removeItem(convRetentionKey(userId, id)); } catch(e) {}
            }
        }
    }, [userId, token]);


    // True when the user is currently viewing the server where their voice /
    // huddle call is active.  Drives whether the call section renders at the
    // top (navigated away) or bottom (still on the call's server) of pane4.
    //
    // Key design choices:
    //  • Uses activeServerView (the open server tab) not activeChannel (the
    //    selected text channel) — voice joins never set activeChannel.
    //  • Uses activeHuddleChannelId (set synchronously on spawn/join) not
    //    active_call_session_id (a WS-driven field that may lag behind).
    //  • activeTab gate ensures DMs/friends/files always show the top position.
    const isViewingCallServer = useMemo(() => {
        if (!activeCall?.isVoiceChannel) return false;
        if (activeTab !== 'servers' || !activeServerView?.serverId) return false;
        const sid = activeServerView.serverId;
        if (activeVoiceChannelId) {
            const allChs = Object.values(serverChannels).flat();
            const ch = allChs.find(c => c.channel_id === activeVoiceChannelId);
            return !!ch && ch.server_id === sid;
        }
        if (activeHuddleChannelId) {
            const allChs = Object.values(serverChannels).flat();
            const ch = allChs.find(c => c.channel_id === activeHuddleChannelId);
            return !!ch && ch.server_id === sid;
        }
        return false;
    }, [activeCall, activeTab, activeServerView, activeVoiceChannelId, activeHuddleChannelId, serverChannels]);

    // Server + channel name for the floating call header in the TOP position.
    const callServerInfo = useMemo(() => {
        if (!activeCall?.isVoiceChannel) return null;
        const allChs = Object.values(serverChannels).flat();
        let ch: (typeof allChs)[0] | undefined;
        if (activeVoiceChannelId) {
            ch = allChs.find(c => c.channel_id === activeVoiceChannelId);
        } else if (activeHuddleChannelId) {
            ch = allChs.find(c => c.channel_id === activeHuddleChannelId);
        }
        if (!ch) return null;
        const srv = servers.find(s => s.server_id === ch!.server_id);
        return {
            serverId: ch.server_id,
            serverName: srv?.name ?? null,
            channelName: activeCall.voiceChannelName ?? ch.name,
            iconName: ch.icon_name ?? null,
            iconEmoji: ch.icon_emoji ?? null,
            maxCalls: ch.max_calls ?? null,
        };
    }, [activeCall, activeVoiceChannelId, activeHuddleChannelId, serverChannels, servers]);

    /** Resolved channel permissions for the channel of the *currently active* call —
     *  voice channel or huddle. Used by CallPane → SidebarConference to pre-disable
     *  mic-unmute / camera / screen-share controls when the user lacks SPEAK /
     *  VIDEO / SCREEN_SHARE. Undefined when no call is active or permissions for
     *  the call's channel haven't been resolved yet (LiveKit still enforces). */
    const activeCallChannelPermissions = useMemo<bigint | undefined>(() => {
        const callChannelId = activeVoiceChannelId ?? activeHuddleChannelId;
        if (!callChannelId) return undefined;
        for (const map of Object.values(channelPermissionsMaps)) {
            if (callChannelId in map) return map[callChannelId];
        }
        return undefined;
    }, [activeVoiceChannelId, activeHuddleChannelId, channelPermissionsMaps]);

    /** Context value for call components so they can open profiles with server context. */
    const callServerCtxValue = useMemo(() => {
        if (!callServerInfo) return null;
        const perms = myPermissions[callServerInfo.serverId] ?? 0n;
        return {
            serverId: callServerInfo.serverId,
            canChangeOwnNick: hasPermission(perms, Permissions.CHANGE_NICKNAME) || hasPermission(perms, Permissions.ADMINISTRATOR),
            canManageNick: hasPermission(perms, Permissions.MANAGE_NICKNAMES) || hasPermission(perms, Permissions.ADMINISTRATOR),
        };
    }, [callServerInfo, myPermissions]);

    /** DEAFEN_MEMBERS on the *call's* server — surfaces the server-moderation
     *  block in FloatingHuddleCard's participant popover while the user is
     *  away from that server. Mirrors ServerContextPanel's own `canServerMute`
     *  gate so the same moderator sees the same rows in both places. Client
     *  gate is UX only; PATCH .../call-mute re-checks the permission. */
    const callServerCanMute = useMemo(() => {
        if (!callServerInfo) return false;
        const perms = myPermissions[callServerInfo.serverId] ?? 0n;
        return hasPermission(perms, Permissions.DEAFEN_MEMBERS) || hasPermission(perms, Permissions.ADMINISTRATOR);
    }, [callServerInfo, myPermissions]);

    /** Server-side track-mute for a participant of the active huddle call, fired
     *  from FloatingHuddleCard's popover. Same endpoint + fire-and-forget error
     *  handling as ServerContextPanel's serverMuteCallParticipant; the room name
     *  for a huddle is its call_id. */
    const serverMuteFloatingParticipant = useCallback(
        (targetUserId: string, trackType: 'audio' | 'video' | 'screenshare' | 'deafen', muted: boolean) => {
            const serverId = callServerInfo?.serverId;
            const roomName = activeHuddleCallId;
            if (!token || !serverId || !roomName) return;
            axios.patch(
                `${API_BASE}/servers/${serverId}/members/${targetUserId}/call-mute`,
                { track_type: trackType, muted, room_name: roomName },
                { headers: { Authorization: `Bearer ${token}` } },
            ).catch(err => {
                console.error('[Dashboard] floating-card server-mute failed:', err?.response?.data ?? err.message);
            });
        },
        [token, callServerInfo, activeHuddleCallId],
    );

    const divider2El = (
        <div
            key="divider2-stable"
            onMouseDown={onDividerMouseDown('right')}
            // 4 px wide instead of 8 px — narrower physical footprint to keep
            // the visual gap between chat-pane right edge and conference-panel
            // left edge tight. The drag handle still hits-tests because the
            // inner pill is 4 px wide too. Without this, the divider was
            // contributing half of an 8+px gap that combined with the chat
            // feed's px-6 right padding to make the LEFT-of-videos gap
            // look much larger than the right-of-videos gap.
            style={{ width: 4, flexShrink: 0, cursor: 'col-resize', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20 }}
            className="group relative app-div2"
        >
            <div className="w-[2px] h-16 rounded-full group-hover:bg-cl-lume/40 transition-colors" />
        </div>
    );

    const pane4El = (
        <div key="pane4-stable" className="select-none app-pane4" style={{ width: rightWidth, minWidth: RIGHT_PANEL_MIN_PX, maxWidth: sidebarMaxPx(windowWidth), flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderTopRightRadius: '1rem' }}>
            {/* bg-cl-deep split back OFF this <aside> and onto the scroll zone
                below (round three on this exact question). Round one moved it
                there; round two moved it back here on the theory that seeing
                the app's base bg-cl-abyss (#0B0F1E) where cl-deep used to be
                read as an unwanted NEW dark patch rather than "no background."
                Direct owner correction: "now it looks the same as it did
                before, so still not transparent like I wanted" — confirming
                the uniform-everywhere result was the wrong direction; the
                bg-cl-abyss reveal was actually what was wanted. There is no
                third option here: #0B0F1E is the deepest background layer in
                the app, so "transparent" in this exact spot can only ever
                mean "reveals that", never "reveals nothing" — nothing else is
                ever positioned behind this pinned, non-scrolling strip for it
                to show instead. */}
            <aside className="relative w-full h-full flex flex-col rounded-r-2xl border-r border-white/[0.04] shadow-xl" style={{ overflow: 'hidden' }}>
                        {/* The call UI used to take over this whole panel here. It now lives
                            inline at the top of the chat-panel column (see below) so members,
                            pinned messages, storage, etc. remain visible during a call. */}

                        {globalIncomingCall && (
                            // Full redesign — the old version was a single 0.8s one-shot glow
                            // (`call-morph-glow`, `animation-fill-mode: forwards`) that finished
                            // and went completely static a fraction of a second in, while the
                            // call itself keeps ringing for up to 15s (see the ring-timeout
                            // effect above). So for nearly the whole time this screen is up,
                            // nothing on it moved — it just sat there looking unfinished. Now:
                            // continuously pulsing rings + a breathing avatar for as long as
                            // it's ringing, a shaking phone badge instead of static "Incoming
                            // Call..." text, and large circular accept/decline buttons (the
                            // iOS/Android/Discord/Teams pattern) instead of two stretched
                            // rectangular ClButtons.
                            <div
                                className="absolute inset-0 z-50 flex flex-col items-center justify-center p-6 text-center fade-pop-enter"
                                style={{
                                    background: activeCall
                                        ? 'radial-gradient(120% 120% at 50% 15%, rgba(19,26,48,0.97) 0%, rgba(11,15,30,0.99) 65%)'
                                        : 'radial-gradient(120% 120% at 50% 15%, var(--cl-deep) 0%, var(--cl-abyss) 65%)',
                                    backdropFilter: activeCall ? 'blur(12px)' : undefined,
                                }}
                            >
                                <IncomingCallWaves />
                                <div className="relative mb-8 shrink-0" style={{ width: 136, height: 136 }}>
                                    <div className="cl-incall-ring" />
                                    <div className="cl-incall-ring" />
                                    <div className="cl-incall-ring" />
                                    <div className="cl-incall-ring" />
                                    <div className="cl-incall-avatar w-full h-full relative z-10" style={{ boxShadow: '0 10px 40px rgba(0,0,0,0.55)', borderRadius: '50%' }}>
                                        <EncryptedAvatar
                                            attachmentId={globalIncomingCall.callerAvatarId}
                                            userId={globalIncomingCall.callerUserId}
                                            isGroup={globalIncomingCall.isGroup}
                                            token={token}
                                            className="w-full h-full"
                                            fallbackSize={48}
                                            disableClickProfile
                                        />
                                    </div>
                                </div>
                                <h2
                                    className="m-0 mb-3 max-w-full truncate px-2"
                                    style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 25, letterSpacing: '-0.01em', color: 'var(--cl-text)' }}
                                >
                                    {globalIncomingCall.callerName}
                                </h2>
                                {/* The two-line amber disclaimer that used to sit below this
                                    is now a single badge on the same row as "Incoming call".
                                    It was replaced for two reasons, not one: it was too much
                                    prose for the two seconds a ringing call actually gets, and
                                    it only knew verified/not — so a plain first-contact TOFU
                                    call and an actively forged one rendered identically.
                                    `TrustBadge` distinguishes five states and explains the one
                                    it is showing on hover. */}
                                {/* One row, nowrap, centred as a unit — see .cl-incall-meta.
                                    The trust badge is the ICON ALONE: at this size the word
                                    "Verified" beside it was the longest thing on the row and
                                    pushed the pair off centre, while saying nothing the green
                                    shield does not. Its tooltip and aria-label still carry the
                                    full wording, so nothing is lost for a reader who wants it
                                    or for a screen reader. */}
                                <div className="cl-incall-meta mb-10">
                                    <span
                                        className="cl-incall-badge"
                                        style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--cl-lume)' }}
                                    >
                                        <PhoneIncoming size={15} />
                                        {globalIncomingCall.isGroup ? 'Incoming group call' : 'Incoming call'}
                                    </span>
                                    {globalIncomingCall.callerTrust && (
                                        <TrustBadge
                                            trust={globalIncomingCall.callerTrust}
                                            displayName={globalIncomingCall.callerName}
                                            size={17}
                                        />
                                    )}
                                </div>
                                <div className="flex items-start gap-12 shrink-0">
                                    <div className="flex flex-col items-center">
                                        <button
                                            type="button"
                                            className="cl-incall-btn cl-incall-btn--decline"
                                            onClick={() => setGlobalIncomingCall(null)}
                                            aria-label="Decline call"
                                        >
                                            <PhoneOff size={24} />
                                        </button>
                                        <span className="cl-incall-btnlabel">Decline</span>
                                    </div>
                                    <div className="flex flex-col items-center">
                                        <button
                                            type="button"
                                            className="cl-incall-btn cl-incall-btn--answer"
                                            onClick={acceptGlobalCall}
                                            aria-label={activeCall ? 'Leave current call and answer' : 'Answer call'}
                                        >
                                            <Phone size={24} />
                                        </button>
                                        <span className="cl-incall-btnlabel">{activeCall ? 'Leave & Answer' : 'Answer'}</span>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* ── Unified scroll zone — call section + per-view content scroll
                            together as one unit. The controlbar below is the only element
                            pinned outside this scroll so it stays at the panel bottom.
                            bg-cl-deep lives here, not on the outer <aside> (see its own
                            comment), so this panel's normal content keeps its usual
                            background everywhere the control bar ISN'T floating over it.
                            The control bar itself is now an absolute overlay pinned to
                            the bottom of this same scroll zone (see #call-controlbar-root
                            below) rather than a separate reserved strip — pb-24 reserves
                            room at the true bottom of the SCROLLED content so the last
                            message/tile can still be scrolled fully clear of the floating
                            pill instead of ending up hidden underneath it. ── */}
                        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar flex flex-col bg-cl-deep pb-24">

                        {/* ── Call section — video tiles, floating call card, participant
                            rows. Lives inside the unified scroll so scrolling down moves
                            these up and reveals more of the per-view content below. ── */}
                        {callPaneActive && (() => {
                            const snapCall = activeCall;
                            const isVC = !!snapCall?.isVoiceChannel;
                            const isHuddle = isVC && !!activeHuddleChannelId;
                            // Live call entry — provides participant count + spawned_at timer.
                            // snapCall is null while a join is still Connecting… (isStartingCall).
                            const liveHuddleCall = isHuddle && activeHuddleCallId
                                ? (huddleCalls[activeHuddleChannelId ?? ''] ?? []).find(c => c.call_id === activeHuddleCallId) ?? null
                                : null;
                            // ── Calls-channel encryption-key state ──────────
                            // Only the PRE-mount states (CallPane not yet up)
                            // render here — without this the key gate rendered
                            // as nothing at all: the join had already succeeded
                            // server-side (participant row + huddle:participant
                            // join fan-out + a minted, expiring LiveKit token),
                            // so the user was in the call for everyone else, saw
                            // an empty panel, and couldn't leave — the disconnect
                            // button lives on CallPane, which is what the gate
                            // blocks. Once the gate reaches 'connect' (including
                            // degraded), CallPane IS mounted, so that indicator
                            // moves inside SidebarConference itself — see the
                            // encryptionIndicatorMode passed to CallPane below,
                            // which is what makes it show for DM/group/huddle
                            // calls too, not only gated Calls-channel ones.
                            //
                            // 'loading' is deliberately never shown (owner
                            // feedback: it flashed above everything in this
                            // panel for a fraction of a second on every server
                            // call — key derivation normally resolves in well
                            // under a second, per CallEncryptionIndicator's own
                            // docstring — and reads as a UI glitch, not useful
                            // information). 'stalled' still renders: it is the
                            // ONLY leave affordance while the join has already
                            // succeeded server-side but CallPane isn't mounted
                            // yet, for the rare case the key genuinely never
                            // arrives — silently dropping that too would bring
                            // back the exact "stuck in a call with no way out"
                            // bug this gate exists to prevent.
                            //
                            // DM/group calls reach this too now that the gate
                            // covers them. They get 'loading' as well as
                            // 'stalled', unlike a Calls channel: a Calls
                            // channel derives its key locally in well under a
                            // second, so 'loading' only ever flashed there —
                            // but a DM call is waiting on a `call_key` to
                            // arrive over the network from another device, so
                            // the wait is real, visible, and worth explaining
                            // rather than showing an empty panel.
                            //
                            // This is also the ONLY way out of a blocked DM
                            // call: the join already succeeded server-side, and
                            // the disconnect button lives on CallPane, which
                            // the gate is holding back. Leaving this
                            // Calls-channel-only would have traded a plaintext
                            // call for a stuck one.
                            const keyNoticeMode: Extract<CallEncryptionIndicatorMode, 'loading' | 'stalled'> | null =
                                !snapCall ? null
                                : callsChannelGate.kind !== 'blocked' ? null
                                : callsChannelGate.stalled ? 'stalled'
                                : snapCall.callsChannelId ? null
                                : 'loading';
                            return (
                                <>
                                    {keyNoticeMode && (
                                        <CallEncryptionIndicator
                                            mode={keyNoticeMode}
                                            channelName={snapCall?.voiceChannelName ?? callServerInfo?.channelName ?? ''}
                                            // handleDisconnectCall is the real
                                            // leave: it POSTs leave_voice /
                                            // leaveHuddleCall so the participant
                                            // row and the broadcast are undone,
                                            // not just the local UI.
                                            onLeave={() => { void handleDisconnectCall(false); }}
                                        />
                                    )}

                                    {/* Video tiles always at the very top — portaled here by
                                        SidebarConference when camera/screenshare is active.
                                        No wrapper padding: SidebarConference's own px-2
                                        centers the tiles on the panel-wide gutter. */}
                                    <div id="call-video-root" className="shrink-0 w-full" />

                                    {/* Floating call card — shown only when the user has
                                        navigated away from the call's server. No server-name
                                        label; px-2 matches the panel-wide gutter so
                                        everything is the same visual width. */}
                                    {isVC && callServerInfo && !isViewingCallServer && (
                                        <div className="shrink-0 px-2 pt-2 pb-1">
                                            {isHuddle ? (
                                                /* Huddle — the FULL merged card (channel header +
                                                   call summary + participant rows), same as
                                                   ServerContextPanel's own rendering, so this really
                                                   is "the same block" following the user across tabs
                                                   rather than a stripped-down summary. */
                                                <FloatingHuddleCard
                                                    channelName={callServerInfo.channelName}
                                                    iconName={callServerInfo.iconName}
                                                    iconEmoji={callServerInfo.iconEmoji}
                                                    maxCalls={callServerInfo.maxCalls}
                                                    callId={activeHuddleCallId ?? 'live'}
                                                    callName={liveHuddleCall?.name ?? callServerInfo.channelName}
                                                    spawnedAt={liveHuddleCall?.spawned_at}
                                                    participantIds={liveHuddleCall?.participants ?? (userId ? [userId] : [])}
                                                    canRename={liveHuddleCall?.spawner_user_id === userId}
                                                    token={token}
                                                    userId={userId ?? ''}
                                                    myUsername={user?.username || 'You'}
                                                    myAvatarUrl={user?.avatar_url ?? null}
                                                    friendNameMap={friendNameMap}
                                                    expanded={floatingHuddleExpanded}
                                                    onToggleExpanded={() => setFloatingHuddleExpanded(v => !v)}
                                                    encryptionState={myCallEncryptionState}
                                                    canServerMute={callServerCanMute}
                                                    onServerMuteTrack={serverMuteFloatingParticipant}
                                                />
                                            ) : (
                                                /* Voice channel — compact indicator row */
                                                <div className="flex items-center gap-2 px-1 py-1">
                                                    <span className="relative flex h-2 w-2 shrink-0">
                                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: 'var(--cl-ok)' }} />
                                                        <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: 'var(--cl-ok)' }} />
                                                    </span>
                                                    <span className="text-[13px] font-semibold text-white/90 truncate">
                                                        {callServerInfo.channelName}
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Participant rows — always anchored here so SidebarConference
                                        (CallSidebarPortal) never remounts on navigation. The DOM
                                        node never disappears so CallSidebarPortal's MutationObserver
                                        never loses its target reference — the LiveKit room stays
                                        connected across all view switches.

                                        For a huddle call, this root is ALWAYS CSS-hidden
                                        (display:none), whether viewing the call's own server or
                                        not — a dedicated participant-row rendering already covers
                                        both cases: ServerContextPanel's own list when viewing the
                                        server, FloatingHuddleCard's list (above) when away. Without
                                        this, the away-from-server case showed the SAME participant
                                        twice — this root's own row alongside FloatingHuddleCard's.
                                        Audio/video processing inside SidebarConference continues
                                        uninterrupted even while this container is invisible; only
                                        video tiles (#call-video-root) and controls
                                        (#call-controlbar-root) are separate portals unaffected by
                                        this hide.

                                        NO padding of its own — the actual root cause, found
                                        by live-measuring against the search bar's width
                                        rather than guessing another pixel value: this div's
                                        content is SidebarConference, which for a normal (non-
                                        portal) call renders its video tiles inside its OWN
                                        internal scrollContainerRef — and that container
                                        ALREADY reserves a symmetric inset on every side
                                        (`scrollbarGutter: 'stable both-edges'` horizontally,
                                        `pt-3 pb-3` vertically — see its own comment in
                                        SidebarConference.tsx). Every px-2/pt-2/pb-2 tried
                                        here at the Dashboard.tsx level was stacking a SECOND,
                                        independent inset on top of that first one — making
                                        the video narrower than the search bar (double-counted
                                        horizontally) even after both insets were internally
                                        symmetric on their own axis. The voice-channel (server)
                                        path never has this problem because it portals video
                                        tiles to #call-video-root, bypassing
                                        scrollContainerRef's inset entirely — there is only
                                        ever ONE layer for server calls, never two. Fixing the
                                        real double-count here, at the one place it actually
                                        lives, instead of adding a third compensating layer.
                                        No border-b: it read as a stray divider between the
                                        call and the search bar / rest of the panel below. */}
                                    <div
                                        id="call-sidebar-root"
                                        className="shrink-0 w-full flex flex-col relative"
                                        style={isHuddle ? { display: 'none' } : undefined}
                                    />
                                </>
                            );
                        })()}

                        {/* Per-view content — natural height inside the unified scroll zone.
                            No individual overflow — the scroll zone above handles paging. */}
                        <div className="flex flex-col">
                        {(
                            activeTab === 'friends' ? (() => {
                            // Derived fresh on every render from BOTH live sources, so it no
                            // longer matters whether the friends-list seed, the WS status
                            // batch, or the presence poll lands first. See utils/activeNow.ts
                            // for why the old `fs?.status ?? presence[...]` chain silently
                            // dropped online friends.
                            const onlineFriends = selectActiveFriends(globalFriends?.accepted || [], friendStatuses, displayPresence);
                            return (
                                <div className="flex flex-col p-4">
                                    <h4 className="text-[11px] font-mono font-semibold uppercase tracking-widest mb-2 ml-1 text-cl-faint">Active Now</h4>
                                    {onlineFriends.length === 0 ? (
                                        <div className="rounded-[14px] border border-cl-border/40 bg-cl-surface/40 flex flex-col items-center justify-center p-6 mt-2">
                                            <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mb-3">
                                                <Users className="w-5 h-5 text-cl-faint" />
                                            </div>
                                            <h3 className="text-cl-muted font-semibold mb-1 text-sm">No one&apos;s active right now</h3>
                                            <p className="text-xs text-center max-w-[200px] text-cl-faint">When a friend comes online, they&apos;ll appear here!</p>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col gap-1">
                                            {onlineFriends.map(f => (
                                                <div
                                                    key={f.user_id}
                                                    className="flex items-center gap-2.5 px-2.5 py-1.5 bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.02] rounded-lg transition-all group relative cursor-default"
                                                    onContextMenu={(e) => {
                                                        const items: import('./primitives/ContextMenu').ContextMenuItem[] = [
                                                            { icon: <User size={14} />, label: 'View Profile', onSelect: () => openProfileAt(f.user_id, { x: window.innerWidth / 2, y: window.innerHeight / 2 }) },
                                                            { icon: <MessageSquare size={14} />, label: 'Message', onSelect: () => { openDMWithUser(f.user_id, f.username, f.avatar_url); } },
                                                            { icon: <PhoneCall size={14} />, label: 'Call', onSelect: () => startGlobalCall(f.user_id) },
                                                            ...(servers.length > 0 ? [{ divider: true as const }, { icon: <UserPlus size={14} />, label: 'Invite to Server', onSelect: () => {}, submenu: buildInviteToServerItems(f.user_id) }] : []),
                                                            { icon: <Users size={14} />, label: 'Add to group chat', onSelect: () => setAddToGroupTarget({ user_id: f.user_id, username: f.username, avatar_url: f.avatar_url }) },
                                                            { divider: true as const },
                                                            { icon: <UserX size={14} />, label: 'Remove friend', danger: true, onSelect: async () => { try { await axios.delete(`${API_BASE}/friends/${f.user_id}`, { headers: { Authorization: `Bearer ${token}` } }); axios.get(`${API_BASE}/friends`, { headers: { Authorization: `Bearer ${token}` }}).then(res => setGlobalFriends(res.data)).catch(() => {}); } catch(e) { toast.push({ kind: 'error', title: 'Remove Failed', message: 'Failed to remove friend' }); } } },
                                                            { icon: <UserX size={14} />, label: 'Block', danger: true, onSelect: () => handleSidebarBlock(f.user_id, f.username) },
                                                            { icon: <Flag size={14} />, label: 'Report User', danger: true, onSelect: () => setReportTarget({ id: f.user_id, username: f.username }) },
                                                        ];
                                                        friendListMenu.open(e, items, f.username);
                                                    }}
                                                >
                                                    <div className="w-8 h-8 rounded-full shrink-0 relative cursor-pointer" onClick={(e) => openProfileAt(f.user_id, { x: e.clientX, y: e.clientY })}>
                                                        <div className="w-full h-full rounded-full flex items-center justify-center overflow-hidden">
                                                            <EncryptedAvatar
                                                                attachmentId={f.avatar_url ?? null}
                                                                userId={f.user_id}
                                                                token={token}
                                                                className="w-full h-full"
                                                                fallbackSize={13}
                                                            />
                                                        </div>
                                                        <span className="absolute -bottom-0.5 -right-0.5 z-10 flex items-center justify-center">
                                                            {/* Real resolved status, not a hardcoded "online" — the section now
                                                                includes away/dnd friends, and the dot has to say which. */}
                                                            <StatusIcon status={resolveActiveStatus(f.user_id, friendStatuses, displayPresence)} currentGame={friendStatuses[f.user_id]?.current_game ?? null} onMobile={!!friendStatuses[f.user_id]?.on_mobile} size={9} />
                                                        </span>
                                                    </div>
                                                    <div className="flex-1 min-w-0 pr-2 cursor-pointer" onClick={(e) => openProfileAt(f.user_id, { x: e.clientX, y: e.clientY })}>
                                                        <p className="font-semibold text-[13px] text-white truncate leading-tight group-hover:text-cl-lume transition-colors">{f.username}</p>
                                                        <p className="text-[11px] truncate leading-tight" style={{ color: 'var(--cl-faint)' }}>
                                                            {friendStatuses[f.user_id]?.current_game
                                                                ? friendStatuses[f.user_id].current_game
                                                                : STATUS_CONFIG[resolveActiveStatus(f.user_id, friendStatuses, displayPresence)].label}
                                                        </p>
                                                    </div>

                                                    {/* Hover action buttons — absolutely positioned so they never eat
                                                        layout space from the username / game-name column. */}
                                                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity bg-cl-deep/90 backdrop-blur-sm rounded-full px-1 py-0.5">
                                                        <ClButton
                                                            icon
                                                            size="sm"
                                                            variant="ghost"
                                                            tooltip="Message"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                openDMWithUser(f.user_id, f.username, f.avatar_url);
                                                            }}
                                                        >
                                                            <MessageSquare size={14} />
                                                        </ClButton>
                                                        <ClButton
                                                            icon
                                                            size="sm"
                                                            variant="ghost"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                const items: import('./primitives/ContextMenu').ContextMenuItem[] = [
                                                                    { icon: <User size={14} />, label: 'View Profile', onSelect: () => openProfileAt(f.user_id, { x: window.innerWidth / 2, y: window.innerHeight / 2 }) },
                                                                    { icon: <MessageSquare size={14} />, label: 'Message', onSelect: () => { openDMWithUser(f.user_id, f.username, f.avatar_url); } },
                                                                    { icon: <PhoneCall size={14} />, label: 'Call', onSelect: () => startGlobalCall(f.user_id) },
                                                                    ...(servers.length > 0 ? [{ divider: true as const }, { icon: <UserPlus size={14} />, label: 'Invite to Server', onSelect: () => {}, submenu: buildInviteToServerItems(f.user_id) }] : []),
                                                                    { icon: <Users size={14} />, label: 'Add to group chat', onSelect: () => setAddToGroupTarget({ user_id: f.user_id, username: f.username, avatar_url: f.avatar_url }) },
                                                                    { divider: true as const },
                                                                    { icon: <UserX size={14} />, label: 'Remove friend', danger: true, onSelect: async () => { try { await axios.delete(`${API_BASE}/friends/${f.user_id}`, { headers: { Authorization: `Bearer ${token}` } }); axios.get(`${API_BASE}/friends`, { headers: { Authorization: `Bearer ${token}` }}).then(res => setGlobalFriends(res.data)).catch(() => {}); } catch(e) { toast.push({ kind: 'error', title: 'Remove Failed', message: 'Failed to remove friend' }); } } },
                                                                    { icon: <UserX size={14} />, label: 'Block', danger: true, onSelect: () => handleSidebarBlock(f.user_id, f.username) },
                                                                    { icon: <Flag size={14} />, label: 'Report User', danger: true, onSelect: () => setReportTarget({ id: f.user_id, username: f.username }) },
                                                                ];
                                                                friendListMenu.open(e, items, f.username);
                                                            }}
                                                        >
                                                            <MoreVertical size={16} />
                                                        </ClButton>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })() : activeChannel ? (() => {
                            const srv = servers.find(s => s.server_id === activeChannel.server_id);
                            if (!srv) return null;
                            return (
                                <ServerContextPanel
                                    server={srv}
                                    channel={activeChannel}
                                    token={token}
                                    userId={userId}
                                    myPermissions={myPermissions[srv.server_id] ?? 0n}
                                    allChannels={serverChannels[srv.server_id] || []}
                                    voiceParticipants={voiceParticipants}
                                    activeVoiceChannelId={activeVoiceChannelId}
                                    huddleCalls={huddleCalls}
                                    activeHuddleCallId={activeHuddleCallId}
                                    myCallEncryptionState={myCallEncryptionState}
                                    searchableMessages={(channelMessages[activeChannel.channel_id] ?? []).map((m: any) => ({
                                        id: m.id,
                                        sender_user_id: m.sender_user_id,
                                        sender_display_name: m.sender_display_name ?? undefined,
                                        text: typeof m.content?.text === 'string' ? m.content.text : '',
                                        created_at: m.created_at,
                                    }))}
                                    friendStatuses={friendStatuses}
                                    presenceAuthoritative={presenceAuthoritative}
                                    myStatus={myStatus}
                                    myCurrentGame={myCurrentGame}
                                    globalFriends={globalFriends}
                                    conversations={conversations}
                                    sentFriendRequests={sentFriendRequests}
                                    setSentFriendRequests={setSentFriendRequests}
                                    onOpenProfile={openProfileAt}
                                    onStartChat={handleStartChat}
                                    onOpenDMWithUser={openDMWithUser}
                                    onStartCall={startGlobalCall}
                                    onBlock={handleSidebarBlock}
                                    onReport={(uid, uname) => setReportTarget({ id: uid, username: uname })}
                                    categories={serverCategories[srv.server_id] || []}
                                    onChannelsChanged={() => { loadChannels(srv.server_id); reloadCategories(srv.server_id); }}
                                    onJoinVoiceChannel={handleJoinVoiceChannel}
                                    onSpawnHuddleCall={handleSpawnHuddleCall}
                                    onJoinExistingHuddleCall={handleJoinExistingHuddleCall}
                                    callCooldownSecs={callCooldownSecs}
                                    onLeaveHuddleCall={handleLeaveHuddleCall}
                                    onRenameHuddleCall={(callId, name) => renameHuddleCall(callId, name)}
                                    onJumpToMessage={(id) => jumpToMessageRef.current?.(id)}
                                    onMemberRoleColorsChange={(colors) => setServerMemberRoleColors(prev => ({ ...prev, [srv.server_id]: colors }))}
                                    onMemberAvatarMapChange={(map) => setServerMemberAvatarMaps(prev => ({ ...prev, [srv.server_id]: map }))}
                                    onMemberNicknamesChange={setServerMemberNicknames}
                                    rolesRefreshKey={serverRolesRefreshKey}
                                    onBuildInviteToServerItems={buildInviteToServerItems}
                                    channelPermissionsMap={channelPermissionsMaps[srv.server_id] ?? {}}
                                    showPinnedPanel={pinnedSidebarExpanded && !!activeChannel}
                                    onClosePinnedPanel={togglePinnedSidebar}
                                    /* Server-backed pins — same list the pin button writes to
                                       (the pinned subset, not every server save). */
                                    pinnedCount={(activeChannel ? channelPinnedIds[activeChannel.channel_id] : undefined)?.length ?? 0}
                                    pinnedSearchQuery={pinnedSidebarExpanded ? chatSearch : ''}
                                    onPinnedSearchChange={(q) => setChatSearch(q)}
                                />
                            );
                        })() : activeChat ? (
                            <div className="flex flex-col w-full">

                                {/* Search bar — always at top of the DM/group panel. */}
                                        <div className="shrink-0 px-2 py-2">
                                            <ClSearch
                                                icon={<Search size={15} />}
                                                className="text-[13px]"
                                                style={{ paddingTop: 8, paddingBottom: 8, borderRadius: 11 }}
                                                placeholder={pinnedSidebarExpanded ? 'Search pinned messages' : 'Search in chat'}
                                                type="text"
                                                value={chatSearch}
                                                onChange={e => setChatSearch(e.target.value)}
                                            />
                                        </div>
                                        {/* Profile card — DS DesktopContextPanel · DMContext: an 84px
                                            banner (lume radial over the sink + faded mark watermark),
                                            a 58px avatar with a lume glow ring overlapping the banner,
                                            then name + status. Group is a simpler centred card. */}
                                        {activeChat.type === 'dm' ? (() => {
                                            const fs = activeChat.other_user_id ? friendStatuses[activeChat.other_user_id] : undefined;
                                            const liveStatus = fs?.status ?? 'offline';
                                            const onMobile = liveStatus !== 'offline' && !!fs?.on_mobile;
                                            const game = onMobile ? null : (fs?.current_game ?? null);
                                            const baseLabel = (game && liveStatus !== 'offline')
                                                ? `Playing ${game}`
                                                : liveStatus === 'offline'
                                                    ? (formatLastSeen(dmPartnerProfile?.last_seen_at) ?? 'Offline')
                                                    : liveStatus === 'online' ? 'Online'
                                                        : liveStatus === 'away' ? 'Idle'
                                                            : liveStatus === 'dnd' ? 'Do Not Disturb' : 'Offline';
                                            const statusLabel = onMobile ? `${baseLabel} · on mobile` : baseLabel;
                                            return (
                                                <div className="px-2 pt-1 shrink-0">
                                                    <div className="overflow-hidden mb-3.5" style={{ background: 'var(--cl-surface)', border: '1px solid var(--cl-border)', borderRadius: 14 }}>
                                                        {/* Banner strip — the partner's real banner when they have one
                                                            (decrypted via the shared Banner component, friend-gated),
                                                            otherwise the lume-glow + watermark placeholder. */}
                                                        {dmPartnerProfile?.banner_url ? (
                                                            <Banner
                                                                attachmentId={dmPartnerProfile.banner_url}
                                                                fallbackUserId={activeChat.other_user_id ?? null}
                                                                token={token ?? ''}
                                                                height={84}
                                                                fadeToColor="var(--cl-surface)"
                                                            />
                                                        ) : (
                                                            <div className="relative flex items-center justify-center" style={{ height: 84, background: 'radial-gradient(130px 90px at 50% 128%, var(--cl-lume-tint), transparent 72%), var(--cl-sink)' }}>
                                                                <img src={cipherlineMark} alt="" width={38} style={{ opacity: 0.16 }} />
                                                            </div>
                                                        )}
                                                        <div className="flex flex-col items-center px-3.5 pb-4" style={{ marginTop: -26 }}>
                                                            <div className="w-[58px] h-[58px] rounded-full shrink-0 relative" style={{ boxShadow: '0 0 0 5px var(--cl-surface), 0 0 24px rgba(37,224,200,.26)' }}>
                                                                <div className="w-full h-full rounded-full overflow-hidden flex items-center justify-center">
                                                                    <EncryptedAvatar
                                                                        attachmentId={activeChat.avatar_url ?? null}
                                                                        userId={activeChat.other_user_id}
                                                                        token={token}
                                                                        className="w-full h-full"
                                                                        fallbackSize={24}
                                                                    />
                                                                </div>
                                                                {activeChat.other_user_id && (
                                                                    <span className="absolute bottom-0 right-0 z-20 flex items-center justify-center rounded-full" style={{ border: '3px solid var(--cl-surface)' }}>
                                                                        <StatusIcon status={liveStatus} currentGame={game && liveStatus !== 'offline' ? game : null} onMobile={onMobile} size={14} />
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div
                                                                className="font-display cursor-pointer hover:text-[var(--cl-lume)] transition-colors"
                                                                style={{ fontWeight: 600, fontSize: 18, color: 'var(--cl-text)', marginTop: 9 }}
                                                                onClick={(e) => activeChat.other_user_id && openProfileAt(activeChat.other_user_id, { x: e.clientX, y: e.clientY })}
                                                            >
                                                                {activeChat.title || 'Unknown'}
                                                            </div>
                                                            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--cl-faint)', marginTop: 3 }}>{statusLabel}</div>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })() : (
                                            <div className="px-2 pt-1 shrink-0">
                                                <div className="mb-3.5 text-center" style={{ background: 'var(--cl-surface)', border: '1px solid var(--cl-border)', borderRadius: 14, padding: 16 }}>
                                                    <div className="font-display" style={{ fontWeight: 600, fontSize: 17, color: 'var(--cl-text)' }}>{activeChat.title || 'Unknown'}</div>
                                                    <div className="inline-flex items-center justify-center gap-1.5" style={{ marginTop: 6, color: 'var(--cl-muted)', fontSize: 11.5, fontWeight: 700 }}>
                                                        <Users size={12} /> {groupMembers.length} members
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                {/* ── Scrollable details ──
                                       Out of call: flex-1 (fills the panel below the title) with
                                       its own internal scroll. During a call the entire panel body
                                       is one big scroll list (the wrapper above owns overflow-y-auto),
                                       so this section is just shrink-0 and content scrolls with
                                       the rest. Position changes are handled by the morph wrapper
                                       above resizing — this block just rides along on flex layout. */}
                                <div className="flex flex-col">

                                {/* ── Shared · Media / Files / Links — DS SharedRow.
                                       Real counts from the loaded messages (attachments by
                                       mime, links by URL match in text). ── */}
                                {(() => {
                                    const cmsgs = messagesState[activeChat.id] || [];
                                    let media = 0, files = 0, links = 0;
                                    for (const m of cmsgs) {
                                        const c: any = (m as any).content;
                                        if (!c) continue;
                                        if (c.type === 'attachment') {
                                            const mime = typeof c.mime === 'string' ? c.mime : '';
                                            if (mime.startsWith('image/') || mime.startsWith('video/')) media++;
                                            else files++;
                                        } else if (c.type === 'text' && typeof c.text === 'string' && /https?:\/\/\S+/i.test(c.text)) {
                                            links++;
                                        }
                                    }
                                    const tiles: { icon: React.ReactNode; n: number; label: string; tab: SharedTab }[] = [
                                        { icon: <ImageIcon size={17} />, n: media, label: 'Media', tab: 'media' },
                                        { icon: <FolderOpen size={17} />, n: files, label: 'Files', tab: 'files' },
                                        { icon: <LinkIcon size={17} />, n: links, label: 'Links', tab: 'links' },
                                    ];
                                    return (
                                        <div className="px-2 pt-1">
                                            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--cl-faint)', padding: '2px 2px 8px' }}>Shared</div>
                                            <div className="flex" style={{ gap: 8, marginBottom: 14 }}>
                                                {tiles.map(t => (
                                                    <button
                                                        key={t.label}
                                                        type="button"
                                                        onClick={() => setSharedContentTab(t.tab)}
                                                        title={`Browse shared ${t.label.toLowerCase()}`}
                                                        className="flex flex-col items-center transition-all hover:-translate-y-0.5 cursor-pointer"
                                                        style={{ flex: 1, gap: 5, background: 'var(--cl-surface)', border: '1px solid var(--cl-border)', borderRadius: 14, padding: '11px 8px' }}
                                                        onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--cl-lume)')}
                                                        onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--cl-border)')}
                                                    >
                                                        <span style={{ color: 'var(--cl-lume)', display: 'flex' }}>{t.icon}</span>
                                                        <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--cl-text)', fontFamily: 'var(--cl-font-body)' }}>{t.n}</span>
                                                        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--cl-faint)' }}>{t.label}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })()}

                                {/* Bio (DM only) */}
                                {activeChat.type === 'dm' && dmPartnerProfile?.bio && (
                                    <div className="px-4 pt-3 pb-2 border-b border-white/[0.02]">
                                        <p className="text-[10px] font-mono font-semibold uppercase tracking-widest mb-1.5 text-cl-faint">About</p>
                                        <p className="text-[12px] leading-relaxed break-words whitespace-pre-wrap" style={{ color: 'var(--cl-faint)' }}>{dmPartnerProfile.bio}</p>
                                    </div>
                                )}

                                {/* Show the "Active Call" green pill ONLY when there's a call in
                                    this conversation that the local user has not joined. Two
                                    independent gates because they cover different races:
                                      1. activeCall matches conversation — local-state truth.
                                      2. participant_users contains us — server-state truth.
                                    During the start-call request the server sometimes reports
                                    the call (and us in it) before activeCall is set locally;
                                    without gate (2) the pill flashes briefly during start. */}
                                <AnimatePresence>
                                {callCardVisible
                                    && !(activeCall && activeCall.conversation_id === activeChat.id)
                                    && !(activeChatCallStatus?.participant_users || []).some((u: any) => u.user_id === userId)
                                    && (
                                    <motion.div
                                        key="call-card"
                                        // Was `pr-2` (right padding only) while every sibling section
                                        // in this panel (Shared, Bio, Pinned Messages) uses `px-2` —
                                        // this card sat flush against the left edge instead of
                                        // inset like everything around it. Also now matches Pinned
                                        // Messages' exact pt-2/pb-2 rhythm rather than its own pb-1.
                                        className="px-2 pt-2 pb-2 shrink-0"
                                        initial={{ opacity: 0, y: -8 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -8 }}
                                        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                                    >
                                        {/* Radius + border/bg tokens now match the Shared tiles and
                                            profile card above (14px, --cl-border-weight) instead of
                                            Tailwind's rounded-xl (12px). Green was Tailwind's
                                            green-500/400/50 (#22c55e-family) — a visibly different hue
                                            from --cl-ok (#4ADE80), the actual "online/ok" green used
                                            everywhere else (status dots, the Answer button below) — so
                                            this card was quietly off-brand every time it appeared. */}
                                        <div style={{ width: '100%', borderRadius: 14, overflow: 'hidden', background: 'linear-gradient(135deg, rgba(74,222,128,0.10), rgba(74,222,128,0.04))', border: '1px solid rgba(74,222,128,0.22)' }}>
                                            <div className="flex items-center gap-3 px-3 pt-3 pb-2">
                                                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(74,222,128,0.18)' }}>
                                                    <PhoneCall className="w-4 h-4" style={{ color: 'var(--cl-ok)' }} />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-[13px] font-semibold leading-tight" style={{ color: 'var(--cl-text)' }}>Active Call</div>
                                                    <div className="text-[11px] leading-tight mt-0.5" style={{ color: 'var(--cl-ok)', opacity: 0.8 }}>{activeChatCallStatus?.participants || 0} in call</div>
                                                </div>
                                                <div className="flex items-center shrink-0">
                                                    {(activeChatCallStatus?.participant_users || []).slice(0, 4).map((u: any) => (
                                                        <div key={u.user_id} className="w-6 h-6 rounded-full ring-2 ring-cl-abyss -ml-1.5 first:ml-0 overflow-hidden" title={u.username}>
                                                            <EncryptedAvatar
                                                                attachmentId={u.avatar_url ?? null}
                                                                userId={u.user_id}
                                                                token={token}
                                                                className="w-full h-full"
                                                                fallbackSize={12}
                                                            />
                                                        </div>
                                                    ))}
                                                    {(!activeChatCallStatus?.participant_users || activeChatCallStatus.participant_users.length === 0) && (
                                                        <div className="w-6 h-6 rounded-full bg-cl-surface ring-2 ring-cl-abyss flex items-center justify-center overflow-hidden">
                                                            <Users className="w-3 h-3 text-cl-faint" />
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="px-3 pb-3">
                                                <ClButton
                                                    variant="ok"
                                                    fullWidth
                                                    onClick={async () => {
                                                        if (!token) return;
                                                        try {
                                                            const res = await axios.post(`${API_BASE}/calls/${activeChatCallStatus.session_id}/join`, {}, { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } });
                                                            setActiveCall({
                                                                id: res.data.session_id,
                                                                conversation_id: activeChatCallStatus.conversation_id || activeChat?.id,
                                                                livekit_url: res.data.livekit_url,
                                                                livekit_token: res.data.livekit_token || '',
                                                                e2ee_key_b64: callKeyStoreRef.current[activeChatCallStatus.session_id] || '',
                                                                mode: res.data.mode || 'sfu'
                                                            });
                                                        } catch (e: any) {
                                                            console.error('Failed to join active call', e);
                                                            if (e?.response?.status === 409) {
                                                                toast.push({ kind: 'info', title: 'Answered elsewhere', message: 'This call was already joined from your other device.' });
                                                            }
                                                        }
                                                    }}
                                                >
                                                    Join Call
                                                </ClButton>
                                            </div>
                                        </div>
                                    </motion.div>
                                )}
                                </AnimatePresence>

                                {/* ── Pinned Messages collapsible section ──
                                    Always shown for both DMs and groups — matches the same
                                    polished card button layout in both chat types. Stays
                                    visible during calls (the call section above shrinks the
                                    available space but doesn't replace it). */}
                                {(() => {
                                    const pinCount = (pinnedMessagesState[activeChat.id] || []).length;
                                    return (
                                        <div className="px-2 pt-2 pb-1 shrink-0">
                                            <ClButton
                                                variant="ghost"
                                                fullWidth
                                                onClick={togglePinnedSidebar}
                                                className="text-left"
                                            >
                                                <div className="flex items-center justify-center shrink-0" style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--cl-lume-tint)', color: 'var(--cl-lume)' }}>
                                                    <Pin className="w-4 h-4" />
                                                </div>
                                                <div className="flex-1 min-w-0 text-left">
                                                    <div className="text-[13px] font-semibold leading-tight" style={{ color: 'var(--cl-text)' }}>Pinned Messages</div>
                                                    <div className="text-[11px] leading-tight mt-0.5" style={{ color: 'var(--cl-faint)' }}>
                                                        {pinCount > 0
                                                            ? `${pinCount} ${pinCount === 1 ? 'message' : 'messages'} pinned`
                                                            : 'None pinned yet'}
                                                    </div>
                                                </div>
                                                <ChevronDown className={`w-4 h-4 shrink-0 transition-transform duration-200 ${pinnedSidebarExpanded ? 'rotate-180' : ''}`} style={{ color: 'var(--cl-muted)' }} />
                                            </ClButton>
                                        </div>
                                    );
                                })()}

                                {/* Portal target / empty state — wrapped in AnimatePresence so the
                                    panel slides open and closed smoothly rather than snapping. */}
                                <AnimatePresence>
                                {pinnedSidebarExpanded && (
                                    <motion.div
                                        key="pinned-dm-panel"
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: 'auto', opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                                        style={{ overflow: 'hidden' }}
                                    >
                                        {(pinnedMessagesState[activeChat.id] || []).length > 0 ? (
                                            <div
                                                id="pinned-panel-root"
                                                className="flex flex-col overflow-hidden"
                                                style={{ height: '50vh' }}
                                            />
                                        ) : (
                                            <div className="flex flex-col items-center justify-center px-8 py-10 text-center">
                                                <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mb-3 ring-1 ring-white/10">
                                                    <Pin className="w-5 h-5 text-cl-faint" />
                                                </div>
                                                <p className="text-[13px] text-cl-muted font-semibold">No pinned messages</p>
                                            </div>
                                        )}
                                    </motion.div>
                                )}
                                </AnimatePresence>

                                {/* No horizontal padding here — every section inside (member
                                    rows, Local Storage, Options) carries its own px-2, and the
                                    wrapper's old pr-2 double-padded them 8px narrower on the
                                    right than the Shared/Pinned sections above. */}
                                {!pinnedSidebarExpanded ? (<div className="pl-0 pr-0 pt-3 pb-4 flex flex-col">
                                    {/* Top-content wrapper — Members list (groups) or Media
                                        Archive (DMs). In the unified scroll context there is no
                                        "panel fold" to push to, so grow/min-h-full are dropped;
                                        Storage + Options appear naturally after the list. */}
                                    <div className="flex flex-col">
                                    {/* Group members list */}
                                    {activeChat.type === 'group' && (
                                        /* px-2 matches the "Shared" section's own wrapper (and the
                                           Pinned Messages card above it). Without it this section had NO
                                           horizontal padding, so the member rows' hover backgrounds ran
                                           wider than every other element in the panel. */
                                        <div className="mb-5 px-2">
                                            {/* Byte-for-byte the same style object as the "Shared" heading
                                                above, rather than a Tailwind approximation of it. The old
                                                classes differed on three axes at once: font-mono (a
                                                different TYPEFACE entirely), font-semibold vs 800, and
                                                tracking-widest (.1em) vs .08em — plus ml-1 instead of the
                                                2px left padding, so the two headings did not line up
                                                either. Keep these identical; they are siblings in the same
                                                panel and should read as one system. */}
                                            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--cl-faint)', padding: '2px 2px 8px' }}>Members ({groupMembers.length})</div>
                                            {groupMembersLoading ? (
                                                <div className="text-xs text-center py-4" style={{ color: 'var(--cl-faint)' }}>Loading...</div>
                                            ) : (
                                                <div className="flex flex-col gap-0.5">
                                                    {groupMembers.map(m => {
                                                        const isFriend = globalFriends?.accepted.some(f => f.user_id === m.user_id);
                                                        const isMe = m.user_id === userId;

                                                        return (
                                                        <div
                                                            key={m.user_id}
                                                            className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/5 transition-colors relative group w-full cursor-pointer"
                                                            onClick={(e) => {
                                                                // Let clicks on buttons / menus fall through to them.
                                                                if ((e.target as HTMLElement).closest('button, a, input')) return;
                                                                openProfileAt(m.user_id, { x: e.clientX, y: e.clientY });
                                                            }}
                                                            onContextMenu={(e) => {
                                                                if (isMe) return;
                                                                const _items: import('./primitives/ContextMenu').ContextMenuItem[] = isFriend ? [
                                                                    { icon: <User size={14} />, label: 'View Profile', onSelect: () => openProfileAt(m.user_id, { x: window.innerWidth / 2, y: window.innerHeight / 2 }) },
                                                                    { icon: <MessageSquare size={14} />, label: 'Message', onSelect: () => { openDMWithUser(m.user_id, m.username, m.avatar_url); } },
                                                                    { icon: <PhoneCall size={14} />, label: 'Call', onSelect: () => startGlobalCall(m.user_id) },
                                                                    ...(servers.length > 0 ? [{ divider: true as const }, { icon: <UserPlus size={14} />, label: 'Invite to Server', onSelect: () => {}, submenu: buildInviteToServerItems(m.user_id) }] : []),
                                                                    { divider: true as const },
                                                                    { icon: <UserX size={14} />, label: 'Remove friend', danger: true, onSelect: async () => { try { await axios.delete(`${API_BASE}/friends/${m.user_id}`, { headers: { Authorization: `Bearer ${token}` } }); axios.get(`${API_BASE}/friends`, { headers: { Authorization: `Bearer ${token}` }}).then(res => setGlobalFriends(res.data)).catch(() => {}); } catch(e) { toast.push({ kind: 'error', title: 'Remove Failed', message: 'Failed to remove friend' }); } } },
                                                                    { icon: <UserX size={14} />, label: 'Block', danger: true, onSelect: () => handleSidebarBlock(m.user_id, m.username) },
                                                                    { icon: <Flag size={14} />, label: 'Report User', danger: true, onSelect: () => setReportTarget({ id: m.user_id, username: m.username }) },
                                                                ] : [
                                                                    { icon: <User size={14} />, label: 'View Profile', onSelect: () => openProfileAt(m.user_id, { x: window.innerWidth / 2, y: window.innerHeight / 2 }) },
                                                                    ...(sentFriendRequests.has(m.user_id)
                                                                        ? [{ icon: <UserPlus size={14} />, label: 'Friend Request Sent', disabled: true, onSelect: () => {} }]
                                                                        : [{ icon: <UserPlus size={14} />, label: 'Add Friend', onSelect: async () => { try { await axios.post(`${API_BASE}/friends/request`, { target_username: m.username }, { headers: { Authorization: `Bearer ${token}` } }); setSentFriendRequests(prev => new Set(prev).add(m.user_id)); nudges.notify({ kind: 'friend_request_sent' }); } catch(_) {} } }]
                                                                    ),
                                                                    { icon: <UserX size={14} />, label: 'Block', danger: true, onSelect: () => handleSidebarBlock(m.user_id, m.username) },
                                                                    { icon: <Flag size={14} />, label: 'Report User', danger: true, onSelect: () => setReportTarget({ id: m.user_id, username: m.username }) },
                                                                ];
                                                                groupMemberMenu.open(e, _items, m.username);
                                                            }}
                                                        >
                                                            <div className="relative w-9 h-9 shrink-0">
                                                                <div className="w-full h-full rounded-full flex items-center justify-center overflow-hidden">
                                                                    <EncryptedAvatar
                                                                        attachmentId={m.avatar_url ?? null}
                                                                        userId={m.user_id}
                                                                        token={token}
                                                                        className="w-full h-full"
                                                                        fallbackSize={16}
                                                                        bypassFriendGate
                                                                    />
                                                                </div>
                                                                {/* Status dot when online/away/dnd or offline, game controller only when actively present. */}
                                                                {(() => {
                                                                    const _status = isMe ? myStatus : (friendStatuses[m.user_id]?.status ?? 'offline');
                                                                    const _onMobile = !isMe && _status !== 'offline' && !!friendStatuses[m.user_id]?.on_mobile;
                                                                    const _game = isMe ? myCurrentGame : (friendStatuses[m.user_id]?.current_game ?? null);
                                                                    const showController = !!_game && _status !== 'offline' && !_onMobile;
                                                                    return showController ? (
                                                                        <span className="absolute bottom-0 right-[-2px] flex items-center justify-center">
                                                                            <StatusIcon status={_status} currentGame={_game} size={13} />
                                                                        </span>
                                                                    ) : (
                                                                        <span className="absolute bottom-0 right-[-1px] border-2 border-cl-deep rounded-full flex items-center justify-center">
                                                                            <StatusIcon status={_status} currentGame={null} onMobile={_onMobile} size={9} />
                                                                        </span>
                                                                    );
                                                                })()}
                                                            </div>
                                                            <div className="flex-1 min-w-0 flex flex-col leading-tight">
                                                                <span className="text-sm font-medium truncate" style={{ color: 'var(--cl-text)' }}>{m.username}</span>
                                                                {(() => {
                                                                    const _status = isMe ? myStatus : (friendStatuses[m.user_id]?.status ?? 'offline');
                                                                    const g = isMe ? myCurrentGame : (friendStatuses[m.user_id]?.current_game ?? null);
                                                                    return g && _status !== 'offline' ? (
                                                                        <span className="text-[11px] truncate mt-0.5" style={{ color: 'var(--cl-faint)' }}>{g}</span>
                                                                    ) : null;
                                                                })()}
                                                            </div>

                                                            {!isMe && (
                                                                <ClButton
                                                                    icon
                                                                    size="sm"
                                                                    variant="ghost"
                                                                    style={{ opacity: 0 }}
                                                                    className="group-hover:!opacity-100 shrink-0"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        const _items: import('./primitives/ContextMenu').ContextMenuItem[] = isFriend ? [
                                                                            { icon: <User size={14} />, label: 'View Profile', onSelect: () => openProfileAt(m.user_id, { x: window.innerWidth / 2, y: window.innerHeight / 2 }) },
                                                                            { icon: <MessageSquare size={14} />, label: 'Message', onSelect: () => { openDMWithUser(m.user_id, m.username, m.avatar_url); } },
                                                                            { icon: <PhoneCall size={14} />, label: 'Call', onSelect: () => startGlobalCall(m.user_id) },
                                                                            ...(servers.length > 0 ? [{ divider: true as const }, { icon: <UserPlus size={14} />, label: 'Invite to Server', onSelect: () => {}, submenu: buildInviteToServerItems(m.user_id) }] : []),
                                                                            { divider: true as const },
                                                                            { icon: <UserX size={14} />, label: 'Remove friend', danger: true, onSelect: async () => { try { await axios.delete(`${API_BASE}/friends/${m.user_id}`, { headers: { Authorization: `Bearer ${token}` } }); axios.get(`${API_BASE}/friends`, { headers: { Authorization: `Bearer ${token}` }}).then(res => setGlobalFriends(res.data)).catch(() => {}); } catch(e) { toast.push({ kind: 'error', title: 'Remove Failed', message: 'Failed to remove friend' }); } } },
                                                                            { icon: <UserX size={14} />, label: 'Block', danger: true, onSelect: () => handleSidebarBlock(m.user_id, m.username) },
                                                                            { icon: <Flag size={14} />, label: 'Report User', danger: true, onSelect: () => setReportTarget({ id: m.user_id, username: m.username }) },
                                                                        ] : [
                                                                            { icon: <User size={14} />, label: 'View Profile', onSelect: () => openProfileAt(m.user_id, { x: window.innerWidth / 2, y: window.innerHeight / 2 }) },
                                                                            ...(sentFriendRequests.has(m.user_id)
                                                                                ? [{ icon: <UserPlus size={14} />, label: 'Friend Request Sent', disabled: true, onSelect: () => {} }]
                                                                                : [{ icon: <UserPlus size={14} />, label: 'Add Friend', onSelect: async () => { try { await axios.post(`${API_BASE}/friends/request`, { target_username: m.username }, { headers: { Authorization: `Bearer ${token}` } }); setSentFriendRequests(prev => new Set(prev).add(m.user_id)); nudges.notify({ kind: 'friend_request_sent' }); } catch(_) {} } }]
                                                                            ),
                                                                            { icon: <UserX size={14} />, label: 'Block', danger: true, onSelect: () => handleSidebarBlock(m.user_id, m.username) },
                                                                            { icon: <Flag size={14} />, label: 'Report User', danger: true, onSelect: () => setReportTarget({ id: m.user_id, username: m.username }) },
                                                                        ];
                                                                        groupMemberMenu.open(e, _items, m.username);
                                                                    }}
                                                                >
                                                                    <MoreVertical size={14} />
                                                                </ClButton>
                                                            )}
                                                        </div>
                                                    );})}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    </div>{/* end detailsPanelTopRef wrapper */}


                                    {/* ── Local Storage + per-conversation Retention ─────── */}
                                    {userId && activeChat && (
                                        <ConvRetentionSection
                                            convId={activeChat.id}
                                            userId={userId}
                                            msgs={messagesState[activeChat.id] || []}
                                            globalMsgRetention={getEffectiveMessageRetention(retention.policy, activeChat.type === 'group' ? 'group' : 'dm')}
                                            globalAttRetention={getEffectiveAttachmentRetention(retention.policy, activeChat.type === 'group' ? 'group' : 'dm')}
                                            onChanged={() => setConvRetentionVersion(v => v + 1)}
                                            onPurgeNow={runConvSweepNow}
                                        />
                                    )}

                                    {/* ── Options — DS DesktopContextPanel ghost OptionRows ── */}
                                    <div className="shrink-0 px-2 pt-3 pb-8">
                                        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--cl-faint)', padding: '2px 2px 6px' }}>Options</div>
                                        {activeChat.type === 'group' && (
                                            <OptionRow icon={<Settings size={15} />} label="Group Settings" onClick={() => setManageGroupOpen(true)} />
                                        )}
                                        {activeChat.type === 'dm' && (
                                            <OptionRow icon={<X size={15} />} label="Close conversation" onClick={() => { setDeleteDataChecked(false); setCloseDialogState({ id: activeChat.id, title: activeChat.title || 'Chat', isGroup: false }); }} />
                                        )}
                                        {activeChat.type === 'dm' && activeChat.other_user_id ? (
                                            // You cannot block yourself (the server refuses it too).
                                            isSelfDm(activeChat, authUserId) ? null : (
                                                <OptionRow danger icon={<UserX size={15} />} label="Block contact" onClick={() => handleSidebarBlock(activeChat.other_user_id!, activeChat.title || 'this user')} />
                                            )
                                        ) : activeChat.type === 'group' ? (
                                            <OptionRow danger icon={<LogOut size={15} />} label="Leave group" onClick={() => { setDeleteDataChecked(false); setCloseDialogState({ id: activeChat.id, title: activeChat.title || 'Group', isGroup: true }); }} />
                                        ) : null}
                                    </div>
                                </div>
                            ) : null}
                                </div>{/* end scrollable details */}
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
                                <div className="flex items-center justify-center mb-4" style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--cl-lume-tint)', border: 'var(--cl-hairline)' }}>
                                    <Info className="w-6 h-6" style={{ color: 'var(--cl-lume)' }} />
                                </div>
                                <p style={{ fontSize: 13, color: 'var(--cl-faint)', fontFamily: 'var(--cl-font-body)' }}>Details show up here once you open a chat.</p>
                            </div>
                        ))}
                        </div>{/* end per-view content */}

                        </div>{/* end unified scroll zone */}

                        {/* Control bar — now FLOATS over the bottom of the scroll zone
                            instead of reserving its own strip below it. Every previous
                            round of this fix tried to make that reserved strip's
                            background disappear — uniform panel colour, then the app's
                            own base colour, neither of which was "no background",
                            because there was never anything else positioned behind that
                            strip to reveal instead. Direct owner ask, explicit: "I want
                            the pill to just be floating." absolute + pointer-events-none
                            takes it out of the flex column entirely (so the scroll zone
                            above reclaims the space) and overlays it directly on the
                            bottom of whatever's actually scrolled there — real content,
                            not a flat colour, which is the only way this ever reads as
                            genuinely background-free. pointer-events-none on this outer
                            strip (with pointer-events:auto restored on .cl-console-inner,
                            index.css) lets clicks in the empty margin either side of the
                            centered pill fall through to the content underneath instead
                            of silently eating them. SidebarConference portals its
                            ControlBar here, unchanged — only the container moved. */}
                        {callPaneActive && (
                            <div id="call-controlbar-root" className="absolute bottom-0 left-0 right-0 z-10 px-2 pb-1 pointer-events-none" />
                        )}
            </aside>
        </div>
    );

    // Avatar/banner visibility gate: only friends and yourself get full imagery.
    // Rebuild as a Set for O(1) lookup across every EncryptedAvatar render on the screen.
    const acceptedFriendIds = useMemo(
        () => new Set((globalFriends?.accepted ?? []).map(f => f.user_id)),
        [globalFriends]
    );
    const isFriendOrSelf = useCallback(
        (uid: string | null | undefined) => !!uid && (uid === userId || acceptedFriendIds.has(uid)),
        [acceptedFriendIds, userId]
    );
    // Same "don't thread a prop through the whole call component tree"
    // rationale as ProfileOpenContext — see ReportOpenContext's docblock.
    // Every consumer (PopoverMenu, chiefly) only ever reaches this for a
    // remote participant, so no isSelf check is needed here.
    const openReportAt = useCallback(
        (uid: string, username: string, snippet?: string) => setReportTarget({ id: uid, username, snippet }),
        []
    );

    // ── First-week nudges + "ask at the moment of need" (FirstWeekNudges.tsx) ──
    // Everything here is plumbing: the rules live in utils/firstWeekNudges.ts and
    // the engine in hooks/useFirstWeekNudges.ts. The inputs are REAL state this
    // component already holds; nothing is fetched for it.
    const nudgeFriendNames = useMemo(
        () => new Map<string, string>(
            (globalFriends?.accepted ?? [])
                .filter(f => f?.user_id && f?.username)
                .map(f => [f.user_id as string, f.username as string] as const),
        ),
        [globalFriends],
    );
    const nudgeVoice = useMemo(
        () => ({ voiceParticipants, huddleCalls, serverChannels, servers, friendNames: nudgeFriendNames, activeVoiceChannelId }),
        [voiceParticipants, huddleCalls, serverChannels, servers, nudgeFriendNames, activeVoiceChannelId],
    );
    // Is any message of the user's own known locally (read lazily, at evaluation)?
    const nudgeHasOwnMessage = useCallback((): boolean => {
        if (!userId) return false;
        type OwnCheck = { sender_user_id?: string; sender_device_id?: string; content?: { type?: string } } | null | undefined;
        const mine = (m: OwnCheck) => (m?.sender_user_id === userId || (!!deviceId && m?.sender_device_id === deviceId))
            && isUserAuthoredContentType(m?.content?.type);
        for (const list of Object.values(messagesStateRef.current)) for (const m of list) if (mine(m)) return true;
        for (const list of Object.values(channelMessagesRef.current)) for (const m of list) if (mine(m)) return true;
        return false;
    }, [userId, deviceId]);
    // Anything first-run / modal / celebratory on screen: stay quiet.
    const nudgeUiBusy = settingsOpen || !!deepLinkInviteCode || deviceStorage.status !== 'done'
        || showStartDMModal || showCreateGroupModal || showCreateServerModal || showJoinServerModal
        || firstFriendCelebration || showReferralWelcome || showProWelcome || !!historyRequest || !!profileModalUserId;
    const nudgeOpenDm = useCallback((uid: string | undefined, username: string) => {
        const f = (globalFriends?.accepted ?? []).find(x => (uid && x.user_id === uid) || x.username === username);
        const id = uid ?? f?.user_id;
        if (id) void openDMWithUser(id, f?.username || username, f?.avatar_url ?? undefined);
    }, [globalFriends, openDMWithUser]);
    const nudgeOpenChannel = useCallback((channelId: string) => {
        // Same sequence as Home's "open channel": navigate, never join — joining
        // (and the mic prompt that comes with it) stays the user's own click.
        for (const list of Object.values(serverChannels)) {
            const channel = list.find(c => c.channel_id === channelId);
            if (!channel) continue;
            const srv = servers.find(sv => sv.server_id === channel.server_id);
            setActiveTab('servers');
            setActiveServerView({ serverId: channel.server_id, serverName: srv?.name ?? 'Server' });
            handleSelectChannel(channel);
            void requestMissingChannelKeys(channel.server_id);
            return;
        }
    }, [serverChannels, servers, handleSelectChannel]); // eslint-disable-line react-hooks/exhaustive-deps
    const nudgeMessageYourself = useCallback(() => {
        if (!authUserId) return;
        setActiveTab('dms');
        void openDMWithUser(authUserId, selfConversationTitle(user?.username ?? ''), user?.avatar_url ?? undefined);
    }, [authUserId, openDMWithUser, user?.username, user?.avatar_url]);

    return (
        <CallProvider>
        <ProfileOpenContext.Provider value={openProfileAt}>
        <CallServerCtx.Provider value={callServerCtxValue}>
        <ReportOpenContext.Provider value={openReportAt}>
        <FriendshipContext.Provider value={isFriendOrSelf}>
        <div ref={containerRef} data-layout="drift" className="w-screen h-screen flex flex-col bg-cl-abyss text-white overflow-hidden font-sans relative">
            {/* Screen Lock — full-viewport gate (see useScreenLock.ts). Highest
                z-index in the app so it covers every modal, portal, and call
                panel; the WS connection and notifications keep running behind it. */}
            {screenLock.isLocked && <ScreenLockOverlay screenLock={screenLock} />}

            {/* Focus suspender — Friends AND Home: both render a full-width pane with no
                #call-focus-root, so both must collapse a focused stream back
                into the context panel and restore it on the way out. */}
            <CallFocusSuppressor
                suppressFocus={activeTab === 'friends' || activeTab === 'home'}
                callActive={callPaneActive}
            />
            {/* ── Titlebar ── */}
            <div className="drag-region h-[34px] w-full shrink-0 flex items-center px-3 bg-cl-abyss">
                {/* WindowControls renders null on Mac/Windows (native titleBarOverlay
                    draws those buttons instead — see electron/main.ts). Only wrap it
                    in a no-drag region when it'll actually render something: an empty
                    -webkit-app-region:no-drag div sitting inside a drag region for no
                    reason creates a drag/no-drag boundary right at the corner where
                    Windows' native overlay buttons sit, which can render as a stray
                    static seam there. */}
                {!isMac && !isWindows && !!window.electronAPI && (
                    <div className="ml-auto no-drag">
                        <WindowControls />
                    </div>
                )}
            </div>
            {/* ── Main layout ── */}
            <div className="flex flex-1 overflow-hidden app-mainrow">

            {/* Pane 1: Global Nav (Fixed Edge) */}
            <nav
                className="shrink-0 app-rail"
                style={{ width: 72, flex: 'none', background: 'var(--cl-abyss)', borderRight: '1px solid var(--cl-border)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '16px 0' }}
            >
                {/* App Logo — cipherline mascot */}
                <Mascot onClick={() => { setActiveTab('home'); setActiveChat(null); setActiveChannel(null); }} />

                {/* Top track — DMs, Groups, joined servers, add-server in one sunk
                    deck with the sliding lume pill. Verbatim structure from the
                    Redesign app.jsx top RailTrack. The active pill slides to:
                    DMs (0), Groups (1), then server N at 2+N.

                    Servers are drag-to-reorder (railServers — see
                    rail/useServerRailOrder.ts): the DndContext wraps the whole
                    track (it renders no DOM of its own, so RailTrack's
                    child-index-based pill measurement is unaffected), and only
                    the servers themselves sit in a SortableContext — DMs,
                    Groups, and the add-server tile stay fixed. */}
                <DndContext
                    sensors={railSensors}
                    onDragStart={onRailDragStart}
                    onDragOver={onRailDragOver}
                    onDragEnd={onRailDragEnd}
                >
                <RailTrack
                    activeIndex={
                        activeTab === 'home' ? -1
                            : activeTab === 'dms' ? 0
                                : activeTab === 'groups' ? 1
                                    : activeTab === 'servers'
                                        ? (() => { const si = railServers.findIndex(s => s.server_id === activeServerView?.serverId); return si < 0 ? -1 : 2 + si; })()
                                        : -1
                    }
                >
                    <RailTile
                        icon={<MessageSquare size={19} />}
                        title="Direct messages"
                        active={activeTab === 'dms'}
                        badge={railBadges.dm}
                        onClick={() => {
                            setActiveTab('dms');
                            if (!activeChat || activeChat.type !== 'dm') setPendingNavSelect('dm');
                        }}
                    />
                    <RailTile
                        icon={<MessagesSquare size={19} />}
                        title="Group chats"
                        active={activeTab === 'groups'}
                        badge={railBadges.group}
                        onClick={() => {
                            setActiveTab('groups');
                            if (!activeChat || activeChat.type !== 'group') setPendingNavSelect('group');
                        }}
                    />
                    <SortableContext items={railServerKeys} strategy={verticalListSortingStrategy}>
                    {railServers.map(srv => {
                            const isActive = activeTab === 'servers' && activeServerView?.serverId === srv.server_id;
                            const srvMode: NotifMode = serverNotifPrefs[srv.server_id] ?? (srv.default_notification_level ?? 'all');
                            const isMuted = srvMode === 'none';
                            const isOwner = srv.owner_user_id === userId;
                            const _srvPerms = myPermissions[srv.server_id] ?? 0n;
                            // Offered exactly when at least one Settings tab is
                            // visible — same helper the modal uses, so the entry
                            // point and the contents can't disagree. It used to
                            // be a hand-maintained permission list here that
                            // included CREATE_INVITE, which no tab is keyed on
                            // and which every member has by default, so everyone
                            // saw this and landed on an editable Overview.
                            const canManageSrv = canOpenServerSettings(_srvPerms, srv.owner_user_id === userId);

                            // Count-driven (utils/unreadBadges.ts) — was: sum
                            // channelUnreadCounts/channelMentionCounts over
                            // serverChannels[srv.server_id]'s channel ids, which
                            // read 0 for any server whose channel list hadn't
                            // loaded yet (every unvisited server, before the
                            // Phase-1 eager-load fix landed).
                            const srvTotals = serverRailBadges.byServer[srv.server_id];
                            const srvTotalMentions = srvTotals?.mentions ?? 0;
                            const srvRawUnread = srvTotals?.unread ?? 0;
                            // The channel ids this server's badge is counting.
                            // serverRailBadges classifies by channelToServerId,
                            // which is derived from exactly this list — so
                            // "Mark as Read" below clears precisely what the
                            // badge counted, no more and no less.
                            const srvChannelIds = (serverChannels[srv.server_id] || []).map(c => c.channel_id);
                            /** Live call activity in this server, or undefined for
                             *  "nothing visible happening" — the badge predicate. */
                            const srvCall = serverCallPresence.get(srv.server_id);


                            const railKey = `srv:${srv.server_id}`;
                            return (
                                <SortableServerTile
                                    key={srv.server_id}
                                    id={railKey}
                                    isDragging={railDragId === railKey}
                                    dropLine={getRailDropLine(railKey)}
                                >
                                <div className="relative group">
                                    {/* Inner relative wrapper sized to the button — badges absolute-position
                                        against this. They can't live inside the button itself because the
                                        button has `overflow-hidden rounded-xl` (needed to clip the server
                                        icon), which would also clip negative-offset badges out of view. */}
                                    <div
                                        className="relative"
                                        onMouseEnter={(e) => {
                                            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                            // Roster capped at 5 lines: the rail can hold many
                                            // servers and this tooltip is a fixed-position node,
                                            // so an uncapped 30-person channel would be taller
                                            // than the viewport. Names come from the presence
                                            // seed AND from the display_name on each live join
                                            // event; an id neither covered (an older API sends no
                                            // display_name) degrades to a neutral label rather
                                            // than showing a raw user id.
                                            const roster = srvCall
                                                ? summarizeCallRoster(srvCall.userIds, 5)
                                                : null;
                                            setRailTooltip({
                                                name: srv.name,
                                                anchor: { left: r.left, top: r.top, width: r.width, height: r.height },
                                                muted: isMuted,
                                                call: roster && srvCall
                                                    ? {
                                                        names: labelVoiceUsers(roster.shown, voiceUserNames),
                                                        overflow: roster.overflow,
                                                        total: srvCall.userIds.length,
                                                    }
                                                    : null,
                                            });
                                        }}
                                        onMouseLeave={() => setRailTooltip(null)}
                                        onContextMenu={(e) => {
                                            e.preventDefault();
                                            setRailTooltip(null);
                                            if (!myPermissions[srv.server_id]) loadMyPermissions(srv.server_id);
                                            // Build items as a function so the checked states
                                            // can be refreshed live via updateItems when the
                                            // user clicks a notification option.
                                            const buildItems = (currentMode: NotifMode): import('./primitives/ContextMenu').ContextMenuItem[] => {
                                                const setAndRefresh = (mode: NotifMode) => {
                                                    setServerNotifPrefs(prev => ({ ...prev, [srv.server_id]: mode }));
                                                    serverRailMenu.updateItems(buildItems(mode));
                                                };
                                                return [
                                                    {
                                                        icon: <Bell />,
                                                        label: 'Notifications',
                                                        onSelect: () => {},
                                                        submenu: [
                                                            {
                                                                icon: <Bell />,
                                                                label: 'All Messages',
                                                                checked: currentMode === 'all',
                                                                onSelect: () => setAndRefresh('all'),
                                                            },
                                                            {
                                                                icon: <BellDot />,
                                                                label: '@Mentions Only',
                                                                checked: currentMode === 'mentions',
                                                                onSelect: () => setAndRefresh('mentions'),
                                                            },
                                                            {
                                                                icon: <BellOff />,
                                                                label: 'Mute',
                                                                checked: currentMode === 'none',
                                                                onSelect: () => setAndRefresh('none'),
                                                            },
                                                        ],
                                                    },
                                                    {
                                                        icon: <CheckCheck />,
                                                        label: 'Mark as Read',
                                                        // Raw unread, not srvTotalUnread: the latter is
                                                        // forced to 0 for a muted server (whose badge is
                                                        // hidden), which would leave the only way to clear
                                                        // a muted server's counts permanently disabled.
                                                        disabled: srvRawUnread === 0 && srvTotalMentions === 0,
                                                        onSelect: () => {
                                                            const clearServer = (prev: Record<string, number>) =>
                                                                clearCountsForIds(prev, srvChannelIds);
                                                            setChannelUnreadCounts(clearServer);
                                                            setChannelMentionCounts(clearServer);
                                                        },
                                                    },
                                                    { divider: true as const },
                                                    ...(canManageSrv || isOwner ? [{
                                                        icon: <Settings />,
                                                        label: 'Server Settings',
                                                        onSelect: () => {
                                                            setActiveTab('servers');
                                                            setActiveServerView({ serverId: srv.server_id, serverName: srv.name });
                                                            setShowServerSettings(true);
                                                        },
                                                    }] : []),
                                                    {
                                                        icon: <LinkIcon />,
                                                        label: 'Copy Server ID',
                                                        onSelect: () => writeToClipboard(srv.server_id).catch(() => toast.push({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' })),
                                                    },
                                                    { divider: true as const },
                                                    {
                                                        icon: <LogOut />,
                                                        label: isOwner ? 'Owner — cannot leave' : 'Leave Server',
                                                        danger: !isOwner,
                                                        disabled: isOwner,
                                                        onSelect: () => {
                                                            if (!isOwner) setLeaveServerTarget(srv);
                                                        },
                                                    },
                                                ];
                                            };
                                            serverRailMenu.open(e, buildItems(srvMode), srv.name);
                                        }}
                                    >
                                        <button
                                            className="no-drag"
                                            onClick={() => {
                                                setActiveTab('servers');
                                                setActiveServerView({ serverId: srv.server_id, serverName: srv.name });
                                                loadChannels(srv.server_id);
                                                setPendingChannelSelect(srv.server_id);
                                                void requestMissingChannelKeys(srv.server_id);
                                            }}
                                            // Alt+ArrowUp/Down reorders this server in the rail —
                                            // the keyboard equivalent of the pointer drag (see
                                            // rail/useServerRailOrder.ts). Same convention as
                                            // cl/ClSelect.tsx's role reorder.
                                            onKeyDown={(e) => onRailTileKeyDown(e, srv.server_id)}
                                            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                                            style={{ position: 'relative', zIndex: 1, width: 44, height: 44, border: 'none', background: 'none', cursor: 'pointer', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, flex: 'none' }}
                                        >
                                            {/* 40×40 icon centred in the 44×44 tile leaves a 2px gap so the
                                                track's sliding lume pill reads as a glowing halo when active. */}
                                            <ServerIcon
                                                serverId={srv.server_id}
                                                name={srv.name}
                                                attachmentId={srv.icon_attachment}
                                                keyB64={srv.icon_key_b64}
                                                nonceB64={srv.icon_nonce_b64}
                                                token={token}
                                                className={`w-10 h-10 text-sm rounded-[10px] object-cover ${isActive ? '' : 'ring-1 ring-white/[0.08]'}`}
                                            />
                                            {!isActive && (
                                                <span aria-hidden style={{ position: 'absolute', inset: 0, borderRadius: 12, boxShadow: 'inset 0 1px 2px rgba(0,0,0,.5)', pointerEvents: 'none', opacity: 0.5 }} />
                                            )}
                                        </button>
                                    {/* Badges live OUTSIDE the button so the button's overflow-hidden
                                        (which clips the rounded server icon) doesn't also clip the badges.
                                        pointer-events-none so clicks pass through to the button below. */}
                                    {/* Unread/mention badge — same RailBadge the DM/Group rail tiles
                                        render (components/RailBadge.tsx): identical shape, size,
                                        position and typography. This used to be a bare unread dot
                                        plus a differently-styled mention pill — the exact
                                        inconsistency reported from live testing.
                                        It used to render `unread + mentions`, which double-counted
                                        every @mention: a mention sets BOTH counters, and outside a
                                        mute the mention count is a subset of the unread count, so one
                                        @mention drew a badge reading 2. resolveBadge owns the whole
                                        rule now — mention count wins outright, a mute shows only
                                        mentions, and @mentions-only draws the count in grey. It is
                                        handed the RAW unread because applying the mute is
                                        resolveBadge's decision to make, not this line's. */}
                                    {!isActive && (
                                        <RailBadge
                                            badge={resolveBadge(srvRawUnread, srvTotalMentions, srvMode)}
                                            className="z-10 pointer-events-none"
                                        />
                                    )}
                                    {/* Live-call badge — bottom-RIGHT, the only corner the rail
                                        wasn't already using: the unread dot owns bottom-centre
                                        (6px wide, centred at x=22 on the 44px tile, so it spans
                                        x=19-25 while this 16px badge at -right-1 spans x=32-48 —
                                        a 7px gap on the shared bottom row) and the mention pill
                                        owns top-right. Shown regardless of `isActive` and of mute,
                                        unlike those two: mute is about message noise, and "someone
                                        is in a call in here" stays true and useful while you're
                                        looking at the server.

                                        Only rendered when serverCallPresence has an entry, which
                                        it only does for a call in a channel this user can SEE —
                                        a private call produces no event and no seed row, so there
                                        is nothing to badge.

                                        Labelled for AT: the hover roster is mouse-only (as the
                                        rest of this rail's tooltip already is), so without this
                                        the badge would be purely decorative to a screen reader. */}
                                    {srvCall && (
                                        <div
                                            role="img"
                                            aria-label={`${srvCall.userIds.length} in call`}
                                            className="absolute -bottom-1 -right-1 z-10 pointer-events-none flex items-center justify-center rounded-full bg-cl-lume text-cl-on-lume ring-2 ring-cl-abyss"
                                            style={{ width: 16, height: 16 }}
                                        >
                                            <Volume2 size={9} strokeWidth={2.75} aria-hidden />
                                        </div>
                                    )}
                                    </div>
                                </div>
                                </SortableServerTile>
                            );
                        })}
                    </SortableContext>
                    {/* Create / Join server — an accent (lume) tile in the same
                        deck. The wrapper is the positioning context for the
                        rightward dropdown. */}
                    <div ref={addServerMenuRef} style={{ position: 'relative' }}>
                        <RailTile
                            icon={<Plus size={18} />}
                            title="Create or Join Server"
                            accent
                            onClick={() => setShowAddServerMenu(v => !v)}
                        />
                        {showAddServerMenu && (
                            /* Same panel + row vocabulary as the right-click menus (.ctxm) —
                               this IS a menu, it should speak like one. */
                            <div className="cl-kit">
                                <div className="ctxm absolute left-full top-0 ml-3 z-50" style={{ minWidth: 180 }}>
                                    <button
                                        type="button"
                                        className="ctxm-row"
                                        onClick={() => {
                                            setShowAddServerMenu(false);
                                            // Open to every plan, uncapped (2026-10-04): no Pro gate,
                                            // no owned-server cap.
                                            setShowCreateServerModal(true);
                                        }}
                                    >
                                        <span className="ci"><Server size={15} /></span>
                                        <span className="clabel">Create Server</span>
                                    </button>
                                    <button
                                        type="button"
                                        className="ctxm-row"
                                        onClick={() => { setShowAddServerMenu(false); setShowJoinServerModal(true); }}
                                    >
                                        <span className="ci"><Plus size={15} /></span>
                                        <span className="clabel">Join Server</span>
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </RailTrack>
                {/* Ghost of the server icon being dragged — dropAnimation={null}
                    same as ServerChannelList's channel/category drag overlay;
                    portaled by dnd-kit itself, so it doesn't disturb RailTrack's
                    child-index measurement above. */}
                <DragOverlay dropAnimation={null}>
                    {draggedRailServer && (
                        <div className="opacity-80 pointer-events-none shadow-2xl" style={{ width: 44, height: 44 }}>
                            <ServerIcon
                                serverId={draggedRailServer.server_id}
                                name={draggedRailServer.name}
                                attachmentId={draggedRailServer.icon_attachment}
                                keyB64={draggedRailServer.icon_key_b64}
                                nonceB64={draggedRailServer.icon_nonce_b64}
                                token={token}
                                className="w-10 h-10 text-sm rounded-[10px] object-cover"
                            />
                        </div>
                    )}
                </DragOverlay>
                {/* Screen-reader announcement for both the pointer drag and the
                    Alt+ArrowUp/Down keyboard reorder — visually hidden, same
                    convention as cl/ClSelect.tsx's reorder live region. */}
                <span
                    aria-live="polite"
                    style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}
                >
                    {railMoveAnnouncement}
                </span>
                </DndContext>

                {/* Spacer pushes the bottom deck + avatar to the floor of the rail. */}
                <span style={{ marginTop: 'auto' }} />

                {/* Update indicator — sits directly above Friends, its own slot
                    outside the RailTrack below (that track's sliding "active
                    tab" pill has no meaning for a status icon that isn't a
                    navigation target). Renders nothing until there's an update
                    to show. inCall covers every place a call can be live —
                    a 1:1/group call, a server voice channel, or a huddle —
                    since the confirm this gates is "you're about to leave
                    whichever one of these you're in". */}
                <UpdateRailTile inCall={!!activeCall || !!activeVoiceChannelId || !!activeHuddleChannelId} />

                {/* Bottom track — Friends + Settings. Settings opens a modal, so
                    its tile lights only while that modal is open. */}
                <RailTrack activeIndex={activeTab === 'friends' ? 0 : settingsOpen ? 1 : -1}>
                    <RailTile
                        icon={<Users size={19} />}
                        title="Friends"
                        active={activeTab === 'friends'}
                        /* Pending friend requests, not messages — always the loud
                           tone: there is no per-conversation mode to quieten and
                           nothing else surfaces them. */
                        badge={unreadFriends > 0 ? { count: unreadFriends, tone: 'alert' } : null}
                        onClick={() => setActiveTab('friends')}
                    />
                    <RailTile icon={<Settings size={19} />} title="Settings" active={settingsOpen} onClick={() => setSettingsOpen(true)} />
                </RailTrack>

                <StatusPicker
                        myStatus={myStatus}
                        onSetStatus={setStatus}
                        username={userId || 'me'}
                        currentGame={myCurrentGame}
                        onDismissGame={clearGame}
                        avatarAttachmentId={user?.avatar_url ?? null}
                        userId={userId}
                        token={token}
                        onEditProfile={() => setSettingsOpen(true)}
                    />
            </nav>

            {/* Main Content Area */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', overflow: 'hidden' }}>

                {/* Admin-authored announcement banners — server-resolved
                    eligibility/scheduling, client only filters what THIS user
                    has already dismissed. Sits above the billing banners:
                    an admin announcement is a deliberate, curated message,
                    so it takes visual priority over the routine billing
                    nudges below it. Renders nothing when there's nothing to
                    show. */}
                <AnnouncementBanners wsConnectCount={wsConnectCount} />

                {/* Billing status banners — trial ending (last 3 days) and
                    payment-failed. Both self-gate and are dismissible; they
                    render nothing at all in every other state. Sits with
                    HistorySyncBanner above the panes so it never overlaps the
                    call/chat layout. */}
                <TrialBanner />

                {/* Ghost-device alarm: a device on this account that nobody
                    confirmed. See docs/ghost-device.md §2.5. */}
                <OwnDeviceAlert
                    alerts={ownAlertState.alerts}
                    selfKeyMismatch={ownAlertState.selfKeyMismatch}
                    unreviewedBaseline={ownAlertState.unreviewedBaseline}
                    names={ownAlertNames}
                    onConfirm={handleOwnConfirm}
                    onReject={handleOwnReject}
                    onReviewed={() => { if (userId) ownDeviceLedger.markOwnDevicesReviewed(userId); }}
                    onManage={() => { setSettingsInitialTab('devices'); setSettingsOpen(true); }}
                />

                {/* G8: one-time notice when this device's master key is not
                    protected by an OS keyring (Linux basic_text fallback).
                    Self-gating; renders nothing on a protected device. */}
                <KeyProtectionNotice />
                <EncryptionAtRestNotice />

                {/* First-run "storage on this device" prompt — see
                    useDeviceStorageSetup. HistorySyncBanner waits for it so a
                    new device answers "how long do I keep things" BEFORE it
                    pulls history, and the two modals never stack. */}
                <DeviceStorageSetupModal
                    open={deviceStorage.status === 'prompt'}
                    onSave={deviceStorage.complete}
                />

                {deviceStorage.status === 'done' && (
                    <HistorySyncBanner
                        userId={userId}
                        token={token}
                        deviceId={deviceId}
                        historyDelivered={historyDelivered}
                        clearHistoryDelivered={clearHistoryDelivered}
                        historyDeclined={historyDeclined}
                        setHistoryDeclined={setHistoryDeclined}
                    />
                )}

                {/* Content panels row */}
                <div style={{ flex: 1, display: 'flex', minWidth: 0, overflow: 'hidden' }}>

                {activeTab === 'friends' ? (
                    <>
                    {/* Friends: full-width friends pane */}
                    <div className="view-enter app-pane-solo" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', overflow: 'hidden' }}>
                        <FriendsPane
                           onStartChat={handleStartChat}
                           onStartGroupChat={() => setShowCreateGroupModal(true)}
                           onAddToGroup={(friend) => setAddToGroupTarget(friend)}
                           onFriendsLoaded={setGlobalFriends}
                           onStartCall={startGlobalCall}
                           friendStatuses={friendStatuses}
                           onViewProfile={setProfileModalUserId}
                           friendAcceptedEvent={friendAcceptedEvent}
                           friendRequestEvent={friendRequestEvent}
                           friendRemovedEvent={friendRemovedEvent}
                           wsConnectCount={wsConnectCount}
                        />
                    </div>
                    </>
                ) : activeTab === 'home' ? (
                    <>
                    <div className="view-enter app-pane-solo" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', overflow: 'hidden' }}>
                        <HomePanel
                            userId={userId || ''}
                            displayName={user?.username || ''}
                            token={token}
                            conversations={conversations}
                            unreadCounts={unreadCounts}
                            mentionCounts={mentionCounts}
                            lastActivityAt={lastActivityAt}
                            presence={displayPresence}
                            servers={servers}
                            serverChannels={serverChannels}
                            voiceParticipants={voiceParticipants}
                            huddleCalls={huddleCalls}
                            serverMemberAvatarMaps={serverMemberAvatarMaps}
                            voiceUserNames={voiceUserNames}
                            voiceUserAvatarIds={voiceUserAvatarIds}
                            serverBadges={serverRailBadges.byServer}
                            serverLastActivityAt={serverLastActivityAt}
                            pinnedItems={pinnedHomeItems}
                            friends={globalFriends}
                            friendStatuses={friendStatuses}
                            localCallSession={localCallSession}
                            onSelectConversation={(conv) => { setActiveTab('dms'); handleStartChat({ id: conv.id, title: conv.title, type: conv.type, other_user_id: conv.other_user_id, avatar_url: conv.avatar_url }); }}
                            onJoinVoiceChannel={handleJoinVoiceChannel}
                            onJoinHuddleCall={handleJoinExistingHuddleCall}
                            onSelectServer={(serverId) => {
                                // Same sequence as clicking the server rail — see the
                                // rail button below; keep the two in step.
                                const srv = servers.find(s => s.server_id === serverId);
                                setActiveTab('servers');
                                setActiveServerView({ serverId, serverName: srv?.name ?? 'Server' });
                                loadChannels(serverId);
                                setPendingChannelSelect(serverId);
                                void requestMissingChannelKeys(serverId);
                            }}
                            onOpenChannel={(channel) => {
                                // Unlike onSelectServer above, the exact channel is
                                // already known (it came from Dashboard's own
                                // serverChannels — see HomePanel's resolvedPins), so
                                // there's no need for pendingChannelSelect's "wait for
                                // the list, then guess remembered/first" dance: select
                                // it directly, same as the sidebar's own channel list.
                                const srv = servers.find(s => s.server_id === channel.server_id);
                                setActiveTab('servers');
                                setActiveServerView({ serverId: channel.server_id, serverName: srv?.name ?? 'Server' });
                                handleSelectChannel(channel);
                                void requestMissingChannelKeys(channel.server_id);
                            }}
                            onPin={handlePinToHome}
                            onUnpin={handleUnpinFromHome}
                            onOpenStorage={() => { setSettingsInitialTab('storage'); setSettingsOpen(true); }}
                        />
                    </div>
                    </>
                ) : (
                    <div
                        className="app-callgroup"
                        data-focus-span={focusSpansSidebar ? 'sidebar' : 'chat'}
                        style={{
                            // The list + chat group is a 3-column / 2-row grid so the
                            // focused-video pane can change which columns it covers
                            // without ever moving in the DOM. Row 1 is the focused
                            // pane (auto -> 0 when there is no call), row 2 is the
                            // panes themselves. Columns are `auto` so pane 2 and the
                            // divider keep sizing themselves exactly as before —
                            // the drag divider still drives `leftWidth` and nothing
                            // about resizing changes.
                            flex: 1,
                            minWidth: 0,
                            display: 'grid',
                            gridTemplateColumns: 'auto auto minmax(0, 1fr)',
                            gridTemplateRows: 'auto minmax(0, 1fr)',
                            overflow: 'hidden',
                        }}
                    >
                        {/* Focused-stream portal target.
                            Wide: row 1 of the chat column only, so pane 2 (the
                            conversation / channel list) spans both rows and keeps
                            its full height.
                            Narrow: row 1 across every column except the server rail,
                            so the focused video gets the list's width too and the
                            list drops to row 2.
                            This node's position in the tree NEVER changes — only its
                            grid placement — so switching modes cannot reparent the
                            portal or restart the pane's entry animation. */}
                        {activeCall && (
                            <div
                                id="call-focus-root"
                                style={{
                                    gridRow: 1,
                                    gridColumn: focusSpansSidebar ? '1 / -1' : 3,
                                    minWidth: 0,
                                    overflow: 'hidden',
                                }}
                            />
                        )}

                        {/* Pane 2: Chat List */}
                        <div className="select-none app-pane2" style={{ width: leftWidth, minWidth: SIDEBAR_MIN_PX, maxWidth: sidebarMaxPx(windowWidth), flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', gridColumn: 1, gridRow: focusSpansSidebar ? 2 : '1 / 3' }}>
                            <aside ref={pane2EnterRef} className={`view-enter app-pane2-sheet w-full h-full bg-cl-deep flex flex-col rounded-l-2xl${hasFocusedStream ? ' rounded-tr-2xl' : ''} border-l border-white/[0.04] shadow-xl relative`} style={{ overflow: 'hidden' }}>
                            {/* Header & Search — only shown for DMs / Groups.
                                In server mode the search makes no sense (channels
                                have their own filtering inside ServerChannelList,
                                and the server name + banner take this space). */}
                            {(activeTab === 'dms' || activeTab === 'groups') && (
                                <div className="shrink-0 flex items-center" style={{ gap: 8, padding: '12px 12px 10px' }}>
                                    <div className="flex-1 min-w-0">
                                        <ClSearch
                                            icon={<Search size={14} />}
                                            className="text-[13.5px]"
                                            style={{ paddingTop: 9, paddingBottom: 9, borderRadius: 12 }}
                                            placeholder={activeTab === 'dms' ? 'Search DMs' : 'Search groups'}
                                            type="text"
                                            value={listSearch}
                                            onChange={e => setListSearch(e.target.value)}
                                        />
                                    </div>
                                    {/* New DM / group — bespoke 38×38 surface tile with lume plus (app.jsx ConvoList). */}
                                    <button
                                        title={activeTab === 'dms' ? 'New Direct Message' : 'Create Group Chat'}
                                        onClick={() => activeTab === 'dms' ? setShowStartDMModal(true) : setShowCreateGroupModal(true)}
                                        className="shrink-0 flex items-center justify-center transition-colors"
                                        style={{ width: 38, height: 38, background: 'var(--cl-surface)', border: '1.5px solid var(--cl-border)', borderRadius: 12, color: 'var(--cl-lume)', cursor: 'pointer' }}
                                    >
                                        <Plus size={16} strokeWidth={2.4} />
                                    </button>
                                </div>
                            )}

                            {/* List Content — server mode owns its own padding/banner
                                so it can render the banner edge-to-edge. DM/group lists
                                still want the comfortable p-2 padding. */}
                            <div
                                className={`flex-1 overflow-y-auto overflow-x-hidden w-full custom-scrollbar ${activeTab === 'servers' ? '' : 'space-y-[2px]'}`}
                                style={activeTab === 'servers' ? undefined : { padding: '2px 8px 10px' }}
                            >
                                {(activeTab === 'dms' || activeTab === 'groups') ? (() => {
                                    // Last-activity timestamp computed ONCE per conversation (it used
                                    // to be recomputed inside every sort comparison) — the same ts now
                                    // also drives the time-bucket dividers below.
                                    const sortedAndFiltered = conversations.filter(c => {
                                        const typeMatch = activeTab === 'dms' ? c.type === 'dm' : c.type === 'group';
                                        // Your own "(You)" chat also answers to "me" / "myself" (selfMatchesQuery).
                                        const searchMatch = !listSearch.trim() || (c.title || '').toLowerCase().includes(listSearch.toLowerCase())
                                            || (isSelfDm(c, authUserId) && selfMatchesQuery(listSearch, user?.username));
                                        const notHidden = !hiddenConversations.includes(c.conversation_id);
                                        return typeMatch && searchMatch && notHidden;
                                    }).map(c => {
                                        const lastMsg = (messagesState[c.conversation_id] || []).slice(-1)[0];
                                        const ts = lastMsg
                                            ? new Date(lastMsg.sent_at_client || lastMsg.timestamp || lastMsg.received_at_server).getTime()
                                            : new Date(c.created_at).getTime();
                                        return { conv: c, ts };
                                    }).sort((a, b) => b.ts - a.ts);
                                    const nowMs = Date.now();
                                    // Searching for yourself when no self chat exists yet: offer it as a
                                    // result. It is NOT listed otherwise — nothing exists in the history
                                    // until the first message (selfConversation.ts).
                                    const openSelfChat = () => {
                                        if (!authUserId) return;
                                        void openDMWithUser(authUserId, selfConversationTitle(user?.username ?? ''), user?.avatar_url ?? undefined);
                                        setListSearch('');
                                    };
                                    const selfSearchRow = activeTab === 'dms' && authUserId
                                        && selfMatchesQuery(listSearch, user?.username)
                                        && !conversations.some(c => isSelfDm(c, authUserId))
                                        ? (
                                            <div
                                                key="self-search-result"
                                                role="button"
                                                tabIndex={0}
                                                onClick={openSelfChat}
                                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSelfChat(); } }}
                                                className="group relative flex items-center cursor-pointer transition-colors hover:bg-cl-surface"
                                                style={{ gap: 11, borderRadius: 12, padding: '9px 10px' }}
                                            >
                                                <DmAvatarBadge
                                                    avatarAttachmentId={user?.avatar_url ?? null}
                                                    otherUserId={authUserId}
                                                    token={token}
                                                    status="offline"
                                                    currentGame={null}
                                                    hideStatus
                                                />
                                                <div className="flex-1 min-w-0 pr-1" style={{ lineHeight: 1.25 }}>
                                                    <h4 className="text-[14px]" style={{ fontFamily: 'var(--cl-font-body)', fontWeight: 800, color: 'var(--cl-muted)' }}>
                                                        <span className="truncate min-w-0">{selfConversationTitle(user?.username ?? '')}</span>
                                                    </h4>
                                                    <p className="text-[12px] truncate" style={{ fontWeight: 600, color: 'var(--cl-faint)' }}>Message yourself</p>
                                                </div>
                                            </div>
                                        ) : null;
                                    return sortedAndFiltered.length === 0 && !selfSearchRow ? (
                                        <MascotEmpty
                                            title={activeTab === 'dms' ? 'No direct messages' : 'No group chats'}
                                            sub={activeTab === 'dms' ? 'Add a friend to start messaging. It’s all encrypted before it leaves this machine.' : 'Create or join a group from Friends.'}
                                        >
                                            {/* FriendsPane's MascotEmpty has always passed an action; this
                                                one didn't, leaving a brand-new account with only the
                                                icon-only + in the header above to discover. */}
                                            <ClButton
                                                size="sm"
                                                onClick={() => activeTab === 'dms' ? setShowStartDMModal(true) : setShowCreateGroupModal(true)}
                                            >
                                                {activeTab === 'dms' ? 'New message' : 'New group'}
                                            </ClButton>
                                        </MascotEmpty>
                                    ) : (
                                        <>
                                        {selfSearchRow}
                                        {sortedAndFiltered.map(({ conv, ts }, i, arr) => {
                                            let prevText = conv.type === 'dm' ? 'Direct Message' : 'Group Chat';
                                            const lastMsg = (messagesState[conv.conversation_id] || []).slice(-1)[0];
                                            if (lastMsg?.content) {
                                                // Mention tokens (`<@u:USER_ID:username>`, etc. — see
                                                // src/utils/mentionTokens.ts) are wire format, not display
                                                // text: resolving them here is what keeps a mention out of
                                                // this single-line preview as a raw user id. Same helper the
                                                // full message view's renderTextWithMentions is built on top
                                                // of, so the token grammar isn't duplicated.
                                                if (lastMsg.content.type === 'text') {
                                                    prevText = mentionsToPlainText(
                                                        lastMsg.content.text,
                                                        (uid) => friendNameMap[uid]?.username,
                                                    );
                                                }
                                                else if (lastMsg.content.type === 'attachment') prevText = 'Sent an attachment';
                                                else if (lastMsg.content.type === 'call_key') prevText = 'Started a call';
                                                else if (lastMsg.content.type === 'call_end') prevText = 'Call ended';
                                                else if (lastMsg.content.type === 'safety_number') prevText = 'Shared a safety code';
                                                else if (lastMsg.content.type === 'klipy_gif') prevText = 'Sent a GIF';
                                                else prevText = 'Sent a message';
                                                
                                                if (lastMsg.sender_user_id === userId) prevText = `You: ${prevText}`;
                                            }

                                            // Time-bucket divider — rendered whenever this row's bucket
                                            // differs from the row above's. The leading "Today" is
                                            // suppressed so the top of the list stays clean; every other
                                            // transition gets a label, and the 1-year+ bucket draws its
                                            // label from the personality pool (chatListDividers.ts).
                                            const bucket = chatBucket(ts, nowMs);
                                            const prevBucket = i > 0 ? chatBucket(arr[i - 1].ts, nowMs) : null;
                                            const dividerLabel = bucket !== prevBucket && !(i === 0 && bucket === 'today')
                                                ? chatBucketLabel(bucket, nowMs)
                                                : null;
                                            return (
                                                <React.Fragment key={conv.conversation_id}>
                                                {dividerLabel && (
                                                    <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--cl-faint)', padding: '10px 6px 4px', userSelect: 'none' }}>
                                                        {dividerLabel}
                                                    </div>
                                                )}
                                                <div
                                                    onClick={() => handleStartChat({ id: conv.conversation_id, title: conv.title, type: conv.type, other_user_id: conv.other_user_id, avatar_url: conv.avatar_url })}
                                                    onContextMenu={(e) => {
                                                        const hasUnread = (unreadCounts[conv.conversation_id] || 0) > 0 || (mentionCounts[conv.conversation_id] || 0) > 0;
                                                        const isDm = conv.type === 'dm';
                                                        const convId = conv.conversation_id;
                                                        // Build items as a function so Notifications checked states
                                                        // can be refreshed live via updateItems without reopening.
                                                        const dmFriend = isDm && conv.other_user_id
                                                            ? globalFriends?.accepted.find((f: any) => f.user_id === conv.other_user_id) ?? null
                                                            : null;
                                                        const buildItems = (currentMode: NotifMode): import('./primitives/ContextMenu').ContextMenuItem[] => {
                                                            const setAndRefresh = (mode: NotifMode) => {
                                                                setConvNotifMode(convId, mode);
                                                                sidebarMenu.updateItems(buildItems(mode));
                                                            };
                                                            return [
                                                                ...(isDm && conv.other_user_id ? [{
                                                                    icon: <User />, label: 'View Profile',
                                                                    onSelect: () => openProfileAt(conv.other_user_id!, { x: e.clientX, y: e.clientY }),
                                                                }] : []),
                                                                // dmFriend gates this: buildInviteToServerItems works by DMing
                                                                // the target, which the server refuses for anyone who isn't
                                                                // an accepted friend. A DM's conversation row can outlive the
                                                                // friendship (removing a friend keeps chat history visible —
                                                                // see ChatPane's Remove Friend flow), so `isDm` alone is not
                                                                // enough here the way it is for View Profile / Copy ID.
                                                                ...(dmFriend && servers.length > 0 ? [{
                                                                    icon: <UserPlus />, label: 'Invite to Server',
                                                                    onSelect: () => {},
                                                                    submenu: buildInviteToServerItems(conv.other_user_id!),
                                                                }] : []),
                                                                {
                                                                    icon: <CheckCheck />, label: 'Mark as Read',
                                                                    disabled: !hasUnread,
                                                                    onSelect: () => setUnreadCounts(prev => {
                                                                        const next = { ...prev, [convId]: 0 };
                                                                        return next;
                                                                    }),
                                                                },
                                                                {
                                                                    icon: <LinkIcon />, label: 'Copy ID',
                                                                    onSelect: () => writeToClipboard(convId).catch(() => toast.push({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' })),
                                                                },
                                                                ...(conv.type === 'group' ? [{
                                                                    icon: <Settings />, label: 'Manage Group',
                                                                    onSelect: () => { handleStartChat({ id: convId, title: conv.title, type: conv.type }); setManageGroupOpen(true); },
                                                                }] : []),
                                                                // Same dmFriend reasoning as Invite to Server above:
                                                                // inviteMember requires mutual friendship too, and this DM
                                                                // may belong to someone who is no longer a friend.
                                                                ...(dmFriend ? [{
                                                                    icon: <Users />, label: 'Add to Group Chat',
                                                                    onSelect: () => setAddToGroupTarget({ user_id: conv.other_user_id!, username: conv.title || '', avatar_url: conv.avatar_url ?? undefined }),
                                                                }] : []),
                                                                pinnedHomeItems.some(p => p.type === 'conversation' && (p as any).id === convId)
                                                                    ? { icon: <Pin />, label: 'Unpin from Home', onSelect: () => handleUnpinFromHome({ type: 'conversation', id: convId }) }
                                                                    : { icon: <Pin />, label: 'Pin to Home', onSelect: () => handlePinToHome({ type: 'conversation', id: convId }) },
                                                                // Your own messages never notify, so there is nothing to tune.
                                                                ...(conv.is_self ? [] : [{
                                                                    icon: <Bell />, label: 'Notifications',
                                                                    onSelect: () => {},
                                                                    submenu: [
                                                                        {
                                                                            icon: <Bell />, label: 'All Messages',
                                                                            checked: currentMode === 'all',
                                                                            onSelect: () => setAndRefresh('all'),
                                                                        },
                                                                        {
                                                                            icon: <BellDot />, label: '@Mentions Only',
                                                                            checked: currentMode === 'mentions',
                                                                            onSelect: () => setAndRefresh('mentions'),
                                                                        },
                                                                        {
                                                                            icon: <BellOff />, label: 'Mute',
                                                                            checked: currentMode === 'none',
                                                                            onSelect: () => setAndRefresh('none'),
                                                                        },
                                                                    ],
                                                                }]),
                                                                { divider: true as const },
                                                                ...(dmFriend ? [{
                                                                    icon: <UserMinus />, label: 'Remove Friend',
                                                                    danger: true,
                                                                    onSelect: async () => {
                                                                        try {
                                                                            await axios.delete(`${API_BASE}/friends/${conv.other_user_id}`, { headers: { Authorization: `Bearer ${token}` } });
                                                                            axios.get(`${API_BASE}/friends`, { headers: { Authorization: `Bearer ${token}` } })
                                                                                .then(res => setGlobalFriends(res.data))
                                                                                .catch(() => {});
                                                                        } catch { toast.push({ kind: 'error', title: 'Remove Failed', message: 'Failed to remove friend' }); }
                                                                    },
                                                                }] : []),
                                                                ...(isDm && conv.other_user_id && !conv.is_self ? [{
                                                                    icon: <UserX />, label: 'Block',
                                                                    danger: true,
                                                                    onSelect: () => handleSidebarBlock(conv.other_user_id!, conv.title || ''),
                                                                }] : []),
                                                                ...(isDm && conv.other_user_id && !conv.is_self ? [{
                                                                    icon: <Flag />, label: 'Report User',
                                                                    danger: true,
                                                                    onSelect: () => setReportTarget({ id: conv.other_user_id!, username: conv.title || '' }),
                                                                }] : []),
                                                                {
                                                                    icon: conv.type === 'group' ? <LogOut /> : <Trash2 />,
                                                                    label: conv.type === 'group' ? 'Leave Group' : 'Close / Delete',
                                                                    danger: true,
                                                                    onSelect: () => { setDeleteDataChecked(false); setCloseDialogState({ id: convId, title: conv.title || 'Chat', isGroup: conv.type === 'group' }); },
                                                                },
                                                            ];
                                                        };
                                                        sidebarMenu.open(e, buildItems(notifMode(convId)), conv.title || 'Chat');
                                                    }}
                                                    className={`group relative flex items-center cursor-pointer transition-colors ${
                                                        activeChat?.id === conv.conversation_id ? 'bg-cl-surface' : 'hover:bg-cl-surface'
                                                    }`}
                                                    style={{ gap: 11, borderRadius: 12, padding: '9px 10px' }}
                                                >
                                                    {/* Active pip — lume bar hugging the list's left edge (app.jsx ConvoList). */}
                                                    {activeChat?.id === conv.conversation_id && (
                                                        <span aria-hidden style={{ position: 'absolute', left: -8, top: '50%', transform: 'translateY(-50%)', width: 4, height: 22, borderRadius: 99, background: 'var(--cl-lume)' }} />
                                                    )}
                                                    {/* DmAvatarBadge (below Dashboard's own component definitions) owns
                                                        the "Playing X" hover tooltip via cl/useClTooltip — portaled to
                                                        <body>, so it's no longer clipped by this scrolling list. */}
                                                    {conv.type === 'dm' && conv.other_user_id && (() => {
                                                        const fs = friendStatuses[conv.other_user_id];
                                                        const status: UserStatus = fs?.status ?? (displayPresence[conv.other_user_id] ? 'online' : 'offline');
                                                        const _game = fs?.current_game ?? null;
                                                        return (
                                                            <DmAvatarBadge
                                                                avatarAttachmentId={conv.avatar_url ?? null}
                                                                otherUserId={conv.other_user_id}
                                                                token={token}
                                                                status={status}
                                                                currentGame={_game}
                                                                onMobile={!!fs?.on_mobile && status !== 'offline'}
                                                                hideStatus={!!conv.is_self}
                                                            />
                                                        );
                                                    })()}
                                                    {conv.type !== 'dm' && (
                                                        <div className="w-9 h-9 rounded-full shrink-0 relative">
                                                            <div className="w-full h-full rounded-full flex items-center justify-center overflow-hidden">
                                                                <EncryptedAvatar
                                                                    attachmentId={conv.avatar_url ?? null}
                                                                    userId={null}
                                                                    isGroup
                                                                    token={token}
                                                                    className="w-full h-full"
                                                                    fallbackSize={16}
                                                                    disableClickProfile
                                                                />
                                                            </div>
                                                        </div>
                                                    )}
                                                    {(() => {
                                                        const cMode = notifMode(conv.conversation_id);
                                                        const unread = unreadCounts[conv.conversation_id] || 0;
                                                        const mentions = mentionCounts[conv.conversation_id] || 0;
                                                        const hasUnread = unread > 0;
                                                        const hasMention = mentions > 0;
                                                        // Red "unverified device" marker — visible from the picker,
                                                        // before the chat is even opened. Same rule as the in-chat
                                                        // banner (`hasUnverifiedDeviceWarning` in senderTrust.ts):
                                                        // ONLY a genuinely warnable verdict (a changed key, or a
                                                        // forgery-shaped mismatch) qualifies. Plain first contact
                                                        // is never marked — see that function's doc for why marking
                                                        // it would train this warning to be ignored.
                                                        const showUnverifiedMarker = conv.type === 'dm'
                                                            && hasUnverifiedDeviceWarning(conv.other_user_id, senderWarnings);
                                                        return (
                                                            <>
                                                                <div className="flex-1 min-w-0 pr-1" style={{ lineHeight: 1.25 }}>
                                                                    <h4 className="flex items-center gap-1 text-[14px]" style={{ fontFamily: 'var(--cl-font-body)', fontWeight: 800, color: activeChat?.id === conv.conversation_id ? 'var(--cl-text)' : 'var(--cl-muted)' }}>
                                                                        <span className="truncate min-w-0">{conv.title}</span>
                                                                        {showUnverifiedMarker && (
                                                                            <span
                                                                                className="inline-flex items-center shrink-0"
                                                                                title={`${conv.title || 'This contact'}'s identity key is unverified — open the chat and hover the shield for details.`}
                                                                            >
                                                                                <AlertTriangle
                                                                                    size={11}
                                                                                    strokeWidth={2.5}
                                                                                    className="text-cl-flash"
                                                                                    aria-label="Unverified device"
                                                                                />
                                                                            </span>
                                                                        )}
                                                                    </h4>
                                                                    <p className="text-[12px] truncate" style={{ fontWeight: 600, color: (hasUnread && cMode !== 'none') || hasMention ? 'var(--cl-muted)' : 'var(--cl-faint)' }}>
                                                                        {typingUsers[conv.conversation_id]?.size > 0 ? (
                                                                            <span className="text-cl-lume italic animate-pulse font-medium">Typing...</span>
                                                                        ) : prevText}
                                                                    </p>
                                                                </div>

                                                                {/* Right-edge accessory: badges by default, close action on hover. */}
                                                                <div className="relative flex items-center justify-end shrink-0 min-w-[24px] h-6 gap-1">
                                                                    {hasMention && (
                                                                        <div className="w-5 h-5 flex items-center justify-center rounded-full shadow-sm transition-opacity group-hover:opacity-0 group-hover:pointer-events-none opacity-100" style={{ background: 'var(--cl-glow)', color: 'var(--cl-on-glow)' }}>
                                                                            <AtSign size={10} strokeWidth={2.6} />
                                                                        </div>
                                                                    )}
                                                                    {hasUnread && cMode !== 'none' && !hasMention && (
                                                                        <div className="flex items-center justify-center rounded-full font-extrabold shadow-sm transition-opacity group-hover:opacity-0 group-hover:pointer-events-none opacity-100" style={{ minWidth: 19, height: 19, padding: '0 5px', fontSize: 10.5, background: 'var(--cl-flash)', color: 'var(--cl-on-flash)' }}>
                                                                            {unread > 99 ? '99+' : unread}
                                                                        </div>
                                                                    )}
                                                                    <HoverActions
                                                                        className="absolute right-0 top-1/2 -translate-y-1/2"
                                                                        actions={[
                                                                            {
                                                                                icon: <X strokeWidth={2.5} />,
                                                                                label: conv.type === 'group' ? 'Leave Group' : 'Close / Delete DM',
                                                                                onClick: () => { setCloseDialogState({ id: conv.conversation_id, title: conv.title || 'Chat', isGroup: conv.type === 'group' }); setDeleteDataChecked(false); },
                                                                            },
                                                                        ]}
                                                                    />
                                                                </div>
                                                            </>
                                                        );
                                                    })()}
                                                </div>
                                                </React.Fragment>
                                            );
                                        })}
                                        </>
                                    );
                                })() : activeTab === 'servers' ? (
                                    (() => {
                                        const srv = servers.find(s => s.server_id === activeServerView?.serverId);
                                        if (!srv) {
                                            return (
                                                <div className="flex flex-col items-center justify-center h-full px-4 text-center" style={{ opacity: 0.5 }}>
                                                    <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-3"
                                                        style={{ background: 'var(--cl-lume-tint)', border: 'var(--cl-hairline)' }}>
                                                        <Server className="w-6 h-6" style={{ color: 'var(--cl-lume)' }} />
                                                    </div>
                                                    <h3 className="text-sm font-medium" style={{ fontFamily: 'var(--cl-font-display)', color: 'var(--cl-text)' }}>select a server</h3>
                                                    <p className="text-xs mt-1" style={{ color: 'var(--cl-faint)' }}>your communities, encrypted.</p>
                                                </div>
                                            );
                                        }
                                        const _srvPermsHere = myPermissions[srv.server_id] ?? 0n;
                                        const isThisServerOwner = srv.owner_user_id === userId;
                                        // Same single source of truth as the server-rail context
                                        // menu above — see canOpenServerSettings.
                                        const canManageThisSrv = canOpenServerSettings(_srvPermsHere, isThisServerOwner);
                                        return (
                                            <>
                                            <ServerChannelList
                                                server={srv}
                                                channels={serverChannels[srv.server_id] || []}
                                                categories={serverCategories[srv.server_id] || []}
                                                loading={channelsLoading[srv.server_id] ?? false}
                                                activeChannelId={activeChannel?.kind === 'text' ? (activeChannel?.channel_id ?? null) : null}
                                                onSelectChannel={handleSelectChannel}
                                                token={token}
                                                userId={userId}
                                                myPermissions={myPermissions[srv.server_id] ?? 0n}
                                                onOpenMemberOptions={() => setShowMemberOptionsModal(true)}
                                                /* canOpenServerSettings already short-circuits for the
                                                   owner, so no separate owner clause is needed here. */
                                                onOpenServerSettings={canManageThisSrv ? () => setShowServerSettings(true) : undefined}
                                                onOpenInvite={() => setShowInviteModal(true)}
                                                // Notification props
                                                unreadCounts={channelUnreadCounts}
                                                mentionCounts={channelMentionCounts}
                                                serverNotifMode={serverNotifPrefs[srv.server_id] ?? (srv.default_notification_level ?? 'all')}
                                                onMarkChannelRead={(cid) => {
                                                    setChannelUnreadCounts(prev => { const n = {...prev}; delete n[cid]; return n; });
                                                    setChannelMentionCounts(prev => { const n = {...prev}; delete n[cid]; return n; });
                                                }}
                                                // After any inline channel/category mutation lands, reload both
                                                // the channel list and the category list so the sidebar reflects
                                                // the new state without needing a full server reload.
                                                onChannelsChanged={() => {
                                                    loadChannels(srv.server_id);
                                                    reloadCategories(srv.server_id);
                                                }}
                                                // handleChannelCreated closes over bootstrapAndDistributeChannelKey,
                                                // which now mutates bootstrapInFlightRef — the compiler can't prove
                                                // across this prop boundary that ServerSettingsModal's ChannelsTab
                                                // only calls onChannelCreated from its own createChannel() click
                                                // handler (verified: server/ServerSettingsModal.tsx —
                                                // `onChannelCreated?.(res.data)` fires inside an async click
                                                // handler, never during render).
                                                // eslint-disable-next-line react-hooks/refs
                                                onChannelCreated={(ch) => handleChannelCreated(srv.server_id, ch)}
                                                onDeleteChannelApi={async (ch) => {
                                                    await axios.delete(`${API_BASE}/servers/${srv.server_id}/channels/${ch.channel_id}`, {
                                                        headers: { Authorization: `Bearer ${token}` },
                                                    });
                                                    // If the deleted channel was active, drop the selection
                                                    if (activeChannel?.channel_id === ch.channel_id) setActiveChannel(null);
                                                }}
                                                onDeleteCategoryApi={async (cat) => {
                                                    await axios.delete(`${API_BASE}/servers/${srv.server_id}/categories/${cat.category_id}`, {
                                                        headers: { Authorization: `Bearer ${token}` },
                                                    });
                                                }}
                                            />
                                            </>
                                        );
                                    })()
                                ) : activeTab === 'files' ? (
                                    <div className="flex flex-col items-center justify-center h-full opacity-50 px-4 text-center">
                                        <FolderOpen className="w-10 h-10 text-cl-faint mb-3" />
                                        <h3 className="text-cl-muted text-sm font-semibold">Shared Folders</h3>
                                        <p className="text-cl-faint text-xs mt-1">Encrypted file sharing — coming soon.</p>
                                    </div>
                                ) : activeTab === 'calendar' ? (
                                    <div className="flex flex-col items-center justify-center h-full opacity-50 px-4 text-center">
                                        <Calendar className="w-10 h-10 text-cl-faint mb-3" />
                                        <h3 className="text-cl-muted text-sm font-semibold">Calendar</h3>
                                        <p className="text-cl-faint text-xs mt-1">Shared calendar & scheduling — coming soon.</p>
                                    </div>
                                ) : null}
                            </div>
                        </aside>
                    </div>

                    {/* Drag Divider 1 - sits perfectly between List and Chat */}
                    <div
                        onMouseDown={onDividerMouseDown('left')}
                        style={{ width: 1, flexShrink: 0, cursor: 'col-resize', display: 'flex', zIndex: 20, gridColumn: 2, gridRow: focusSpansSidebar ? 2 : '1 / 3' }}
                        className="group relative app-div1"
                    >
                        <div className="w-full h-full bg-white/[0.04]"></div>
                        <div className="absolute top-0 bottom-0 -left-1 -right-1 z-30" />
                        <div className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 w-1 h-32 rounded-full opacity-0 group-hover:opacity-100 bg-cl-lume/40 transition-opacity z-40 pointer-events-none" />
                    </div>

                        {/* Right section: Pane 3 — always row 2, column 3. The
                            focused pane above it is a grid sibling now (see the
                            portal target at the top of this group), not a child. */}
                        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden', gridColumn: 3, gridRow: 2 }}>
                            {/* Inner row: Pane 3 (Divider 2 + Pane 4 are now stable siblings outside) */}
                            <div style={{ flex: 1, display: 'flex', minWidth: 0, overflow: 'hidden' }}>
                                {/* Pane 3: Main Chat View */}
                                <div className="app-pane3" style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderTopRightRadius: '1rem' }}>
                                    <main className="app-pane3-sheet w-full h-full bg-cl-abyss flex flex-col relative" style={{ overflow: 'hidden', flex: 1, minHeight: 0 }}>
                                        <div
                                            key={activeChat?.id ?? activeChannel?.channel_id ?? 'empty'}
                                            className="view-enter w-full h-full flex flex-col flex-1 min-h-0"
                                        >
                                        {activeChat ? (
                                            <ChatPane
                                                bundleReady={bundleReady}
                                                activeChat={activeChat}
                                                onAddToGroup={() => {
                                                    if (activeChat?.other_user_id) {
                                                        setAddToGroupTarget({ user_id: activeChat.other_user_id, username: activeChat.title || '', avatar_url: activeChat.avatar_url });
                                                    }
                                                }}
                                                messages={messagesState[activeChat.id] || []}
                                                onMessageSent={handleOptimisticMessage}
                                                typingUsers={typingUsers[activeChat.id] || new Set()}
                                                sendTypingEvent={privacy.settings.showTypingIndicators ? sendTypingEvent : () => {}}
                                                readReceipts={readReceipts[activeChat.id] || {}}
                                                sendReadReceipt={sendReadReceipt}
                                                showReadReceipts={privacy.settings.showReadReceipts}
                                                activeCall={activeCall}
                                                onCallChange={handleConvCallChange}
                                                onStartingCallChange={setIsStartingCall}
                                                chatSearch={pinnedSidebarExpanded ? '' : chatSearch}
                                                friendRemovedEvent={friendRemovedEvent}
                                                onCloseChatRequest={() => { setDeleteDataChecked(false); setCloseDialogState({ id: activeChat.id, title: activeChat.title || 'Chat', isGroup: activeChat.type === 'group' }); }}
                                                notifPref={notifMode(activeChat.id)}
                                                onSetNotifMode={(mode) => setConvNotifMode(activeChat.id, mode)}
                                                retention={retention}
                                                friendStatuses={friendStatuses}
                                                pinnedMsgIds={pinnedMessagesState[activeChat.id] || []}
                                                onPinMessage={(msgId) => handlePinMessage(activeChat.id, msgId)}
                                                onUnpinMessage={(msgId) => handleUnpinMessage(activeChat.id, msgId)}
                                                pinnedSidebarExpanded={pinnedSidebarExpanded}
                                                onTogglePinnedSidebar={togglePinnedSidebar}
                                                /* Used to open a full-panel pinned overlay during a call;
                                                   the call panel is now inline so the regular pinned
                                                   toggle does the right thing. */
                                                onOpenPinnedCallOverlay={() => { if (!pinnedSidebarExpanded) togglePinnedSidebar(); }}
                                                pinnedSearchQuery={pinnedSidebarExpanded ? chatSearch : ''}
                                                jumpToMessageRef={jumpToMessageRef}
                                                onOpenProfile={setProfileModalUserId}
                                                avatarUpdatedEvent={avatarUpdatedEvent}
                                                servers={servers}
                                                onInviteJoin={(serverId, serverName) => {
                                                    loadServers();
                                                    setActiveTab('servers');
                                                    setActiveServerView({ serverId, serverName });
                                                    loadChannels(serverId);
                                                    setPendingChannelSelect(serverId);
                                                    // Pull channel keys distributed by existing members, and
                                                    // file key requests for anything still missing — this
                                                    // in-chat invite-embed join path was the one join flow
                                                    // that skipped the key sweep entirely (JoinServerModal
                                                    // and the deep-link invite flow both already do this).
                                                    void requestMissingChannelKeys(serverId);
                                                    setTimeout(() => void requestMissingChannelKeys(serverId), 3000);
                                                }}
                                                onInviteCodeClick={(code) => setDeepLinkInviteCode(code)}
                                                channelMessageRetention={activeConvRetention.msg}
                                                channelAttachmentRetention={activeConvRetention.att}
                                                convType={activeChat?.type === 'group' ? 'group' : 'dm'}
                                                myUserId={userId ?? ''}
                                                keyChangedSenders={keyChangedSenders}
                                                senderWarnings={senderWarnings}
                                                onKeyChangeResolved={clearSenderWarning}
                                                onReport={(id, username, snippet) => setReportTarget({ id, username, snippet })}
                                            />
                                        ) : activeChannel ? (
                                            /* Server text channel — Sender Keys send path.
                                               Voice channels never land here; their UI lives
                                               entirely in the right-hand ServerContextPanel. */
                                            <ChatPane
                                                bundleReady={bundleReady}
                                                activeChat={activeChannelAsChat ?? { id: activeChannel.channel_id }}
                                                activeChannel={activeChannel}
                                                emojisChangedEvent={emojisChangedEvent}
                                                messages={channelMessages[activeChannel.channel_id] || []}
                                                messagesFetching={!!channelMessagesFetching[activeChannel.channel_id]}
                                                onMessageSent={() => {/* channel send handled by onChannelMessageSent */}}
                                                onChannelMessageSent={handleChannelMessageSent}
                                                typingUsers={typingUsers[activeChannel.channel_id] || new Set()}
                                                sendTypingEvent={privacy.settings.showTypingIndicators ? sendTypingEvent : () => {}}
                                                readReceipts={readReceipts[activeChannel?.channel_id || ''] || {}}
                                                sendReadReceipt={sendReadReceipt}
                                                showReadReceipts={privacy.settings.showReadReceipts}
                                                activeCall={null}
                                                onCallChange={() => {}}
                                                retention={channelRetention}
                                                friendStatuses={friendStatuses}
                                                /* Channel pins are SERVER-BACKED and shared with the whole
                                                   server (POST/DELETE /v1/channels/:cid/pins/:mid, listed on
                                                   channel entry). Pin used to be a client-only bookmark here —
                                                   and before that it was literally `onPinMessage={() => {}}` —
                                                   so pinning in a channel never reached anyone else.
                                                   Save to server is its own action now (SAVE_MESSAGES,
                                                   /v1/channels/:cid/saves/:mid): `serverSavedIds` is every
                                                   saved message (amber icon, no expiry countdown),
                                                   `pinnedMsgIds` the pinned subset (pin button + pinned
                                                   sidebar). Pinning saves; unpinning keeps the save. */
                                                serverSavedIds={channelServerSaves[activeChannel.channel_id] || []}
                                                pinnedMsgIds={channelPinnedIds[activeChannel.channel_id] || []}
                                                onPinMessage={(msgId) => handleServerPinChannel(activeChannel.channel_id, msgId)}
                                                onUnpinMessage={(msgId) => handleServerUnpinChannel(activeChannel.channel_id, msgId)}
                                                onServerSaveMessage={(msgId) => handleServerSaveChannel(activeChannel.channel_id, msgId)}
                                                onServerUnsaveMessage={(msgId) => handleServerUnsaveChannel(activeChannel.channel_id, msgId)}
                                                pinnedSidebarExpanded={pinnedSidebarExpanded}
                                                onTogglePinnedSidebar={togglePinnedSidebar}
                                                onOpenPinnedCallOverlay={() => {}}
                                                pinnedSearchQuery={pinnedSidebarExpanded ? chatSearch : ''}
                                                jumpToMessageRef={jumpToMessageRef}
                                                onOpenProfile={setProfileModalUserId}
                                                avatarUpdatedEvent={avatarUpdatedEvent}
                                                memberRoleColors={serverMemberRoleColors[activeChannel.server_id] ?? {}}
                                                serverMemberNicknames={serverMemberNicknames}
                                                channelMessageRetention={activeChannelRetention.msg}
                                                channelAttachmentRetention={activeChannelRetention.att}
                                                convType="server"
                                                servers={servers}
                                                onInviteJoin={(serverId, serverName) => {
                                                    loadServers();
                                                    setActiveTab('servers');
                                                    setActiveServerView({ serverId, serverName });
                                                    loadChannels(serverId);
                                                    setPendingChannelSelect(serverId);
                                                    // Pull channel keys distributed by existing members, and
                                                    // file key requests for anything still missing — this
                                                    // in-chat invite-embed join path was the one join flow
                                                    // that skipped the key sweep entirely (JoinServerModal
                                                    // and the deep-link invite flow both already do this).
                                                    void requestMissingChannelKeys(serverId);
                                                    setTimeout(() => void requestMissingChannelKeys(serverId), 3000);
                                                }}
                                                onInviteCodeClick={(code) => setDeepLinkInviteCode(code)}
                                                channelPermissions={
                                                    activeChannel.my_permissions
                                                        ? (() => { try { return BigInt(activeChannel.my_permissions); } catch { return undefined; } })()
                                                        : undefined
                                                }
                                                channelKeyMissing={!!awaitingChannelKeys[activeChannel.channel_id]}
                                                channelKeyCoolingOff={isCoolingOff(channelKeyCoolOff[activeChannel.channel_id], Date.now())}
                                                onLoadOlderFromServer={loadOlderChannelMessages}
                                                channelHistoryExhausted={!!channelHistoryExhausted[activeChannel.channel_id]}
                                                onChannelKeyMissing={(serverId, channelId) => {
                                                    setAwaitingChannelKeys(prev => ({ ...prev, [channelId]: true }));
                                                    void channelKeyOpsRef.current.maybeFileKeyRequest(serverId, channelId);
                                                }}
                                                onReport={(id, username, snippet) => setReportTarget({ id, username, snippet })}
                                            />
                                        ) : (
                                            <div className="flex-1 flex flex-col items-center justify-center" style={{ opacity: 0.5 }}>
                                                <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6"
                                                    style={{ background: 'var(--cl-lume-tint)', border: 'var(--cl-hairline)', boxShadow: 'var(--cl-glow-lume)' }}>
                                                    <img src={cipherlineMark} alt="" width={36} height={29} style={{ filter: 'drop-shadow(0 0 8px rgba(37,224,200,0.3))' }} />
                                                </div>
                                                <h2 className="text-lg font-medium" style={{ fontFamily: 'var(--cl-font-display)', color: 'var(--cl-text)', letterSpacing: '0.01em' }}>pick up where you left off</h2>
                                                <p className="text-sm mt-2" style={{ color: 'var(--cl-faint)' }}>encrypted, like everything else.</p>
                                            </div>
                                        )}
                                        </div>
                                    </main>
                                </div>
                            </div>{/* end inner row */}
                        </div>{/* end right section */}

                    {/* end list + chat grid group */}
                    </div>
                )}

                {/* Drag Divider 2 + Pane 4 — rendered OUTSIDE the activeTab ternary so they
                    stay at a stable position in the React tree on every tab switch. React
                    matches them by key ("divider2-stable" / "pane4-stable"), preventing the
                    call-panel DOM nodes (#call-video-root, #call-sidebar-root) from being
                    unmounted when the user navigates to the Friends tab.

                    Only mounted when there's something to contextualise: an open chat or
                    channel, a server view, a live call, or the Friends tab. `callPaneActive`
                    is part of the condition so the call portals survive a tab switch mid-call
                    (the original stability concern). When genuinely idle — Home, or DM/group
                    lists with nothing selected — the panel collapses so the chat area runs
                    full-width instead of showing an empty placeholder.

                    `activeTab === 'friends'` is listed explicitly because pane4 is where the
                    "Active Now" section lives. Without it that section only appeared when
                    some UNRELATED thing (an open DM, channel, or live call) happened to be
                    keeping pane4 mounted — so opening the Friends tab from a cold start, or
                    after closing the last chat, showed no Active Now at all. That read as
                    "the Active Now section sometimes doesn't come up", and it was really a
                    mount condition that never mentioned the one tab the section belongs to.
                    The Friends tab always has something to contextualise: who is around. */}
                {(callPaneActive || !!activeChat || !!activeChannel || activeTab === 'friends' || (activeTab === 'servers' && !!activeServerView)) && (
                    <>
                        {divider2El}
                        {pane4El}
                    </>
                )}

                </div>{/* end content panels row */}
            </div>{/* end main content flex (column) */}
            </div>{/* end flex flex-1 overflow-hidden (nav + content) */}

            {/* Modals and Overlays */}
            <ClModal
                open={!!sidebarBlockConfirm}
                onClose={() => setSidebarBlockConfirm(null)}
                width={400}
                cardStyle={{ padding: '32px' }}
            >
                <h2 className="text-xl font-bold text-cl-text mt-0 mb-2">Block {sidebarBlockConfirm?.username}?</h2>
                <p className="text-sm text-cl-muted mb-6" style={{ lineHeight: 1.5 }}>
                    {sidebarBlockConfirm?.username} won't be able to send you friend requests or messages. They won't be notified that you blocked them.
                </p>
                {/* flex:1 goes on wrapper divs, not ClButton's `style` — ClButton's
                    `style` prop lands on the outer .clb wrapper span, not the inner
                    .cap that actually paints, so a plain style={{flex:1}} stretched
                    the (invisible) wrapper while .cap stayed content-width, exposing
                    the danger variant's .l/.l2 depth-shadow layers as a stray block
                    of color to the right of the "Block" label. `fullWidth` makes
                    ClButton stretch .cap to match its wrapper instead. */}
                <div style={{ display: 'flex', gap: '12px' }}>
                    <div style={{ flex: 1 }}>
                        <ClButton variant="ghost" fullWidth onClick={() => setSidebarBlockConfirm(null)}>Cancel</ClButton>
                    </div>
                    <div style={{ flex: 1 }}>
                        <ClButton variant="danger" fullWidth onClick={confirmSidebarBlock}>Block</ClButton>
                    </div>
                </div>
            </ClModal>
            {historyRequest && (
                <HistoryRequestModal
                    request={historyRequest}
                    onClose={() => setHistoryRequest(null)}
                />
            )}
            {/* First-week nudges + the "want a ping?" ask: at most one small in-app
                card at a time, only while you're actively here. Renders nothing
                almost always — see FirstWeekNudges.tsx. */}
            <FirstWeekNudges
                friendsLoaded={globalFriends !== null}
                friendCount={globalFriends?.accepted?.length ?? 0}
                serversLoaded={sawServersLoadingRef.current && !serversLoading}
                serverCount={servers.length}
                voice={nudgeVoice}
                userStatus={myStatus ?? 'online'}
                activeCall={!!activeCall}
                screensharing={false}
                gameActive={!!myCurrentGame}
                uiBusy={nudgeUiBusy}
                hasOwnMessage={nudgeHasOwnMessage}
                onOpenDm={nudgeOpenDm}
                onOpenChannel={nudgeOpenChannel}
                onPreviewInvite={setDeepLinkInviteCode}
                onMessageYourself={nudgeMessageYourself}
            />
            {/* Finish-setup checklist (self-gating; renders only for freshly-onboarded accounts) */}
            <OnboardingChecklist
                refreshSignal={checklistRefreshSignal}
                onOpenSettings={(tab) => { setSettingsInitialTab(tab); setSettingsOpen(true); }}
            />
            {/* Signup attribution: the one-shot "friend request to whoever invited you" offer
                (self-gating), and the inviter's "your friend joined" toast. */}
            <ReferrerFriendOffer />
            <ReferralJoinedToast />
            {/* "Welcome to Pro" celebration — shown once after a paid subscription activates */}
            {showProWelcome && (
                <ProWelcome onClose={dismissProWelcome} />
            )}
            {/* Referral welcome banner — shown once when the new user enters the dashboard
                having signed up with a valid referral code. */}
            <AnimatePresence>
                {showReferralWelcome && (
                    <ReferralWelcomeBanner days={referralBonusDays} onDismiss={dismissReferralWelcome} />
                )}
            </AnimatePresence>
            {firstFriendCelebration && (
                <FirstFriendConfetti onDone={() => setFirstFriendCelebration(false)} />
            )}
            {/* Modals */}
            {settingsOpen && (
                <SettingsScreen
                    initialTab={settingsInitialTab}
                    onClose={() => { setSettingsOpen(false); setSettingsInitialTab(undefined); setChecklistRefreshSignal(s => s + 1); }}
                    onViewProfile={() => { setSettingsOpen(false); userId && setProfileModalUserId(userId); }}
                    onLogout={handleLock}
                    retention={retention}
                    messagesState={messagesState}
                    onClearAllMessages={handleClearAllMessages}
                    conversations={conversations}
                    onPurgeConversation={handlePurgeConversation}
                    onPurgeTypeNow={onPurgeTypeNow}
                    countExpiringForType={countExpiringForType}
                    keybinds={keybinds}
                    voice={voice}
                    gameSettings={gameSettings}
                    currentGame={myCurrentGame}
                    currentGameProcess={myCurrentGameProcess}
                    onIgnoreCurrentGame={ignoreCurrentGame}
                    privacy={privacy}
                    screenLock={screenLock}
                    gif={gif}
                />
            )}

            {pendingChatPurge && (
                <PurgeConfirmModal
                    count={pendingChatPurge.count}
                    label={pendingChatPurge.label}
                    convTitle={pendingChatPurge.convTitle}
                    onCancel={() => setPendingChatPurge(null)}
                    onConfirm={() => {
                        pendingChatPurge.commit();
                        setPendingChatPurge(null);
                    }}
                />
            )}

            {showStartDMModal && (
                <StartDMModal
                    onClose={() => setShowStartDMModal(false)}
                    existingConversations={conversations}
                    onDMStarted={(chat) => {
                        setShowStartDMModal(false);
                        fetchConversations();
                        handleStartChat(chat);
                    }}
                />
            )}

            {/* Shared media/files/links browser — opened from the context panel tiles. */}
            {activeChat && (
                <SharedContentModal
                    open={sharedContentTab !== null}
                    initialTab={sharedContentTab ?? 'media'}
                    onClose={() => setSharedContentTab(null)}
                    messages={messagesState[activeChat.id] || []}
                    token={token}
                    title={activeChat.title || (activeChat.type === 'dm' ? 'Direct Message' : 'Group Chat')}
                    onJumpToMessage={(msgId) => {
                        setSharedContentTab(null);
                        // The chat feed is mounted behind the modal — jump immediately;
                        // the modal's exit animation plays over the scroll.
                        jumpToMessageRef.current?.(msgId);
                    }}
                    resolveSenderName={(uid) => {
                        if (!uid) return null;
                        if (uid === userId) return 'You';
                        if (activeChat.type === 'dm') return activeChat.title || null;
                        const m = groupMembers.find((g: any) => g.user_id === uid);
                        return m?.username || null;
                    }}
                />
            )}

            {addToGroupTarget && (
                <AddToGroupModal
                    targetUser={addToGroupTarget}
                    myGroups={conversations.filter(c => c.type === 'group')}
                    onClose={() => setAddToGroupTarget(null)}
                    onGroupJoined={(groupConvId) => {
                        setAddToGroupTarget(null);
                        const group = conversations.find(c => c.conversation_id === groupConvId);
                        if (group) handleStartChat({ id: groupConvId, title: group.title, type: 'group', avatar_url: group.avatar_url });
                    }}
                    onCreateNew={() => {
                        setCreateGroupPreselected([addToGroupTarget]);
                        setAddToGroupTarget(null);
                        setShowCreateGroupModal(true);
                    }}
                />
            )}

            {showCreateGroupModal && (
                <CreateGroupModal
                    onClose={() => { setShowCreateGroupModal(false); setCreateGroupPreselected([]); }}
                    preSelectedUsers={createGroupPreselected}
                    onGroupCreated={(group) => {
                        setShowCreateGroupModal(false);
                        setCreateGroupPreselected([]);
                        // Pull the conversation list so the new group appears
                        // in the sidebar immediately. handleStartChat alone
                        // sets activeChat but doesn't add the group to the
                        // sidebar's conversations array — the user previously
                        // had to switch away from the new group and back to
                        // see it listed. fetchConversations is awaited so a
                        // potential race between the create-response and the
                        // GET /conversations doesn't briefly drop the new
                        // group from the list.
                        fetchConversations()
                            .catch(err => console.warn('[Dashboard] refresh conversations after group create:', err))
                            .finally(() => handleStartChat(group));
                    }}
                />
            )}

            {closeDialogState && (
                <CloseChatDialog
                    state={closeDialogState}
                    deleteDataChecked={deleteDataChecked}
                    setDeleteDataChecked={setDeleteDataChecked}
                    onClose={() => setCloseDialogState(null)}
                    onConfirm={() => {
                        handleCloseConversation(closeDialogState.id, deleteDataChecked, !!closeDialogState.isGroup);
                    }}
                />
            )}
            {manageGroupOpen && activeChat && activeChat.type === 'group' && (
                <GroupSettingsModal
                    conversationId={activeChat.id}
                    conversationTitle={activeChat.title || 'Group Chat'}
                    avatarUrl={activeChat.avatar_url}
                    onClose={() => setManageGroupOpen(false)}
                    onGroupLeft={() => {
                        setManageGroupOpen(false);
                        handleCloseConversation(activeChat.id, true, true);
                    }}
                    onGroupUpdated={() => {
                        // No optimistic state patch here — single source of truth
                        // is the server's `group:updated metadata_changed` broadcast,
                        // which my listener (groupUpdatedEvent useEffect above)
                        // catches and applies to conversations + activeChat. The
                        // editor is in the broadcast audience (notifyGroupUpdated
                        // sends to all activeMembers), so they get the WS event
                        // ~50 ms after their save, same as every other member.
                        // Doing both an optimistic patch AND a WS-driven patch
                        // caused a brief render dip mid-transition — drop the
                        // optimistic path, keep the WS-driven one as the only
                        // mutator. Just close the modal here.
                        setManageGroupOpen(false);
                    }}
                />
            )}
            {showCreateServerModal && (
                <CreateServerModal
                    onClose={() => setShowCreateServerModal(false)}
                    onCreateServer={async (name) => {
                        const srv = await createServer(name);
                        if (srv) {
                            // The server itself is already fully created and
                            // in the list at this point — createServer()
                            // already awaited both the POST and a
                            // loadServers() refresh. Everything below is
                            // best-effort UX follow-up (jump to the new
                            // server, load its channels, pre-mint the first
                            // channel's key) — none of it may throw back out
                            // of this handler, or CreateServerModal's catch
                            // reports "Failed to create server" for an
                            // operation that had already fully succeeded.
                            // Confirmed bug: a stale/missing channel-key IPC
                            // method (e.g. after an Electron main change with
                            // no restart) threw from bootstrapAndDistributeChannelKey
                            // below with no wrapper here, and the resulting
                            // false-negative error surfaced on every server
                            // creation even though the server was fine.
                            try {
                                setActiveTab('servers');
                                setActiveServerView({ serverId: srv.server_id, serverName: srv.name });
                                const chans = await loadChannels(srv.server_id);
                                // Once the channel list arrives, pendingChannelSelect
                                // will pick the first text channel (#general).
                                setPendingChannelSelect(srv.server_id);

                                // Every other server-entry path either mints
                                // explicitly (channel creation) or runs a key
                                // sweep (join, invite, notification-open,
                                // server-rail click) — creation was the one path
                                // that did neither, relying entirely on
                                // pendingChannelSelect's later auto-select to
                                // mint through handleSelectChannel. That worked
                                // only when nothing about that one request burst
                                // went wrong. Mint #general (and any other
                                // never-minted text channel this owner-only
                                // server has) directly and immediately instead —
                                // bootstrapAndDistributeChannelKey's in-flight
                                // guard makes the auto-select's later mint
                                // attempt for the same channel a no-op.
                                for (const channelId of computeUnmintedChannels(chans ?? [], {})) {
                                    await bootstrapAndDistributeChannelKey(srv.server_id, channelId);
                                }
                                void requestMissingChannelKeys(srv.server_id);
                            } catch (e) {
                                // Non-fatal: the server exists; worst case the
                                // owner sees an unminted #general and the
                                // existing repair sweep / auto-select-on-open
                                // paths mint it the next time it's opened.
                                console.warn('[CreateServer] post-creation setup failed (server itself was created fine):', e);
                            }
                            // Modal calls its own onClose() after this resolves
                        }
                    }}
                />
            )}

            {showJoinServerModal && (
                <JoinServerModal
                    onClose={() => setShowJoinServerModal(false)}
                    onJoinServer={async (code) => {
                        const result = await joinServer(code);
                        if (result) {
                            // Update server name from freshly loaded list
                            const srvName = servers.find(s => s.server_id === result.server_id)?.name ?? '';
                            setActiveTab('servers');
                            setActiveServerView({ serverId: result.server_id, serverName: srvName });
                            loadChannels(result.server_id);
                            // Pull any channel keys that existing members have already
                            // distributed, and file key requests for whatever's still
                            // missing. The 3s retry covers the race window where
                            // members are mid-distribution off the join event.
                            void requestMissingChannelKeys(result.server_id);
                            setTimeout(() => void requestMissingChannelKeys(result.server_id), 3000);
                            // Modal calls its own onClose() after this resolves
                        }
                    }}
                />
            )}

            <AnimatePresence>
                {showServerSettings && activeServerView && (() => {
                    const srv = servers.find(s => s.server_id === activeServerView.serverId);
                    if (!srv) return null;
                    return (
                        <ServerSettingsModal
                            key={srv.server_id}
                            server={srv}
                            token={token}
                            userId={userId}
                            myPermissions={myPermissions[srv.server_id] ?? 0n}
                            tabRequest={serverSettingsTabRequest}
                            onClose={() => {
                                setShowServerSettings(false);
                                // Drop the deep link with the modal, so a later
                                // ordinary open doesn't inherit 'members'.
                                setServerSettingsTabRequest(undefined);
                                setServerRolesRefreshKey(k => k + 1);
                            }}
                            onServerUpdated={(_updated) => {
                                // Reload the server list so the nav rail reflects any name/icon change
                                loadServers();
                            }}
                            storageRefreshKey={storageRefreshKey}
                        />
                    );
                })()}
            </AnimatePresence>

            {showInviteModal && activeServerView && (() => {
                const srv = servers.find(s => s.server_id === activeServerView.serverId);
                if (!srv) return null;
                return (
                    <ServerInviteModal
                        server={srv}
                        token={token}
                        onClose={() => setShowInviteModal(false)}
                    />
                );
            })()}

            {/* Per-member server options — notifs, nickname, retention, local cache */}
            {showMemberOptionsModal && activeServerView && userId && (() => {
                const srv = servers.find(s => s.server_id === activeServerView.serverId);
                if (!srv) return null;
                const srvChannelIds = (serverChannels[srv.server_id] || []).map(c => c.channel_id);
                return (
                    <ServerMemberOptionsModal
                        server={srv}
                        userId={userId}
                        token={token}
                        notifMode={serverNotifPrefs[srv.server_id] ?? (srv.default_notification_level ?? 'all') as any}
                        onSetNotif={(mode) => setServerNotifPrefs(prev => ({ ...prev, [srv.server_id]: mode }))}
                        localStats={computeServerLocalStats(channelMessages, srvChannelIds)}
                        defaultMessageRetention={getEffectiveMessageRetention(retention.policy, 'server')}
                        defaultAttachmentRetention={getEffectiveAttachmentRetention(retention.policy, 'server')}
                        onNicknameSaved={() => setServerRolesRefreshKey(k => k + 1)}
                        onRetentionChanged={() => setChannelRetentionVersion(v => v + 1)}
                        onPurgeRequest={runServerChannelSweepNow}
                        onClose={() => setShowMemberOptionsModal(false)}
                    />
                );
            })()}

            {/* Deep-link invite modal — triggered by cipherline://invite/<code> */}
            {deepLinkInviteCode && (
                <InvitePreviewModal
                    code={deepLinkInviteCode}
                    token={token}
                    servers={servers}
                    arrival={!!deepLinkInviteArrival}
                    onJoin={(serverId, serverName) => {
                        loadServers();
                        setActiveTab('servers');
                        setActiveServerView({ serverId, serverName });
                        loadChannels(serverId);
                        setPendingChannelSelect(serverId);
                        // Pull channel keys distributed by existing members, and
                        // file key requests for anything still missing.
                        void requestMissingChannelKeys(serverId);
                        setTimeout(() => void requestMissingChannelKeys(serverId), 3000);
                        setDeepLinkInviteCode(null);
                        onDeepLinkConsumed?.();
                    }}
                    onClose={() => { setDeepLinkInviteCode(null); onDeepLinkConsumed?.(); }}
                />
            )}

            {/* CallPane mounts/unmounts in lockstep with activeCall — leaving
                tears the call UI down in a single frame (no grace window). */}
            {activeCall && (() => {
                const call = activeCall;

                // ── Never connect a Calls channel unencrypted ──────────────
                // For a Calls channel the room key is DERIVED from the
                // channel Sender Key. If this device has never held the
                // current epoch, the Sender-Key backfill is fetching it — we
                // wait rather than mounting CallPane, because mounting it with
                // an empty e2ee key is exactly the unencrypted join this
                // feature exists to remove, and it would be indistinguishable
                // to the user from an encrypted one. The wait is no longer a
                // blank screen: see the CallEncryptionIndicator rendered in the
                // call section, which explains it and offers a real way out.
                //
                // Once the room IS joined under a real key, a later inability
                // to re-READ that key (a flaky IPC poll, a pruned/discarded
                // epoch row) does not make the live call unencrypted — the
                // derived key is already installed in LiveKit's key provider
                // and the media stays encrypted under it. resolveCallKeyGate
                // therefore holds the connection on the latched key and warns,
                // instead of unmounting a working call in a way that reads as
                // a crash. It never invents a key: 'connect' always carries a
                // non-empty one (asserted in callKeyGate.test.ts).
                // ── NO CALL CONNECTS WITHOUT A KEY. Any kind. ─────────────
                // The `call.callsChannelId &&` qualifier that used to be on
                // this line is the whole bug. It meant a DM/group call whose
                // `call_key` had not arrived yet fell straight through and
                // mounted CallPane with an empty key — and CallPane's
                // `...(e2eeKeyB64 ? { encryption: ... } : {})` then built the
                // LiveKit Room with NO encryption block, so E2EEActivator took
                // its keyless branch, logged "media is NOT end-to-end
                // encrypted", and the call ran in plaintext to the SFU for its
                // entire duration. A key arriving a second later could not
                // rescue it: a Room built without `encryption:` has no key
                // provider to install into.
                //
                // The race is ordinary, not exotic — the client learns it is
                // in a call from a REST status check while the key arrives as
                // an encrypted message, so answering promptly loses it. Both
                // peers can be desktops, so this was not a mobile-only gap.
                //
                // resolveCallKeyGate now decides for BOTH kinds and only ever
                // returns 'connect' with a non-empty key, so this is one
                // check with no call shape left outside it.
                if (callsChannelGate.kind !== 'connect') {
                    return null;
                }
                const effectiveE2eeKeyB64 = callsChannelGate.keyB64;
                // Belt-and-braces. The gate's first invariant already
                // guarantees a non-empty key here; this is the assertion that
                // says so out loud, because the cost of it being wrong is
                // plaintext media on the relay.
                if (!effectiveE2eeKeyB64) {
                    console.error('[CallKey] Refusing to mount CallPane with an empty room key');
                    return null;
                }
                // ── In-call encryption indicator (small padlock, shown inside
                // SidebarConference) ──────────────────────────────────────
                // Reachable here means the gate above already narrowed
                // callsChannelGate.kind to 'connect' — for EVERY call kind
                // now, not just Calls channels. Never 'blocked' here: that
                // renders pre-mount, above, with its own leave affordance
                // since CallPane isn't up yet to provide one.
                //
                // This comment used to say the DM/group branch was "always
                // non-empty by the time activeCall is set". That was the false
                // belief behind the plaintext-call bug — `call.e2ee_key_b64`
                // is empty for the entire window between answering and the
                // `call_key` arriving, which is exactly when a fast answer
                // used to connect in the clear.
                //
                // `degraded` needs no callsChannelId qualifier: only the
                // derived-key path can degrade (a delivered key cannot become
                // unreadable mid-call), so it is false by construction for a
                // DM/group call — see resolveCallKeyGate.
                const encryptionIndicatorMode: Extract<CallEncryptionIndicatorMode, 'connected' | 'degraded'> =
                    callsChannelGate.degraded ? 'degraded' : 'connected';

                let activeCallTitle = undefined;
                let activeCallAvatarUrl = undefined;
                let activeCallUserId: string | undefined = undefined;
                let isGroup = false;

                if (call.isVoiceChannel) {
                    // Voice channel call — always group-style UI, title = channel name.
                    isGroup = true;
                    activeCallTitle = call.voiceChannelName;
                } else if (call.conversation_id) {
                    const conv = conversations.find(c => c.conversation_id === call.conversation_id);
                    if (conv) {
                        isGroup = conv.type === 'group';
                        activeCallTitle = conv.title;
                        if (conv.type === 'dm' && conv.other_user_id) {
                            activeCallUserId = conv.other_user_id;
                            const fu = globalFriends?.accepted.find(f => f.user_id === conv.other_user_id);
                            if (fu) {
                                activeCallTitle = fu.username;
                                activeCallAvatarUrl = fu.avatar_url || undefined;
                            }
                        }
                        if (!activeCallAvatarUrl) {
                            activeCallAvatarUrl = conv.avatar_url || undefined;
                        }
                    }
                }

                // Server-mute controls: only available in voice/huddle server calls
                // and only when the local user has MUTE_MEMBERS in that server.
                const callServId = call.isVoiceChannel ? callServerInfo?.serverId : undefined;
                const callSrvPerms = callServId ? (myPermissions[callServId] ?? 0n) : 0n;
                const canServerMute = callServId
                    ? hasPermission(callSrvPerms, Permissions.DEAFEN_MEMBERS)
                    : false;
                const handleServerMuteTrack = callServId
                    ? (targetUserId: string, trackType: 'audio' | 'video' | 'screenshare' | 'deafen', muted: boolean) => {
                        axios.patch(
                            `${API_BASE}/servers/${callServId}/members/${targetUserId}/call-mute`,
                            { track_type: trackType, muted, room_name: call.id },
                            { headers: { Authorization: `Bearer ${token}` } },
                        ).catch(err => {
                            console.error('[ServerMute] Failed:', err?.response?.data ?? err.message);
                        });
                    }
                    : undefined;

                return (
                    <div style={{ display: 'none' }}>
                        <CallPane
                            key={call.id}
                            livekitUrl={call.livekit_url}
                            token={call.livekit_token}
                            apiToken={token || ''}
                            e2eeKeyB64={effectiveE2eeKeyB64}
                            encryptionIndicatorMode={encryptionIndicatorMode}
                            onRemoteEncryptionChange={(snapshot) => setUnencryptedPeersForCallId(snapshot.anyUnencrypted ? call.id : null)}
                            onDisconnect={handleDisconnectCall}
                            onInactivityWarning={(active) => {
                                // Note: writing ref.current here trips the strict
                                // react-hooks/refs lint rule (a known false-positive
                                // for refs mutated from an inline callback prop —
                                // this pattern already accounts for a large share of
                                // this file's pre-existing lint debt); functionally
                                // correct since this only runs when SidebarConference
                                // actually invokes the callback, never during render.
                                inactivityWarningSessionRef.current = active ? call.id : null;
                            }}
                            onParticipantCount={setCallParticipantCount}
                            onVideoActive={() => {}}
                            videoByDefault={!!call.videoByDefault}
                            isCallInitiator={call.isInitiator}
                            localAvatarUrl={user?.avatar_url || undefined}
                            activeChatTitle={activeCallTitle}
                            activeChatAvatarUrl={activeCallAvatarUrl}
                            activeChatUserId={activeCallUserId}
                            sessionId={call.id}
                            isGroup={isGroup}
                            noRinging={!!call.isVoiceChannel}
                            isHuddle={call.isVoiceChannel && !!activeHuddleChannelId}
                            onFocusedStreamChange={setHasFocusedStream}
                            voice={voice}
                            memberRoleColors={
                                call.isVoiceChannel && callServerInfo?.serverId
                                    ? (serverMemberRoleColors[callServerInfo.serverId] ?? {})
                                    : {}
                            }
                            memberAvatarMap={
                                call.isVoiceChannel && callServerInfo?.serverId
                                    ? (serverMemberAvatarMaps[callServerInfo.serverId] ?? {})
                                    : {}
                            }
                            canServerMute={canServerMute}
                            onServerMuteTrack={handleServerMuteTrack}
                            isActive={!!activeCall}
                            channelPermissions={activeCallChannelPermissions}
                        />
                    </div>
                );
            })()}

            {sidebarMenu.menu}
            {serverRailMenu.menu}
            {friendListMenu.menu}
            {reportTarget && (
                <ReportModal
                    targetUserId={reportTarget.id}
                    targetUsername={reportTarget.username}
                    token={token ?? ''}
                    onClose={() => setReportTarget(null)}
                    initialSnippet={reportTarget.snippet}
                />
            )}
            {groupMemberMenu.menu}

            {/* Server rail hover tooltip — fixed-position to escape overflow clipping.
                Two-pass measure/place like useClTooltip: rendered hidden at the
                anchor's own position first so railTooltipRef has something to
                measure, then re-positioned via computeTooltipPlacement (which
                flips off the left rail edge and clamps vertically — the fix for
                a long name near the top/bottom of the rail running off-screen). */}
            {railTooltip && (
                <div
                    ref={railTooltipRef}
                    className="fixed z-[9999] pointer-events-none px-3 py-1.5 bg-cl-raise border border-white/[0.08] rounded-xl text-xs text-white/80 font-medium whitespace-nowrap shadow-xl"
                    style={{
                        left: railTooltipPlacement ? railTooltipPlacement.left : railTooltip.anchor.left,
                        top: railTooltipPlacement ? railTooltipPlacement.top : railTooltip.anchor.top,
                        visibility: railTooltipPlacement ? 'visible' : 'hidden',
                        maxWidth: 220,
                    }}
                >
                    <div>
                        {railTooltip.name}
                        {railTooltip.muted && <span className="ml-1.5 text-[10px] text-white/35">(muted)</span>}
                    </div>
                    {/* Live-call roster. Measured in the same pass as the name
                        (railTooltipRef runs on the committed node), so
                        computeTooltipPlacement flips/clamps against the FULL
                        height — a tall roster near the bottom of the rail can't
                        run off-screen. */}
                    {railTooltip.call && (
                        <div className="mt-1.5 pt-1.5 border-t border-white/[0.08]">
                            <div className="flex items-center gap-1.5 text-[10px] text-cl-lume">
                                <Volume2 size={11} strokeWidth={2.5} aria-hidden />
                                <span>{railTooltip.call.total} in call</span>
                            </div>
                            <ul className="mt-1 space-y-0.5">
                                {railTooltip.call.names.map((n, i) => (
                                    <li key={i} className="text-[11px] text-white/65 truncate">{n}</li>
                                ))}
                                {railTooltip.call.overflow > 0 && (
                                    <li className="text-[11px] text-white/35">+{railTooltip.call.overflow} more</li>
                                )}
                            </ul>
                        </div>
                    )}
                </div>
            )}

            {/* Leave-current-call-to-join-server-call popup — same style as the
                DM call-conflict card in ChatPane: small, anchored near the click. */}
            {pendingServerJoin && (() => {
                const { anchor, channelName, fn } = pendingServerJoin;
                // Position above the click point, shifted left so it doesn't clip the right edge.
                const popW = 256; // w-64
                const left = Math.max(8, Math.min(anchor.x - popW + 24, window.innerWidth - popW - 8));
                const top  = anchor.y - 8; // popup sits above cursor; translateY(-100%) does the rest
                return (
                    <div
                        className="fixed z-[200] w-64 bg-cl-surface border border-white/10 rounded-xl shadow-2xl p-4 fade-pop-enter"
                        style={{ left, top, transform: 'translateY(-100%)' }}
                    >
                        {/* Click-outside to cancel */}
                        <div className="fixed inset-0 -z-10" onClick={() => setPendingServerJoin(null)} />
                        <h3 className="text-sm font-bold text-cl-text mb-2 m-0">Leave Current Call?</h3>
                        <p className="text-xs text-cl-faint mb-4 m-0 leading-tight">
                            You're already in a call. Leave it and join <span className="text-cl-text/80 font-medium">{channelName}</span>?
                        </p>
                        {/* flex:1 goes on wrapper divs, not ClButton's `style` — see
                            the fullWidth comment on the sidebarBlockConfirm buttons
                            above for why. */}
                        {/* ClConfirm's canonical button row: right-aligned,
                            intrinsic-width sm buttons (never stretched 50/50 —
                            fullWidth halves made the pair look mismatched and
                            oversized for a 256px popup). Same layout as every
                            other confirm in the app. */}
                        <div className="flex items-center justify-end" style={{ gap: 12 }}>
                            <ClButton size="sm" variant="ghost" onClick={() => setPendingServerJoin(null)}>
                                Cancel
                            </ClButton>
                            <ClButton size="sm" onClick={() => { setPendingServerJoin(null); fn(); }}>
                                Leave & Join
                            </ClButton>
                        </div>
                    </div>
                );
            })()}

            {/* Leave-server confirmation dialog */}
            {leaveServerTarget && (
                <ConfirmDialog
                    title={`Leave "${leaveServerTarget.name}"?`}
                    message="You'll need a new invite to rejoin. Your messages will remain visible to other members."
                    confirmLabel="Leave Server"
                    onConfirm={async () => {
                        try {
                            await axios.post(
                                `${API_BASE}/servers/${leaveServerTarget.server_id}/leave`,
                                {},
                                { headers: { Authorization: `Bearer ${token}` } },
                            );
                            // Navigate away if we were viewing this server.
                            if (activeServerView?.serverId === leaveServerTarget.server_id) {
                                setActiveServerView(null);
                                setActiveChannel(null);
                                setActiveTab('dms');
                            }
                            // Drop per-server retention override and any cached
                            // server-pins for the channels of this server. Local
                            // channelMessages for the server's channels also become
                            // orphan keys; they'll be cleaned up by the topology
                            // re-sweep effect since serverChannelsRef no longer
                            // covers them.
                            if (userId) {
                                try { secureLocalStore.removeItem(`cipherline_server_retention_${userId}_${leaveServerTarget.server_id}`); } catch {}
                            }
                            loadServers();
                        } catch (err: any) {
                            console.error('[Dashboard] leaveServer failed:', err);
                        }
                        setLeaveServerTarget(null);
                    }}
                    onCancel={() => setLeaveServerTarget(null)}
                />
            )}

            {/* Portal target for fullscreen call overlay */}
            <div id="call-fullscreen-root" />

            {/* Portal target for the call control console WHILE fullscreen is up.
                SidebarConference re-points its one <ControlBar> here instead of
                #call-controlbar-root so fullscreen gets the real capsule rather
                than a second, thinner copy of it. Positioned and shown/hidden
                entirely from index.css off <html data-cl-fullscreen>, which
                FullscreenOverlay sets — it is inert and invisible otherwise. */}
            <div id="call-fullscreen-controls-root" />

            {/* Solo kick dialog */}
            {showSoloKickDialog && (
                <SoloKickDialog onClose={() => setShowSoloKickDialog(false)} />
            )}

            {/* Profile Modal */}
            {profileModalUserId && token && userId && (
                <ProfileModal
                    userId={profileModalUserId}
                    anchor={profileModalAnchor}
                    token={token}
                    currentUserId={userId}
                    friendStatuses={friendStatuses}
                    myStatus={myStatus}
                    myGame={myCurrentGame}
                    isFriend={!!globalFriends?.accepted.some(f => f.user_id === profileModalUserId)}
                    onClose={() => { setProfileModalUserId(null); setProfileModalAnchor(null); setProfileModalRoleCtx(null); }}
                    onMessage={(uid) => {
                        setProfileModalUserId(null);
                        const friend = globalFriends?.accepted.find(f => f.user_id === uid);
                        openDMWithUser(uid, friend?.username || uid, friend?.avatar_url);
                    }}
                    onCall={(uid) => {
                        setProfileModalUserId(null);
                        startGlobalCall(uid);
                    }}
                    onSendFriendRequest={async (_uid, username, discriminator) => {
                        try {
                            await axios.post(`${API_BASE}/friends/request`,
                                { target_username: username, target_discriminator: discriminator },
                                { headers: { Authorization: `Bearer ${token}` } }
                            );
                            nudges.notify({ kind: 'friend_request_sent' });
                            // Optimistic UI: close the modal; the server emits
                            // friend:request via WS which refreshes globalFriends.
                            setProfileModalUserId(null);
                        } catch (e: any) {
                            toast.push({ kind: 'error', title: 'Request Failed', message: e?.response?.data?.message || 'Failed to send friend request' });
                        }
                    }}
                    onOpenSettings={() => { setProfileModalUserId(null); setSettingsOpen(true); }}
                    onAddToGroup={(friend) => {
                        setProfileModalUserId(null);
                        setAddToGroupTarget({
                            user_id: friend.user_id,
                            username: friend.username,
                            avatar_url: friend.avatar_url ?? undefined,
                        });
                    }}
                    onRemoveFriend={async (uid) => {
                        setProfileModalUserId(null);
                        try {
                            await axios.delete(`${API_BASE}/friends/${uid}`, { headers: { Authorization: `Bearer ${token}` } });
                            axios.get(`${API_BASE}/friends`, { headers: { Authorization: `Bearer ${token}` } })
                                .then(res => setGlobalFriends(res.data)).catch(() => {});
                        } catch {
                            toast.push({ kind: 'error', title: 'Remove Failed', message: 'Failed to remove friend' });
                        }
                    }}
                    onBlock={(uid, uname) => { setProfileModalUserId(null); handleSidebarBlock(uid, uname); }}
                    // ProfileModal has always rendered a "Report User" item —
                    // but only when handed an onReport, and nothing ever handed
                    // it one. Clicking someone's avatar, the most obvious way to
                    // report a person, silently had no such option.
                    onReport={(uid, uname) => { setProfileModalUserId(null); setReportTarget({ id: uid, username: uname }); }}
                    serverRoles={profileModalRoleCtx?.roles}
                    memberRoleIds={profileModalRoleCtx?.roleIds}
                    serverId={profileModalRoleCtx?.serverId}
                    currentNickname={profileModalRoleCtx?.currentNickname}
                    canSetNickname={profileModalRoleCtx?.canSetNickname}
                    autoEditNickname={profileModalRoleCtx?.autoEditNickname}
                    onSetNickname={async (targetUserId, nickname) => {
                        const sid = profileModalRoleCtx?.serverId;
                        if (!sid || !token) return;
                        await axios.patch(
                            `${API_BASE}/servers/${sid}/members/${targetUserId}/nickname`,
                            { nickname: nickname ?? '' },
                            { headers: { Authorization: `Bearer ${token}` } },
                        );
                        // Update the local nickname cache so ChatPane reflects it immediately.
                        setServerMemberNicknames(prev => {
                            if (!nickname) {
                                const next = { ...prev };
                                delete next[targetUserId];
                                return next;
                            }
                            return { ...prev, [targetUserId]: nickname };
                        });
                        // Refresh the role context so the popover shows the updated nickname.
                        setProfileModalRoleCtx(prev => prev ? { ...prev, currentNickname: nickname ?? null } : prev);
                    }}
                    inviteToServerItems={
                        profileModalUserId && profileModalUserId !== userId
                            ? buildInviteToServerItems(profileModalUserId)
                            : undefined
                    }
                />
            )}
        </div >
        </FriendshipContext.Provider>
        </ReportOpenContext.Provider>
        </CallServerCtx.Provider>
        </ProfileOpenContext.Provider>
        </CallProvider>
    );
};

export default Dashboard;
