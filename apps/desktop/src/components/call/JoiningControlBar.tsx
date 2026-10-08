import React from 'react';
import { Mic, MicOff, Headphones, HeadphoneOff, PhoneCall, Loader2 } from 'lucide-react';
import type { CallJoinPhase } from '../../utils/callJoinFlow';
import { joinPhaseLabel } from '../../utils/callJoinFlow';

/**
 * The call controls while a join is still in flight (see utils/callJoinFlow.ts).
 *
 * Same capsule as the real ControlBar (.cl-console / .cl-ctrlbtn, so it sits
 * in exactly the same place at exactly the same size), with:
 *   - mic + deafen live — pressing them records the user's INTENT, which is
 *     applied the moment the room connects (a pre-muted join never publishes
 *     the mic at all — see CallPane's `audio` prop);
 *   - the three video slots replaced by one status segment with a spinner and
 *     "Joining… / Securing… / Connecting…";
 *   - Leave, which works in every phase: it cancels a join whose request is
 *     still in flight, or tears down a call that is mounted but not yet up.
 * When the room reports Connected, Dashboard stops rendering this in the same
 * commit SidebarConference mounts the real ControlBar into #call-controlbar-root.
 *
 * Deliberately no mount/exit animation: the real bar has none either (see the
 * note above .cl-share-live in index.css), and a fade here would read as the
 * controls arriving late — the opposite of the point.
 */
export interface JoiningControlBarProps {
    phase: CallJoinPhase;
    muted: boolean;
    deafened: boolean;
    /** False when the join's token carries no microphone grant (listen-only). */
    canSpeak: boolean;
    onToggleMute: () => void;
    onToggleDeafen: () => void;
    onLeave: () => void;
}

const offTone: React.CSSProperties = { background: 'rgba(255,107,94,0.16)', color: 'var(--cl-flash)' };
const neutralTone: React.CSSProperties = { background: 'transparent', color: 'rgba(255,255,255,0.92)' };
const disabledTone: React.CSSProperties = { background: 'rgba(255,255,255,0.035)', color: 'rgba(255,255,255,0.28)', boxShadow: 'none' };

export const JoiningControlBar = ({ phase, muted, deafened, canSpeak, onToggleMute, onToggleDeafen, onLeave }: JoiningControlBarProps) => {
    const micOff = muted || deafened || !canSpeak;
    const label = joinPhaseLabel(phase);
    return (
        <div className="shrink-0 w-full bg-transparent px-1 pt-1.5 pb-2 select-none" data-call-joining={phase}>
            <div className="cl-console">
                <div className="cl-console-inner">
                    <button
                        type="button"
                        className="cl-ctrlbtn"
                        data-tone={micOff ? 'off' : 'neutral'}
                        disabled={!canSpeak}
                        aria-pressed={micOff}
                        aria-label={!canSpeak ? "You don't have permission to speak here" : micOff ? 'Unmute' : 'Mute'}
                        title={!canSpeak ? "You don't have permission to speak here" : micOff ? 'Unmute' : 'Mute'}
                        onClick={onToggleMute}
                        style={!canSpeak ? disabledTone : micOff ? offTone : neutralTone}
                    >
                        <span className="cl-ico cl-ico--tog" data-off={micOff}>
                            <Mic className="w-4 h-4 ico-on" />
                            <MicOff className="w-4 h-4 ico-off" />
                        </span>
                    </button>

                    <button
                        type="button"
                        className="cl-ctrlbtn"
                        data-tone={deafened ? 'off' : 'neutral'}
                        aria-pressed={deafened}
                        aria-label={deafened ? 'Undeafen' : 'Deafen'}
                        title={deafened ? 'Undeafen' : 'Deafen'}
                        onClick={onToggleDeafen}
                        style={deafened ? offTone : neutralTone}
                    >
                        <span className="cl-ico cl-ico--tog" data-off={deafened}>
                            <Headphones className="w-4 h-4 ico-on" />
                            <HeadphoneOff className="w-4 h-4 ico-off" />
                        </span>
                    </button>

                    <span className="cl-console-sep" aria-hidden="true" />

                    {/* Holds the width of camera + share + fullscreen so nothing
                        shifts when the real controls take over. */}
                    <div className="cl-join-status" role="status" aria-live="polite">
                        <Loader2 className="cl-join-spinner motion-safe:animate-spin" aria-hidden="true" />
                        <span className="cl-join-label">{label}</span>
                    </div>

                    <span className="cl-console-sep cl-console-sep--leave" aria-hidden="true" />

                    <button
                        type="button"
                        className="cl-ctrlbtn cl-ctrlbtn--wide"
                        data-tone="danger"
                        onClick={onLeave}
                        title="Leave Call"
                        aria-label="Leave call"
                        style={{ background: 'var(--cl-flash)', color: '#fff' }}
                    >
                        <span className="cl-ico"><PhoneCall className="w-4 h-4 rotate-[135deg]" /></span>
                        <span className="cl-ctrl-label">Leave</span>
                    </button>
                </div>
            </div>
        </div>
    );
};
