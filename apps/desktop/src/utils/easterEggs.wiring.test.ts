import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyKvKey } from '../services/backupRegistry';
import { EGG_LEDGER_KEY } from './easterEggs';

/**
 * The cross-cutting promises of the playful touches, as checks on the source:
 *   - there is NO switch (owner, 2026-10-20: "I don't want any of it
 *     togglable"): no Settings card, no search entry, no storage key, and no
 *     code path that reads one;
 *   - the seen ledger is classified for backup (excluded: device-local
 *     bookkeeping);
 *   - every egg keeps its rate limit / cooldown and its reduced-motion
 *     fallback (those are restraint and accessibility, not toggles);
 *   - the egg machinery never talks to the network, never touches telemetry or
 *     beta-diagnostics, and never imports anything that holds message content.
 *     (CreateGroupModal and startDirectMessage DO call the API — but that is the
 *     ordinary, user-confirmed "Open DM" request, not egg telemetry.)
 *     The ONE egg network path is the Egg hunter sync: EggProgressHost posts
 *     the found-egg ids (nothing else) to `/profile/eggs`. eggProgress.ts
 *     itself stays network-free — the host injects the sender — and the
 *     allowance below is pinned to that file, that endpoint and that body;
 *   - the full-screen moments obey the same rules (and are scanned below).
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** Every .ts/.tsx under src, relative paths (tests excluded). */
function sources(dir = SRC): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { out.push(...sources(full)); continue; }
        if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(relative(SRC, full));
    }
    return out;
}

