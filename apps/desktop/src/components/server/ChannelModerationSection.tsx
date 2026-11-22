/**
 * ChannelModerationSection - the "Moderation" card of a TEXT channel's settings
 * (create + edit): Slowmode and Age-restricted. Controlled: the dialog owns the
 * draft, so both are part of its dirty / Save / Cancel flow like every other
 * field. The server enforces both (slowmode on the message post, the age gate on
 * every history read); this is only where they are edited.
 */
import React from 'react';
import { Clock, ShieldAlert } from 'lucide-react';
import { SLOWMODE_OPTIONS_SECONDS, slowmodeLabel } from '@cipherline/shared';
import { ClSelect, ClToggle } from '../cl';
import { Row } from './CallNamingSection';

interface Props {
    slowmode: number;
    onSlowmode: (seconds: number) => void;
    ageRestricted: boolean;
    onAgeRestricted: (next: boolean) => void;
    disabled?: boolean;
}

export const SLOWMODE_HINT = 'How long each member must wait between messages. Moderators with Manage Messages or Manage Channels are exempt.';
export const AGE_RESTRICTED_HINT = 'Members must confirm they are 18 or older before they can open this channel. Its messages stay hidden until they do.';

const OPTIONS = SLOWMODE_OPTIONS_SECONDS.map(n => ({ value: String(n), label: slowmodeLabel(n) }));

export const ChannelModerationSection: React.FC<Props> = ({ slowmode, onSlowmode, ageRestricted, onAgeRestricted, disabled }) => (
    <div className="rounded-xl border border-solid border-cl-border/50 bg-cl-surface/40 divide-y divide-white/[0.05]" data-testid="channel-moderation">
        <Row
            icon={<Clock size={13} />}
            label="Slowmode"
            sublabel={SLOWMODE_HINT}
            control={
                <div className="w-[130px]" data-testid="slowmode-picker">
                    <ClSelect
                        options={OPTIONS}
                        value={String(slowmode)}
                        onChange={v => onSlowmode(Number(v))}
                        ariaLabel="Slowmode"
                        disabled={disabled}
                        style={{ width: '100%' }}
                    />
                </div>
            }
        />
        <Row
            icon={<ShieldAlert size={13} />}
            label="Age-restricted"
            sublabel={AGE_RESTRICTED_HINT}
            control={<ClToggle checked={ageRestricted} onChange={onAgeRestricted} disabled={disabled} aria-label="Age-restricted" />}
        />
    </div>
);

export default ChannelModerationSection;
