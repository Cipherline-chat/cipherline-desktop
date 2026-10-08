import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guards for background avatar warming and the removal of
 * ChatPane's preload gate.
 *
 * These pin *registration and the absence of the await*, not logic — the class
 * of bug where a piece is built and unit-tested in isolation but never reaches
 * the boot path. Same approach, and the same reason, as
 * callsChannelKeyWiring.test.ts: Dashboard.tsx is a ~7.4k-line monolith with no
 * render harness, so a mounting test would cost far more than it pins.
 *
 * The selection logic is covered by utils/avatarWarmPlan.test.ts, the queueing
 * and rate guarantees by utils/avatarWarmQueue.test.ts and
 * hooks/avatarPreloadLanes.test.ts.
 */

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const dashboard = read('Dashboard.tsx');
const chatPane = read('ChatPane.tsx');
const homePanel = read('HomePanel.tsx');

describe('the warmer is actually mounted', () => {
    it('Dashboard imports and CALLS useAvatarWarming, not merely imports it', () => {
        expect(dashboard).toContain("import { useAvatarWarming } from '../hooks/useAvatarWarming';");
        expect(dashboard).toContain('useAvatarWarming({');
    });

    it('feeds it the ranking inputs the plan needs, not just a token', () => {
        const call = dashboard.slice(dashboard.indexOf('useAvatarWarming({'));
        const body = call.slice(0, call.indexOf('});') + 3);
        // Without conversations/servers there is nothing to warm; without the
        // badge and activity maps the plan degrades to list order, which is the
        // account's join order rather than what the user is about to open.
        for (const field of [
            'conversations', 'servers', 'friends:', 'presence',
            'unreadCounts', 'mentionCounts', 'lastActivityAt',
            'serverBadges:', 'serverLastActivityAt',
            'serverChannels', 'channelMessages',
        ]) {
            expect(body).toContain(field);
        }
    });
});

describe('ChatPane no longer blocks its loading gate on avatar preloading', () => {
    /** The preload call sites, with the ~200 chars of context before each. */
    const callSites = [...chatPane.matchAll(/preloadAvatars\(avatarIds, token\)/g)]
        .map(m => chatPane.slice(Math.max(0, m.index! - 200), m.index! + 40));

    it('still has BOTH preload sites — removing the gate must not remove the warm', () => {
        expect(callSites).toHaveLength(2);
    });

    it('neither site is awaited', () => {
        for (const site of callSites) {
            expect(site).toContain('void preloadAvatars(avatarIds, token)');
            // Guard against `await void`, and against the await simply moving
            // to a wrapper on the same line.
            expect(site).not.toMatch(/await\s+(void\s+)?preloadAvatars/);
        }
    });

    it('the loading flags are still cleared, so the gate opens rather than sticking', () => {
        expect(chatPane).toContain('setMembersFetching(false)');
        expect(chatPane).toContain('setChatLoading(false)');
    });
});

