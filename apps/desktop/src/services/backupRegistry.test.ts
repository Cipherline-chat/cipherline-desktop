import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    KV_RULES, APP_PREF_KEYS, SECURE_STORE_EXCLUDED,
    classifyKvKey, collectIncludedKv, applyIncludedKv, toPortableKey, fromPortableKey, repairSoundPaths,
} from './backupRegistry';

const UID = 'a1b2c3d4-uid';

describe('backupRegistry — classification', () => {
    it('has no duplicate patterns', () => {
        const seen = new Set<string>();
        for (const r of KV_RULES) {
            expect(seen.has(r.pattern), `duplicate rule ${r.pattern}`).toBe(false);
            seen.add(r.pattern);
        }
    });

    it('includes the settings the audit found missing, excludes session material and structured vault fields', () => {
        const inc = (k: string) => expect(classifyKvKey(k, UID), k).toBe('include');
        const exc = (k: string) => expect(classifyKvKey(k, UID), k).toBe('exclude');
        inc(`cipherline_notif_global_prefs_${UID}`);
        inc(`cipherline_notif_prefs_${UID}`);
        inc(`cipherline_home_pins_${UID}`);
        inc(`cipherline_ignored_${UID}_srv-1`);
        inc(`kv_verify_v2_${UID}_peer-7`);
        inc('cipherline_privacy_settings');
        inc('cipherline_ambient_motion');
        inc('cipherline_vol_mic_someone');
        exc('cipherline_token');
        exc('cipherline_refresh_token');
        exc('cipherline_private_key');
        exc(`cipherline_msgs_${UID}_conv-1`);
        exc(`cipherline_convs_${UID}`);
        exc(`cipherline_unread_${UID}`);
        exc('kv_verify_old_style');
        expect(classifyKvKey('cipherline_totally_new_thing', UID)).toBe('unknown');
    });

    it('retention is per-device: every retention key is EXCLUDED, with a reason on record', () => {
        // Owner decision 2026-09: retention settings never leave the device.
        // include:false is also what makes applyIncludedKv ignore these keys
        // when an OLD backup still carries them (deviceRetention.vault.test.ts).
        const keys = [
            `cipherline_storage_policy_${UID}`,
            `cipherline_conv_retention_${UID}_conv-9`,
            `cipherline_server_retention_${UID}_srv-3`,
            `cipherline_retention_purged_${UID}_chan-4`,
            `cipherline_device_storage_setup_${UID}`,
        ];
        for (const k of keys) expect(classifyKvKey(k, UID), k).toBe('exclude');
        for (const pattern of [
            'cipherline_storage_policy_{uid}', 'cipherline_conv_retention_{uid}_', 'cipherline_server_retention_{uid}_',
            'cipherline_retention_purged_{uid}_', 'cipherline_device_storage_setup_{uid}',
        ]) {
            const rule = KV_RULES.find(r => r.pattern === pattern);
            expect(rule, pattern).toBeDefined();
            expect(rule!.include, pattern).toBe(false);
            expect(rule!.why, pattern).toMatch(/device/i);
        }
        // And none of them is collected, even when present.
        const map = new Map(keys.map(k => [k, '{}']));
        const store = { keysWithPrefix: (p: string) => [...map.keys()].filter(k => k.startsWith(p)), getItem: (k: string) => map.get(k) ?? null };
        expect(collectIncludedKv(store, UID)).toEqual({});
    });

    it('a new field inside the notification prefs blob rides along in the backup', () => {
        // Notification prefs are one JSON object under one key, so `sound_groups`
        // — the collapsed "App sounds" enable + volume — is backed up by the
        // existing rule rather than needing its own. Asserted rather than
        // assumed, because the source scan below can only see NEW KEYS: a new
        // field inside an existing blob produces no `setItem('…` for it to
        // catch, so nothing else would notice if this key ever flipped to
        // excluded and quietly stopped carrying the sound settings.
        expect(classifyKvKey(`cipherline_notif_global_prefs_${UID}`, UID)).toBe('include');
        const rule = KV_RULES.find(r => r.pattern === 'cipherline_notif_global_prefs_{uid}');
        expect(rule?.include).toBe(true);
        expect(rule?.why).toMatch(/sound groups/i);
    });

    it('per-user rules do not match another account’s keys', () => {
        expect(classifyKvKey('cipherline_notif_global_prefs_other-user', UID)).toBe('unknown');
    });

    it('portable keys round-trip through the {uid} placeholder', () => {
        const k = `cipherline_conv_retention_${UID}_conv-1`;
        const p = toPortableKey(k, UID);
        expect(p).toBe('cipherline_conv_retention_{uid}_conv-1');
        expect(fromPortableKey(p, UID)).toBe(k);
        expect(toPortableKey('cipherline_ambient_motion', UID)).toBe('cipherline_ambient_motion');
    });
});

