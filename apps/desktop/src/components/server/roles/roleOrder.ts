/**
 * The ONE role display order used everywhere a list of a server's roles is
 * shown: highest `position` first, `@everyone` pinned last.
 *
 * Server Settings → Roles (RoleListPane + RolesTabContainer) and the channel /
 * category permission editors all call this, so a role list reads identically
 * in every surface. It used to be spelled out twice inside the roles tab and a
 * third, subtly different way (position only, @everyone wherever position 0
 * happened to land) in each channel dialog.
 *
 * Stable: roles that share a position keep the order the API returned them in.
 */
export function sortRolesForDisplay<T extends { is_everyone: boolean; position: number }>(
    roles: readonly T[],
): T[] {
    return [...roles].sort((a, b) => {
        if (a.is_everyone && !b.is_everyone) return 1;
        if (!a.is_everyone && b.is_everyone) return -1;
        return b.position - a.position;
    });
}
