/** Badge/avatar metrics for ParticipantCard's tile sizes — shared by the card
 *  (ParticipantTileShell) and the instant-join placeholder (JoiningCallView).
 *  Its own module so ParticipantCard.tsx exports components only (fast refresh). */
export function tileMetrics(sizeMode: 'tiny' | 'normal' | 'large' | 'row' | undefined, compact: boolean) {
    const effectiveCompact = sizeMode === 'tiny' || (sizeMode !== 'large' && compact);
    const effectiveLarge = sizeMode === 'large';
    return {
        effectiveCompact,
        effectiveLarge,
        size: effectiveLarge ? 'w-20 h-20' : effectiveCompact ? 'w-9 h-9' : 'w-24 h-24',
        nameTrunc: effectiveLarge ? 'max-w-[100px]' : effectiveCompact ? 'max-w-[60px]' : 'max-w-[100px]',
        nameSize: effectiveLarge ? 'text-xs' : effectiveCompact ? 'text-[10px]' : 'text-xs',
        badgeSize: effectiveLarge ? 'p-1' : effectiveCompact ? 'p-0.5' : 'p-1.5',
        badgeIconSize: effectiveLarge ? 'w-3 h-3' : effectiveCompact ? 'w-2 h-2' : 'w-3.5 h-3.5',
    };
}
