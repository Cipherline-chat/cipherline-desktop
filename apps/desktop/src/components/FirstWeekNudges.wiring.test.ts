/**
 * Source-shape pins for the first-week nudges (no jsdom in this repo — see
 * useAnnouncements.test.ts — so wiring is pinned against the source, the same
 * way the other Dashboard-wiring tests do). The RULES are tested behaviourally
 * in utils/firstWeekNudges.test.ts; this file only guards that they are
 * actually connected, and that the cost/privacy constraints hold.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

const dash = read('components/Dashboard.tsx');
const hook = read('hooks/useFirstWeekNudges.ts');
const card = read('components/FirstWeekNudges.tsx');

describe('Dashboard mounts the engine with real state', () => {
    it('mounts <FirstWeekNudges> once, fed by existing state', () => {
        expect(dash.match(/<FirstWeekNudges\b/g)).toHaveLength(1);
        for (const prop of [
            'friendsLoaded={globalFriends !== null}',
            'friendCount={globalFriends?.accepted?.length ?? 0}',
            'serverCount={servers.length}',
            'activeCall={!!activeCall}',
            'onPreviewInvite={setDeepLinkInviteCode}',
        ]) expect(dash).toContain(prop);
    });
    it('"servers loaded" waits for a real load, not the initial loading=false', () => {
        expect(dash).toContain('serversLoaded={sawServersLoadingRef.current && !serversLoading}');
    });
    it('stays quiet behind the first-run storage prompt, modals and celebrations', () => {
        const busy = dash.slice(dash.indexOf('const nudgeUiBusy'), dash.indexOf('const nudgeOpenDm'));
        for (const flag of ['settingsOpen', 'deviceStorage.status !== \'done\'', 'deepLinkInviteCode', 'firstFriendCelebration', 'showReferralWelcome', 'showProWelcome']) {
            expect(busy).toContain(flag);
        }
    });
    it('the "hop in" action navigates, it never joins (joining — and the mic prompt — stays the user\'s click)', () => {
        const fn = dash.slice(dash.indexOf('const nudgeOpenChannel'), dash.indexOf('const nudgeMessageYourself'));
        expect(fn).toContain('handleSelectChannel(channel)');
        expect(fn).not.toContain('handleJoinVoiceChannel');
    });
    it('reports the real events other features own', () => {
        expect(dash).toContain("nudges.notify({ kind: 'message_sent' })");
        expect(dash).toContain("nudges.notify({ kind: 'friend_joined', username: f.username, userId: id })");
        expect(dash.match(/nudges\.notify\(\{ kind: 'friend_request_sent' \}\)/g)!.length).toBeGreaterThanOrEqual(3);
        expect(read('components/AddFriendModal.tsx')).toContain("nudges.notify({ kind: 'friend_request_sent' })");
        expect(read('components/ChatPane.tsx').match(/nudges\.notify\(\{ kind: 'friend_request_sent' \}\)/g)).toHaveLength(2);
        expect(read('components/server/ServerContextPanel.tsx')).toContain("nudges.notify({ kind: 'friend_request_sent' })");
        for (const f of ['components/OnboardingChecklist.tsx', 'components/billing/BillingTab.tsx', 'components/server/ServerInviteModal.tsx']) {
            expect(read(f)).toContain("nudges.notify({ kind: 'invite_sent' })");
        }
    });
});

describe('cost and privacy constraints', () => {
    it('no polling faster than 60 s; the tick lives only while focused and visible', () => {
        expect(hook).toContain('const TICK_MS = 60_000;');
        const intervals = [...hook.matchAll(/setInterval\(/g)];
        expect(intervals).toHaveLength(1);
        expect(hook).toContain('const here = document.hasFocus() && !document.hidden;');
    });
    it('never an OS notification for a nudge, never the network from the engine', () => {
        // The one notifShow is the ask's confirmation, asserted in notificationAsk.test.ts.
        expect(hook).not.toMatch(/axios|fetch\(|sendBeacon|XMLHttpRequest/);
        expect(read('utils/firstWeekNudges.ts')).not.toMatch(/axios|fetch\(|notifShow|new Notification/);
    });
    it('the only network call in the card is the existing referral-link fetch', () => {
        expect(card.match(/axios\.(get|post|put|patch|delete)/g)).toEqual(['axios.get']);
        expect(card).toContain('`${API_BASE}/billing/referral`');
    });
    it('state is stored encrypted-at-rest via secureLocalStore only (never raw localStorage)', () => {
        for (const f of ['utils/firstWeekNudgeStore.ts', 'utils/notificationAsk.ts', 'hooks/useFirstWeekNudges.ts', 'components/SaveCoachMark.tsx', 'components/FirstWeekNudges.tsx']) {
            expect(read(f)).not.toMatch(/\blocalStorage\b|sessionStorage/);
        }
        expect(read('utils/firstWeekNudgeStore.ts')).toContain('secureLocalStore.setItem(`cipherline_first_week_nudges_${userId}`');
    });
});

describe('the card itself', () => {
    it('is dismissible, has the off switch, and is a polite live region that never takes focus', () => {
        expect(card).toContain('Don’t show these');
        expect(card).toContain('onClick={engine.dismiss}');
        expect(card).toContain('onClick={engine.turnOff}');
        expect(card).toContain('role="status"');
        expect(card).toContain('aria-live="polite"');
        expect(card).not.toMatch(/autoFocus|\.focus\(\)/);
    });
    it('uses the design-system button and the shared (reduced-motion-aware) enter animation', () => {
        expect(card).toContain("from './cl'");
        expect(card).toContain('fade-rise-enter');
        const css = read('index.css');
        expect(css).toMatch(/prefers-reduced-motion: reduce\)[\s\S]*?\.fade-rise-enter[\s\S]*?animation: none/);
    });
    it('offers the official server through the existing join PROMPT, never by joining', () => {
        expect(card).toContain('onPreviewInvite(OFFICIAL_SERVER_INVITE_CODE)');
        expect(card).not.toMatch(/joinServer|\/join\b/);
    });
});

describe('settings and backup', () => {
    it('Settings → Notifications has the switch, bound to the same flag', () => {
        const tab = read('components/NotificationsTab.tsx');
        expect(tab).toContain('label="Getting-started tips"');
        expect(tab).toContain('useNudgeOffSwitch(userId)');
        expect(tab).toContain('<ClToggle checked={tipsOn} onChange={setTipsOn} />');
        expect(read('components/settings/settingsSearchIndex.ts')).toContain("label: 'Getting-started tips'");
    });
    it('the new persisted keys are classified in backupRegistry (state travels, the per-device ask does not)', () => {
        const reg = read('services/backupRegistry.ts');
        expect(reg).toMatch(/cipherline_first_week_nudges_\{uid\}',\s+match: 'exact',\s+include: true/);
        expect(reg).toMatch(/cipherline_notif_ask_\{uid\}',\s+match: 'exact',\s+include: false/);
    });
    it('the permission ask is wired into the engine only through the invite / friend-request events', () => {
        expect(hook).toContain("case 'friend_request_sent':");
        expect(hook).toContain("case 'invite_sent':");
    });
});
