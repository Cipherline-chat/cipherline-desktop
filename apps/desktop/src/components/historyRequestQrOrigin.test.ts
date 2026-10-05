import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * docs/QR-LINKING.md §3 — `device:history_request` grew two additive,
 * optional fields (`via: 'qr'`, `transfer_id`) so a request that arrived
 * through a QR scan (a genuine physical-proximity gesture — see the design's
 * §3.4 "why this is the stronger primitive") can say so on the approver's
 * confirm screen, rather than looking identical to any other in-app request.
 *
 * Source-scanning rather than rendering, same rationale as the neighbouring
 * `historySyncDowngradeRefusal.test.ts`: this repo has no React testing
 * harness (no testing-library dependency), and `HistoryRequestModal` sits
 * behind Dashboard.tsx's ~7.4k-line monolith. What matters here cannot be a
 * "the field changed something" test the way normal logic can — it is a
 * *display-only, additive* change — so this pins three things at once:
 *   1. the new copy exists and is gated, not unconditional;
 *   2. both new fields are OPTIONAL on the interface, so an event that lacks
 *      them (every request before this feature, and every non-QR request
 *      after it) type-checks and renders unchanged;
 *   3. neither field is ever passed into the C-2b verification call — the
 *      cryptographic verdict must be provably identical either way, not just
 *      "probably fine because nobody wired it in".
 *
 * QR-6 (adversarial review) update: bullet 1 used to be, literally, a raw
 * `request.via === 'qr'` guard in the JSX — and that alone is an
 * unverifiable server claim. A compromised API pod can attach `via: 'qr'`
 * to ANY history request, including a remote attacker's, and the modal
 * would have asserted a physical scan that never happened. The gate is now
 * `shouldShowQrAuthorisedLine(request)` (`../utils/recentTransfers.ts`),
 * which additionally requires `transfer_id` to match a transfer THIS
 * device actually opened a QR for — that deeper via+transfer_id logic has
 * its own coverage in `recentTransfers.test.ts`; this file only needs to
 * confirm the modal delegates to that gate rather than trusting `via`
 * alone again in some future edit.
 */

const modalPath = join(__dirname, 'HistoryRequestModal.tsx');
const realtimePath = join(__dirname, '..', 'hooks', 'useRealtime.ts');
const modal = readFileSync(modalPath, 'utf8');
const realtime = readFileSync(realtimePath, 'utf8');

function codeOnly(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const modalCode = codeOnly(modal);
const realtimeCode = codeOnly(realtime);

describe('meta — the scans are looking at real files', () => {
    it('both sources loaded and still contain code after comment stripping', () => {
        expect(modalCode.length).toBeGreaterThan(1000);
        expect(realtimeCode.length).toBeGreaterThan(1000);
    });
});

describe('HistoryRequestModal — QR-origin line is additive and gated', () => {
    it('declares via/transfer_id as OPTIONAL on the HistoryRequest interface', () => {
        expect(modal).toMatch(/via\?:\s*'qr'/);
        expect(modal).toMatch(/transfer_id\?:\s*string/);
    });

    it('renders the QR-scan line only inside a `shouldShowQrAuthorisedLine(request)` guard (QR-6)', () => {
        // The modal must import the real gate function, not reimplement its
        // own via/transfer_id check inline — that centralisation is what lets
        // recentTransfers.test.ts be the single source of truth for the
        // via+transfer_id logic.
        expect(modal).toMatch(/import\s*\{\s*shouldShowQrAuthorisedLine\s*\}\s*from\s*['"]\.\.\/utils\/recentTransfers['"]/);

        const marker = 'shouldShowQrAuthorisedLine(request)';
        expect(modalCode).toContain(marker);
        const idx = modalCode.indexOf(marker);
        // The copy must appear shortly AFTER the guard, i.e. inside the JSX
        // block it opens — not floating unconditionally elsewhere in the file.
        const window = modalCode.slice(idx, idx + 300);
        expect(window).toMatch(/[Aa]uthorised by a code scanned/);
    });

    it('QR-6: the bare `via` field alone is never enough — a plain `request.via === \'qr\'` guard would be the regression this closes', () => {
        // Guards against a future edit reintroducing the naive check
        // alongside (or instead of) the real gate — e.g. `via === 'qr' &&
        // shouldShowQrAuthorisedLine(request)` would still be wrong, because
        // it implies via is doing independent gating work rather than being
        // folded into the one function that owns the whole decision.
        expect(modalCode).not.toContain("request.via === 'qr'");
    });

    it('never appears unconditionally (no bare copy outside the guard)', () => {
        // Every occurrence of the phrase must be preceded, within a small
        // window, by the guard — so there is exactly one occurrence and it is
        // the gated one above, not a second copy slipped in elsewhere.
        const occurrences = modalCode.match(/[Aa]uthorised by a code scanned/g) ?? [];
        expect(occurrences.length).toBe(1);
    });

    it('does NOT feed via/transfer_id into the C-2b verification call — the crypto verdict is unaffected', () => {
        const callIdx = modalCode.indexOf('verifyHistoryRequestAdvertisement({');
        expect(callIdx).toBeGreaterThan(-1);
        const callEnd = modalCode.indexOf('});', callIdx);
        const callArgs = modalCode.slice(callIdx, callEnd);
        expect(callArgs).not.toContain('via');
        expect(callArgs).not.toContain('transfer_id');
        // The existing gate is still intact — the fields this bullet is
        // actually about are unchanged by this change.
        expect(callArgs).toContain('capabilitySigB64');
        expect(callArgs).toContain('capabilityTs');
    });
});

describe('useRealtime — via/transfer_id are optional and unverified, same as the existing capability fields', () => {
    it('declares via/transfer_id as OPTIONAL on the historyRequest state shape', () => {
        expect(realtime).toMatch(/via\?:\s*'qr'/);
        expect(realtime).toMatch(/transfer_id\?:\s*string/);
    });

    it('populates them defensively from msg.data, never trusting an unexpected shape', () => {
        expect(realtimeCode).toContain("msg.data.via === 'qr' ? 'qr' : undefined");
        expect(realtimeCode).toMatch(/typeof msg\.data\.transfer_id === 'string'/);
    });
});
