import { useEffect, useRef } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { API_BASE } from '../constants';
import { secureLocalStore } from '../utils/secureLocalStore';
import { bindEntrancePrefs } from '../utils/entrancePrefs';
import {
    bindCallPersonalizationTransport, requestCallPersonalization, type PersonalizationTransport,
} from '../utils/callPersonalizationStore';

/**
 * Mounted once next to EggProgressHost; renders nothing. It
 *   1. gives utils/callPersonalizationStore its only network access
 *      (`GET /v1/personalization?ids=`, `PATCH /v1/me/personalization`),
 *   2. loads this account's listener prefs (utils/entrancePrefs.ts), and
 *   3. reads the caller's OWN cosmetics once at sign-in, so Settings and the
 *      local tiles show the saved values on this device too.
 * Everything here is cosmetic: a failure leaves defaults and says nothing.
 */
export const CallPersonalizationHost = () => {
    const { token, userId } = useAuth();
    const tokenRef = useRef(token);
    useEffect(() => { tokenRef.current = token; });

    useEffect(() => {
        if (!userId) return;
        let cancelled = false;
        const headers = () => ({ Authorization: `Bearer ${tokenRef.current ?? ''}` });
        const transport: PersonalizationTransport = {
            async read(ids) {
                if (!tokenRef.current) return {};
                const res = await axios.get(`${API_BASE}/personalization`, { params: { ids: ids.join(',') }, headers: headers(), timeout: 15000 });
                return res.data ?? {};
            },
            async save(patch) {
                const res = await axios.patch(`${API_BASE}/me/personalization`, patch, { headers: headers(), timeout: 15000 });
                return res.data;
            },
        };
        void secureLocalStore.whenAccountReady().catch(() => undefined).then(() => {
            if (cancelled) return;
            bindEntrancePrefs(userId);
            bindCallPersonalizationTransport(transport);
            requestCallPersonalization([userId]);
        });
        return () => {
            cancelled = true;
            bindCallPersonalizationTransport(null);
            bindEntrancePrefs(null);
        };
    }, [userId]);

    return null;
};

export default CallPersonalizationHost;
