// @vitest-environment jsdom
/**
 * GroupSettingsModal (redone on the dialog frame): the save flow is unchanged —
 * rename -> PATCH /conversations/:id; new picture -> cropper -> encrypted upload
 * (purpose 'group_icon') -> key saved + broadcast -> PATCH with the new
 * attachment id. Save stays disabled until something changed, errors are shown,
 * and the locally-created preview blob URL is revoked (on replace and on unmount).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const axiosGet = vi.fn();
const axiosPatch = vi.fn();
vi.mock('axios', () => ({
    default: { get: (...a: unknown[]) => axiosGet(...a), post: vi.fn(), patch: (...a: unknown[]) => axiosPatch(...a) },
}));
vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({ token: 'tok', user: { user_id: 'me', username: 'Me', avatar_url: null }, deviceId: 'dev' }),
}));
const toastPush = vi.fn();
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ push: toastPush }) }));
vi.mock('./EncryptedAvatar', () => ({ EncryptedAvatar: () => null }));
/** What the picture hook "decrypts": the id itself when it is a blob:, else nothing. */
vi.mock('../hooks/useEncryptedAvatar', () => ({
    useEncryptedAvatar: (id: string | null | undefined) => (id && id.startsWith('blob:') ? id : null),
    evictAvatar: vi.fn(),
}));
const uploadEncryptedFile = vi.fn();
const broadcastGroupAvatarKey = vi.fn();
const saveAvatarKey = vi.fn();
vi.mock('../hooks/useAttachments', () => ({ useAttachments: () => ({ uploadEncryptedFile }) }));
vi.mock('../hooks/useAvatarBroadcast', () => ({ useAvatarBroadcast: () => ({ broadcastGroupAvatarKey }) }));
vi.mock('../utils/avatarKeyStore', () => ({ saveAvatarKey: (...a: unknown[]) => saveAvatarKey(...a) }));
/** The real cropper needs canvas/image decoding; the stub confirms with a fixed JPEG blob. */
vi.mock('./cl/ClImageCropper', () => ({
    ClImageCropper: (p: { open: boolean; onConfirm: (b: Blob) => void; onCancel: () => void }) =>
        p.open ? React.createElement('button', { 'data-testid': 'crop-confirm', onClick: () => p.onConfirm(new Blob(['jpg'], { type: 'image/jpeg' })) }, 'crop-ok') : null,
}));

const { GroupSettingsModal } = await import('./GroupSettingsModal');
const { API_BASE } = await import('../constants');

let root: Root;
let host: HTMLDivElement;
let onGroupUpdated: ReturnType<typeof vi.fn<(t: string, a: string) => void>>;
let created: string[];
let revoked: string[];
beforeEach(() => {
    axiosGet.mockReset(); axiosPatch.mockReset(); uploadEncryptedFile.mockReset();
    broadcastGroupAvatarKey.mockReset(); saveAvatarKey.mockReset(); toastPush.mockReset();
    axiosGet.mockResolvedValue({ data: [{ user_id: 'me', username: 'Me', avatar_url: null }] });
    axiosPatch.mockResolvedValue({ data: {} });
    uploadEncryptedFile.mockResolvedValue({ attachmentId: 'att-new', keyB64: 'k', nonceB64: 'n' });
    created = []; revoked = [];
    let n = 0;
    URL.createObjectURL = vi.fn(() => { const u = `blob:test/${++n}`; created.push(u); return u; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u); }) as typeof URL.revokeObjectURL;
    onGroupUpdated = vi.fn<(t: string, a: string) => void>();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { try { act(() => root.unmount()); } catch { /* already unmounted */ } host.remove(); });

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
const body = () => document.body.textContent ?? '';
const nameInput = () => document.getElementById('group-settings-name') as HTMLInputElement;
const save = () => document.querySelector('button[type="submit"]') as HTMLButtonElement;
const hint = () => document.querySelector('.dlg-foot-hint')?.textContent ?? '';
const backdropImg = () => document.querySelector('[data-testid="group-settings-banner"] img') as HTMLImageElement | null;

async function mount(props: Partial<React.ComponentProps<typeof GroupSettingsModal>> = {}) {
    act(() => root.render(React.createElement(GroupSettingsModal, {
        conversationId: 'conv-1', conversationTitle: 'Crew', avatarUrl: 'att-old',
        onClose: () => {}, onGroupLeft: () => {}, onGroupUpdated, ...props,
    })));
    await flush();
}
const type = async (value: string) => {
    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(nameInput(), value);
        nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const pickFile = async () => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'g.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    await act(async () => { (document.querySelector('[data-testid="crop-confirm"]') as HTMLElement).click(); });
    await flush();
};
const clickSave = async () => { await act(async () => { save().click(); }); await flush(); };

