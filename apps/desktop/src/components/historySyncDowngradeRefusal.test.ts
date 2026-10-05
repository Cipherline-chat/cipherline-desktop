import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HISTORY_REFUSED_LEGACY_REQUESTER } from '../utils/historyRequestProof';

/**
 * C-2b — source-level guards on the two components that decide whether a raw
 * history key can leave a device.
 *
 * The crypto is proven behaviourally against real Ed25519 in
 * `utils/historyRequestProof.test.ts`. What is pinned HERE is the property that
 * test cannot reach: that the *components* have no downgrade branch left. The
 * defect was never bad crypto — it was a correct wrap sitting behind
 * `if (request.accepts_wrapped_key) { wrap } else { send it in the clear }`,
 * where the condition was a boolean the server relayed. Removing a branch is
 * exactly the kind of change a later refactor silently restores, and it does
 * not show up as a failing crypto test because the crypto still works; the
 * plaintext path simply runs instead.
 *
 * Source-scanning rather than rendering: this repo has no React testing
 * harness (no testing-library dependency), and these components sit behind
 * Dashboard.tsx's ~7.4k-line monolith. Same approach as
 * `callsChannelKeyWiring.test.ts` and `services/backupRegistry`'s scan test.
 *
 * Every scan below is two-sided — it asserts the dangerous construct is ABSENT
 * *and* that the safe one it was replaced by is PRESENT. A one-sided absence
 * assertion would keep passing if the whole file were deleted or renamed.
 */

const modal = readFileSync(join(__dirname, 'HistoryRequestModal.tsx'), 'utf8');
const banner = readFileSync(join(__dirname, 'HistorySyncBanner.tsx'), 'utf8');

/** Strip comments so a scan can't be satisfied — or defeated — by prose. Both
 *  files discuss `transfer_key_b64` at length in their docblocks; only real
 *  code should count. */
