// Channel-key scenario harness — the coordinator.
//
//   node run.mjs <before|after> <scenario|all> [runs=5]
//
// Expects the isolated API on CKH_API (default http://127.0.0.1:3197/v1) and
// its Postgres on 127.0.0.1:5497 (see run.sh, which does all of this). Forks
// one headless device (out/<mode>/client.cjs) per holder / joiner / leaver.
// Writes one JSON line per run to out/results-<mode>.jsonl and prints a
// per-scenario summary with pass/fail against the acceptance criteria.
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, openSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = process.env.CKH_MAIN_NODE_MODULES ?? '/home/antigravity/Cipherline';
const req = createRequire(join(MAIN, 'apps/api/package.json'));
const pg = req('pg');
const jwt = req('jsonwebtoken');

const [modeArg, which = 'all', runsArg = '5'] = process.argv.slice(2);
// `both`: before and after run INTERLEAVED (run i of before, then run i of
// after, …) against two APIs (CKH_API_BEFORE / CKH_API_AFTER), so a box shared
// with other work loads both sides alike.
const MODES = modeArg === 'both' ? ['before', 'after'] : [modeArg];
const API_URLS = {
    before: process.env.CKH_API_BEFORE ?? process.env.CKH_API ?? 'http://127.0.0.1:3197/v1',
    after: process.env.CKH_API_AFTER ?? process.env.CKH_API ?? 'http://127.0.0.1:3197/v1',
};
// A second API replica (CKH_REPLICAS=2 in run.sh): devices alternate between
// the two, which share Postgres and Redis (pub/sub fan-out), as prod pods do.
const API_URLS_2 = { before: process.env.CKH_API_BEFORE_2, after: process.env.CKH_API_AFTER_2 };
let deviceSeq = 0;
let mode = MODES[0];
const RUNS = Number(runsArg);
const N_HOLDERS = Number(process.env.CKH_HOLDERS ?? 15);
const N_CHANNELS = Number(process.env.CKH_CHANNELS ?? 20);
const N_EPOCHS = Number(process.env.CKH_EPOCHS ?? 15);
const OBSERVE_MS = Number(process.env.CKH_OBSERVE_MS ?? 100_000);
const SECRET = process.env.CKH_JWT_SECRET ?? 'ckh-harness-secret-0123456789abcdef0123456789';
const OUT = join(here, 'out');
mkdirSync(join(OUT, 'logs'), { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const dbs = {};
for (const m of MODES) {
    dbs[m] = new pg.Client({ host: '127.0.0.1', port: 5497, user: 'ckh', password: 'ckh', database: MODES.length === 1 && process.env.CKH_DB ? process.env.CKH_DB : `ckh_${m}` });
    await dbs[m].connect();
}
let db = dbs[mode];

let seq = 0;
async function mkUser(name) {
    const r = await db.query(
        `INSERT INTO users (username, discriminator, password_hash) VALUES ($1, $2, 'x') RETURNING user_id`,
        [`${name}${Date.now() % 1e7}${seq++}`, 1000 + (seq % 9000)]);
    const id = r.rows[0].user_id;
    await db.query(`UPDATE users SET subscription_status = 'active' WHERE user_id = $1`, [id]).catch(() => undefined);
    return { id, token: jwt.sign({ user_id: id }, SECRET, { algorithm: 'HS256', expiresIn: '6h' }) };
}

const procs = new Set();
function device(name, user, runTag) {
    const out = openSync(join(OUT, 'logs', `${mode}-${runTag}-${name}.log`), 'a');
    const api = API_URLS_2[mode] && (deviceSeq++ % 2 === 1) ? API_URLS_2[mode] : API_URLS[mode];
    const p = fork(join(OUT, mode, 'client.cjs'), [], { stdio: ['ignore', out, out, 'ipc'], env: { ...process.env, CKH_API: api } });
    procs.add(p);
    let n = 0;
    const pending = new Map();
    const keys = [];
    const rotations = [];
    p.on('message', (m) => {
        if (m.event === 'key') keys.push(m);
        else if (m.event === 'rotated') rotations.push(m);
        else if (m.id && pending.has(m.id)) { const { resolve, reject, cmd } = pending.get(m.id); pending.delete(m.id); m.ok ? resolve(m.result) : reject(new Error(`${name}.${cmd}: ${m.error}`)); }
    });
    const call = (cmd, args = {}) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject, cmd }); p.send({ id, cmd, args }); });
    const kill = () => { try { p.kill('SIGKILL'); } catch { /* */ } procs.delete(p); };
    return { name, user, call, keys, rotations, kill, info: null };
}
function killAll() { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* */ } } procs.clear(); }
process.on('exit', killAll);
process.on('SIGINT', () => { killAll(); process.exit(130); });
process.on('SIGTERM', () => { killAll(); process.exit(143); });

