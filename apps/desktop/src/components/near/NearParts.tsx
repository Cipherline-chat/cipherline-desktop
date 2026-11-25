import React, { useEffect, useRef, useState } from 'react';
import { Bluetooth, Check, Info, Laptop, Smartphone, Wifi, WifiOff } from 'lucide-react';
import { nt, ntRuns, type NearStringKey } from '../../utils/nearStrings';
import { checkStatusKey, normalizeTyped, type CheckRow, type NearHint } from '../../utils/nearModel';
import '../../styles/near.css';

/** A catalogue string with `**bold**` runs rendered as `<b>`. */
export const NearText: React.FC<{ k: NearStringKey; vars?: Record<string, string | number>; bold?: string }> = ({ k, vars, bold = 'nr-b' }) => (
    <>{ntRuns(k, vars).map((r, i) => (r.bold ? <b key={i} className={bold}>{r.text}</b> : <React.Fragment key={i}>{r.text}</React.Fragment>))}</>
);

export const DeviceIcon: React.FC<{ phone: boolean; size?: number }> = ({ phone, size = 26 }) => (phone ? <Smartphone size={size} aria-hidden /> : <Laptop size={size} aria-hidden />);

/** Two device glyphs with a dotted line; `apart` = broken, grey, calm (refusal). */
export const DevicePair: React.FC<{ apart?: boolean; phone?: boolean }> = ({ apart, phone = true }) => (
    <div className={`nr-pair${apart ? ' apart' : ''}`} aria-hidden="true" data-testid="device-pair">
        <span className="dev"><Laptop size={30} aria-hidden /></span>
        <span className="lnk"><i /><i /><i /><i /></span>
        <span className={`dev${apart ? ' dim' : ''}`}><DeviceIcon phone={phone} size={30} /></span>
    </div>
);

const ROW_ICON = { ble: Bluetooth, lan: Wifi } as const;

/**
 * `ProximityCheck` (spec component 2): two rows, Bluetooth and Same Wi-Fi. A polite live region; each row change
 * is announced as "Bluetooth: Not found" and nothing else (the list itself is not re-read).
 */
export const ProximityCheck: React.FC<{ rows: CheckRow[] }> = ({ rows }) => {
    const [announce, setAnnounce] = useState('');
    const prev = useRef<Record<string, string>>({});
    useEffect(() => {
        const said: string[] = [];
        for (const r of rows) {
            if (prev.current[r.k] !== undefined && prev.current[r.k] !== r.st && r.st !== 'wait') {
                said.push(nt('ck.a11y.live', { step: nt(r.k === 'ble' ? 'ck.ble.t' : 'ck.lan.t'), status: nt(checkStatusKey(r.st)) }));
            }
            prev.current[r.k] = r.st;
        }
        if (said.length) setAnnounce(said.join('. '));
    }, [rows]);
    return (
        <>
            <div className="nr-checks" role="list" data-testid="proximity-check">
                {rows.map(r => {
                    const Icon = r.st === 'no' && r.k === 'lan' ? WifiOff : ROW_ICON[r.k];
                    return (
                        <div key={r.k} className={`nr-ck ${r.st}`} role="listitem" data-row={r.k} data-status={r.st}>
                            <span className="ti"><Icon size={18} aria-hidden /></span>
                            <span>
                                <div className="t">{nt(r.k === 'ble' ? 'ck.ble.t' : 'ck.lan.t')}</div>
                                <div className="s">{r.sub}</div>
                            </span>
                            <span className="st">
                                {r.st === 'on' && <span className="nr-spin" aria-hidden="true" />}
                                {r.st === 'ok' && <Check size={16} aria-hidden />}
                                {nt(checkStatusKey(r.st))}
                            </span>
                        </div>
                    );
                })}
            </div>
            <div className="sr-only" role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>{announce}</div>
        </>
    );
};

/** A hint row: `surface` background and a lume icon. Never a yellow callout. */
export const NearHintRow: React.FC<{ hint: NearHint }> = ({ hint }) => {
    if (!hint) return null;
    return (
        <div className="nr-hint" data-testid="near-hint" data-hint={hint.key}>
            <Info size={18} aria-hidden />
            <span><NearText k={hint.key} vars={hint.vars} /></span>
        </div>
    );
};

/** Time since `active` turned true, in ms, ticking every 500 ms (drives the "bring it closer" hint). */
// eslint-disable-next-line react-refresh/only-export-components -- co-located helper export; splitting the file would only affect dev Fast Refresh, not runtime behaviour
export function useElapsed(active: boolean, now: () => number = Date.now): number {
    const [t0, setT0] = useState<number | null>(null);
    const [, tick] = useState(0);
    useEffect(() => {
        if (!active) { setT0(null); return; }
        setT0(now());
        const id = setInterval(() => tick(x => x + 1), 500);
        return () => clearInterval(id);
    }, [active, now]);
    return t0 === null ? 0 : now() - t0;
}

/**
 * Eight-slot code entry: ONE hidden input, so paste, autofill and the screen reader see a plain text field.
 * Crockford normalisation on every keystroke / paste (`K7QM-42F8`, `k7qm 42f8`, `K7QM·42F8` all fill it).
 */
export const CodeSlotsField: React.FC<{
    value: string;
    onChange: (v: string) => void;
    onSubmit?: () => void;
    disabled?: boolean;
    error?: boolean;
    label: string;
    autoFocus?: boolean;
    id?: string;
}> = ({ value, onChange, onSubmit, disabled, error, label, autoFocus, id }) => {
    const ref = useRef<HTMLInputElement>(null);
    const [focused, setFocused] = useState(false);
    useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
    const cell = (i: number) => (
        <i key={i} className={`${value[i] ? 'f' : ''}${focused && value.length === i ? ' cur' : ''}`}>{value[i] ?? ''}</i>
    );
    return (
        <div className={`nr-slots${error ? ' err' : ''}${disabled ? ' dis' : ''}`} onClick={() => ref.current?.focus()} data-testid="code-slots">
            {[0, 1, 2, 3].map(cell)}
            <span className="sep" aria-hidden="true">{'·'}</span>
            {[4, 5, 6, 7].map(cell)}
            <input
                ref={ref}
                id={id}
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={32}
                aria-label={label}
                aria-invalid={error || undefined}
                disabled={disabled}
                value={value}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onChange={e => onChange(normalizeTyped(e.target.value))}
                onKeyDown={e => { if (e.key === 'Enter' && value.length === 8) { e.preventDefault(); onSubmit?.(); } }}
            />
        </div>
    );
};

/** Thin progress bar with value for assistive tech. */
export const NearProgress: React.FC<{ pct: number; state?: 'moving' | 'paused' | 'interrupted' | 'preparing'; label: string }> = ({ pct, state = 'moving', label }) => (
    <div className={`nr-prog ${state === 'moving' ? '' : state}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state === 'preparing' ? undefined : pct} aria-busy={state === 'preparing' || undefined} aria-label={label}>
        <div className="pf" style={state === 'preparing' ? undefined : { width: `${pct}%` }} />
    </div>
);
