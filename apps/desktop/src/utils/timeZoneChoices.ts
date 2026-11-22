/**
 * Time-zone picker data: the zone list, a friendly description of each zone
 * for "now" (DST-aware), and the search filter behind the profile editor's
 * Time zone dropdown (`TimeZonePicker`).
 *
 * Pure apart from `Intl` — no DOM, no React — so the label / filter rules are
 * unit-testable under the plain `node` vitest environment.
 *
 * The STORED value never changes shape: it is still the bare IANA id
 * ("America/Chicago"). Everything here is presentation.
 */

import { deviceTimeZone, isValidTimeZone } from './profileVisibility';
import { timeFormatRevision, withTimeFormat } from './a11y/timeFormat';

export interface TimeZoneInfo {
    /** IANA id — the stored value. */
    id: string;
    /** "Chicago", "Buenos Aires", "UTC". */
    city: string;
    /** "America", "Argentina, America"; '' for a region-less id like "UTC". */
    region: string;
    /** Offset from UTC right now, in minutes (−360 for Chicago in winter). */
    offsetMinutes: number;
    /** "UTC−06:00" (U+2212 minus, like the design copy). */
    offsetLabel: string;
    /** Wall-clock time there right now: "8:41 PM". */
    time: string;
    /** "Central Standard Time" — '' when the runtime has no name. */
    longName: string;
    /** Lower-cased text the search matches against (see buildHaystack). */
    haystack: string;
}

/**
 * Used only when the runtime lacks `Intl.supportedValuesOf` (pre-2022
 * engines). One or two well-known zones per populated offset, so anyone can
 * still find something at their offset even without the full IANA list.
 */
export const FALLBACK_TIME_ZONES: readonly string[] = [
    'Pacific/Midway', 'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Vancouver',
    'America/Phoenix', 'America/Denver', 'America/Chicago', 'America/Mexico_City', 'America/New_York',
    'America/Toronto', 'America/Bogota', 'America/Lima', 'America/Halifax', 'America/Caracas',
    'America/Santiago', 'America/St_Johns', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
    'Atlantic/South_Georgia', 'Atlantic/Azores', 'Atlantic/Reykjavik', 'UTC', 'Europe/London',
    'Europe/Dublin', 'Europe/Lisbon', 'Africa/Lagos', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
    'Europe/Rome', 'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Warsaw', 'Africa/Cairo',
    'Africa/Johannesburg', 'Europe/Athens', 'Europe/Helsinki', 'Europe/Kyiv', 'Asia/Jerusalem',
    'Europe/Istanbul', 'Europe/Moscow', 'Asia/Riyadh', 'Africa/Nairobi', 'Asia/Tehran', 'Asia/Dubai',
    'Asia/Kabul', 'Asia/Karachi', 'Asia/Tashkent', 'Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Dhaka',
    'Asia/Yangon', 'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore',
    'Asia/Manila', 'Australia/Perth', 'Asia/Tokyo', 'Asia/Seoul', 'Australia/Adelaide', 'Australia/Darwin',
    'Australia/Brisbane', 'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Guam', 'Pacific/Noumea',
    'Pacific/Auckland', 'Pacific/Fiji', 'Pacific/Tongatapu', 'Pacific/Kiritimati',
];

/**
 * Every zone the picker offers: the runtime's full IANA list (or the
 * fallback above), plus "UTC" (Chromium's list omits it), the device zone
 * and the user's current value — so a saved alias such as "Asia/Calcutta"
 * still shows as selected rather than leaving the trigger blank. Only valid
 * ids survive; order is irrelevant (see sortTimeZones).
 */
export function allTimeZoneIds(current?: string | null): string[] {
    const out = new Set<string>(runtimeZoneIds());
    const cur = current?.trim();
    if (cur && !out.has(cur) && isValidTimeZone(cur)) out.add(cur);
    return [...out];
}

