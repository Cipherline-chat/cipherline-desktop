/**
 * Your OWN status across devices — the server is the source of truth.
 *
 * ── The bug this fixes ────────────────────────────────────────────────────
 * The desktop used to PATCH its locally saved status on every launch and
 * every WS reconnect. Pick "Do Not Disturb" on the phone, then open the PC,
 * and the PC's saved "Online" went straight back to the server: the DND was
 * gone for everyone. Same for a reconnect after sleep, and for every game
 * start/stop (those PATCHes carry the status too).
 *
 * ── The rule now ──────────────────────────────────────────────────────────
 * On every (re)connect the desktop READS the choice (`GET /auth/me`) and
 * adopts it. It sends a status only when the user changes it on this device.
 * While running, a change made on another device arrives as `presence:self`
 * and is adopted the same way, so the desktop never holds (and later
 * re-sends) a stale copy.
 *
 * ── Transition / compatibility ────────────────────────────────────────────
 *   • `chosen_status` absent from /auth/me → an older server that does not
 *     keep the choice: re-announce exactly as before.
 *   • `chosen_status: null` → the server has no REAL choice yet (never picked
 *     since the rework, or only a value it derived — which can never be
 *     "appear offline"). Seed it from this device's last choice, once.
 *   • /auth/me unreachable → send nothing (retried once); what the server
 *     already holds stands.
 *
 * ── A change made while offline (decided 2026-09-29) ─────────────────────
 * No timestamps exist server-side, and comparing two devices' clocks would be
 * a guess anyway, so this is a three-way merge against what this device last
 * knew the server held (`base`):
 *   • server still == base  → only this device changed it: SEND the local
 *     change (it is never silently lost);
 *   • server != base        → another device changed it during the same
 *     outage: a real conflict. The SERVER wins (it is what everyone already
 *     sees, and the other change is at least as recent as far as we can
 *     tell); the local change is dropped with a console note.
 * The pending change is persisted, so quitting while offline does not lose
 * it either.
 *
 * Pure of React and I/O: the hook (useUserStatus) supplies the effects, which
 * is what lets vitest (node env, no renderer) drive it end to end.
 */

import type { UserStatus } from './userStatusModel';

export interface OwnChoice {
    status: UserStatus;
    text: string;
    emoji: string;
}

export interface PendingLocalChange extends OwnChoice {
    /** What this device believed the server held when the change was made. */
    base: OwnChoice;
}

export interface ServerOwnState {
    /** null = no real choice stored yet (see header). */
    chosen: UserStatus | null;
    text: string;
    emoji: string;
    /** `current_game` as the server holds it; undefined when not reported. */
    game: string | null | undefined;
    showMobilePresence: boolean | undefined;
}

const CHOSEN: readonly UserStatus[] = ['online', 'away', 'dnd', 'offline'];
const isChosen = (v: unknown): v is UserStatus => typeof v === 'string' && (CHOSEN as readonly string[]).includes(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function sameChoice(a: OwnChoice | null | undefined, b: OwnChoice | null | undefined): boolean {
    return !!a && !!b && a.status === b.status && a.text === b.text && a.emoji === b.emoji;
}

/** Parse `GET /auth/me`. 'unsupported' = a server that predates `chosen_status`. */
export function readServerOwnState(me: unknown): ServerOwnState | 'unsupported' {
    if (!me || typeof me !== 'object' || !('chosen_status' in me)) return 'unsupported';
    const m = me as Record<string, unknown>;
    return {
        chosen: isChosen(m.chosen_status) ? m.chosen_status : null,
        text: str(m.custom_status_text),
        emoji: str(m.custom_status_emoji),
        game: 'current_game' in m ? (typeof m.current_game === 'string' ? m.current_game : null) : undefined,
        showMobilePresence: typeof m.show_mobile_presence === 'boolean' ? m.show_mobile_presence : undefined,
    };
}

/** Parse a `presence:self` payload; null when it isn't one we can trust. */
export function readSelfEvent(data: unknown): { choice: OwnChoice; showMobilePresence: boolean | undefined } | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    if (!isChosen(d.status)) return null;
    return {
        choice: { status: d.status, text: str(d.custom_status_text), emoji: str(d.custom_status_emoji) },
        showMobilePresence: typeof d.show_mobile_presence === 'boolean' ? d.show_mobile_presence : undefined,
    };
}

export type ConnectDecision =
    | { kind: 'reannounce' }
    | { kind: 'seed' }
    | { kind: 'send-pending' }
    | { kind: 'adopt'; choice: OwnChoice; conflict: boolean }
    | { kind: 'none' };

