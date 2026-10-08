import { useEffect, useRef } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { preloadAvatarsBackground, warmAvatarsFromDiskCache } from './useEncryptedAvatar';
import secureLocalStore from '../utils/secureLocalStore';
import { hydratePeerIdentityCache, knownAvatarIds } from '../utils/peerIdentityCache';
import { bindProfileCacheViewer } from '../utils/profileCache';
import { bindRosterViewer } from '../utils/serverRosterCache';
import {
    buildAvatarWarmPlan,
    collectRecentSenderIds,
    selectFriendBanners,
    selectServerMemberAvatars,
    DEFAULT_WARM_LIMITS,
    type WarmPlanConversation,
    type WarmPlanFriend,
    type WarmPlanServer,
} from '../utils/avatarWarmPlan';

/**
 * Warm the avatar cache for the chats the user is likely to open next.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * `useEncryptedAvatar` reads its memory cache SYNCHRONOUSLY in the useState
 * initialiser, so a warm avatar paints on the first render with no async gap
 * and no fallback flash. That is the whole reason ChatPane used to be allowed
 * to `await preloadAvatars(...)` before dropping its loading gate — and also
 * the reason it no longer needs to. Warming properly makes the gate redundant
 * rather than merely shorter, and the gate cost seconds where the flash it
 * bought costs a 180 ms cross-fade (EncryptedAvatar renders the fallback and
 * the image into the same box, so nothing reflows).
 *
 * Home already warmed its own deck rows. It did not cover DM/group partners
 * beyond the deck, and it never covered SERVER CHANNEL MEMBERS at all — which
 * is why server chats hit the gate cold in every single session.
 *
 * ── When ────────────────────────────────────────────────────────────────────
 * On idle, after the boot burst. Never on the render path, never awaited.
 *
 * ── How much ────────────────────────────────────────────────────────────────
 * See avatarWarmPlan for the caps and avatarWarmQueue for the rate budget.
 * Short version: the plan is capped at ~108 ids and the cold ones are paced at
 * roughly a quarter of the account's 300-req/min API budget, because that
 * budget is a FIXED window with a 60 s block — overspending it 429s the user
 * off the whole API, not just off avatars.
 */

/** How long after mount to wait before warming, when the browser never reports
 *  idle. Long enough for the boot fetches (conversations, servers, channels,
 *  friends, messages) to have claimed their share of the throttle window. */
const WARM_START_DELAY_MS = 2_500;

type IdleHandle = { kind: 'idle'; id: number } | { kind: 'timeout'; id: ReturnType<typeof setTimeout> };

function scheduleWhenIdle(fn: () => void, timeoutMs: number): IdleHandle {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
        .requestIdleCallback;
    if (typeof ric === 'function') return { kind: 'idle', id: ric(fn, { timeout: timeoutMs }) };
    return { kind: 'timeout', id: setTimeout(fn, timeoutMs) };
}

function cancelIdle(handle: IdleHandle): void {
    if (handle.kind === 'timeout') { clearTimeout(handle.id); return; }
    const cic = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
    if (typeof cic === 'function') cic(handle.id);
}

export interface AvatarWarmingInput {
    /** Active account. Scopes the persisted identity cache; no network use. */
    userId?: string | null;
    token: string | null;
    conversations?: WarmPlanConversation[] | null;
    friends?: WarmPlanFriend[] | null;
    servers?: WarmPlanServer[] | null;
    presence?: Record<string, boolean> | null;
    unreadCounts?: Record<string, number> | null;
    mentionCounts?: Record<string, number> | null;
    lastActivityAt?: Record<string, number> | null;
    serverBadges?: Record<string, { unread?: number; mentions?: number }> | null;
    serverLastActivityAt?: Record<string, number> | null;
    /** serverId -> its channels, used only to find that server's cached messages. */
    serverChannels?: Record<string, Array<{ channel_id: string }>> | null;
    /** channelId -> locally cached messages, newest last. */
    channelMessages?: Record<string, Array<{ sender_user_id?: string | null }>> | null;
}

