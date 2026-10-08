import { describe, expect, it } from 'vitest';
import { RECOMMENDED_RETENTION } from '../../../utils/deviceStorageSetup';
import type { StoragePolicy } from '../../../hooks/useRetentionPolicy';
import {
    FILE_WINDOWS, MSG_WINDOWS, choiceToRetention, detectPreset, fractionOf, labelFor, menuOptions,
    presetRetention, retentionEquals, retentionFromPolicy, retentionToChoice, stepWindow, windowAtFraction,
    withWindow, type PresetId,
} from './storageModel';

const basePolicy = (over: Partial<StoragePolicy> = {}): StoragePolicy => ({
    attachmentRetention: 'never', messageRetention: 'never',
    savedAttachmentIds: [], unsavedAttachmentIds: [], savedMessageIds: [], unsavedMessageIds: [],
    unsavedMessageTimestamps: {}, unsavedAttachmentTimestamps: {},
    ...over,
});

describe('presets', () => {
    it('Recommended is exactly RECOMMENDED_RETENTION', () => {
        expect(retentionToChoice(presetRetention('rec'))).toEqual(RECOMMENDED_RETENTION);
    });

    it('Keep everything is all never', () => {
        const c = retentionToChoice(presetRetention('all'));
        expect(Object.values(c).every(v => v === 'never')).toBe(true);
        expect(Object.keys(c)).toHaveLength(6);
    });

    it('Keep less is DMs 3mo/1wk, groups 1mo/24h, servers 1wk/24h', () => {
        expect(retentionToChoice(presetRetention('less'))).toEqual({
            dmMessageRetention: '3mo', dmAttachmentRetention: '1wk',
            groupMessageRetention: '1mo', groupAttachmentRetention: '24h',
            serverMessageRetention: '1wk', serverAttachmentRetention: '24h',
        });
    });

    it('only uses real windows (messages have no 24h)', () => {
        for (const p of ['rec', 'all', 'less'] as PresetId[]) {
            const r = presetRetention(p);
            for (const l of ['dm', 'group', 'server'] as const) {
                expect(MSG_WINDOWS).toContain(r[l].msg);
                expect(FILE_WINDOWS).toContain(r[l].file);
            }
        }
    });

    it('returns an independent copy each time', () => {
        const a = presetRetention('rec');
        a.dm.msg = 'never';
        expect(presetRetention('rec').dm.msg).toBe('1y');
    });
});

describe('detectPreset', () => {
    it('recognises each preset', () => {
        expect(detectPreset(presetRetention('rec'))).toBe('rec');
        expect(detectPreset(presetRetention('all'))).toBe('all');
        expect(detectPreset(presetRetention('less'))).toBe('less');
    });

    it('any single hand edit becomes custom', () => {
        expect(detectPreset(withWindow(presetRetention('rec'), 'group', 'file', '24h'))).toBe('custom');
        expect(detectPreset(withWindow(presetRetention('all'), 'server', 'msg', '1y'))).toBe('custom');
    });

    it('editing back to a preset value un-customises', () => {
        const edited = withWindow(presetRetention('rec'), 'dm', 'msg', '3mo');
        expect(detectPreset(edited)).toBe('custom');
        expect(detectPreset(withWindow(edited, 'dm', 'msg', '1y'))).toBe('rec');
    });

    it('withWindow does not mutate its input', () => {
        const r = presetRetention('rec');
        withWindow(r, 'dm', 'msg', 'never');
        expect(r.dm.msg).toBe('1y');
    });

    it('choice <-> retention round-trips', () => {
        const c = { ...RECOMMENDED_RETENTION, groupMessageRetention: '3mo' as const, serverAttachmentRetention: '24h' as const };
        expect(retentionToChoice(choiceToRetention(c))).toEqual(c);
        expect(retentionEquals(choiceToRetention(c), presetRetention('rec'))).toBe(false);
    });
});

