import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { DotField } from './engine';
import { clampTagX } from './placement';
import './dots.css';

export interface DotTag {
  id: string;
  /** world position the label hangs under (see the scenes' anchors) */
  at: [number, number, number];
  text: ReactNode;
  /** extra class: '' (shared), 'faded', 'name', 'key' */
  cls?: string;
  /** optional opacity override (React owns only this style property) */
  opacity?: number;
}

export interface DotTagLayerProps {
  field: DotField | null;
  tags: DotTag[] | null;
  className?: string;
}

/**
 * Absolutely-positioned labels pinned to points in the dot field. Each
 * label's left/top is written imperatively on every frame event (React
 * never owns them), so the layer costs nothing while the field is idle.
 * The layer is a fixed full-viewport overlay and assumes the field's
 * canvas covers the viewport too (as the onboarding's does).
 */
export function DotTagLayer({ field, tags, className }: DotTagLayerProps) {
  const els = useRef(new Map<string, HTMLSpanElement>());
  const tagsRef = useRef<DotTag[] | null>(tags);
  const fieldRef = useRef<DotField | null>(field);

  const position = useCallback(() => {
    const f = fieldRef.current, list = tagsRef.current;
    if (!list || !f) return;
    for (const t of list) {
      const el = els.current.get(t.id);
      if (!el) continue;
      const p = f.project(t.at), hw = (el.offsetWidth || 120) / 2;
      el.style.left = clampTagX(p.x, hw, window.innerWidth) + 'px';
      el.style.top = p.y + 'px';
    }
  }, []);

  /* re-project right after the tag list or the field changes, before paint */
  useLayoutEffect(() => {
    tagsRef.current = tags;
    fieldRef.current = field;
    position();
  }, [tags, field, position]);

  useEffect(() => (field ? field.on('frame', position) : undefined), [field, position]);

  if (!field || !tags || tags.length === 0) return null;
  return (
    <div className={className ? `dot-tags ${className}` : 'dot-tags'}>
      {tags.map((t) => (
        <span
          key={t.id}
          ref={(el) => { if (el) els.current.set(t.id, el); else els.current.delete(t.id); }}
          className={`tag3d ${t.cls || ''}`.trim()}
          data-t={t.id}
          style={t.opacity === undefined ? undefined : { opacity: t.opacity }}
        >
          {t.text}
        </span>
      ))}
    </div>
  );
}
