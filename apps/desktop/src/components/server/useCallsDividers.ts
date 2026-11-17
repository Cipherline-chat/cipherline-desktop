/**
 * The Calls panel's divider state + writes: optimistic create / edit /
 * delete, rolled back with a toast when the API refuses (the same pattern as
 * the channel list).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { apiUrl } from '../../utils/apiPath';
import type { DividerInfo } from '../../hooks/useServers';
import type { DividerValues } from './DividerFormDialog';

const NONE: DividerInfo[] = [];
const errMsg = (e: unknown) => (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
const msg = (e: unknown, fallback: string) => (typeof errMsg(e) === 'string' ? errMsg(e) as string : fallback);

/**
 * The Calls panel's divider state + writes: optimistic create / edit /
 * delete, rolled back with a toast when the API refuses (the same pattern as
 * the channel list). `dividers` is everything the server sent; this keeps the
 * `calls` ones.
 */
export function useCallsDividers(opts: {
    serverId: string;
    token: string | null;
    dividers: DividerInfo[] | undefined;
    onApplyDividers?: (update: (list: DividerInfo[]) => DividerInfo[]) => void;
    onChanged?: () => void;
    toast: { push: (t: { kind: 'error'; message: string }) => void };
}) {
    const { serverId, token, dividers, onApplyDividers, onChanged, toast } = opts;
    const fromProps = useMemo(() => (dividers ?? NONE).filter(d => d.list_kind === 'calls'), [dividers]);
    const [local, setLocal] = useState<DividerInfo[]>(fromProps);
    const [synced, setSynced] = useState(fromProps);
    if (fromProps !== synced) { setSynced(fromProps); setLocal(fromProps); }
    const ref = useRef(local);
    useEffect(() => { ref.current = local; }, [local]);
    const seq = useRef(0);
    const auth = useMemo(() => ({ headers: { Authorization: `Bearer ${token}` } }), [token]);

    const apply = useCallback((update: (list: DividerInfo[]) => DividerInfo[]) => {
        const next = update(ref.current);
        ref.current = next;
        setLocal(next);
        onApplyDividers?.(update);
    }, [onApplyDividers]);

    const create = useCallback((container: string | null, v: DividerValues, endPosition: number) => {
        const tempId = `pending:cdiv:${++seq.current}`;
        const temp: DividerInfo = {
            divider_id: tempId, server_id: serverId, parent_category_id: container, list_kind: 'calls',
            position: endPosition, ...v,
        };
        apply(list => [...list, temp]);
        axios.post(apiUrl`/servers/${serverId}/dividers`, {
            style: v.style,
            ...(container ? { parent_category_id: container } : { list_kind: 'calls' }),
            ...(v.label ? { label: v.label } : {}),
            ...(v.color ? { color: v.color } : {}),
        }, auth)
            .then(res => { apply(list => list.map(d => (d.divider_id === tempId ? (res.data as DividerInfo) : d))); onChanged?.(); })
            .catch(e => {
                apply(list => list.filter(d => d.divider_id !== tempId));
                toast.push({ kind: 'error', message: msg(e, "Couldn't add that divider.") });
            });
    }, [apply, auth, onChanged, serverId, toast]);

    const update = useCallback((d: DividerInfo, v: DividerValues) => {
        apply(list => list.map(x => (x.divider_id === d.divider_id ? { ...x, ...v } : x)));
        axios.patch(apiUrl`/servers/${serverId}/dividers/${d.divider_id}`, { style: v.style, label: v.label ?? '', color: v.color }, auth)
            .then(() => onChanged?.())
            .catch(e => {
                apply(list => list.map(x => (x.divider_id === d.divider_id ? d : x)));
                toast.push({ kind: 'error', message: msg(e, "Couldn't save that divider. It's back as it was.") });
            });
    }, [apply, auth, onChanged, serverId, toast]);

    const remove = useCallback((d: DividerInfo) => {
        apply(list => list.filter(x => x.divider_id !== d.divider_id));
        axios.delete(apiUrl`/servers/${serverId}/dividers/${d.divider_id}`, auth)
            .then(() => onChanged?.())
            .catch(() => {
                apply(list => (list.some(x => x.divider_id === d.divider_id) ? list : [...list, d]));
                toast.push({ kind: 'error', message: "Couldn't delete that divider. It's back in the list." });
            });
    }, [apply, auth, onChanged, serverId, toast]);

    return { dividers: local, setLocal, ref, create, update, remove };
}
