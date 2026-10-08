/**
 * Pure readers for CallEventMonitor (components/call): what the call log
 * records from WebRTC stats — candidate TYPES and layer on/off, never
 * addresses, ports or identities.
 */
export type StatsLike = { forEach(cb: (s: Record<string, unknown>) => void): void; get?(id: string): Record<string, unknown> | undefined };

/** The selected candidate pair's types, from a peer connection's stats. Pure. */
export function iceRouteFromStats(report: StatsLike): { local: string; remote: string; relay: boolean; protocol: string } | null {
    const byId = new Map<string, Record<string, unknown>>();
    let selected: string | undefined;
    report.forEach(s => {
        if (typeof s.id === 'string') byId.set(s.id, s);
        if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') selected = s.selectedCandidatePairId;
    });
    let pair = selected ? byId.get(selected) : undefined;
    if (!pair) for (const s of byId.values()) if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') { pair = s; break; }
    if (!pair) return null;
    const l = byId.get(String(pair.localCandidateId));
    const r = byId.get(String(pair.remoteCandidateId));
    if (!l || !r) return null;
    const type = (c: Record<string, unknown>) => (typeof c.candidateType === 'string' ? c.candidateType : 'unknown');
    const relay = type(l) === 'relay' || type(r) === 'relay';
    const protocol = relay && typeof l.relayProtocol === 'string' ? `turn-${l.relayProtocol}` : (typeof l.protocol === 'string' ? l.protocol : 'unknown');
    return { local: type(l), remote: type(r), relay, protocol };
}

/** "q:on h:off f:on" from a sender's encodings (simulcast) — '' for one layer. */
export function layerStateString(encodings: readonly RTCRtpEncodingParameters[] | undefined): string {
    if (!encodings || encodings.length < 2) return '';
    return encodings.map((e, i) => `${e.rid ?? i}:${e.active === false ? 'off' : 'on'}`).join(' ');
}

