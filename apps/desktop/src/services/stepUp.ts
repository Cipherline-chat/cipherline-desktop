/**
 * Step-up re-verification client ("Confirm it's you").
 *
 * Before the app REVEALS a stored secret (the saved backup passphrase, the
 * storage recovery key) it asks the user to prove they are present right now:
 * a fresh authenticator code or an unused backup code, or — for accounts
 * without 2FA — the account password. The check is
 * `POST /v1/auth/2fa/verify-step-up`.
 *
 * This is a gate against a shoulder-surfer or an unlocked machine, not an
 * access-control boundary: the server holds none of these secrets, and the
 * result is held only in memory (see useStepUp) — never persisted.
 */
import axios from 'axios';
import { API_BASE } from '../constants';

/** How long a successful step-up keeps secrets revealable. Matches the server's `step_up_until`. */
export const STEP_UP_TTL_MS = 5 * 60_000;

export type StepUpMethod = 'totp' | 'password';

export type StepUpFailure = 'rejected' | 'rate_limited' | 'unavailable';

export class StepUpError extends Error {
    readonly kind: StepUpFailure;
    constructor(kind: StepUpFailure) {
        super(kind);
        this.name = 'StepUpError';
        this.kind = kind;
    }
}

/** Which proof this account must give. Throws on any transport/server failure
 *  — the caller must NOT fall back to "no gate" when it cannot find out. */
export async function fetchStepUpMethod(token: string): Promise<StepUpMethod> {
    const res = await axios.get(`${API_BASE}/auth/2fa/totp/status`, { headers: { Authorization: `Bearer ${token}` } });
    const d = res.data as { enabled?: boolean; step_up_method?: StepUpMethod } | undefined;
    if (d?.step_up_method === 'totp' || d?.step_up_method === 'password') return d.step_up_method;
    // Older API without the flag: 2FA on => code, off => password.
    return d?.enabled ? 'totp' : 'password';
}

/** Submit the proof. Resolves on success; throws StepUpError otherwise. The
 *  value is sent once and not retained. */
export async function verifyStepUp(token: string, method: StepUpMethod, value: string): Promise<void> {
    const body = method === 'totp' ? { code: value.trim() } : { password: value };
    try {
        await axios.post(`${API_BASE}/auth/2fa/verify-step-up`, body, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 401 || status === 400) throw new StepUpError('rejected');
        if (status === 429) throw new StepUpError('rate_limited');
        throw new StepUpError('unavailable');
    }
}
