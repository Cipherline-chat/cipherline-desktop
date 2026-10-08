/**
 * "Open the issue reporter" from anywhere — Settings, the in-call menu, the
 * boot crash prompt, the gaming-freeze offer — without threading props through
 * the tree. One module-level request; ReportProblemHost (mounted once in
 * App.tsx) renders the modal for it.
 */
import { useSyncExternalStore } from 'react';
import type { DiagnosticCategory, DiagnosticTrigger } from './reportTypes';

export type ReportStep = 'category' | 'details' | 'preview';

export interface ReportRequest {
    /** Preselected category; omit to start at the category picker. */
    category?: DiagnosticCategory;
    trigger: DiagnosticTrigger;
    /** Defaults to 'details' when a category is given, else 'category'. */
    step?: ReportStep;
    /** Bumped on every open so re-opening the same request remounts cleanly. */
    nonce?: number;
}

let current: ReportRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function openReportProblem(req: ReportRequest): void {
    current = { ...req, nonce: ++seq };
    emit();
}

export function closeReportProblem(): void {
    if (!current) return;
    current = null;
    emit();
}

export function getReportRequest(): ReportRequest | null {
    return current;
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useReportRequest(): ReportRequest | null {
    return useSyncExternalStore(subscribe, getReportRequest, getReportRequest);
}

/**
 * Entry point for the gaming-freeze offer (GamingVideoGuard, on the
 * claude/gaming-call-mode branch): its card links here so a freeze can be
 * reported with the Performance log attached.
 */
export function openFreezeOfferReport(): void {
    openReportProblem({ category: 'performance', trigger: 'freeze_offer' });
}
