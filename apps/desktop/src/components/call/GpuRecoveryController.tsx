/**
 * GpuRecoveryController — inside <LiveKitRoom> (CallPane). Registers this
 * call's video recovery for a GPU process restart (utils/gpuRecovery.ts):
 * main's `gpu:process-restarted` → runGpuVideoRecovery on this room. A newer
 * restart cancels a run still in progress; leaving the call cancels it too.
 * Renders nothing.
 */
import { useEffect } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { registerCallGpuRecovery, runGpuVideoRecovery } from '../../utils/gpuRecovery';
import { buildRoomRecoveryDeps, type RoomLike } from '../../utils/gpuRecoveryRoom';

export const GpuRecoveryController: React.FC = () => {
    const room = useRoomContext();

    useEffect(() => {
        if (!room) return;
        let generation = 0;
        let disposed = false;
        const unregister = registerCallGpuRecovery(async () => {
            const mine = ++generation;
            const deps = buildRoomRecoveryDeps(room as unknown as RoomLike, {
                cancelled: () => disposed || mine !== generation,
            });
            return runGpuVideoRecovery(deps);
        });
        return () => { disposed = true; generation++; unregister(); };
    }, [room]);

    return null;
};

export default GpuRecoveryController;
