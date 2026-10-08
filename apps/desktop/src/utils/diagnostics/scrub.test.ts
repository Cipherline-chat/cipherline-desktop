import { describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import {
    createScrubber, scrubDeep, reducePath, looksLikeEncodedBlob, normalizeText,
    MAX_SCRUB_INPUT, KEY_RE,
} from './scrub';

const s = createScrubber({
    sensitiveTerms: ['Alice Wonder', 'bobby_tables', 'Gaming Den', 'Secret Project Room', 'zoë', 'x'],
    homeDir: 'C:\\Users\\Dawson K',
});
const plain = createScrubber();

/** Every planted secret must be gone from `out` (case-insensitive). */
// The two fuzz tests scrub 18,000 random tokens each (~2 s alone). In a full
// parallel `vitest run` on a loaded box that blew vitest's default 5 s budget
// — a timeout, not a miss — so they get an explicit one.
const FUZZ_TIMEOUT_MS = 60_000;

/**
 * Deterministic key fuzz. The old version drew from crypto.randomBytes, so a
 * rare real leak (a SID-looking run inside a random base64url key) showed up
 * as an unreproducible failure. Seeded: a miss prints the seed and key.
 * SCRUB_FUZZ_ITERS / SCRUB_FUZZ_SEED scale it for a one-off big sweep
 * (iters x 2 sizes x 3 encodings keys; 90000 iters = 540k keys).
 */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function seededBytes(rng: () => number, n: number): Buffer {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = Math.floor(rng() * 256);
    return b;
}
const FUZZ_SEED = Number(process.env.SCRUB_FUZZ_SEED ?? 20261007);
const FUZZ_ITERS = Number(process.env.SCRUB_FUZZ_ITERS ?? 3000);
const FUZZ_BIG_TIMEOUT_MS = Math.max(FUZZ_TIMEOUT_MS, FUZZ_ITERS * 6);

function expectNone(out: string, planted: string[]) {
    const lower = out.toLowerCase();
    for (const p of planted) expect(lower, `leaked "${p}" in: ${out}`).not.toContain(p.toLowerCase());
}

describe('paths and the home directory', () => {
    it('removes a Windows home dir with a space in the username and a spaced file name', () => {
        const out = s.text("ENOENT: no such file, open 'C:\\Users\\Dawson K\\Documents\\secret plan.docx'");
        expect(out).toBe("ENOENT: no such file, open '<path>'");
    });
    it('removes a home dir it was not told about', () => {
        const out = plain.text('EPERM C:\\Users\\jsmith\\AppData\\Roaming\\Cipherline\\secure.db');
        expectNone(out, ['jsmith', 'secure.db', 'AppData']);
    });
    it('keeps a code location from a packaged build', () => {
        expect(plain.text('at x (C:\\Program Files\\Cipherline\\resources\\app.asar\\dist-electron\\main.js:120:15)'))
            .toBe('at x (resources/app.asar/dist-electron/main.js:120:15)');
    });
    it('reduces file:// stack frames and drops the username', () => {
        const out = plain.text('at f (file:///C:/Users/jsmith/AppData/Local/Programs/cipherline/resources/app.asar/dist/assets/index-AbC12x9Z.js:1:23456)');
        expect(out).toBe('at f (file://resources/app.asar/dist/assets/index-AbC12x9Z.js:1:23456)');
    });
    it('handles POSIX homes, spaced macOS homes and /root', () => {
        const out = plain.text('/home/dawson/.config/Cipherline/secure.db and /Users/Jane Doe/Library/Application Support/notes.txt and /root/.ssh/id_rsa');
        expectNone(out, ['dawson', 'Jane', 'Doe', 'notes.txt', 'id_rsa', 'secure.db', 'Application Support']);
    });
    it('handles UNC shares and ~ paths with spaced names', () => {
        expectNone(plain.text('\\\\fileserver\\share\\Payroll Q3.xlsx missing'), ['fileserver', 'Payroll', 'Q3.xlsx']);
        expectNone(plain.text('~/Downloads/holiday photo.png'), ['holiday', 'photo']);
        expectNone(plain.text('~\\My Documents\\tax return 2025.pdf failed'), ['tax return', '2025.pdf', 'My Documents']);
    });
    it('never keeps a non-code basename even under a code anchor', () => {
        expect(reducePath('/home/u/Documents/src/plan-for-acquisition.txt')).toBe('<path>');
        expect(reducePath('C:\\work\\dist\\customer list.csv')).toBe('<path>');
    });
    it('keeps the innermost node_modules package for library frames', () => {
        expect(plain.text('at y (/home/u/app/node_modules/livekit-client/dist/livekit-client.esm.mjs:100:2)'))
            .toBe('at y (node_modules/livekit-client/dist/livekit-client.esm.mjs:100:2)');
    });
    it('scrubs ids inside a kept code path', () => {
        const id = randomUUID();
        const out = plain.text(`at z (/opt/app/resources/app.asar/dist/${id}/x.js:1:1)`);
        expect(out).not.toContain(id);
    });
    it('keeps API route paths but scrubs ids in them', () => {
        const id = randomUUID();
        expect(plain.text(`POST /v1/calls/${id}/join 500`)).toBe('POST /v1/calls/<id>/join 500');
    });
    it('turns other user-data roots into <path>', () => {
        expectNone(plain.text('open /Volumes/Backup Drive/Family Photos/kids.jpg'), ['Family', 'kids', 'Backup Drive']);
        expectNone(plain.text('read /tmp/upload-abc/contract final.pdf'), ['contract', 'final.pdf']);
    });
});

describe('URLs', () => {
    it('replaces unknown-host URLs entirely', () => {
        expect(plain.text('fetch https://evil.example.com/path/to/thing?q=hello failed')).toBe('fetch <url> failed');
        expect(plain.text('ws://203.0.113.9:7880/rtc?access_token=abc')).toBe('<url>');
    });
    it('keeps the code path for the API, drops the query and scrubs ids', () => {
        const id = randomUUID();
        expect(plain.text(`GET https://api.cipherline.chat/v1/conversations/${id}/messages?since=123&token=zz 500`))
            .toBe('GET https://api.cipherline.chat/v1/conversations/<id>/messages?<query> 500');
    });
    it('drops the object key and signature from presigned media URLs', () => {
        const out = plain.text(`GET https://media.cipherline.chat/attachments/${randomUUID()}?X-Amz-Signature=abcdef0123456789abcdef&X-Amz-Credential=AKIA123 failed`);
        expect(out).toBe('GET https://media.cipherline.chat/<path> failed');
    });
    it('keeps dev-server stack frames with line:col', () => {
        expect(plain.text('at g (http://localhost:5174/src/components/CallPane.tsx?t=1700000000123:45:9)'))
            .toBe('at g (http://localhost:5174/src/components/CallPane.tsx?<query>:45:9)');
    });
    it('strips userinfo credentials in URLs', () => {
        expectNone(plain.text('https://user:hunter2@api.cipherline.chat/v1/x'), ['hunter2', 'user:']);
    });
    it('does not let a name survive inside a kept URL path', () => {
        expectNone(s.text('https://api.cipherline.chat/v1/servers/bobby_tables/x'), ['bobby_tables']);
    });
});

describe('credentials and tokens', () => {
    it('redacts JWTs, Bearer tokens and key=value secrets', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl';
        const out = plain.text(`Authorization: Bearer abcdefghijklmnop123 jwt=${jwt} password=hunter2 {"refresh_token":"xyz123abc"} file_key_b64: QUJDREVGR0hJSktM`);
        expectNone(out, ['abcdefghijklmnop123', jwt, 'hunter2', 'xyz123abc', 'QUJDREVGR0hJSktM']);
    });
    it('redacts PEM blocks, even unterminated ones', () => {
        // Built from parts so the source never holds a literal key header: the public export
        // (scripts/release/export-public-desktop.sh) refuses any file that does.
        const pem = (edge: 'BEGIN' | 'END', kind: string) => `-----${edge} ${kind}-----`;
        expect(plain.text(`${pem('BEGIN', 'PRIVATE KEY')}\nMIIEvAAA\n${pem('END', 'PRIVATE KEY')}`)).toBe('<pem>');
        expectNone(plain.text(`x ${pem('BEGIN', 'EC PRIVATE KEY')}\nMHcCAQEE`), ['MHcCAQEE']);
    });
    it('redacts attestation and call/transfer keys by name', () => {
        expectNone(plain.text('x-cipherline-attest: v1.abc.def call_key=Zm9vYmFy transfer_key_b64="Zm9vYmFyYmF6"'), ['v1.abc.def', 'Zm9vYmFy', 'Zm9vYmFyYmF6']);
    });
    it('catches every random 32/64-byte key in base64, base64url and hex (seeded)', () => {
        const rng = mulberry32(FUZZ_SEED);
        const misses: string[] = [];
        let keys = 0;
        for (let i = 0; i < FUZZ_ITERS; i++) {
            for (const n of [32, 64]) {
                const b = seededBytes(rng, n);
                for (const t of [b.toString('base64'), b.toString('base64url'), b.toString('hex')]) {
                    keys++;
                    const out = plain.text(`k ${t} end`);
                    if (out.includes(t.slice(0, 10)) || out.includes(t.slice(-10))) misses.push(`seed=${FUZZ_SEED} i=${i} ${t} => ${out}`);
                }
            }
        }
        expect(keys).toBe(FUZZ_ITERS * 6);
        expect(misses).toEqual([]);
    }, FUZZ_BIG_TIMEOUT_MS);
    it('a random key with a LiveKit-SID-looking run inside is scrubbed as a WHOLE (no prefix or suffix survives)', () => {
        // The exact key a 3000-iteration fuzz once leaked: the SID rule's \b matched after
        // the '-' and rewrote only `PA_JY6C…`, leaving `wN4389W-XITWvZTRCYZAI-` in the report.
        const found = 'wN4389W-XITWvZTRCYZAI-PA_JY6CdJjMxy9oNmTiMo';
        expect(plain.text(`k ${found} end`)).toBe('k <b64> end');
        // Constructed from real random keys: overwrite a window of a seeded 32/64-byte key
        // (base64 and base64url, so every separator `+ / - _ =` occurs naturally) with an SID
        // of every prefix, at the start, in the middle and at the end.
        const rng = mulberry32(7);
        const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const leaks: string[] = [];
        let n = 0;
        for (const prefix of ['PA', 'TR', 'RM', 'PS', 'SS', 'EG', 'IN', 'DP', 'AG', 'SIP', 'ST', 'EP']) {
            for (const bytes of [32, 64]) {
                for (const enc of ['base64', 'base64url'] as const) {
                    for (const where of ['start', 'middle', 'end'] as const) {
                        for (let rep = 0; rep < 12; rep++) {
                            const key = seededBytes(rng, bytes).toString(enc).replace(/=+$/, '');
                            const sid = `${prefix}_${Array.from({ length: 12 }, () => ALNUM[Math.floor(rng() * 62)]).join('')}`;
                            const at = where === 'start' ? 0 : where === 'end' ? key.length - sid.length : Math.floor((key.length - sid.length) / 2);
                            const tok = key.slice(0, at) + sid + key.slice(at + sid.length);
                            const out = plain.text(`k ${tok} end`);
                            n++;
                            const probes = [tok.slice(0, at).slice(0, 10), tok.slice(at + sid.length).slice(-10)].filter(x => x.length === 10);
                            for (const pr of probes) if (out.includes(pr)) leaks.push(`${tok} => ${out}`);
                        }
                    }
                }
            }
        }
        expect(n).toBe(12 * 2 * 2 * 3 * 12);
        expect(leaks).toEqual([]);
    });
    it('catches the 43-char base64url key a 1.6M-key seeded fuzz found sitting exactly on the wordiness cut-off', () => {
        // seed=101 i=46064: churn 0.357, wordiness 0.800 — read as "words" at the old `< 0.8`.
        const key = '25OhbvSzlaLYulhxvoDFsxyaGEdfRAOWLM4MUuBWGNU';
        expect(plain.text(`k ${key} end`)).toBe('k <b64> end');
        // long camelCase identifiers (no lone 1–2 letter pieces) are still kept
        for (const id of ['audioOnlyParticipantsBaseFiltered', 'removeWindowAudioProcessExitedListener']) expect(plain.text(`at ${id}()`)).toContain(id);
    });
    it('a lone SID, and an SID inside ordinary words, are still just <sid>', () => {
        expect(plain.text('participant PA_hJ7kL9mN2pQ left')).toBe('participant <sid> left');
        expect(plain.text('room=RM_AbCdEf12345x ok')).toBe('room=<sid> ok');
        expect(plain.text('track-TR_AbCdEf12345x failed')).not.toContain('AbCdEf12345x');
    });
    it('catches the unpadded base64url keys that used to slip past the wordiness cut-off', () => {
        // Found by a 240k-key fuzz of the 0.65 threshold (1 in ~80k leaked).
        for (const key of [
            'gDXlpwoHInfHNRyycCOHLNJVKuiMS583yUexQX3whoo',
            'KUhkcJGRetK_QZKTaqczMjieiJOGMnaktStrswN46wk',
            'XFL2YKBuknaaMOGQOC-yjeTdyjcafdHHDvldnSgrbBo',
        ]) expectNone(plain.text(`k ${key} end`), [key.slice(0, 10)]);
        // …while long code identifiers are still kept.
        expect(plain.text('at MediaFoundationVideoEncodeAccelerator.encode')).toContain('MediaFoundationVideoEncodeAccelerator');
        expect(plain.text('handleScreenShareStartWithMediaFoundationVideoEncodeAccelerator failed')).toContain('handleScreenShareStartWithMediaFoundation');
    });
    it('catches ≥ 99.5% of random 16/24-byte tokens (documented residual)', () => {
        let misses = 0;
        let total = 0;
        for (let i = 0; i < 3000; i++) {
            for (const n of [16, 24]) {
                const b = randomBytes(n);
                for (const t of [b.toString('base64'), b.toString('base64url'), b.toString('hex')]) {
                    total++;
                    if (plain.text(`k ${t} end`).includes(t.slice(0, 10))) misses++;
                }
            }
        }
        expect(misses / total).toBeLessThan(0.005);
    }, FUZZ_TIMEOUT_MS);
    it('a key containing / is not split by the path rule (no prefix leak)', () => {
        const key = 'kwyFX9v45cJ+/ttzt4OLg4hF217/p88Ti+7gnjdmN/GpQusZGNbKt6DyeI8Ch==';
        const out = plain.text(`key material ${key} end`);
        expect(out).not.toContain('kwyFX9v45cJ');
    });
    it('leaves code identifiers, codec names and labels alone', () => {
        for (const id of ['handleScreenShareStart', 'getUserMediaStreamTrackProcessor', 'MediaFoundationVideoEncodeAccelerator',
            'qualityLimitationReason', 'rehydrate-avatars-batch2', 'ERR_INTERNET_DISCONNECTED', 'createScreenShareTrackWithAudio',
            'channelKeyRotationController2', 'SimulcastEncoderAdapter', 'VideoToolboxVideoEncoder', 'startup:hydrate']) {
            expect(plain.text(id)).toBe(id);
            expect(looksLikeEncodedBlob(id)).toBe(false);
        }
        expect(plain.text('video/H264 profile 42e01f, 2560x1440 at 90 fps, v1.0.17')).toBe('video/H264 profile 42e01f, 2560x1440 at 90 fps, v1.0.17');
    });
});

