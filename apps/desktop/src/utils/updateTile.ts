/**
 * updateTile.ts — what the update rail tile shows and does for each updater
 * phase, kept pure so the wording and (above all) the ACTION per phase are
 * unit-tested. The lifecycle itself is electron/updater-state.ts's.
 *
 * The rule this encodes (owner, 2026-10-09): an update always completes in the
 * app. No phase on Windows or macOS has a "go to your browser" action — a
 * failure offers Retry, which main turns into a fresh in-app download. The one
 * browser action, `open-download`, belongs to `manual`, which main only ever
 * produces on Linux (an AppImage that cannot replace itself).
 */

export type UpdateTileAction = 'install' | 'retry' | 'open-download' | null;
export type UpdateTileTone = 'busy' | 'ready' | 'warn' | 'error' | 'external';

export interface UpdateTileDescriptor {
    visible: boolean;
    action: UpdateTileAction;
    /** Tooltip + accessible name. */
    label: string;
    tone: UpdateTileTone;
    /** Progress ring value 0–100, or null for no ring. */
    percent: number | null;
}

/** "45s", "1m 20s", "5m" — rounded UP, never "0s". */
export function formatRetryIn(ms: number): string {
    const total = Math.max(1, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m === 0) return `${s}s`;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

const FAILED_LABEL: Record<'download' | 'verify' | 'install', string> = {
    download: "Update couldn't finish downloading — click to try again",
    verify: "Update couldn't be verified — click to try again",
    install: "Update couldn't be installed — click to try again",
};

export function describeUpdateTile(state: UpdateStateShape, now: number): UpdateTileDescriptor {
    switch (state.phase) {
        case 'idle':
            return { visible: false, action: null, label: '', tone: 'busy', percent: null };
        case 'available':
            // version '' = a Retry after a rejected manifest: the version is not known yet.
            return { visible: true, action: null, label: state.version ? `Downloading update v${state.version}…` : 'Checking for update…', tone: 'busy', percent: 0 };
        case 'downloading':
            return { visible: true, action: null, label: `Downloading update… ${Math.round(state.percent)}%`, tone: 'busy', percent: state.percent };
        case 'retrying': {
            const left = state.retryAt - now;
            const when = left > 500 ? `retrying in ${formatRetryIn(left)}` : 'retrying now';
            return {
                visible: true,
                action: 'retry',
                label: `Update downloading… ${when} — click to retry now`,
                tone: 'warn',
                percent: null,
            };
        }
        case 'failed':
            return { visible: true, action: 'retry', label: FAILED_LABEL[state.stage] ?? FAILED_LABEL.download, tone: 'error', percent: null };
        case 'ready':
            return { visible: true, action: 'install', label: 'Update ready — click to restart and install', tone: 'ready', percent: null };
        case 'manual':
            return { visible: true, action: 'open-download', label: `Update available — click to download v${state.version}`, tone: 'external', percent: null };
        default:
            // An unknown phase from a newer main process: show nothing rather than guess.
            return { visible: false, action: null, label: '', tone: 'busy', percent: null };
    }
}
