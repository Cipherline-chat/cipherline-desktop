import { useEffect, useState } from 'react';
import { ClBanner, ClBannerOverlay } from './ClBanner';

/**
 * Reliability audit (Phase J): surfaces the main process's
 * webContents 'unresponsive'/'responsive' signal. This does NOT mean the
 * call/audio pipeline is dead — AudioWorklets run on the browser's own
 * real-time audio thread, isolated from a frozen React/main-thread — so
 * this is informational with an opt-in reload, never an automatic one.
 *
 * Mounted once at the app root (see App.tsx), not scoped to being in a
 * call, since a UI hang can happen at any time. Floats above whatever is
 * open (it is not part of the Dashboard's banner stack), as an inset card.
 */
export function RendererHangBanner() {
  const [unresponsive, setUnresponsive] = useState(false);

  useEffect(() => {
    const api = window.electronAPI;
    const offUnresponsive = api?.onRendererUnresponsive?.(() => setUnresponsive(true));
    const offResponsive = api?.onRendererResponsive?.(() => setUnresponsive(false));
    return () => { offUnresponsive?.(); offResponsive?.(); };
  }, []);

  if (!unresponsive) return null;

  return (
    <ClBannerOverlay>
      <ClBanner
        inline
        tone="warning"
        title="Cipherline isn't responding"
        description="A call in progress will likely keep working. Give it a moment, or force a reload."
        actions={[{
          key: 'force-reload',
          label: 'Force reload',
          variant: 'primary',
          onClick: () => window.location.reload(),
        }]}
      />
    </ClBannerOverlay>
  );
}
