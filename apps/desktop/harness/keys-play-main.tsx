/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React, { useState } from 'react';
import '../src/index.css';
import '../src/styles/home-deck.css';
import { HomeKeys, type HomeKeysMirror } from '../src/components/mascot/HomeKeys';
import { beginKeysActivity, setOwnCallMedia } from '../src/utils/keysBeats';
import { __setShinyLaunch } from '../src/utils/keysRare';
import { secureLocalStore } from '../src/utils/secureLocalStore';

/**
 * Keys on the Home greeting row (as HomePanel lays it out), put into one
 * mirrored state by ?state=<name>, for keys-play-record.mjs to hover, click
 * and spam. ?shiny=1 forces a Shiny Keys launch. window.__kp: { caption(t) }.
 *
 * States: neutral gaming call dnd asleep camo offline pile box safe coffee
 * lantern crown. (coffee needs a morning clock: the recorder installs one.)
 */
const q = new URLSearchParams(location.search);
const state = q.get('state') ?? 'neutral';
if (q.get('shiny') === '1') __setShinyLaunch(true);
else __setShinyLaunch(false);

const base: HomeKeysMirror = { status: 'online', gaming: false, inCall: false, unread: 0, pro: false };
const MIRROR: Record<string, Partial<HomeKeysMirror>> = {
    neutral: {}, gaming: { gaming: true }, call: { inCall: true }, dnd: { status: 'dnd' }, asleep: { status: 'away' },
    camo: { status: 'offline' }, offline: {}, pile: { unread: 60 }, box: {}, safe: {}, coffee: {}, lantern: {}, crown: { pro: true },
};
if (state === 'box') beginKeysActivity('transfer');
if (state === 'safe') beginKeysActivity('backup');
if (state === 'call') setOwnCallMedia({ speaking: false, sharing: false, video: true });
if (state === 'lantern') document.documentElement.setAttribute('data-depth', 'night');

const kp = { caption: (_t: string) => {} };
(window as any).__kp = kp;

const App = () => {
    const [cap, setCap] = useState('');
    kp.caption = setCap;
    React.useEffect(() => {
        if (state === 'offline') window.dispatchEvent(new Event('offline'));
    }, []);
    return (
        <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ height: 34, flexShrink: 0, background: '#0B0F1E' }} />
            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                <nav style={{ width: 72, flex: 'none', background: '#0B0F1E' }} />
                <div className="hd-frame">
                    <div className="hd-host">
                        <div className="hd-inner">
                            <div className="hd-greet">
                                <div>
                                    <span className="hd-eyebrow">Tuesday, October 20</span>
                                    <h1>Good evening, Dawson.</h1>
                                    <p>Quiet since you left.</p>
                                </div>
                                <div className="hd-mascotbtn hd-mascotslot" style={{ position: 'relative' }}>
                                    <HomeKeys
                                        userId="harness"
                                        lively={false}
                                        signal="idle"
                                        speech={null}
                                        onPoke={() => {}}
                                        canPlay={() => 'call'}
                                        onPlay={() => {}}
                                        mirror={{ ...base, ...MIRROR[state] }}
                                    />
                                    <div id="kp-cap" style={{
                                        position: 'absolute', right: 0, top: 'calc(100% + 64px)',
                                        whiteSpace: 'nowrap', font: '700 11px/1.3 Nunito, system-ui, sans-serif', color: '#8C98BC',
                                        letterSpacing: '.02em',
                                    }}>{cap}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// The egg ledger (the morning coffee's once-a-day claim) needs the store.
secureLocalStore.hydrate().catch(() => {}).finally(() => {
    createRoot(document.getElementById('root')!).render(<App />);
});
