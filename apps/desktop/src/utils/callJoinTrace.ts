/**
 * The live join timeline: one per join, started by Dashboard on the click and
 * marked by whoever reaches each stage (Dashboard for ui/request/key,
 * CallPane for connected/mic). When the mic publishes — or the join ends
 * without one — a single summary line goes to the console:
 *
 *   [CallJoin] voice · ui 9ms · request +301ms · key +2ms · connected +590ms · mic +160ms · total 1062ms
 *
 * That line is the before/after evidence for the instant-join work on a real
 * machine (Windows DevTools → Console, filter "CallJoin"). Durations and the
 * join kind only — see formatJoinTimeline.
 *
 * Also opens freezeLog activity spans so a long task during a join is labelled
 * with the phase it happened in.
 */
import { beginActivity } from './freezeLog';
import {
    startJoinTimeline, markJoinStage, formatJoinTimeline,
    type CallJoinKind, type JoinStage, type JoinTimeline,
} from './callJoinFlow';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

let current: JoinTimeline | null = null;
let endSpan: (() => void) | null = null;

export function startCallJoinTrace(kind: CallJoinKind): void {
    endSpan?.();
    current = startJoinTimeline(kind, now());
    endSpan = beginActivity('call:join-click-to-connected');
}

export function markCallJoinTrace(stage: JoinStage): void {
    if (!markJoinStage(current, stage, now())) return;
    if (stage === 'connected') { endSpan?.(); endSpan = null; }
    if (stage === 'mic') finishCallJoinTrace();
}

/** Log the summary (if a join was being traced) and stop tracing. */
export function finishCallJoinTrace(outcome?: 'cancelled' | 'failed' | 'ended'): void {
    if (!current) return;
    const line = formatJoinTimeline(current);
    console.info(`[CallJoin] ${line}${outcome ? ` · ${outcome}` : ''}`);
    current = null;
    endSpan?.();
    endSpan = null;
}
