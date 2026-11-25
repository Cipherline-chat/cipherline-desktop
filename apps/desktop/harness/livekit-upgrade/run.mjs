// LiveKit server upgrade harness: the same scripted DM call against whatever LiveKit you point it at,
// so a candidate server version can be compared with the one prod runs. THROWAWAY servers only.
//
// Setup (from apps/desktop; everything else lives in a scratch dir S, nothing binds a host port):
//   docker network create lkup-net        # LiveKit at a static IP; Chromium on the host reaches it directly
//   throwaway postgres + redis on lkup-net; LiveKit started from a copy of prod's livekit-config with
//     use_external_ip false, node_ip = its lkup-net IP, its own redis db, webhook urls = the test API AND
//     http://<lkup-net gateway>:<API port + 5000>/hook (this script's recorder), TURN UDP on,
//     and on 1.12+ `turn.allow_restricted_peer_cidrs: [<node ip>/32]` (prod's node IP is public);
//   the worktree API (tsc-emitted dist, NODE_ENV=development) with LIVEKIT_URL / INTERNAL_LIVEKIT_URL at it;
//   two seeded users (A paid, B free, accepted friends, one DM).
//   OUT_DIR=$S/dist npx vite build -c harness/livekit-upgrade/vite.config.ts
//
// Run:
//   node harness/livekit-upgrade/run.mjs --mode functional --lk-ip 172.20.0.10 --api http://127.0.0.1:13005 \
//     --dist $S/dist --out $S/f-113.json --conv <dm id> --user-a <id> --user-b <id> --jwt-cmd 'node $S/mint.cjs'
//   node harness/livekit-upgrade/run.mjs --mode soak --lk-ip 172.20.0.10 --container <lk container> \
//     --minutes 25 --dist $S/dist --out $S/soak-113.jsonl
//
// functional: API call start/join tokens (free tier = microphone-only grant), E2EE audio both ways, camera +
//   screen share decoded under E2EE, the SFU refusing a free-tier camera, encrypted data packets, the API's
//   RoomService calls (listRooms / listParticipants / updateParticipant / mutePublishedTrack /
//   removeParticipant), metric names, leave + rejoin, an 8 s and a 30 s network freeze (SIGSTOP of one
//   client's whole browser), forced TURN relay, a hard client kill, webhooks (verified with the API's
//   WebhookReceiver), room_finished and the API closing the session.
// soak: two participants each sharing a 1080p screen (+ a camera on A), plus churn (a third client
//   joining/leaving every 20 s, a 6 s freeze of B every 3 min); samples container memory and LiveKit's
//   own go_goroutines / heap metrics every 30 s.
// hold: an E2EE call held for --seconds while you stop/replace LiveKit containers from outside
//   (k8s Recreate: `docker stop -t 30` the old one, start the new version at the same IP on the same
//   redis db); --lk-ip-b sends B's signalling to a second node (cross-node / cross-version relay).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const ROOT = '/home/antigravity/Cipherline';
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? `${ROOT}/node_modules/playwright-core`);
const SDK = await import(process.env.LK_SDK ?? `${ROOT}/node_modules/livekit-server-sdk/dist/index.js`);
const { AccessToken, RoomServiceClient, WebhookReceiver, TrackSource } = SDK;
const exe = process.env.CHROME_EXE ?? (() => {
    const base = path.join(process.env.HOME, '.cache/ms-playwright');
    const dirs = fs.readdirSync(base).filter(d => d.startsWith('chromium_headless_shell-')).sort();
    return path.join(base, dirs[dirs.length - 1], 'chrome-headless-shell-linux64/chrome-headless-shell');
})();

const LK_IP = args['lk-ip']; if (!LK_IP) throw new Error('--lk-ip');
if (!/^(10|172|192\.168|127)\./.test(LK_IP)) throw new Error('refusing a non-private LiveKit address');
const LK_URL = `ws://${LK_IP}:7880`;
const LK_KEY = process.env.LK_KEY ?? 'lkupkey';
const LK_SECRET = process.env.LK_SECRET ?? 'lkupsecret0123456789abcdef0123456789abcdef';
const MODE = args.mode ?? 'functional';
const OUT = path.resolve(args.out);
const DIST = path.resolve(args.dist);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const log = (...m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...m);

