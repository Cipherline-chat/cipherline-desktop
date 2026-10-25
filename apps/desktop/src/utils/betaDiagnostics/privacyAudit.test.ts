/**
 * Beta diagnostics — PRIVACY SELF-AUDIT.
 *
 * Representative failures are pushed through the REAL entry points the app
 * uses (deliveryDiagnostics.record, logCallEvent, captureError, the key-wait
 * tracker, ChatPane's send-failure detail, the profile builder, the call
 * summary + rating) with identifying material planted in every input:
 * conversation / channel / envelope / server / peer ids (UUIDs and not),
 * e-mails, usernames, home-directory paths, IPs. Then every byte the
 * transport was handed is audited:
 *
 *   - no UUID-shaped string other than session_id / call_summary_id;
 *   - no e-mail; no path into a user directory; no IP;
 *   - no planted id / name, in any form;
 *   - every `detail` key matches /^[a-z0-9_]{1,32}$/ (≤ 12 keys) and every
 *     value is number | boolean | /^[A-Za-z0-9_.:-]{0,64}$/;
 *   - `message` only on unhandled_error, ≤ 300 chars.
 *
 * POSITIVE CONTROL: the same audit run over a deliberately leaky payload must
 * report every planted violation — so a green audit is not a vacuous one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { betaReporter, type BetaRoute } from './reporter';
import { installBetaBridges } from './bridges';
import { keyWaitTracker, KEY_UNANSWERED_MS } from './detectors';
import { beginBetaCall, endBetaCall, noteBetaCallEnd, __resetBetaCallForTests } from './callSession';
import { sendFailureDetail, setBetaSensitiveTerms, setBetaScrubber } from './sanitize';
import { createScrubber } from '../diagnostics/scrub';
import { buildProfile } from './profile';
import { record as recordDelivery } from '../deliveryDiagnostics';
import { logCallEvent } from '../callEventLog';
import { captureError } from '../diagnostics/recentErrors';
import { fallbackSystemInfo } from '../diagnostics/ipc';
import { reportBeta } from './reporter';

const CONV = '7d1f0c2a-9b4e-4c1d-8a2f-3e5b6c7d8e9f';
const CHANNEL = 'a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d';
const ENVELOPE = 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f';
const SERVER = '11112222-3333-4444-8555-666677778888';
const PEER = '99998888-7777-4666-9555-444433332222';
// Ids that are not UUID-shaped: only ever handed over in STRUCTURED fields.
const NON_UUID_IDS = ['conv_q8Zr2LmN', 'chan_88aa77'];
// Names the app holds (usernames, display names, a server name) — what
// collectSensitiveTerms() hands the host; free text is scrubbed against them.
const NAMES = ['alice.wonder', 'Alice Wonderland', 'BobTheBuilder', 'srv-alpha-bravo'];
const EMAIL = 'alice.wonder@example.com';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const USER_DIR_RE = /(?:[A-Za-z]:\\+Users\\+|\/home\/|\/Users\/)[^\s"\\/]+/;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const DETAIL_KEY = /^[a-z0-9_]{1,32}$/;
const DETAIL_STR = /^[A-Za-z0-9_.:-]{0,64}$/;

interface Sent { route: BetaRoute; body: Record<string, unknown> }

/** The audit. Returns every violation found (empty = clean). */
export function auditPayloads(sent: readonly Sent[], allowedUuids: ReadonlySet<string>): string[] {
    const bad: string[] = [];
    const planted = [CONV, CHANNEL, ENVELOPE, SERVER, PEER, ...NON_UUID_IDS, ...NAMES, EMAIL];
    for (const { route, body } of sent) {
        const json = JSON.stringify(body);
        for (const u of json.match(UUID_RE) ?? []) if (!allowedUuids.has(u)) bad.push(`${route}: foreign uuid ${u}`);
        if (EMAIL_RE.test(json)) bad.push(`${route}: email`);
        if (USER_DIR_RE.test(json)) bad.push(`${route}: user-dir path`);
        if (IP_RE.test(json)) bad.push(`${route}: ip`);
        for (const p of planted) if (json.toLowerCase().includes(p.toLowerCase())) bad.push(`${route}: planted ${p}`);
        const events = route === 'events' ? (body.events as Array<Record<string, unknown>>) : [];
        for (const ev of events) {
            const d = ev.detail as Record<string, unknown> | undefined;
            if (d) {
                if (Object.keys(d).length > 12) bad.push(`${ev.kind}: >12 detail keys`);
                for (const [k, v] of Object.entries(d)) {
                    if (!DETAIL_KEY.test(k)) bad.push(`${ev.kind}: detail key ${k}`);
                    const ok = typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && DETAIL_STR.test(v));
                    if (!ok) bad.push(`${ev.kind}: detail value ${k}`);
                }
            }
            if (ev.message !== undefined && (ev.kind !== 'unhandled_error' || String(ev.message).length > 300)) bad.push(`${ev.kind}: message`);
        }
    }
    return bad;
}