describe('identities and addresses', () => {
    it('removes emails, including full-width, zero-width-split and %40-encoded', () => {
        const out = plain.text('alice@example.com ｊｏｈｎ＠ｅｘａｍｐｌｅ.ｃｏｍ jo\u200bhn@exa\u200bmple.org bob%40corp.io büro@straße.de');
        expect(out).toBe('<email> <email> <email> <email> <email>');
    });
    it('removes caller-supplied names, case-insensitively and whole-word', () => {
        const out = s.text('ALICE WONDER joined gaming den with Bobby_Tables in Secret Project Room; Zoë waved');
        expectNone(out, ['alice', 'wonder', 'gaming den', 'bobby_tables', 'secret project', 'zoë']);
    });
    it('does not shred words containing a name, and ignores too-short terms', () => {
        const out = s.text('xylophone renderer');
        expect(out).toBe('xylophone renderer');
    });
    it('names with regex metacharacters are matched literally', () => {
        const t = createScrubber({ sensitiveTerms: ['a.b*c (test)', '[admins]'] });
        expect(t.text('in a.b*c (test) and [admins]')).toBe('in <name> and <name>');
        expect(t.text('aXbbbc (test)')).toBe('aXbbbc (test)');
    });
    it('removes @mentions but not scoped packages', () => {
        expect(plain.text('ping @charlie_x now')).toBe('ping @<user> now');
        expect(plain.text('from @cipherline/shared')).toBe('from @cipherline/shared');
    });
    it('removes LiveKit SIDs and UUIDs (dashed or not)', () => {
        const id = randomUUID();
        const out = plain.text(`participant PA_hJ7kL9mN2pQ track TR_AbCdEf123 room RM_xyz12345 user ${id} ${id.replace(/-/g, '')}`);
        expect(out).toBe('participant <sid> track <sid> room <sid> user <id> <id>');
    });
    it('removes IPv4 (with port) and IPv6, but not versions, times or line numbers', () => {
        const out = plain.text('ip 192.168.1.20:7881 10.0.0.1 fe80::1ff:fe23:4567:890a%eth0 2001:db8:85a3:0:0:8a2e:370:7334 ::ffff:203.0.113.4 time 12:34:56 at main.js:12:345 std::string v1.0.17');
        expect(out).toBe('ip <ip> <ip> <ip> <ip> <ip> time 12:34:56 at main.js:12:345 std::string v1.0.17');
    });
    it('removes bare third-party domains, keeps ours and code dots', () => {
        expect(plain.text('see evil.com, docs.google.com:443, api.cipherline.chat and electron.app.getPath in main.js'))
            .toBe('see <domain>, <domain>, api.cipherline.chat and electron.app.getPath in main.js');
    });
    it('removes international phone numbers', () => {
        expect(plain.text('call +1 (319) 555-0142 or +44 20 7946 0958')).toBe('call <phone> or <phone>');
    });
});

