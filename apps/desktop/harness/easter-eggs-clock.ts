/* eslint-disable -- visual harness, not shipped */
// Freezes `new Date()` / Date.now() at ?date=<ISO local time> so a calendar egg (Halloween, New Year,
// the birthday, 3 am) can be photographed on any day. MUST be the first import of the harness entry:
// the eggs read the clock at render time. Without ?date= the real clock is untouched.
const iso = new URLSearchParams(location.search).get('date');
if (iso) {
    const fixed = new Date(iso).getTime();
    const Real = Date;
    class FrozenDate extends Real {
        constructor(...a: any[]) {
            if (a.length === 0) super(fixed);
            else super(...(a as [any]));
        }
        static now() { return fixed; }
    }
    (globalThis as any).Date = FrozenDate;
}
export {};
