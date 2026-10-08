import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Info, Laptop, MessageSquare, MessagesSquare, Server, ServerOff } from 'lucide-react';
import type { AttachmentRetention, MessageRetention } from '../../../hooks/useRetentionPolicy';
import { StepActions } from '../OnboardingFlow';
import { useEscape } from '../../../hooks/useEscape';
import type { StepProps } from '../types';
import {
    LANES, PRESET_IDS, PRESET_LABELS, RULER_LABELS, RULER_STOPS,
    detectPreset, fractionOf, labelFor, menuOptions, positionOf, presetRetention, retentionFromPolicy,
    retentionToChoice, stepWindow, windowAtFraction, windowsFor, withWindow,
    type Kind, type Lane, type PresetId, type Retention,
} from './storageModel';
import './storage.css';

/**
 * Step 1: Storage. One picture instead of six dropdowns (prototype: ob6
 * R.storage). Presets + a three-lane timeline: drag a bar end, click a value,
 * or use the arrow keys. Continue saves through the app's REAL retention path,
 * `deps.deviceStorage.complete(choice, 'signup')` (policy + marker + live-hook
 * notify), and does not advance if that throws.
 */

type Win = MessageRetention | AttachmentRetention;

const LANE_META: Record<Lane, { name: string; Icon: React.FC<{ size?: number; strokeWidth?: number }> }> = {
    dm: { name: 'Direct messages', Icon: MessageSquare },
    group: { name: 'Group chats', Icon: MessagesSquare },
    server: { name: 'Servers', Icon: Server },
};

const KIND_PHRASE: Record<Kind, string> = { msg: 'keep messages for', file: 'keep files for' };

// ── the value menu ───────────────────────────────────────────────────────────

interface MenuState { lane: Lane; kind: Kind; anchor: HTMLElement }

