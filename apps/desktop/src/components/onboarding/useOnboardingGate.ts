import { useCallback, useState } from 'react';
import {
    readOnboarding, resumeStep, shouldShowOnboarding,
    type OnboardingMarker, type OnboardingStepId,
} from '../../utils/onboardingProgress';
import type { DeviceStorageStatus } from '../../hooks/useDeviceStorageSetup';

/** DEV builds only (dead-code-eliminated from production): `?ob-force=<step>`
 *  opens the setup over the real, signed-in Dashboard at that step, without a
 *  marker — for working on the ending's build-out against the real Home. */
function devForcedStep(): OnboardingStepId | null {
    if (!import.meta.env.DEV) return null;
    try {
        const v = new URLSearchParams(window.location.search).get('ob-force');
        return v === 'storage' || v === 'privacy' || v === 'profile' || v === 'invite' || v === 'ending' ? v : null;
    } catch { return null; }
}

interface GateState {
    /** The account this state belongs to. */
    uid: string | null;
    marker: OnboardingMarker | null;
    /** The step it opened at — non-null = latched open. */
    open: OnboardingStepId | null;
    done: boolean;
}

function initialFor(uid: string | null): GateState {
    const marker = readOnboarding(uid);
    return { uid, marker, open: marker ? marker.step : devForcedStep(), done: false };
}

/**
 * Whether the first-run setup should be up for the signed-in account, and
 * where it resumes. See utils/onboardingProgress.ts for the two signals.
 *
 * Latched: once up, it stays up until the ending calls `done()` — the profile
 * step clearing the server's `username_pending` must not close it mid-flow.
 * A marker opens it on the very first render (no Dashboard flash after
 * signup); a server-only resume waits for /auth/me and for this device's
 * storage decision (so it knows whether to start at storage or profile).
 *
 * State is adjusted DURING render (React's "storing information from previous
 * renders" pattern), not in effects, so the gate never paints a frame of the
 * Dashboard it is about to cover.
 */
export function useOnboardingGate(
    userId: string | null | undefined,
    usernamePending: boolean | undefined,
    deviceStorageStatus: DeviceStorageStatus,
) {
    const uid = userId ?? null;
    const [state, setState] = useState<GateState>(() => initialFor(uid));

    // Account switch within a session: re-read for the new account.
    if (state.uid !== uid) {
        setState(initialFor(uid));
    } else if (
        !state.done && !state.open && uid
        && shouldShowOnboarding(state.marker, usernamePending)
        && (state.marker || deviceStorageStatus !== 'checking')
    ) {
        // A server-only resume (username_pending, no marker on this device).
        setState({ ...state, open: resumeStep(state.marker, deviceStorageStatus === 'done') });
    }

    const done = useCallback(() => {
        setState(s => ({ ...s, done: true, open: null, marker: null }));
    }, []);

    const active = state.uid === uid && !!state.open && !state.done;
    return { active, initialStep: state.open ?? 'storage', marker: state.marker, done };
}
