import { useEffect } from 'react';
import { useToast } from '../contexts/ToastContext';
import { setOutputDeviceFailureHandler } from '../utils/audioOutput';

/**
 * Session-long toast for a rejected output-device (`setSinkId`) switch.
 *
 * This used to be registered only while a call component was mounted, so a
 * failure from the Settings pane (a speaker pick, the "Test speakers" button,
 * "Listen to mic") was a console warning nobody sees - exactly the case where
 * the user is staring at the dropdown asking why nothing changed.
 * audioOutput.ts fires it once per failure episode (not once per routed
 * element) and re-arms it when the user picks again.
 *
 * The "your speakers were unplugged" notice stays call-scoped
 * (SidebarConference): outside a call an unplugged headset is not news.
 */
export function useOutputDeviceNotices(): void {
    const toast = useToast();
    useEffect(() => {
        setOutputDeviceFailureHandler(() => {
            toast.push({
                kind: 'warning',
                title: 'Speaker switch failed',
                message: "Couldn't route audio to your selected output device - falling back to the system default.",
            });
        });
        return () => setOutputDeviceFailureHandler(null);
    }, [toast]);
}
