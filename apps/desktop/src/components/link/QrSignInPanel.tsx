import React from 'react';
import axios from 'axios';
import QRCode from 'qrcode';
import { QrCode as QrCodeIcon, Loader2, ShieldCheck, AlertTriangle, X as XIcon, Smartphone } from 'lucide-react';
import { API_BASE } from '../../constants';
import { useAuth } from '../../contexts/AuthContext';
import { registerOrReuseDevice } from '../../utils/deviceRegistration';
import { buildLinkQr } from '../../utils/linkQr';
import { formatCountdown } from '../../utils/formatCountdown';
import { ClButton } from '../ClButton';
import { userColor, userIconColor } from '../../utils/avatarColor';
import {
    QrSignInController, generateVerificationCode,
    type QrSignInDeps, type QrSignInSnapshot, type CreateSessionResult, type PollResult, type LinkGrantResult,
} from '../../utils/qrSignInController';
import type { ClaimLinkSessionResponse } from '../../types/link';
import { useLinkController } from './useLinkController';

/**
 * QR sign-in — the NEW device's half (this desktop, at the sign-in screen).
 * Full design + threat model: docs/QR-LINKING.md §2, §7; the 2026-09-28
 * hardening (verification code, claim-then-mint, richer confirm screen) is
 * described in `../../utils/qrSignInController.ts`'s header.
 *
 * Deliberately NOT in `components/cl/` — that directory is imported directly
 * by `apps/website` (CLAUDE.md's architecture map), and this panel talks to
 * Electron IPC that has no meaning on the web.
 *
 * All the session/poll/countdown state machinery lives in
 * `../../utils/qrSignInController.ts`, a plain, dependency-injected module —
 * this component is a thin view over it (build the real dependencies once,
 * subscribe to its snapshot, render by phase). See that file's header for why
 * the split exists: `apps/desktop`'s vitest suite has no DOM (and its
 * `include` glob only matches `*.test.ts`), so every other test in this app
 * exercises logic directly rather than mounting a component — the coverage
 * for this file lives in `QrSignInPanel.test.ts` (deliberately `.ts`, not
 * `.tsx` — see that file's header) exercising the controller directly.
 * `QrPanels.strictMode.test.ts` additionally mounts THIS component (jsdom,
 * inside `<StrictMode>` as main.tsx does), because the one bug a controller
 * test cannot see is the component mismanaging the controller's lifetime.
 */

/** Vite dev server (Tier-1). False in every packaged build, staging included. */
const IS_DEV_BUILD = import.meta.env.DEV === true;

const POLL_INTERVAL_MS = 2000;
// Sub-second so the displayed countdown ticks smoothly rather than jumping in
// whole seconds; the 2s poll above is the thing actually bounded by the server.
const COUNTDOWN_TICK_MS = 250;

/** Wires the controller's injected dependencies to the real IPC bridge,
 *  `axios`, and `AuthContext.login`. The one function argument is `login`
 *  itself (from `useAuth()`) — everything else is a module-level import, so
 *  this needs no other component state. */
