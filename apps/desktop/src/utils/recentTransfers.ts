/**
 * QR-6 (adversarial review) — a local record of transfer ids THIS DEVICE
 * actually rendered a QR for, so `HistoryRequestModal.tsx` can locally
 * verify the server's `via: 'qr'` claim on a `device:history_request` rather
 * than rendering it as a bare, unverifiable assertion.
 *
 * The finding: a compromised API pod can attach `via: 'qr'` to ANY history
 * request — including a remote attacker's — and the modal would assert
 * "Authorised by a code scanned on this device" about a request that never
 * involved this device at all. That line is the human gate on handing over
 * the account's entire message history, so a false proximity claim there is
 * actively worse than no claim.
 *
 * The fix binds the claim to something the server cannot forge: a
 * `transfer_id` this device itself minted and rendered, via
 * `TransferQrController.begin()` calling `recordOpenedTransfer` the moment
 * `POST /v1/link/transfers` returns (i.e. the moment a QR for that id
 * actually appeared on THIS screen). `HistoryRequestModal` then renders the
 * "scanned on this device" line only when the request's `transfer_id`
 * matches one of these — otherwise it renders nothing, not a weaker claim.
 *
 * In-memory, module-scope, TTL-pruned — mirrors the server's own ~120s
 * transfer TTL (docs/QR-LINKING.md §3) rather than persisting anything
 * (there is no reason to remember a transfer id past the window it could
 * plausibly still be claimed in).
 */

/**
 * How long a transfer id this device opened stays eligible to match an inbound
 * `device:history_request`.
 *
 * **Deliberately mirrors `LINK_SESSION_TTL_S` in
 * `apps/api/src/link/link.constants.ts` (120 s), and the two are NOT wired to a
 * shared source** — the server constant is not exported to the renderer, and
 * plumbing it through for one number would be more coupling than it is worth.
 * If the server's transfer TTL ever changes, change this to match.
 *
 * Drift is not a security problem in either direction, which is why a comment
 * is the right weight of fix: too SHORT and a still-valid transfer loses its
 * "authorised by a scanned code" line (the badge disappears, nothing is falsely
 * asserted); too LONG and the window outlives a session the server has already
 * expired, so there is nothing left to match against. Both fail toward
 * rendering nothing, which is the safe direction — the line's whole purpose is
 * that it may only appear when this device really did display the code.
 */
const RECENT_WINDOW_MS = 120_000;

const openedAt = new Map<string, number>();

function prune(now: number): void {
    for (const [id, ts] of openedAt) {
        if (now - ts > RECENT_WINDOW_MS) openedAt.delete(id);
    }
}

/** Call the moment this device actually renders a QR for `transferId` — i.e.
 *  from `TransferQrController.begin()` right after `createTransfer()`
 *  resolves, never speculatively and never from anything server-relayed
 *  later (that would defeat the whole point: this record must only ever
 *  reflect what THIS device did, not what a request claims). */
export function recordOpenedTransfer(transferId: string, now: number = Date.now()): void {
    prune(now);
    openedAt.set(transferId, now);
}

/** True iff `transferId` was opened by THIS device within the last
 *  `RECENT_WINDOW_MS`. A missing/empty id is never a match — fail closed,
 *  the same rule CLAUDE.md states for every trust boundary in this app. */
export function wasTransferOpenedByThisDevice(
    transferId: string | null | undefined,
    now: number = Date.now(),
): boolean {
    if (!transferId) return false;
    prune(now);
    const ts = openedAt.get(transferId);
    return ts !== undefined && (now - ts) <= RECENT_WINDOW_MS;
}

/**
 * Whether `HistoryRequestModal` should render the "Authorised by a code
 * scanned on this device" line for a given request. Extracted as a pure,
 * independently-testable predicate for the same reason
 * `shouldHandleHistoryRequest`/`isMyHistoryDelivery` in `useRealtime.ts`
 * are: `apps/desktop`'s vitest has no DOM/`@testing-library`, so the
 * decision the JSX makes has to live somewhere testable on its own.
 */
export function shouldShowQrAuthorisedLine(
    request: { via?: 'qr'; transfer_id?: string } | null | undefined,
    now: number = Date.now(),
): boolean {
    if (!request || request.via !== 'qr') return false;
    return wasTransferOpenedByThisDevice(request.transfer_id, now);
}

/** Test-only: clear all recorded ids so suites don't leak state into each
 *  other through this module's singleton map. */
export function _resetRecentTransfersForTest(): void {
    openedAt.clear();
}