describe('adversarial input', () => {
    it('cannot forge a placeholder sentinel to protect a secret', () => {
        const out = plain.text('\u0001alice@example.com\u0002 and \u0001/home/bob/x.txt\u0002');
        expectNone(out, ['alice@example.com', 'bob', 'x.txt']);
    });
    it('angle-bracketed hex is still scrubbed (no fake placeholder escape)', () => {
        expect(plain.text('<deadbeefdeadbeefdeadbeef>')).toBe('<<hex>>');
    });
    it('strips bidi overrides and control characters', () => {
        const out = plain.text('a\u202Eb\u0000c\u001bd\u200Ee');
        expect(out).toBe('abcde');
    });
    it('caps enormous input before running patterns (no hang)', () => {
        const big = 'a@'.repeat(200_000) + 'x';
        const t0 = Date.now();
        const out = plain.text(big, 100_000);
        expect(Date.now() - t0).toBeLessThan(3000);
        expect(out.length).toBeLessThanOrEqual(MAX_SCRUB_INPUT);
    });
    it('pathological near-matches finish quickly', () => {
        const inputs = [
            'C:\\' + 'a\\'.repeat(5000),
            '/' + 'a/'.repeat(8000),
            'x'.repeat(19_000) + '@',
            ('ab:' ).repeat(6000),
            ('-----BEGIN A-----').repeat(1000),
            'https://' + 'a'.repeat(19_000),
        ];
        for (const inp of inputs) {
            const t0 = Date.now();
            plain.text(inp);
            expect(Date.now() - t0, inp.slice(0, 20)).toBeLessThan(2000);
        }
    });
    it('truncates output to maxLength with an ellipsis', () => {
        expect(plain.text('word '.repeat(100), 20)).toHaveLength(20);
    });
    it('coerces non-strings without throwing', () => {
        expect(plain.text(undefined)).toBe('');
        expect(plain.text(42)).toBe('42');
        expect(plain.text(new Error('at /home/x/secret.txt'))).not.toContain('secret');
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(plain.text(circular)).toBe('[unserializable]');
    });
    it('normalizeText folds compatibility forms', () => {
        expect(normalizeText('ｆｉｌｅ')).toBe('file');
    });
});

