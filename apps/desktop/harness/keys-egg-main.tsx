/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React, { useState } from 'react';
import { motion } from 'framer-motion';
import '../src/index.css';
import '../src/styles/home-deck.css';
import { HomeKeys, type PlayVerdict } from '../src/components/mascot/HomeKeys';
import { homeGameVerdict } from '../src/utils/keysBurst';
import { FirewallOverlay } from '../src/components/FirewallOverlay';
import { canUseWorker } from '../src/components/loadingWorkerHost';

/**
 * The Home greeting row as HomePanel lays it out (titlebar drag strip, the
 * 72 px rail, .hd-frame > .hd-host > .hd-greet, the framer slot), with the
 * real HomeKeys in it. canPlay is HomePanel's rule (homeGameVerdict, not in
 * a call), and onPlay opens the real FirewallOverlay over the pane, as
 * HomePanel does.
 *
 * window.__egg: { played, verdicts[], close() } for the driver
 * (harness/keys-egg-drive.mjs).
 */
const egg = { played: 0, verdicts: [] as PlayVerdict[], close: () => {} };
(window as any).__egg = egg;

const canPlay = (): PlayVerdict => {
    const v = homeGameVerdict(false, () => canUseWorker(document.createElement('canvas')));
    egg.verdicts.push(v);
    return v;
};

const App = () => {
    const [open, setOpen] = useState(false);
    egg.close = () => setOpen(false);
    return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <div className="drag-region" style={{ height: 34, flexShrink: 0, background: '#0B0F1E' }} />
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <nav style={{ width: 72, flex: 'none', background: '#0B0F1E' }} />
            <div className="hd-frame">
                <div className="hd-host">
                    <div className="hd-inner">
                        <div className="hd-greet">
                            <div>
                                <span className="hd-eyebrow">Thursday, October 8</span>
                                <h1>Good evening, Dawson.</h1>
                                <p>Quiet since you left.</p>
                            </div>
                            <motion.div
                                initial={{ opacity: 0, scale: 0.8 }}
                                animate={{ opacity: 1, scale: 1 }}
                                transition={{ duration: 0.5, delay: 0.18 }}
                                className="hd-mascotbtn hd-mascotslot"
                            >
                                <HomeKeys
                                    userId="harness"
                                    lively
                                    signal="idle"
                                    speech={null}
                                    onPoke={() => {}}
                                    canPlay={canPlay}
                                    onPlay={() => { egg.played++; setOpen(true); }}
                                />
                            </motion.div>
                        </div>
                    </div>
                </div>
                {open && <FirewallOverlay userId="harness" onClose={() => setOpen(false)} />}
            </div>
        </div>
    </div>
    );
};

createRoot(document.getElementById('root')!).render(<App />);
