import { describe, it, expect } from 'vitest';
import * as main from '../../../electron/ui-scale';
import {
    UI_SCALE_STEPS, UI_SCALE_DEFAULT, isUiScaleStep, toUiScaleState, isLimited,
    uiScaleValueText, uiScaleAt, uiScaleIndex,
} from './uiScale';

describe('renderer mirror of electron/ui-scale.ts', () => {
    it('steps and default match the main process exactly', () => {
        expect([...UI_SCALE_STEPS]).toEqual([...main.UI_SCALE_STEPS]);
        expect(UI_SCALE_DEFAULT).toBe(main.UI_SCALE_DEFAULT);
    });
    it('a real controller state passes the renderer validator unchanged (contract round-trip)', () => {
        const c = main.createUiScaleController({
            readStored: () => '200', writeStored: () => {}, workAreaFor: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
            applyZoomFactor: () => {}, notify: () => {},
        });
        const s = c.apply({
            isDestroyed: () => false, isMaximized: () => false, isFullScreen: () => false,
            getBounds: () => ({ x: 0, y: 0, width: 1600, height: 1000 }), setBounds: () => {}, setMinimumSize: () => {},
        }, 'display');
        expect(toUiScaleState(s)).toEqual(s);
    });
});

describe('toUiScaleState', () => {
    it('accepts a valid state', () => {
        expect(toUiScaleState({ percent: 150, effective: 125, max: 125, source: 'display' }))
            .toEqual({ percent: 150, effective: 125, max: 125, source: 'display' });
    });
    it.each([
        [null], [undefined], ['125'], [{}], [{ percent: 133, effective: 100, max: 200 }],
        [{ percent: 100, effective: NaN, max: 200 }], [{ percent: 100, effective: 100 }],
    ])('rejects %j', (raw) => { expect(toUiScaleState(raw)).toBeNull(); });
    it('effective can never exceed the preference; unknown source -> set', () => {
        expect(toUiScaleState({ percent: 110, effective: 150, max: 200, source: 'evil' }))
            .toEqual({ percent: 110, effective: 110, max: 200, source: 'set' });
    });
});

describe('labels and slider mapping', () => {
    it('isLimited', () => {
        expect(isLimited({ percent: 200, effective: 150, max: 150, source: 'init' })).toBe(true);
        expect(isLimited({ percent: 125, effective: 125, max: 150, source: 'init' })).toBe(false);
    });
    it('aria-valuetext says percent, and the limit when there is one', () => {
        expect(uiScaleValueText(125)).toBe('125 percent');
        expect(uiScaleValueText(200, 150)).toBe('200 percent, limited to 150 percent by your display');
        expect(uiScaleValueText(125, 125)).toBe('125 percent');
    });
    it('index <-> step round-trips and clamps', () => {
        UI_SCALE_STEPS.forEach((s, i) => { expect(uiScaleAt(i)).toBe(s); expect(uiScaleIndex(s)).toBe(i); });
        expect(uiScaleAt(-3)).toBe(80);
        expect(uiScaleAt(99)).toBe(200);
        expect(uiScaleIndex(133)).toBe(uiScaleIndex(100));
        expect(isUiScaleStep(125)).toBe(true);
        expect(isUiScaleStep('125')).toBe(false);
    });
});
