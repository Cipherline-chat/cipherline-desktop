import { useState, useEffect, useRef } from 'react';
import { useAuth } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import AuthScreen from './components/AuthScreen';
import { SeasonalLayer } from './components/SeasonalLayer';
import { useSeasonalEffects } from './hooks/useSeasonalEffects';
import Dashboard from './components/Dashboard';
import UpgradeRequiredOverlay from './components/UpgradeRequiredOverlay';
import { UpdateProvider } from './contexts/UpdateContext';
import { AppLoadingScreen } from './components/AppLoadingScreen';
import { HydrationGate } from './components/HydrationGate';
import { HydrationProvider, useHydration } from './contexts/HydrationContext';
import { OfflineScreen } from './components/OfflineScreen';
import { RendererHangBanner } from './components/RendererHangBanner';
import { useNetworkStatus } from './hooks/useNetworkStatus';
import { ClKitGallery } from './components/cl/ClKitGallery';
import { useEscape } from './hooks/useEscape';
import {
    clearPendingInvite, getPendingInvite, onPendingInviteChange, setPendingInvite,
} from './utils/signupAttribution';

function AppInner() {
  const { isAuthenticated, initializing } = useAuth();
  const isOnline = useNetworkStatus();
  const [deepLinkInviteCode, setDeepLinkInviteCode] = useState<string | null>(null);
  // True when the prompt below is a REMEMBERED invite (arrived before/while the
  // account was being created) rather than a link opened by someone already
  // signed in. Only the former gets the "welcome" entrance animation.
  const [inviteIsArrival, setInviteIsArrival] = useState(false);
  const { ready: hydrated } = useHydration();
  const [showKit, setShowKit] = useState(false);
  const [seasonalEffects] = useSeasonalEffects();

  // Fade-in curtain: when the user logs in or registers, briefly overlay
  // the Dashboard with a solid ABYSS curtain that fades out (0.4 s). This
  // gives the "app fades in from dark" effect without wrapping Dashboard in
  // a stacking-context-altering motion.div.
  const [curtain, setCurtain] = useState(false);
  const prevAuth = useRef(initializing ? null : isAuthenticated);
  useEffect(() => {
    if (prevAuth.current === false && isAuthenticated) {
      setCurtain(true);
    }
    prevAuth.current = isAuthenticated;
  }, [isAuthenticated]);

  // Dev-only UI-kit gallery — Ctrl+Shift+K toggles the brand primitive
  // reference over the app. Not linked from any user-facing surface.
  // Guarded by import.meta.env.DEV so the listener (and the gallery import
  // below) are dead-code-eliminated from production builds, not merely
  // skipped at runtime.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'K' || e.key === 'k')) {
        e.preventDefault();
        setShowKit((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Escape closes the gallery through the shared stack, so it doesn't also
  // steal the press from whatever real layer is open underneath it.
  useEscape(() => setShowKit(false), import.meta.env.DEV && showKit);

  // Listen for cipherline://invite/<code> deep links from the Electron main process.
  //
  // Two cases, deliberately different:
  //  - SIGNED IN (the app is up and running): today's behaviour — the join prompt
  //    opens right away.
  //  - NOT signed in (a new person following an invite, or the app still booting
  //    on a cold start): the code is REMEMBERED (encrypted, utils/signupAttribution)
  //    and the prompt appears once the account exists and the app has finished
  //    loading, so it survives the sign-up steps and even an app restart. It is
  //    only ever a prompt — nothing joins until the person clicks Join.
  const sessionLive = useRef(false);
  useEffect(() => { sessionLive.current = isAuthenticated && !initializing; }, [isAuthenticated, initializing]);
  useEffect(() => {
    const onInvite = (code: string) => {
      if (sessionLive.current) {
        setInviteIsArrival(false);
        setDeepLinkInviteCode(code);
      } else {
        setPendingInvite(code);   // malformed codes are refused here
      }
    };
    // Push path: app already running, main process sends the code directly.
    const cleanup = window.electronAPI?.onDeepLinkInvite?.(onInvite);

    // Pull path: handles cold-start race where the protocol URL arrived before
    // this useEffect registered the push listener above.  Main stores the code
    // in pendingDeepLinkCode; we fetch and clear it here on startup.
    window.electronAPI?.getPendingDeepLinkCode?.().then((code: string | null) => {
      if (code) onInvite(code);
    });

    return () => { cleanup?.(); };
  }, []);

  // Surface a remembered invite once the account is signed in AND the app has
  // loaded (so the prompt lands on the finished app, not over the loading
  // screen). Re-checked whenever the remembered code changes.
  const [pendingInviteTick, setPendingInviteTick] = useState(0);
  useEffect(() => onPendingInviteChange(() => setPendingInviteTick(t => t + 1)), []);
  useEffect(() => {
    if (!isAuthenticated || initializing || !hydrated) return;
    const pending = getPendingInvite();
    if (!pending) return;
    // A beat after the loading screen lifts, so the prompt reads as an arrival.
    const t = setTimeout(() => {
      setInviteIsArrival(true);
      setDeepLinkInviteCode(cur => cur ?? pending);
    }, 900);
    return () => clearTimeout(t);
  }, [isAuthenticated, initializing, hydrated, pendingInviteTick]);

  // The prompt was answered (joined or declined): one-shot, forget it.
  const handleInviteConsumed = () => {
    clearPendingInvite();
    setDeepLinkInviteCode(null);
    setInviteIsArrival(false);
  };

  // Show a skeleton while the auth context reads localStorage.
  // This eliminates the one-frame flash of the login screen on startup.
  if (initializing) {
    return <AppLoadingScreen />;
  }

  return (
    <div className="app-container">
      {import.meta.env.DEV && showKit && <ClKitGallery onClose={() => setShowKit(false)} />}
      {/* Draggable Top Bar for Electron Frameless UI */}
      <div style={{ height: '32px', width: '100%', WebkitAppRegion: 'drag', position: 'fixed', top: 0, left: 0, zIndex: 9999 } as any} />

      {isAuthenticated
        ? <Dashboard
            initialDeepLinkInviteCode={deepLinkInviteCode}
            deepLinkInviteArrival={inviteIsArrival}
            onDeepLinkConsumed={handleInviteConsumed}
          />
        : <AuthScreen />}

      {/* Skeleton over the (already mounted, already fetching) Dashboard until
          conversations + friends + servers land. Mounting Dashboard behind it
          is deliberate — it owns those fetches, so replacing it with the
          skeleton would stall the very loads the gate waits for. */}
      {isAuthenticated && <HydrationGate />}

      {/* Seasonal ambient (marine snow in its date window). Mounted only for
          the signed-in app — AuthScreen and the registration wizard have their
          own deep-field backdrops, and layering a second particle system over
          those reads as noise rather than weather. Renders null for eleven
          months of the year. */}
      {isAuthenticated && <SeasonalLayer enabled={seasonalEffects} />}

      {/* Entry curtain — solid ABYSS that fades out on first login, giving the
          "app fades in from dark" feel without wrapping Dashboard in a new
          stacking context. Pointer-events:none so it never blocks the UI. */}
      {curtain && (
        <div
          key="entry-curtain"
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: '#0B0F1E', pointerEvents: 'none',
            animation: 'app-curtain-out 0.4s ease-out forwards',
          }}
          onAnimationEnd={() => setCurtain(false)}
        />
      )}

      {/* Offline overlay — blocks the authenticated UI when there's no network.
          Dismissed automatically when connectivity returns; the WebSocket
          reconnects via its own backoff loop and Dashboard re-fetches data. */}
      {isAuthenticated && (
        <OfflineScreen isOnline={isOnline} />
      )}

      {/* Mounted at root so it covers every screen when the server forces
          an upgrade or electron-updater has a fresh build ready. */}
      <UpgradeRequiredOverlay />

      {/* Main-process-detected renderer hang. Mounted unconditionally (even
          pre-auth) since a hang can happen at any time. */}
      <RendererHangBanner />
    </div>
  );
}

function App() {
  return (
    <ToastProvider>
      <UpdateProvider>
        <HydrationProvider>
          <AppInner />
        </HydrationProvider>
      </UpdateProvider>
    </ToastProvider>
  );
}

export default App;
