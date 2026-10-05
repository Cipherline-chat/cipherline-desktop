/**
 * AnnouncementBanners — admin-authored announcement banners, app-wide.
 *
 * Mounted once in Dashboard.tsx's app shell (alongside TrialBanner /
 * HistorySyncBanner, above the content-panes row) so it's visible no matter
 * which tab/pane is open, without sitting inside the 34px drag-region
 * titlebar or interfering with window dragging / the native window controls.
 *
 * Stacking, bounded: the owner wants multiple banners to be able to stack,
 * but has separately made clear that unbounded chrome at the top of the app
 * is unwelcome. So at most `MAX_VISIBLE_ANNOUNCEMENTS` render by default;
 * anything past that collapses behind a compact "+N more" toggle that
 * expands the rest in place (still just more of the same compact rows, not
 * a separate overlay) rather than being silently dropped.
 *
 * Dismissal is per-user, client-only state (server-lean: the server does not
 * learn who dismissed what) — persisted via secureLocalStore, one JSON array
 * of dismissed banner ids per account, capped by `recordDismissal` so it
 * can't grow forever. A non-dismissible banner renders no close control.
 *
 * All targeting/scheduling is server-resolved — this component does no
 * eligibility filtering of its own beyond "already dismissed by this user".
 */
import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { ClButton } from './ClButton';
import { useAuth } from '../contexts/AuthContext';
import { useAnnouncements } from '../hooks/useAnnouncements';
import secureLocalStore from '../utils/secureLocalStore';
import {
    boundAnnouncementStack,
    filterDismissed,
    formatEndsIn,
    MAX_VISIBLE_ANNOUNCEMENTS,
    parseDismissedIds,
    recordDismissal,
    resolveAnnouncementColor,
    resolveAnnouncementIcon,
} from '../utils/announcements';

interface Props {
    /** Bumped on every WS reconnect (see useRealtime's wsConnectCount).
     *  Passed as a prop rather than read from a context because it's
     *  Dashboard-local state, the same way FriendsPane/HomePanel receive it. */
    wsConnectCount: number;
}

const dismissedKey = (uid: string) => `cipherline_announcement_dismissed_${uid}`;

export const AnnouncementBanners: React.FC<Props> = ({ wsConnectCount }) => {
    const { token, userId } = useAuth();
    const banners = useAnnouncements(token, wsConnectCount);
    // Bumped on dismiss to force a re-read of secureLocalStore — same
    // "store is the source of truth, re-read rather than mirror" approach
    // TrialBanner uses with its own dismissTick.
    const [dismissTick, setDismissTick] = useState(0);
    const [expanded, setExpanded] = useState(false);

    const dismissedIds = useMemo(() => {
        if (!userId) return [];
        try {
            return parseDismissedIds(secureLocalStore.getItem(dismissedKey(userId)));
        } catch {
            return [];
        }
        // dismissTick is a deliberate re-read trigger, not a real dependency.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userId, dismissTick]);

    const live = useMemo(() => filterDismissed(banners, dismissedIds), [banners, dismissedIds]);

    if (!userId || live.length === 0) return null;

    const { visible, overflow } = boundAnnouncementStack(live, MAX_VISIBLE_ANNOUNCEMENTS);
    const shown = expanded ? live : visible;

    const dismiss = (bannerId: string) => {
        if (!userId) return;
        try {
            const next = recordDismissal(dismissedIds, bannerId);
            // Inlined (rather than via the `dismissedKey` helper) so the
            // backupRegistry source scan's literal-head regex actually sees
            // this call and cross-checks it against KV_RULES.
            secureLocalStore.setItem(`cipherline_announcement_dismissed_${userId}`, JSON.stringify(next));
        } catch {
            // Non-fatal — worst case the banner reappears once next boot.
        }
        setDismissTick(t => t + 1);
    };

    return (
        // A floating card, not a flush strip. It used to be rounded on the
        // BOTTOM only, on the reasoning that the top should meet the titlebar
        // squarely the way TrialBanner and HistorySyncBanner do. Sitting
        // directly under the window controls with a hard top edge made it
        // read as part of the chrome rather than as a message, so it now
        // rounds on all four corners and is inset vertically.
        //
        // The padding lives on an OUTER wrapper and the radius plus
        // overflow-hidden on the INNER stack. Putting both on one element
        // would round the padding box, so the curve would sit away from the
        // visible edge. overflow-hidden stays on the stack rather than on
        // each row: it clips whichever child is currently first and last — a
        // single banner, the ends of a stacked group, or the "+N more" /
        // "Show less" toggle — so the corners are always right without
        // rounding every row and creating seams between them.
        //
        // No horizontal padding: the left inset is the rail and the right is
        // the pane gutter, both of which already position this correctly.
        <div className="w-full shrink-0 py-2" role="region" aria-label="Announcements">
            <div className="flex flex-col rounded-xl overflow-hidden">
            {shown.map(b => {
                const tokens = resolveAnnouncementColor(b.color);
                const Icon = resolveAnnouncementIcon(b.icon);
                const endsIn = formatEndsIn(b.ends_at);
                return (
                    <div
                        key={b.id}
                        role="status"
                        className={`w-full px-4 py-2 border-b flex items-center gap-2.5 text-[13px] animate-in fade-in slide-in-from-top-2 duration-200 ${tokens.bg} ${tokens.border} ${tokens.text}`}
                    >
                        {Icon && <Icon size={15} className="shrink-0" />}
                        <div className="flex-1 min-w-0 flex items-baseline gap-2">
                            {b.title && <span className="font-semibold shrink-0">{b.title}</span>}
                            <span className="truncate text-cl-text/90">{b.body}</span>
                            {endsIn && <span className="shrink-0 text-[11px] opacity-70">{endsIn}</span>}
                        </div>
                        {b.dismissible && (
                            <ClButton
                                type="button"
                                icon
                                variant="ghost"
                                size="sm"
                                tooltip="Dismiss"
                                onClick={() => dismiss(b.id)}
                            >
                                <X size={13} />
                            </ClButton>
                        )}
                    </div>
                );
            })}
            {!expanded && overflow.length > 0 && (
                <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="w-full px-4 py-1 text-[11px] text-cl-muted hover:text-cl-text bg-cl-deep border-b border-cl-border flex items-center justify-center gap-1"
                >
                    +{overflow.length} more <ChevronDown size={12} />
                </button>
            )}
            {expanded && overflow.length > 0 && (
                <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    className="w-full px-4 py-1 text-[11px] text-cl-muted hover:text-cl-text bg-cl-deep border-b border-cl-border flex items-center justify-center gap-1"
                >
                    Show less <ChevronUp size={12} />
                </button>
            )}
            </div>
        </div>
    );
};
