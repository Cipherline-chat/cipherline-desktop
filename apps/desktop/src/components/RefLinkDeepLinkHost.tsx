/**
 * A friend's profile-share QR / referral link opened while SIGNED IN
 * (`cipherline://ref/<CODE>`). Signed out, AuthScreen owns this link and fills
 * the sign-up form; this host is mounted by Dashboard only, so that path is
 * untouched. Resolves the code (GET /v1/friends/by-link/:code) and opens the
 * person's profile through Dashboard's own openProfileAt, whose Add Friend /
 * Message buttons already reflect friendship state. Renders nothing itself.
 */
import { useEffect, useRef } from 'react';
import axios from 'axios';
import { apiUrl } from '../utils/apiPath';
import { useToast } from '../contexts/ToastContext';
import { REF_LINK_TOASTS, resolveRefLink } from '../utils/refLinkLookup';

interface Props {
    token: string | null | undefined;
    onOpenProfile: (userId: string) => void;
}

export const RefLinkDeepLinkHost: React.FC<Props> = ({ token, onOpenProfile }) => {
    const toast = useToast();
    // Latest values without re-subscribing the IPC listener on every render.
    const live = useRef({ token, onOpenProfile, toast });
    live.current = { token, onOpenProfile, toast };

    useEffect(() => {
        const api = window.electronAPI;
        let alive = true;
        const handle = async (raw: unknown) => {
            const { token: t, onOpenProfile: open, toast: tst } = live.current;
            if (!t) return;
            const outcome = await resolveRefLink(raw, async (code) => {
                const res = await axios.get(apiUrl`/friends/by-link/${code}`, {
                    headers: { Authorization: `Bearer ${t}` },
                    validateStatus: () => true,
                });
                return { status: res.status, data: res.data };
            });
            if (!alive) return;
            if (outcome.kind === 'open_profile') open(outcome.userId);
            else tst.push(REF_LINK_TOASTS[outcome.kind]);
        };
        // Main parks the code until read (cold start / signed-in-later); consume it so it
        // doesn't resurface on the sign-up screen after a later sign-out.
        const off = api?.onDeepLinkRef?.((code) => {
            void handle(code);
            void api.getPendingDeepLinkRef?.().catch(() => {});
        });
        void api?.getPendingDeepLinkRef?.().then((code) => { if (code) void handle(code); }, () => { /* none */ });
        return () => { alive = false; off?.(); };
    }, []);

    return null;
};

export default RefLinkDeepLinkHost;
