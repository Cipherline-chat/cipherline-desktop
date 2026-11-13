/**
 * "Import from a Discord template" — client-side helpers.
 *
 * The API does all the real work (fetch from Discord, validation, mapping,
 * the transactional create — see apps/api/src/servers/discord-template/).
 * Nothing here is load-bearing: the link check only gives instant feedback
 * before a round-trip, and the tree builder only arranges the preview the
 * server already computed.
 */

export type TemplateKind = 'text' | 'huddle';

export interface TemplateOverride { role_ref: string; allow: string; deny: string }

export interface TemplateRole {
    ref: string;
    name: string;
    color: number;
    hoisted: boolean;
    mentionable: boolean;
    permissions: string;
    position: number;
}

export interface TemplateCategory {
    ref: string;
    name: string;
    kind: TemplateKind;
    position: number;
    overrides: TemplateOverride[];
    private: boolean;
}

export interface TemplateChannel {
    ref: string;
    name: string;
    kind: TemplateKind;
    topic: string | null;
    /** A ChannelIconPicker icon name (ChannelIconRenderer), or null = default (# / speaker). */
    icon_name: string | null;
    position: number;
    category_ref: string | null;
    member_limit: number | null;
    overrides: TemplateOverride[];
    private: boolean;
}

export interface TemplateBlueprint {
    server: {
        name: string;
        description: string | null;
        default_notification_level: 'all' | 'mentions';
        system_channel_ref: string | null;
    };
    everyone_permissions: string;
    roles: TemplateRole[];
    categories: TemplateCategory[];
    channels: TemplateChannel[];
    skipped: Array<{ item: string; reason: string }>;
    warnings: string[];
}

export interface DiscordTemplatePreview {
    code: string;
    template: { name: string; description: string | null };
    blueprint: TemplateBlueprint;
}

export interface DiscordTemplateImportRequest {
    code: string;
    name: string;
    description?: string;
    icon_attachment?: string;
    icon_key_b64?: string;
    icon_nonce_b64?: string;
}

// ── Link check (UX mirror of the API's parseTemplateLink) ─────────────────

const CODE_RE = /^[A-Za-z0-9]{2,32}$/;

/** True when `input` looks like something the API will accept. The API
 *  re-checks; this only decides whether to enable the button / show a hint. */
export function looksLikeTemplateLink(input: string): boolean {
    const raw = input.trim();
    if (!raw || raw.length > 200) return false;
    if (CODE_RE.test(raw)) return true;
    let candidate = raw;
    if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
        if (!/^https:\/\//i.test(candidate)) return false;
    } else {
        candidate = `https://${candidate}`;
    }
    let u: URL;
    try { u = new URL(candidate); } catch { return false; }
    if (u.username || u.password || u.port) return false;
    const host = u.hostname.toLowerCase();
    const seg = u.pathname.split('/').filter(Boolean);
    if (host === 'discord.new' && seg.length === 1) return CODE_RE.test(seg[0]);
    if ((host === 'discord.com' || host === 'www.discord.com') && seg.length === 2 && seg[0] === 'template') {
        return CODE_RE.test(seg[1]);
    }
    return false;
}

// ── Errors → copy ─────────────────────────────────────────────────────────

/** A user-facing message for a failed preview/import call (axios error or other). */
export function templateErrorMessage(err: unknown): string {
    const e = err as { response?: { status?: number; data?: { code?: string; message?: unknown } } } | null;
    const status = e?.response?.status;
    const code = e?.response?.data?.code;
    switch (code) {
        case 'INVALID_TEMPLATE_LINK': return 'That doesn’t look like a Discord template link. It should look like discord.new/abc123.';
        case 'TEMPLATE_NOT_FOUND': return 'That template doesn’t exist or was deleted. Check the link and try again.';
        case 'DISCORD_UNREACHABLE': return 'Couldn’t reach Discord. Try again in a moment.';
        case 'TEMPLATE_UNREADABLE': return 'Discord sent back a template we couldn’t read.';
        case 'DISCORD_BUSY': return 'Discord is busy right now. Try again in a minute.';
    }
    if (status === 429) return 'Too many tries. Wait a minute, then try again.';
    if (status === 400) {
        const m = e?.response?.data?.message;
        const text = Array.isArray(m) ? m.join(' ') : typeof m === 'string' ? m : '';
        return text || 'Something about that request wasn’t valid.';
    }
    if (!e?.response) return 'Couldn’t reach Cipherline. Check your connection and try again.';
    return 'Something went wrong. Try again.';
}

// ── Preview tree ──────────────────────────────────────────────────────────

export interface PreviewGroup {
    /** null = uncategorized (shown first, like the sidebar). */
    category: TemplateCategory | null;
    channels: TemplateChannel[];
}

/** Channels arranged like the server will show them: one list per panel
 *  (text sidebar / Calls panel), uncategorized first, then categories, all by
 *  position. Empty uncategorized groups are dropped; empty categories kept. */
export function buildPreviewTree(bp: TemplateBlueprint): { text: PreviewGroup[]; calls: PreviewGroup[] } {
    const byPos = <T extends { position: number }>(a: T, b: T) => a.position - b.position;
    const panel = (kind: TemplateKind): PreviewGroup[] => {
        const groups: PreviewGroup[] = [];
        const loose = bp.channels.filter((c) => c.kind === kind && c.category_ref === null).sort(byPos);
        if (loose.length) groups.push({ category: null, channels: loose });
        for (const cat of bp.categories.filter((c) => c.kind === kind).sort(byPos)) {
            groups.push({
                category: cat,
                channels: bp.channels.filter((c) => c.category_ref === cat.ref).sort(byPos),
            });
        }
        return groups;
    };
    return { text: panel('text'), calls: panel('huddle') };
}

/** Roles from most to least powerful (the way a role list reads). */
export function rolesForDisplay(bp: TemplateBlueprint): TemplateRole[] {
    return [...bp.roles].sort((a, b) => b.position - a.position);
}

/** `#rrggbb` for a role color, or null for "no color" (-1 / 0). */
export function roleColorCss(color: number): string | null {
    if (!Number.isInteger(color) || color <= 0 || color > 0xffffff) return null;
    return `#${color.toString(16).padStart(6, '0')}`;
}

/** The server-name input's filter (same rule as CreateServerModal / the API). */
export const sanitizeServerNameInput = (v: string): string => v.replace(/[^a-zA-Z0-9 '\-_.]/g, '');
