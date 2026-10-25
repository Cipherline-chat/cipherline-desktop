/** Move `from` to `to` in a copy of `list` (the reorder behind drag / Alt + arrows). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
    const next = [...list];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    return next;
}
