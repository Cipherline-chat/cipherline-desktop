import { useEffect, useState } from 'react';

/**
 * Reliability audit (Phase J): surfaces the main process's
 * webContents 'unresponsive'/'responsive' signal. This does NOT mean the
 * call/audio pipeline is dead — AudioWorklets run on the browser's own
 * real-time audio thread, isolated from a frozen React/main-thread — so
 * this is informational with an opt-in reload, never an automatic one.
 *
 * Mounted once at the app root (see App.tsx), not scoped to being in a
 * call, since a UI hang can happen at any time.
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
    <div style={{
      position: 'fixed', top: 32, left: 0, right: 0, zIndex: 9998,
      background: 'var(--cl-warn, #b45309)', color: '#fff',
      fontSize: 13, textAlign: 'center', padding: '6px 16px',
      fontFamily: 'var(--cl-font-body, sans-serif)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
    }}>
      <span>Cipherline isn&apos;t responding — a call in progress will likely keep working. Give it a moment, or force a reload.</span>
      <button
        onClick={() => window.location.reload()}
        style={{
          background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.4)',
          borderRadius: 6, color: '#fff', fontSize: 12, padding: '3px 10px',
          cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
        }}
      >
        Force reload
      </button>
    </div>
  );
}
