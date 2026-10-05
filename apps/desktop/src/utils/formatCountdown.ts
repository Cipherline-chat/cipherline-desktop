/** `mm:ss`, e.g. `1:45`. Shared by `QrSignInPanel.tsx` and `TransferQrPanel.tsx`
 *  — both QR sessions are well under an hour (docs/QR-LINKING.md's 120s TTL). */
export function formatCountdown(totalSeconds: number): string {
    const s = Math.max(0, totalSeconds);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
}
