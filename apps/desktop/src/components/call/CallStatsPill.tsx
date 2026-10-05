import React, { useState, useRef, useCallback } from 'react';
import { pingColor, lossColor } from '../../hooks/useCallStats';
import type { CallStats } from '../../hooks/useCallStats';

interface CallStatsPillProps {
    stats: CallStats;
    className?: string;
}

/**
 * Returns how many bars (1-4) should be lit and what color to use,
 * based on ping and packet loss combined.  Zero bars when no data yet.
 *
 *  4 bars green   — ping < 80 ms  AND loss < 1 %
 *  3 bars green   — ping < 150 ms AND loss < 5 %
 *  2 bars yellow  — ping < 250 ms AND loss < 15 %
 *  1 bar  red     — anything worse (but connected)
 *  0 bars gray    — no data yet
 */
export function signalQuality(pingMs: number | null, lossPercent: number | null): { bars: number; color: string } {
    if (pingMs === null) return { bars: 0, color: '#4b5563' };

    const loss = lossPercent ?? 0;

    if (pingMs < 80  && loss < 1)  return { bars: 4, color: '#4ade80' }; // green-400
    if (pingMs < 150 && loss < 5)  return { bars: 3, color: '#86efac' }; // green-300
    if (pingMs < 250 && loss < 15) return { bars: 2, color: '#facc15' }; // yellow-400
    return                                { bars: 1, color: '#f87171' }; // red-400
}

/** Four signal bars — the bottom N are lit in `activeColor`, the rest are dimmed. */
export const SignalBars: React.FC<{ bars: number; color: string }> = ({ bars, color }) => {
    const dim = 'rgba(255,255,255,0.12)';
    // Each rect: [x, y, width, height] — bars grow taller left→right
    const rects: [number, number, number, number][] = [
        [0,   9,  3,   7],
        [4.5, 6,  3,  10],
        [9,   3,  3,  13],
        [13.5, 0, 2.5, 16],
    ];

    return (
        <svg
            width="16" height="16"
            viewBox="0 0 16 16"
            className="w-3 h-3 shrink-0"
            aria-hidden
            style={{ display: 'block' }}
        >
            {rects.map(([x, y, w, h], i) => (
                <rect
                    key={i}
                    x={x} y={y} width={w} height={h} rx="0.8"
                    fill={i < bars ? color : dim}
                    style={{ transition: 'fill 400ms ease' }}
                />
            ))}
        </svg>
    );
};

/**
 * Compact connection-quality pill.
 *
 * Normal state — signal bars + ping: "[▂▄▆█] 24 ms"
 * Hover state  — packet loss slides in: "[▂▄▆█] 24 ms · 0% loss"
 */
export const CallStatsPill: React.FC<CallStatsPillProps> = ({ stats, className = '' }) => {
    const [hovered, setHovered] = useState(false);
    const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const { pingMs, packetLossPercent } = stats;
    const { bars, color } = signalQuality(pingMs, packetLossPercent);

    const handleEnter = useCallback(() => {
        if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
        setHovered(true);
    }, []);

    const handleLeave = useCallback(() => {
        leaveTimer.current = setTimeout(() => setHovered(false), 200);
    }, []);

    return (
        <div
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/30 backdrop-blur-sm border border-white/[0.06] select-none cursor-default ${className}`}
            onMouseEnter={handleEnter}
            onMouseLeave={handleLeave}
        >
            <SignalBars bars={bars} color={color} />

            {/* Ping — always visible */}
            <span className={`text-[10px] font-mono font-medium tabular-nums whitespace-nowrap ${pingColor(pingMs)}`}>
                {pingMs !== null ? `${pingMs} ms` : '—'}
            </span>

            {/* Packet loss — slides in on hover */}
            <div
                className="overflow-hidden flex items-center"
                style={{
                    maxWidth: hovered ? 80 : 0,
                    opacity: hovered ? 1 : 0,
                    transition: 'max-width 200ms ease, opacity 180ms ease',
                }}
            >
                <span className="text-white/20 text-[10px] mx-1 shrink-0">·</span>
                <span className={`text-[10px] font-mono font-medium tabular-nums whitespace-nowrap ${lossColor(packetLossPercent)}`}>
                    {packetLossPercent !== null ? `${packetLossPercent}%` : '—'}
                    <span className="text-gray-500 font-normal ml-0.5">loss</span>
                </span>
            </div>
        </div>
    );
};
