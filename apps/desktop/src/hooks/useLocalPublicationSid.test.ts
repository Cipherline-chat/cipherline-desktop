import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ParticipantEvent, Track } from 'livekit-client';
import { watchLocalPublicationSid, type PublicationSidSource } from './useLocalPublicationSid';

/** A local participant whose publications change the way swapShareCodec changes them. */
function fakeParticipant() {
    const pubs: Array<{ source: Track.Source; trackSid: string }> = [];
    const handlers = new Map<string, Set<() => void>>();
    const emit = (ev: ParticipantEvent) => handlers.get(ev)?.forEach(fn => fn());
    const p: PublicationSidSource & {
        publish(source: Track.Source, sid: string): void;
        unpublish(sid: string): void;
        listeners(): number;
    } = {
        getTrackPublication: (source) => pubs.find(x => x.source === source),
        on: (ev, fn) => { (handlers.get(ev) ?? handlers.set(ev, new Set()).get(ev)!).add(fn); },
        off: (ev, fn) => { handlers.get(ev)?.delete(fn); },
        publish(source, sid) { pubs.push({ source, trackSid: sid }); emit(ParticipantEvent.LocalTrackPublished); },
        unpublish(sid) { pubs.splice(pubs.findIndex(x => x.trackSid === sid), 1); emit(ParticipantEvent.LocalTrackUnpublished); },
        listeners: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
    };
    return p;
}

describe('watchLocalPublicationSid — follows our own republish (report dfda9c13)', () => {
    it('make-before-break codec switch: old sid while both exist, the NEW sid once the old is unpublished', () => {
        const p = fakeParticipant();
        p.publish(Track.Source.ScreenShare, 'TR_old');
        const seen: Array<string | null> = [];
        const off = watchLocalPublicationSid(p, Track.Source.ScreenShare, sid => seen.push(sid));
        p.publish(Track.Source.ScreenShare, 'TR_new'); // H.265 publication added
        p.unpublish('TR_old');                         // then the H.264 one removed
        expect(seen).toEqual(['TR_old', 'TR_old', 'TR_new']);
        p.unpublish('TR_new');
        expect(seen.at(-1)).toBeNull();
        off();
        expect(p.listeners()).toBe(0);
    });

    it('ignores other sources\' publications (negative control)', () => {
        const p = fakeParticipant();
        const seen: Array<string | null> = [];
        watchLocalPublicationSid(p, Track.Source.ScreenShare, sid => seen.push(sid));
        p.publish(Track.Source.Camera, 'TR_cam');
        expect(new Set(seen)).toEqual(new Set([null]));
    });

    it('SidebarConference keys its screen-share effects on the event-driven sid, not a render-time read', () => {
        const src = readFileSync(join(__dirname, '..', 'components', 'SidebarConference.tsx'), 'utf8');
        expect(src).toContain('const ssTrackSid = useLocalPublicationSid(localParticipant, Track.Source.ScreenShare);');
        expect(src).not.toMatch(/const ssTrackSid = localParticipant\s*\?\.getTrackPublication/);
    });
});
