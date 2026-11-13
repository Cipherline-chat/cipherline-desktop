/* eslint-disable -- harness stubs, not shipped */
// Stand-ins used ONLY by the device-sync harness (see device-sync.vite.config.ts).

// ── contexts/AuthContext ──
export const useAuth = () => ({
    token: 'harness-token', userId: 'me', deviceId: 'dev-1',
    user: { user_id: 'me', username: 'Dawson' },
});
export const AuthProvider = ({ children }: { children: unknown }) => children as any;

// ── utils/historyRequestProof ──
export const HISTORY_REFUSED_LEGACY_REQUESTER = 'requester_cannot_receive_wrapped_key';
export const verifyHistoryRequestAdvertisement = () => ({ ok: true }) as any;

// ── utils/historyTransferKey ──
export async function fetchOwnDeviceKeyBundle() { return { device_id: 'req-1', identity_key_pub_b64: 'AAAA' } as any; }
export async function wrapHistoryTransferKey() { return 'd3JhcHBlZA=='; }

// ── utils/crypto: exportLocalHistory is held open until the harness releases it ──
export async function exportLocalHistory(_uid: string, opts: any) {
    const w = window as any;
    opts?.onAttachmentProgress?.(14, 37, 48_300_000);
    await new Promise<void>(res => { w.__releaseExport = res; });
    return new Blob([JSON.stringify({ transferMeta: { included_message_count: 1234 } })], { type: 'application/json' });
}
