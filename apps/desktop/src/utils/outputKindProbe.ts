/**
 * Live "speakers or headphones?" for the current output pick: asks the OS (via
 * the main process) and Chromium's device list, hands both to the pure
 * resolver in outputKind.ts, and re-asks when the hardware or the pick changes.
 *
 * Nothing here is persisted and nothing leaves the device: the answer is an enum
 * held in React state, and the only trace is one memory-only call event
 * (`output_kind`: enums and a boolean, never a device name or id).
 */
import { useEffect, useRef, useState } from 'react';
import { resolveOutputKind, type OutputEndpointFacts, type OutputKindResult } from './outputKind';
import { logCallEvent } from './callEventLog';

const UNKNOWN: OutputKindResult = { kind: 'unknown', source: 'none' };

/** Validate what crossed the IPC boundary: only well-formed records survive. */
export function sanitizeFacts(raw: unknown): OutputEndpointFacts[] {
    if (!Array.isArray(raw)) return [];
    const out: OutputEndpointFacts[] = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object' || typeof (r as { name?: unknown }).name !== 'string') continue;
        const o = r as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : undefined);
        out.push({
            name: String(o.name).slice(0, 200),
            isDefault: o.isDefault === true,
            isCommunications: o.isCommunications === true,
            formFactor: str(o.formFactor), jackSubType: str(o.jackSubType), transport: str(o.transport),
            dataSource: str(o.dataSource), port: str(o.port),
        });
        if (out.length >= 64) break;
    }
    return out;
}

export async function probeOutputKind(speakerDeviceId: string): Promise<OutputKindResult> {
    try {
        const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
        const [devices, rawFacts] = await Promise.all([
            md?.enumerateDevices?.().catch(() => [] as MediaDeviceInfo[]) ?? Promise.resolve([] as MediaDeviceInfo[]),
            (window.electronAPI?.getAudioOutputFacts?.() ?? Promise.resolve([])).catch(() => []),
        ]);
        return resolveOutputKind({
            speakerDeviceId,
            outputs: devices.filter(d => d.kind === 'audiooutput'),
            facts: sanitizeFacts(rawFacts),
        });
    } catch {
        return UNKNOWN;
    }
}

/**
 * The output type for `speakerDeviceId`, kept current. Starts 'unknown' (which
 * the auto default treats as speakers) until the first probe lands.
 * Re-probed on `devicechange` (debounced: a headset plug fires several) and on
 * window focus (some drivers flip the jack endpoint without a devicechange).
 */
export function useOutputKind(speakerDeviceId: string): OutputKindResult {
    const [result, setResult] = useState<OutputKindResult>(UNKNOWN);
    const lastLogged = useRef('');

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const run = () => {
            void probeOutputKind(speakerDeviceId).then(r => {
                if (cancelled) return;
                setResult(prev => (prev.kind === r.kind && prev.source === r.source ? prev : r));
                const key = `${r.kind}/${r.source}`;
                if (key !== lastLogged.current) {
                    lastLogged.current = key;
                    logCallEvent('output_kind', { type: r.kind, via: r.source });
                }
            });
        };
        const schedule = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(run, 400);
        };
        run();
        const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
        md?.addEventListener?.('devicechange', schedule);
        window.addEventListener('focus', schedule);
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            md?.removeEventListener?.('devicechange', schedule);
            window.removeEventListener('focus', schedule);
        };
    }, [speakerDeviceId]);

    return result;
}
