/**
 * Opens the theme import preview when the app is launched (or focused) from a
 * `cipherline://theme#clth1.…` link — the website /theme page's "Open in
 * Cipherline". Main validates only the shape (electron/deep-link.ts
 * parseThemeDeepLink: prefix, base64url, length); the code is decoded here
 * with the import dialog's own rules, and NOTHING is saved or applied until
 * the user presses Save / Save and use (Preview shows it on the whole app for
 * a while, storing nothing: theme/engine.ts startThemePreview).
 *
 * Mounted by Dashboard (signed in, so the theme library is available). A link
 * that arrived before sign-in is parked in main and pulled on mount.
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { decodeShareCode, type CustomThemeDef } from '../../theme/customTheme';
import { useCustomThemes } from '../../theme/customThemeLibrary';
import { chooseCustomTheme } from '../../theme/activeThemeMirror';
import { isThemeCodeShape } from '../../theme/themeLink';
import { CustomThemeImportDialog } from '../settings/panes/CustomThemeShareDialog';

export const ThemeDeepLinkHost: React.FC = () => {
    const { userId, user } = useAuth();
    const uid = userId ?? user?.user_id ?? null;
    const lib = useCustomThemes(uid);
    const [code, setCode] = useState<string | null>(null);

    useEffect(() => {
        const api = window.electronAPI;
        const take = (c: unknown) => { if (isThemeCodeShape(c)) setCode(c); };
        // A pushed code is also parked in main: pull it once so it can't reopen on the next mount.
        const off = api?.onDeepLinkTheme?.((c) => { take(c); void api.getPendingDeepLinkTheme?.().catch(() => {}); });
        void api?.getPendingDeepLinkTheme?.().then(take, () => { /* nothing pending */ });
        return () => { off?.(); };
    }, []);

    if (!code) return null;
    const decoded = decodeShareCode(code);
    const title = decoded.ok ? `Preview “${decoded.def.name}”` : 'Theme link';
    return (
        <CustomThemeImportDialog
            initialText={code}
            fromLink={{ title }}
            onClose={() => setCode(null)}
            onImport={(def: CustomThemeDef, use: boolean) => {
                const entry = lib.create(def);
                if (!entry) return false;
                if (use) { const { id, ...d } = entry; void chooseCustomTheme(uid, id, d); }
                setCode(null);
                return true;
            }}
        />
    );
};

export default ThemeDeepLinkHost;
