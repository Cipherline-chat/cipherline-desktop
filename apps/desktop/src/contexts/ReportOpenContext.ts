import { createContext, useContext } from 'react';

/**
 * Global handler for opening the abuse-report flow (ReportModal) on a user.
 * Wired once at the Dashboard root — any descendant can call
 * `useReportOpen()?.(userId, username, snippet)` to bring up the report
 * modal, without threading an `onReport` prop through every intermediate
 * layer. Mirrors ProfileOpenContext / CallServerCtx, which solve the exact
 * same "deep call component tree" problem for View Profile and server-role
 * enrichment respectively (see their docblocks).
 *
 * This exists specifically for PopoverMenu.tsx — the call-participant popover
 * shared by DM calls, group calls, server voice channels, huddles and screen
 * share — which has no practical way to receive a report callback from
 * Dashboard.tsx / ServerContextPanel.tsx without rewiring CallPane,
 * SidebarConference, ParticipantCard, VideoTile, FloatingHuddleCard and
 * ScreenShareGate. Every one of those already gates PopoverMenu (and the
 * self-participant menus that stand in for it) to remote participants only
 * — `!isLocal` / `!isMe` — so no additional self-report check is needed by
 * consumers of this context.
 *
 * `snippet` mirrors ReportModal's `initialSnippet` — content-bearing report
 * flows (e.g. reporting a message) can pre-fill it; call-participant reports
 * have no message content to attach, so they omit it.
 */
export type ReportOpenFn = (userId: string, username: string, snippet?: string) => void;

export const ReportOpenContext = createContext<ReportOpenFn | null>(null);

/** Returns the open-report callback if a provider is installed, else null. */
export function useReportOpen(): ReportOpenFn | null {
    return useContext(ReportOpenContext);
}
