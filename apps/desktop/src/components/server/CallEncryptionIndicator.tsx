import { Lock, ShieldAlert, Loader2 } from 'lucide-react';
import { ClButton } from '../ClButton';

/**
 * The in-call encryption status indicator — replaced the old full-width
 * `CallsChannelKeyNotice` banner (2026-09-08, per owner feedback: "I am not
 * a fan of the big banner ... after you join a little green padlock shows
 * up ... and when it's loading you have a little loading symbol"). Same
 * underlying security story, five presentations:
 *
 *   'mixed'     — the one mode NOT about this device's own key. Someone else
 *                 in the call is on a build older than 1.0.13, which cannot
 *                 encrypt call media, so THEIR audio and video reach the media
 *                 server in the clear while ours stay encrypted (livekit-client
 *                 enables decryption per remote participant — see
 *                 utils/remoteE2EEWatch.ts). Red, no padlock of any colour, and
 *                 it names the people rather than counting them: at this size a
 *                 tinted lock still reads as "encrypted", and "someone" is not
 *                 something a user can act on. Outranks 'degraded' where both
 *                 could apply — see SidebarConference.
 *
 *   'loading'   — a server Calls-channel call is waiting on its room key.
 *                 CallPane is NOT mounted yet (see the mount gate in
 *                 Dashboard.tsx), so this is rendered standalone in the call
 *                 section and carries its own compact leave affordance —
 *                 there is otherwise no way out of a call whose join already
 *                 succeeded server-side. Small, neutral, no alarm: this is
 *                 normal and usually resolves in well under a second.
 *   'stalled'   — same pre-mount situation, but past CALL_KEY_STALL_MS, so
 *                 "any moment now" would be a lie. Still no bypass offered —
 *                 there is no plaintext fallback and there must never be one
 *                 (callsChannelKeyWiring.test.ts asserts no such wording ever
 *                 appears in this file). Kept as a small card rather than a
 *                 bare pill specifically so the explanation AND the leave
 *                 button stay visible without a hover/click to reveal them —
 *                 this is the state where someone is stuck in a call for
 *                 everyone else with no idea why, so it stays the most
 *                 noticeable of the four.
 *   'connected' — CallPane IS mounted and this device holds a real key for
 *                 the room. STILL SUPPORTED HERE but no longer rendered by
 *                 SidebarConference (2026-09-08 round 2, per owner feedback:
 *                 the padlock they meant was the Huddle channel-row summary,
 *                 not this bottom pill — a live call now shows it there
 *                 instead, sourced from this exact same gate, via
 *                 HuddleButton's `encryptionState` — see HuddleButton.tsx
 *                 and Dashboard.tsx's `myCallEncryptionState`). Steady-state
 *                 "Encrypted" needs no action and no explanation, so showing
 *                 it in two places was a duplicate, not two facts.
 *   'degraded'  — also rendered inside SidebarConference, only reachable for
 *                 a Calls-channel call: the call IS connected and encrypted
 *                 under the key it joined with, but this device can no
 *                 longer read the channel's current key, so it can't follow
 *                 a key change. Amber, not green — still "Encrypted", never
 *                 downgraded to implying the live call itself is at risk.
 *                 Kept here (unlike 'connected') because it DOES require
 *                 explanation — the channel-row padlock has no room for the
 *                 amber nuance, and losing that signal would read as "the
 *                 call is now unencrypted" instead of "still fine, this
 *                 device just can't confirm the key stayed current."
 *
 * Presentational only — composed from existing primitives and design tokens,
 * with no edits under components/cl (which would drag in the website build).
 */

export type CallEncryptionIndicatorMode = 'loading' | 'stalled' | 'connected' | 'degraded' | 'mixed';

interface CallEncryptionIndicatorProps {
    mode: CallEncryptionIndicatorMode;
    /** For 'mixed': display names of the participants publishing in the clear.
     *  Names, not identities — this is read by a human deciding whether to keep
     *  talking, and a raw user id tells them nothing. Falls back to a count if
     *  empty. Unused by every other mode. */
    unencryptedNames?: string[];
    /** The Calls channel's display name, for the 'loading'/'stalled' copy that
     *  names what it's waiting on. Unused for 'connected'/'degraded'. */
    channelName?: string;
    /** Must actually leave the call server-side — the participant row and the
     *  join broadcast have to be undone, not just the local UI. Required for
     *  'loading' and 'stalled' (the only modes rendered while CallPane is not
     *  mounted); unused for 'connected'/'degraded'. */
    onLeave?: () => void;
}

