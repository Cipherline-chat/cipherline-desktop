/**
 * activeCallRegistry — a tiny module-level flag for "is there a live call
 * right now", read synchronously by code that needs to make a decision
 * before the next render. (Its original reader, OfflineScreen's "reload the
 * renderer on reconnect unless a call is live", is gone — that reload no
 * longer exists at all; see OfflineScreen.tsx.)
 *
 * Deliberately NOT React state and NOT threaded through props. `activeCall`/
 * `activeVoiceChannelId`/`activeHuddleCallId` are three separate `useState`s
 * inside Dashboard.tsx, set from 14+ call sites across a ~9000-line
 * component. Hand-editing every one of those call sites to also write a
 * prop/context value is exactly the kind of change that's easy to get
 * "mostly right" and silently miss one — which for THIS specific purpose
 * (deciding whether a destructive reload is safe) is worse than not having
 * the guard at all, since a missed call site would look like the fix works
 * everywhere except the one path nobody tested.
 *
 * Instead, Dashboard.tsx drives this registry from a SINGLE effect watching
 * the three pieces of state directly (see the `useEffect` near where all
 * three are in scope) — correct by construction regardless of which of the
 * 14+ call sites caused the change, since React re-runs the effect on any
 * state transition, not on any particular setter call.
 */

let hasActiveCall = false;

/** Written by Dashboard.tsx's single call-state-sync effect. */
export function setHasActiveCall(active: boolean): void {
    hasActiveCall = active;
}

/** Read synchronously wherever a decision needs the current call state. */
export function getHasActiveCall(): boolean {
    return hasActiveCall;
}
