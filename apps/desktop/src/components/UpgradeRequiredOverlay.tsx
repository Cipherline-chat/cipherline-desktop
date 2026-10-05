import { useEffect, useState } from 'react';
import { APP_VERSION } from '../constants';
import { ClButton, ClModal } from './cl';

type OverlayState =
    | { kind: 'hidden' }
    | { kind: 'upgrade-required'; minVersion?: string };

/**
 * Blocking overlay shown when the server tells us our build is below
 * MIN_CLIENT_VERSION (via HTTP 426 on any REST call or WS close code 4426).
 * Mounted at the root of the app so it covers the auth screen, dashboard, and
 * pairing flow uniformly. Once shown it never hides — the old build is dead
 * to the server — the user has to restart into a fresh installer.
 *
 * This used to ALSO cover the soft "an update finished downloading, restart
 * whenever" case (a second copy of that nudge, alongside the old
 * UpdateReadyBanner). That's now the rail tile's job exclusively — see
 * UpdateRailTile.tsx / UpdateContext.tsx — one place for the ambient nudge
 * instead of two independently listening for the same event. This overlay
 * only ever renders for the forced, non-dismissible case now.
 */
export default function UpgradeRequiredOverlay() {
    const [state, setState] = useState<OverlayState>({ kind: 'hidden' });
    const [relaunching, setRelaunching] = useState(false);
    const [relaunchError, setRelaunchError] = useState<string | null>(null);

    useEffect(() => {
        const onUpgradeRequired = (e: Event) => {
            const detail = (e as CustomEvent).detail as { minVersion?: string } | undefined;
            setState({ kind: 'upgrade-required', minVersion: detail?.minVersion });
        };
        window.addEventListener('cipherline:upgrade-required', onUpgradeRequired);
        return () => window.removeEventListener('cipherline:upgrade-required', onUpgradeRequired);
    }, []);

    if (state.kind === 'hidden') return null;

    const title = 'Update required';
    const body = `Cipherline ${APP_VERSION} is no longer supported${state.minVersion ? ` (server requires ≥ ${state.minVersion})` : ''}. A newer build is required to continue. If an update is downloading in the background it will install on relaunch; otherwise download the latest installer from updates.cipherline.chat.`;

    const handleRelaunch = async () => {
        // quitAndInstall normally kills the process immediately on success, so
        // in the success case nothing after this line ever runs — the states
        // below exist entirely for the FAILURE case, which is exactly the one
        // this used to say nothing about. Two distinct ways it fails, both
        // previously silent:
        //   (a) window.electronAPI?.quitAndInstall is undefined — a dev/
        //       unpackaged build, or the preload bridge not exposing it — the
        //       optional chain short-circuited and nothing happened at all.
        //   (b) the IPC call itself rejects (missing/corrupt downloaded
        //       installer, updater in a bad state) — swallowed by a bare
        //       `.catch(() => {})`.
        // In FORCED mode this button is the only thing on an undismissable
        // modal, so silently doing nothing was a genuine dead end.
        if (!window.electronAPI?.quitAndInstall) {
            setRelaunchError('Restart isn’t available in this build. Download the latest installer from updates.cipherline.chat and reinstall manually.');
            return;
        }
        setRelaunching(true);
        setRelaunchError(null);
        try {
            await window.electronAPI.quitAndInstall();
        } catch (err) {
            setRelaunching(false);
            setRelaunchError('Could not restart automatically. Download the latest installer from updates.cipherline.chat and reinstall manually.');
            console.warn('[UpgradeRequiredOverlay] quitAndInstall failed:', err);
        }
    };

    return (
        // ClModal instead of a hand-rolled overlay — was entirely hardcoded
        // hex (#1b1d22/#2b2e36/#f2f3f5/#c9ccd3), no cl-* tokens anywhere,
        // reading as a pre-design-system dialog dropped in next to everything
        // else in the app. Never dismissible — "once shown it never hides" —
        // so onClose is a no-op and closeOnOverlay is off, same guarantee the
        // old pointerEvents:'auto' hand-rolled backdrop gave.
        <ClModal
            open
            onClose={() => {}}
            closeOnOverlay={false}
            width={480}
            overlayStyle={{ zIndex: 100000 }}
            label={title}
        >
            <h2 className="m-0 mb-3 text-xl font-semibold text-cl-text">
                {title}
            </h2>
            <p className="m-0 mb-6 leading-relaxed text-cl-muted text-sm">
                {body}
            </p>
            {relaunchError && (
                <p className="m-0 mb-4 leading-relaxed text-sm" style={{ color: 'var(--cl-flash)' }}>
                    {relaunchError}
                </p>
            )}
            <div className="flex gap-2 justify-end">
                <ClButton
                    variant="primary"
                    onClick={handleRelaunch}
                    loading={relaunching}
                    disabled={relaunching}
                >
                    Restart &amp; install
                </ClButton>
            </div>
        </ClModal>
    );
}