function codeOnly(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const modalCode = codeOnly(modal);
const bannerCode = codeOnly(banner);

describe('meta — the scans are looking at real files', () => {
    it('both sources loaded and still contain code after comment stripping', () => {
        // Guards every `not.toContain` below: if a rename emptied these, the
        // absence assertions would all pass for the wrong reason.
        expect(modalCode.length).toBeGreaterThan(1000);
        expect(bannerCode.length).toBeGreaterThan(1000);
        expect(modalCode).toContain('deliver-history');
        expect(bannerCode).toContain('history-request');
    });
});

describe('C-2b — the approver cannot send a plaintext transfer key', () => {
    it('never puts `transfer_key_b64` in a request body', () => {
        // THE property. There is no input — from the server, the user, or a
        // failed wrap — that makes this component emit the raw AES key,
        // because the field is not written anywhere in its code.
        // Negative lookbehind, because `wrapped_transfer_key_b64:` ENDS with
        // `transfer_key_b64:` — a plain substring check here passes only when
        // the wrapped field is absent too, i.e. it would have been satisfied by
        // breaking the feature. (Caught by this test on first run.)
        expect(modalCode).not.toMatch(/(?<!wrapped_)transfer_key_b64\s*:/);
        // POSITIVE CONTROL: the wrapped field IS written, so the scan is
        // matching the right shape and the transfer still happens.
        expect(modalCode).toContain('wrapped_transfer_key_b64: wrappedTransferKeyB64');
    });

    it('has no `accepts_wrapped_key` conditional left to downgrade through', () => {
        // The exact deleted construct. `accepts_wrapped_key` survives only as
        // an inbound interface field; it must not appear in a condition.
        expect(modalCode).not.toContain('if (request.accepts_wrapped_key)');
        expect(modalCode).not.toMatch(/\?\s*\{\s*wrapped_transfer_key_b64/);
        // POSITIVE CONTROL: the wrap is now unconditional.
        expect(modalCode).toContain('const wrappedTransferKeyB64 = await wrapHistoryTransferKey(');
    });

    it('decides on the verified advertisement, not the relayed boolean', () => {
        expect(modalCode).toContain('verifyHistoryRequestAdvertisement({');
        // The verifier is fed the identity key from the approver's OWN bundle
        // fetch, never a field off the relayed event.
        expect(modalCode).toContain('identityKeyPubB64: entry.identity_key_pub_b64');
        expect(modalCode).not.toContain('identityKeyPubB64: request.');
    });

    it('verifies BEFORE any history is packaged, encrypted or uploaded', () => {
        // Ordering matters for more than tidiness: exporting and uploading a
        // history blob whose key will never be delivered leaves ciphertext on
        // the server for no reason.
        // Compare CALL SITES, not the first mention: `exportLocalHistory`
        // appears in the import block at the top of the file, which made an
        // `indexOf('exportLocalHistory')` comparison meaningless.
        const verifyAt = modalCode.indexOf('verifyHistoryRequestAdvertisement({');
        const exportAt = modalCode.indexOf('await exportLocalHistory(');
        expect(verifyAt).toBeGreaterThan(-1);
        expect(exportAt).toBeGreaterThan(-1);
        expect(verifyAt).toBeLessThan(exportAt);
    });

    it('gates the send path on the verdict as well as the render path', () => {
        // Defence in depth: the refusal UI replaces the button, but the
        // handler refuses independently so a future render change cannot
        // re-expose it.
        expect(modalCode).toContain("if (verdict !== 'ok' || !bundle) {");
    });

    it('wraps to the SAME bundle entry the signature was verified against', () => {
        // One fetch, one key. Re-fetching at send time would let the server
        // serve one identity key to the check and another to the wrap.
        expect(modalCode).toContain('fetchOwnDeviceKeyBundle(');
        expect(modalCode).toContain('wrapHistoryTransferKey(\n                transferKeyB64, bundle,');
        expect((modalCode.match(/fetchOwnDeviceKeyBundle\(/g) ?? []).length).toBe(1);
    });
});

describe('C-2b — a refusal is actionable, never a hang or a generic error', () => {
    it('tells the requester WHY, with a machine-readable reason', () => {
        // Without this the requester just counts down to a 60s timeout — the
        // "spinner that never resolves" outcome.
        expect(modalCode).toContain('void postDecline(HISTORY_REFUSED_LEGACY_REQUESTER)');
        expect(HISTORY_REFUSED_LEGACY_REQUESTER).toBe('requester_cannot_receive_wrapped_key');
    });

    it('declines at most ONCE per request despite StrictMode double-invocation', () => {
        // `src/main.tsx` renders under React.StrictMode, which runs effects
        // twice in development. Two declines means two
        // `historyTransfer key_form=refused` lines, which silently doubles the
        // rollout-drain number the launch-checklist gate is read off.
        expect(modalCode).toContain('const declinedForRef = useRef<string | null>(null);');
        expect(modalCode).toContain('if (declinedForRef.current !== request.device_id) {');
    });

    it('names the out-of-date device and says what to do about it', () => {
        // The user has two devices and one is stale; the message has to say
        // which one and what action fixes it.
        expect(modal).toContain('That device needs an update');
        expect(modal).toContain('Update Cipherline on');
        expect(modal).toContain('{request.device_name}');
    });

    it('distinguishes "cannot verify" from "could not reach the key bundle"', () => {
        // A network blip must not be reported to the user as an out-of-date
        // device, and must not auto-decline a perfectly modern requester.
        expect(modalCode).toContain("setVerdict('error')");
        expect(modalCode).toContain("setVerdict('refused')");
        const errorBranch = modalCode.slice(
            modalCode.indexOf('key bundle fetch failed'),
            modalCode.indexOf("setVerdict('error')") + 40,
        );
        expect(errorBranch).not.toContain('postDecline');
        // POSITIVE CONTROL: the transient branch offers a retry.
        expect(modal).toContain('Try again');
    });

    it('has no path that leaves the verdict on `checking`', () => {
        // `checking` renders a spinner with no terminal state — the
        // never-resolving outcome this change exists to eliminate. Every early
        // return out of the verification effect must first move off it,
        // including the defensive not-signed-in guard.
        const effect = modalCode.slice(
            modalCode.indexOf('useEffect(() => {\n        if (!user?.user_id'),
            modalCode.indexOf('const handleDecline'),
        );
        expect(effect.length).toBeGreaterThan(200);
        // Every `return` in the effect body is preceded by a verdict change.
        // Enumerated rather than regex-counted so a new branch shows up here as
        // a failure rather than passing silently.
        expect(effect).toContain("setVerdict('error');\n            return;");
        expect(effect).toContain("if (!cancelled) setVerdict('error');\n                return;");
        expect(effect).toContain("setVerdict('refused');");
        expect(effect).toContain("setVerdict('ok');");
    });
});

describe('C-2b — the requester refuses a plaintext key too', () => {
    it('blocks a delivery that carries only the legacy plaintext key', () => {
        // The mirror case: a CURRENT requester talking to a LEGACY approver.
        // The approver has already handed the server the key; importing anyway
        // would complete the sync while the privacy claim about it was false,
        // with nothing on screen to say so.
        expect(bannerCode).toContain(
            '!historyDelivered.wrapped_transfer_key_b64 && historyDelivered.transfer_key_b64',
        );
        expect(bannerCode).toContain("setState('blocked')");
    });

    it('has no expression left that could consume a plaintext key', () => {
        // The `?: historyDelivered.transfer_key_b64` fallback is gone, not
        // merely shadowed by the guard above it.
        expect(bannerCode).not.toContain(': historyDelivered.transfer_key_b64');
        // POSITIVE CONTROL: the wrapped path is what actually runs.
        expect(bannerCode).toContain('await unwrapHistoryTransferKey(');
    });

    it('refuses BEFORE showing an import progress label', () => {
        const guardAt = bannerCode.indexOf('!historyDelivered.wrapped_transfer_key_b64 &&');
        const importingAt = bannerCode.indexOf("setState('importing')");
        expect(guardAt).toBeGreaterThan(-1);
        expect(importingAt).toBeGreaterThan(-1);
        expect(guardAt).toBeLessThan(importingAt);
    });

    it('signs its advertisement and abandons rather than sending it unsigned', () => {
        // An unsigned request is what a current approver refuses, so sending
        // one "as a best effort" buys a confusing decline — and on an older
        // approver it quietly takes the plaintext path.
        expect(bannerCode).toContain('getHistoryRequestProof(userId, deviceId, capabilityTs)');
        expect(bannerCode).toContain('if (!proof?.sig) {');
        const abandon = bannerCode.slice(bannerCode.indexOf('if (!proof?.sig) {'), bannerCode.indexOf('if (!proof?.sig) {') + 600);
        expect(abandon).toContain("setState('blocked')");
        expect(abandon).toContain('return;');
        // POSITIVE CONTROL: a signed request DOES carry the proof fields.
        expect(bannerCode).toContain('capability_sig_b64: proof.sig');
        expect(bannerCode).toContain('capability_ts: capabilityTs');
    });

    it('renders the blocked state with copy and a way forward', () => {
        expect(banner).toContain('Couldn’t sync your history');
        expect(banner).toContain('{blockedText}');
        // Not a dead end: the user can retry after updating, or start fresh.
        const blockedBlock = banner.slice(banner.indexOf("{state === 'blocked' && ("));
        expect(blockedBlock.slice(0, 1400)).toContain('Start fresh');
        expect(blockedBlock.slice(0, 1400)).toContain('Try again');
    });

    it('explains a capability refusal differently from a user decline', () => {
        expect(bannerCode).toContain('historyDeclined.reason === HISTORY_REFUSED_LEGACY_REQUESTER');
        // POSITIVE CONTROL: an ordinary "no thanks" still reaches the plain
        // declined screen rather than being swallowed by the new branch.
        expect(bannerCode).toContain("setState('declined')");
    });
});
