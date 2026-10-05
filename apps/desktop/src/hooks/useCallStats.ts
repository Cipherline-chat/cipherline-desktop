import { useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';

export interface CallStats {
    pingMs: number | null;
    packetLossPercent: number | null;
}

const POLL_INTERVAL_MS = 3000;

/**
 * Polls LiveKit's internal PCTransportManager every 3 s and returns
 * round-trip time (ms) and per-interval packet-loss (%).
 *
 * RTT  — nominated ICE candidate-pair `currentRoundTripTime` (seconds → ms).
 * Loss — delta of inbound-rtp `packetsLost / (packetsLost + packetsReceived)`
 *         between polls so it reflects recent loss, not a lifetime average.
 *
 * Access path: room.engine.pcManager.subscriber (PCTransport) → .getStats()
 * which internally calls its RTCPeerConnection.getStats().  Falls back to
 * the publisher transport if the subscriber isn't up yet.
 */
export function useCallStats(): CallStats {
    const room = useRoomContext();
    const [stats, setStats] = useState<CallStats>({ pingMs: null, packetLossPercent: null });
    const prevRef = useRef({ packetsLost: 0, packetsReceived: 0, seeded: false });

    useEffect(() => {
        const poll = async () => {
            try {
                const pcManager = (room as any).engine?.pcManager;
                if (!pcManager) return;

                // Prefer the subscriber transport — it receives remote media and
                // has the richest set of inbound-rtp stats and ICE pair RTT.
                let report: RTCStatsReport | undefined;
                try { report = await pcManager.subscriber?.getStats?.(); } catch { /* ignore */ }
                if (!report) {
                    try { report = await pcManager.publisher?.getStats?.(); } catch { /* ignore */ }
                }
                if (!report) return;

                let rttMs: number | null = null;
                let totalLost = 0;
                let totalReceived = 0;
                let hasInbound = false;

                report.forEach((stat: any) => {
                    // ICE candidate-pair → RTT.  In Chromium the nominated pair
                    // has `nominated === true`; fall back to `state === 'succeeded'`
                    // for environments that don't set that flag.
                    if (stat.type === 'candidate-pair') {
                        const rtt = stat.currentRoundTripTime;
                        if (rtt != null && (stat.nominated === true || stat.state === 'succeeded')) {
                            const ms = Math.round(rtt * 1000);
                            if (rttMs === null || ms < rttMs) rttMs = ms;
                        }
                    }
                    // Inbound RTP → cumulative packet counters for delta-loss.
                    if (stat.type === 'inbound-rtp') {
                        totalLost     += stat.packetsLost     ?? 0;
                        totalReceived += stat.packetsReceived ?? 0;
                        hasInbound = true;
                    }
                });

                let lossPercent: number | null = null;
                if (hasInbound) {
                    const prev = prevRef.current;
                    if (!prev.seeded) {
                        // First poll — seed counters, report 0 % (no delta yet)
                        prevRef.current = { packetsLost: totalLost, packetsReceived: totalReceived, seeded: true };
                        lossPercent = 0;
                    } else {
                        const deltaLost     = Math.max(0, totalLost     - prev.packetsLost);
                        const deltaReceived = Math.max(0, totalReceived - prev.packetsReceived);
                        const deltaTotal    = deltaLost + deltaReceived;
                        lossPercent = deltaTotal > 0 ? Math.round((deltaLost / deltaTotal) * 100) : 0;
                        prevRef.current = { packetsLost: totalLost, packetsReceived: totalReceived, seeded: true };
                    }
                }

                setStats(prev => {
                    if (prev.pingMs === rttMs && prev.packetLossPercent === lossPercent) return prev;
                    return { pingMs: rttMs, packetLossPercent: lossPercent };
                });
            } catch {
                // PCTransportManager not ready yet — keep previous values silently
            }
        };

        // Short initial delay to let ICE negotiate before the first poll
        const first = setTimeout(poll, 2000);
        const iv    = setInterval(poll, POLL_INTERVAL_MS);
        return () => { clearTimeout(first); clearInterval(iv); };
    }, [room]);

    return stats;
}

/** Tailwind text-color for ping latency. */
export function pingColor(ms: number | null): string {
    if (ms === null) return 'text-gray-500';
    if (ms < 80)    return 'text-green-400';
    if (ms < 200)   return 'text-yellow-400';
    return 'text-red-400';
}

/** Tailwind text-color for packet-loss percentage. */
export function lossColor(pct: number | null): string {
    if (pct === null) return 'text-gray-500';
    if (pct < 1)      return 'text-green-400';
    if (pct < 5)      return 'text-yellow-400';
    return 'text-red-400';
}
