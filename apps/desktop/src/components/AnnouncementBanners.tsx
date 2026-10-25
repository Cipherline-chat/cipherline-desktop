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
 * is unwelcome. That bound now lives in ClBannerStack (Dashboard), which
 * orders EVERY banner by priority, shows the top two and collapses the rest
 * behind "+N more" rather than silently dropping them.
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
import { ClBanner } from './ClBanner';
import { useAuth } from '../contexts/AuthContext';
import { useAnnouncements } from '../hooks/useAnnouncements';
import secureLocalStore from '../utils/secureLocalStore';
import {
    filterDismissed,
    formatEndsIn,
    parseDismissedIds,
    recordDismissal,
    resolveAnnouncementIcon,
    resolveAnnouncementTone,
    type AnnouncementTone,
} from '../utils/announcements';

/** An admin announcement is a deliberate, curated message, so it outranks the
 *  routine billing nudges at the same severity (see TrialBanner's priorities). */
const ANNOUNCEMENT_PRIORITY: Record<AnnouncementTone, number> = {
    danger: 85,
    warning: 68,
    info: 58,
    neutral: 55,
};

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

    // Each live announcement is its own ClBanner; the surrounding ClBannerStack
    // (Dashboard) orders them against every other banner by priority, shows the
    // top two and folds the rest behind "+N more". Fragment, not a wrapper:
    // the banners must be direct children of the stack to be ordered by it.
    return (
        <>
            {live.map(b => {
                const tone = resolveAnnouncementTone(b.color);
                const Icon = resolveAnnouncementIcon(b.icon);
                const endsIn = formatEndsIn(b.ends_at);
                const body = <>{b.body}{endsIn && <span className="opacity-70"> · {endsIn}</span>}</>;
                return (
                    <ClBanner
                        key={b.id}
                        id={`announcement-${b.id}`}
                        tone={tone}
                        priority={ANNOUNCEMENT_PRIORITY[tone]}
                        icon={Icon ? <Icon size={15} /> : undefined}
                        title={b.title || undefined}
                        description={body}
                        onDismiss={b.dismissible ? () => dismiss(b.id) : undefined}
                    />
                );
            })}
        </>
    );
};
