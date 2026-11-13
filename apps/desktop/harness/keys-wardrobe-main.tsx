/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React, { useEffect, useState } from 'react';
import '../src/index.css';
import '../src/styles/home-deck.css';
import { HomeKeys, type HomeKeysMirror } from '../src/components/mascot/HomeKeys';
import { __setShinyLaunch, markRareIdle } from '../src/utils/keysRare';
import { drawFor, WARDROBE_CHANCE, type Wear } from '../src/utils/keysWardrobe';
import { secureLocalStore } from '../src/utils/secureLocalStore';

/**
 * Keys on the Home greeting row wearing one look from his wardrobe
 * (utils/keysWardrobe.ts), for keys-wardrobe-shots.mjs.
 *
 *   ?hat=<beanie|captain|snorkel|shades|flower|crown|none>  the Home-visit pick
 *   &pro=1             a Pro account (the crown is in the draw)
 *   &to=<hat|none>     then the next idle check changes to this (lively on;
 *                      the shooter fast-forwards the fake clock to it)
 *   &late=1            Pro arrives 1 s after mount (the launch's billing load):
 *                      a bare pick becomes the crown
 *   &state=call|dnd|night  something that claims his head (it wins)
 *
 * The wardrobe's dice are a scripted queue: exactly the draws that produce
 * the requested looks (drawFor), nothing else random.
 */
const q = new URLSearchParams(location.search);
const parse = (v: string | null): Wear => (!v || v === 'none' ? null : (v as Wear));
const hat = parse(q.get('hat'));
const to = q.has('to') ? parse(q.get('to')) : undefined;
const pro = q.get('pro') === '1';
const late = q.get('late') === '1';
const state = q.get('state') ?? '';
__setShinyLaunch(false);
// no juggling / newspaper during a fast-forward
markRareIdle(performance.now());

const queue: number[] = [drawFor(hat, { pro: pro && !late, last: null })];
if (late) queue.push(0.1); // proArrived: bare → crown
if (to !== undefined) queue.push(WARDROBE_CHANCE / 4, drawFor(to, { pro, last: late ? 'crown' : hat }));
const random = () => (queue.length ? queue.shift()! : 0.999);
(window as any).__kw = { queue };

if (state === 'night') document.documentElement.setAttribute('data-depth', 'night');

const base: HomeKeysMirror = { status: 'online', gaming: false, inCall: false, unread: 0, pro: false };
const STATE: Record<string, Partial<HomeKeysMirror>> = { call: { inCall: true }, dnd: { status: 'dnd' } };

const App = () => {
    const [isPro, setPro] = useState(pro && !late);
    useEffect(() => {
        if (!late) return;
        const t = setTimeout(() => setPro(true), 1000);
        return () => clearTimeout(t);
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
                                    <span className="hd-eyebrow">Wednesday, October 28</span>
                                    <h1>Good evening, Dawson.</h1>
                                    <p>Quiet since you left.</p>
                                </div>
                                <div className="hd-mascotbtn hd-mascotslot" style={{ position: 'relative' }}>
                                    <HomeKeys
                                        userId="harness"
                                        lively={to !== undefined}
                                        signal="idle"
                                        speech={null}
                                        onPoke={() => {}}
                                        canPlay={() => 'call'}
                                        onPlay={() => {}}
                                        mirror={{ ...base, ...(STATE[state] ?? {}), pro: isPro }}
                                        random={random}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

secureLocalStore.hydrate().catch(() => {}).finally(() => {
    createRoot(document.getElementById('root')!).render(<App />);
});
