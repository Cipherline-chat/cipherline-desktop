/* eslint-disable -- visual harness, not shipped */
// Stand-in for hooks/useAttachments (server-dialogs harness only): the real one drags in the whole upload stack.
export const useAttachments = (_token?: string | null) => ({
    uploadEncryptedFile: async (_blob: Blob, _name: string, _mime: string) => {
        ((window as any).__log ||= []).push(['upload-icon']);
        return { attachmentId: 'att-1', keyB64: 'k', nonceB64: 'n' };
    },
});