// ---- static server for the page + webhook recorder ----
const hooks = [];
const receiver = new WebhookReceiver(LK_KEY, LK_SECRET);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/hook') {
        let body = ''; req.on('data', c => { body += c; });
        req.on('end', async () => {
            try {
                const e = await receiver.receive(body, req.headers.authorization ?? '');
                hooks.push({ t: Date.now() - T0, event: e.event, room: e.room?.name, who: e.participant?.identity, track: e.track?.source });
            } catch (err) { hooks.push({ t: Date.now() - T0, event: 'REJECTED', err: String(err?.message ?? err) }); }
            res.writeHead(200); res.end();
        });
        return;
    }
    const f = path.join(DIST, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
    if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': mime[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
});
const apiPort = args.api ? Number(new URL(args.api).port) : 0;
const HOOK_PORT = Number(args['hook-port'] ?? (apiPort ? apiPort + 5000 : 0));
await new Promise(r => server.listen(HOOK_PORT, '0.0.0.0', r));
const PAGE = `http://127.0.0.1:${server.address().port}/index.html`;

// ---- browsers ----
const CHROME_ARGS = ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
const browsers = [];
async function client(name) {
    // A marker flag so this browser's main process (and through it, its whole tree) can be signalled.
    const marker = `--lkup-client=${name}-${randomBytes(4).toString('hex')}`;
    const browser = await chromium.launch({ executablePath: exe, args: [...CHROME_ARGS, marker] });
    browsers.push(browser);
    const pid = Number(execFileSync('pgrep', ['-o', '-f', marker.slice(2)], { encoding: 'utf8' }).trim());
    const page = await browser.newPage();
    page.on('pageerror', e => log(`${name} pageerror: ${String(e).slice(0, 200)}`));
    await page.goto(PAGE);
    await page.waitForFunction(() => window.HREADY === true);
    const call = (fn, a) => page.evaluate(([f, x]) => window.H[f](x), [fn, a]);
    return { name, browser, page, call, pid };
}
function tree(pid) {
    const out = [pid];
    for (let i = 0; i < out.length; i++) {
        try { out.push(...execFileSync('pgrep', ['-P', String(out[i])], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)); } catch { /* none */ }
    }
    return out;
}
const signal = (c, sig) => { const pids = tree(c.pid); for (const p of pids) { try { process.kill(p, sig); } catch { /* gone */ } } return pids.length; };

async function mintToken(identity, room, grant = {}) {
    const at = new AccessToken(LK_KEY, LK_SECRET, { identity, ttl: '2h' });
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, ...grant });
    return at.toJwt();
}
const jwtGrant = (tok) => JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).video;

async function metricsSnapshot() {
    const txt = await (await fetch(`http://${LK_IP}:6789/metrics`)).text();
    const val = (re) => { const m = txt.match(re); return m ? Number(m[1]) : null; };
    return {
        txt,
        goroutines: val(/^go_goroutines (\S+)$/m),
        heapInuse: val(/^go_memstats_heap_inuse_bytes (\S+)$/m),
        rss: val(/^process_resident_memory_bytes (\S+)$/m),
        rooms: val(/^livekit_room_total\{[^}]*\} (\S+)$/m),
        participants: val(/^livekit_participant_total\{[^}]*\} (\S+)$/m),
    };
}
function containerMem(name) {
    try { return execFileSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}|{{.CPUPerc}}', name], { encoding: 'utf8' }).trim(); } catch { return null; }
}

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); log(`${ok ? 'PASS' : 'FAIL'} ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ''); }
const peerVideos = (s, who) => s.videos.filter(v => v.who === who);
const evAfter = (s, tMs) => s.events.filter(e => e.t >= tMs).map(e => e.e + (e.reason !== undefined ? `(${e.reason})` : '') + (e.who ? `:${e.who.slice(0, 4)}` : ''));
async function audioWindow(cs, ms = 5000) {
    for (const c of cs) await c.call('stats', true);
    await sleep(ms);
    const out = {};
    for (const c of cs) { const s = await c.call('stats'); out[c.name] = s.audio; }
    return out;
}
const audioOk = (a) => a.frames > 0 && a.good / a.frames > 0.6;

async function api(pathname, token, body) {
    const r = await fetch(`${args.api}/v1${pathname}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-cipherline-version': '9.9.9' }, body: JSON.stringify(body ?? {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${pathname} ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    return j;
}

