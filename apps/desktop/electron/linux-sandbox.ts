/**
 * The AppImage on a Linux that blocks its sandbox (Ubuntu 24.04 and newer).
 *
 * Measured 2026-11-02 on Ubuntu 24.04.4 (kernel.apparmor_restrict_unprivileged_userns = 1) with
 * the staging AppImage from our own update host:
 *   - the bare binary refuses to start: "The SUID sandbox helper binary was found, but is not
 *     configured correctly" (an AppImage cannot carry a setuid helper, and Ubuntu denies the
 *     unprivileged user namespace that would replace it);
 *   - the AppImage itself DOES start - electron-builder's AppRun probes `unshare -Ur true`, sees
 *     it fail, and adds --no-sandbox without saying a word (running its AppRun and listing the
 *     processes shows `--no-sandbox` on the browser process). The sandbox is what contains a
 *     compromised renderer; this is the one build of Cipherline that quietly drops it;
 *   - it also does not start at all without libfuse2, which Ubuntu 24.04 no longer ships.
 * The .deb has neither problem: it installs its own AppArmor profile (userns allowed for
 * /opt/Cipherline/cipherline) and falls back to a setuid chrome-sandbox.
 *
 * We cannot change what the AppRun does, and we do not add or remove --no-sandbox ourselves
 * (the sandbox is not ours to weaken, nor can the app re-enable it after launch). What the app
 * can do is not let it be silent: say so, once per launch unless asked not to, and point at the
 * .deb. A user who passed --no-sandbox on purpose gets the same message and can tick the box.
 *
 * Deliberately free of any `electron` import: main.ts hands the few things it needs in.
 */

export interface SandboxFacts {
    platform: string;
    /** app.isPackaged: a dev run (npm run dev:windows, a smoke test) is the developer's own business. */
    packaged: boolean;
    /** process.env.APPIMAGE: set by the AppImage runtime, absent for the .deb and the unpacked build. */
    appImageEnv: string | undefined;
    /** app.commandLine.hasSwitch('no-sandbox'). */
    noSandboxSwitch: boolean;
    /** CIPHERLINE_SMOKE_TEST is set (CI starts the unpacked build under Xvfb, sandbox off). */
    smokeTest: boolean;
}

/** Is this an AppImage that is running without Chromium's sandbox? */
export function appImageIsUnsandboxed(f: SandboxFacts): boolean {
    return f.platform === 'linux' && f.packaged && !f.smokeTest && !!f.appImageEnv && f.noSandboxSwitch;
}

export const SANDBOX_NOTICE = {
    title: 'Cipherline is running without its security sandbox',
    message: 'This AppImage is running without Chromium’s security sandbox.',
    detail:
        'Your system (Ubuntu 24.04 and newer block it for AppImages) does not allow the AppImage to use the ' +
        'sandbox, so it was started without. Cipherline still encrypts everything on your device, but the ' +
        'sandbox is what keeps a compromised web page from reaching the rest of your computer.\n\n' +
        'For full protection install the .deb from cipherline.chat/download (Debian, Ubuntu): it sets the ' +
        'sandbox up for you.',
    buttons: ['Continue anyway', 'Quit'],
    checkboxLabel: 'Don’t show this again',
} as const;

/** What the dialog's answer means. */
export function sandboxNoticeOutcome(response: number, dontShowAgain: boolean): { quit: boolean; remember: boolean } {
    const quit = response === 1;
    return { quit, remember: !quit && dontShowAgain };
}

export interface SandboxNoticeDeps {
    facts: SandboxFacts;
    /** Has the person asked not to be told again? */
    suppressed: () => boolean;
    /** Remember that, content-free (a marker file). */
    remember: () => void;
    showMessageBox: (opts: {
        type: 'warning'; title: string; message: string; detail: string; buttons: string[];
        defaultId: number; cancelId: number; checkboxLabel: string; noLink: boolean;
    }) => Promise<{ response: number; checkboxChecked: boolean }>;
    quit: () => void;
    log: (line: string) => void;
}

/**
 * Tell the person (never blocks startup: the caller does not await it). Returns whether a
 * notice was shown, for the tests.
 */
export async function warnIfAppImageUnsandboxed(d: SandboxNoticeDeps): Promise<boolean> {
    if (!appImageIsUnsandboxed(d.facts)) return false;
    d.log('[Main] AppImage is running without the Chromium sandbox (the AppRun adds --no-sandbox where user namespaces are blocked)');
    let suppressed = false;
    try { suppressed = d.suppressed(); } catch { suppressed = false; }
    if (suppressed) return false;
    try {
        const r = await d.showMessageBox({
            type: 'warning',
            title: SANDBOX_NOTICE.title,
            message: SANDBOX_NOTICE.message,
            detail: SANDBOX_NOTICE.detail,
            buttons: [...SANDBOX_NOTICE.buttons],
            defaultId: 0,
            cancelId: 0,
            checkboxLabel: SANDBOX_NOTICE.checkboxLabel,
            noLink: true,
        });
        const out = sandboxNoticeOutcome(r.response, r.checkboxChecked);
        if (out.remember) { try { d.remember(); } catch { /* it will simply be shown again */ } }
        if (out.quit) d.quit();
    } catch (err) {
        d.log(`[Main] sandbox notice failed: ${(err as Error)?.message ?? 'unknown'}`);
        return false;
    }
    return true;
}