async function retry429(fn) {
    for (;;) {
        try { return await fn(); } catch (e) { if (!/HTTP 429/.test(String(e))) throw e; await sleep(2_000); }
    }
}

/** Fresh server: N text channels × E epochs; every holder (and leaver) holds every key and is online. */
async function setup(runTag, { leavers = 0 } = {}) {
    const O = await mkUser('own');
    const owner = device('H0', O, runTag);
    owner.info = await owner.call('init', { name: 'H0', userId: O.id, token: O.token });
    const srv = await owner.call('http', { method: 'POST', path: '/servers', body: { name: `Keys ${runTag}` } });
    const sid = srv.server_id ?? srv.server?.server_id;
    let chans = (await owner.call('http', { method: 'GET', path: `/servers/${sid}/channels` })).filter(c => c.kind === 'text');
    for (let i = chans.length; i < N_CHANNELS; i++) {
        await retry429(() => owner.call('http', { method: 'POST', path: `/servers/${sid}/channels`, body: { name: `ch-${i}`, kind: 'text' } }));
    }
    chans = (await owner.call('http', { method: 'GET', path: `/servers/${sid}/channels` })).filter(c => c.kind === 'text').map(c => c.channel_id);
    // Setup shortcut (not under test): the owner mints every epoch locally and
    // registers it directly; every holder is handed the key material.
    const material = await owner.call('mintLocal', { channelIds: chans, epochs: N_EPOCHS });
    const t0 = Date.now() - N_EPOCHS * 60_000;
    for (const cid of chans) {
        for (const k of material[cid]) {
            await db.query(
                `INSERT INTO server_sender_key_meta (server_id, channel_id, epoch, created_at, rotation_reason, key_fingerprint_b64)
                 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
                [sid, cid, k.epoch, new Date(t0 + k.epoch * 60_000), k.epoch === 1 ? 'create' : 'periodic', k.fp]);
        }
    }
    const code = (await owner.call('http', { method: 'POST', path: `/servers/${sid}/invites`, body: {} })).code;
    const holders = [owner];
    for (let i = 1; i < N_HOLDERS; i++) {
        const U = await mkUser(`h${i}`);
        const h = device(`H${i}`, U, runTag);
        h.info = await h.call('init', { name: `H${i}`, userId: U.id, token: U.token });
        await h.call('acceptSilently', { code });
        await h.call('installKeys', { keys: material });
        holders.push(h);
    }
    const leaverDevs = [];
    for (let i = 0; i < leavers; i++) {
        const U = await mkUser(`l${i}`);
        const l = device(`L${i}`, U, runTag);
        l.info = await l.call('init', { name: `L${i}`, userId: U.id, token: U.token });
        await l.call('acceptSilently', { code });
        await l.call('installKeys', { keys: material });
        leaverDevs.push(l);
    }
    for (const h of [...holders, ...leaverDevs]) await h.call('connect');
    await sleep(6_000); // connect sweeps settle (nothing is missing anywhere)
    // The on-screen channel's newest page: 50 messages across the epochs, newest last.
    const viewChannelId = chans[0];
    const viewRows = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, epoch: Math.max(1, N_EPOCHS - Math.floor((49 - i) / 5)) }));
    return { sid, chans, code, holders, leavers: leaverDevs, viewChannelId, viewRows };
}

async function newJoiner(name, runTag) {
    const U = await mkUser(name);
    const j = device(name, U, runTag);
    j.info = await j.call('init', { name, userId: U.id, token: U.token });
    await j.call('connect');
    return j;
}

async function latestEpochs(sid) {
    const r = await db.query(`SELECT channel_id, MAX(epoch)::int AS e, MAX(created_at) AS at FROM server_sender_key_meta WHERE server_id = $1 GROUP BY channel_id`, [sid]);
    return new Map(r.rows.map(x => [x.channel_id, { epoch: x.e, at: new Date(x.at).getTime() }]));
}

/** Everything one run measures, for each joiner. */
async function measure(s, joiners, extra = {}) {
    const q = (xs, p) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
    const latest = await latestEpochs(s.sid);
    const onlineHolders = s.holders.filter(h => !h.offline);
    const heldByOnline = new Map(s.chans.map(c => [c, new Set()]));
    for (const h of onlineHolders) {
        const st = await h.call('status', { channelIds: s.chans });
        for (const c of s.chans) for (const e of st[c] ?? []) heldByOnline.get(c).add(e);
    }
    const out = [];
    for (const j of joiners) {
        const rep = await j.call('report');
        const st = await j.call('status', { channelIds: s.chans });
        const stored = j.keys.filter(k => k.stored === 'stored');
        const firstAt = new Map();
        for (const k of stored) { const key = `${k.channel}:${k.epoch}`; if (!firstAt.has(key)) firstAt.set(key, k.t); }
        const currentMs = [];
        let currentMissing = 0;
        for (const c of s.chans) {
            const L = latest.get(c);
            const t = firstAt.get(`${c}:${L.epoch}`);
            if (t === undefined) { if (!(st[c] ?? []).includes(L.epoch)) currentMissing++; continue; }
            currentMs.push(Math.max(0, t - Math.max(j.joinedAt, L.at)));
        }
        // "All historical epochs": every epoch an online member holds.
        let completeAt = j.joinedAt; let historyMissing = 0;
        const missingDetail = {};
        for (const c of s.chans) {
            for (const e of heldByOnline.get(c)) {
                const t = firstAt.get(`${c}:${e}`);
                if (t === undefined) { if (!(st[c] ?? []).includes(e)) { historyMissing++; (missingDetail[c.slice(0, 8)] ??= []).push(e); } continue; }
                completeAt = Math.max(completeAt, t);
            }
        }
        const allMs = historyMissing ? null : completeAt - j.joinedAt;
        const dev = j.info.deviceId;
        const env = await db.query(
            `SELECT channel_id, epoch, created_at, acked_at FROM server_key_envelopes WHERE recipient_device_id = $1 AND server_id = $2`, [dev, s.sid]);
        const pairs = new Set(env.rows.map(r => `${r.channel_id}:${r.epoch}`));
        const lateAfter = completeAt + 60_000;
        const lateEnvelopes = historyMissing ? null : env.rows.filter(r => new Date(r.created_at).getTime() > lateAfter).length;
        let latePosts = 0;
        if (!historyMissing) for (const h of s.holders) {
            const hr = await h.call('report').catch(() => null);
            latePosts += (hr?.postsByRecipientDevice?.[dev] ?? []).filter(t => t > lateAfter).length;
        }
        const open = await db.query(`SELECT channel_id, epochs, routed_to, escalate_at, created_at, newest_acked_at FROM channel_key_requests WHERE requester_device_id = $1 AND fulfilled_at IS NULL`, [dev]);
        const openDetail = open.rows.map(r => ({ ch: r.channel_id.slice(0, 8), epochs: r.epochs, routed: (r.routed_to ?? []).length, created: r.created_at, newestAcked: r.newest_acked_at, latest: latest.get(r.channel_id)?.epoch, heldByOnline: [...(heldByOnline.get(r.channel_id) ?? [])].sort((a, b) => a - b).join(',') }));
        let servableOpen = 0; let orphanOpen = 0;
        for (const r of open.rows) {
            const want = r.epochs ?? [latest.get(r.channel_id)?.epoch];
            const servable = want.some(e => heldByOnline.get(r.channel_id)?.has(e) && !(st[r.channel_id] ?? []).includes(e));
            if (servable) servableOpen++; else if (want.some(e => !(st[r.channel_id] ?? []).includes(e))) orphanOpen++;
        }
        const reasksLastMin = Object.values(rep.stats.keyRequestsByChannel).flat().filter(t => t > Date.now() - 60_000).length;
        // Banner: shown while the newest message on screen was readable; and flaps.
        let bannerWithKey = 0; let bannerOn = 0;
        let prev = false;
        for (const p of rep.bannerTimeline) {
            if (p.banner && p.newestHeld) bannerWithKey++;
            if (p.banner && !prev) bannerOn++;
            prev = p.banner;
        }
        const kr = [...((rep.stats.httpMs ?? {})['POST /servers/:id/channels/:id/key-request'] ?? []), ...((rep.stats.httpMs ?? {})['POST /servers/:id/key-requests'] ?? [])];
        const firstAskMs = kr.length ? Math.min(...kr.map(x => x[0])) - j.joinedAt : null;
        const lastAskMs = kr.length ? Math.max(...kr.map(x => x[0] + x[1])) - j.joinedAt : null;
        out.push({
            joiner: j.name, currentMs, firstAskMs, lastAskMs, missingDetail, openDetail: open.rows.length ? openDetail : undefined, currentMissing, allMs, historyMissing,
            envelopes: env.rows.length, pairs: pairs.size, copies: pairs.size ? env.rows.length / pairs.size : 0,
            lateEnvelopes, latePosts, servableOpen, orphanOpen, reasksLastMin,
            bannerWithKey, bannerOnTransitions: bannerOn, bannerFlaps: Math.max(0, bannerOn - 1),
            stats: rep.stats, features: rep.features,
        });
    }
    let holderPosts = 0; let holder429 = 0; let skipped = 0; let minted = 0; let stoodDown = 0;
    const postMs = []; const listMs = []; let passes = 0; const byReason = {}; const passesBy = {}; let pushesIn = 0;
    for (const h of [...s.holders, ...s.leavers]) {
        const r = await h.call('report').catch(() => null);
        if (!r) continue;
        postMs.push(...(r.stats.postMs ?? [])); listMs.push(...(r.stats.listMs ?? [])); passes += r.stats.passes ?? 0;
        for (const [k, v] of Object.entries(r.stats.postsByReason ?? {})) byReason[k] = (byReason[k] ?? 0) + v;
        for (const [k, v] of Object.entries(r.stats.passesBy ?? {})) passesBy[k] = (passesBy[k] ?? 0) + v;
        pushesIn += r.stats.pushesIn ?? 0;
        holderPosts += r.stats.handshakePosts; holder429 += r.stats.handshake429; skipped += r.stats.handshakeSkippedDevices;
        minted += r.stats.rotationsMinted; stoodDown += r.stats.rotationsStoodDown;
    }
    // API latency by route, joiners and holders apart (first 40 s after the first join only).
    const t0 = Math.min(...joiners.map(j => j.joinedAt));
    const httpBy = async (devs) => {
        const acc = {};
        for (const d of devs) {
            const r = await d.call('report').catch(() => null);
            for (const [k, v] of Object.entries(r?.stats?.httpMs ?? {})) for (const [at, ms] of v) if (at >= t0 && at <= t0 + 40_000) (acc[k] ??= []).push(ms);
        }
        return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, { n: v.length, p50: q(v, 0.5), p95: q(v, 0.95) }]));
    };
    const http = { joiners: await httpBy(joiners), holders: await httpBy([...s.holders, ...s.leavers]) };
    const rot = await db.query(`SELECT count(*)::int AS n FROM server_sender_key_meta WHERE server_id = $1 AND rotation_reason = 'member_left'`, [s.sid]);
    return { http, holderTiming: { postP50: q(postMs, 0.5), postP95: q(postMs, 0.95), listP50: q(listMs, 0.5), listP95: q(listMs, 0.95), lists: listMs.length, passes, passesBy, pushesIn, distributeCallsByReason: byReason }, joiners: out, holderPosts, holder429, skippedDevices: skipped, rotationsMinted: minted, rotationsStoodDown: stoodDown, memberLeftEpochs: rot.rows[0].n, ...extra };
}

/** Append rows under each new epoch of the on-screen channel (chatter after a rotation). */
function followRotations(s, joiners) {
    let last = N_EPOCHS;
    const t = setInterval(async () => {
        const r = await db.query(`SELECT MAX(epoch)::int AS e FROM server_sender_key_meta WHERE channel_id = $1`, [s.viewChannelId]).catch(() => null);
        const e = r?.rows?.[0]?.e;
        if (e && e > last) {
            last = e;
            const rows = [0, 1, 2].map(i => ({ id: `r${e}-${i}`, epoch: e }));
            setTimeout(() => { for (const j of joiners) void j.call('appendViewRows', { rows }).catch(() => undefined); }, 2_000);
        }
    }, 500);
    return () => clearInterval(t);
}

async function joinServer(j, s) {
    j.joinedAt = Date.now();
    await j.call('join', { code: s.code, viewChannelId: s.viewChannelId, viewRows: s.viewRows });
}

const SCENARIOS = {
    async 'one-joiner'(tag) {
        const s = await setup(tag);
        const j = await newJoiner('J1', tag);
        await joinServer(j, s);
        await sleep(OBSERVE_MS);
        return measure(s, [j]);
    },
    async 'two-joiners-20s'(tag) {
        const s = await setup(tag);
        const a = await newJoiner('J1', tag); const b = await newJoiner('J2', tag);
        await joinServer(a, s);
        await sleep(20_000);
        await joinServer(b, s);
        await sleep(OBSERVE_MS);
        return measure(s, [a, b]);
    },
    async 'leave-then-join'(tag) {
        const s = await setup(tag, { leavers: 1 });
        const j = await newJoiner('J1', tag);
        const stop = followRotations(s, [j]);
        const gap = Math.floor(Math.random() * 6_000);
        await s.leavers[0].call('leave', { serverId: s.sid });
        await sleep(gap);
        await joinServer(j, s);
        await sleep(OBSERVE_MS);
        stop();
        return measure(s, [j], { leaveToJoinMs: gap });
    },
    async 'ten-joiners'(tag) {
        const s = await setup(tag);
        const js = [];
        for (let i = 1; i <= 10; i++) js.push(await newJoiner(`J${i}`, tag));
        await Promise.all(js.map(j => joinServer(j, s)));
        await sleep(OBSERVE_MS);
        return measure(s, js);
    },
    async 'holder-offline-mid'(tag) {
        const s = await setup(tag);
        const j = await newJoiner('J1', tag);
        await joinServer(j, s);
        await sleep(3_000);
        // The holders that have sent this joiner the most so far go offline.
        const r = await db.query(`SELECT sender_user_id, count(*)::int AS n FROM server_key_envelopes WHERE recipient_device_id = $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 5`, [j.info.deviceId]);
        const gone = new Set(r.rows.map(x => x.sender_user_id));
        for (const h of s.holders) if (gone.has(h.user.id)) { await h.call('disconnect'); h.offline = true; }
        await sleep(OBSERVE_MS);
        return measure(s, [j], { holdersTakenOffline: gone.size });
    },
    async 'double-rotation-then-join'(tag) {
        const s = await setup(tag, { leavers: 2 });
        const j = await newJoiner('J1', tag);
        const stop = followRotations(s, [j]);
        await s.leavers[0].call('leave', { serverId: s.sid });
        await sleep(2_500);
        await s.leavers[1].call('leave', { serverId: s.sid });
        await sleep(2_000);
        await joinServer(j, s);
        await sleep(OBSERVE_MS);
        stop();
        return measure(s, [j]);
    },
};

function pct(xs, p) { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)]; }
function summarize(name, runs) {
    const js = runs.flatMap(r => r.joiners);
    const cur = js.flatMap(j => j.currentMs);
    const all = js.map(j => j.allMs).filter(x => x !== null);
    const sum = {
        scenario: name, mode, runs: runs.length, joinersMeasured: js.length,
        current: { p50: pct(cur, 0.5), p95: pct(cur, 0.95), max: pct(cur, 1), missing: js.reduce((a, j) => a + j.currentMissing, 0) },
        allHistory: { p50: pct(all, 0.5), p95: pct(all, 0.95), max: pct(all, 1), incomplete: js.filter(j => j.allMs === null).length },
        copiesAvg: js.length ? +(js.reduce((a, j) => a + j.copies, 0) / js.length).toFixed(2) : null,
        copiesMax: js.length ? +Math.max(...js.map(j => j.copies)).toFixed(2) : null,
        lateEnvelopes: js.reduce((a, j) => a + (j.lateEnvelopes ?? 0), 0),
        latePosts: js.reduce((a, j) => a + (j.latePosts ?? 0), 0),
        servableOpenRequests: js.reduce((a, j) => a + j.servableOpen, 0),
        orphanOpenRequests: js.reduce((a, j) => a + j.orphanOpen, 0),
        reasksLastMinute: js.reduce((a, j) => a + j.reasksLastMin, 0),
        bannerWithKey: js.reduce((a, j) => a + j.bannerWithKey, 0),
        bannerFlaps: js.reduce((a, j) => a + j.bannerFlaps, 0),
        holderPosts: runs.reduce((a, r) => a + r.holderPosts, 0),
        holder429: runs.reduce((a, r) => a + r.holder429, 0),
        memberLeftEpochs: runs.map(r => r.memberLeftEpochs),
    };
    sum.pass = {
        current15s: sum.current.p95 !== null && sum.current.p95 <= 15_000 && sum.current.missing === 0,
        history30s: sum.allHistory.p95 !== null && sum.allHistory.p95 <= 30_000 && sum.allHistory.incomplete === 0,
        copiesLe2: sum.copiesAvg !== null && sum.copiesAvg <= 2,
        noLateSends: sum.lateEnvelopes === 0,
        noServableOpen: sum.servableOpenRequests === 0,
        noReaskLoop: sum.reasksLastMinute === 0,
        bannerHonest: sum.bannerWithKey === 0 && sum.bannerFlaps === 0,
    };
    return sum;
}

const names = which === 'all' ? Object.keys(SCENARIOS) : which.split(',');
for (const name of names) {
    const runsByMode = Object.fromEntries(MODES.map(m => [m, []]));
    for (let i = 0; i < RUNS; i++) {
        for (const m of MODES) {
            mode = m; db = dbs[m];
            const tag = `${name}-${i}`;
            try {
                const r = await SCENARIOS[name](tag);
                runsByMode[m].push(r);
                appendFileSync(join(OUT, `results-${m}.jsonl`), JSON.stringify({ mode: m, scenario: name, run: i, at: new Date().toISOString(), ...r }) + '\n');
                const j0 = r.joiners[0];
                console.log(`[${m}] ${tag}: current p95=${pct(r.joiners.flatMap(j => j.currentMs), 0.95)}ms missing=${r.joiners.reduce((a, j) => a + j.currentMissing, 0)} all=${r.joiners.map(j => j.allMs).join(',')} copies=${j0.copies.toFixed(2)} late=${j0.lateEnvelopes} servableOpen=${j0.servableOpen} banner(withKey=${j0.bannerWithKey},flaps=${j0.bannerFlaps}) memberLeftEpochs=${r.memberLeftEpochs} timing=${JSON.stringify(r.holderTiming)}`);
            } catch (e) {
                console.log(`[${m}] ${tag}: HARNESS ERROR ${e?.stack ?? e}`);
            } finally {
                killAll();
                await sleep(1_000);
            }
        }
    }
    for (const m of MODES) {
        mode = m;
        const sum = summarize(name, runsByMode[m]);
        appendFileSync(join(OUT, `summary-${m}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...sum }) + '\n');
        console.log('SUMMARY ' + JSON.stringify(sum));
    }
}
for (const m of MODES) await dbs[m].end();
process.exit(0);
