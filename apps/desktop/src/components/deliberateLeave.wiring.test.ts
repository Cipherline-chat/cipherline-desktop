import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Owner report (staging 1.0.22-staging.163): in a Calls channel with "End call
 * when the starter leaves" ON, the starter pressing Leave did NOT end the call,
 * while moving to another call did.
 *
 * Every explicit Leave already sent `{deliberate:true}` through the one shared
 * chain (handleUserLeave -> handleDisconnectCall -> handleLeaveHuddleCall ->
 * useServers.leaveHuddleCall). The difference was ORDER: Leave cleared the call
 * state in the same tick, which unmounts CallPane and disconnects the LiveKit
 * room before the HTTPS request has even left the machine. LiveKit's
 * `participant_left` webhook reaches the API server-to-server first and is an
 * ORDINARY leave, so the starter was already out of the participant set when the
 * deliberate leave landed ("no leave left to act on") and the call carried on.
 * A call switch keeps the old room up for the whole join round trip, so it won.
 *
 * Dashboard has no render harness, so the properties are pinned at source level:
 *   1. an inventory of EVERY leave entry point and what it sends (so a new one
 *      cannot appear without a conscious decision);
 *   2. the ordering: send first, tear the room down after the answer (or the cap);
 *   3. the request is not abortable by the teardown;
 *   4. a negative control proving the scans can fail.
 * The behaviour of the pieces (hold decision, ack wait, cap) is unit-tested in
 * utils/endCallOnLeave.test.ts.
 */
const SRC = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');
const dash = read('components', 'Dashboard.tsx');
const conf = read('components', 'SidebarConference.tsx');
const pane = read('components', 'CallPane.tsx');
const servers = read('hooks', 'useServers.ts');
const panel = read('components', 'server', 'ServerContextPanel.tsx');
const controlBar = read('components', 'call', 'ControlBar.tsx');

const between = (src: string, from: string, to: string): string => {
    const a = src.indexOf(from);
    expect(a, `"${from}" not found`).toBeGreaterThan(-1);
    const b = src.indexOf(to, a + from.length);
    expect(b, `"${to}" not found after "${from}"`).toBeGreaterThan(a);
    return src.slice(a, b);
};

const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
    }
    return out;
};
const sources = walk(SRC).map(f => ({ file: relative(SRC, f), text: readFileSync(f, 'utf8') }));

// ── The predicates the scans use (exported to the negative control below) ────

/** In the hold branch the request is created BEFORE the room is cleared. */
const holdBranchSendsFirst = (dashSrc: string): boolean => {
    const a = dashSrc.indexOf('shouldHoldTeardownForLeaveAck(deliberate,');
    if (a < 0) return false;
    const end = dashSrc.indexOf('return;', a);
    const hold = dashSrc.slice(a, end);
    const send = hold.indexOf('leaveHuddleCall(callId, { deliberate })');
    const wait = hold.indexOf('await waitForLeaveAck(sent)');
    const teardown = hold.indexOf('setActiveCall(');
    return send > -1 && wait > send && teardown > wait;
};

/** handleDisconnectCall must not clear the call itself when a huddle leave owns the teardown. */
const disconnectDefersToHuddleLeave = (dashSrc: string): boolean =>
    dashSrc.includes('huddleLeaveOwnsTeardown = true;')
    && dashSrc.includes('if (!huddleLeaveOwnsTeardown) setActiveCall(null);');

const leaveSites = (srcs: { file: string; text: string }[]): string[] => {
    const sites: string[] = [];
    for (const s of srcs) {
        for (const m of s.text.matchAll(/\bleaveHuddleCall\(([^)]*\{[^}]*\}|[^)]*)\)/g)) {
            if (/callId: string/.test(m[1])) continue; // the declaration inside useServers
            sites.push(`${s.file}: leaveHuddleCall(${m[1].replace(/\s+/g, ' ').trim()})`);
        }
    }
    return sites;
};

