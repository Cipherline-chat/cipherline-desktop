/**
 * storageModel — the pure logic behind the onboarding "Storage" step.
 *
 * Only the REAL retention windows exist here: messages never|1y|6mo|3mo|1mo|1wk,
 * files add 24h. Everything the chart does (presets, "is this Custom?",
 * pointer position -> window, arrow-key stepping) is a pure function over those
 * so it can be tested without a DOM. The component owns state and rendering.
 */
import {
    getEffectiveAttachmentRetention, getEffectiveMessageRetention,
    ATTACHMENT_RETENTION_LABELS, MESSAGE_RETENTION_LABELS,
    type AttachmentRetention, type MessageRetention, type StoragePolicy,
} from '../../../hooks/useRetentionPolicy';
import { RECOMMENDED_RETENTION, type DeviceRetentionChoice } from '../../../utils/deviceStorageSetup';

export type Lane = 'dm' | 'group' | 'server';
export const LANES: readonly Lane[] = ['dm', 'group', 'server'];

/** Which of a lane's two bars: the message bar or the files bar. */
export type Kind = 'msg' | 'file';

export interface LaneRetention { msg: MessageRetention; file: AttachmentRetention }
export type Retention = Record<Lane, LaneRetention>;

/** Shortest to longest. Index in the list + the offset below = ruler position. */
export const MSG_WINDOWS: readonly MessageRetention[] = ['1wk', '1mo', '3mo', '6mo', '1y', 'never'];
export const FILE_WINDOWS: readonly AttachmentRetention[] = ['24h', '1wk', '1mo', '3mo', '6mo', '1y', 'never'];

/** Ruler stops: 0 = Today, then 24h, 1 wk, 1 mo, 3 mo, 6 mo, 1 yr, 7 = forever. */
export const RULER_STOPS = 7;
export const RULER_LABELS: readonly string[] = ['Today', '24h', '1 wk', '1 mo', '3 mo', '6 mo', '1 yr', '∞'];

const POS: Record<AttachmentRetention, number> = { '24h': 1, '1wk': 2, '1mo': 3, '3mo': 4, '6mo': 5, '1y': 6, never: 7 };

export function windowsFor(kind: Kind): readonly (MessageRetention | AttachmentRetention)[] {
    return kind === 'msg' ? MSG_WINDOWS : FILE_WINDOWS;
}

/** Ruler position (1..7) of a window. */
export function positionOf(w: AttachmentRetention): number {
    return POS[w];
}

/** Where a bar ends, as a fraction of the track (Forever = the far end, 1). */
export function fractionOf(w: AttachmentRetention): number {
    return POS[w] / RULER_STOPS;
}

export function labelFor(kind: Kind, w: MessageRetention | AttachmentRetention): string {
    return kind === 'msg'
        ? MESSAGE_RETENTION_LABELS[w as MessageRetention]
        : ATTACHMENT_RETENTION_LABELS[w];
}

/** The pointer's fraction along the track (clamped to 0..1) -> the nearest real
 *  window for that bar. Messages have no sub-week window, so anything left of
 *  "1 wk" snaps to 1 wk; files bottom out at 24h. */
export function windowAtFraction(kind: Kind, fraction: number): MessageRetention | AttachmentRetention {
    const list = windowsFor(kind);
    const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
    const stop = Math.round(f * RULER_STOPS);
    const min = POS[list[0]];
    const want = Math.max(stop, min);
    return list.find(w => POS[w] === want) ?? list[list.length - 1];
}

/** One arrow-key step along the list, clamped at both ends. +1 = keep longer. */
export function stepWindow(kind: Kind, current: MessageRetention | AttachmentRetention, delta: number): MessageRetention | AttachmentRetention {
    const list = windowsFor(kind);
    const i = list.indexOf(current);
    const from = i < 0 ? 0 : i;
    return list[Math.max(0, Math.min(list.length - 1, from + delta))];
}

/** Menu entries for a bar, longest first (the order the prototype lists them). */
export function menuOptions(kind: Kind): (MessageRetention | AttachmentRetention)[] {
    return windowsFor(kind).slice().reverse();
}

// ── presets ──────────────────────────────────────────────────────────────────

export type PresetId = 'rec' | 'all' | 'less';
export type PresetState = PresetId | 'custom';
export const PRESET_IDS: readonly PresetId[] = ['rec', 'all', 'less'];
export const PRESET_LABELS: Record<PresetState, string> = {
    rec: 'Recommended', all: 'Keep everything', less: 'Keep less', custom: 'Custom',
};

export function choiceToRetention(c: DeviceRetentionChoice): Retention {
    return {
        dm: { msg: c.dmMessageRetention, file: c.dmAttachmentRetention },
        group: { msg: c.groupMessageRetention, file: c.groupAttachmentRetention },
        server: { msg: c.serverMessageRetention, file: c.serverAttachmentRetention },
    };
}

export function retentionToChoice(r: Retention): DeviceRetentionChoice {
    return {
        dmMessageRetention: r.dm.msg,
        dmAttachmentRetention: r.dm.file,
        groupMessageRetention: r.group.msg,
        groupAttachmentRetention: r.group.file,
        serverMessageRetention: r.server.msg,
        serverAttachmentRetention: r.server.file,
    };
}

const EVERYTHING: DeviceRetentionChoice = {
    dmMessageRetention: 'never', dmAttachmentRetention: 'never',
    groupMessageRetention: 'never', groupAttachmentRetention: 'never',
    serverMessageRetention: 'never', serverAttachmentRetention: 'never',
};

const LESS: DeviceRetentionChoice = {
    dmMessageRetention: '3mo', dmAttachmentRetention: '1wk',
    groupMessageRetention: '1mo', groupAttachmentRetention: '24h',
    serverMessageRetention: '1wk', serverAttachmentRetention: '24h',
};

/** A fresh copy of a preset (callers mutate nothing, but never share the object). */
export function presetRetention(p: PresetId): Retention {
    switch (p) {
        case 'rec': return choiceToRetention(RECOMMENDED_RETENTION);
        case 'all': return choiceToRetention(EVERYTHING);
        case 'less': return choiceToRetention(LESS);
    }
}

export function retentionEquals(a: Retention, b: Retention): boolean {
    return LANES.every(l => a[l].msg === b[l].msg && a[l].file === b[l].file);
}

/** The preset a retention equals exactly, else 'custom'. */
export function detectPreset(r: Retention): PresetState {
    return PRESET_IDS.find(p => retentionEquals(r, presetRetention(p))) ?? 'custom';
}

/** Returns a new Retention with one bar changed. */
export function withWindow(r: Retention, lane: Lane, kind: Kind, w: MessageRetention | AttachmentRetention): Retention {
    return { ...r, [lane]: { ...r[lane], [kind]: w } } as Retention;
}

/** What this device already has stored (resume / Back), via the same per-type
 *  resolution the rest of the app uses (a missing per-type field falls back to
 *  the global one). */
export function retentionFromPolicy(policy: StoragePolicy): Retention {
    const r = {} as Retention;
    for (const l of LANES) {
        r[l] = { msg: getEffectiveMessageRetention(policy, l), file: getEffectiveAttachmentRetention(policy, l) };
    }
    return r;
}
