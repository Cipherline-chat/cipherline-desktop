import { useEffect, useRef } from 'react';
import { useNotificationPrefsSafe } from '../contexts/NotificationContext';
import { playSound } from '../utils/notificationSounds';
import { callNoticesHeld } from '../utils/callNoticeLayer';

/**
 * Play the `call_prompt` sound each time an in-call card that wants a decision
 * appears. The cards sit inside the app, and the person they are for is usually
 * in a game or another window, so without this they go unseen.
 *
 * Not used by the three-hour card in CallMilestones: that one asks nothing and
 * closes by itself.
 *
 * A card held off screen by an open call prompt (utils/callNoticeLayer.ts) has
 * not appeared yet: callers pass `open && !anchor.held`, and the effect also
 * asks the hold registry itself, because a card and a prompt that mount in the
 * SAME commit render before the prompt's hold exists (the hold is taken in a
 * layout effect, which always runs before this passive one).
 */
export function useCallPromptCue(open: boolean): void {
    const notif = useNotificationPrefsSafe();
    const prefsRef = useRef(notif?.prefs);
    prefsRef.current = notif?.prefs;
    useEffect(() => {
        if (open && !callNoticesHeld()) playSound('call_prompt', prefsRef.current);
    }, [open]);
}