describe('inventory: every leave entry point and what it sends', () => {
    it('ControlBar Leave button + the leave hotkey both go through handleUserLeave (deliberate)', () => {
        expect(controlBar).toContain('onClick={onLeave}');
        expect(conf).toContain('onLeave={handleUserLeave}');
        expect(conf).toContain("'keybind:leave-call':         handleUserLeave,");
        expect(between(conf, 'const handleUserLeave = () => {', '};').replace(/\s+/g, ' ')).toContain('handleLeave(true);');
    });

    it('the panel / call-card / floating-card "Leave call" menu rows call one handler, deliberately', () => {
        // ServerContextPanel renders the server panel card AND the floating card's menu.
        const rows = [...panel.matchAll(/label: 'Leave call', onSelect: \(\) => (onLeaveHuddleCall\?\.\(\))/g)];
        expect(rows.length).toBe(2);
        expect(panel.match(/onLeave=\{\(\) => onLeaveHuddleCall\?\.\(\)\}/g)).toHaveLength(2);
        expect(dash).toContain('onLeaveHuddleCall={handleLeaveHuddleFromPanel}');
        const fn = between(dash, 'const handleLeaveHuddleFromPanel = useCallback(() => {', '}, [handleLeaveHuddleCall]);');
        expect(fn).toContain('handleLeaveHuddleCall({ deliberate: true })');
    });

    it('the floating card draws no leave control of its own', () => {
        const floating = read('components', 'call', 'FloatingHuddleCard.tsx');
        expect(floating).toContain('onLeave={() => {}}');
        expect(floating).not.toMatch(/leaveHuddleCall|handleDisconnectCall/);
    });

    it('switching calls (both server paths + the DM-call answer) is deliberate', () => {
        const prev = [...dash.matchAll(/leaveHuddleCall\(prevCall([^)]*)\)/g)].map(m => m[1]);
        expect(prev).toHaveLength(3);
        for (const a of prev) expect(a).toContain('deliberate: true');
    });

    it('fullscreen reuses the SAME ControlBar (no second leave control exists)', () => {
        expect(sources.filter(s => /^\s*<ControlBar\b/m.test(s.text)).map(s => s.file)).toEqual(['components/SidebarConference.tsx']);
        const fs = read('components', 'call', 'FullscreenOverlay.tsx');
        expect(fs).not.toMatch(/onLeave|handleDisconnectCall|leaveHuddleCall/);
    });

    it('the ONLY file that POSTs a huddle-call leave is useServers.leaveHuddleCall', () => {
        const posters = sources.filter(s => /huddles\/calls\/\$\{[^}]*\}\/leave/.test(s.text)).map(s => s.file);
        expect(posters).toEqual(['hooks/useServers.ts']);
    });

    it('every leaveHuddleCall(...) call site in src is accounted for, with its flag', () => {
        expect(leaveSites(sources).sort()).toEqual([
            // switching calls: deliberate
            'components/Dashboard.tsx: leaveHuddleCall(prevCall, { deliberate: true })',
            'components/Dashboard.tsx: leaveHuddleCall(prevCall, { deliberate: true })',
            'components/Dashboard.tsx: leaveHuddleCall(prevCall, { deliberate: true })',
            // the shared Leave chain (button, hotkey, panel menu): deliberate arrives as a variable
            'components/Dashboard.tsx: leaveHuddleCall(callId, { deliberate })',
            'components/Dashboard.tsx: leaveHuddleCall(callId, { deliberate })',
            // undoing a superseded join: NEVER deliberate (it would end the call it just made)
            'components/Dashboard.tsx: leaveHuddleCall(res.call_id)',
            'components/Dashboard.tsx: leaveHuddleCall(res.call_id)',
        ].sort());
    });

    it('everything that reaches the shared chain without the user choosing stays non-deliberate', () => {
        // inactivity auto-leave: bare handleLeave() (defaults to false)
        expect(conf).toContain('if (inactivityCountdown <= 0) { handleLeave(); return; }');
        expect(conf).toContain('const handleLeave = (deliberate: boolean = false) => {');
        // LiveKit onDisconnected (drop / kicked / server removal): onDisconnect() with NO args
        const disc = between(pane, 'onDisconnected={(reason) => {', 'onError={(err) => {');
        expect(disc).toContain('if (handling.teardown) onDisconnect();');
        expect(disc).not.toMatch(/onDisconnect\([^)]/);
        // connection / encryption failures route through stableOnLeave() with no args
        expect(pane.slice(pane.indexOf('const failConnection'), pane.indexOf('const failEncryption'))).toContain('stableOnLeave()');
        // the Dashboard callers other than the CallPane forwarder pass at most wasLastPerson (never `deliberate`)
        const args = [...dash.matchAll(/handleDisconnectCall(?:Ref\.current\?)?\.?\(([^)]*)\)/g)]
            .map(m => m[1].trim())
            .filter(a => !a.startsWith('wasLastPerson: boolean'));
        expect(args.filter(a => a.includes('deliberate'))).toEqual(['wasLastPerson, deliberate === true']);
    });

    it('quitting the app sends no leave at all (non-deliberate by construction): no unload / quit hook posts one', () => {
        for (const s of sources) {
            if (!/beforeunload|pagehide|sendBeacon/.test(s.text)) continue;
            expect(s.text, s.file).not.toMatch(/huddles\/calls|leaveHuddleCall|handleDisconnectCall/);
        }
        const electron = readdirSync(join(SRC, '..', 'electron')).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
        for (const f of electron) {
            expect(readFileSync(join(SRC, '..', 'electron', f), 'utf8'), f).not.toMatch(/huddles\/calls\/[^`'"]*leave/);
        }
    });

    it('"leave while still connecting" and the key-wait Leave stay non-deliberate', () => {
        expect(dash).toContain('void handleDisconnectCall(false);');
        const joiningLeave = between(dash, 'phase={joinPhase}', '/>');
        expect(joiningLeave).not.toContain('deliberate');
    });
});

describe('ordering: the deliberate leave is sent BEFORE the room is torn down', () => {
    it('handleLeaveHuddleCall holds the teardown (send -> wait for answer -> clear) when the leave would end the call', () => {
        expect(holdBranchSendsFirst(dash)).toBe(true);
        expect(dash).toContain('shouldHoldTeardownForLeaveAck(deliberate, callRow, channel, userId)');
    });

    it('the hold branch only clears what is still THIS call (a join made while waiting is not wiped)', () => {
        const hold = between(dash, 'await waitForLeaveAck(sent);', 'return;');
        expect(hold).toContain('setActiveHuddleCallId(cur => (cur === callId ? null : cur));');
        expect(hold).toContain('setActiveCall(cur => (cur?.id === callId ? null : cur));');
    });

    it('handleDisconnectCall leaves the clearing of activeCall to the huddle leave', () => {
        expect(disconnectDefersToHuddleLeave(dash)).toBe(true);
    });

    it('a second Leave while the first waits is ignored (no second request)', () => {
        expect(dash).toContain('if (leavingHuddleCallRef.current === callId) return;');
        expect(dash).toContain('leavingHuddleCallRef.current = null;');
    });

    it('every other leave still tears down at once, before sending (unchanged latency)', () => {
        const tail = between(dash, '// Optimistic update: clear local state immediately so the card', '}, [activeHuddleCallId, activeHuddleChannelId, serverChannels');
        expect(tail.indexOf('setActiveCall(null)')).toBeGreaterThan(-1);
        expect(tail.indexOf('setActiveCall(null)')).toBeLessThan(tail.indexOf('leaveHuddleCall(callId, { deliberate })'));
    });
});

describe('the request is not aborted by the teardown', () => {
    const fn = between(servers, 'const leaveHuddleCall = useCallback(', 'const { destroyed }');

    it('no AbortController / signal / cancel token on the leave POST, and it is retried', () => {
        expect(fn).not.toMatch(/AbortController|signal|CancelToken|abort\(/);
        expect(fn).toContain('fetchWithRetry(');
        expect(fn).toContain('const body = leaveRequestBody(opts?.deliberate);');
    });

    it('leaveHuddleCall lives in useServers (app-level state), not in CallPane/SidebarConference, so unmounting them cannot cancel it', () => {
        for (const [name, src] of [['CallPane', pane], ['SidebarConference', conf]] as const) {
            expect(src, name).not.toMatch(/huddles\/calls|leaveHuddleCall/);
        }
    });

    it('axios/fetch are never wired to an abort signal anywhere in the leave chain', () => {
        const chain = between(dash, 'const handleLeaveHuddleCall = useCallback(', '}, [activeHuddleCallId, activeHuddleChannelId, serverChannels');
        expect(chain).not.toMatch(/AbortController|signal/);
    });
});

describe('negative control: the scans can fail', () => {
    it('reordering the hold branch (teardown before send) is caught', () => {
        const broken = dash.replace(
            'const sent = leaveHuddleCall(callId, { deliberate }).catch(err =>',
            'setActiveCall(null);\n            const sent = leaveHuddleCall(callId, { deliberate }).catch(err =>',
        );
        expect(broken).not.toBe(dash);
        expect(holdBranchSendsFirst(broken)).toBe(false);
    });

    it('dropping the wait is caught', () => {
        const broken = dash.replace('await waitForLeaveAck(sent);', '');
        expect(holdBranchSendsFirst(broken)).toBe(false);
    });

    it('handleDisconnectCall clearing activeCall unconditionally again is caught', () => {
        const broken = dash.replace('if (!huddleLeaveOwnsTeardown) setActiveCall(null);', 'setActiveCall(null);');
        expect(disconnectDefersToHuddleLeave(broken)).toBe(false);
    });

    it('a new unlisted leaveHuddleCall call site would change the inventory', () => {
        const before = leaveSites(sources);
        const after = leaveSites([...sources, { file: 'components/NewButton.tsx', text: 'onClick={() => leaveHuddleCall(id)}' }]);
        expect(after).toHaveLength(before.length + 1);
        expect(after).toContain('components/NewButton.tsx: leaveHuddleCall(id)');
    });
});
