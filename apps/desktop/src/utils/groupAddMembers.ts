/**
 * Pure rules for "add people to a group", shared by the picker, the right-hand
 * panel's "+" button and their tests.
 *
 * Who may add: ANY active member of the group — not just the owner/admins. That
 * is exactly what the server enforces (`ConversationsService.inviteMember`
 * only requires the caller to be an active `ConversationMember`; there is no
 * role check) and what `GroupSettingsModal` has always allowed (it renders the
 * "Add Members" section for every member). The server additionally requires
 * mutual friendship with each invitee and caps a group at 200 members. The
 * client mirrors both for UX only — it holds no load-bearing check.
 */

/**
 * Hard cap on group size. Mirrors `conversations.service.ts` (createGroup:
 * `memberIds.size > 200`, inviteMember: `currentCount >= 200`). Display and
 * button-disabling only; the server is the authority.
 */
export const GROUP_MAX_MEMBERS = 200;

/** How many more people can still be added before the cap. Never negative. */
export function remainingGroupSlots(memberCount: number, max: number = GROUP_MAX_MEMBERS): number {
    return Math.max(0, max - memberCount);
}

export interface CanAddGroupMembersInput {
    chatType: string | null | undefined;
    selfUserId: string | null | undefined;
    /** user_ids of the currently loaded member list. */
    memberIds: readonly string[];
    membersLoading: boolean;
}

/**
 * Whether the "+" next to the Members heading should be offered: a group chat,
 * the member list has loaded, and the signed-in user is one of its members
 * (the server's only requirement). Hidden while loading.
 */
export function canAddGroupMembers({ chatType, selfUserId, memberIds, membersLoading }: CanAddGroupMembersInput): boolean {
    if (chatType !== 'group') return false;
    if (membersLoading) return false;
    if (!selfUserId) return false;
    return memberIds.includes(selfUserId);
}

export interface GroupMemberEntry {
    user_id: string;
    username?: string;
    avatar_url?: string | null;
}

/**
 * Collapse `/conversations/:id/devices` rows (one per device) into one entry per
 * user, seeding the signed-in user if the endpoint omitted them (brief pairing
 * handshakes). Same shape the right-hand panel has always built inline.
 */
export function buildGroupMemberList(
    devices: ReadonlyArray<{ user_id?: string; username?: string; avatar_url?: string | null }>,
    self?: { user_id: string; username?: string | null; avatar_url?: string | null } | null,
): GroupMemberEntry[] {
    const unique = new Map<string, GroupMemberEntry>();
    for (const d of devices) {
        if (d.user_id && !unique.has(d.user_id)) {
            unique.set(d.user_id, { user_id: d.user_id, username: d.username, avatar_url: d.avatar_url });
        }
    }
    if (self?.user_id && !unique.has(self.user_id)) {
        unique.set(self.user_id, {
            user_id: self.user_id,
            username: self.username || 'You',
            avatar_url: self.avatar_url ?? null,
        });
    }
    return Array.from(unique.values());
}

/**
 * Optimistically fold freshly-added members into the loaded roster (the panel
 * shows them at once; a re-fetch then converges on the server's view). Skips
 * anyone already present so a racing `group:updated` refresh can't duplicate.
 */
export function mergeAddedGroupMembers(
    current: readonly GroupMemberEntry[],
    added: ReadonlyArray<GroupMemberEntry>,
): GroupMemberEntry[] {
    const have = new Set(current.map(m => m.user_id));
    return [...current, ...added.filter(a => !have.has(a.user_id))];
}