const sent: Sent[] = [];
let uninstall: () => void = () => {};

beforeAll(async () => {
    sent.length = 0;
    betaReporter.configure({ appVersion: '1.0.23', platform: 'linux', transport: async (route, body) => { sent.push({ route, body: JSON.parse(JSON.stringify(body)) }); return { ok: true }; } });
    betaReporter.setServerEnabled(true); betaReporter.setLocalEnabled(true); betaReporter.setSignedIn(true);
    uninstall = installBetaBridges();
    // What the host installs from the app's live name list (collectSensitiveTerms).
    setBetaSensitiveTerms(NAMES);
    setBetaScrubber(createScrubber({ sensitiveTerms: NAMES, maxLength: 300 }));

    // Delivery failures, with ids in ctx and in the error text.
    recordDelivery('message_decrypt', new Error(`[E2EE:BAD_MAC] envelope ${ENVELOPE} in ${CONV} from ${EMAIL}`), { envelope_id: ENVELOPE, conversation_id: CONV });
    recordDelivery('channel_key_decrypt', new Error(`[E2EE:EPOCH_CONFLICT] ${CHANNEL} epoch 4`), { envelope_id: ENVELOPE, channel_id: CHANNEL, epoch: 4 });
    recordDelivery('message_ack', Object.assign(new Error(`ack failed for ${ENVELOPE}`), { response: { status: 503 } }), { envelope_ids: `${ENVELOPE},${CONV}` });
    recordDelivery('channel_key_distribute', new Error(`x ${SERVER}`), { server_id: SERVER, recipient_user_id: PEER });
    recordDelivery('message_process', new Error('bad content'), { conversation_id: NON_UUID_IDS[0], channel_id: NON_UUID_IDS[1] });

    // Call engine events (placeholders only by contract) + the e2ee / share failures.
    logCallEvent('reconnecting');
    logCallEvent('e2ee_decrypt_error', { reason: 'missing_key' });
    logCallEvent('share_start', { verdict: 'failed', why: 'NotReadableError' });
    logCallEvent('mic_device_switch', { reason: 'default_changed', to_default: true, verdict: 'failed' });

    // An unhandled error full of identifying text.
    const err = new TypeError(`Cannot read 'x' of ${CONV}: /home/alice.wonder/Documents/secret.docx, C:\\Users\\Alice Wonderland\\x.txt, ${EMAIL}, @BobTheBuilder, 10.1.2.3:443, srv-alpha-bravo`);
    err.stack = `TypeError: boom\n    at onMessage (/home/alice.wonder/.config/cipherline/app.asar/dist/assets/index-Ab1.js:10:20)\n    at C:\\Users\\Alice Wonderland\\AppData\\Local\\x\\chunk.js:3:4`;
    captureError('error', err);
    captureError('unhandledrejection', `rejected ${PEER} for ${EMAIL}`);

    // A send failure whose error mentions the conversation.
    reportBeta('msg_send_failed', sendFailureDetail(Object.assign(new Error(`POST /v1/conversations/${CONV}/messages failed`), { response: { status: 500 } }), 'dm'));
    reportBeta('msg_send_failed', sendFailureDetail(new Error(`[E2EE:NO_BUNDLE] ${CHANNEL} ${EMAIL}`), 'channel'));

    // A key request that is never answered (channel id only as a map key).
    const realNow = Date.now;
    keyWaitTracker.noteAsked(CHANNEL, { targetEpoch: 3, heldEpoch: null });
    Date.now = () => realNow() + KEY_UNANSWERED_MS + 1;
    keyWaitTracker.tick();
    Date.now = realNow;
    keyWaitTracker.clear();

    // A detail that tries to smuggle ids / free text in.
    reportBeta('app_freeze', { ms: 1500, phase: CONV, channel_id: CHANNEL, note: 'hello there', who: NAMES[0] });

    // Device profile with a home dir in odd places.
    betaReporter.sendProfile(buildProfile({
        ...fallbackSystemInfo('1.0.23'), os_version: '6.8.0-142-generic', arch: 'x64', cpu_model: 'Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz',
        cpu_cores: 12, ram_gb: 31.2, gpu: { devices: [{ vendor_id: '0x8086', device_id: '0x3e92', active: true, driver_version: '23.2.1' }], feature_status: {} },
    }, { webglRenderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)', audioInputs: 2, audioOutputs: 2, webcams: 1, networkType: 'unknown', localeLang: 'en', devicePixelRatio: 1 }));

    // A call: summary at end, then a rating.
    __resetBetaCallForTests();
    const t = beginBetaCall({ callType: 'group', e2ee: true }, Date.now() - 120_000);
    logCallEvent('participants', { count: 3 });
    logCallEvent('ice_route', { pc: 'subscriber', type: 'relay', local: 'relay', remote: 'host', turn: true, protocol: 'turn-udp' });
    noteBetaCallEnd('user');
    endBetaCall(t);
    await betaReporter.flush();
    const summary = sent.find(s => s.route === 'call-summary');
    if (summary) betaReporter.rateCall(String(summary.body.call_summary_id), 3, ['echo', 'one_way']);
    await betaReporter.flush();
});

afterAll(() => {
    uninstall();
    setBetaSensitiveTerms([]);
    setBetaScrubber(null);
    betaReporter.setSignedIn(false);
    betaReporter.setServerEnabled(false);
    betaReporter.configure({ transport: null });
    __resetBetaCallForTests();
});

describe('beta diagnostics privacy self-audit', () => {
    it('sent every kind of payload (the audit has something to look at)', () => {
        const routes = new Set(sent.map(s => s.route));
        expect(routes).toEqual(new Set(['events', 'profile', 'call-summary']));
        const kinds = new Set(sent.filter(s => s.route === 'events').flatMap(s => (s.body.events as Array<{ kind: string }>).map(e => e.kind)));
        for (const k of ['key_decrypt_failed', 'msg_fetch_gap', 'call_reconnect', 'call_e2ee_error', 'share_failed', 'mic_failed',
            'unhandled_error', 'msg_send_failed', 'key_request_unanswered', 'app_freeze']) expect(kinds, k).toContain(k);
        expect(sent.filter(s => s.route === 'call-summary')).toHaveLength(2); // summary + rating
    });

    it('no identifier, e-mail, path, IP or name leaks; detail and message follow the contract', () => {
        const allowed = new Set<string>([betaReporter.sessionId]);
        for (const s of sent) if (typeof s.body.call_summary_id === 'string') allowed.add(s.body.call_summary_id);
        expect(auditPayloads(sent, allowed)).toEqual([]);
    });

    it('the smuggling attempt lost every unsafe key, kept the measurement', () => {
        const freeze = sent.filter(s => s.route === 'events').flatMap(s => s.body.events as Array<{ kind: string; detail?: Record<string, unknown> }>).find(e => e.kind === 'app_freeze');
        expect(freeze?.detail).toEqual({ ms: 1500 });
    });

    it('POSITIVE CONTROL: the audit catches every planted violation in a leaky payload', () => {
        const leaky: Sent[] = [{
            route: 'events',
            body: {
                session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                events: [
                    { kind: 'app_freeze', at: 'x', message: 'not allowed here', detail: { conversation_id: CONV, 'Bad-Key': 1, text: 'free text with spaces' } },
                    { kind: 'unhandled_error', at: 'x', message: `${EMAIL} at /home/alice.wonder/x.js 10.0.0.1 ${'y'.repeat(300)}` },
                    { kind: 'msg_send_failed', at: 'x', detail: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, i])) },
                ],
            },
        }];
        const v = auditPayloads(leaky, new Set(['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']));
        expect(v).toEqual(expect.arrayContaining([
            `events: foreign uuid ${CONV}`,
            'events: email',
            'events: user-dir path',
            'events: ip',
            `events: planted ${CONV}`,
            `events: planted ${EMAIL}`,
            'app_freeze: detail key Bad-Key',
            'app_freeze: detail value text',
            'app_freeze: message',
            'unhandled_error: message',
            'msg_send_failed: >12 detail keys',
        ]));
    });
});
