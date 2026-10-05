/**
 * FirstWeekNudges — the card for the first-week, in-app-only nudges and the
 * "want a ping?" permission ask. Mounted once by Dashboard.
 *
 * It renders nothing almost all of the time. When the engine
 * (hooks/useFirstWeekNudges.ts) decides there is something real and useful to
 * say, one small card slides in at the top-right, in the same visual language
 * as the toasts: deep surface, accent stripe, short copy, a clear primary
 * action, and two ways out ("Not now" and "Don't show these").
 *
 * Accessibility: the card is a polite live region (announced when it appears,
 * never steals focus), every control is a real button in the normal tab order,
 * and motion is the shared `fade-rise-enter` class, which the stylesheet turns
 * off under prefers-reduced-motion.
 */
import React, { useCallback, useMemo } from 'react';
import axios from 'axios';
import { Bell, Compass, Headphones, MessageSquare, UserCheck, UserPlus, X } from 'lucide-react';
import { ClButton } from './cl';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { API_BASE } from '../constants';
import { writeToClipboard } from '../utils/clipboard';
import { nudgeCopy, OFFICIAL_SERVER_INVITE_CODE, type FriendsInVoiceInput, type Nudge } from '../utils/firstWeekNudges';
import { nudges } from '../utils/firstWeekNudgeStore';
import { notificationAskCopy } from '../utils/notificationAsk';
import { useFirstWeekNudges, type ActiveCard, type NudgeEngineInput } from '../hooks/useFirstWeekNudges';

interface Props extends Omit<NudgeEngineInput, 'userId' | 'accountCreatedAt' | 'voice'> {
    /** Raw voice state; reduced to "friends are in X" by the engine. */
    voice: Omit<FriendsInVoiceInput, 'myUserId'>;
    /** Open a DM with this person (a friend who just arrived). */
    onOpenDm: (userId: string | undefined, username: string) => void;
    /** Go to a voice / Calls channel (never joins it — that stays the user's click). */
    onOpenChannel: (channelId: string) => void;
    /** Show the existing "join this server?" prompt for an invite code. */
    onPreviewInvite: (code: string) => void;
    /** Open (creating if needed) your own "message yourself" chat. */
    onMessageYourself: () => void;
}

function iconFor(card: ActiveCard): React.ReactNode {
    if (card.type === 'ask') return <Bell size={17} />;
    switch (card.nudge.kind) {
        case 'friend_joined': return <UserCheck size={17} />;
        case 'friends_in_voice': return <Headphones size={17} />;
        case 'no_friends': return <UserPlus size={17} />;
        case 'no_server': return <Compass size={17} />;
        case 'self_message': return <MessageSquare size={17} />;
    }
}

export const FirstWeekNudges: React.FC<Props> = ({
    onOpenDm, onOpenChannel, onPreviewInvite, onMessageYourself, voice, ...rest
}) => {
    const { user, token } = useAuth();
    const toast = useToast();

    /** Copy your referral link — the same fetch the checklist and Subscription
     *  pane use. Copying a link to share counts as "sent an invite", which is
     *  the moment to offer a ping (nudges.notify → the notification ask). */
    const copyInviteLink = useCallback(async () => {
        if (!token) return;
        try {
            const r = await axios.get<{ referral_code: string | null }>(`${API_BASE}/billing/referral`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const code = r.data?.referral_code;
            if (!code) throw new Error('no referral code');
            await writeToClipboard(`https://cipherline.chat/ref/${code}`);
            toast.push({ kind: 'success', title: 'Invite link copied', message: 'Send it to a friend. They’ll land right here with you.' });
            nudges.notify({ kind: 'invite_sent' });
        } catch {
            toast.push({ kind: 'error', message: 'Couldn’t get your invite link. You can copy it from Settings → Subscription.' });
        }
    }, [token, toast]);

    const actions = useMemo(() => ({
        run: (n: Nudge) => {
            switch (n.kind) {
                case 'friend_joined': onOpenDm(n.userId, n.username); break;
                case 'friends_in_voice': onOpenChannel(n.voice.channelId); break;
                case 'no_friends': void copyInviteLink(); break;
                case 'no_server': onPreviewInvite(OFFICIAL_SERVER_INVITE_CODE); break;
                case 'self_message': onMessageYourself(); break;
            }
        },
        onTurnedOff: () => toast.push({
            kind: 'info',
            message: 'Okay, no more tips. You can bring them back in Settings → Notifications.',
        }),
    }), [onOpenDm, onOpenChannel, onPreviewInvite, onMessageYourself, copyInviteLink, toast]);

    const engine = useFirstWeekNudges(
        { ...rest, voice, userId: user?.user_id ?? null, accountCreatedAt: user?.created_at ?? null },
        actions,
    );
    const { card } = engine;
    if (!card) return null;

    const copy = card.type === 'ask'
        ? (() => { const c = notificationAskCopy(card.variant, card.trigger); return { title: c.title, body: c.body, action: c.accept, decline: c.decline }; })()
        : (() => { const c = nudgeCopy(card.nudge); return { ...c, decline: 'Not now' }; })();

    return (
        <div className="fixed top-14 right-4 z-[9500] w-[340px] max-w-[calc(100vw-2rem)] pointer-events-none">
            <div
                key={card.id}
                role="status"
                aria-live="polite"
                aria-label={copy.title}
                className="pointer-events-auto relative flex items-start gap-3 pl-4 pr-2 py-3 bg-cl-deep border border-white/[0.08] ring-1 ring-cl-lume/30 rounded-xl shadow-2xl overflow-hidden fade-rise-enter"
            >
                <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-cl-lume" aria-hidden="true" />
                <span className="shrink-0 mt-0.5 w-8 h-8 rounded-lg grid place-items-center text-cl-lume bg-cl-lume/10" aria-hidden="true">
                    {iconFor(card)}
                </span>
                <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-white leading-tight m-0">{copy.title}</p>
                    <p className="text-[12px] text-cl-muted leading-snug m-0 mt-0.5 break-words">{copy.body}</p>
                    <div className="flex items-center gap-2 mt-2.5">
                        <ClButton size="sm" variant="primary" onClick={engine.accept}>{copy.action}</ClButton>
                        <ClButton size="sm" variant="ghost" onClick={engine.dismiss}>{copy.decline}</ClButton>
                    </div>
                    {card.type === 'nudge' && (
                        <button
                            type="button"
                            onClick={engine.turnOff}
                            className="mt-2 p-0 bg-transparent border-0 text-[11px] text-cl-faint hover:text-cl-muted underline-offset-2 hover:underline cursor-pointer"
                        >
                            Don’t show these
                        </button>
                    )}
                </div>
                <ClButton icon size="sm" variant="ghost" onClick={engine.dismiss} tooltip="Dismiss">
                    <X size={14} />
                </ClButton>
            </div>
        </div>
    );
};

export default FirstWeekNudges;