async function functional() {
    const jwtA = execSync(`${args['jwt-cmd']} ${args['user-a']}`, { encoding: 'utf8' }).trim();
    const jwtB = execSync(`${args['jwt-cmd']} ${args['user-b']}`, { encoding: 'utf8' }).trim();
    const A_ID = args['user-a'], B_ID = args['user-b'];
    const keyB64 = randomBytes(32).toString('base64');
    const rs = new RoomServiceClient(`http://${LK_IP}:7880`, LK_KEY, LK_SECRET);

    // 1. tokens through the API
    const start = await api('/calls/start', jwtA, { conversation_id: args.conv });
    const SID = start.session_id;
    const joinB = await api(`/calls/${SID}/join`, jwtB);
    check('api.tokens', start.livekit_token && joinB.livekit_token, { url: start.livekit_url, grantA: jwtGrant(start.livekit_token).canPublishSources ?? 'all', grantB: jwtGrant(joinB.livekit_token).canPublishSources });
    check('api.free_tier_grant_is_mic_only', JSON.stringify(jwtGrant(joinB.livekit_token).canPublishSources) === '["microphone"]');

    const A = await client('A'), B = await client('B');
    let sA = await A.call('join', { url: LK_URL, token: start.livekit_token, keyB64, toneHz: 440, expectHz: 660 });
    let sB = await B.call('join', { url: LK_URL, token: joinB.livekit_token, keyB64, toneHz: 660, expectHz: 440 });
    check('join.connected', sA.state === 'connected' && sB.state === 'connected', { a: sA.events.map(e => e.e), b: sB.events.map(e => e.e), server: sA.events.find(e => e.e === 'connected')?.serverVersion });
    await sleep(4000);
    let aw = await audioWindow([A, B]);
    sA = await A.call('stats'); sB = await B.call('stats');
    const e2eeActive = (s) => s.events.some(e => e.e === 'e2ee_active') && !s.events.some(e => e.e === 'e2ee_failure');
    check('e2ee.activated_both', e2eeActive(sA) && e2eeActive(sB));
    check('audio.both_ways_decrypted', audioOk(aw.A) && audioOk(aw.B), aw);
    check('audio.remote_mic_gcm', sA.events.some(e => e.e === 'track_subscribed' && e.kind === 'audio' && e.gcm) && sB.events.some(e => e.e === 'track_subscribed' && e.kind === 'audio' && e.gcm));

    // 2. camera + screen share under E2EE
    const cam = await A.call('publishCamera', { codec: 'vp8' });
    const scr = await A.call('publishScreen', { codec: 'h264', res: '1080p', fps: 15 });
    await sleep(3000);
    const m = await metricsSnapshot();
    check('metrics.names_present', /^livekit_room_total\{/m.test(m.txt) && /^livekit_participant_total\{/m.test(m.txt) && /^livekit_packet_bytes\{[^}]*direction="incoming"/m.test(m.txt) && /^livekit_packet_bytes\{[^}]*direction="outgoing"/m.test(m.txt), { rooms: m.rooms, participants: m.participants });
    const v1 = peerVideos(await B.call('stats'), A_ID);
    await sleep(6000);
    sB = await B.call('stats'); sA = await A.call('stats');
    const v2 = peerVideos(sB, A_ID);
    const dec = (src) => { const a = v1.find(v => v.source === src), b = v2.find(v => v.source === src); return b ? { fps: b.fps, w: b.w, h: b.h, codec: b.codec, gcm: b.gcm, decoded6s: (b.framesDecoded ?? 0) - (a?.framesDecoded ?? 0), plis: b.plis, freezes: b.freezes } : null; };
    const camD = dec('camera'), scrD = dec('screen_share');
    check('video.camera_decoded_e2ee', cam.ok && camD && camD.gcm && camD.decoded6s > 60, camD);
    check('video.screen_share_decoded_e2ee', scr.ok && scrD && scrD.gcm && scrD.decoded6s > 40, scrD);
    check('e2ee.no_encryption_errors', !sA.events.some(e => e.e === 'encryption_error') && !sB.events.some(e => e.e === 'encryption_error'));
    check('e2ee.sender_codec_pin_fired', sA.events.filter(e => e.e === 'codec_pin').map(e => e.m));

    // 3. free tier: the SFU must refuse B's camera even when the client skips its own check
    const tPub = (await B.call('stats')).t;
    const freeCam = await B.call('publishCamera', { codec: 'vp8', bypassClientCheck: true });
    await sleep(3000);
    sA = await A.call('stats');
    const bCamAtA = peerVideos(sA, B_ID).filter(v => v.source === 'camera');
    check('free_tier.sfu_refuses_camera', bCamAtA.length === 0, { publishResult: freeCam, bEvents: evAfter(await B.call('stats'), tPub) });

    // 4. encrypted data packets both ways
    await A.call('sendData', 20); await B.call('sendData', 20);
    await sleep(2000);
    sA = await A.call('stats'); sB = await B.call('stats');
    const got = (s, from) => s.data.filter(d => d.from === from && /#\d+$/.test(d.text)).length;
    check('data.reliable_both_ways', got(sA, B_ID) >= 20 && got(sB, A_ID) >= 20, { atA: got(sA, B_ID), atB: got(sB, A_ID), topics: [...new Set(sB.data.map(d => d.topic))] });

    // 5. RoomService API surface the API uses
    const rooms = await rs.listRooms([SID]);
    const parts = await rs.listParticipants(SID);
    check('roomservice.listRooms_listParticipants', rooms.length === 1 && rooms[0].numParticipants === 2 && parts.length === 2,
        { numParticipants: rooms[0]?.numParticipants, ids: parts.map(p => p.identity.slice(0, 4)), aTracks: parts.find(p => p.identity === A_ID)?.tracks.map(tr => tr.source) });
    const tPerm = (await B.call('stats')).t;
    await rs.updateParticipant(SID, B_ID, { permission: { canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA] } });
    await sleep(1500);
    const bPerm = await B.call('stats');
    const camB = await B.call('publishCamera', { codec: 'vp8' });
    await sleep(5000);
    const bCam2 = peerVideos(await A.call('stats'), B_ID).filter(v => v.source === 'camera');
    check('roomservice.updateParticipant_grants_camera', camB.ok && bCam2.length === 1 && (bCam2[0].framesDecoded ?? 0) > 30, { perms: bPerm.perms, events: evAfter(bPerm, tPerm), decoded: bCam2[0]?.framesDecoded });
    const aMic = (await rs.listParticipants(SID)).find(p => p.identity === A_ID)?.tracks.find(tr => tr.source === TrackSource.MICROPHONE);
    await rs.mutePublishedTrack(SID, A_ID, aMic.sid, true);
    await sleep(1000);
    aw = await audioWindow([B], 3000);
    check('roomservice.mutePublishedTrack_silences', aw.B.good / Math.max(1, aw.B.frames) < 0.1, aw.B);
    await A.call('unmuteMic');
    await sleep(1500);
    aw = await audioWindow([B], 3000);
    check('client.unmute_after_server_mute', audioOk(aw.B), aw.B);
    await B.call('unpublishVideo');

    // 6. leave + rejoin
    let h0 = hooks.length;
    await B.call('leave');
    await sleep(3000);
    sA = await A.call('stats');
    check('leave.peer_sees_disconnect', sA.events.some(e => e.e === 'participant_disconnected' && e.who === B_ID));
    check('webhook.participant_left_on_leave', hooks.slice(h0).some(h => h.event === 'participant_left' && h.who === B_ID), hooks.slice(h0).map(h => h.event));
    const rejoin = await api(`/calls/${SID}/join`, jwtB);
    sB = await B.call('join', { url: LK_URL, token: rejoin.livekit_token, keyB64, toneHz: 660, expectHz: 440 });
    await sleep(5000);
    aw = await audioWindow([A, B]);
    const vRe = peerVideos(await B.call('stats'), A_ID);
    check('rejoin.audio_and_video', audioOk(aw.A) && audioOk(aw.B) && vRe.length === 2 && vRe.every(v => (v.framesDecoded ?? 0) > 10), { aw, vids: vRe.map(v => [v.source, v.framesDecoded]) });

    // 7. brief network freeze (8 s) of B: the server keeps it, the client resumes
    for (const [label, secs, settle] of [['freeze8', 8, 15], ['freeze30', 30, 30]]) {
        h0 = hooks.length;
        const tb = (await B.call('stats')).t, ta = (await A.call('stats')).t;
        signal(B, 'SIGSTOP');
        await sleep(secs * 1000);
        signal(B, 'SIGCONT');
        await sleep(settle * 1000);
        sB = await B.call('stats'); sA = await A.call('stats');
        aw = await audioWindow([A, B]);
        const vids = peerVideos(await B.call('stats'), A_ID);
        const bOk = sB.state === 'connected' && audioOk(aw.A) && audioOk(aw.B) && vids.length === 2;
        check(`${label}.recovered`, bOk, { bState: sB.state, bEvents: evAfter(sB, tb), aEvents: evAfter(sA, ta), hooks: hooks.slice(h0).map(h => `${h.event}:${(h.who ?? '').slice(0, 4)}`), aw, vids: vids.map(v => [v.source, v.fps]) });
    }

    // 8. forced TURN relay (UDP) for a fresh client with B's identity (this also kicks B: duplicate identity)
    const C = await client('C');
    const tokC = (await api(`/calls/${SID}/join`, jwtB)).livekit_token;
    await C.call('join', { url: LK_URL, token: tokC, keyB64, toneHz: 660, expectHz: 440, relay: true });
    await sleep(5000);
    aw = await audioWindow([A, C]);
    const sC = await C.call('stats');
    check('turn.relay_call', sC.state === 'connected' && sC.pair?.local === 'relay' && audioOk(aw.A) && audioOk(aw.C), { pair: sC.pair, aw, cEvents: sC.events.map(e => e.e) });
    sB = await B.call('stats');
    check('duplicate_identity.old_session_kicked', sB.events.some(e => e.e === 'disconnected'), sB.events.filter(e => e.e === 'disconnected'));

    // 9. hard kill of C: how fast does the server notice?
    h0 = hooks.length;
    const tKill = Date.now();
    signal(C, 'SIGKILL');
    let seenAt = null, hookAt = null;
    for (let i = 0; i < 90 && (seenAt === null || hookAt === null); i++) {
        await sleep(1000);
        sA = await A.call('stats');
        if (seenAt === null && sA.remotes.length === 0) seenAt = Date.now() - tKill;
        if (hookAt === null && hooks.slice(h0).some(h => h.event === 'participant_left' && h.who === B_ID)) hookAt = Date.now() - tKill;
    }
    check('kill.server_detects_dead_client', seenAt !== null && hookAt !== null, { peerSawLeaveMs: seenAt, webhookMs: hookAt });

    // 10. last one out: room_finished + the API closing its session
    h0 = hooks.length;
    await A.call('leave');
    let roomFinished = null;
    for (let i = 0; i < 60 && roomFinished === null; i++) { await sleep(1000); if (hooks.slice(h0).some(h => h.event === 'room_finished')) roomFinished = i + 1; }
    check('webhook.room_finished', roomFinished !== null, { afterS: roomFinished });
    let closed = null;
    for (let i = 0; i < 150 && closed === null; i++) {
        await sleep(2000);
        const v = execFileSync('docker', ['exec', 'lkup-pg', 'psql', '-U', 'lkup', '-d', 'lkup', '-Atc', `select active from call_sessions where id='${SID}'`], { encoding: 'utf8' }).trim();
        if (v === 'f') closed = (i + 1) * 2;
    }
    check('api.session_closed_after_call', closed !== null, { afterS: closed });
    check('webhook.none_rejected', !hooks.some(h => h.event === 'REJECTED'), { kinds: [...new Set(hooks.map(h => h.event))] });
    fs.writeFileSync(OUT, JSON.stringify({ lk: LK_IP, results, hooks }, null, 1));
}

async function soak() {
    const minutes = Number(args.minutes ?? 25);
    const room = `soak-${randomBytes(4).toString('hex')}`;
    const keyB64 = randomBytes(32).toString('base64');
    const A = await client('A'), B = await client('B');
    await A.call('join', { url: LK_URL, token: await mintToken('soak-a', room), keyB64, toneHz: 440, expectHz: 660 });
    await B.call('join', { url: LK_URL, token: await mintToken('soak-b', room), keyB64, toneHz: 660, expectHz: 440 });
    await A.call('publishCamera', { codec: 'vp8' });
    await A.call('publishScreen', { codec: 'h264', res: '1080p', fps: 30 });
    await B.call('publishScreen', { codec: 'vp8', res: '1080p', fps: 30 });
    const C = await client('C');
    let cIn = false, n = 0;
    const out = fs.createWriteStream(OUT);
    const end = Date.now() + minutes * 60_000;
    let nextSample = Date.now(), nextChurn = Date.now() + 20_000, nextFreeze = Date.now() + 180_000;
    while (Date.now() < end) {
        if (Date.now() >= nextChurn) {
            nextChurn += 20_000;
            if (cIn) await C.call('leave'); else await C.call('join', { url: LK_URL, token: await mintToken(`soak-c-${n++}`, room), keyB64, toneHz: 880, expectHz: 440 });
            cIn = !cIn;
        }
        if (Date.now() >= nextFreeze) { nextFreeze += 180_000; signal(B, 'SIGSTOP'); await sleep(6000); signal(B, 'SIGCONT'); }
        if (Date.now() >= nextSample) {
            nextSample += 30_000;
            const m = await metricsSnapshot().catch(() => ({}));
            const sB = await B.call('stats').catch(() => null);
            const sA = await A.call('stats').catch(() => null);
            const row = { t: Math.round((Date.now() - T0) / 1000), docker: containerMem(args.container), goroutines: m.goroutines, heapInuseMB: m.heapInuse && +(m.heapInuse / 2 ** 20).toFixed(1),
                rssMB: m.rss && +(m.rss / 2 ** 20).toFixed(1), participants: m.participants,
                bSees: sB?.videos.map(v => `${v.source}:${v.fps ?? 0}`).join(','), aSees: sA?.videos.map(v => `${v.source}:${v.fps ?? 0}`).join(','), bState: sB?.state };
            out.write(JSON.stringify(row) + '\n');
            log(JSON.stringify(row));
        }
        await sleep(1000);
    }
    out.end();
}

// hold: keep an E2EE call (audio both ways + A's camera) up for --seconds while the operator swaps or
// overlaps LiveKit containers from outside; every 5 s prints each side's state, peer-audio ratio and
// A-camera fps at B. --lk-ip-b puts B's signalling on a second node (cross-node/cross-version relay).
async function hold() {
    const secs = Number(args.seconds ?? 120);
    const room = args.room ?? `hold-${randomBytes(4).toString('hex')}`;
    const keyB64 = randomBytes(32).toString('base64');
    const urlB = args['lk-ip-b'] ? `ws://${args['lk-ip-b']}:7880` : LK_URL;
    const A = await client('A'), B = await client('B');
    const sA0 = await A.call('join', { url: LK_URL, token: await mintToken('hold-a', room), keyB64, toneHz: 440, expectHz: 660 });
    const sB0 = await B.call('join', { url: urlB, token: await mintToken('hold-b', room), keyB64, toneHz: 660, expectHz: 440 });
    log('joined', sA0.events.find(e => e.e === 'connected'), sB0.events.find(e => e.e === 'connected'));
    await A.call('publishCamera', { codec: 'vp8' });
    const out = fs.createWriteStream(OUT);
    const end = Date.now() + secs * 1000;
    let seenA = 0, seenB = 0;
    while (Date.now() < end) {
        const aw = await audioWindow([A, B], 5000);
        const sA = await A.call('stats'), sB = await B.call('stats');
        const cam = sB.videos.find(v => v.source === 'camera');
        const row = { t: Math.round((Date.now() - T0) / 1000), a: sA.state, b: sB.state,
            aHearsB: aw.A.frames ? +(aw.A.good / aw.A.frames).toFixed(2) : 0, bHearsA: aw.B.frames ? +(aw.B.good / aw.B.frames).toFixed(2) : 0,
            camAtB: cam ? cam.framesDecoded : null, newEventsA: sA.events.slice(seenA).map(e => e.e + (e.reason !== undefined ? `(${e.reason})` : '')),
            newEventsB: sB.events.slice(seenB).map(e => e.e + (e.reason !== undefined ? `(${e.reason})` : '')) };
        seenA = sA.events.length; seenB = sB.events.length;
        out.write(JSON.stringify(row) + '\n');
        log(JSON.stringify(row));
    }
    out.end();
}

try {
    if (MODE === 'soak') await soak(); else if (MODE === 'hold') await hold(); else await functional();
} catch (e) {
    log('RUN ERROR', e?.stack ?? e);
    results.push({ name: 'run', ok: false, detail: String(e?.message ?? e) });
    if (MODE === 'functional') fs.writeFileSync(OUT, JSON.stringify({ lk: LK_IP, results, hooks }, null, 1));
} finally {
    for (const b of browsers) { try { await b.close(); } catch { /* killed */ } }
    server.close();
    const failed = results.filter(r => !r.ok).length;
    log(`done: ${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
}