export function decideOnConnect(
    server: ServerOwnState | 'unsupported' | 'unavailable',
    pending: PendingLocalChange | null,
): ConnectDecision {
    if (server === 'unsupported') return { kind: 'reannounce' };
    if (server === 'unavailable') return { kind: 'none' };
    if (server.chosen === null) return { kind: 'seed' };
    const choice: OwnChoice = { status: server.chosen, text: server.text, emoji: server.emoji };
    if (pending) {
        if (sameChoice(choice, pending.base)) return { kind: 'send-pending' };
        if (sameChoice(choice, pending)) return { kind: 'adopt', choice, conflict: false };
        return { kind: 'adopt', choice, conflict: true };
    }
    return { kind: 'adopt', choice, conflict: false };
}

/** Own-preference changes for other hooks (the privacy toggle). */
type PrefsListener = (p: { showMobilePresence: boolean }) => void;
const prefsListeners = new Set<PrefsListener>();
export const ownPrefsBus = {
    emit(p: { showMobilePresence: boolean }): void {
        for (const l of Array.from(prefsListeners)) {
            try { l(p); } catch (e) { console.error('[ownPrefsBus] listener failed:', e); }
        }
    },
    subscribe(l: PrefsListener): () => void {
        prefsListeners.add(l);
        return () => { prefsListeners.delete(l); };
    },
};

/** `presence:self` frames, from useRealtime to useUserStatus. */
type SelfListener = (data: unknown) => void;
const selfListeners = new Set<SelfListener>();
export const selfPresenceBus = {
    emit(data: unknown): void {
        for (const l of Array.from(selfListeners)) {
            try { l(data); } catch (e) { console.error('[selfPresenceBus] listener failed:', e); }
        }
    },
    subscribe(l: SelfListener): () => void {
        selfListeners.add(l);
        return () => { selfListeners.delete(l); };
    },
};

export interface OwnStatusDeps {
    /** `GET /auth/me` body. Throws on failure. */
    fetchMe(): Promise<unknown>;
    /** `PATCH /auth/status`. Resolves true on success, false on failure. */
    patchStatus(choice: OwnChoice, game: string | null): Promise<boolean>;
    /** Reflect a choice that came FROM the server into the UI + local storage. */
    apply(choice: OwnChoice): void;
    /** What this device currently shows as its choice. */
    getLocal(): OwnChoice;
    getGame(): string | null;
    loadPending(): PendingLocalChange | null;
    savePending(p: PendingLocalChange | null): void;
    /** How long to wait before the one retry of an unreadable /auth/me. */
    retryMs?: number;
}

export class OwnStatusSync {
    private base: OwnChoice;
    private pending: PendingLocalChange | null;
    private synced = false;
    private deferred = false;
    private inFlight = 0;
    private missedSelf = false;
    private seq = 0;
    private gen = 0;
    private retry: ReturnType<typeof setTimeout> | null = null;
    private deps: OwnStatusDeps;

    constructor(deps: OwnStatusDeps) {
        this.deps = deps;
        this.base = deps.getLocal();
        this.pending = deps.loadPending();
    }

    get isSynced(): boolean { return this.synced; }
    get pendingChange(): PendingLocalChange | null { return this.pending; }

    dispose(): void {
        if (this.retry) clearTimeout(this.retry);
        this.retry = null;
        this.seq++;
    }

    private setPending(p: PendingLocalChange | null) {
        this.pending = p;
        this.deps.savePending(p);
    }

    private adopt(choice: OwnChoice) {
        this.base = choice;
        if (this.pending) this.setPending(null);
        const local = this.deps.getLocal();
        if (!sameChoice(local, choice)) this.deps.apply(choice);
    }

    /** Send the local choice as the server's (re-announce / seed / pending). */
    private async sendLocal(): Promise<void> {
        const choice = this.deps.getLocal();
        const gen = this.gen;
        this.inFlight++;
        const ok = await this.deps.patchStatus(choice, this.deps.getGame()).catch(() => false);
        this.inFlight--;
        if (ok && gen === this.gen) {
            this.base = choice;
            if (this.pending) this.setPending(null);
        }
        this.afterFlight();
    }

