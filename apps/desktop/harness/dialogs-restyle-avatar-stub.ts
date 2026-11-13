/* eslint-disable -- visual harness, not shipped */
// new-message-avatar-stub.ts predates hooks/useEncryptedAvatar's `avatarUrlMime` export; EncryptedAvatar imports it.
export * from './new-message-avatar-stub';
export const avatarUrlMime = (_url: string | null | undefined): string | null => null;