const ValueMenu: React.FC<{
    anchor: HTMLElement;
    kind: Kind;
    current: Win;
    label: string;
    onPick: (w: Win) => void;
    onClose: () => void;
}> = ({ anchor, kind, current, label, onPick, onClose: closeMenu }) => {
    const onClose = useCallback((restoreFocus: boolean) => {
        closeMenu();
        if (restoreFocus) anchor.focus({ preventScroll: true });
    }, [closeMenu, anchor]);
    const ref = useRef<HTMLDivElement>(null);
    const options = menuOptions(kind);
    const root = anchor.closest<HTMLElement>('.ob') ?? document.body;

    // Place it under (or, when there's no room, over) the opener, then focus
    // the current value, before the first paint.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const r = anchor.getBoundingClientRect();
        const h = el.offsetHeight;
        el.style.left = `${Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 12, r.left))}px`;
        el.style.top = `${r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
        const cur = el.querySelector<HTMLElement>('[aria-checked="true"]') ?? el.querySelector<HTMLElement>('button');
        cur?.focus({ preventScroll: true });
    }, [anchor]);

    // Click outside, scroll or resize closes it (the anchor itself toggles via its own click).
    useEffect(() => {
        const down = (e: PointerEvent) => {
            const t = e.target as Node;
            if (ref.current?.contains(t) || anchor.contains(t)) return;
            onClose(false);
        };
        const away = () => onClose(false);
        document.addEventListener('pointerdown', down, true);
        window.addEventListener('resize', away);
        document.addEventListener('scroll', away, true);
        return () => {
            document.removeEventListener('pointerdown', down, true);
            window.removeEventListener('resize', away);
            document.removeEventListener('scroll', away, true);
        };
    }, [anchor, onClose]);

    // Esc closes the menu (and returns focus) through the shared escape stack.
    useEscape(() => onClose(true));

    const onKeyDown = (e: React.KeyboardEvent) => {
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        const go = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus({ preventScroll: true }); };
        switch (e.key) {
            case 'ArrowDown': go(i + 1); break;
            case 'ArrowUp': go(i - 1); break;
            case 'Home': go(0); break;
            case 'End': go(items.length - 1); break;
            case 'Tab': e.preventDefault(); onClose(true); break;
        }
    };

    return createPortal(
        <div ref={ref} className="st-menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
            {options.map(o => (
                <button
                    key={o}
                    type="button"
                    role="menuitemradio"
                    aria-checked={o === current}
                    tabIndex={-1}
                    onClick={() => { onPick(o); onClose(true); }}
                >
                    {labelFor(kind, o)}{o === current && <Check size={14} strokeWidth={2.6} aria-hidden />}
                </button>
            ))}
        </div>,
        root,
    );
};

// ── the step ─────────────────────────────────────────────────────────────────

export const StorageStep: React.FC<StepProps> = ({ deps, onNext, onBack }) => {
    const { status } = deps.deviceStorage;
    const policy = deps.retention.policy;

    // A device that already has a choice (resume / Back) starts from it;
    // otherwise from Recommended.
    const [ret, setRet] = useState<Retention>(() => (status === 'done' ? retentionFromPolicy(policy) : presetRetention('rec')));
    // Until the person touches the chart (or saves), follow the stored policy if
    // it only becomes readable after mount (the hook loads asynchronously).
    const touched = useRef(false);
    useEffect(() => {
        if (status === 'done' && !touched.current) setRet(retentionFromPolicy(policy));
    }, [status, policy]);

    const [error, setError] = useState('');
    const [menu, setMenu] = useState<MenuState | null>(null);
    const [drag, setDrag] = useState<{ lane: Lane; kind: Kind } | null>(null);
    const dragRef = useRef<{ lane: Lane; kind: Kind; pointerId: number } | null>(null);
    const preset = detectPreset(ret);

    const edit = useCallback((lane: Lane, kind: Kind, w: Win) => {
        touched.current = true;
        setError('');
        setRet(r => (r[lane][kind] === w ? r : withWindow(r, lane, kind, w)));
    }, []);

    const choosePreset = (p: PresetId) => {
        touched.current = true;
        setError('');
        setMenu(null);
        setRet(presetRetention(p));
    };

    // ── presets (radiogroup, roving tabindex) ───────────────────────────────
    const segRefs = useRef<Partial<Record<PresetId, HTMLButtonElement | null>>>({});
    const onSegKey = (e: React.KeyboardEvent) => {
        const d = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
        if (!d) return;
        e.preventDefault();
        const from = preset === 'custom' ? (d > 0 ? -1 : PRESET_IDS.length) : PRESET_IDS.indexOf(preset);
        const next = PRESET_IDS[(from + d + PRESET_IDS.length) % PRESET_IDS.length];
        choosePreset(next);
        segRefs.current[next]?.focus();
    };

    // ── dragging a bar end ──────────────────────────────────────────────────
    const applyPointer = (e: React.PointerEvent<HTMLDivElement>, lane: Lane, kind: Kind) => {
        const r = e.currentTarget.getBoundingClientRect();
        edit(lane, kind, windowAtFraction(kind, (e.clientX - r.left) / r.width));
    };
    const onTrackDown = (e: React.PointerEvent<HTMLDivElement>, lane: Lane) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const track = e.currentTarget;
        const onHandle = (e.target as HTMLElement).closest<HTMLElement>('.st-rh');
        const kind: Kind = onHandle
            ? (onHandle.dataset.kind as Kind)
            : (e.clientY - track.getBoundingClientRect().top < 22 ? 'msg' : 'file');
        try { track.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
        dragRef.current = { lane, kind, pointerId: e.pointerId };
        setDrag({ lane, kind });
        setMenu(null);
        track.querySelector<HTMLElement>(`.st-rh--${kind}`)?.focus({ preventScroll: true });
        applyPointer(e, lane, kind);
    };
    const onTrackMove = (e: React.PointerEvent<HTMLDivElement>, lane: Lane) => {
        const d = dragRef.current;
        if (d && d.lane === lane && d.pointerId === e.pointerId) applyPointer(e, lane, d.kind);
    };
    const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId !== e.pointerId) return;
        dragRef.current = null;
        setDrag(null);
    };

    const onHandleKey = (e: React.KeyboardEvent, lane: Lane, kind: Kind) => {
        const list = windowsFor(kind);
        const cur = ret[lane][kind];
        let next: Win | null = null;
        switch (e.key) {
            case 'ArrowRight': case 'ArrowUp': next = stepWindow(kind, cur, 1); break;
            case 'ArrowLeft': case 'ArrowDown': next = stepWindow(kind, cur, -1); break;
            case 'Home': next = list[0]; break;
            case 'End': next = list[list.length - 1]; break;
        }
        if (next === null) return;
        e.preventDefault();
        edit(lane, kind, next);
    };

    // ── value menus ─────────────────────────────────────────────────────────
    const closeMenu = useCallback(() => setMenu(null), []);
    const toggleMenu = (e: React.MouseEvent<HTMLButtonElement>, lane: Lane, kind: Kind) => {
        const anchor = e.currentTarget;
        setMenu(m => (m && m.lane === lane && m.kind === kind ? null : { lane, kind, anchor }));
    };
    const onValueKey = (e: React.KeyboardEvent<HTMLButtonElement>, lane: Lane, kind: Kind) => {
        if (e.key !== 'ArrowDown') return;
        e.preventDefault();
        const anchor = e.currentTarget;
        setMenu({ lane, kind, anchor });
    };

    // ── save ────────────────────────────────────────────────────────────────
    const save = () => {
        setError('');
        setMenu(null);
        try {
            deps.deviceStorage.complete(retentionToChoice(ret), 'signup');
        } catch (e) {
            setError(e instanceof Error && e.message ? e.message : 'Couldn’t save your storage settings. Try again.');
            return;
        }
        touched.current = true;
        onNext();
    };

    return (
        <div className="step step--one" data-ob-step="storage">
            <div className="copy">
                <p className="eyebrow">Storage</p>
                <h1 className="h1">Your history lives on <em>this device</em>.</h1>
                <p className="lede">
                    Your messages are encrypted before they leave, and your history is kept here, on this computer.
                    So you decide how long it stays. Pick one, and fine-tune it whenever you like.
                </p>

                <div className="st-where">
                    <span><i><Laptop size={15} aria-hidden /></i><b>This computer</b>keeps your history</span>
                    <span className="srv"><i><ServerOff size={15} aria-hidden /></i><b>Our servers</b>can’t read a word</span>
                </div>

                <div className="st-top">
                    <div className="st-seg" role="radiogroup" aria-label="How long this device keeps things" onKeyDown={onSegKey}>
                        {PRESET_IDS.map(p => (
                            <button
                                key={p}
                                ref={el => { segRefs.current[p] = el; }}
                                type="button"
                                role="radio"
                                aria-checked={preset === p}
                                tabIndex={preset === p || (preset === 'custom' && p === 'rec') ? 0 : -1}
                                onClick={() => choosePreset(p)}
                            >
                                {PRESET_LABELS[p]}
                            </button>
                        ))}
                        {preset === 'custom' && (
                            <button type="button" role="radio" aria-checked="true" tabIndex={-1} className="st-custom">
                                {PRESET_LABELS.custom}
                            </button>
                        )}
                    </div>
                    <div className="st-legend" aria-hidden="true">
                        <span className="m"><i />Messages</span>
                        <span className="f"><i />Files &amp; media</span>
                    </div>
                </div>

                <div className="st-rc">
                    <div className="st-row st-ruler" aria-hidden="true">
                        <span />
                        <div className="st-ticks">
                            {RULER_LABELS.map((t, i) => (
                                <span key={t} className={i === RULER_STOPS ? 'inf' : ''} style={{ left: `${(i / RULER_STOPS) * 100}%` }}>{t}</span>
                            ))}
                        </div>
                        <span />
                    </div>

                    {LANES.map(lane => {
                        const { name, Icon } = LANE_META[lane];
                        const { msg, file } = ret[lane];
                        const pm = fractionOf(msg);
                        const pf = fractionOf(file);
                        const dragging = drag?.lane === lane;
                        return (
                            <div className="st-row st-lane" key={lane} data-lane={lane}>
                                <div className="st-lane-n"><i><Icon size={16} aria-hidden /></i><b>{name}</b></div>
                                <div
                                    className={`st-track${dragging ? ' dragging' : ''}`}
                                    onPointerDown={e => onTrackDown(e, lane)}
                                    onPointerMove={e => onTrackMove(e, lane)}
                                    onPointerUp={endDrag}
                                    onPointerCancel={endDrag}
                                >
                                    <div className={`st-bar st-bar--m${msg === 'never' ? ' inf' : ''}`} style={{ width: `${pm * 100}%` }} />
                                    <div className={`st-bar st-bar--f${file === 'never' ? ' inf' : ''}`} style={{ width: `${pf * 100}%` }} />
                                    {(['msg', 'file'] as const).map(kind => {
                                        const w = ret[lane][kind];
                                        const first = windowsFor(kind)[0];
                                        return (
                                            <button
                                                key={kind}
                                                type="button"
                                                role="slider"
                                                className={`st-rh st-rh--${kind}${dragging && drag?.kind === kind ? ' drag' : ''}`}
                                                data-kind={kind}
                                                aria-label={`${name}: ${KIND_PHRASE[kind]}`}
                                                aria-valuemin={positionOf(first)}
                                                aria-valuemax={RULER_STOPS}
                                                aria-valuenow={positionOf(w)}
                                                aria-valuetext={labelFor(kind, w)}
                                                style={{ left: `${Math.min(fractionOf(w), 0.985) * 100}%` }}
                                                onKeyDown={e => onHandleKey(e, lane, kind)}
                                            />
                                        );
                                    })}
                                </div>
                                <div className="st-vals">
                                    <button
                                        type="button"
                                        className="st-vm"
                                        aria-haspopup="menu"
                                        aria-expanded={menu?.lane === lane && menu.kind === 'msg'}
                                        aria-label={`${name}: messages kept for ${labelFor('msg', msg)}`}
                                        onClick={e => toggleMenu(e, lane, 'msg')}
                                        onKeyDown={e => onValueKey(e, lane, 'msg')}
                                    >
                                        {labelFor('msg', msg)}<ChevronDown size={13} strokeWidth={2.4} aria-hidden />
                                    </button>
                                    <button
                                        type="button"
                                        className="st-vf"
                                        aria-haspopup="menu"
                                        aria-expanded={menu?.lane === lane && menu.kind === 'file'}
                                        aria-label={`${name}: files kept for ${labelFor('file', file)}`}
                                        onClick={e => toggleMenu(e, lane, 'file')}
                                        onKeyDown={e => onValueKey(e, lane, 'file')}
                                    >
                                        {labelFor('file', file)} <small>files</small><ChevronDown size={12} strokeWidth={2.4} aria-hidden />
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>

                <p className="foot">
                    <Info size={13} aria-hidden />
                    <span>
                        This is for this device only: it doesn’t sync and isn’t in backups. Change it any time in <b>Settings → Storage</b>.
                        “Forever” keeps things here until you delete them.
                    </span>
                </p>

                {error && <p className="ob-err" role="alert">{error}</p>}
                <StepActions onBack={onBack} onNext={save} />
            </div>

            {menu && (
                <ValueMenu
                    anchor={menu.anchor}
                    kind={menu.kind}
                    current={ret[menu.lane][menu.kind]}
                    label={`${LANE_META[menu.lane].name}: ${KIND_PHRASE[menu.kind]}`}
                    onPick={w => edit(menu.lane, menu.kind, w)}
                    onClose={closeMenu}
                />
            )}
        </div>
    );
};