describe('GroupSettingsModal', () => {
    it('is the dialog-frame pattern: titled, name field, footer with Cancel + Save', async () => {
        await mount();
        const dlg = document.querySelector('[role="dialog"]')!;
        expect(dlg.getAttribute('aria-label')).toBe('Group settings');
        expect(dlg.querySelector('.dlg-card, .mcard.dlg-card') ?? document.querySelector('.dlg-card')).not.toBeNull();
        expect(document.querySelector('.dlg-head h2')?.textContent).toBe('Group settings');
        expect(nameInput().value).toBe('Crew');
        expect([...document.querySelectorAll('.dlg-foot-actions button')].map(b => b.textContent?.trim())).toEqual(['Cancel', 'Save']);
    });

    it('Save is disabled until something changes, and the hint says what enables it', async () => {
        await mount();
        expect(save().disabled).toBe(true);
        expect(hint()).toContain('Change the name or photo');
        await type('Crew 2');
        expect(save().disabled).toBe(false);
        expect(hint()).toContain('Unsaved changes');
        await type('Crew');           // back to the original
        expect(save().disabled).toBe(true);
    });

    it('NEGATIVE CONTROL: a blank name can not be saved', async () => {
        await mount();
        await type('   ');
        expect(save().disabled).toBe(true);
        expect(hint()).toContain('Give the group a name');
        await clickSave();
        expect(axiosPatch).not.toHaveBeenCalled();
    });

    it('rename-only save PATCHes the title with the existing picture id, then reports success', async () => {
        await mount();
        await type('  Crew Reborn ');
        await clickSave();
        expect(uploadEncryptedFile).not.toHaveBeenCalled();
        expect(axiosPatch).toHaveBeenCalledWith(
            `${API_BASE}/conversations/conv-1`,
            { title: 'Crew Reborn', avatar_attachment: 'att-old' },
            { headers: { Authorization: 'Bearer tok' } },
        );
        expect(onGroupUpdated).toHaveBeenCalledWith('Crew Reborn', 'att-old');
        expect(body()).toContain('Group updated');
        expect(save().disabled).toBe(true);                 // nothing left to save
        expect(document.querySelector('.dlg-foot-actions button')?.textContent?.trim()).toBe('Done');
    });

    it('new picture: crop -> encrypted upload as group_icon -> key saved + broadcast -> PATCH with the new id', async () => {
        await mount();
        await pickFile();
        expect(backdropImg()?.getAttribute('src')).toBe('blob:test/1');   // the same picture shows as the banner
        expect(save().disabled).toBe(false);
        await clickSave();
        expect(uploadEncryptedFile).toHaveBeenCalledTimes(1);
        const args = uploadEncryptedFile.mock.calls[0];
        expect(args[1]).toBe('group_avatar.jpg');
        expect(args[2]).toBe('image/jpeg');
        expect(args[3]).toBe('conv-1');
        expect(args[6]).toBe('group_icon');
        expect(saveAvatarKey).toHaveBeenCalledWith('att-new', 'k', 'n');
        expect(broadcastGroupAvatarKey).toHaveBeenCalledWith('conv-1', 'att-new', 'k', 'n');
        expect(axiosPatch).toHaveBeenCalledWith(
            `${API_BASE}/conversations/conv-1`,
            { title: 'Crew', avatar_attachment: 'att-new' },
            { headers: { Authorization: 'Bearer tok' } },
        );
        expect(onGroupUpdated).toHaveBeenCalledWith('Crew', 'att-new');
    });

    it('a second save after a picture save sends the attachment id, never the blob: preview URL', async () => {
        await mount();
        await pickFile();
        await clickSave();
        await type('Crew v2');
        await clickSave();
        expect(axiosPatch).toHaveBeenLastCalledWith(
            `${API_BASE}/conversations/conv-1`,
            { title: 'Crew v2', avatar_attachment: 'att-new' },
            expect.anything(),
        );
        expect(uploadEncryptedFile).toHaveBeenCalledTimes(1);  // not re-uploaded
    });

    it('shows the server message when the save fails, and stays editable', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        axiosPatch.mockRejectedValue({ response: { data: { message: 'Not allowed' } } });
        await mount();
        await type('Crew 2');
        await clickSave();
        expect(document.querySelector('.dlg-error')?.textContent).toBe('Not allowed');
        expect(onGroupUpdated).not.toHaveBeenCalled();
        expect(save().disabled).toBe(false);
    });

    it('a rejected file type toasts and does not open the cropper', async () => {
        await mount();
        const input = document.querySelector('input[type="file"]') as HTMLInputElement;
        Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.svg', { type: 'image/svg+xml' })], configurable: true });
        await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
        expect(toastPush).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', title: 'Invalid group icon' }));
        expect(document.querySelector('[data-testid="crop-confirm"]')).toBeNull();
        expect(save().disabled).toBe(true);
    });

    it('revokes the local preview blob URL when it is replaced, and on unmount', async () => {
        await mount();
        await pickFile();
        expect(created).toEqual(['blob:test/1']);
        await pickFile();
        expect(created).toEqual(['blob:test/1', 'blob:test/2']);
        expect(revoked).toEqual(['blob:test/1']);          // replaced -> old one revoked
        act(() => root.unmount());
        expect(revoked).toEqual(['blob:test/1', 'blob:test/2']);
    });

    it('does not revoke anything when no local picture was picked (cache URLs belong to the avatar cache)', async () => {
        await mount();
        act(() => root.unmount());
        expect(revoked).toEqual([]);
    });
});