    /** A (re)connect: read the server's choice and reconcile. */
    async onConnected(attempt = 0): Promise<ConnectDecision['kind']> {
        if (this.retry) { clearTimeout(this.retry); this.retry = null; }
        const seq = ++this.seq;
        const genAtStart = this.gen;
        this.synced = false;
        let server: ServerOwnState | 'unsupported' | 'unavailable';
        let raw: unknown = null;
        try {
            raw = await this.deps.fetchMe();
            server = readServerOwnState(raw);
        } catch {
            server = 'unavailable';
        }
        if (seq !== this.seq) return 'none'; // a newer connect took over
        if (this.gen !== genAtStart) {
            // The user picked something while we were asking — their own
            // PATCH is the newest word; don't let the older read override it.
            this.markSynced();
            return 'none';
        }
        if (typeof server === 'object' && server.showMobilePresence !== undefined) {
            ownPrefsBus.emit({ showMobilePresence: server.showMobilePresence });
        } else if (server === 'unsupported' && raw && typeof raw === 'object'
            && typeof (raw as Record<string, unknown>).show_mobile_presence === 'boolean') {
            ownPrefsBus.emit({ showMobilePresence: (raw as Record<string, boolean>).show_mobile_presence });
        }

        const decision = decideOnConnect(server, this.pending);
        switch (decision.kind) {
            case 'reannounce':
            case 'seed':
            case 'send-pending':
                this.synced = true;
                this.deferred = false;
                await this.sendLocal();
                break;
            case 'adopt': {
                if (decision.conflict) {
                    console.info('[ownStatus] a status change made on this device while offline was superseded by a newer change from another device');
                }
                this.adopt(decision.choice);
                this.synced = true;
                const s = server as ServerOwnState;
                const game = this.deps.getGame();
                const gameDiffers = s.game !== undefined && (s.game ?? null) !== (game ?? null);
                if (gameDiffers || this.deferred) {
                    // Only the GAME is news here: the status sent is the one
                    // just adopted, i.e. what the server already holds.
                    this.deferred = false;
                    await this.sendLocal();
                }
                break;
            }
            case 'none':
                if (attempt === 0) {
                    this.retry = setTimeout(() => {
                        this.retry = null;
                        if (seq === this.seq) void this.onConnected(1);
                    }, this.deps.retryMs ?? 5_000);
                } else {
                    // Unreadable twice: stop holding back game updates. They
                    // carry the status this device already shows.
                    this.markSynced();
                }
                break;
        }
        return decision.kind;
    }

    private markSynced() {
        this.synced = true;
        if (this.deferred) {
            this.deferred = false;
            void this.sendLocal();
        }
    }

    /** The user changed their status ON THIS DEVICE (UI already updated). */
    async changeLocally(choice: OwnChoice): Promise<void> {
        const gen = ++this.gen;
        this.inFlight++;
        const ok = await this.deps.patchStatus(choice, this.deps.getGame()).catch(() => false);
        this.inFlight--;
        if (gen === this.gen) {
            if (ok) {
                this.base = choice;
                if (this.pending) this.setPending(null);
            } else {
                // Offline (or the server refused): keep it and settle it on
                // the next connect — see the header.
                this.setPending({ ...choice, base: this.pending?.base ?? this.base });
            }
        }
        this.afterFlight();
    }

    /** Something other than the status changed (a game started/stopped). The
     *  PATCH carries the status too, so it waits until the server's choice is
     *  known — otherwise a launch-time game detection would re-send the stale
     *  local status before the adopt. */
    async ambientChange(): Promise<void> {
        if (!this.synced) {
            this.deferred = true;
            return;
        }
        await this.sendLocal();
    }

    /** `presence:self` — the choice changed (possibly on another device). */
    onSelfEvent(data: unknown): void {
        const ev = readSelfEvent(data);
        if (!ev) return;
        if (ev.showMobilePresence !== undefined) ownPrefsBus.emit({ showMobilePresence: ev.showMobilePresence });
        if (this.inFlight > 0) {
            // Could be the echo of an older PATCH of ours; re-read once ours land.
            this.missedSelf = true;
            return;
        }
        // An offline change waiting for the next connect decides there.
        if (this.pending) return;
        this.adopt(ev.choice);
    }

    private afterFlight() {
        if (this.inFlight === 0 && this.missedSelf) {
            this.missedSelf = false;
            void this.resync();
        }
    }

    private async resync(): Promise<void> {
        const gen = this.gen;
        try {
            const s = readServerOwnState(await this.deps.fetchMe());
            if (s === 'unsupported' || s.chosen === null) return;
            if (gen !== this.gen || this.inFlight > 0 || this.pending) return;
            this.adopt({ status: s.chosen, text: s.text, emoji: s.emoji });
        } catch { /* the next event or connect settles it */ }
    }
}
