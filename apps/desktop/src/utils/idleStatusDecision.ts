/**
 * What an idle verdict (poll, lock, sleep, unlock) does to the user's status:
 * one pure decision so useUserStatus.ts's single `applyIdle` and its tests
 * cannot drift.
 *
 *   server does per-connection auto-away -> only REPORT the change
 *     (`presence:idle`); the server aggregates across ALL the user's devices
 *     ('away' only when every present connection is idle) and only ever turns
 *     a chosen 'online' into 'away'. A chosen DND / Invisible is never changed
 *     and nothing about idleness is visible while they are chosen.
 *   older server -> the legacy per-device PATCH, which must leave a manual
 *     DND / Invisible alone and only restore an AUTOMATIC away.
 */
import type { UserStatus } from './userStatusModel';

export type IdleAction =
    | { kind: 'none' }
    | { kind: 'report-idle'; idle: boolean }
    | { kind: 'auto-away' }      // legacy: show + PATCH 'away', remember it was automatic
    | { kind: 'auto-return' };   // legacy: show + PATCH 'online', clear the automatic flag

export function decideIdleAction(input: {
    serverAutoAway: boolean;
    wasIdle: boolean;
    idle: boolean;
    current: UserStatus;
    autoAway: boolean;
}): IdleAction {
    if (input.serverAutoAway) {
        return input.idle !== input.wasIdle ? { kind: 'report-idle', idle: input.idle } : { kind: 'none' };
    }
    if (input.current === 'dnd' || input.current === 'offline') return { kind: 'none' }; // manual override
    if (input.idle && input.current === 'online') return { kind: 'auto-away' };
    if (!input.idle && input.current === 'away' && input.autoAway) return { kind: 'auto-return' };
    return { kind: 'none' };
}
