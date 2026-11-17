import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ClSelect, type ClSelectOption, type ClSelectSearchConfig } from '../../cl/ClSelect';
import {
    buildTimeZoneInfos, describeTimeZone, filterTimeZones, timeZoneLabel, warmTimeZoneFormatters,
    type TimeZoneInfo,
} from '../../../utils/timeZoneChoices';
import '../../../styles/profile-settings.css';

/**
 * Profile → "Show my local time" → Time zone.
 *
 * The app's own dropdown (ClSelect, the same one the visibility rows above it
 * use) with its opt-in search: type a city, region, zone id, zone name
 * ("central") or an offset ("UTC-6", "GMT+1"). Each row reads
 * "Chicago (America) — UTC−06:00, 8:41 PM" over the zone id; the clock times
 * and offsets are for NOW (DST-aware) and refresh every time the menu opens.
 *
 * Replaces a text `<input list>` + `<datalist>`: Chromium filters a datalist
 * against the input's current text, so with "America/Chicago" already in the
 * field the native (unstyled) popup listed exactly one zone — itself.
 *
 * The value is the bare IANA id, unchanged — nothing server-side moves.
 * There is no "follow this computer" choice: the profile stores a fixed zone
 * (empty = not shown), so the device zone is offered as a one-tap suggestion
 * by the caller instead.
 */
export interface TimeZonePickerProps {
    value: string;
    onChange: (zone: string) => void;
    id?: string;
    ariaLabel?: string;
    /** Test seam: the clock the labels are computed for. */
    now?: () => Date;
}

type Opt = ClSelectOption<string> & { info: TimeZoneInfo };

/** Row height for the windowed list (see `search.rowHeight`). */
const TZ_ROW_H = 52;

function rowLabel(z: TimeZoneInfo): React.ReactNode {
    return (
        <span className="tzp-row">
            <span className="tzp-main">
                {/* The place gives way (ellipsis) before the offset + clock do. */}
                <span className="tzp-place">{z.city}{z.region && <span className="tzp-region"> ({z.region})</span>}</span>
                <span className="tzp-when">{' — '}{z.offsetLabel}, {z.time}</span>
            </span>
            <span className="tzp-sub">{z.id}{z.longName ? ` · ${z.longName}` : ''}</span>
        </span>
    );
}

function triggerLabel(z: TimeZoneInfo): React.ReactNode {
    return (
        <span className="tzp-trigger" title={timeZoneLabel(z)}>
            {z.city}{z.region && <span className="tzp-region"> ({z.region})</span>}
            <span className="tzp-off"> {'—'} {z.offsetLabel}</span>
        </span>
    );
}

function toOption(z: TimeZoneInfo): Opt {
    return { value: z.id, label: rowLabel(z), triggerLabel: triggerLabel(z), info: z };
}

export function TimeZonePicker({ value, onChange, id, ariaLabel, now = () => new Date() }: TimeZonePickerProps) {
    // The full list (418 zones) costs ~150-200 ms to describe the FIRST time —
    // one Intl formatter pair per zone, cached for the session after that — so
    // the formatters are warmed in idle slices after the pane paints, and the
    // list is described once they're ready (a few ms). Until then the trigger
    // only needs the CURRENT zone, which is one cheap describe. Opening before
    // the warm-up finishes just builds the rest synchronously.
    const [stamp, setStamp] = useState<Date | null>(null);
    useEffect(() => warmTimeZoneFormatters(() => setStamp(now())), []); // eslint-disable-line react-hooks/exhaustive-deps
    // `value` deliberately absent: a pick re-describing 418 zones is waste —
    // a picked value is already in the list, an off-list saved one is
    // prepended below, and the next open re-stamps anyway.
    const infos = useMemo(() => (stamp ? buildTimeZoneInfos(value, stamp) : null), [stamp]); // eslint-disable-line react-hooks/exhaustive-deps

    const options = useMemo<Opt[]>(() => {
        if (infos) {
            if (!value || infos.some((z) => z.id === value)) return infos.map(toOption);
            const cur = describeTimeZone(value, stamp ?? now());
            return cur ? [toOption(cur), ...infos.map(toOption)] : infos.map(toOption);
        }
        const cur = value ? describeTimeZone(value, now()) : null;
        return cur ? [toOption(cur)] : [];
    }, [infos, value]); // eslint-disable-line react-hooks/exhaustive-deps

    // Opening re-stamps "now" so the clock column is current (cheap once warm).
    const onOpenChange = useCallback((open: boolean) => { if (open) setStamp(now()); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const search = useMemo<ClSelectSearchConfig<string>>(() => ({
        placeholder: 'Search city, zone or offset (UTC-6)',
        ariaLabel: 'Search time zones',
        filter: (opts, q) => {
            const byId = new Map((opts as Opt[]).map((o) => [o.value, o]));
            return filterTimeZones((opts as Opt[]).map((o) => o.info), q).map((z) => byId.get(z.id)!);
        },
        emptyText: (q) => `No time zone matches “${q.trim()}”. Try a city or an offset like UTC+1.`,
        // ~420 two-line rows: windowed, so opening / each keystroke mounts
        // only the ~20 rows in view. Must match the rendered row height
        // (two lines + the kit's 9px row padding; pinned inline by ClSelect).
        rowHeight: TZ_ROW_H,
    }), []);

    return (
        <ClSelect<string>
            id={id}
            options={options}
            value={value}
            onChange={onChange}
            search={search}
            onOpenChange={onOpenChange}
            ariaLabel={ariaLabel}
            placeholder="Pick a time zone"
            style={{ width: '100%' }}
        />
    );
}

export default TimeZonePicker;
