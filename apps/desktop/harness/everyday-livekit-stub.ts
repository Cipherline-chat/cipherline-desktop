/* eslint-disable -- harness stub, not shipped */
// Stand-in for @livekit/components-react in the everyday-call harness only: the milestones read the room
// through useRoomContext(), and the harness supplies a fake one (window.__room).
export const useRoomContext = () => (window as any).__room;
export const useMaybeRoomContext = () => (window as any).__room;
