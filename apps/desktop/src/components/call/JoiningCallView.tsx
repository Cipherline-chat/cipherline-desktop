import { MicOff, Headphones } from 'lucide-react';
import { EncryptedAvatar } from '../EncryptedAvatar';
import { ParticipantRowShell, ParticipantTileShell, LocalPingReadout } from './ParticipantCard';
import { tileMetrics } from './participantTileMetrics';
import type { JoinPeer } from '../../utils/joinView';

/**
 * The call, as it will look once connected — rendered before the LiveKit room
 * exists, for the calls whose in-call UI is SidebarConference (DM / group
 * calls, legacy voice channels). Huddle calls don't use this: their call view
 * is the huddle card list, which shows the joining user in place directly
 * (utils/joinView.ts → displayHuddleCalls).
 *
 * Owner ask: during the connecting stage, put me IN the call with everyone
 * else (or, for a new call, a call with just me), and keep the only
 * "connecting" indication in the bottom controls. So this renders:
 *   - the SAME DOM skeleton SidebarConference renders for an audio-only call
 *     (the class strings below are pinned against SidebarConference's by
 *     instantCallJoin.wiring.test.ts, so the two cannot drift apart);
 *   - the SAME row / tile components ParticipantCard renders through
 *     (ParticipantRowShell / ParticipantTileShell), with yourself first and
 *     everyone already in the call after you — SidebarConference's order;
 *   - for a call nobody else is in yet, the ringing tile it shows.
 * CallPane hands over to the real SidebarConference once the room is connected
 * and the mic is up, with entrance animations skipped, so nothing re-animates
 * or moves. No animation of its own: no mount/exit animation on anything in
 * the call panel (reparenting restarts them).
 */
export interface JoiningCallViewProps {
    /** 'rows' = voice-channel list (SidebarConference noRinging); 'tiles' = DM / group grid. */
    layout: 'rows' | 'tiles';
    token: string;
    self: { userId: string; name: string; avatarId: string | null; muted: boolean; deafened: boolean; roleColor?: string };
    /** Everyone already known to be in the call, in join order. */
    peers: JoinPeer[];
    /** DM / group only: who is being called, for the ringing tile shown while nobody else is in. */
    ringing?: { title: string; avatarId: string | null; userId: string | null; isGroup: boolean } | null;
}

export const JoiningCallView = ({ layout, token, self, peers, ringing }: JoiningCallViewProps) => {
    // What the real local entry shows at the handover: CallPane hands over only
    // once the mic has published (or the join was muted/deafened), so a
    // speaking join shows no mute badge; a muted one shows SidebarConference's
    // "mic off"; a deafened one its local-deafen glyph plus "mic off" (the
    // deafened metadata lands a moment after — see SidebarConference).
    const micOff = self.muted || self.deafened;
    const silenced = micOff;
    const rows = layout === 'rows';

    return (
        <div className="call-no-select w-full flex flex-col relative" data-call-joining-view={layout}>
            <div
                className={`overflow-x-hidden flex flex-col ${rows ? 'pt-0 pb-0 px-0 gap-0' : 'pt-3 pb-1 px-0 gap-3'}`}
                style={rows ? undefined : { scrollbarGutter: 'stable both-edges' }}
            >
                <div className="flex flex-col gap-3">
                    {!rows && <div style={{ height: 1, marginTop: -13, flexShrink: 0, pointerEvents: 'none', visibility: 'hidden' }} aria-hidden />}
                </div>

                {rows ? (
                    <div className="rounded-b-xl overflow-hidden bg-white/[0.04] border-x border-b border-white/[0.07]">
                        <div className="flex flex-col w-full">
                            <div className="w-full">
                                <ParticipantRowShell
                                    userId={self.userId}
                                    displayName={self.name}
                                    avatarId={self.avatarId}
                                    token={token}
                                    speaking={false}
                                    silenced={silenced}
                                    roleColor={self.roleColor}
                                    badges={<>
                                        <LocalPingReadout stats={null} />
                                        {micOff && <MicOff className="w-3.5 h-3.5 text-red-400" />}
                                        {self.deafened && <Headphones className="w-3.5 h-3.5 text-white/30" />}
                                    </>}
                                />
                            </div>
                            {peers.map(p => (
                                <div key={p.userId} className="w-full">
                                    <ParticipantRowShell
                                        userId={p.userId}
                                        displayName={p.name}
                                        avatarId={p.avatarId}
                                        token={token}
                                        speaking={false}
                                        silenced={false}
                                        roleColor={p.roleColor}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 flex flex-row flex-wrap justify-center items-center content-center gap-x-8 gap-y-6">
                        <div>
                            <ParticipantTileShell
                                userId={self.userId}
                                displayName={self.name}
                                avatarId={self.avatarId}
                                token={token}
                                sizeMode="normal"
                                compact={false}
                                speaking={false}
                                dimmed={silenced}
                                badges={micOff ? <MuteBadge /> : null}
                            />
                        </div>
                        {peers.map(p => (
                            <div key={p.userId}>
                                <ParticipantTileShell
                                    userId={p.userId}
                                    displayName={p.name}
                                    avatarId={p.avatarId}
                                    token={token}
                                    sizeMode="normal"
                                    compact={false}
                                    speaking={false}
                                    dimmed={false}
                                />
                            </div>
                        ))}
                        {peers.length === 0 && ringing && (
                            <div>
                                <RingingTile {...ringing} token={token} />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

/** The red mic-off badge ParticipantCard stacks on a muted tile. */
const MuteBadge = () => {
    const { badgeSize, badgeIconSize } = tileMetrics('normal', false);
    return (
        <div className={`bg-red-500 rounded-full ${badgeSize} border-[2px] border-[#0B0F1E] shadow-md z-[3] -ml-2`}>
            <MicOff className={`${badgeIconSize} text-white`} />
        </div>
    );
};

/**
 * SidebarConference's DummyRingingTile (non-compact), as markup. Its rings are
 * a continuous `ping` loop (0% and 100% identical), so a restart at the
 * handover is not a visible jump.
 */
export const RingingTile = ({ title, avatarId, userId, isGroup, token }: { title: string; avatarId: string | null; userId: string | null; isGroup: boolean; token: string }) => (
    <div className="flex flex-col items-center gap-2 relative">
        <div className="relative isolate">
            <div className="w-24 h-24 relative z-10 rounded-full overflow-hidden flex items-center justify-center transition-all p-0 border-none ring-1 ring-white/10">
                <EncryptedAvatar
                    attachmentId={avatarId ?? null}
                    userId={userId ?? null}
                    isGroup={isGroup && !userId}
                    token={token}
                    className="w-full h-full object-cover"
                    fallbackSize={32}
                    bypassFriendGate
                />
            </div>
            <div className="absolute inset-0 z-0 bg-cl-lume/20 rounded-full animate-ping pointer-events-none" style={{ animationDuration: '2s' }}></div>
            <div className="absolute inset-[-10px] z-[0] border border-cl-lume/20 rounded-full animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] pointer-events-none" style={{ animationDelay: '0.5s' }}></div>
        </div>
        <span className={`flex items-center gap-1.5 text-[10px] font-semibold text-cl-muted px-2 py-0.5 rounded-full bg-white/5 truncate max-w-[150px]`}>
            <span className="truncate max-w-[100px]">{title || 'User'}</span>
            <span className="text-cl-lume tracking-widest uppercase animate-pulse" style={{ fontSize: '9px' }}>Calling...</span>
        </span>
    </div>
);