describe('backupRegistry — collect / apply', () => {
    function fakeStore(entries: Record<string, string>) {
        const map = new Map(Object.entries(entries));
        return {
            keysWithPrefix: (p: string) => [...map.keys()].filter(k => k.startsWith(p)),
            getItem: (k: string) => map.get(k) ?? null,
            setItem: (k: string, v: string) => { map.set(k, v); },
            map,
        };
    }

    it('collects only included keys, keyed portably', () => {
        const store = fakeStore({
            [`cipherline_notif_global_prefs_${UID}`]: '{"dnd":true}',
            [`cipherline_notif_global_prefs_other`]: '{"dnd":false}',
            'cipherline_ambient_motion': '1',
            'cipherline_token': 'jwt',
            [`cipherline_msgs_${UID}_c1`]: '[]',
            [`cipherline_ignored_${UID}_s1`]: '["u9"]',
        });
        expect(collectIncludedKv(store, UID)).toEqual({
            'cipherline_notif_global_prefs_{uid}': '{"dnd":true}',
            'cipherline_ambient_motion': '1',
            'cipherline_ignored_{uid}_s1': '["u9"]',
        });
    });

    it('applies included keys under the restoring account and refuses everything else', () => {
        const store = fakeStore({});
        const n = applyIncludedKv(store, {
            'cipherline_notif_global_prefs_{uid}': '{"dnd":true}',
            'cipherline_ambient_motion': '1',
            'cipherline_token': 'evil',                  // excluded — session
            'cipherline_convs_{uid}': '[]',              // excluded — structured
            'cipherline_brand_new_{uid}': 'x',           // unknown — not applied
        }, UID);
        expect(n).toBe(2);
        expect(store.map.get(`cipherline_notif_global_prefs_${UID}`)).toBe('{"dnd":true}');
        expect(store.map.get('cipherline_ambient_motion')).toBe('1');
        expect(store.map.has('cipherline_token')).toBe(false);
        expect(store.map.has(`cipherline_convs_${UID}`)).toBe(false);
    });
});

describe('backupRegistry — repairSoundPaths', () => {
    const defaults = { message: './sounds/notification.wav', mention: './sounds/mention.wav' };
    const available = [{ name: 'ding.wav', file: 'file:///home/me/.config/Cipherline/custom-sounds/ding.wav' }];

    it('re-points custom sound references at this machine’s copies and drops missing ones', () => {
        const { prefs, changed } = repairSoundPaths({
            custom_sounds: [
                { name: 'ding.wav', file: 'file://C:\\Users\\old\\AppData\\Roaming\\Cipherline\\custom-sounds\\ding.wav' },
                { name: 'gone.mp3', file: 'file://C:\\Users\\old\\AppData\\Roaming\\Cipherline\\custom-sounds\\gone.mp3' },
            ],
            sounds: {
                message: { enabled: true, volume: 1, file: 'file://C:\\Users\\old\\AppData\\Roaming\\Cipherline\\custom-sounds\\ding.wav' },
                mention: { enabled: true, volume: 1, file: 'file://C:\\Users\\old\\AppData\\Roaming\\Cipherline\\custom-sounds\\gone.mp3' },
            },
        }, available, defaults);
        expect(changed).toBe(true);
        expect(prefs.custom_sounds).toEqual([{ name: 'ding.wav', file: available[0].file }]);
        expect(prefs.sounds!.message.file).toBe(available[0].file);
        expect(prefs.sounds!.mention.file).toBe('./sounds/mention.wav');
    });

    it('leaves bundled sounds and already-correct paths untouched', () => {
        const input = {
            custom_sounds: [{ name: 'ding.wav', file: available[0].file }],
            sounds: { message: { enabled: true, volume: 1, file: './sounds/notification.wav' }, mention: { enabled: true, volume: 1, file: available[0].file } },
        };
        const { prefs, changed } = repairSoundPaths(input, available, defaults);
        expect(changed).toBe(false);
        expect(prefs).toEqual(input);
    });
});