export function useAvatarWarming(input: AvatarWarmingInput): void {
    // ── Surviving a restart ─────────────────────────────────────────────────
    // Everything below this block is a bet on what the user will open next and
    // is paced accordingly. This one is not a bet and costs no requests at all:
    // it restores state this device already earned and then threw away when the
    // process exited.
    //
    // Two halves, both required (`restartFirstPaint.test.ts` pins them apart):
    // the persisted identity cache gives a freshly-mounted row the attachment id
    // synchronously, and the disk warm puts the decrypted blob back in the
    // memory cache so `useEncryptedAvatar`'s useState initialiser finds it on
    // the FIRST render. The blobs were never the problem — a restarted session
    // downloads nothing — but without this the user watches every avatar fade in
    // again after each boot, which is indistinguishable from a re-download.
    //
    // MUST await `whenAccountReady()`: per-account records are cold right after
    // an explicit sign-in, and an early read would look like "this account knows
    // nobody" — which the cache would then write back over the real record.
    // `isAccountReady` re-checks in case the account moved again while awaiting.
    const warmUserId = input.userId ?? null;
    useEffect(() => {
        // Synchronously, before any await: the maps are module state and this
        // effect only re-runs when the ACCOUNT changes, so leaving A's peers in
        // place while B's store decrypts would let B's first pane seed itself
        // from A's contacts. Unbinds the writer too, so nothing lands in the
        // wrong account's record during the gap.
        hydratePeerIdentityCache(null);
        // Same rule for the profile cache: responses depend on who asks.
        bindProfileCacheViewer(warmUserId);
        // ...and the server member rosters: they are membership-gated, per account.
        bindRosterViewer(warmUserId);
        if (!warmUserId) return;
        let cancelled = false;
        void (async () => {
            try {
                await secureLocalStore.whenAccountReady();
                if (cancelled || !secureLocalStore.isAccountReady(warmUserId)) return;
                // Also clears the maps synchronously, so an in-session account
                // switch can never seed B's panes from A's peers.
                hydratePeerIdentityCache(warmUserId);
                if (cancelled) return;
                await warmAvatarsFromDiskCache(knownAvatarIds());
            } catch (e) {
                // Purely an optimisation. A failure here costs a cross-fade,
                // never a missing avatar: every row still loads normally.
                console.warn('[useAvatarWarming] restart warm failed', e);
            }
        })();
        return () => { cancelled = true; };
    }, [warmUserId]);

    // The live inputs, read at fire time rather than captured at schedule time,
    // so the effect below can depend on almost nothing and still plan from
    // current state. Warming is a bet; re-running it on every keystroke-adjacent
    // state change would be pure waste.
    const latest = useRef(input);
    // Written in an effect, not during render (react-hooks/refs). Nothing reads
    // it until the idle callback fires WARM_START_DELAY_MS later, so it is
    // always current by then.
    useEffect(() => { latest.current = input; });

    // Servers whose member list has already been pulled this session. One
    // discovery request each, ever — a server the user never opens must not
    // cost a request per re-plan.
    const warmedServers = useRef(new Set<string>());
    // Ids already handed to the background lane. preloadAvatar is a no-op for
    // anything already in the memory cache, but this also skips the ones that
    // came back empty, so a missing avatar is not re-attempted every re-plan.
    const enqueued = useRef(new Set<string>());

    const token = input.token;
    // Deliberately coarse: identity of the collections, not their contents.
    const conversationCount = input.conversations?.length ?? 0;
    const serverCount = input.servers?.length ?? 0;
    const friendCount = input.friends?.length ?? 0;

    useEffect(() => {
        if (!token) return;
        if (conversationCount === 0 && serverCount === 0 && friendCount === 0) return;

        let cancelled = false;

        const handle = scheduleWhenIdle(() => {
            if (cancelled) return;
            const state = latest.current;
            const plan = buildAvatarWarmPlan({
                conversations: state.conversations,
                friends: state.friends,
                servers: state.servers,
                presence: state.presence,
                unreadCounts: state.unreadCounts,
                mentionCounts: state.mentionCounts,
                lastActivityAt: state.lastActivityAt,
                serverBadges: state.serverBadges,
                serverLastActivityAt: state.serverLastActivityAt,
            });

            const fresh = plan.direct.filter(id => !enqueued.current.has(id));
            for (const id of fresh) enqueued.current.add(id);
            if (fresh.length) void preloadAvatarsBackground(fresh, token);

            // Friends' banners, AFTER the avatars so they queue behind them on
            // the paced background lane. See selectFriendBanners for the bet.
            const banners = selectFriendBanners(state.friends, state.presence)
                .filter(id => !enqueued.current.has(id));
            for (const id of banners) enqueued.current.add(id);
            if (banners.length) void preloadAvatarsBackground(banners, token, { kind: 'banner' });

            for (const serverId of plan.serverIds) {
                if (warmedServers.current.has(serverId)) continue;
                warmedServers.current.add(serverId);
                void warmServerMembers(serverId, token, state, () => cancelled);
            }
        }, WARM_START_DELAY_MS);

        return () => { cancelled = true; cancelIdle(handle); };
        // Re-plans when the shape of the account changes (a server joined, a
        // conversation created), not when a single unread count ticks.
    }, [token, conversationCount, serverCount, friendCount]);
}

/**
 * One `GET /servers/:id/members`, then warm the avatars of the people whose
 * messages will actually paint — the senders in that server's locally cached
 * channel history first, then the member list to fill the remaining budget.
 *
 * Errors are swallowed: a 403 from a server the user has since left, or an
 * offline boot, must not surface anywhere. This is a bet, not a feature.
 */
async function warmServerMembers(
    serverId: string,
    token: string,
    state: AvatarWarmingInput,
    isCancelled: () => boolean,
): Promise<void> {
    let members: Array<{ user_id?: string | null; avatar_url?: string | null }>;
    try {
        const res = await axios.get(`${API_BASE}/servers/${serverId}/members`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!Array.isArray(res.data)) return;
        members = res.data;
    } catch {
        return;
    }
    if (isCancelled()) return;

    const channels = state.serverChannels?.[serverId] ?? [];
    const cached = state.channelMessages ?? {};
    const senders = collectRecentSenderIds(channels.map(ch => cached[ch.channel_id]));

    const ids = selectServerMemberAvatars(members, senders, DEFAULT_WARM_LIMITS.memberAvatarsPerServer);
    if (ids.length) void preloadAvatarsBackground(ids, token);
}
