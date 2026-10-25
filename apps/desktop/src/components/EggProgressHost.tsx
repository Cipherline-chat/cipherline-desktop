import React, { useEffect, useRef } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { API_BASE } from '../constants';
import { secureLocalStore } from '../utils/secureLocalStore';
import { invalidateProfile } from '../utils/profileCache';
import {
    EGG_TIER_EVENT, EGG_TIER_COLORS, bindEggAccount, unbindEggAccount, creditLedgerFinds, eggTierByNumber, type EggSyncResult,
} from '../utils/eggProgress';
import { EggTierIcon } from './EggTierIcon';
import { resolveProfileBadgeColor } from '../utils/profileBadges';

/**
 * The signed-in app's side of the Egg hunter badge, mounted once next to
 * EggLayer. It renders nothing; it does two jobs:
 *
 *   1. Binds the account to utils/eggProgress and hands it the ONLY network
 *      call in the feature: `POST /v1/profile/eggs { ids }` (debounced and
 *      retried by the controller). The request carries egg ids and nothing
 *      else; the reply is the caller's own `{ tier, count }`.
 *   2. When a sync earns a higher tier, shows the "New badge" toast with the
 *      tier's glyph. The toast uses the stock toast stack (so it stacks and
 *      dismisses like every other one) and its entrance already honours
 *      prefers-reduced-motion (`.fade-rise-enter`); the glyph itself never
 *      animates.
 */
export const EggProgressHost: React.FC = () => {
    const { token, userId } = useAuth();
    const { push } = useToast();

    // The sender always reads the freshest token (it rotates every ~7 days and
    // on refresh) without re-binding, which would drop the debounce timer.
    const tokenRef = useRef(token);
    const pushRef = useRef(push);
    useEffect(() => { tokenRef.current = token; pushRef.current = push; });

    useEffect(() => {
        if (!userId) return;
        let cancelled = false;
        void secureLocalStore.whenAccountReady().catch(() => undefined).then(() => {
            if (cancelled) return;
            bindEggAccount(userId, async (ids): Promise<EggSyncResult | null> => {
                const t = tokenRef.current;
                if (!t) return null;
                try {
                    const res = await axios.post<EggSyncResult>(
                        `${API_BASE}/profile/eggs`,
                        { ids },
                        { headers: { Authorization: `Bearer ${t}` }, timeout: 15000 },
                    );
                    const d = res.data;
                    if (!d || typeof d.tier !== 'number' || typeof d.count !== 'number') return null;
                    return d;
                } catch {
                    return null;
                }
            });
            creditLedgerFinds();
        });
        return () => { cancelled = true; unbindEggAccount(); };
    }, [userId]);

    useEffect(() => {
        const onTier = (e: Event) => {
            const d = (e as CustomEvent<{ tier: number; name: string; count: number }>).detail;
            const t = d && eggTierByNumber(d.tier);
            if (!t) return;
            const c = resolveProfileBadgeColor(EGG_TIER_COLORS[t.tier]);
            // Your own card shows the new badge on its next open, not a stale cache.
            invalidateProfile(userId);
            pushRef.current({
                kind: 'success',
                title: `New badge: ${t.name}`,
                message: `${d.count} easter eggs found`,
                durationMs: 7000,
                icon: (
                    <span
                        className={`inline-flex items-center justify-center rounded-full border w-7 h-7 ${c.bg} ${c.border} ${c.text}`}
                        data-testid="egg-tier-toast-icon"
                    >
                        <EggTierIcon tier={t.tier} size={17} />
                    </span>
                ),
            });
        };
        window.addEventListener(EGG_TIER_EVENT, onTier);
        return () => window.removeEventListener(EGG_TIER_EVENT, onTier);
    }, [userId]);

    return null;
};

export default EggProgressHost;