/**
 * Source scan: every key the app writes must be classified. This is what
 * turns "we forgot to add it to the backup" from a silent data loss into a
 * failing test with the offending key in the message.
 */
describe('backupRegistry — every persisted key in the source tree is classified', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcRoot = join(here, '..');
    const electronRoot = join(here, '..', '..', 'electron');

    function walk(dir: string, out: string[] = []): string[] {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, out); }
            else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
        }
        return out;
    }

    it('secureLocalStore.setItem keys', () => {
        // Matches the literal head of the key in `setItem('key…` / `setItem(\`key…${…}`.
        const re = /secureLocalStore\.setItem\(\s*[`'"]([A-Za-z0-9_]+)/g;
        // Also `setItem(SOME_CONST, ...)` where SOME_CONST is a string literal
        // declared in the same file - the shape every settings hook uses. The
        // literal-only scan used to miss all of them (useGameSettings,
        // useKeybinds, useVoiceSettings, ...), so their keys were classified
        // only because someone remembered to add them by hand.
        // `,` OR `+`: `setItem(PREFIX + userId, …)` is the same shape with the
        // template spelled as concatenation, and the comma-only pattern was
        // blind to it — a key written that way reached disk unclassified and
        // this test still passed. Caught while adding the peer-identity cache,
        // which is written exactly like that.
        const reConst = /secureLocalStore\.setItem\(\s*([A-Z][A-Z0-9_]*)\s*[,+]/g;
        const constHead = (text: string, name: string): string | null => {
            const m = text.match(new RegExp(`const\\s+${name}\\s*=\\s*[\`'"]([A-Za-z0-9_]+)`));
            return m ? m[1] : null;
        };
        const unknown = new Set<string>();
        for (const file of walk(srcRoot)) {
            const text = readFileSync(file, 'utf8');
            const heads: string[] = [];
            for (const m of text.matchAll(re)) heads.push(m[1]);
            for (const m of text.matchAll(reConst)) { const h = constHead(text, m[1]); if (h) heads.push(h); }
            for (const head of heads) {
                // Turn the literal head into a representative key: append the
                // uid for `_${userId}` / `_{uid}` templates, and a tail for prefixes.
                const candidates = [head, `${head}${UID}`, `${head}${UID}_tail`, `${head}tail`];
                if (!candidates.some(k => classifyKvKey(k, UID) !== 'unknown')) unknown.add(`${head} (${file.slice(srcRoot.length + 1)})`);
            }
        }
        expect([...unknown], 'unclassified secureLocalStore keys — add them to KV_RULES').toEqual([]);
    });

    it('electron secureStore.set keys', () => {
        const re = /secureStore\.set\(\s*[`'"]([A-Za-z0-9_:]+)/g;
        const known = (k: string) =>
            (APP_PREF_KEYS as readonly string[]).includes(k) || SECURE_STORE_EXCLUDED.some(p => k === p || k.startsWith(p));
        const unknown = new Set<string>();
        for (const file of walk(electronRoot)) {
            const text = readFileSync(file, 'utf8');
            for (const m of text.matchAll(re)) if (!known(m[1])) unknown.add(`${m[1]} (${file.slice(electronRoot.length + 1)})`);
        }
        // `secureStore.set(KEYS.x, …)` style (googleDriveAuth) is covered by the oauth:google: prefix.
        expect([...unknown], 'unclassified SecureStore keys — add to APP_PREF_KEYS or SECURE_STORE_EXCLUDED').toEqual([]);
    });
});