describe('ChatPane seeds its author maps from the session identity cache', () => {
    /**
     * The behaviour these pin is measured in hooks/chatSwitchFirstPaint.test.ts;
     * what is NOT provable there is that the real 6.7k-line pane is wired this
     * way, because it has no render harness. Dashboard remounts this pane on
     * every conversation switch (`key={activeChat?.id ?? ...}`), so a map that
     * starts at `{}` means every message row paints its fallback — a silhouette
     * for the face, the literal words "Unknown User" for the name — until a
     * fresh REST round-trip lands. That is the reported "it loads everyone's
     * profile pictures every time", and the name flash is the same bug.
     */
    it('all FOUR author maps initialise from the cache, not from {}', () => {
        expect(chatPane).toContain('useState<Record<string, string>>(snapshotDeviceAvatarIds)');
        expect(chatPane).toContain('useState<Record<string, string>>(snapshotUserAvatarIds)');
        expect(chatPane).toContain('useState<Record<string, string>>(snapshotDeviceNames)');
        expect(chatPane).toContain('useState<Record<string, string>>(snapshotUserNames)');
        expect(chatPane).toContain("from '../utils/peerIdentityCache'");
    });

    it('no author map is ever REPLACED wholesale — that would discard the seed', () => {
        // `setUserIdToAvatar(userAvatarMap)` / `setDeviceToUsername(deviceMap)`
        // are the pre-fix shape: a bare identifier argument clobbers the seeded
        // snapshot with only what this one fetch returned.
        for (const setter of [
            'setUserIdToAvatar', 'setDeviceToAvatar',
            'setUserIdToUsername', 'setDeviceToUsername',
        ]) {
            const calls = [...chatPane.matchAll(new RegExp(`${setter}\\(([^)\\n]*)`, 'g'))].map(m => m[1]);
            expect(calls.length).toBeGreaterThan(0);
            for (const arg of calls) {
                expect(arg.trimStart().startsWith('prev')).toBe(true);
            }
        }
    });

    it('every fetch that learns an identity also writes it back to the cache', () => {
        // Two directory fetches (conversation devices, server members) plus the
        // devices refetch behind avatar:updated all go through the bulk setter;
        // the lazy per-user resolver and the live avatar:updated patch write
        // the single-field ones.
        expect([...chatPane.matchAll(/rememberIdentities\(/g)]).toHaveLength(3);
        expect([...chatPane.matchAll(/rememberUserAvatarId\(/g)]).toHaveLength(2);
        expect([...chatPane.matchAll(/rememberUserName\(/g)]).toHaveLength(1);
    });

    it('Dashboard keeps the cached NAME fresh when a peer renames', () => {
        // `user:username_updated` is handled only in Dashboard, so without this
        // the next chat switch would seed the stale handle straight back over
        // the five surfaces that handler patches. (The avatar's sibling event
        // is a ChatPane prop, which is why that one is patched over there.)
        expect(dashboard).toMatch(/import \{[^}]*\brememberUserName\b[^}]*\} from '\.\.\/utils\/peerIdentityCache';/);
        const handler = dashboard.slice(dashboard.indexOf('const { user_id, username } = usernameUpdatedEvent;'));
        expect(handler.slice(0, handler.indexOf('}, [usernameUpdatedEvent]'))).toContain('rememberUserName(user_id, username)');
    });

    it('Dashboard gives the warmer the account id, or nothing survives a restart', () => {
        // `useAvatarWarming` scopes the persisted identity cache — and decides
        // whether to hydrate it at all — off `userId`. Drop that one prop and
        // every other part of this feature still compiles, still passes its own
        // unit tests, and does nothing: the cache is never loaded, the disk warm
        // is never run, and the boot flash the owner reported comes straight
        // back. Exactly the wiring-class regression this file exists for.
        const call = dashboard.slice(dashboard.indexOf('useAvatarWarming({'));
        expect(call.slice(0, call.indexOf('});'))).toContain('userId,');
    });

    it('seeding the name map does NOT widen the DM @-mention list', () => {
        // The one consumer that reads an author map WHOLESALE rather than by a
        // sender id already in the message list. Seeding `userIdToUsername`
        // from a cross-conversation cache without this scope would offer a DM's
        // autocomplete people who are not in the DM — a mention token for a
        // non-participant, and a readout of who else the account has talked to
        // from inside an unrelated conversation.
        const block = chatPane.slice(chatPane.indexOf('const memberCandidates: MentionSuggestion[] = ('));
        const body = block.slice(0, block.indexOf('// 3. Roles'));
        expect(body).toContain('conversationUserIds.has(uid)');
        // And the scope itself must stay per-conversation: replaced by each
        // directory fetch, never merged and never seeded from the cache.
        expect(chatPane).toContain('setConversationUserIds(new Set(Object.keys(userMap)))');
        expect([...chatPane.matchAll(/setConversationUserIds\(/g)]).toHaveLength(1);
        expect(chatPane).not.toContain('setConversationUserIds(prev');
    });

    it('the cache never learns a server NICKNAME, so it cannot outrank one', () => {
        // ChatPane resolves: server nickname -> device username -> account
        // username. The nickname lives in `serverMemberNicknames`, a
        // Dashboard-owned PROP that survives the remount and is consulted
        // FIRST, so the cache only ever fills the two slots the network fetch
        // used to fill. Pin that the resolution order is unchanged and that no
        // nickname is ever handed to a remember* call.
        expect(chatPane).toContain(
            "const resolvedName = (activeChannel && msg.sender_user_id && serverMemberNicknames?.[msg.sender_user_id])",
        );
        for (const call of [...chatPane.matchAll(/remember(?:UserName|DeviceName|Identities)\(([^;]*)/g)]) {
            expect(call[1]).not.toContain('nickname');
            expect(call[1]).not.toContain('serverMemberNicknames');
        }
    });
});

describe('"Happening now" can show avatars for a server never opened this session', () => {
    /**
     * This one is NOT a caching bug. `serverMemberAvatarMaps` is populated only
     * by ServerContextPanel, i.e. only for a server whose panel has mounted, so
     * a call in an unopened server had no avatar attachment id anywhere on the
     * client and the deck's lookup resolved to `null` — forever, no matter how
     * warm the blob caches were. The fix is delivery: `avatar_url` now rides
     * the voice-presence seed and both JOIN events, exactly as `display_name`
     * already did.
     */
    it('the deck falls back to the cross-server presence avatar map', () => {
        expect(homePanel).toContain(
            'attachmentId={serverMemberAvatarMaps?.[call.server.server_id]?.[uid] ?? voiceUserAvatarIds?.[uid] ?? null}',
        );
    });

    it('HomePanel declares and destructures the prop, so it is not silently dropped', () => {
        expect(homePanel).toContain('voiceUserAvatarIds?: Record<string, string>;');
        expect(homePanel).toMatch(/voiceUserNames,\s*voiceUserAvatarIds,/);
    });

    it('Dashboard actually passes it, and feeds it from BOTH the seed and the live events', () => {
        expect(dashboard).toContain('voiceUserAvatarIds={voiceUserAvatarIds}');
        // The seed alone is not enough — it is a boot/reconnect snapshot, so
        // someone who joins a call afterwards would stay a placeholder until
        // the next reconcile tick. The huddle path is the one that actually
        // fires (every server gets a Calls channel, not a voice channel), so
        // both merge sites are load-bearing.
        expect([...dashboard.matchAll(/mergeVoiceUserAvatarId\(/g)]).toHaveLength(2);
        expect(dashboard).toContain('setVoiceUserAvatarIds(prev => ({ ...prev, ...avatars }))');
    });
});

describe('Home no longer spreads the whole friend list into a foreground preload', () => {
    it('the deck warm covers its own rows only', () => {
        const effect = homePanel.slice(homePanel.indexOf('...missedConvs.map(convAvatarId)'));
        const body = effect.slice(0, effect.indexOf('}, ['));
        expect(body).toContain('recentItems.map');
        // The uncapped `...(friends?.accepted ?? []).map(...)` is what could
        // 429 a 150-friend account off the entire API at boot. It belongs to
        // useAvatarWarming now, which caps and paces it.
        expect(body).not.toContain('friends?.accepted');
    });
});
