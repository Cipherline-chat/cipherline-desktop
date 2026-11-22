/**
 * Readability preferences — Settings → Accessibility → Messages / Text /
 * Focus and links / Notifications. One small table instead of eight hooks:
 *
 *   density   Cozy (today) / Compact
 *   font      Default (Nunito) / Atkinson Hyperlegible / Lexend / OpenDyslexic
 *   leading   Normal / Relaxed          (message line spacing)
 *   tracking  Normal / Wide             (message letter spacing)
 *   focus     Off (keyboard only, today) / Always show the focus outline
 *   links     Off (today) / Underline links in messages
 *   time      Automatic / 12-hour / 24-hour           (utils/a11y/timeFormat.ts)
 *   toast     Normal / Long (2x) / Until I close them (utils/a11y/toastDuration.ts)
 *   groupGap  null (the density's own) or 0-24 px between message groups
 *
 * Every default equals today's behaviour. Values live in secureLocalStore
 * (portable preferences: classified include in services/backupRegistry.ts),
 * are validated on read (anything unknown falls back to the default), and are
 * never written on mount. They reach the screen as data attributes and one
 * custom property on <html> (applyReadability), styled by styles/readability.css.
 */

export const READABILITY_CHANGED_EVENT = 'cipherline:readability-changed';

export const READABILITY_SPECS = {
    density:  { key: 'cipherline_a11y_density',  values: ['cozy', 'compact'], def: 'cozy' },
    font:     { key: 'cipherline_a11y_font',     values: ['default', 'atkinson', 'lexend', 'opendyslexic'], def: 'default' },
    leading:  { key: 'cipherline_a11y_leading',  values: ['normal', 'relaxed'], def: 'normal' },
    tracking: { key: 'cipherline_a11y_tracking', values: ['normal', 'wide'], def: 'normal' },
    focus:    { key: 'cipherline_a11y_focus',    values: ['off', 'on'], def: 'off' },
    links:    { key: 'cipherline_a11y_links',    values: ['off', 'on'], def: 'off' },
    time:     { key: 'cipherline_a11y_time',     values: ['auto', '12h', '24h'], def: 'auto' },
    toast:    { key: 'cipherline_a11y_toast',    values: ['normal', 'long', 'sticky'], def: 'normal' },
} as const;

export type ReadabilityId = keyof typeof READABILITY_SPECS;
export type ReadabilityValue<K extends ReadabilityId> = (typeof READABILITY_SPECS)[K]['values'][number];

export const GROUP_GAP_KEY = 'cipherline_a11y_group_gap';
export const GROUP_GAP_MIN = 0;
export const GROUP_GAP_MAX = 24;
/** What each density uses between message groups when the user hasn't chosen (Cozy = Tailwind mt-3, today). */
export const GROUP_GAP_DEFAULT_PX = { cozy: 12, compact: 4 } as const;

/** Every stored key — the backup registry test asserts each is classified. */
export const READABILITY_STORE_KEYS: string[] = [...Object.values(READABILITY_SPECS).map(s => s.key), GROUP_GAP_KEY];

export function parseReadability<K extends ReadabilityId>(id: K, raw: string | null | undefined): ReadabilityValue<K> {
    const spec = READABILITY_SPECS[id];
    return ((spec.values as readonly string[]).includes(raw ?? '') ? raw : spec.def) as ReadabilityValue<K>;
}

/** null = "use the density's own gap". Anything not an integer 0-24 is null. */
export function parseGroupGap(raw: string | null | undefined): number | null {
    if (typeof raw !== 'string' || !/^\d{1,2}$/.test(raw)) return null;
    const n = Number(raw);
    return n >= GROUP_GAP_MIN && n <= GROUP_GAP_MAX ? n : null;
}

export function effectiveGroupGap(density: ReadabilityValue<'density'>, gap: number | null): number {
    return gap ?? GROUP_GAP_DEFAULT_PX[density];
}

export interface ReadabilityState {
    density: ReadabilityValue<'density'>;
    font: ReadabilityValue<'font'>;
    leading: ReadabilityValue<'leading'>;
    tracking: ReadabilityValue<'tracking'>;
    focus: ReadabilityValue<'focus'>;
    links: ReadabilityValue<'links'>;
    groupGap: number | null;
}

export const READABILITY_DEFAULTS: ReadabilityState = {
    density: 'cozy', font: 'default', leading: 'normal', tracking: 'normal', focus: 'off', links: 'off', groupGap: null,
};

/** The data attributes + custom property a state maps to (pure, for tests and the applier). */
export function readabilityAttrs(s: ReadabilityState): { attrs: Record<string, string>; gapPx: number } {
    return {
        attrs: {
            'data-a11y-density': s.density,
            'data-a11y-font': s.font,
            'data-a11y-leading': s.leading,
            'data-a11y-tracking': s.tracking,
            'data-a11y-focus': s.focus,
            'data-a11y-links': s.links,
        },
        gapPx: effectiveGroupGap(s.density, s.groupGap),
    };
}

export const GROUP_GAP_VAR = '--cl-msg-group-gap';

export function applyReadability(s: ReadabilityState, el: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null): void {
    if (!el) return;
    const { attrs, gapPx } = readabilityAttrs(s);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.style.setProperty(GROUP_GAP_VAR, `${gapPx}px`);
}

/** The font stack each non-default choice puts on --cl-font-body / --cl-font-display (see readability.css). */
export const FONT_LABELS: Record<ReadabilityValue<'font'>, string> = {
    default: 'Default',
    atkinson: 'Atkinson Hyperlegible',
    lexend: 'Lexend',
    opendyslexic: 'OpenDyslexic',
};
