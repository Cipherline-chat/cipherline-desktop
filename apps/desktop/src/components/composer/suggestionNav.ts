import type { ServerInfo } from '../../hooks/useServers';

/**
 * Shared ↑/↓ wrap-around math for the composer's autocomplete menus
 * (@mention and :emoji:). Both menus need the exact same "wrap past either
 * end" behaviour — this was previously duplicated inline as
 * `(i - 1 + length) % length` / `(i + 1) % length` at each menu's keydown
 * site; pulling it out means a future third suggestion menu (or a change to
 * the wrap behaviour) only has one place to touch, and the boundary cases
 * (empty list, single item, wrapping at each end) are unit-testable without
 * mounting a component.
 */
export function nextSuggestionIndex(current: number, length: number, direction: 'up' | 'down'): number {
    if (length <= 0) return 0;
    if (direction === 'up') return (current - 1 + length) % length;
    return (current + 1) % length;
}

/**
 * The hint text shown on a custom-emoji suggestion row: the owning server's
 * display name when it's cheaply available (ChatPane already receives the
 * full `servers` list as a prop from Dashboard — no extra fetch), falling
 * back to the generic "Custom" label otherwise (server list not loaded yet,
 * or the emoji's server isn't in it for some reason). All custom-emoji
 * suggestions in one composer session come from the SAME server (the active
 * channel's), but this takes serverId explicitly rather than assuming that,
 * so it stays correct if that ever changes.
 */
export function resolveCustomEmojiHint(serverId: string | null | undefined, servers: Pick<ServerInfo, 'server_id' | 'name'>[]): string {
    if (!serverId) return 'Custom';
    return servers.find(s => s.server_id === serverId)?.name ?? 'Custom';
}