describe('stack()', () => {
    it('scrubs every frame and caps the number of frames', () => {
        const frames = Array.from({ length: 60 }, (_, i) => `    at f${i} (C:\\Users\\Dawson K\\x\\app.asar\\dist\\a.js:${i}:2)`);
        const out = s.stack('Error: boom\n' + frames.join('\n'), 10);
        expect(out.split('\n')).toHaveLength(12);
        expect(out).toContain('… 50 more frames');
        expectNone(out, ['Dawson']);
    });
});

describe('scrubDeep', () => {
    it('scrubs every string, drops bad keys and prototype keys, caps sizes', () => {
        const input = JSON.parse(`{
            "ok": "alice@example.com",
            "bad key": "x",
            "__proto__": {"polluted": true},
            "nested": {"arr": ["/home/bob/x.txt", 1, true, null]},
            "nan": null
        }`);
        input.fn = () => 1;
        input.inf = Infinity;
        const out = scrubDeep(input, plain) as Record<string, unknown>;
        expect(out.ok).toBe('<email>');
        expect(out).not.toHaveProperty('bad key');
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect((out.nested as { arr: unknown[] }).arr).toEqual(['<path>', 1, true, null]);
        expect(out.fn).toBeNull();
        expect(out.inf).toBeNull();
    });
    it('keeps verbatim keys only when they match their pattern', () => {
        const out = scrubDeep({ build_commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', app_version: 'alice@example.com' }, plain, undefined, {
            build_commit: /^[0-9a-f]{7,40}$/, app_version: /^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/,
        }) as Record<string, unknown>;
        expect(out.build_commit).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
        expect(out.app_version).toBe('<invalid>');
    });
    it('enforces depth, array and key limits', () => {
        let deep: unknown = 'leaf';
        for (let i = 0; i < 20; i++) deep = { d: deep };
        const lim = { maxDepth: 4, maxArrayLength: 3, maxKeys: 2, maxStringLength: 10 };
        expect(JSON.stringify(scrubDeep(deep, plain, lim))).toBe('{"d":{"d":{"d":{"d":null}}}}');
        expect(scrubDeep([1, 2, 3, 4, 5], plain, lim)).toEqual([1, 2, 3]);
        expect(Object.keys(scrubDeep({ a: 1, b: 2, c: 3 }, plain, lim) as object)).toEqual(['a', 'b']);
    });
    it('KEY_RE only admits identifier keys', () => {
        expect(KEY_RE.test('quality_limitation_reason')).toBe(true);
        expect(KEY_RE.test('alice@example.com')).toBe(false);
        expect(KEY_RE.test('1abc')).toBe(false);
    });
});