export const CallEncryptionIndicator = ({ mode, channelName, onLeave, unencryptedNames }: CallEncryptionIndicatorProps) => {
    if (mode === 'mixed') {
        // Deliberately NOT a padlock of any colour. 'degraded' is amber and
        // still says "Encrypted" because the call genuinely is; this state is
        // the one where part of the call genuinely is not, so reusing that
        // treatment would under-sell it. It names people rather than counting
        // them — "someone" is not actionable, "Sam" is.
        const names = unencryptedNames?.filter(Boolean) ?? [];
        const who = names.length === 0
            ? 'Someone in this call is'
            : names.length === 1
                ? `${names[0]} is`
                : names.length === 2
                    ? `${names[0]} and ${names[1]} are`
                    : `${names.slice(0, 2).join(', ')} and ${names.length - 2} other${names.length - 2 === 1 ? '' : 's'} are`;
        return (
            <div
                className="mx-auto mb-1 w-fit max-w-full flex items-start gap-1.5 px-2 py-1 rounded-md text-[10.5px] font-semibold"
                style={{ color: 'rgb(252,165,165)', background: 'rgba(248,113,113,.10)' }}
                role="status"
                aria-live="polite"
                title={`${who} on an older version of Cipherline that cannot encrypt call media. Their audio and video reach our server unencrypted; yours stay encrypted. Ask them to update to 1.0.13 or later.`}
            >
                <ShieldAlert className="w-3 h-3 shrink-0 mt-[1px]" />
                <span className="min-w-0">{who} not encrypted — on an older version</span>
            </div>
        );
    }

    if (mode === 'connected' || mode === 'degraded') {
        const degraded = mode === 'degraded';
        return (
            <div
                className="mx-auto mb-1 w-fit flex items-center gap-1.5 px-2 py-1 rounded-md text-[10.5px] font-semibold select-none"
                style={{
                    color: degraded ? 'rgb(252,211,77)' : 'var(--cl-lume)',
                    background: degraded ? 'rgba(255,201,77,.10)' : 'rgba(120,255,214,.08)',
                }}
                title={degraded
                    ? "This device can no longer read this channel's key changes. The call stays encrypted under the key it joined with — if this doesn't clear on its own, leave and rejoin."
                    : 'End-to-end encrypted — the server never sees this call’s audio or video.'}
            >
                {degraded
                    ? <ShieldAlert className="w-3 h-3 shrink-0" />
                    : <Lock className="w-3 h-3 shrink-0" />}
                <span>Encrypted</span>
            </div>
        );
    }

    const name = channelName?.trim() || 'this channel';
    const stalled = mode === 'stalled';

    if (!stalled) {
        // 'loading' — compact single row: spinner, brief wording, small leave
        // affordance. No card, no explanatory paragraphs — this is expected
        // to clear in well under a second and a lengthy explanation for a
        // sub-second wait would itself read as something being wrong.
        return (
            <div className="shrink-0 px-2 pt-2 pb-1">
                <div
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-cl-raise border"
                    style={{ borderColor: 'rgba(255,255,255,.08)' }}
                    role="status"
                    aria-live="polite"
                >
                    <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" style={{ color: 'var(--cl-lume)' }} />
                    <span className="text-[11.5px] text-white/70">
                        {channelName ? 'Setting up encryption…' : 'Securing call…'}
                    </span>
                    {onLeave && (
                        <ClButton
                            variant="ghost"
                            size="sm"
                            onClick={onLeave}
                            className="ml-auto"
                        >
                            Leave
                        </ClButton>
                    )}
                </div>
            </div>
        );
    }

    // 'stalled' — the escape-hatch state. CallPane is still not mounted (no
    // disconnect button lives anywhere else), the join already succeeded
    // server-side, and there's no telling how much longer this will take —
    // so this stays a small card with the explanation AND the leave button
    // both visible without further interaction, not just a pill.
    return (
        <div className="shrink-0 px-2 pt-2 pb-1">
            <div
                className="rounded-xl border p-2.5 bg-cl-raise"
                style={{ borderColor: 'rgba(255,201,77,.28)' }}
                role="status"
                aria-live="polite"
            >
                <div className="flex items-center gap-2 mb-1">
                    <ShieldAlert className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--cl-glow)' }} />
                    <span className="text-[12px] font-semibold text-cl-text">Still waiting for encryption keys</span>
                </div>
                {/* Two different waits, two different explanations. A Calls
                    channel is waiting on a member to deliver the CHANNEL key;
                    a DM or group call is waiting on the `call_key` the person
                    who started it sends to each of your devices. Telling a DM
                    caller that "no other device in has delivered the channel
                    key" would be both wrong and unactionable — there is no
                    channel, and the fix is to redial, not to wait for a
                    member to come online. `channelName` is absent exactly for
                    the DM/group case, which is what distinguishes them. */}
                <p className="text-[11px] leading-relaxed text-white/60">
                    {channelName
                        ? <>No other device in {name} has delivered the channel key yet, and there is no way
                            to join without it — an unencrypted call is not offered. Leave and try again
                            once another member is online.</>
                        : <>The key for this call hasn't reached this device yet, and there is no way to
                            join without it — an unencrypted call is not offered. Leave and call again;
                            if it keeps happening, the other device may be offline.</>}
                </p>
                <div className="mt-2">
                    <ClButton variant="danger" size="sm" fullWidth onClick={onLeave}>
                        Leave call
                    </ClButton>
                </div>
            </div>
        </div>
    );
};
