import { ArrowRight, ArrowUpCircle, ExternalLink, ShieldCheck } from 'lucide-react';
import { ClButton, ClProgress } from './cl';
import { ClientBlockScreen } from './ClientBlockScreen';

/**
 * "Update required" — presentational. UpgradeRequiredOverlay owns the wiring
 * (the 426 / 4426 / status-check signal, the auto-updater state, the actions).
 *
 * The primary action follows the auto-updater's own lifecycle
 * (electron/updater-state.ts) — the update ALWAYS happens in the app (owner
 * rule 2026-10-09); the website link is a quiet fallback for a build that
 * cannot update itself or an updater that keeps failing.
 *
 * Nothing on this path talks to the Cipherline API: the updater reads the
 * signed feed from the update origin, and the required version came with the
 * 426 (or from GET /v1/client-status, which the floor exempts). A client below
 * the floor can therefore always get itself current.
 */

export type CheckPhase = 'checking' | 'none-found' | 'no-updater' | 'error' | 'idle';

export interface UpdateRequiredScreenProps {
    currentVersion: string;
    requiredVersion?: string | null;
    /** The auto-updater lifecycle (global UpdateStateShape, env.d.ts — never import electron/ from src/). */
    update: UpdateStateShape;
    /** Our own "did a check run / find anything" knowledge for the idle phase. */
    checkPhase: CheckPhase;
    installing: boolean;
    installError?: string | null;
    onPrimary: () => void;
    onOpenWebsite: () => void;
}

interface Primary { label: string; disabled?: boolean }

function describe(p: UpdateRequiredScreenProps): { line: string; error?: boolean; progress?: number | null; primary: Primary } {
    const u = p.update;
    switch (u.phase) {
        case 'available':
            return { line: `Found Cipherline ${u.version} — starting the download…`, progress: 0, primary: { label: 'Downloading…', disabled: true } };
        case 'downloading':
            return { line: `Downloading Cipherline ${u.version} — ${Math.round(u.percent)}%`, progress: u.percent, primary: { label: 'Downloading…', disabled: true } };
        case 'retrying': {
            const s = Math.max(0, Math.ceil((u.retryAt - Date.now()) / 1000));
            return { line: `The download was interrupted. Trying again${s ? ` in ${s}s` : ''} (attempt ${u.attempt + 1} of ${u.maxAttempts + 1}).`, error: true, primary: { label: 'Retry now' } };
        }
        case 'failed':
            return {
                line: u.stage === 'verify'
                    ? 'The downloaded update couldn’t be verified as Cipherline’s, so it wasn’t installed.'
                    : u.stage === 'install' ? 'The update downloaded but couldn’t be installed.' : 'The update didn’t finish downloading.',
                error: true,
                primary: { label: 'Try again' },
            };
        case 'ready':
            return { line: `Cipherline ${u.version} is downloaded and ready.`, progress: 100, primary: { label: p.installing ? 'Restarting…' : 'Restart & update', disabled: p.installing } };
        case 'manual':
            return { line: `Cipherline ${u.version} is ready to download for this system.`, primary: { label: 'Download update' } };
        case 'idle':
        default:
            switch (p.checkPhase) {
                case 'checking': return { line: 'Looking for the latest version…', primary: { label: 'Checking…', disabled: true } };
                case 'none-found': return { line: 'The new version isn’t available here yet — it may still be rolling out. We’ll keep checking.', primary: { label: 'Check again' } };
                case 'no-updater': return { line: 'This copy of Cipherline can’t update itself. Get the latest version from our website.', primary: { label: 'Download Cipherline' } };
                case 'error': return { line: 'Couldn’t reach the update server. Check your connection and try again.', error: true, primary: { label: 'Try again' } };
                default: return { line: 'Updating takes about a minute.', primary: { label: 'Update now' } };
            }
    }
}

export function UpdateRequiredScreen(props: UpdateRequiredScreenProps) {
    const d = describe(props);
    return (
        <ClientBlockScreen tone="lume" titleId="cb-update-title" bodyId="cb-update-body" testId="update-required-screen">
            <div className="cb-emblem" aria-hidden>
                <div className="cb-emblem-core"><ArrowUpCircle size={32} strokeWidth={2.2} /></div>
            </div>
            <div className="cb-eyebrow">Update required</div>
            <h1 id="cb-update-title" className="cb-title">Time for a quick update</h1>
            <p id="cb-update-body" className="cb-body">
                This version of Cipherline can’t connect anymore — a newer one is required to keep you safe.
                Your messages and keys stay on this device.
            </p>

            <div className="cb-versions">
                <div className="cb-chip"><small>Installed</small><b>{props.currentVersion}</b></div>
                <ArrowRight className="cb-arrow" size={18} aria-hidden />
                <div className="cb-chip is-target"><small>Required</small><b>{props.requiredVersion ? `${props.requiredVersion}+` : 'Latest'}</b></div>
            </div>

            <div className="cb-status" aria-live="polite">
                {d.progress != null && <ClProgress value={d.progress} done={d.progress >= 100} />}
                <div className={`cb-status-line${d.error ? ' is-error' : ''}`}>
                    {!d.error && <span className="cb-dot" aria-hidden />}
                    {d.line}
                </div>
                {props.installError && <div className="cb-status-line is-error">{props.installError}</div>}
            </div>

            <div className="cb-actions">
                <ClButton
                    variant="primary"
                    size="lg"
                    className="cb-primary"
                    onClick={props.onPrimary}
                    disabled={d.primary.disabled}
                    autoFocus
                >
                    {d.primary.label}
                </ClButton>
                <button type="button" className="cb-link" onClick={props.onOpenWebsite}>
                    Having trouble? Download from cipherline.chat <ExternalLink size={12} aria-hidden />
                </button>
            </div>
            <div className="cb-foot">
                <ShieldCheck size={13} aria-hidden />
                Updates are signed by Cipherline and verified before they install.
            </div>
        </ClientBlockScreen>
    );
}

export default UpdateRequiredScreen;
