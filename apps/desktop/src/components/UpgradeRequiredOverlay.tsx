import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_VERSION } from '../constants';
import { useUpdate } from '../contexts/UpdateContext';
import { DEFAULT_UPDATE_URL, UPGRADE_REQUIRED_EVENT, pinUpdateUrl } from '../utils/clientControl';
import { fetchClientStatus } from '../utils/clientStatusFetch';
import { UpdateRequiredScreen, type CheckPhase } from './UpdateRequiredScreen';

/** Re-check for the update this often while nothing has been found yet. */
const RECHECK_IDLE_MS = 5 * 60_000;

/**
 * Blocking full-screen "Update required", shown when the server says this
 * build is below the version floor: HTTP 426 on any REST call, WS close 4426,
 * or the boot / reconnect check against GET /v1/client-status
 * (ClientControlGate). All three arrive as the `cipherline:upgrade-required`
 * window event, optionally with `{ minVersion }`.
 *
 * Once shown it never hides — the old build is dead to the server. The way
 * out is the update itself, driven through the existing auto-updater bridge
 * (UpdateContext → preload `checkForUpdatesNow` / `retryUpdate` /
 * `quitAndInstall`; no new IPC): on show it forces a check, electron-updater
 * downloads automatically, and the button follows the updater's state to
 * "Restart & update". The website download is a quiet fallback link.
 *
 * Props/API unchanged (default export, no props) — mounted once at the App
 * root. The visual is UpdateRequiredScreen.
 */
export default function UpgradeRequiredOverlay() {
    const [shown, setShown] = useState(false);
    const [minVersion, setMinVersion] = useState<string | null>(null);
    const [updateUrl, setUpdateUrl] = useState(DEFAULT_UPDATE_URL);
    const [checkPhase, setCheckPhase] = useState<CheckPhase>('idle');
    const [installing, setInstalling] = useState(false);
    const [installError, setInstallError] = useState<string | null>(null);
    const { state, retry, openDownload, checkNow } = useUpdate();
    const shownRef = useRef(false);


    const runCheck = useCallback(async () => {
        setCheckPhase('checking');
        try {
            const dispatched = await checkNow();
            // The answer arrives on `state`; if it stays idle the feed has
            // nothing newer for this channel (yet).
            setCheckPhase(dispatched ? 'none-found' : 'no-updater');
        } catch {
            setCheckPhase('error');
        }
    }, [checkNow]);

    // On the FIRST signal: show, learn the required version / download page if
    // the signal didn't carry them, and start the update right away. Done in
    // the event handler (not an effect on `shown`) so it runs exactly once,
    // with the updater state as it is at that moment (read through a ref).
    const firstShow = useRef<() => void>(() => undefined);
    useEffect(() => {
        firstShow.current = () => {
            void fetchClientStatus().then((s) => {
                if (!s) return;
                setUpdateUrl(s.updateUrl);
                setMinVersion((cur) => cur ?? (s.minVersionDesktop !== '0.0.0' ? s.minVersionDesktop : null));
            });
            if (state.phase === 'idle') void runCheck();
        };
    });

    useEffect(() => {
        const onUpgradeRequired = (e: Event) => {
            const detail = (e as CustomEvent).detail as { minVersion?: string } | undefined;
            if (detail?.minVersion) setMinVersion(detail.minVersion);
            if (shownRef.current) return;
            shownRef.current = true;
            setShown(true);
            firstShow.current();
        };
        window.addEventListener(UPGRADE_REQUIRED_EVENT, onUpgradeRequired);
        return () => window.removeEventListener(UPGRADE_REQUIRED_EVENT, onUpgradeRequired);
    }, []);

    // While nothing is found, keep asking (a release may still be propagating).
    useEffect(() => {
        if (!shown || state.phase !== 'idle' || checkPhase !== 'none-found') return;
        const t = setTimeout(() => { void runCheck(); }, RECHECK_IDLE_MS);
        return () => clearTimeout(t);
    }, [shown, state.phase, checkPhase, runCheck]);

    const openWebsite = useCallback(() => {
        // Pinned again at the point of use: only ever our own download page.
        window.electronAPI?.openExternal?.(pinUpdateUrl(updateUrl))?.catch?.(() => { /* nothing else to try */ });
    }, [updateUrl]);

    const install = useCallback(async () => {
        // quitAndInstall kills the process on success, so everything after it
        // is for the FAILURE case: no bridge (dev/unpackaged) or the IPC
        // rejecting (corrupt download, updater in a bad state). Both used to
        // be silent on an undismissable screen — a dead end.
        if (!window.electronAPI?.quitAndInstall) {
            setInstallError('Restart isn’t available in this build — download the latest version from cipherline.chat.');
            return;
        }
        setInstalling(true);
        setInstallError(null);
        try {
            await window.electronAPI.quitAndInstall();
        } catch (err) {
            setInstalling(false);
            setInstallError('Couldn’t restart automatically. Try again, or download the latest version from cipherline.chat.');
            console.warn('[UpgradeRequiredOverlay] quitAndInstall failed:', err);
        }
    }, []);

    const onPrimary = useCallback(() => {
        switch (state.phase) {
            case 'ready': void install(); return;
            case 'retrying':
            case 'failed': retry(); return;
            case 'manual': openDownload(); return;
            case 'available':
            case 'downloading': return;
            default:
                if (checkPhase === 'no-updater') openWebsite();
                else void runCheck();
        }
    }, [state.phase, checkPhase, install, retry, openDownload, openWebsite, runCheck]);

    if (!shown) return null;

    return (
        <UpdateRequiredScreen
            currentVersion={APP_VERSION}
            requiredVersion={minVersion}
            update={state}
            checkPhase={checkPhase}
            installing={installing}
            installError={installError}
            onPrimary={onPrimary}
            onOpenWebsite={openWebsite}
        />
    );
}
