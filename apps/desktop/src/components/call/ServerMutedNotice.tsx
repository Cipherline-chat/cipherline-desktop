import { ShieldAlert } from 'lucide-react';
import { serverMutedMicView } from '../../utils/serverMuteGate';

/**
 * Standing "Server muted by a moderator" line above the call controls, for as
 * long as a moderator's server mute holds. Not a toast (server mute changes are
 * silent events): a state the user can always see, saying what happens when it
 * is lifted - which is also the feedback for pressing Mute while server-muted,
 * since that only changes the user's own choice (utils/serverMuteGate.ts).
 */
export const ServerMutedNotice = ({ selfMuted }: { selfMuted: boolean }) => {
    const view = serverMutedMicView(selfMuted);
    return (
        <div
            className="mx-auto mb-1 w-fit max-w-full flex items-start gap-1.5 px-2 py-1 rounded-md text-[10.5px] font-semibold"
            style={{ color: 'var(--cl-flash-text)', background: 'rgb(var(--cl-flash-rgb) / 0.12)' }}
            role="status"
            aria-live="polite"
            data-testid="server-muted-notice"
        >
            <ShieldAlert className="w-3 h-3 shrink-0 mt-[1px]" aria-hidden="true" />
            <span className="min-w-0">
                {view.notice}
                <span className="font-medium" style={{ opacity: 0.8 }}> · {view.noticeDetail}</span>
            </span>
        </div>
    );
};
