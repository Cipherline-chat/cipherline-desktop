import React from 'react';
import { Lock, Sparkles, Award, Tag } from 'lucide-react';
import type { FounderPanel } from '@cipherline/shared';

/**
 * The founding-status block on Settings → Subscription. Copy and the
 * member / former / offer / closed decision come from `founderPanel` in
 * packages/shared/billing.ts (the website account portal renders the same
 * one), so this file only lays it out.
 */
export const FounderStatusPanel: React.FC<{ panel: FounderPanel }> = ({ panel }) => {
    const member = panel.kind === 'member';
    const offer = panel.kind === 'offer';
    const accent = member || offer;
    const Icon = member ? Lock : offer ? Sparkles : Tag;
    return (
        <div
            data-testid="founder-panel"
            data-kind={panel.kind}
            style={{
                marginTop: 14,
                background: 'var(--cl-surface)',
                border: `1px solid ${accent ? 'rgba(37,224,200,.30)' : 'var(--cl-border)'}`,
                borderRadius: 14,
                padding: '14px 16px',
            }}
        >
            <div className="flex items-start gap-3">
                <span
                    aria-hidden
                    style={{
                        width: 32, height: 32, borderRadius: 10, flexShrink: 0, display: 'grid', placeItems: 'center',
                        background: accent ? 'var(--cl-lume-tint)' : 'var(--cl-raise)',
                        color: accent ? 'var(--cl-lume)' : 'var(--cl-muted)',
                    }}
                >
                    <Icon size={16} />
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                    <div data-testid="founder-panel-title" style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 16.5, lineHeight: 1.25, color: 'var(--cl-text)' }}>
                        {panel.title}
                    </div>
                    {panel.subtitle && (
                        <div data-testid="founder-panel-subtitle" style={{ marginTop: 2, fontSize: 13, fontWeight: 700, color: accent ? 'var(--cl-lume)' : 'var(--cl-muted)' }}>
                            {panel.subtitle}
                        </div>
                    )}
                </div>
            </div>

            {panel.details.length > 0 && (
                <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0 }}>
                    {panel.details.map((d: string) => (
                        <li key={d} className="flex gap-2" style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--cl-muted)', padding: '2px 0' }}>
                            <span aria-hidden style={{ width: 4, height: 4, borderRadius: 99, background: 'var(--cl-faint)', flexShrink: 0, marginTop: 8 }} />
                            <span>{d}</span>
                        </li>
                    ))}
                </ul>
            )}

            {panel.badge && (
                <div className="flex items-start gap-2" data-testid="founder-panel-badge" style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--cl-border)', fontSize: 12.5, fontWeight: 700, color: 'var(--cl-text)' }}>
                    <Award size={14} aria-hidden style={{ color: 'var(--cl-glow)', flexShrink: 0, marginTop: 2 }} />
                    <span>{panel.badge}</span>
                </div>
            )}
        </div>
    );
};