describe('there is no switch', () => {
    it('Appearance has no Personality / easter-eggs card', () => {
        const pane = read('components/settings/panes/AppearancePane.tsx');
        expect(pane).not.toMatch(/Easter eggs|playful touches|useEasterEggs/);
    });
    it('settings search has no entry for it', () => {
        expect(read('components/settings/settingsSearchIndex.ts')).not.toMatch(/Easter eggs/);
    });
    it('no source reads or writes the retired key, or the retired hook / event', () => {
        const offenders = sources().filter(f => /cipherline_easter_eggs|easter-eggs-changed|useEasterEggs\(|eggsEnabledNow|readEggsEnabled|EGGS_KEY\b/.test(read(f)));
        expect(offenders).toEqual([]);
    });
});

describe('backup classification', () => {
    const UID = 'u-1';
    it('the ledger never travels with a backup', () => {
        expect(classifyKvKey(EGG_LEDGER_KEY, UID)).toBe('exclude');
    });
    it('the retired switch has no registry entry', () => {
        expect(read('services/backupRegistry.ts')).not.toMatch(/cipherline_easter_eggs/);
    });
});

describe('privacy: the egg machinery is local-only', () => {
    const FILES = [
        'utils/easterEggs.ts', 'hooks/useEasterEggs.ts', 'utils/eggPools.ts', 'utils/aloneEcho.ts', 'utils/versionTaps.ts',
        'utils/statusFlap.ts', 'utils/groupOfTwo.ts', 'utils/settingsSearchNote.ts', 'utils/eggProgress.ts',
        'components/call/AloneEcho.tsx', 'components/EggLayer.tsx', 'components/KeysParty.tsx',
        'components/mascot/KeysCostume.tsx', 'components/settings/VersionTapEgg.tsx', 'components/GroupOfTwoDialog.tsx',
        // Keys mirroring you on Home (2026-10-20)
        'utils/keysMirror.ts', 'utils/keysGestures.ts', 'utils/keysBeats.ts',
        'components/mascot/useKeysMirror.ts', 'components/mascot/KeysGear.tsx', 'components/mascot/HomeKeys.tsx',
    ];
    it.each(FILES)('%s exists', (f) => { expect(existsSync(join(SRC, f))).toBe(true); });

    const NETWORK = /\baxios\b|\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|electronAPI|betaDiagnostics|diagnostics\/|reportEvent|telemetry|analytics/i;
    it.each(FILES)('%s has no network, IPC or telemetry', (f) => {
        const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toMatch(NETWORK);
    });

    const CONTENT = /messageStore|messagesState|channelMessages|decrypt|inputText|plaintext|\.content\b|ClientContent/;
    it.each(FILES)('%s never touches message content', (f) => {
        const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toMatch(CONTENT);
    });

    it('the Egg hunter sync is the one allowed egg network path: one file, one endpoint, ids only', () => {
        const strip = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        // Exactly one source (comments aside) knows the endpoint…
        expect(sources().filter(f => /profile\/eggs/.test(strip(f)))).toEqual(['components/EggProgressHost.tsx']);
        // …and that host does one thing on the network: POST the id list there.
        const host = strip('components/EggProgressHost.tsx');
        expect([...host.matchAll(/axios\.(\w+)/g)].map(m => m[1])).toEqual(['post']);
        expect(host).toMatch(/axios\.post<EggSyncResult>\(\s*`\$\{API_BASE\}\/profile\/eggs`,\s*\{ ids \},/);
        expect(host).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|electronAPI|betaDiagnostics|diagnostics\/|reportEvent|telemetry|analytics/i);
        expect(host).not.toMatch(CONTENT);
        // The state machine it drives stays in FILES above (no network of its own).
        expect(FILES).toContain('utils/eggProgress.ts');
    });

    it('besides that sync, the only egg that talks to the API is the user-chosen Open DM, via the shared helper', () => {
        const helper = read('utils/startDirectMessage.ts');
        expect(helper).toMatch(/\/conversations\/dm/);
        const dlg = read('components/GroupOfTwoDialog.tsx');
        expect(dlg).not.toMatch(/axios|startDirectMessage/);
        expect(read('components/CreateGroupModal.tsx')).toMatch(/await startDirectMessage\(\{ token, deviceId, person: twoOf\.person \}\)/);
    });
});

describe('every egg keeps its restraint (rate limits, cooldowns)', () => {
    it.each([
        ['components/EggLayer.tsx', /claimEggNow\('konami'/],
        ['components/call/AloneEcho.tsx', /claimEggNow\(ALONE_ECHO_EGG/],
        ['components/StatusPicker.tsx', /claimEggNow\(STATUS_FLAP_EGG/],
        ['components/CreateGroupModal.tsx', /insistedCount: eggCountNow\(GROUP_OF_TWO_INSISTED\)/],
        ['components/mascot/Keys.tsx', /useEasterCostume\(\)/],
        ['components/settings/DepthGauge.tsx', /useEggCalendar\(\)/],
        ['components/settings/DepthGauge.tsx', /settingsSearchPool\(v\)/],
        ['components/ChatPane.tsx', /useLateNightPlaceholder\(\)/],
        ['components/HomePanel.tsx', /usePlayfulLine\(/],
        ['components/GameActivitySettings.tsx', /usePlayfulLine\(/],
        ['components/FriendsPane.tsx', /usePlayfulLine\(/],
    ])('%s', (file, re) => { expect(read(file as string)).toMatch(re as RegExp); });
});

describe('Keys on Home: what reaches him is kinds and flags, never content', () => {
    const calls = (re: RegExp) => sources().flatMap(f => [...read(f).matchAll(re)].map(m => ({ f, arg: m[1].trim() })));

    it('every emitKeysBeat call passes a bare literal kind', () => {
        const found = calls(/emitKeysBeat\(([^)]*)\)/g).filter(c => c.f !== 'utils/keysBeats.ts');
        expect(found.length).toBeGreaterThanOrEqual(3);
        for (const c of found) expect(c.arg, c.f).toMatch(/^'(message|home)'$/);
    });
    it('every beginKeysActivity call passes a bare literal kind', () => {
        const found = calls(/beginKeysActivity\(([^)]*)\)/g).filter(c => c.f !== 'utils/keysBeats.ts');
        expect(found.map(c => c.f).sort()).toEqual(['hooks/useAttachments.ts', 'services/driveBackup.ts']);
        for (const c of found) expect(c.arg, c.f).toMatch(/^'(transfer|backup)'$/);
    });
    it('call media is three booleans from the call sidebar (or the all-off constant)', () => {
        const found = calls(/setOwnCallMedia\(((?:[^()]|\([^()]*\))*)\)/g).filter(c => c.f !== 'utils/keysBeats.ts');
        expect(found.map(c => c.f)).toEqual(['components/SidebarConference.tsx', 'components/SidebarConference.tsx']);
        for (const c of found) expect(c.arg, c.f).toMatch(/^(OWN_MEDIA_OFF|\{ speaking: [^,]+, sharing: [^,]+, video: [^,]+ \})$/);
    });
    it('the message beat fires only for a message allowed to alert (the same decision the sound uses)', () => {
        const dash = read('components/Dashboard.tsx');
        expect(dash).toMatch(/if \(Object\.values\(notifCandidates\)\.some\(c => c\.decision\.playsSound\)\) emitKeysBeat\('message'\);/);
        expect(dash).toMatch(/if \(alertable && decision\.playsSound\) emitKeysBeat\('message'\);/);
    });
    it('the mirror\'s inputs are typed as counts and flags', () => {
        const mirror = read('utils/keysMirror.ts');
        const iface = mirror.slice(mirror.indexOf('export interface MirrorInputs'), mirror.indexOf('export const NEUTRAL_INPUTS'));
        const fields = [...iface.matchAll(/^\s+(\w+): ([^;]+);/gm)].map(m => [m[1], m[2]]);
        expect(fields.length).toBeGreaterThan(10);
        for (const [name, type] of fields) {
            if (name === 'status') { expect(type).toBe('MirrorStatus'); continue; }
            expect(['boolean', 'number'], name).toContain(type);
        }
    });
});

describe('full-screen moments (utils/moments.ts, components/moments/)', () => {
    const MOMENT_FILES = [
        'utils/moments.ts', 'components/moments/MomentHost.tsx', 'components/moments/MomentStill.tsx',
        'components/moments/views/index.ts', 'components/moments/views/SelfFriendMoment.tsx',
        'components/moments/views/SelfPingMoment.tsx',
        'components/moments/views/WishMoment.tsx',
        'components/moments/views/EmptyPartyMoment.tsx',
        'components/moments/views/VolumeCeilingMoment.tsx',
        'components/moments/VolumeCeilingWatch.tsx', 'hooks/useCountMilestone.ts', 'components/moments/MomentClock.tsx',
        'components/moments/views/SchoolMoment.tsx',
        'components/moments/views/ReefMoment.tsx',
        'components/moments/views/CoffeeMoment.tsx',
        'components/moments/views/NewYearMoment.tsx',
        'components/moments/views/AnniversaryMoment.tsx',
        'components/moments/views/SelfFanMoment.tsx',
        'components/moments/views/DoubleGeneralMoment.tsx',
        'components/moments/views/RevolvingDoorMoment.tsx',
        'components/moments/views/FirstBanMoment.tsx', 'hooks/useMomentInviteRequest.ts',
        'components/moments/views/NoteToSelfMoment.tsx', 'components/moments/views/EchoEveryoneMoment.tsx',
        'utils/milestones.ts',
        'components/moments/MilestoneWatch.tsx',
        'components/moments/views/FirstMessageMoment.tsx',
        'components/moments/views/FirstCallMoment.tsx',
        'components/moments/views/FirstServerMoment.tsx',
        'components/moments/views/Call100Moment.tsx',
        'components/moments/views/PiDayMoment.tsx',
        'components/moments/views/LeapDayMoment.tsx',
        'components/moments/views/NyeCallMoment.tsx',
        // Ceremonies (not eggs): the first-verification overlay and the hook that asks for it.
        'components/moments/views/SafetyVerifiedMoment.tsx', 'utils/firstVerification.ts',
    ];
    const strip = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const NETWORK = /\baxios\b|\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|electronAPI|betaDiagnostics|diagnostics\/|reportEvent|telemetry|analytics/i;
    const CONTENT = /messageStore|messagesState|channelMessages|decrypt|inputText|plaintext|\.content\b|ClientContent|wireText|\.value\b/;
    it.each(MOMENT_FILES)('%s exists', (f) => { expect(existsSync(join(SRC, f))).toBe(true); });
    it.each(MOMENT_FILES)('%s has no network, IPC or telemetry', (f) => { expect(strip(f)).not.toMatch(NETWORK); });
    it.each(MOMENT_FILES)('%s never touches message content or draft text', (f) => { expect(strip(f)).not.toMatch(CONTENT); });
    it.each(MOMENT_FILES)('%s does not read the easter-eggs switch (owner: no toggles)', (f) => {
        expect(strip(f)).not.toMatch(/EGGS_KEY|readEggsEnabled|eggsEnabledNow|useEasterEggs\(/);
    });
    it('is mounted once, for the signed-in app', () => {
        const app = read('App.tsx');
        expect(app.match(/<MomentHost \/>/g)?.length).toBe(1);
        expect(app).toMatch(/\{isAuthenticated && <MomentHost \/>\}/);
    });
    it('every registered moment has a view', () => {
        const views = read('components/moments/views/index.ts');
        const ids = [...read('utils/moments.ts').matchAll(/^ {4}'([a-z0-9-]+)': moment\(\{$/gm)].map(m => m[1]);
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) expect(views).toMatch(new RegExp(`'${id}':`));
    });

    // Each trigger: where it fires, and what it is given (structural facts only).
    it('Add Friend: your own tag asks for the moment and returns BEFORE the request', () => {
        const src = read('components/AddFriendModal.tsx');
        const self = src.indexOf("requestMoment('self-friend')");
        const post = src.indexOf('axios.post(');
        expect(self).toBeGreaterThan(-1);
        expect(self).toBeLessThan(post);
        expect(src.slice(self, post)).toMatch(/return;/);
        expect(src).toMatch(/if \(isOwnTag\(parsed, user\)\)/);
    });

    it('note to self: asked for on a real send in your own chat — not an edit — and given nothing else', () => {
        const src = read('components/ChatPane.tsx');
        const send = src.slice(src.indexOf('const handleSendAll = async'), src.indexOf('const handleSendAll = async') + 12000);
        expect(send).toMatch(/if \(isSelfChat && !editingId\) requestMoment\('note-to-self'\);/);
    });

    it('@everyone echo: given the parsed mention types + a roster COUNT, on send', () => {
        const src = read('components/ChatPane.tsx');
        expect(src).toMatch(/const mentionMo = mentionMoment\(mentions, \{\s*me: user\?\.user_id,\s*othersInServer: mentionMembers\.length \? mentionMembers\.filter\(m => m\.user_id !== user\?\.user_id\)\.length : null,\s*\}\);/);
        // ...plus the server it was sent in (an id), so "Invite friends" opens THAT server's invite.
        expect(src).toMatch(/if \(mentionMo\) requestMoment\(mentionMo, \{ serverId: activeChannel\?\.server_id \?\? null \}\);/);
    });
    it('@everyone echo: "Invite friends" opens the real invite dialog for that server', () => {
        const dash = read('components/Dashboard.tsx');
        expect(dash).toMatch(/useMomentInviteRequest\(sid => \{ setInviteServerId\(sid\); setShowInviteModal\(true\); \}\);/);
        expect(dash).toMatch(/const sid = inviteServerId \?\? activeServerView\?\.serverId;\s*const srv = servers\.find\(s => s\.server_id === sid\);/);
        expect(dash).toMatch(/<ServerInviteModal\s+server=\{srv\}/);
        expect(read('hooks/useMomentInviteRequest.ts')).toMatch(/window\.addEventListener\(MOMENT_INVITE_EVENT, on\)/);
    });
    it('first ban: asked for only AFTER a ban request succeeded, with nothing about who', () => {
        for (const f of ['components/server/ServerSettingsModal.tsx', 'components/server/ServerContextPanel.tsx']) {
            const src = read(f);
            const post = src.indexOf('/members/${');
            const ban = src.indexOf('/ban`', post);
            const mo = src.indexOf("requestMoment('first-ban')");
            expect(ban, f).toBeGreaterThan(-1);
            expect(mo, f).toBeGreaterThan(ban);
            expect(src.match(/requestMoment\(/g)?.length, f).toBe(1);
            // inside the same try, before its catch: a failed ban never plays it
            expect(src.slice(ban, mo), f).not.toMatch(/catch/);
        }
    });

    it('self-ping: the DM/group send path asks too (mention types only)', () => {
        const src = read('components/ChatPane.tsx');
        expect(src).toMatch(/const dmMentionMo = mentionMoment\(mentions, \{ me: user\?\.user_id, othersInServer: null \}\);\s*if \(dmMentionMo\) requestMoment\(dmMentionMo\);/);
    });

    it('voice join: the clock and the roster presence, only after the join succeeded', () => {
        const dash = read('components/Dashboard.tsx');
        const join = dash.slice(dash.indexOf('const handleJoinVoiceChannel = useCallback'), dash.indexOf('const handleJoinVoiceChannel = useCallback') + 6000);
        const set = join.indexOf('setActiveCall({');
        const mo = join.indexOf('const joinMo = voiceJoinMoment(new Date(), peekRoster(channel.server_id)?.members ?? null, userId);');
        expect(set).toBeGreaterThan(-1);
        expect(mo).toBeGreaterThan(set);
        expect(join).toMatch(/if \(joinMo\) requestMoment\(joinMo\);/);
    });

    it('volume ceiling: every 200% slider is wrapped, and the cl/ slider itself is untouched', () => {
        expect(read('components/VoiceVideoSettings.tsx')).toMatch(/<VolumeCeilingWatch>\s*<ClSlider/);
        expect(read('components/call/ControlBar.tsx')).toMatch(/<VolumeCeilingWatch>\s*<ClSlider min=\{0\} max=\{max\}/);
        expect(read('components/call/PopoverMenu.tsx').match(/<VolumeCeilingWatch>\s*<ResetSlider min=\{0\} max=\{MAX_PER_USER_VOLUME\}/g)?.length).toBe(2);
        expect(read('components/ClSlider.tsx')).not.toMatch(/moment/i);
    });

    it('milestones: Dashboard hands over two COUNTS, never the lists', () => {
        const dash = read('components/Dashboard.tsx');
        expect(dash).toMatch(/useCountMilestone\(globalFriends \? globalFriends\.accepted\.length : null, 100, 'friends-100'\);/);
        expect(dash).toMatch(/useCountMilestone\(serversLoading \? null : servers\.length, 10, 'servers-10'\);/);
    });

    it('clock moments: mounted once for the signed-in app; reads only the clock and your created_at', () => {
        const app = read('App.tsx');
        expect(app.match(/<MomentClock \/>/g)?.length).toBe(1);
        expect(app).toMatch(/\{isAuthenticated && <MomentClock \/>\}/);
        const clock = read('components/moments/MomentClock.tsx');
        expect(clock).toMatch(/const created = user\?\.created_at \?\? null;/);
        expect(clock).not.toMatch(/user\?\.(?!created_at)\w+/);
    });

    it('self-fan: ChatPane uses only who sent a row', () => {
        const src = read('components/ChatPane.tsx');
        expect(src).toMatch(/const r = selfReact\(selfReactTimes\.current\);/);
        const helpers = src.slice(src.indexOf('const isOwnRow = '), src.indexOf('const selfReactTimes = '));
        expect(helpers).not.toMatch(/content|text/);
    });
    it('the retired delete-snatch moment is gone everywhere (owner 2026-10-20)', () => {
        expect(existsSync(join(SRC, 'components/moments/views/DeleteSnatchMoment.tsx'))).toBe(false);
        expect(existsSync(join(SRC, 'styles/moment-delete-snatch.css'))).toBe(false);
        for (const f of ['components/ChatPane.tsx', 'utils/moments.ts', 'utils/eggProgress.ts', 'components/moments/views/index.ts']) {
            expect(strip(f), f).not.toMatch(/delete-snatch|quickDelete|DeleteSnatch/);
        }
    });
    it('second #general: ChannelSettingsDialog compares channel names after a successful create', () => {
        const src = read('components/server/ChannelSettingsDialog.tsx');
        const post = src.indexOf('axios.post(apiUrl`/servers/${serverId}/channels`');
        const mo = src.indexOf("if (isSecondGeneral(saved, channels)) requestMoment('double-general');");
        expect(post).toBeGreaterThan(-1);
        expect(mo).toBeGreaterThan(post);
    });
    it('first message: asked for only AFTER the server accepted a text send, in both delivery lanes, and given nothing but account age + "is it your own notes"', () => {
        const src = read('components/ChatPane.tsx');
        const calls = [...src.matchAll(/markDelivered\(clientMsgId\);\s*noteMessageDelivered\(user\?\.created_at, isSelfChat\);/g)];
        expect(calls).toHaveLength(2);
        // each sits after the POST that carried it, inside `post:`, never in the optimistic part
        for (const m of calls) {
            const before = src.slice(Math.max(0, m.index! - 2500), m.index);
            expect(before).toMatch(/await trackActivity\('send:post'/);
        }
        const mil = strip('utils/milestones.ts');
        const fn = mil.slice(mil.indexOf('export function noteMessageDelivered'), mil.indexOf('export function noteServerCreated'));
        expect(fn).toMatch(/messageDeliveredMoment\(createdIso, eggsFound\(\), isSelfChat\)/);
    });
    it('first call + the 100th: CallPane announces the media room CONNECTED (once per call, no detail); the watch counts it', () => {
        const pane = read('components/CallPane.tsx');
        expect(pane.match(/announceCallConnected\(\)/g)).toHaveLength(1);
        const at = pane.indexOf('announceCallConnected()');
        expect(pane.slice(at - 300, at)).toMatch(/if \(!h\.connected\) \{\s*h\.connected = true;/);
        expect(strip('utils/milestones.ts')).toMatch(/dispatchEvent\(new Event\(CALL_CONNECTED_EVENT\)\)/);
        const app = read('App.tsx');
        expect(app.match(/<MilestoneWatch \/>/g)).toHaveLength(1);
        expect(app).toMatch(/\{isAuthenticated && <MilestoneWatch \/>\}/);
        const watch = strip('components/moments/MilestoneWatch.tsx');
        expect(watch).toMatch(/const uid = user\?\.user_id \?\? null;/);
        expect(watch).toMatch(/const created = user\?\.created_at \?\? null;/);
        expect(watch.match(/user\?\.\w+/g)!.sort()).toEqual(['user?.created_at', 'user?.user_id']);
    });
    it('the call counter is one integer per account, in the encrypted store, and the backup carries it', () => {
        const mil = strip('utils/milestones.ts');
        expect(mil).toMatch(/secureLocalStore\.setItem\(`cipherline_calls_connected_\$\{userId\}`, String\(before \+ 1\)\)/);
        expect(mil).not.toMatch(/localStorage/);
        expect(read('services/backupRegistry.ts')).toMatch(/pattern: 'cipherline_calls_connected_\{uid\}',\s+match: 'exact',\s+include: true/);
    });
    it('first server: counted BEFORE the create from the loaded list\'s owner ids, asked for only once the server exists', () => {
        const dash = read('components/Dashboard.tsx');
        const own = dash.indexOf('const ownedBefore = serversLoading || serversError ? null : servers.filter(sv => sv.owner_user_id === userId).length;');
        const create = dash.indexOf('const srv = await createServer(name);');
        const note = dash.indexOf('noteServerCreated(ownedBefore);');
        expect(own).toBeGreaterThan(-1);
        expect(create).toBeGreaterThan(own);
        expect(note).toBeGreaterThan(create);
        expect(dash.slice(create, note)).toMatch(/if \(srv\) \{\s*$/);
    });
    it('New Year\'s call fireworks: the clock + a "live call" flag; its midnight timer is cleared on unmount', () => {
        const clock = strip('components/moments/MomentClock.tsx');
        expect(clock).toMatch(/nyeCallDue\(now, getHasActiveCall\(\)\)/);
        expect(clock).toMatch(/window\.clearTimeout\(midnight\)/);
    });
    it('revolving door: remembered on a successful leave, detected from the server list', () => {
        const dash = read('components/Dashboard.tsx');
        expect(dash).toMatch(/noteServerLeft\(leaveServerTarget\.server_id\);/);
        expect(dash).toMatch(/if \(serverRejoined\(servers\.map\(sv => sv\.server_id\)\)\) requestMoment\('revolving-door'\);/);
    });
});
