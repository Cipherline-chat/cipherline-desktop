/**
 * StorageMeter — progress bar showing how much of the server's pinned-content
 * quota is in use. Lives in Settings → Overview. Re-fetches on mount.
 *
 * Quota tiers come from `@cipherline/shared` (single source of truth — same
 * file the API references for enforcement).
 */

import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Pin } from 'lucide-react';
import { formatBytes } from '@cipherline/shared';
import { API_BASE } from '../../constants';

interface Props {
    serverId: string;
    token: string | null;
    /** Refresh trigger — bump this when a pin/unpin echo arrives. */
    refreshKey?: number;
}

interface QuotaInfo {
    used_bytes: number;
    limit_bytes: number;
    member_count: number;
    tier_label: string;
}

export const StorageMeter: React.FC<Props> = ({ serverId, token, refreshKey = 0 }) => {
    const [data, setData] = useState<QuotaInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!token || !serverId) return;
        let cancelled = false;
        setLoading(true);
        axios.get(`${API_BASE}/servers/${serverId}/storage`, {
            headers: { Authorization: `Bearer ${token}` },
        }).then(res => {
            if (!cancelled) { setData(res.data); setError(null); }
        }).catch(e => {
            if (!cancelled) setError(e?.response?.data?.message ?? 'Failed to load storage');
        }).finally(() => {
            if (!cancelled) setLoading(false);
        });
        return () => { cancelled = true; };
    }, [serverId, token, refreshKey]);

    if (loading && !data) {
        return (
            <div className="text-[11px] text-cl-faint italic">Loading storage…</div>
        );
    }
    if (error || !data) {
        return <div className="text-[11px] text-red-400/70">{error ?? 'Storage unavailable'}</div>;
    }

    const pct = data.limit_bytes > 0 ? Math.min(100, (data.used_bytes / data.limit_bytes) * 100) : 0;
    const isNearLimit = pct >= 90;
    const isOverHalf  = pct >= 50;

    const fillColor = isNearLimit
        ? 'bg-red-500'
        : isOverHalf
            ? 'bg-amber-400'
            : 'bg-cl-lume';

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[11px] text-cl-muted">
                    <Pin size={11} className="text-cl-faint" />
                    <span className="font-mono font-semibold uppercase tracking-widest text-[10px] text-cl-faint">
                        Pinned-Content Storage
                    </span>
                </div>
                <span className="text-[11px] text-cl-muted font-mono tabular-nums">
                    {formatBytes(data.used_bytes)} / {formatBytes(data.limit_bytes)}
                </span>
            </div>
            {/* Bar */}
            <div className="h-1.5 w-full bg-white/[0.06] rounded-full overflow-hidden">
                <div
                    className={`h-full ${fillColor} transition-all`}
                    style={{ width: `${pct}%` }}
                />
            </div>
            <div className="flex items-center justify-between text-[10px] text-cl-faint">
                <span>Tier: <span className="text-cl-muted">{data.tier_label}</span></span>
                <span>{Math.round(pct)}% used</span>
            </div>
            {isNearLimit && (
                <p className="text-[11px] text-amber-400/80 leading-snug">
                    You're near the storage limit. Unpin old messages to free space, or grow the
                    server's member count to unlock the next tier.
                </p>
            )}
        </div>
    );
};
