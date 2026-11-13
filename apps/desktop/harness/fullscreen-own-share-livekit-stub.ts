/* eslint-disable -- harness stub, not shipped */
// Stand-in for @livekit/components-react: the roster comes from window.__call (the harness).
import React from 'react';

const call = () => (window as any).__call;
function useCallRoster() {
    const [, bump] = React.useState(0);
    React.useEffect(() => call().subscribe(() => bump((n: number) => n + 1)), []);
}
export const useParticipants = () => { useCallRoster(); return call().participants; };
export const useLocalParticipant = () => { useCallRoster(); return { localParticipant: call().local }; };
export const useIsSpeaking = () => false;
export const useConnectionState = () => 'connected';
export const useRoomContext = () => call().room;
export const useMaybeRoomContext = () => call().room;
