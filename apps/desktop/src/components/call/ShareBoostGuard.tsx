/**
 * ShareBoostGuard - tells the main process whether OUR screen share is live,
 * for "Prioritize calls and screen share while gaming" (utils/gamingVideoMode.ts,
 * electron/share-boost.ts). Mounted once per call inside <LiveKitRoom>
 * (CallPane), next to GamingVideoGuard. Renders nothing.
 *
 * Why here and not in SidebarConference: that component is unmounted and
 * remounted mid-call whenever the call portal target moves (navigating between
 * servers), and a share must not drop its priority boost for the gap. This one
 * lives as long as the Room does.
 *
 * Main owns every decision (setting on/off, Windows-only priority, the power
 * request, the OS power-throttling opt-out). All this sends is one boolean,
 * and only on change; unmount sends false, and main also resets on a renderer
 * reload / crash / quit.
 *
 * It also logs main's answer: every apply / re-apply / restore of the power
 * throttling opt-out arrives as `share:power` and becomes a `share_power` call
 * event (utils/sharePowerEvent.ts says how to read it); the GPU scheduling
 * class arrives as `share:gpu-sched` and becomes `share_gpu_sched`
 * (utils/shareGpuSchedEvent.ts). The call event log
 * lives in the renderer, so main cannot write it directly.
 */
import React, { useEffect } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import { localShareLive } from '../../utils/shareLive';
import { logCallEvent } from '../../utils/callEventLog';
import { parseSharePowerReport } from '../../utils/sharePowerEvent';
import { parseShareGpuSchedReport, shareGpuSchedEventDetail } from '../../utils/shareGpuSchedEvent';

export const ShareBoostGuard: React.FC = () => {
    const room = useRoomContext();
    useEffect(() => {
        const api = window.electronAPI;
        if (!room || !api?.setShareActive) return;
        let last: boolean | null = null;
        const push = () => {
            const on = localShareLive(room);
            if (on === last) return;
            last = on;
            api.setShareActive?.(on)?.catch?.(() => { /* main predates the channel, or is quitting */ });
        };
        room.on(RoomEvent.LocalTrackPublished, push);
        room.on(RoomEvent.LocalTrackUnpublished, push);
        room.on(RoomEvent.Disconnected, push);
        const offPower = api.onSharePower?.((raw) => {
            const r = parseSharePowerReport(raw);
            if (!r) return;
            logCallEvent('share_power', {
                phase: r.phase, procs: r.procs, ok_n: r.ok, fail_n: r.failed,
                main_err: r.mainErr, gpu_err: r.gpuErr, ren_err: r.rendererErr, mask: r.mask, timer: r.timer,
            });
        });
        // The GPU scheduling class (share_gpu_sched): what Windows' GPU scheduler was told for the capture + encode processes.
        const offGpuSched = api.onShareGpuSched?.((raw) => {
            const r = parseShareGpuSchedReport(raw);
            if (!r) return;
            logCallEvent('share_gpu_sched', shareGpuSchedEventDetail(r));
        });
        push();
        return () => {
            try { offPower?.(); } catch { /* bridge gone */ }
            try { offGpuSched?.(); } catch { /* bridge gone */ }
            room.off(RoomEvent.LocalTrackPublished, push);
            room.off(RoomEvent.LocalTrackUnpublished, push);
            room.off(RoomEvent.Disconnected, push);
            if (last) api.setShareActive?.(false)?.catch?.(() => {});
        };
    }, [room]);
    return null;
};

export default ShareBoostGuard;