// The runtime list never changes within a session; validating it (one
// formatter per id) is the slow part, so do it once.
let runtimeIdsCache: string[] | null = null;
function runtimeZoneIds(): string[] {
    if (runtimeIdsCache) return runtimeIdsCache;
    let base: readonly string[] | null = null;
    try {
        const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
        if (sv) {
            const list = sv('timeZone');
            if (Array.isArray(list) && list.length > 0) base = list;
        }
    } catch { /* fall back */ }
    // The runtime's own list is supported by definition — re-validating it
    // would build a throwaway formatter per zone (~90 ms). The hand-written
    // fallback is checked, since an old engine may lack a newer id.
    const out = new Set<string>(base ?? FALLBACK_TIME_ZONES.filter(isValidTimeZone));
    out.add('UTC');
    const dev = deviceTimeZone();
    if (dev) out.add(dev);
    runtimeIdsCache = [...out];
    return runtimeIdsCache;
}

/** Test seam: forget the cached runtime list (after stubbing `Intl`). */
export function resetTimeZoneIdCacheForTests(): void {
    runtimeIdsCache = null;
}

/** "UTC−06:00", "UTC+05:30", "UTC+00:00". U+2212 for the minus sign. */
export function formatUtcOffset(minutes: number): string {
    const sign = minutes < 0 ? '−' : '+';
    const abs = Math.abs(Math.round(minutes));
    const h = String(Math.floor(abs / 60)).padStart(2, '0');
    const m = String(abs % 60).padStart(2, '0');
    return `UTC${sign}${h}:${m}`;
}

// Formatter construction is the expensive part (~0.2 ms each, so ~90 ms for
// one formatter over 418 zones); formatting with a built one is cheap. Cache
// per zone for the session so re-opening the picker (which re-describes every
// zone so the clock times are current) costs almost nothing.
const clockFmt = new Map<string, Intl.DateTimeFormat>();
const nameFmt = new Map<string, Intl.DateTimeFormat | null>();

let clockFmtRev = -1;
function clockFormatter(id: string): Intl.DateTimeFormat {
    // The 12/24-hour setting changes the formatter; rebuild lazily after it moves.
    if (clockFmtRev !== timeFormatRevision()) { clockFmt.clear(); clockFmtRev = timeFormatRevision(); }
    let f = clockFmt.get(id);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', withTimeFormat({ timeZone: id, hour: 'numeric', minute: '2-digit', timeZoneName: 'longOffset' as Intl.DateTimeFormatOptions['timeZoneName'] }));
        clockFmt.set(id, f);
    }
    return f;
}

function nameFormatter(id: string): Intl.DateTimeFormat | null {
    if (nameFmt.has(id)) return nameFmt.get(id) ?? null;
    let f: Intl.DateTimeFormat | null = null;
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: 'long' }); } catch { f = null; } // time-format-ok: date-only / validity / parse
    nameFmt.set(id, f);
    return f;
}

type IdleDeadlineLike = { timeRemaining(): number };
type RequestIdle = (cb: (d: IdleDeadlineLike) => void, opts?: { timeout: number }) => number;

/**
 * Build every zone's formatters in small idle-time slices (≤ ~8 ms each), then
 * call `onDone`. After that, describing the whole list is a few ms, so the
 * picker can do it on open without a long task. Returns a cancel function.
 */
export function warmTimeZoneFormatters(onDone: () => void): () => void {
    const ids = runtimeZoneIds();
    const g = globalThis as unknown as { requestIdleCallback?: RequestIdle; cancelIdleCallback?: (h: number) => void };
    let i = 0;
    let cancelled = false;
    let handle: number | ReturnType<typeof setTimeout> = 0;
    const step = (deadline?: IdleDeadlineLike) => {
        if (cancelled) return;
        const until = Date.now() + 8;
        // Even inside an idle period, stop at ~8 ms: input that arrives
        // mid-slice waits for the slice, so a 50 ms idle slice is still jank.
        while (i < ids.length && Date.now() < until && (!deadline || deadline.timeRemaining() > 1)) {
            try { clockFormatter(ids[i]); nameFormatter(ids[i]); } catch { /* describe() will skip it */ }
            i++;
        }
        if (i < ids.length) schedule();
        else onDone();
    };
    const schedule = () => {
        handle = g.requestIdleCallback ? g.requestIdleCallback(step, { timeout: 1000 }) : setTimeout(step, 0);
    };
    schedule();
    return () => {
        cancelled = true;
        if (g.requestIdleCallback && g.cancelIdleCallback) g.cancelIdleCallback(handle as number);
        else clearTimeout(handle as ReturnType<typeof setTimeout>);
    };
}

