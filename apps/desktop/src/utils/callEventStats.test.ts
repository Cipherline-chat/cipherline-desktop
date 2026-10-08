import { describe, it, expect } from 'vitest';
import { iceRouteFromStats, layerStateString } from './callEventStats';

const report = (entries: Record<string, unknown>[]) => new Map(entries.map(e => [String(e.id), e]));

describe('iceRouteFromStats — candidate TYPES only, never addresses', () => {
    it('TURN relay over TLS', () => {
        const r = iceRouteFromStats(report([
            { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
            { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' },
            { id: 'L', type: 'local-candidate', candidateType: 'relay', relayProtocol: 'tls', protocol: 'udp', address: '203.0.113.5', port: 5349 },
            { id: 'R', type: 'remote-candidate', candidateType: 'host', address: '198.51.100.7' },
        ]));
        expect(r).toEqual({ local: 'relay', remote: 'host', relay: true, protocol: 'turn-tls' });
        expect(JSON.stringify(r)).not.toMatch(/203\.0|198\.51|5349/);
    });
    it('direct srflx/udp; falls back to the nominated succeeded pair without a transport entry', () => {
        expect(iceRouteFromStats(report([
            { id: 'P', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R' },
            { id: 'L', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' },
            { id: 'R', type: 'remote-candidate', candidateType: 'host' },
        ]))).toEqual({ local: 'srflx', remote: 'host', relay: false, protocol: 'udp' });
    });
    it('nothing selected yet → null', () => {
        expect(iceRouteFromStats(report([{ id: 'T', type: 'transport' }]))).toBeNull();
    });
});

describe('layerStateString', () => {
    it('simulcast on/off per rid; one layer → empty', () => {
        expect(layerStateString([{ rid: 'q', active: true }, { rid: 'h', active: false }, { rid: 'f' }])).toBe('q:on h:off f:on');
        expect(layerStateString([{}])).toBe('');
        expect(layerStateString(undefined)).toBe('');
    });
});
