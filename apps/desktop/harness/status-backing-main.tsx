/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/theme-light-kit.css';
import '../src/styles/theme-light.css';
import '../src/styles/theme-midnight.css';
import '../src/styles/theme-contrast.css';
import '../src/styles/home-deck.css';
import '../src/styles/friends-pane.css';
import '../src/styles/profile-card.css';
import { loadWebFonts } from '../src/utils/webFonts';
import * as engine from '../src/theme/engine';
import { StatusIcon, StatusDot } from '../src/components/StatusIcon';
import { HomeStatusDot } from '../src/components/HomeStatusDot';
import { statusDotFill, STATUS_CONFIG, type UserStatus } from '../src/utils/userStatusModel';

/**
 * Status backing harness (status-backing-shots.mjs). The REAL StatusIcon / HomeStatusDot / statusDotFill and the REAL
 * css classes + class strings of each call site (Dashboard DM list, ServerContextPanel member list, FriendsPane,
 * Home deck, profile popout, StatusPicker), on a bright avatar picture so a see-through bite would show.
 *   ?theme=dark|light|midnight|hc-dark|hc-light
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
void (engine as any).setThemePreference(q.get('theme') ?? 'dark', {});

const PEOPLE: Array<[string, UserStatus]> = [['Mira', 'online'], ['Jun', 'away'], ['Ada', 'dnd'], ['Kit', 'offline']];
const PIC = (i: number) => ({ background: `conic-gradient(from ${i * 70}deg, #ff5e8a, #ffd24d, #4ade80, #38bdf8, #a78bfa, #ff5e8a)` });
const Av: React.FC<{ i: number; sz: number }> = ({ i, sz }) => <div style={{ width: sz, height: sz, borderRadius: '50%', ...PIC(i) }} />;
const panel: React.CSSProperties = { borderRadius: 12, padding: 8, width: 230, display: 'flex', flexDirection: 'column', gap: 2, boxShadow: 'inset 0 0 0 1px var(--cl-border)' };
const H: React.FC<{ t: string }> = ({ t }) => <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--cl-faint)', margin: '2px 4px 6px' }}>{t}</div>;

const Sheet: React.FC = () => (
    <div id="sheet" style={{ padding: 20, display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start', background: 'var(--cl-abyss)', color: 'var(--cl-text)', minHeight: '100vh' }}>
        <div id="members" style={{ ...panel, background: 'var(--cl-abyss)' }}>
            <H t="MEMBER LIST (abyss)" />
            {PEOPLE.map(([n, s], i) => (
                <div key={n} data-row={s} className="flex items-center gap-2.5 px-2 py-1.5 hover:bg-white/[0.04] [--status-backing:var(--cl-abyss)] hover:[--status-backing:color-mix(in_srgb,var(--cl-abyss),rgb(var(--cl-bright-rgb))_4%)] transition-colors relative group cursor-pointer rounded-lg">
                    <div className={`relative w-8 h-8 shrink-0 ${s === 'offline' ? 'opacity-35' : ''}`}>
                        <div className="w-full h-full rounded-full overflow-hidden"><Av i={i} sz={32} /></div>
                        <span className="absolute -bottom-0.5 -right-0.5 border-[2px] border-[color:var(--status-backing,var(--cl-abyss))] rounded-full flex items-center justify-center"><StatusIcon status={s} size={8} /></span>
                    </div>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{n}</span>
                </div>
            ))}
        </div>
        <div id="dms" style={{ ...panel, background: 'var(--cl-deep)' }}>
            <H t="DM LIST (deep, last row active)" />
            {PEOPLE.map(([n, s], i) => (
                <div key={n} data-row={s} style={{ gap: 11, borderRadius: 12, padding: '9px 10px' }} className={`group relative flex items-center cursor-pointer transition-colors ${i === 3 ? 'bg-cl-surface cl-row-active [--status-backing:var(--cl-surface)]' : 'hover:bg-cl-surface hover:[--status-backing:var(--cl-surface)]'}`}>
                    <div className="w-9 h-9 rounded-full shrink-0 relative z-[1]">
                        <div className="w-full h-full rounded-full flex items-center justify-center overflow-hidden"><Av i={i} sz={36} /></div>
                        <span className="absolute bottom-0 right-0 border-[2px] border-[color:var(--status-backing,var(--cl-deep))] rounded-full z-10 flex items-center justify-center"><StatusIcon status={s} size={8} /></span>
                    </div>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{n}</span>
                </div>
            ))}
        </div>
        <div id="friends" style={{ ...panel, background: 'var(--cl-deep)' }}>
            <H t="FRIENDS" />
            {PEOPLE.map(([n, s], i) => (
                <div key={n} data-row={s} className="fp-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 6, borderRadius: 10 }}>
                    <div className="fp-av"><div className="fp-avimg"><Av i={i} sz={40} /></div><span className="fp-presence"><StatusIcon status={s} size={10} /></span></div>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{n}</span>
                </div>
            ))}
        </div>
        <div id="deck" style={{ ...panel, background: 'var(--cl-sink)' }}>
            <H t="HOME DECK (sink)" />
            {PEOPLE.map(([n, s], i) => (
                <div key={n} data-row={s} className="hd-row"><div className="hd-av"><Av i={i} sz={32} /><HomeStatusDot status={s} /></div><span style={{ fontWeight: 700, fontSize: 13 }}>{n}</span></div>
            ))}
        </div>
        <div id="profile" style={{ ...panel, width: 330, background: 'var(--cl-deep)', flexDirection: 'row', gap: 26, justifyContent: 'center', padding: 22 }}>
            {PEOPLE.map(([n, s], i) => (
                <div key={n} data-row={s} style={{ position: 'relative', width: 56, height: 56, ['--pcd-ring' as any]: 'var(--cl-deep)' }}>
                    <Av i={i} sz={56} />
                    <span className="pcd-dot" style={{ background: statusDotFill(s, STATUS_CONFIG[s].color), right: -2, bottom: -2, width: 18, height: 18 }} />
                </div>
            ))}
        </div>
        <div id="picker" style={{ ...panel, background: 'var(--cl-deep)', width: 270, flexDirection: 'row', flexWrap: 'wrap' }}>
            {PEOPLE.map(([n, s]) => (
                <div key={n} data-row={s} className="flex items-center gap-2 px-2.5 py-2 rounded-xl text-[12.5px] font-bold bg-cl-sink [--status-backing:var(--cl-sink)] text-cl-faint" style={{ width: 120 }}>
                    <StatusDot status={s} size={8} /><span>{n}</span>
                </div>
            ))}
        </div>
    </div>
);
createRoot(document.getElementById('root')!).render(<Sheet />);
(window as any).__booted = true;