/** Parse "GMT-06:00" / "GMT+5:30" / "GMT" into minutes; null if unrecognised. */
function parseGmtName(s: string): number | null {
    const t = s.replace('−', '-').trim();
    if (/^(GMT|UTC)$/i.test(t)) return 0;
    const m = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(t);
    if (!m) return null;
    const mins = Number(m[2]) * 60 + Number(m[3] ?? 0);
    return m[1] === '-' ? -mins : mins;
}

/** Offset by wall-clock arithmetic — for engines without `longOffset`. */
function offsetByArithmetic(id: string, now: Date): number {
    const parts = new Intl.DateTimeFormat('en-US', { // time-format-ok: date-only / validity / parse
        timeZone: id, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric', // time-format-ok: arithmetic parse, never shown
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return Math.round((asUtc - (now.getTime() - now.getMilliseconds())) / 60000);
}

/**
 * V8/ICU hands out CLDR-canonical ids, several of which are the OLD city
 * names ("Asia/Calcutta", "Europe/Kiev"). Show — and search — the current
 * name too; the stored id is whatever the runtime listed, untouched.
 */
const RENAMED_CITIES: Readonly<Record<string, string>> = {
    'Asia/Calcutta': 'Kolkata', 'Europe/Kiev': 'Kyiv', 'Asia/Katmandu': 'Kathmandu',
    'Asia/Saigon': 'Ho Chi Minh City', 'Asia/Rangoon': 'Yangon', 'America/Godthab': 'Nuuk',
    'Atlantic/Faeroe': 'Faroe', 'Pacific/Truk': 'Chuuk', 'Pacific/Ponape': 'Pohnpei',
    'Pacific/Enderbury': 'Kanton', 'Asia/Ulan_Bator': 'Ulaanbaatar', 'Asia/Dacca': 'Dhaka',
    'Asia/Thimbu': 'Thimphu', 'Asia/Macao': 'Macau', 'Asia/Ujung_Pandang': 'Makassar',
    'Africa/Asmera': 'Asmara',
};

function splitId(id: string): { city: string; region: string } {
    const segs = id.split('/').map((s) => s.replace(/_/g, ' '));
    const city = RENAMED_CITIES[id] ?? (segs[segs.length - 1] || id);
    const region = segs.slice(0, -1).reverse().join(', ');
    return { city, region };
}

/** Initials of a long name: "Central Standard Time" → "cst". Lets "cst",
 *  "pdt", "ist" find their zones without a third formatter per zone. */
function initials(name: string): string {
    const words = name.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
    return words.length >= 2 ? words.map((w) => w[0]).join('').toLowerCase() : '';
}

/** Normalise free text for matching: lower-case, `_` / `/` / `,` to spaces. */
export function normalizeTzText(s: string): string {
    return s.toLowerCase().replace(/[_/,()]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildHaystack(info: Omit<TimeZoneInfo, 'haystack'>): string {
    return [
        normalizeTzText(info.id), info.city.toLowerCase(), normalizeTzText(info.region),
        info.longName.toLowerCase(), initials(info.longName),
    ].filter(Boolean).join(' | ');
}

/** Describe one zone as of `now`. Null for an id this runtime can't format. */
export function describeTimeZone(id: string, now: Date = new Date()): TimeZoneInfo | null {
    try {
        const parts = clockFormatter(id).formatToParts(now);
        const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
        const minute = parts.find((p) => p.type === 'minute')?.value ?? '';
        const period = parts.find((p) => p.type === 'dayPeriod')?.value ?? '';
        const time = `${hour}:${minute}${period ? ` ${period}` : ''}`;
        const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
        const offsetMinutes = parseGmtName(tzName) ?? offsetByArithmetic(id, now);
        const longName = nameFormatter(id)?.formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? '';
        const { city, region } = splitId(id);
        const base = {
            id, city, region, offsetMinutes, offsetLabel: formatUtcOffset(offsetMinutes), time,
            // A bare "GMT+05:45"-style name adds nothing the offset doesn't say.
            longName: parseGmtName(longName) === null ? longName : '',
        };
        return { ...base, haystack: buildHaystack(base) };
    } catch {
        return null;
    }
}

/** West-to-east (by offset now), then alphabetically by city. */
export function sortTimeZones(list: TimeZoneInfo[]): TimeZoneInfo[] {
    return [...list].sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.city.localeCompare(b.city) || a.id.localeCompare(b.id));
}

/** All zones described for `now`, sorted. */
export function buildTimeZoneInfos(current?: string | null, now: Date = new Date()): TimeZoneInfo[] {
    const out: TimeZoneInfo[] = [];
    for (const id of allTimeZoneIds(current)) {
        const d = describeTimeZone(id, now);
        if (d) out.push(d);
    }
    return sortTimeZones(out);
}

/** "Chicago (America)" — or just "UTC". */
export function timeZonePlace(info: TimeZoneInfo): string {
    return info.region ? `${info.city} (${info.region})` : info.city;
}

/** "Chicago (America) — UTC−06:00, 8:41 PM" */
export function timeZoneLabel(info: TimeZoneInfo): string {
    return `${timeZonePlace(info)} — ${info.offsetLabel}, ${info.time}`;
}

/**
 * An offset query — "UTC-6", "gmt+1", "UTC+05:30", "+5:30", "−3", "utc", "gmt",
 * "UTC±0" — as minutes. Null when the query isn't offset-shaped (then it's
 * matched as text).
 */
export function parseOffsetQuery(query: string): number | null {
    const q = query.trim().toLowerCase().replace(/−/g, '-').replace(/\s+/g, '');
    if (q === 'utc' || q === 'gmt' || q === 'z') return 0;
    const m = /^(?:utc|gmt)?(?:([+-])|±)(\d{1,2})(?:[:.]?(\d{2}))?$/.exec(q);
    if (!m) return null;
    const h = Number(m[2]);
    const min = Number(m[3] ?? 0);
    if (h > 14 || min > 59) return null;
    const total = h * 60 + min;
    return m[1] === '-' ? -total : total;
}

/**
 * Filter + rank for the picker's search box. Empty query → the list as is.
 * An offset query ("UTC-6") keeps zones at that offset right now; "utc" /
 * "gmt" alone also keep text matches (e.g. a zone named "… GMT"). Text is
 * matched token-by-token (every token must appear somewhere), ranked: city
 * starts with the query → any word starts with the first token → elsewhere.
 * Input order is preserved within a rank (callers pass it sorted).
 */
export function filterTimeZones(list: readonly TimeZoneInfo[], query: string): TimeZoneInfo[] {
    const raw = query.trim();
    if (!raw) return [...list];
    const offset = parseOffsetQuery(raw);
    const bareUtc = /^(utc|gmt|z)$/i.test(raw);
    if (offset !== null && !bareUtc) return list.filter((z) => z.offsetMinutes === offset);

    const q = normalizeTzText(raw);
    const tokens = q.split(' ').filter(Boolean);
    const ranked: TimeZoneInfo[][] = [[], [], [], []];
    for (const z of list) {
        const textHit = tokens.length > 0 && tokens.every((t) => z.haystack.includes(t));
        const offsetHit = bareUtc && z.offsetMinutes === offset;
        if (!textHit && !offsetHit) continue;
        if (!textHit) { ranked[3].push(z); continue; }
        const city = z.city.toLowerCase();
        if (city.startsWith(q)) ranked[0].push(z);
        else if (z.haystack.split(/[\s|]+/).some((w) => w.startsWith(tokens[0]))) ranked[1].push(z);
        else ranked[2].push(z);
    }
    return ranked.flat();
}