function realDeps(login: (t: string, u: string, d: string, p: boolean, r?: string) => void | Promise<void>): QrSignInDeps {
    return {
        linkBegin: async (linkId: string) => {
            if (!window.electronAPI) throw new Error('This feature requires the desktop app.');
            return window.electronAPI.linkBegin(linkId);
        },
        linkBind: async (linkId: string) => {
            if (!window.electronAPI) throw new Error('This feature requires the desktop app.');
            await window.electronAPI.linkBind(linkId);
        },
        linkOpen: async (envelopeB64: string, linkId: string): Promise<LinkGrantResult> => {
            if (!window.electronAPI) throw new Error('This feature requires the desktop app.');
            return window.electronAPI.linkOpen(envelopeB64, linkId);
        },
        linkEnd: async () => {
            await window.electronAPI?.linkEnd?.();
        },
        getDeviceName: async () => {
            if (!window.electronAPI) return 'Cipherline Desktop';
            return window.electronAPI.getDeviceName();
        },
        getPlatform: () => window.electronAPI?.platform ?? 'windows',
        generateCode: generateVerificationCode,
        createSession: async (ekPubB64: string, deviceLabel: string, code: string, platform: string): Promise<CreateSessionResult> => {
            const res = await axios.post<CreateSessionResult>(`${API_BASE}/link/sessions`, {
                ek_pub_b64: ekPubB64,
                device_label: deviceLabel,
                platform,
                code,
            });
            return res.data;
        },
        pollSession: async (linkId: string): Promise<PollResult> => {
            const res = await axios.get<PollResult>(`${API_BASE}/link/sessions/${linkId}`);
            return res.data;
        },
        claimSession: async (linkId: string, claimSecret: string): Promise<ClaimLinkSessionResponse> => {
            const res = await axios.post<ClaimLinkSessionResponse>(`${API_BASE}/link/sessions/${linkId}/claim`, {
                claim_secret: claimSecret,
            });
            return res.data;
        },
        destroySession: async (linkId: string, accessToken: string) => {
            await axios.delete(`${API_BASE}/link/sessions/${linkId}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
        },
        // QR-1: the AUTHORITATIVE "whose account is this" check — the same
        // endpoint AuthContext's refreshProfile() calls after a password
        // login, hit here with the NEW token before anything is persisted.
        // See qrSignInController.ts's QrSignInDeps.whoAmI doc for why this
        // must never be read from the grant instead.
        whoAmI: async (accessToken: string) => {
            const res = await axios.get(`${API_BASE}/auth/me`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            return {
                user_id: res.data.user_id,
                username: res.data.username,
                discriminator: res.data.discriminator ?? null,
                avatar_url: res.data.avatar_url ?? null,
            };
        },
        registerDevice: (userId: string, accessToken: string) => registerOrReuseDevice(userId, accessToken, 'QR'),
        login,
        renderQr: (text: string) => QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 256 }),
        // SECURITY: `linkId`/`ekPubB64` here must come from `linkBegin`'s
        // return value and the server-issued link id ONLY — never from a
        // server response field. docs/QR-LINKING.md §2.5 explains why a
        // server-rendered/sourced QR would reintroduce exactly the
        // compromise this design exists to close. `buildLinkQr` itself takes
        // no network input at all, which is what makes that true by
        // construction here rather than by discipline.
        buildQrText: buildLinkQr,
        pollIntervalMs: POLL_INTERVAL_MS,
        countdownTickMs: COUNTDOWN_TICK_MS,
    };
}

const emptySnapshot: QrSignInSnapshot = {
    phase: 'idle', fingerprint: null, qrDataUrl: null, remainingS: 0, error: null,
    verificationCode: null, deniedReason: null, confirmIdentity: null,
};

/** "123 456" — grouped so it reads as two triplets, the way a human copies it. */
function groupCode(code: string): string {
    return `${code.slice(0, 3)} ${code.slice(3)}`;
}

const QrSignInPanel: React.FC = () => {
    const { login } = useAuth();
    // One controller per MOUNT, built in the mount effect and disposed in its
    // cleanup — see useLinkController for why building it during render left
    // every dev build (React StrictMode) with a dead "Show a code" button.
    // Unmount (switching back to the password tab, navigating away) disposes
    // it, which discards the main-process ephemeral key.
    const { snapshot: snap, controllerRef } = useLinkController<QrSignInSnapshot, QrSignInController>(
        () => new QrSignInController(realDeps(login)),
        emptySnapshot,
    );

    const { phase } = snap;

    // ── render ──────────────────────────────────────────────────────────

    if (phase === 'idle') {
        return (
            <div className="flex flex-col items-center gap-4 py-2">
                <div
                    className="flex items-center justify-center rounded-2xl"
                    style={{ width: 208, height: 208, background: 'var(--cl-surface)', border: '1px solid var(--cl-border)' }}
                >
                    <QrCodeIcon size={56} style={{ color: 'var(--cl-faint)' }} />
                </div>
                <p className="text-cl-faint text-sm text-center max-w-[260px] m-0">
                    Open Cipherline on your phone and scan a code to sign in here — no password needed.
                </p>
                <ClButton fullWidth onClick={() => void controllerRef.current?.begin()}>Show a code</ClButton>
            </div>
        );
    }

    if (phase === 'starting') {
        return (
            <div className="flex flex-col items-center gap-3" style={{ padding: '48px 0' }}>
                <Loader2 className="animate-spin" size={26} style={{ color: 'var(--cl-lume)' }} />
                <p className="text-cl-faint text-sm m-0">Preparing your code…</p>
            </div>
        );
    }

    // A1: a signed-in device has scanned. The QR has done its job; what the
    // approver needs now is the six digits — and ONLY someone looking at this
    // screen can read them. Shown large, nothing else competing.
    if (phase === 'scanned') {
        return (
            <div className="flex flex-col items-center gap-3 py-2">
                <Smartphone size={30} style={{ color: 'var(--cl-lume)' }} />
                <p className="text-cl-text text-sm font-semibold text-center m-0">Enter this code on your phone</p>
                <code
                    className="font-mono font-bold text-cl-text"
                    style={{ fontSize: 34, letterSpacing: '0.18em' }}
                    data-testid="qr-verification-code"
                    aria-label="Verification code"
                >
                    {snap.verificationCode ? groupCode(snap.verificationCode) : '—'}
                </code>
                <p className="text-cl-faint text-xs text-center max-w-[280px] m-0">
                    Your phone asks for it before it approves. Nobody who only has a picture of the QR code can see this.
                </p>
                <div className="flex items-center gap-1.5 text-cl-faint text-xs" role="status" aria-live="polite">
                    <ShieldCheck size={13} />
                    <span>Code expires in {formatCountdown(snap.remainingS)}</span>
                </div>
                <button
                    type="button"
                    onClick={() => void controllerRef.current?.cancel()}
                    className="text-[13px] text-cl-faint hover:text-cl-text transition-colors mt-1"
                >
                    Cancel
                </button>
            </div>
        );
    }

    // QR-1: show the identity the server itself resolved from the new token
    // (never the grant's own fields — see qrSignInController.ts's whoAmI
    // doc) and make the user say so explicitly before anything is persisted.
    // Avatar + handle + approving device, all prominent: with the verification
    // code in place a substituted approval is structurally hard, but this
    // screen remains the visible last line. Deliberately two full-weight
    // buttons, no autoFocus on either: "Continue" must not be the path of
    // least resistance.
    if (phase === 'confirm') {
        // Controller invariant: 'confirm' is only ever set together with
        // confirmIdentity (see qrSignInController.ts's openGrant). Guard
        // anyway rather than rendering a busy-QR fallback for a phase that
        // has no QR of its own to show.
        if (!snap.confirmIdentity) return null;
        const { userId, username, discriminator, approvedByDeviceName } = snap.confirmIdentity;
        const handle = discriminator != null
            ? `@${username}#${String(discriminator).padStart(4, '0')}`
            : `@${username}`;
        return (
            <div className="flex flex-col items-center gap-4 py-2">
                {/* Avatars are E2EE blobs and this device holds no avatar key
                    yet (it is not signed in), so the IMAGE cannot be shown
                    here. What can: the account's identity colour (hashed from
                    the user id — the same colour every other client shows for
                    this account) and its initial. A different account reads
                    as a different avatar even without the picture. */}
                <div
                    className="flex items-center justify-center font-bold"
                    style={{
                        width: 72, height: 72, borderRadius: 24, fontSize: 30,
                        background: userColor(userId), color: userIconColor(userId),
                    }}
                    aria-hidden
                    data-testid="qr-confirm-avatar"
                >
                    {(username || '?').slice(0, 1).toUpperCase()}
                </div>
                <div className="flex flex-col items-center gap-1 text-center">
                    <p className="text-cl-faint text-sm m-0">You are about to sign in as</p>
                    <p className="text-cl-text font-bold m-0" style={{ fontSize: 22 }} data-testid="qr-confirm-handle">{handle}</p>
                    <p className="text-cl-text text-sm m-0 mt-1" data-testid="qr-confirm-device">
                        Approved from <b>{approvedByDeviceName}</b>
                    </p>
                </div>
                <div className="flex items-start gap-2 text-cl-faint text-xs max-w-[300px]">
                    <ShieldCheck size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--cl-lume)' }} />
                    <p className="m-0 text-left">
                        Only continue if this is <b>your</b> account and <b>your</b> phone. If either looks wrong, stop here and show a new code.
                    </p>
                </div>
                <div className="flex gap-2 w-full mt-1">
                    <ClButton fullWidth style={{ flex: 1 }} onClick={() => void controllerRef.current?.rejectAccount()}>
                        This isn't my account
                    </ClButton>
                    <ClButton fullWidth style={{ flex: 1 }} onClick={() => void controllerRef.current?.confirmAccount()}>
                        Continue
                    </ClButton>
                </div>
            </div>
        );
    }

    if (phase === 'expired' || phase === 'denied' || phase === 'error') {
        const locked = phase === 'denied' && snap.deniedReason === 'locked';
        const icon = phase === 'denied'
            ? <XIcon size={40} style={{ color: 'var(--cl-flash)' }} />
            : <AlertTriangle size={40} style={{ color: phase === 'error' ? 'var(--cl-flash)' : 'var(--cl-faint)' }} />;
        const heading = locked ? 'Too many wrong codes'
            : phase === 'denied' ? 'Declined on your other device'
            : phase === 'expired' ? 'This code expired'
            : 'Sign-in failed';
        const detail = phase === 'error' ? snap.error
            : locked ? 'The code entered on the other device did not match five times, so this sign-in was cancelled. Show a new code and read the digits carefully.'
            : null;
        return (
            <div className="flex flex-col items-center gap-3 py-4">
                {icon}
                <p className="text-cl-text text-sm font-semibold text-center m-0" role="status">{heading}</p>
                {detail && <p className="text-cl-faint text-xs text-center max-w-[260px] m-0">{detail}</p>}
                <ClButton fullWidth onClick={() => void controllerRef.current?.begin()} className="mt-1">Show a new code</ClButton>
            </div>
        );
    }

    // active / approving / opening / success — the QR is on screen, or was a
    // moment ago (success is momentary: AuthContext flips isAuthenticated and
    // the parent swaps this panel out for the Dashboard).
    if (!snap.qrDataUrl) return null; // unreachable in practice; keeps TS happy
    const isBusy = phase === 'approving' || phase === 'opening' || phase === 'success';
    return (
        <div className="flex flex-col items-center gap-3 py-1">
            <div
                className="relative flex items-center justify-center rounded-2xl overflow-hidden"
                style={{ width: 208, height: 208, background: '#FFFFFF' }}
            >
                <img src={snap.qrDataUrl} alt="Scan with Cipherline on your phone to sign in" width={208} height={208} />
                {isBusy && (
                    <div
                        className="absolute inset-0 flex flex-col items-center justify-center gap-2"
                        style={{ background: 'rgba(11,15,30,0.82)' }}
                    >
                        <Loader2 className="animate-spin" size={24} style={{ color: 'var(--cl-lume)' }} />
                        <span className="text-[12px] font-medium text-center px-3" style={{ color: 'var(--cl-text)' }}>
                            {phase === 'approving' ? 'Approved — finishing up' : 'Finishing sign-in…'}
                        </span>
                    </div>
                )}
            </div>

            <div className="flex flex-col items-center gap-1">
                <span className="text-cl-faint text-[11px]">Check this code matches the one on your phone</span>
                <code
                    className="font-mono font-bold text-cl-text"
                    style={{ fontSize: 18, letterSpacing: '0.08em' }}
                >
                    {snap.fingerprint}
                </code>
            </div>

            <div className="flex items-center gap-1.5 text-cl-faint text-xs" role="status" aria-live="polite">
                <ShieldCheck size={13} />
                {phase === 'active'
                    ? <span>Code expires in {formatCountdown(snap.remainingS)}</span>
                    : <span>Waiting on your phone…</span>}
            </div>

            {/* A code exists only on the server that issued it. A dev build
                (Tier-1: hosts-file → the dev box) issues codes on the DEV
                server, which a phone on production can never find — it just
                reports the code as expired. Say so where the tester is
                looking, instead of letting them re-show codes that cannot
                work. Production and staging builds never render this. */}
            {IS_DEV_BUILD && phase === 'active' && (
                <p className="text-cl-faint text-[11px] text-center max-w-[280px] m-0" data-testid="qr-dev-server-note">
                    Development build: only a phone using this same server can approve this code.
                </p>
            )}

            {!isBusy && (
                <button
                    type="button"
                    onClick={() => void controllerRef.current?.cancel()}
                    className="text-[13px] text-cl-faint hover:text-cl-text transition-colors mt-1"
                >
                    Cancel
                </button>
            )}
        </div>
    );
};

export default QrSignInPanel;