describe('retentionFromPolicy (resume / Back)', () => {
    it('reads the per-type fields', () => {
        const p = basePolicy({
            dmMessageRetention: '3mo', dmAttachmentRetention: '1wk',
            groupMessageRetention: '1mo', groupAttachmentRetention: '24h',
            serverMessageRetention: '1wk', serverAttachmentRetention: '24h',
        });
        expect(detectPreset(retentionFromPolicy(p))).toBe('less');
    });

    it('falls back to the global fields when a per-type one is unset', () => {
        const r = retentionFromPolicy(basePolicy({ messageRetention: '6mo', attachmentRetention: '1mo', dmMessageRetention: '1y' }));
        expect(r.dm).toEqual({ msg: '1y', file: '1mo' });
        expect(r.group).toEqual({ msg: '6mo', file: '1mo' });
        expect(r.server).toEqual({ msg: '6mo', file: '1mo' });
        expect(detectPreset(r)).toBe('custom');
    });

    it('a policy saved from Recommended reads back as Recommended', () => {
        const p = basePolicy({ ...RECOMMENDED_RETENTION });
        expect(detectPreset(retentionFromPolicy(p))).toBe('rec');
    });
});

describe('windowAtFraction (drag snapping)', () => {
    it('snaps to the nearest ruler stop', () => {
        expect(windowAtFraction('msg', 3 / 7)).toBe('1mo');
        expect(windowAtFraction('msg', 3.4 / 7)).toBe('1mo');
        expect(windowAtFraction('msg', 3.6 / 7)).toBe('3mo');
        expect(windowAtFraction('file', 1 / 7)).toBe('24h');
        expect(windowAtFraction('file', 6 / 7)).toBe('1y');
    });

    it('the far end is Forever', () => {
        expect(windowAtFraction('msg', 1)).toBe('never');
        expect(windowAtFraction('file', 1)).toBe('never');
    });

    it('clamps outside the track and non-finite input', () => {
        expect(windowAtFraction('msg', 5)).toBe('never');
        expect(windowAtFraction('file', -3)).toBe('24h');
        expect(windowAtFraction('file', Number.NaN)).toBe('24h');
    });

    it('messages floor at 1 wk, files floor at 24h', () => {
        expect(windowAtFraction('msg', 0)).toBe('1wk');
        expect(windowAtFraction('msg', 1 / 7)).toBe('1wk');
        expect(windowAtFraction('file', 0)).toBe('24h');
    });

    it('every stop maps back to itself through fractionOf', () => {
        for (const w of MSG_WINDOWS) expect(windowAtFraction('msg', fractionOf(w))).toBe(w);
        for (const w of FILE_WINDOWS) expect(windowAtFraction('file', fractionOf(w))).toBe(w);
    });
});

describe('stepWindow (arrow keys)', () => {
    it('steps longer and shorter', () => {
        expect(stepWindow('msg', '1mo', 1)).toBe('3mo');
        expect(stepWindow('msg', '1mo', -1)).toBe('1wk');
        expect(stepWindow('file', '24h', 1)).toBe('1wk');
    });

    it('clamps at both ends', () => {
        expect(stepWindow('msg', 'never', 1)).toBe('never');
        expect(stepWindow('msg', '1wk', -1)).toBe('1wk');
        expect(stepWindow('file', '24h', -1)).toBe('24h');
    });

    it('an unknown window steps from the shortest instead of throwing', () => {
        expect(stepWindow('msg', '24h', 1)).toBe('1mo');
    });
});

describe('menus and labels', () => {
    it('lists longest first, and only real windows per kind', () => {
        expect(menuOptions('msg')).toEqual(['never', '1y', '6mo', '3mo', '1mo', '1wk']);
        expect(menuOptions('file')).toEqual(['never', '1y', '6mo', '3mo', '1mo', '1wk', '24h']);
    });

    it('labels come from the real label tables', () => {
        expect(labelFor('msg', 'never')).toBe('Forever');
        expect(labelFor('msg', '1y')).toBe('1 year');
        expect(labelFor('file', '24h')).toBe('24 hours');
    });
});
