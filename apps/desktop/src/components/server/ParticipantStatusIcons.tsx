import React from 'react';
import { Video, Monitor, MicOff, VideoOff, MonitorOff, HeadphoneOff, Headphones } from 'lucide-react';
import type { ParticipantMeta } from '../../utils/participantMetadata';
import { resolveParticipantAudio, resolveParticipantMedia, resolveServerModeration, useCallMedia } from '../../utils/callMediaPresence';
import { useVoiceModerationTitles } from '../../utils/serverVoiceModeration';

/**
 * The status badges at the end of a call-participant row in the server
 * sidebar (Calls-channel calls and voice channels) — ONE implementation for
 * both lists and for both "I'm in this call" and "I'm not".
 *
 * Camera / screen share come from `resolveParticipantMedia`, and SELF mute /
 * deafen from `resolveParticipantAudio`:
 *   - viewer IS in this call → live LiveKit state (`track`, `meta.deafened`);
 *   - viewer is NOT          → server presence for `mediaKey`
 *     (utils/callMediaPresence — seeded + live via `call:media_state`; each
 *     participant's own client reports its mic/deafen toggles, push-to-talk
 *     key presses excluded).
 * Server mute / server deafen (a moderator's 24 h restriction) follow the same
 * rule via `resolveServerModeration`: the LiveKit metadata in a call, the
 * server's own presence overlay outside one - so the red badge is there the
 * moment someone (re)joins, even when you are not in the call. Camera / share
 * disables and the viewer's own local-mute are still in-call-only (`meta`,
 * `localMuted`). Mute and deafen are independent: a deafened person who is also
 * muted shows both.
 *
 * Renders nothing when there is nothing to show.
 */
export const ParticipantStatusIcons: React.FC<{
    userId: string;
    /** True when the VIEWER is connected to this participant's call. */
    inThisCall: boolean;
    /** Presence key for this call (huddleCallMediaKey / voiceChannelMediaKey). */
    mediaKey: string | null;
    track?: { hasCamera: boolean; hasScreenShare: boolean; isMuted?: boolean };
    meta?: ParticipantMeta;
    localMuted?: boolean;
    videoHidden?: boolean;
    screenHidden?: boolean;
    /** Tailwind size classes for every icon, e.g. "w-3.5 h-3.5". */
    iconClass: string;
    /** This call's server, for the moderator's "23 h left" tooltip. Optional:
     *  without it the tooltip is just "Server muted". */
    serverId?: string | null;
}> = ({ userId, inThisCall, mediaKey, track, meta, localMuted = false, videoHidden = false, screenHidden = false, iconClass, serverId }) => {
    // Unconditional hook; a null key (in-call) subscribes to nothing.
    const presence = useCallMedia(inThisCall ? null : mediaKey, userId);
    const { hasCamera, hasScreenShare } = resolveParticipantMedia(inThisCall, track, presence);
    const ts = inThisCall ? track : undefined;
    const pmeta = inThisCall ? meta : undefined;
    // Self mute / deafen: live in-call, presence otherwise (same icons either way).
    const { muted: selfMuted, deafened: selfDeafened } = resolveParticipantAudio(inThisCall, ts, pmeta, presence);
    const { serverMuted, serverDeafened } = resolveServerModeration(inThisCall, pmeta, presence);
    const titles = useVoiceModerationTitles(serverId, userId);
    const isLocalMutedByMe = inThisCall && localMuted;
    const ic = (cls: string) => `${iconClass} ${cls}`;

    const icons: React.ReactNode[] = [];
    // Server-moderation badges — red, highest visual priority. The wrapper's
    // title is "Server muted" (+ " · 23 h left" for a moderator, who has the expiry).
    if (serverMuted) icons.push(<span key="sma" title={titles.muted} className="inline-flex"><MicOff className={ic('text-red-500')} /></span>);
    if (serverDeafened) icons.push(<span key="sd" title={titles.deafened} className="inline-flex"><HeadphoneOff className={ic('text-red-500')} /></span>);
    if (pmeta?.serverMutedVideo) icons.push(<VideoOff key="smv" className={ic('text-red-500')} />);
    if (pmeta?.serverMutedScreenShare) icons.push(<MonitorOff key="sms" className={ic('text-red-500')} />);
    // Self-deafen — participant toggled deafen themselves. (Independent of a
    // moderator's server deafen: both can show.)
    if (selfDeafened) icons.push(<Headphones key="d" className={ic('text-red-400')} />);
    // Self-mute — participant muted their own mic. A server mute's red badge
    // already says the mic is off, so it is not doubled; a server DEAFEN says
    // nothing about the mic, so it does not hide this.
    if (selfMuted && !serverMuted && !selfDeafened) {
        icons.push(<MicOff key="m" className={ic('text-red-400')} />);
    }
    // Client-side local mute — only visible to the viewer; gray.
    if (!selfMuted && !selfDeafened && isLocalMutedByMe) {
        icons.push(<MicOff key="lm" className={ic('text-cl-faint')} />);
    }
    // Screen share — gray MonitorOff when the viewer has hidden it.
    if (hasScreenShare && !pmeta?.serverMutedScreenShare) {
        icons.push(inThisCall && screenHidden
            ? <MonitorOff key="ss" className={ic('text-cl-faint')} />
            : <Monitor key="ss" className={ic('text-cl-muted')} aria-label="Sharing screen" />);
    }
    // Camera — gray VideoOff when the viewer has hidden it.
    if (hasCamera && !pmeta?.serverMutedVideo) {
        icons.push(inThisCall && videoHidden
            ? <VideoOff key="cam" className={ic('text-cl-faint')} />
            : <Video key="cam" className={ic('text-cl-muted')} aria-label="Camera on" />);
    }
    if (icons.length === 0) return null;
    return <div className="flex items-center gap-1 shrink-0" data-testid="participant-status-icons">{icons}</div>;
};

export default ParticipantStatusIcons;
